"""Read-only dependency inspection using the simulator's spec, quote and contract-selection rules."""
import math
from collections import Counter
from pathlib import Path
import pyarrow.parquet as pq

from . import engine, parquet
from .binance import BinancePerp, DEFAULT_DIR, month_name, month_of_hour
from .market import DEFAULT_DATA, ParquetMarket, SLIM_UNITS, month_of


def intervals(hours, maximum=256):
    values = sorted(set(hours)); ranges = []
    for hour in values:
        if ranges and hour == ranges[-1][1] + 1:
            ranges[-1][1] = hour
        else:
            ranges.append([hour, hour])
    return {'count': len(values), 'rangesInclusive': ranges[:maximum], 'omittedRanges': max(0, len(ranges) - maximum)}


def inspect(spec, directory=DEFAULT_DATA, perp_directory=DEFAULT_DIR, price_unit=None, iv_unit=None):
    result = {'schema': 1, 'readOnly': True, 'simulationStarted': False, 'downloads': 0, 'cacheWrites': 0,
              'scope': 'conservative_dependencies_for_all_scheduled_entries_and_run_tail_not_a_trade_prediction',
              'files': [], 'errors': [], 'unknownSettlements': [], 'exitCoverage': [], 'selectedQuoteGaps': [], 'selectionSkips': {},
              'fundingCoverage': 'not_required', 'ready': False}
    try:
        market = ParquetMarket(directory, read_only=True, perp_directory=perp_directory, cache_months=2,
                               price_unit=price_unit, iv_unit=iv_unit)
    except FileNotFoundError as error:
        result['errors'].append({'kind': 'missing_option_files', 'detail': str(error)})
        return result
    errors_seen, invalid_months = set(), set()

    def problem(kind, detail, month=None):
        key = (kind, str(detail), month)
        if key not in errors_seen:
            result['errors'].append({'kind': kind, 'detail': str(detail), **({'month': month_name(month)} if month is not None else {})})
            errors_seen.add(key)

    try:
        first, last = market.span()
    except (OSError, ValueError) as error:
        problem('units_conflict' if isinstance(error, parquet.UnitError) else 'schema_or_data_invalid', error)
        # A real run would fail at span() too. Still report the requested files and declarations.
        first, last = spec['start_hour'], spec['end_hour']
        if first is None or last is None:
            market.close(); return result
        result['dataSpanUnknown'] = True
    start = max(first, spec['start_hour'] if spec['start_hour'] is not None else first)
    end = min(last, spec['end_hour'] if spec['end_hour'] is not None else last)
    entries = [hour for hour in range(start, end + 1) if engine.is_entry_hour(hour, spec)]
    days = spec['trend']['ma_days']
    warmup = entries[0] - days * 24 + 1 if days and entries else None
    result['ranges'] = {'data': [first, last], 'requestedEntry': [spec['start_hour'], spec['end_hour']], 'effectiveEntry': [start, end],
                        'scheduledEntries': len(entries), 'trendWarmup': [warmup, entries[0] - 1] if warmup is not None else None,
                        'tailUpperBound': [end + 1, last] if last > end and entries else None,
                        'tailReason': 'run may continue to last data hour when closing quotes or settlement are missing'}
    if not entries:
        problem('no_scheduled_entries', 'no eligible entry hour in the clipped data window')
    requested_start = spec['start_hour'] if spec['start_hour'] is not None else first
    requested_end = spec['end_hour'] if spec['end_hour'] is not None else last
    if requested_start < first or requested_end > last:
        problem('entry_window_clipped', f'requested [{requested_start}, {requested_end}], available [{first}, {last}]')
    # Include the preceding month for midnight labels, exactly as market._sources does.
    option_from, option_to = min(start, requested_start), max(last, requested_end)
    for month in range(month_of(option_from * 3600 - 1), month_of(option_to * 3600) + 1):
        path = market.files.get(month)
        row = {'kind': 'options', 'month': month_name(month), 'file': f'{month_name(month)}.parquet', 'exists': path is not None,
               'boundaryCandidateOnly': month < month_of(option_from * 3600)}
        result['files'].append(row)
        if not path:
            if not row['boundaryCandidateOnly']:
                problem('missing_month_file', row['file'], month)
            continue
        try:
            columns = parquet.detect(pq.read_schema(path).names, {})
            parquet.require(columns)
            row['columns'] = columns
            row['units'] = {role: parquet.unit(path, role, market.units[role], SLIM_UNITS[role]) for role in SLIM_UNITS}
            row['unitSource'] = 'declared_or_explicit_else_legacy_slim_contract'
        except (OSError, ValueError) as error:
            invalid_months.add(month)
            problem('units_conflict' if isinstance(error, parquet.UnitError) else 'schema_invalid', error, month)

    def chain(hour):
        months = {month_of(hour * 3600 - 1), month_of(hour * 3600)}
        if months & invalid_months:
            return []
        try:
            return market.chain(hour)
        except (OSError, ValueError) as error:
            invalid_months.update(months)
            problem('units_conflict' if isinstance(error, parquet.UnitError) else 'quote_data_invalid', error)
            return []

    has_perp = any(leg['type'] == 'perp' for leg in spec['legs'])
    perp = BinancePerp(directory=perp_directory, allow_download=False)
    prices, missing_prices = {}, []
    if (days or has_perp) and entries:
        low = min(warmup if warmup is not None else entries[0], entries[0])
        high = last if has_perp else entries[-1]
        result['ranges']['perp'] = [low, high]
        for month in range(month_of_hour(low - 1), month_of_hour(high - 1) + 1):
            path = perp.folder / f'klines-{month_name(month)}.csv'
            result['files'].append({'kind': 'perp', 'month': month_name(month), 'file': str(path), 'exists': path.is_file(), 'units': 'USD close'})
            try:
                rows = perp._rows(month, 'klines')
                if len({hour for hour, _ in rows}) != len(rows):
                    problem('duplicate_perp_hour', path.name)
                prices.update((hour, price) for hour, price in rows if math.isfinite(price) and price > 0 and month_of_hour(hour - 1) == month)
            except (OSError, ValueError, RuntimeError) as error:
                problem('perp_file_unavailable', error, month)
        missing_prices = [hour for hour in range(low, high + 1) if hour not in prices]
        result['perpHourGaps'] = intervals(missing_prices)
        if missing_prices:
            problem('perp_hour_gaps', f'{len(missing_prices)} missing or invalid closes')
    if has_perp and entries:
        result['fundingCoverage'] = 'local_rows_checked_schedule_completeness_unverified'
        funding_count = 0
        for month in range(month_of_hour(entries[0] + 1), month_of_hour(last) + 1):
            path = perp.folder / f'funding-{month_name(month)}.csv'
            row = {'kind': 'funding', 'month': month_name(month), 'file': str(path), 'exists': path.is_file(), 'units': 'fraction'}
            result['files'].append(row)
            try:
                rows = perp._rows(month, 'funding'); row['events'] = len(rows); funding_count += len(rows)
                if not rows:
                    problem('empty_funding_file', path.name)
                if len({hour for hour, _ in rows}) != len(rows):
                    problem('duplicate_funding_hour', path.name)
                for hour, rate in rows:
                    if not math.isfinite(rate):
                        problem('invalid_funding_rate', path.name)
                    # The real funding loader prices every event in the monthly file, even outside the run window.
                    try:
                        price = perp.price(hour)
                        if price is None or not math.isfinite(price) or price <= 0:
                            problem('funding_price_missing', f'{path.name}: hour {hour}')
                    except (OSError, ValueError, RuntimeError) as error:
                        problem('funding_price_missing', error)
            except (OSError, ValueError, RuntimeError) as error:
                problem('funding_file_unavailable', error, month)
        result['fundingEventsInMonthlyFiles'] = funding_count

    missing, selected, expiries, skips = [], {}, set(), Counter()
    entry_set = set(entries)
    trend_missing = []
    class LocalPrices:
        def perp(self, hour):
            return prices.get(hour)
    trend = engine.TrendWindow(LocalPrices(), days) if days else None
    for hour in range(start, last + 1):
        quotes = chain(hour)
        if not quotes:
            missing.append(hour)
        keyed = {(q.expiry, q.strike, q.is_call): q for q in quotes}
        for contract, first_used in selected.items():
            if first_used < hour < contract[0] and contract not in keyed:
                if len(result['selectedQuoteGaps']) < 512:
                    result['selectedQuoteGaps'].append({'hour': hour, 'expiryHour': contract[0], 'strike': contract[1], 'isCall': contract[2]})
                result['selectedQuoteGapCount'] = result.get('selectedQuoteGapCount', 0) + 1
        if hour not in entry_set:
            continue
        states = [None]
        if days:
            state = trend.state(hour)
            if state is None:
                trend_missing.append(hour); states = ['above', 'below']
            else:
                states = [state]
        for state in states:
            choices, reason = engine.select_option_quotes(quotes, hour, spec, state)
            if reason:
                skips[reason] += 1
            if choices:
                first_expiry = min(quote.expiry for _, _, quote in choices)
                if first_expiry > last:
                    before = spec['exit']['close_hours_before_expiry']
                    scheduled = max(hour + 1, math.ceil(first_expiry - before)) if before is not None else None
                    conditional = any(spec['exit'][name] is not None for name in ('take_profit_pct', 'stop_loss_pct'))
                    scheduled_reachable = scheduled is not None and scheduled <= last
                    status = 'scheduled_exit_within_data' if scheduled_reachable else 'early_exit_unverified' if conditional else 'required_exit_after_data_end'
                    result['exitCoverage'].append({'entryHour': hour, 'trendState': state, 'firstExpiryHour': first_expiry,
                                                   'lastDataHour': last, 'scheduledExitHour': scheduled,
                                                   'conditionalExitConfigured': conditional, 'status': status,
                                                   'definitelyUnreachable': not scheduled_reachable and not conditional})
                    if not scheduled_reachable:
                        problem(status, f'entry {hour}: first expiry {first_expiry}, scheduled exit {scheduled}, last reachable hour {last}; '
                                + ('price-triggered early exit may still close within data; no simulation was performed' if conditional
                                   else 'no configured exit can execute before the data ends'))
            for _, _, quote in choices:
                selected.setdefault((quote.expiry, quote.strike, quote.is_call), hour)
                expiries.add(quote.expiry)
    for expiry in sorted(expiries):
        try:
            if market.settlement(expiry) is None:
                result['unknownSettlements'].append({'expiryHour': expiry, 'reason': 'no_hourly_delivery_estimate',
                                                     'runMayUseLastForwardAfterSixHours': True})
        except (OSError, ValueError) as error:
            result['unknownSettlements'].append({'expiryHour': expiry, 'reason': 'invalid_delivery_data'})
            problem('delivery_data_invalid', error)
    result['optionHourGaps'] = intervals(missing)
    result['trendUnavailableEntries'] = intervals(trend_missing)
    result['selectionSkips'] = dict(skips)
    result['selectedContracts'] = len(selected)
    result['settlementContract'] = 'hourly forward estimate; official delivery TWAP unavailable'
    result['ready'] = not (result['errors'] or missing or trend_missing or result['selectedQuoteGaps'] or result['unknownSettlements'] or skips)
    market.close()
    return result

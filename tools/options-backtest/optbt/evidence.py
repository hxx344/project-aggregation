"""Frozen single-run provenance. Evidence contains the exact floating point inputs used by the engine."""
import hashlib
import json
import math
import platform
from importlib.metadata import version, PackageNotFoundError
from dataclasses import asdict
from pathlib import Path

MAX_TRADES, MAX_BYTES, MAX_LEGS, MAX_FUNDING_EVENTS = 10000, 32 * 1024 * 1024, 64, 10000


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def file_identity(path, **details):
    path = Path(path)
    before = path.stat()
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f'data changed while freezing identity: {path.name}')
    return {'id': digest.hexdigest(), 'file': str(path.resolve()), 'size': before.st_size,
            'mtimeNs': before.st_mtime_ns, **details}


def quote_evidence(quote):
    if quote is None:
        return None
    return {key: None if isinstance(value, float) and not math.isfinite(value) else value
            for key, value in asdict(quote).items()}


def fill_evidence(leg, quote, price, fee, phase, model, fallback=False, waived=False):
    return {'legIndex': leg.index, 'instrument': 'perp' if leg.is_perp else 'option', 'sign': leg.sign, 'qty': leg.qty,
            'expiryHour': leg.expiry, 'strike': leg.strike, 'isCall': leg.is_call, 'phase': phase,
            'quote': quote_evidence(quote), 'fillPriceUsd': price, 'feeUsd': fee, 'fillModel': model,
            'fallback': 'invalid_or_missing_bid_ask_used_mark' if fallback else None,
            'feeTreatment': 'carried_perp_fee_waived' if waived else 'charged',
            'cashUsd': (-leg.sign * price * leg.qty if not leg.is_perp else 0.0) if phase == 'entry'
            else leg.sign * leg.value(price) * leg.qty}


def source_for_perp(market, hour):
    return market.perp_evidence(hour) if hasattr(market, 'perp_evidence') else None


def closing_evidence(position, market, upto, exits):
    if '_evidence' not in position.extra:
        return
    detail = position.extra['_evidence']
    detail['exits'] = exits
    detail['funding'] = {'afterHourExclusive': position.entry_hour, 'uptoHourInclusive': upto, 'events': [], 'legs': []}
    perps = [leg for leg in position.legs if leg.is_perp]
    if perps:
        detail['funding']['events'] = market.funding_evidence(position.entry_hour, upto) if hasattr(market, 'funding_evidence') else None
        one_btc = market.funding(position.entry_hour, upto)
        detail['funding']['legs'] = [{'legIndex': leg.index, 'sign': leg.sign, 'qty': leg.qty,
                                     'oneBtcFundingUsd': one_btc, 'paidUsd': leg.sign * leg.qty * one_btc} for leg in perps]


def missing_quote(position, hour):
    detail = position.extra.get('_evidence')
    if detail is not None:
        if len(detail['missingQuoteHours']) < 1024:
            detail['missingQuoteHours'].append(hour)
        else:
            detail['missingQuoteHoursOmitted'] += 1


class RunEvidence:
    def __init__(self, spec):
        self.spec = spec
        self.opened = 0
        self.unresolved_positions = []
        self.sizes = {}
        self.bytes = 0

    def reserve(self, detail):
        size = len(canonical(detail).encode())
        self.bytes += size - self.sizes.get(detail['id'], 0)
        self.sizes[detail['id']] = size
        if self.bytes > MAX_BYTES:
            raise ValueError('evidence byte budget exceeded; narrow the run')

    def begin(self, position, quotes, carry):
        self.opened += 1
        if self.opened > MAX_TRADES or len(position.legs) > MAX_LEGS:
            raise ValueError(f'evidence budget exceeded ({MAX_TRADES} positions / {MAX_LEGS} legs); narrow the run')
        from .engine import fill_price, leg_fee
        position.extra['_evidence'] = {'id': f'trade-{self.opened:06d}', 'entries': [
            fill_evidence(leg, quote, leg.price, 0.0 if carry and leg.is_perp else leg_fee(self.spec['fees'], leg, quote.forward, leg.price),
                          'entry', self.spec['fill'], fill_price(quote, leg.sign > 0, self.spec['fill'])[1], carry and leg.is_perp)
            for leg, quote in zip(position.legs, quotes)], 'exits': [], 'missingQuoteHours': [], 'missingQuoteHoursOmitted': 0}
        position.extra['_evidence_owner'] = self
        self.reserve(position.extra['_evidence'])

    def unresolved(self, position, last):
        detail = position.extra['_evidence']
        record = {**detail, 'state': position.extra.get('pending', 'open'), 'entryHour': position.entry_hour,
                  'lastDataHour': last, 'netUsd': None, 'missingHours': position.missing_hours}
        self.reserve(record)
        self.unresolved_positions.append(record)

    def bundle(self, trades, market):
        records = []
        for trade in trades:
            detail = trade.pop('_evidence')
            trade['evidence_id'] = detail['id']
            detail.update(entryHour=trade['entry_hour'], exitHour=trade['exit_hour'], reason=trade['reason'],
                          missingHours=trade['missing_hours'], reportedPnlUsd=trade['pnl'], state='closed')
            records.append(detail)
        records.extend(self.unresolved_positions)
        files = list(getattr(market, 'source_identities', {}).values())
        if getattr(market, '_perp', None):
            files.extend(market._perp.source_identities.values())
        code = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                for name in ('engine.py', 'pricing.py', 'market.py', 'parquet.py', 'binance.py', 'spec.py', 'evidence.py')}
        manifest = {'schema': 1, 'specSha256': hashlib.sha256(canonical(self.spec).encode()).hexdigest(), 'spec': self.spec,
                    'modelVersion': code, 'feeModelVersion': code['engine.py'], 'fees': self.spec['fees'],
                    'units': {'prices': 'USD per 1 BTC', 'quantity': 'BTC', 'time': 'UTC epoch hours / quote epoch seconds'},
                    'dataFiles': sorted(files, key=lambda row: row['file']), 'records': len(records),
                    'limits': {'trades': MAX_TRADES, 'bytes': MAX_BYTES, 'legs': MAX_LEGS, 'fundingEventsPerTrade': MAX_FUNDING_EVENTS},
                    'settlement': 'hourly_underlying_estimate_not_official_delivery_TWAP'}
        manifest['environment'] = {'python': platform.python_version()}
        for package in ('numpy', 'pyarrow'):
            try:
                manifest['environment'][package] = version(package)
            except PackageNotFoundError:
                manifest['environment'][package] = None
        lines = ''.join(canonical(record) + '\n' for record in records)
        if len(lines.encode()) + len(canonical(manifest).encode()) > MAX_BYTES:
            raise ValueError('evidence byte budget exceeded; narrow the run')
        manifest['evidenceSha256'] = hashlib.sha256(lines.encode()).hexdigest()
        return manifest, lines

"""Run evidence is independently recomputed; preflight exercises the real CLI offline."""
import csv
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from optbt import engine, spec as specs
from optbt.evidence import RunEvidence
from test_engine import FakeMarket, FRIDAY_21, SUNDAY_08, SATURDAY_08, flat, write_quotes


def verify_cash(test, record, fees):
    entry_cash = entry_fees = exit_cash = exit_fees = 0.0
    for item in record['entries'] + record['exits']:
        phase, qty, price = item['phase'], item['qty'], item['fillPriceUsd']
        if phase == 'settlement':
            expected_price = max(0, (item['deliveryEstimateUsd'] - item['strike']) * (1 if item['isCall'] else -1))
            test.assertAlmostEqual(price, expected_price)
            fee = min(fees['settle_rate'] * item['deliveryEstimateUsd'], fees['settle_cap_pct'] * price) * qty
        elif item['instrument'] == 'perp':
            fee = fees['perp_rate'] * price * qty
        else:
            quote = item['quote']; model = item['fillModel']; buy = item['sign'] > 0 if phase == 'entry' else item['sign'] < 0
            bid, ask = quote['bid'], quote['ask']
            valid_bid, valid_ask = bid is not None and bid > 0, ask is not None and ask > 0
            if model == 'mark':
                expected_price = quote['mark']
            elif model == 'mid':
                expected_price = (bid + ask) / 2 if valid_bid and valid_ask and ask >= bid else quote['mark']
            else:
                wanted = ask if (model == 'cross') == buy else bid
                expected_price = wanted if wanted is not None and wanted > 0 else quote['mark']
            test.assertAlmostEqual(price, expected_price)
            fee = min(fees['rate'] * quote['forward'], fees['cap_pct'] * price) * qty
        if item.get('feeTreatment') == 'carried_perp_fee_waived':
            fee = 0.0
        test.assertAlmostEqual(item['feeUsd'], fee)
        if phase == 'entry':
            entry_cash += -item['sign'] * price * qty if item['instrument'] == 'option' else 0.0
            entry_fees += fee
        else:
            entry = next(row for row in record['entries'] if row['legIndex'] == item['legIndex'])
            exit_cash += item['sign'] * qty * (price - entry['fillPriceUsd'] if item['instrument'] == 'perp' else price)
            exit_fees += fee
    funding = sum(item['paidUsd'] for item in record['funding']['legs'])
    if record['funding']['events'] is not None:
        one_btc = sum(event['rate'] * event['price']['priceUsd'] for event in record['funding']['events'])
        for leg in record['funding']['legs']:
            test.assertAlmostEqual(leg['paidUsd'], leg['sign'] * leg['qty'] * one_btc)
    net = entry_cash - entry_fees + exit_cash - exit_fees - funding
    test.assertAlmostEqual(record['calculation']['netUsd'], net)
    reported = round(record['preCarryReportedPnlUsd'] + record['carryFeeRefundUsd'], 2) if 'carryFeeRefundUsd' in record else round(net, 2)
    test.assertEqual(record['reportedPnlUsd'], reported)


class EvidenceEngineTest(unittest.TestCase):
    def test_early_exit_and_carried_perp_evidence_preserve_results_and_refund_exact_leg_fees(self):
        spec = specs.validate({'entry': {'hours': list(range(24))}, 'expiry': {'dte': 1},
                               'legs': [{'type': 'call', 'side': 'sell', 'delta': 0.5}, {'type': 'perp', 'side': 'buy'}],
                               'fill': 'cross', 'exit': {'close_hours_before_expiry': 24}})
        market = FakeMarket(flat(hours=range(FRIDAY_21, SATURDAY_08 + 2)), settlements={SATURDAY_08: 40000})
        reference, skipped, window = engine.run(spec, market)
        evidence = RunEvidence(spec)
        actual, actual_skipped, actual_window = engine.run(spec, market, evidence=evidence)
        manifest, lines = evidence.bundle(actual, market)
        self.assertEqual([{key: value for key, value in trade.items() if key != 'evidence_id'} for trade in actual], reference)
        self.assertEqual((actual_skipped, actual_window), (skipped, window))
        records = [json.loads(line) for line in lines.splitlines()]
        self.assertTrue(any('carryFeeRefundUsd' in record for record in records))
        for record in records:
            if record['state'] == 'closed':
                verify_cash(self, record, spec['fees'])
        self.assertEqual(manifest['feeModelVersion'], manifest['modelVersion']['engine.py'])

    def test_missing_quotes_and_unknown_settlement_are_unresolved_not_zero(self):
        spec = specs.validate({'entry': {'hours': [21]}, 'expiry': {'dte': 0}, 'legs': [{'type': 'call', 'side': 'sell', 'delta': 0.5}]})
        market = FakeMarket({FRIDAY_21: 40000, SATURDAY_08 + 1: 40000})
        evidence = RunEvidence(spec); trades, skipped, _ = engine.run(spec, market, evidence=evidence)
        _, lines = evidence.bundle(trades, market); record = json.loads(lines)
        self.assertEqual(record['state'], 'settlement'); self.assertIsNone(record['netUsd'])
        self.assertGreater(len(record['missingQuoteHours']), 0); self.assertEqual(skipped['unsettled_at_data_end'], 1)


@unittest.skipUnless(importlib.util.find_spec('pyarrow'), 'optional parquet dependencies unavailable')
class EvidenceParquetTest(unittest.TestCase):
    def setup_data(self, root, perp=False, missing=()):
        data = root / 'options'; data.mkdir()
        first, last = FRIDAY_21, SUNDAY_08
        rows = [(hour * 3600 - 60, last * 3600, 40000.0, True, 41000.0, 1100.0, math.nan, 1150.0)
                for hour in range(first, last + 1) if hour not in missing]
        write_quotes(data / '2024-01.parquet', rows, units={'price': 'usd', 'iv': 'fraction'})
        perp_root = root / 'perp'
        if perp:
            folder = perp_root / 'BTCUSDT'; folder.mkdir(parents=True)
            with (folder / 'klines-2024-01.csv').open('w', newline='') as handle:
                csv.writer(handle).writerows((hour, 41000 + hour - first) for hour in range(first - 24, last + 1))
            with (folder / 'funding-2024-01.csv').open('w', newline='') as handle:
                csv.writer(handle).writerows((hour, 0.0001) for hour in range(first + 1, last + 1) if hour % 8 == 0)
        spec = {'name': 'fixture', 'start': engine.utc(first).isoformat(), 'end': engine.utc(first).isoformat(),
                'entry': {'hours': [21]}, 'expiry': {'dte': 2}, 'fill': 'mid',
                'legs': [{'side': 'sell', 'type': 'call', 'delta': 0.5}] + ([{'side': 'buy', 'type': 'perp'}] if perp else [])}
        return data, perp_root, spec, rows

    def test_actual_run_cli_freezes_file_identity_and_all_prices_fees_funding_are_recomputable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data, perp, spec, rows = self.setup_data(root, perp=True)
            args = [sys.executable, '-B', '-m', 'optbt', 'run', json.dumps(spec), '--data', str(data), '--perp-data', str(perp), '--json']
            cwd = Path(__file__).resolve().parents[1]
            for name in ('first', 'repeat'):
                done = subprocess.run(args + ['--out', str(root / name)], cwd=cwd, capture_output=True, text=True, timeout=30)
                self.assertEqual(done.returncode, 0, done.stderr)
            evidence = (root / 'first/evidence.jsonl').read_bytes()
            self.assertEqual(evidence, (root / 'repeat/evidence.jsonl').read_bytes())
            manifest = json.loads((root / 'first/evidence-manifest.json').read_text())
            record = json.loads(evidence)
            verify_cash(self, record, specs.validate(spec)['fees'])
            self.assertEqual(record['entries'][0]['quote']['time'], FRIDAY_21 * 3600 - 60)
            self.assertEqual(record['entries'][0]['fallback'], 'invalid_or_missing_bid_ask_used_mark')
            self.assertEqual(record['exits'][0]['fallback'], 'hourly_underlying_estimate_not_official_TWAP')
            file_ids = {source['id'] for source in manifest['dataFiles']}
            self.assertIn(record['entries'][0]['quote']['source']['fileId'], file_ids)
            self.assertIn(record['funding']['events'][0]['source']['fileId'], file_ids)
            self.assertIn(record['funding']['events'][0]['price']['source']['fileId'], file_ids)
            extra = ((SUNDAY_08 + 24) * 3600 - 60, (SUNDAY_08 + 48) * 3600, 40000.0, True, 43000.0, 3100.0, 3050.0, 3150.0)
            write_quotes(data / '2024-01.parquet', rows + [extra], units={'price': 'usd', 'iv': 'fraction'})
            self.assertEqual(evidence, (root / 'first/evidence.jsonl').read_bytes(), 'future data cannot modify the frozen bundle')
            again = subprocess.run(args + ['--out', str(root / 'first')], cwd=cwd, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(again.returncode, 0, 'existing run folder must never be overwritten')
            self.assertEqual(evidence, (root / 'first/evidence.jsonl').read_bytes())

    def test_preflight_uses_real_selection_tail_hour_gaps_warmup_and_offline_funding(self):
        from optbt.preflight import inspect
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data, perp, raw, _ = self.setup_data(root, perp=True, missing=(FRIDAY_21 + 3,))
            raw['trend'] = {'ma_days': 1}; raw['legs'][0]['when'] = 'above'
            raw['legs'].append({'type': 'put', 'side': 'sell', 'delta': 0.5, 'when': 'below'})
            spec = specs.validate(raw)
            before = sorted(str(path.relative_to(root)) for path in root.rglob('*'))
            with patch('optbt.binance.fetch', side_effect=AssertionError('preflight must never download')), patch('optbt.engine.run', side_effect=AssertionError('no simulation')):
                result = inspect(spec, data, perp)
            self.assertEqual(result['ranges']['trendWarmup'], [FRIDAY_21 - 23, FRIDAY_21 - 1])
            self.assertEqual(result['ranges']['tailUpperBound'], [FRIDAY_21 + 1, SUNDAY_08])
            self.assertEqual(result['optionHourGaps']['rangesInclusive'], [[FRIDAY_21 + 3, FRIDAY_21 + 3]])
            self.assertGreater(result['selectedQuoteGapCount'], 0)
            self.assertEqual(result['fundingCoverage'], 'local_rows_checked_schedule_completeness_unverified')
            self.assertEqual(sorted(str(path.relative_to(root)) for path in root.rglob('*')), before)
            done = subprocess.run([sys.executable, '-B', '-m', 'optbt', 'preflight', json.dumps(raw), '--data', str(data), '--perp-data', str(perp), '--json'],
                                  cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
            self.assertEqual(done.returncode, 2, done.stderr)
            self.assertEqual(json.loads(done.stdout)['optionHourGaps'], result['optionHourGaps'])
            self.assertFalse((data / '.optbt-cache').exists())

    def test_preflight_reports_unit_conflicts_missing_months_perp_files_and_unknown_delivery(self):
        from optbt.preflight import inspect
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data, perp, raw, rows = self.setup_data(root, perp=False)
            result = inspect(specs.validate(raw), data, perp, price_unit='btc')
            self.assertTrue(any(error['kind'] == 'units_conflict' for error in result['errors']))
            raw['legs'].append({'side': 'buy', 'type': 'perp'})
            raw['trend'] = {'ma_days': 10}; raw['legs'][0]['when'] = 'above'
            raw['legs'].append({'type': 'call', 'side': 'buy', 'delta': 0.5, 'when': 'below'})
            result = inspect(specs.validate(raw), data, perp)
            self.assertTrue(any(error['kind'] == 'perp_file_unavailable' for error in result['errors']))
            self.assertTrue(any(error['kind'] == 'funding_file_unavailable' for error in result['errors']))
            self.assertGreater(result['trendUnavailableEntries']['count'], 0)
            # An entry contract expires after every retained observation: delivery is explicitly unknown.
            write_quotes(data / '2024-01.parquet', rows[:2], units={'price': 'usd', 'iv': 'fraction'})
            result = inspect(specs.validate(raw), data, perp)
            self.assertTrue(result['unknownSettlements'])
            raw['start'] = '2023-12-01'; raw['end'] = '2024-02-01'
            result = inspect(specs.validate(raw), data, perp)
            self.assertTrue(any(error['kind'] == 'missing_month_file' and error['month'] == '2023-12' for error in result['errors']))
            self.assertFalse((data / '.optbt-cache').exists())

    def test_preflight_distinguishes_delivery_estimate_from_reachable_exit_hour(self):
        from optbt.preflight import inspect
        from optbt.market import ParquetMarket
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); data, perp, raw, rows = self.setup_data(root)
            write_quotes(data / '2024-01.parquet', rows[:-2], units={'price': 'usd', 'iv': 'fraction'})
            spec = specs.validate(raw)
            with patch('optbt.engine.run', side_effect=AssertionError('preflight must not simulate')):
                result = inspect(spec, data, perp)
            market = ParquetMarket(data, read_only=True)
            self.assertIsNotNone(market.settlement(SUNDAY_08), 'the two-hours-old forward remains a valid delivery estimate')
            trades, skipped, _ = engine.run(spec, market); market.close()
            self.assertEqual(trades, []); self.assertEqual(skipped['open_at_data_end'], 1)
            self.assertFalse(result['ready']); self.assertEqual(result['unknownSettlements'], [])
            coverage = result['exitCoverage'][0]
            self.assertEqual(coverage['firstExpiryHour'], SUNDAY_08)
            self.assertEqual(coverage['lastDataHour'], SUNDAY_08 - 2)
            self.assertEqual(coverage['status'], 'required_exit_after_data_end'); self.assertTrue(coverage['definitelyUnreachable'])

            raw['exit'] = {'close_hours_before_expiry': 3}
            timed = inspect(specs.validate(raw), data, perp)
            market = ParquetMarket(data, read_only=True)
            trades, _, _ = engine.run(specs.validate(raw), market); market.close()
            self.assertEqual(trades[0]['reason'], 'time_exit')
            self.assertEqual(timed['exitCoverage'][0]['status'], 'scheduled_exit_within_data')
            self.assertFalse(timed['exitCoverage'][0]['definitelyUnreachable']); self.assertTrue(timed['ready'])

            raw['exit'] = {'stop_loss_pct': 0.001}
            conditional = inspect(specs.validate(raw), data, perp)
            market = ParquetMarket(data, read_only=True)
            trades, _, _ = engine.run(specs.validate(raw), market); market.close()
            self.assertEqual(trades[0]['reason'], 'stop_loss')
            self.assertFalse(conditional['ready'], 'conservative coverage cannot prove a price-triggered exit without simulation')
            self.assertEqual(conditional['exitCoverage'][0]['status'], 'early_exit_unverified')
            self.assertFalse(conditional['exitCoverage'][0]['definitelyUnreachable'], 'an actual early close must not be declared impossible')


if __name__ == '__main__':
    unittest.main()

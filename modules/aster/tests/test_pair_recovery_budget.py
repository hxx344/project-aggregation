"""A persisted review stage fits the reserve without repeated account reads."""
from unittest import TestCase
from unittest.mock import patch
import time

from tests import test_pair_manual_baseline as baseline
from tests import test_pair_member_budget as members
from trading.exchange import BudgetWait
from trading.pair_execution import PairTrader


class PairRecoveryBudgetTests(TestCase):
    setUp = baseline.PairManualBaselineLiveTests.setUp
    tearDown = baseline.PairManualBaselineLiveTests.tearDown
    seed = baseline.PairManualBaselineLiveTests.seed
    state = baseline.PairManualBaselineLiveTests.state
    broker = baseline.PairManualBaselineLiveTests.broker
    no_writes = baseline.PairManualBaselineLiveTests.no_writes
    budgets = members.PairMemberBudgetTests.budgets

    def prepare(self, *, review=False):
        original = self.seed()
        if review:
            original['pending']['position_review'] = True
            self.f.store.put('pair_runtime:gold', original)
        for broker in self.live.values():
            broker.api.calls.clear()
            broker.cached_at.clear()
        return original, self.budgets()['test']

    def check(self):
        with self.no_writes():
            return self.engine.pairs.check_recovery('gold')

    def test_cold_review_after_restart_completes_with_142_weight_and_no_open_orders(self):
        original, budget = self.prepare(review=True)
        budget.reserve(1500)
        self.engine.pairs.trader = PairTrader(self.engine)
        result = self.check()
        self.assertTrue(result['completed'], result)
        self.assertEqual(budget.snapshot()['used'], 1642)
        for broker in self.live.values():
            paths = [call[1] for call in broker.api.calls]
            self.assertEqual(paths.count('/fapi/v3/accountWithJoinMargin'), 1)
            self.assertEqual(paths.count('/fapi/v3/openOrders'), 0)
        self.assertEqual(self.state()['owned'], original['owned'])

    def test_review_with_1724_used_does_not_spend_any_partial_read(self):
        original, budget = self.prepare(review=True)
        with budget.reconciliation():
            budget.reserve(1724)
        result = self.check()
        self.assertFalse(result['completed'])
        self.assertEqual(budget.snapshot()['used'], 1724)
        self.assertTrue(all(not broker.api.calls for broker in self.live.values()))
        self.assertEqual(self.state()['pending']['legs'], original['pending']['legs'])
        self.assertGreater(self.state()['pending']['position_review_retry_at'], time.time())

    def test_failed_terminal_review_waits_before_manual_or_restarted_reads(self):
        original, budget = self.prepare(review=True)
        wall = time.time()
        with patch('time.time', side_effect=lambda: wall), \
                patch.object(self.engine.pairs, '_read_members', side_effect=BudgetWait('quota', retry_after=90)) as reads:
            self.check()
            wall += 30
            self.engine.pairs.trader = PairTrader(self.engine)
            self.check()
            self.assertEqual(reads.call_count, 1)
            wall += 59
            self.check()
            self.assertEqual(reads.call_count, 1)
        self.assertEqual(self.state()['pending']['legs'], original['pending']['legs'])
        wall += 1
        with patch('time.time', side_effect=lambda: wall):
            self.assertTrue(self.check()['completed'])

    def test_review_flag_does_not_replace_unknown_order_query(self):
        original, budget = self.prepare(review=True)
        original['pending']['legs'][0]['receipt'] = None
        self.f.store.put('pair_runtime:gold', original)
        with patch.object(self.engine.pairs, '_read_members', side_effect=AssertionError('unknown order')):
            result = self.check()
        self.assertFalse(result['completed'])
        self.assertIsNotNone(self.state()['pending'])
        self.assertIn('/fapi/v3/order', [call[1] for call in self.broker().api.calls])

    def test_market_order_review_does_not_request_unrelated_open_orders(self):
        original, budget = self.prepare(review=True)
        self.broker().api.responses['/fapi/v3/openOrders'] = [{'symbol': 'SPCXUSD1'}]
        self.assertTrue(self.check()['completed'])
        self.assertEqual(self.state()['owned'], original['owned'])
        self.assertIsNone(self.state()['pending'])
        self.assertTrue(all(not any(call[1].endswith('/openOrders') for call in broker.api.calls)
                            for broker in self.live.values()))

    def test_changed_positions_use_same_full_read_for_existing_repair_decision(self):
        from tests.test_cycle_account_snapshot import ACCOUNT, RISK, risk_row
        original, budget = self.prepare(review=True)
        rows = self.broker('short').api.responses[ACCOUNT]['positions']
        for row in rows:
            if row['positionSide'] == 'SHORT':
                row['positionAmt'] = '-0.9'
        self.broker('short').api.responses[RISK] = [risk_row(row) for row in rows]
        result = self.check()
        self.assertFalse(result['completed'])
        self.assertEqual(self.state()['phase'], 'repairing')
        self.assertEqual(self.state()['pending']['repairs'], [])
        self.assertEqual(budget.snapshot()['used'], 142)
        self.assertEqual(self.state()['owned'], original['owned'])

"""ADL scene admission uses real budgets and offline account responses only."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests import test_adl_exchange as fixtures
from trading.adl_exchange import reduction_snapshot, require_snapshot_budget
from trading.exchange import BudgetWait, LiveBroker, RateBudget, RequestNotSent


class BudgetAPI:
    def __init__(self, budget, account_id):
        self.budget = budget
        self.credentials = {"user": "wallet-" + account_id, "signer": "signer-" + account_id}
        self.responses = fixtures.responses()
        self.calls = []

    def call(self, method, path, *args, **kwargs):
        self.budget.reserve(kwargs.get("weight", 1))
        self.calls.append((method, path, kwargs, self.budget._priority_flags()))
        return deepcopy(self.responses[path])

    def close(self):
        pass


class AdlSnapshotBudgetTests(unittest.TestCase):
    def setUp(self):
        network = patch("httpx.Client.request", side_effect=AssertionError("live HTTP forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def brokers(self, *, shared=True):
        first = RateBudget()
        result = {}
        for aid in ("a", "b"):
            budget = first if shared else RateBudget()
            broker = result[aid] = LiveBroker({}, SimpleNamespace(), api=BudgetAPI(budget, aid))
            self.addCleanup(broker.close)
        return result

    @staticmethod
    def spend(budget, weight):
        with budget.reconciliation():
            budget.reserve(weight)

    @staticmethod
    def read(brokers, *, market_only=False):
        require_snapshot_budget(brokers, market_only=market_only)
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(lambda broker: reduction_snapshot(broker, market_only=market_only), brokers.values()))

    def assert_no_reads(self, brokers):
        self.assertTrue(all(not broker.api.calls for broker in brokers.values()))

    def test_shared_budget_admits_both_members_before_spending_any_partial_read(self):
        for market_only, total in ((False, 160), (True, 80)):
            with self.subTest(market_only=market_only):
                brokers = self.brokers()
                budget = brokers["a"].api.budget
                used = budget.limit - total + 1
                self.spend(budget, used)
                with patch.object(budget, "require_available", wraps=budget.require_available) as admission:
                    with self.assertRaises(BudgetWait):
                        self.read(brokers, market_only=market_only)
                admission.assert_called_once_with(total)
                self.assertEqual(budget.snapshot()["used"], used)
                self.assertEqual(budget._priority_flags(), (False, False, False))
                self.assert_no_reads(brokers)

    def test_market_scene_fits_last_80_weight_without_full_order_inventory(self):
        brokers = self.brokers()
        budget = brokers["a"].api.budget
        self.spend(budget, 1720)
        with self.assertRaises(BudgetWait):
            self.read(brokers)
        self.assert_no_reads(brokers)
        snapshots = self.read(brokers, market_only=True)
        self.assertEqual(len(snapshots), 2)
        self.assertEqual(budget.snapshot()["used"], 1800)
        for broker in brokers.values():
            self.assertEqual([call[1] for call in broker.api.calls], [fixtures.ACCOUNT, fixtures.RISK, fixtures.DUAL])
            self.assertTrue(all(call[3] == (True, False, False) for call in broker.api.calls))

    def test_full_scene_keeps_all_four_requests_and_exact_160_weight(self):
        brokers = self.brokers()
        budget = brokers["a"].api.budget
        self.spend(budget, 1640)
        self.read(brokers)
        self.assertEqual(budget.snapshot()["used"], 1800)
        for broker in brokers.values():
            self.assertEqual([call[1] for call in broker.api.calls],
                             [fixtures.ACCOUNT, fixtures.RISK, fixtures.DUAL, fixtures.ORDERS])

    def test_separate_budgets_only_admit_their_own_account(self):
        brokers = self.brokers(shared=False)
        for broker in brokers.values():
            self.spend(broker.api.budget, 1720)
        self.read(brokers)
        self.assertTrue(all(broker.api.budget.snapshot()["used"] == 1800 for broker in brokers.values()))

    def test_one_insufficient_independent_budget_prevents_either_account_read(self):
        brokers = self.brokers(shared=False)
        self.spend(brokers["b"].api.budget, 1761)
        with self.assertRaises(BudgetWait):
            self.read(brokers, market_only=True)
        self.assertEqual(brokers["a"].api.budget.snapshot()["used"], 0)
        self.assertEqual(brokers["b"].api.budget.snapshot()["used"], 1761)
        self.assert_no_reads(brokers)

    def test_whole_scene_admission_cannot_bypass_exchange_cooldown(self):
        brokers = self.brokers()
        budget = brokers["a"].api.budget
        budget.block(180, reason="HTTP 429")
        for market_only in (False, True):
            with self.subTest(market_only=market_only), self.assertRaises(RequestNotSent) as raised:
                self.read(brokers, market_only=market_only)
            self.assertGreater(raised.exception.retry_after, 170)
        self.assertEqual(budget.snapshot()["used"], 0)
        self.assert_no_reads(brokers)

    def test_preflight_is_not_a_lease_and_actual_requests_keep_atomic_budget_checks(self):
        brokers = self.brokers()
        budget = brokers["a"].api.budget
        self.spend(budget, 1640)
        require_snapshot_budget(brokers)
        self.assertEqual(budget.snapshot()["used"], 1640)
        self.spend(budget, 160)
        with self.assertRaises(BudgetWait):
            reduction_snapshot(brokers["a"])
        self.assertEqual(budget.snapshot()["used"], 1800)
        self.assert_no_reads(brokers)

    def test_only_explicit_market_mode_can_skip_inventory_or_lower_admission(self):
        brokers = self.brokers()
        budget = brokers["a"].api.budget
        self.spend(budget, 1720)
        for value in (None, "true", 1):
            with self.subTest(market_only=value), self.assertRaises(BudgetWait):
                self.read(brokers, market_only=value)
        self.assert_no_reads(brokers)


if __name__ == "__main__":
    unittest.main()

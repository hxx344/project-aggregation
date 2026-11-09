"""Margin-check quota admission and visible wait state, using offline brokers only."""
import time
from unittest import TestCase
from unittest.mock import patch

from tests import pair_fixtures as fixtures
from trading.exchange import BudgetWait, ExchangeError, RequestNotSent, api_wait_notice


class PairAPIWaitTests(TestCase):
    setUp = fixtures.PairBudgetTests.setUp
    live_brokers = fixtures.PairBudgetTests.live_brokers
    tick = fixtures.PairBudgetTests.tick

    def enable_margin(self):
        self.margin.stop()  # Exercise the real balancer's backoff.
        self.live_brokers()
        self.pair["margin"]["enabled"] = True
        self.pair = self.store.save_pair(self.pair)

    def read_count(self):
        return sum(path == "/fapi/v3/accountWithJoinMargin"
                   for broker in self.brokers.values() for _, path, _ in broker.api.calls)

    def test_shared_read_admission_rejects_before_either_account_spends(self):
        self.enable_margin()
        weight = sum(broker.transfer_snapshot_weight() for broker in self.brokers.values())
        self.budget.reserve(self.budget._execution_limit() - weight + 1)  # One read fits, both do not.
        before = self.budget.local_weight
        with self.assertRaises(BudgetWait):
            self.trader._read(self.brokers, "XAUUSD1")
        self.assertEqual(self.budget.local_weight, before)
        self.assertFalse(any(b.api.calls for b in self.brokers.values()))

    def test_balance_budget_wait_does_not_repeat_private_reads(self):
        self.enable_margin()
        deadline = time.time() + 30
        notice = {"kind": "budget", "text": "本地执行 API 请求权重预算不足"}
        self.store.put("pair_margin:gold", {"api_notice": notice, "blocked_reason": notice["text"],
                                           "next_check_at": deadline})
        with patch.object(self.trader, "_read", side_effect=AssertionError("must not read during backoff")):
            for _ in range(3):
                state = self.tick()
                self.assertEqual(state["phase"], "margin_wait")
                self.assertGreater(state["retry_after"], 20)
        self.assertEqual(self.read_count(), 0)

    def test_safe_wait_classification_does_not_copy_unrelated_remote_error(self):
        self.assertIsNone(api_wait_notice(ExchangeError("untrusted secret=plaintext", code=-2019)))
        self.assertIsNone(api_wait_notice(RequestNotSent("账户状态变化")))
        self.assertEqual(api_wait_notice(RequestNotSent("接口冷却中：HTTP 429", retry_after=5))["kind"], "cooldown")
        result = api_wait_notice(ExchangeError("HTTP 429 secret=plaintext", http_status=429))
        self.assertEqual(result["kind"], "rate_limit")
        self.assertNotIn("plaintext", result["text"])

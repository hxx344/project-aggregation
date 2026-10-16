"""Unknown acknowledgments retain display timestamps without extra REST reads."""
from contextlib import ExitStack
import time
import unittest
from unittest.mock import patch

from tests import test_pair_integration as integration
from tests import test_pair_order_recovery as recovery
from trading.exchange import BudgetWait, ExchangeError
from trading.pair_execution import PairTrader


class PairUnknownObservationTests(unittest.TestCase):
    setUp = integration.PairIntegrationTests.setUp
    seed = recovery.PairOrderRecoveryTests.seed
    state = recovery.PairOrderRecoveryTests.state
    broker = recovery.PairOrderRecoveryTests.broker
    no_writes = recovery.PairOrderRecoveryTests.no_writes

    def unknown(self, error=None):
        stack = ExitStack()
        stack.enter_context(self.no_writes())
        for side in ("long", "short"):
            stack.enter_context(patch.object(self.broker(side), "query", side_effect=error or
                ExchangeError("Order does not exist", code=-2013)))
        return stack

    def test_observation_window_keeps_old_display_without_snapshot_requests(self):
        original = self.seed()
        original["snapshots"] = {"long": {"timestamp": time.time() - 60, "positions": []}}
        self.f.store.put("pair_runtime:gold", original)
        for side in ("long", "short"):
            broker = self.broker(side)
            broker.state["positions"]["XAUUSD1:" + side.upper()]["qty"] = "12"
            broker.save()
        trader = PairTrader(self.engine)
        self.engine.pairs.trader = trader
        started = time.time()
        with self.unknown(), patch.object(trader, "_read", side_effect=AssertionError("display must not read")):
            for seconds in (0, 1, 3, 10, 30, 60, 119):
                with patch("time.time", return_value=started + seconds):
                    self.engine.pairs.tick("gold")
            current = self.state()
            self.assertIsNotNone(current["pending"])
            self.assertEqual(current["owned"], original["owned"])
            self.assertEqual(current["snapshots"], original["snapshots"])
            self.assertEqual([leg["recovery_query_attempts"] for leg in current["pending"]["legs"]], [3, 3])
            self.assertIsNone(self.f.store.get("pair_batch:" + original["pending"]["id"]))

    def test_query_budget_wait_does_not_spend_more_on_observations(self):
        self.seed()
        trader = PairTrader(self.engine)
        self.engine.pairs.trader = trader
        with self.unknown(BudgetWait("本地 API 请求权重预算不足", retry_after=15)), \
                patch.object(trader, "_read", side_effect=AssertionError("quota backoff must not refresh")):
            self.engine.pairs.tick("gold")
        self.assertEqual(self.state()["api_notice"]["kind"], "budget")
        self.assertNotIn("observation_attempt_at", self.state()["pending"])

    def test_unknown_peer_preserves_old_snapshot_and_known_receipt(self):
        original = self.seed()
        receipt = recovery.receipt_for(original["pending"]["legs"][0], status="REJECTED")
        original["pending"]["legs"][0]["receipt"] = receipt
        original["snapshots"] = {"sentinel": "old-display"}
        self.f.store.put("pair_runtime:gold", original)
        trader = PairTrader(self.engine)
        self.engine.pairs.trader = trader
        with self.unknown(), patch.object(trader, "_read", side_effect=AssertionError("display must not read")):
            self.engine.pairs.tick("gold")
        current = self.state()
        self.assertEqual(current["snapshots"], original["snapshots"])
        self.assertEqual(current["pending"]["legs"][0]["receipt"], receipt)
        self.assertIsNone(current["api_notice"])
        self.assertEqual(current["pending"]["repairs"], [])


if __name__ == "__main__":
    unittest.main()

"""Full recovery evidence is retried on a durable clock, without duplicate reads."""
from copy import deepcopy
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_bounded_recovery as fixtures
from tests import test_pair_order_recovery as orders
from trading.engine import Engine
from trading.exchange import BudgetWait
from trading.models import TradingError
from trading.pair_execution import PairTrader
from trading.store import Store


class PairRealityBackoffTests(TestCase):
    def setUp(self):
        self.f = fixtures.PairBoundedRecoveryTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.ready()
        self.original = deepcopy(self.f.state())
        self.wall = time.time()
        clock = patch("time.time", side_effect=lambda: self.wall)
        clock.start()
        self.addCleanup(clock.stop)

    def restart(self):
        self.f.engine = Engine(Store(self.f.f.store.path), market=self.f.f.market)
        self.addCleanup(self.f.engine.dashboard_reports.close)

    def test_failed_reality_waits_30_then_60_seconds_across_manual_checks_and_restart(self):
        original = deepcopy(self.f.state())
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=TradingError("positions still syncing")) as reads:
            self.assertEqual(self.f.engine.pairs.tick("gold"), 30)
            started = self.wall
            for offset in (1, 4, 20, 29):
                self.wall = started + offset
                self.f.engine.pairs.tick("gold")
                self.f.engine.pairs.check_recovery("gold")
            self.assertEqual(reads.call_count, 1)
        state = self.f.state()
        self.assertEqual(state["pending"]["legs"], original["pending"]["legs"])
        self.assertEqual(state["owned"], original["owned"])
        deadline = state["pending"]["bounded_recovery"]["next_check_at"]
        self.restart()
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=TradingError("positions still syncing")) as reads:
            self.wall = deadline - 1
            self.f.engine.pairs.check_recovery("gold")
            reads.assert_not_called()
            self.wall = deadline
            self.assertEqual(self.f.engine.pairs.tick("gold"), 60)
            self.wall += 59
            self.f.engine.pairs.check_recovery("gold")
            self.assertEqual(reads.call_count, 1)
        self.wall += 1
        self.f.engine.pairs.tick("gold")
        self.assertIsNone(self.f.state()["pending"])

    def test_budget_deadline_survives_manual_calls_and_restart_without_losing_known_receipt(self):
        state = self.f.state()
        state["pending"]["legs"][0]["receipt"] = orders.receipt_for(state["pending"]["legs"][0], status="FILLED", qty="0.2")
        state["snapshots"] = {"long": {"timestamp": self.wall - 120, "positions": []}}
        self.f.f.store.put("pair_runtime:gold", state)
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=BudgetWait("quota", retry_after=90)) as reads:
            self.assertEqual(self.f.engine.pairs.tick("gold"), 90)
            self.wall += 31
            self.f.engine.pairs.check_recovery("gold")
            self.assertEqual(reads.call_count, 1)
        self.restart()
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=AssertionError("quota wait")):
            self.wall += 58
            self.f.engine.pairs.tick("gold")
            self.f.engine.pairs.check_recovery("gold")
        current = self.f.state()
        self.assertEqual(current["pending"]["legs"], state["pending"]["legs"])
        self.assertEqual(current["snapshots"], state["snapshots"])
        self.assertEqual(current["api_notice"]["kind"], "budget")
        self.wall += 1
        self.f.engine.pairs.tick("gold")
        self.assertIsNone(self.f.state()["pending"])

    def test_backwards_clock_restarts_saved_wait_without_immediate_read(self):
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=BudgetWait("quota", retry_after=90)) as reads:
            self.f.engine.pairs.tick("gold")
            self.wall -= 20
            self.f.engine.pairs.tick("gold")
            deadline = self.f.state()["pending"]["bounded_recovery"]["next_check_at"]
            self.assertEqual(deadline - self.wall, 90)
            self.wall += 89
            self.f.engine.pairs.check_recovery("gold")
            self.assertEqual(reads.call_count, 1)

    def test_margin_checks_continue_during_order_reality_backoff(self):
        pair = self.f.f.store.pair("gold")
        pair["enabled"] = True
        pair["margin"].update(enabled=True, check_interval_seconds=5)
        self.f.f.store.save_pair(pair)
        trader = self.f.engine.pairs.trader
        with patch.object(self.f.engine.pairs, "_read_members", side_effect=TradingError("positions still syncing")) as reads, \
                patch.object(trader, "_balance", return_value={"blocks_trading": False}) as balance:
            self.assertEqual(self.f.engine.pairs.tick("gold"), 5)
            self.wall += 5
            self.assertEqual(self.f.engine.pairs.tick("gold"), 5)
            self.assertEqual(reads.call_count, 1)
            self.assertEqual(balance.call_count, 2)
        self.assertEqual(self.f.state()["pending"]["legs"], self.original["pending"]["legs"])

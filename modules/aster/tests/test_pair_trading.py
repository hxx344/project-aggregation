"""Offline regressions for two independent collateral budgets and recovery."""
from copy import deepcopy
from fractions import Fraction
import tempfile
import threading
import time
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from tests.helpers import account, seed_market_capacity
from trading.engine import Engine
from trading.exchange import AmbiguousOrder, ExchangeError
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader
from trading.pair_planning import plan_ordinary
from trading.pairing import validate_pair
from trading.paper import DemoMarket, PaperBroker
from trading.store import Store


class PairTradingTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.market = DemoMarket()
        self.engine = Engine(self.store, market=self.market)
        self.brokers = {}
        for key in ("long", "short"):
            value = account(key)
            value["enabled"] = False
            self.store.save_account(value)
            self.brokers[key] = PaperBroker(key, self.market, self.store)
            self.engine.brokers[key] = self.brokers[key]
        self.pair = self.store.save_pair(validate_pair({"id": "gold", "name": "黄金配对", "long_account_id": "long",
            "short_account_id": "short", "enabled": True, "ordinary": {"enabled": True}}), create=True)
        self.trader = PairTrader(self.engine)
        seed_market_capacity(self.engine)
        self.engine.markets["XAUUSD1"]["capacities"] = {"5": "1000000", "10": "0", "20": "0"}
        self.margin = patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": False})
        self.margin.start()
        self.addCleanup(self.margin.stop)

    def tick(self):
        seed_market_capacity(self.engine)
        current = max(broker.state["leverages"]["XAUUSD1"] for broker in getattr(self, "paper", self.brokers).values())
        self.engine.markets["XAUUSD1"]["capacities"] = {
            str(leverage): "1000000" if leverage <= current else "0" for leverage in (5, 10, 20)}
        return self.trader.tick(self.store.pair("gold"))

    def snapshots(self):
        return {key: broker.snapshot(["XAUUSD1"]) for key, broker in self.brokers.items()}

    def expire(self):
        state = self.store.get("pair_runtime:gold")
        state["progress"]["opened_at"] = time.time() - 100
        self.store.put("pair_runtime:gold", state)

    def assert_flat(self):
        self.assertTrue(all(not p.qty for snap in self.snapshots().values() for p in snap.positions))

    def test_orders_are_parallel_single_direction_and_resume_after_restart(self):
        barrier = threading.Barrier(2, timeout=3)
        originals = {key: broker.submit for key, broker in self.brokers.items()}
        def send(key, orders):
            self.assertIsNotNone(self.store.get("pair_runtime:gold")["pending"])
            self.assertEqual(len(orders), 1)
            self.assertEqual(orders[0]["type"], "MARKET")
            self.assertEqual(orders[0]["positionSide"], key.upper())
            barrier.wait()
            return originals[key](orders)
        with patch.object(self.brokers["long"], "submit", side_effect=lambda rows: send("long", rows)), \
             patch.object(self.brokers["short"], "submit", side_effect=lambda rows: send("short", rows)):
            state = self.tick()
        self.assertEqual(state["phase"], "waiting", state)
        self.assertIsNone(state["pending"])
        self.assertEqual(state["owned"]["LONG"], state["owned"]["SHORT"])
        owned = deepcopy(state["owned"])
        pair = self.store.save_pair({**self.store.pair("gold"), "enabled": False})
        self.trader = PairTrader(self.engine)
        state = self.trader.tick(pair)
        self.assertEqual(state["owned"], owned)
        self.assertEqual(len(self.brokers["long"].state["orders"]), 1)

    def test_reject_one_leg_reduces_other_without_opening_missing_leg(self):
        with patch.object(self.brokers["short"], "submit", side_effect=ExchangeError("余额不足", code=-2019)):
            state = self.tick()
        self.assertEqual(state["phase"], "repairing", state)
        self.assertIsNotNone(state["pending"])
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertFalse(state["last_batch"]["completed"])
        self.assertEqual(len(self.brokers["long"].state["orders"]), 2)
        self.assertEqual(len(self.brokers["short"].state["orders"]), 0)
        self.assert_flat()

    def test_timeout_after_fill_queries_same_id_without_resending(self):
        original = self.brokers["long"].submit
        def timeout(orders):
            original(orders)
            raise AmbiguousOrder("模拟回执丢失")
        with patch.object(self.brokers["long"], "submit", side_effect=timeout) as send:
            state = self.tick()
        self.assertEqual(send.call_count, 1)
        self.assertEqual(state["phase"], "waiting", state)
        self.assertEqual(len(self.brokers["long"].state["orders"]), 1)

    def test_unknown_live_style_query_blocks_retries_and_margin(self):
        with patch.object(self.brokers["long"], "submit", side_effect=AmbiguousOrder("timeout")), \
             patch.object(self.brokers["long"], "query", side_effect=ExchangeError("order not found", code=-2013)):
            state = self.tick()
            self.assertIsNotNone(state["pending"])
            frozen = deepcopy(state["pending"]["legs"])
            with patch.object(self.brokers["short"], "submit", side_effect=AssertionError("never repeat")), \
                 patch("trading.margin_balance.MarginBalancer.tick", side_effect=AssertionError("no transfer during unknown")):
                for _ in range(3):
                    state = self.tick()
            self.assertEqual(state["pending"]["legs"][0]["order"], frozen[0]["order"])
            self.assertEqual(state["phase"], "reconciling")

    def test_weak_subaccount_limits_quantity_despite_large_combined_equity(self):
        self.brokers["long"].state["wallet"] = "50"
        self.brokers["long"].save()
        value = deepcopy(self.pair)
        value["ordinary"]["order_notional"] = "500"
        with self.assertRaises(TradingError):
            plan_ordinary(value, self.snapshots(), self.market.book("XAUUSD1"),
                          self.market.rules["XAUUSD1"], {5: "1000000"})
        self.assertLess(self.snapshots()["long"].ratio, dec("0.55"))

    def test_public_capacity_counts_both_accounts_not_each_independently(self):
        value = deepcopy(self.pair)
        value["ordinary"]["threshold"] = "0"
        value["ordinary"]["order_notional"] = "100000"
        book = self.market.book("XAUUSD1")
        plan = plan_ordinary(value, self.snapshots(), book, self.market.rules["XAUUSD1"], {5: "2000"})
        self.assertLessEqual(Fraction(plan.qty) * 2 * max(Fraction(book.ask), Fraction(book.mark)), 2000)

    def test_final_configuration_change_prevents_both_submissions(self):
        original = self.trader._config_guard
        calls = 0
        def guard(pair, identities, *, opening):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise TradingError("changed")
            return original(pair, identities, opening=opening)
        with patch.object(self.trader, "_config_guard", side_effect=guard):
            state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assert_flat()
        self.assertFalse(self.brokers["long"].state["orders"])

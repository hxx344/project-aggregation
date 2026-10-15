"""Funds-only activation and real signed transfers ignore strategy evidence."""
from contextlib import ExitStack
from copy import deepcopy
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_integration as integration
from tests import test_pair_margin_lifeline_live as live
from trading.models import TradingError, dec, wire
from trading.pair_execution import runtime_default
from trading.paper import DemoMarket


class PairMarginCreationTests(TestCase):
    setUp = integration.PairIntegrationTests.setUp

    def test_create_and_start_with_other_symbols_directions_and_leverages(self):
        first = self.f.broker
        second = self.engine.broker(self.f.store.account("second"))
        first.state["positions"]["SPCXUSD1:SHORT"].update(qty="1", entry="724.185")
        first.state["positions"]["CLUSD1:LONG"].update(qty="2", entry="79.325")
        second.state["positions"]["XAUUSD1:LONG"].update(qty="0.003", entry="4412.015")
        second.state["leverages"]["XAUUSD1"] = 10
        first.save()
        second.save()
        config = integration.pair_config(cycle={"enabled": False}, margin={"enabled": True})
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("no strategy evidence")):
            pair = self.engine.pairs.create(config)
            self.assertEqual(pair["symbol"], "XAUUSD1")
            self.assertTrue(self.engine.pairs.enable("gold", True)["enabled"])
        runtime = self.f.store.get("pair_runtime:gold")
        self.assertEqual(runtime["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(runtime["snapshots"], {})
        self.assertEqual(first.state["positions"]["SPCXUSD1:SHORT"]["qty"], "1")
        self.assertEqual(first.state["orders"], {})

    def test_ordinary_and_cycle_creation_allow_other_symbol_holdings(self):
        self.f.broker.state["positions"]["SPCXUSD1:SHORT"].update(qty="1", entry="724.185")
        self.f.broker.save()
        for ordinary in (True, False):
            with self.subTest(ordinary=ordinary):
                pair = self.engine.pairs.create(integration.pair_config(id="ordinary" if ordinary else "cycle",
                    ordinary={"enabled": ordinary}, cycle={"enabled": not ordinary}, margin={"enabled": True}))
                self.assertFalse(pair["enabled"])
                self.assertEqual(self.f.broker.state["positions"]["SPCXUSD1:SHORT"]["qty"], "1")
                self.engine.pairs.delete(pair["id"])
        self.assertEqual(self.f.store.pairs(), [])

    def test_new_group_keeps_exclusive_ownership_and_legacy_recovery_guard(self):
        config = integration.pair_config(cycle={"enabled": False}, margin={"enabled": True})
        self.f.store.save_intent({"id": "pending", "account_id": "test", "status": "pending", "kind": "leverage"})
        with self.assertRaisesRegex(TradingError, "未完成"):
            self.engine.pairs.create(config)
        self.assertIsNone(self.f.store.pair("gold"))


class PairMarginIndependentTests(TestCase):
    transport = live.PairMarginLifelineLiveTests.transport
    tick = live.PairMarginLifelineLiveTests.tick
    assert_no_trades = live.PairMarginLifelineLiveTests.assert_no_trades

    def setUp(self):
        live.PairMarginLifelineLiveTests.setUp(self)
        self.pair["ordinary"]["enabled"] = False
        self.pair["enabled"] = False
        self.pair = self.store.save_pair(self.pair)
        # Exchange response generation has its own quote source. Public market
        # failures below affect only the actual application, not this fixture.
        for paper in self.paper.values():
            paper.market = DemoMarket()

    def start(self):
        self.pair = self.engine.pairs.enable("gold", True)
        return self.store.get("pair_runtime:gold")

    def mixed_positions(self):
        for side, rows in {
            "long": [("CLUSD1", "LONG", "2"), ("SPCXUSD1", "SHORT", "0.3"), ("XAUUSD1", "SHORT", "0.01")],
            "short": [("XAUUSD1", "LONG", "0.003"), ("XAGUSD1", "LONG", "0.4")],
        }.items():
            paper = self.paper[side]
            for symbol, direction, qty in rows:
                paper.state["positions"][symbol + ":" + direction].update(
                    qty=qty, entry=wire(paper.market.book(symbol).mark))
            paper.state["leverages"]["XAUUSD1"] = 5 if side == "long" else 20
            paper.save()

    def complete_strategy_orders(self):
        # Strategy starts retain an independent, complete account-order read.
        originals = {side: broker.api.call for side, broker in self.brokers.items()}
        stack = ExitStack()
        for side, broker in self.brokers.items():
            def call(method, path, *args, side=side, **kwargs):
                return [] if path == "/fapi/v3/openOrders" else originals[side](method, path, *args, **kwargs)
            stack.enter_context(patch.object(broker.api, "call", side_effect=call))
        return stack

    def test_start_and_signed_transfer_ignore_positions_market_tiers_and_history(self):
        self.mixed_positions()
        old = {**runtime_default(), "symbol": "CLUSD1", "owned": {"LONG": "6", "SHORT": "7"},
               "recovery_watch": {"batches": [{"id": "old", "symbol": "CLUSD1"}]},
               "attention": "旧策略待核对", "snapshots": {"long": {"timestamp": 1, "positions": ["historical"]}}}
        old["progress"]["baseline"] = deepcopy(old["owned"])
        self.store.put("pair_runtime:gold", old)
        with ExitStack() as stack:
            for target, name in ((self.market, "book"), (self.engine, "capacities"),
                                 (self.engine, "cycle_book"), (self.engine.pairs, "_read_members")):
                stack.enter_context(patch.object(target, name, side_effect=AssertionError("strategy path")))
            stack.enter_context(patch("trading.pair_recovery.require_archived_orders_clear",
                                     side_effect=AssertionError("historical order query")))
            for broker in self.brokers.values():
                broker.api.fail_brackets = True
                stack.enter_context(patch.object(broker, "snapshot", side_effect=AssertionError("trade snapshot")))
            self.start()
            state = self.tick()
        self.assertEqual(len(self.sent), 1, state)
        self.assertEqual(self.store.get("pair_margin:gold")["last_transfer"]["status"], "acknowledged")
        for field in ("symbol", "owned", "progress", "pending", "recovery_watch", "attention", "snapshots"):
            self.assertEqual(state[field], old[field], field)
        self.assertEqual(set(state["margin_balances"]), {"long", "short"})
        self.assertTrue(all(row["timestamp"] > 1 for row in state["margin_balances"].values()))
        self.assertTrue(all(path in (live.ACCOUNT, live.INCOME)
                            for broker in self.brokers.values() for _, path, _ in broker.api.calls))
        before = [len(broker.api.calls) for broker in self.brokers.values()]
        self.tick()
        self.assertEqual([len(broker.api.calls) for broker in self.brokers.values()], before)
        self.assertEqual(len(self.sent), 1)
        self.assert_no_trades()

    def test_start_preserves_pending_strategy_and_transfer_records(self):
        identities = self.trader._members(self.pair)[2]
        old = {**runtime_default(), "identities": identities,
               "pending": {"id": "original-order", "kind": "ordinary", "phase": "open",
                           "identities": identities, "symbol": "XAUUSD1"},
               "recovery_watch": {"batches": [{"id": "archive"}]}}
        margin = {"pending": {"request_id": "original-transfer", "status": "unknown"}}
        self.store.put("pair_runtime:gold", old)
        self.store.put("pair_margin:gold", margin)
        with patch.object(self.engine.pairs.recovery, "check", side_effect=AssertionError("must not adopt")):
            state = self.start()
        for field in ("pending", "owned", "progress", "recovery_watch"):
            self.assertEqual(state[field], old[field])
        self.assertEqual(self.store.get("pair_margin:gold"), margin)
        self.assertEqual(self.sent, [])
        self.assert_no_trades()

    def test_pending_leverage_keeps_recovery_without_repeating_write_or_blocking_funds(self):
        identities = self.trader._members(self.pair)[2]
        pending = {"id": "old-leverage", "kind": "leverage", "symbol": "XAUUSD1",
                   "identities": identities, "created_at": time.time(),
                   "before": {"LONG": "0", "SHORT": "0"}, "previous_leverage": 5,
                   "target_leverage": 10, "results": {"long": {"unknown": True}, "short": {"unknown": True}}}
        self.store.put("pair_runtime:gold", {**runtime_default(), "identities": identities, "pending": pending})
        self.start()
        state = self.tick()
        self.assertEqual(state["pending"]["id"], pending["id"])
        self.assertEqual(state["pending"]["results"], pending["results"])
        self.assertEqual(state["pending"]["recovery_query_attempts"], 1)
        self.assertEqual(len(self.sent), 1, state)
        self.assert_no_trades()

    def test_existing_cycle_is_still_reduced_after_margin_only_start(self):
        for side, paper in self.paper.items():
            paper.state["positions"]["XAUUSD1:" + side.upper()].update(qty="0.01", entry="4412.015")
            paper.save()
        old = runtime_default()
        old["progress"].update(phase="holding", quantities={"LONG": "0.01", "SHORT": "0.01"},
            opened_at=time.time() - 10, leverage=5,
            config={**self.pair["cycle"], "enabled": True, "hold_seconds": 1, "leverage": 5})
        self.store.put("pair_runtime:gold", old)
        started = self.start()
        self.assertEqual(started["progress"], old["progress"])
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assertIsNone(state["pending"])
        for side, paper in self.paper.items():
            self.assertEqual(dec(paper.state["positions"]["XAUUSD1:" + side.upper()]["qty"]), 0)
            orders = list(paper.state["orders"].values())
            self.assertEqual(len(orders), 1)
            self.assertEqual(orders[0]["side"], "SELL" if side == "long" else "BUY")

    def test_live_disabled_identity_change_pause_and_maintenance_block_transfers(self):
        with patch.object(self.engine, "live_allowed", return_value=False), self.assertRaises(TradingError):
            self.start()
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.start()
        credentials = self.brokers["short"].api.credentials
        self.brokers["short"].api.credentials = {**credentials, "user": "0x" + "e" * 40}
        self.assertEqual(self.tick()["phase"], "attention")
        self.assertEqual(self.sent, [])
        self.brokers["short"].api.credentials = credentials
        self.engine.pairs.enable("gold", False)
        self.assertEqual(self.tick()["phase"], "paused")
        self.assertEqual(self.sent, [])
        self.start()
        with patch.object(self.engine.workspace, "active", True):
            self.assertEqual(self.tick()["phase"], "maintenance")
        self.assertEqual(self.sent, [])
        self.assert_no_trades()

    def test_start_rejects_changed_identity_and_runtime_cas(self):
        old = {**runtime_default(), "identities": self.trader._members(self.pair)[2]}
        self.store.put("pair_runtime:gold", old)
        credentials = self.brokers["short"].api.credentials
        self.brokers["short"].api.credentials = {**credentials, "user": "0x" + "e" * 40}
        with self.assertRaisesRegex(TradingError, "身份"):
            self.start()
        self.brokers["short"].api.credentials = credentials
        with patch("trading.margin_balance.MarginBalancer.verify_members",
                   side_effect=lambda pair: self.store.put("pair_runtime:gold", {**old, "new_history": True})), \
                self.assertRaisesRegex(TradingError, "记录已变化"):
            self.start()
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.assertTrue(self.store.get("pair_runtime:gold")["new_history"])
        self.assertEqual(self.sent, [])

    def test_ordinary_and_cycle_start_still_require_matching_selected_leverage(self):
        self.mixed_positions()
        for ordinary in (True, False):
            pair = self.store.pair("gold")
            pair["ordinary"]["enabled"] = ordinary
            pair["cycle"]["enabled"] = not ordinary
            self.pair = self.store.save_pair(pair)
            with self.complete_strategy_orders():
                with self.subTest(ordinary=ordinary), self.assertRaisesRegex(TradingError, "实际杠杆必须相同"):
                    self.start()
            self.assertFalse(self.store.pair("gold")["enabled"])
        self.assert_no_trades()

    def test_ordinary_and_cycle_start_preserve_other_positions_at_common_leverage(self):
        self.mixed_positions()
        for paper in self.paper.values():
            paper.state["leverages"]["XAUUSD1"] = 5
            paper.save()
        holdings = {side: deepcopy(paper.state["positions"]) for side, paper in self.paper.items()}
        for ordinary in (True, False):
            with self.subTest(ordinary=ordinary):
                pair = self.store.pair("gold")
                pair["ordinary"]["enabled"] = ordinary
                pair["cycle"]["enabled"] = not ordinary
                self.pair = self.store.save_pair(pair)
                with self.complete_strategy_orders():
                    state = self.start()
                self.assertTrue(self.store.pair("gold")["enabled"])
                self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
                self.assertEqual(state["progress"]["baseline"], state["owned"])
                for side, paper in self.paper.items():
                    self.assertEqual(paper.state["positions"], holdings[side])
                self.engine.pairs.enable("gold", False)
        self.assert_no_trades()

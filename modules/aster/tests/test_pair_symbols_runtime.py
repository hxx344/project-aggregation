"""Offline multi-symbol execution and durable recovery isolation."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
import tempfile
import time
from unittest import TestCase
from unittest.mock import patch

from tests.helpers import account
from trading.engine import Engine
from trading.exchange import AmbiguousOrder, ExchangeError
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader
from tests.pair_legacy_fixtures import runtime_default
from trading.pair_planning import PairPositionError, plan_ordinary, require_runtime_symbols
from trading.pair_recovery import require_archived_orders_clear
from trading.pairing import validate_pair
from trading.paper import DemoMarket, PaperBroker
from trading.store import Store


class PairSymbolsRuntimeTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.market = DemoMarket()
        self.engine = Engine(self.store, market=self.market)
        self.trader = PairTrader(self.engine)
        self.engine.capacities = lambda symbol: {5: dec("1000000"), 10: dec(0), 20: dec(0)}
        self.brokers = {}
        self.margin = patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": False})
        self.margin.start()
        self.addCleanup(self.margin.stop)

    def create(self, symbol="XAGUSD1", *, kind="ordinary", pair_id="silver"):
        members = {}
        for side in ("long", "short"):
            aid = pair_id + "_" + side
            self.store.save_account({**account(aid), "enabled": False})
            broker = PaperBroker(aid, self.market, self.store)
            self.engine.brokers[aid] = members[side] = broker
        self.brokers[pair_id] = members
        pair = validate_pair({"id": pair_id, "name": pair_id, "symbol": symbol,
            "long_account_id": pair_id + "_long", "short_account_id": pair_id + "_short", "enabled": True,
            "ordinary": {"enabled": kind == "ordinary", "min_open_leverage": 5}})
        return self.store.save_pair(pair, create=True)

    def tick(self, pair_id="silver"):
        symbol = self.store.pair(pair_id)["symbol"]
        now = time.time()
        self.engine.markets[symbol] = {"status": "ok", "checked_at": now,
            "capacity_checked_at": {str(leverage): now for leverage in range(1, 21)},
            "capacities": {str(leverage): "1000000" for leverage in range(1, 21)}}
        return self.trader.tick(self.store.pair(pair_id))

    def snapshots(self, pair):
        return {side: broker.snapshot([pair["symbol"]]) for side, broker in self.brokers[pair["id"]].items()}

    def no_writes(self):
        stack = ExitStack()
        for members in self.brokers.values():
            for broker in members.values():
                stack.enter_context(patch.object(broker, "submit", side_effect=AssertionError("unexpected order")))
                stack.enter_context(patch.object(broker, "set_leverage", side_effect=AssertionError("unexpected leverage")))
        stack.enter_context(patch.object(self.trader, "_balance", side_effect=AssertionError("unexpected transfer")))
        return stack

    def test_silver_ordinary_opens_only_selected_symbol_and_preserves_gold_empty(self):
        pair = self.create(kind="ordinary")
        capacities = {20: "0", 10: "0", 5: "1000000"}
        with patch.object(self.engine, "capacities", return_value=capacities) as read:
            state = self.tick()
        self.assertTrue(all(call.args == ("XAGUSD1",) for call in read.call_args_list))
        self.assertGreater(dec(state["owned"]["LONG"]), 0, state)
        self.assertEqual(state["owned"]["LONG"], state["owned"]["SHORT"])
        self.assertEqual(state["symbol"], "XAGUSD1")
        for side, broker in self.brokers[pair["id"]].items():
            self.assertTrue(broker.state["orders"])
            self.assertTrue(all(order["symbol"] == "XAGUSD1" for order in broker.state["orders"].values()))
            self.assertEqual(broker.state["positions"]["XAUUSD1:" + side.upper()]["qty"], "0")

    def test_two_groups_keep_capacity_positions_and_recovery_separate(self):
        self.create("XAUUSD1", pair_id="gold")
        silver = self.create()
        gold_state = self.tick("gold")
        self.assertEqual(gold_state["phase"], "waiting", gold_state)
        self.engine.markets["XAUUSD1"] = {"status": "failed"}
        silver_state = self.tick()
        self.assertEqual(silver_state["phase"], "waiting", silver_state)
        self.assertGreater(dec(silver_state["owned"]["LONG"]), 0)
        self.assertGreater(dec(gold_state["owned"]["LONG"]), 0)
        gold_runtime = deepcopy(self.store.get("pair_runtime:gold"))
        self.store.save_pair({**silver, "enabled": False})
        self.assertEqual(self.tick()["phase"], "paused")
        self.assertEqual(self.store.get("pair_runtime:gold"), gold_runtime)

    def test_silver_unknown_order_restart_queries_original_id_without_resending(self):
        self.create()
        broker = self.brokers["silver"]["long"]
        with patch.object(broker, "submit", side_effect=AmbiguousOrder("missing acknowledgment")), \
                patch.object(broker, "query", side_effect=ExchangeError("not found", code=-2013)):
            state = self.tick()
        self.assertEqual(state["phase"], "reconciling", state)
        order = deepcopy(state["pending"]["legs"][0]["order"])
        self.trader = PairTrader(self.engine)
        with self.no_writes(), patch.object(broker, "query", side_effect=ExchangeError("not found", code=-2013)) as query:
            state = self.tick()
        query.assert_called_once_with("XAGUSD1", order["newClientOrderId"])
        self.assertEqual(state["pending"]["legs"][0]["order"], order)
        self.assertEqual(state["pending"]["repairs"], [])

    def test_silver_unknown_open_can_be_archived_and_observed_without_writes(self):
        pair = self.create()
        with ExitStack() as stack:
            for broker in self.brokers["silver"].values():
                stack.enter_context(patch.object(broker, "submit", side_effect=AmbiguousOrder("unknown")))
                stack.enter_context(patch.object(broker, "query", side_effect=ExchangeError("not found", code=-2013)))
            state = self.tick()
        self.assertIsNotNone(state["pending"], state)
        state["pending"]["created_at"] = time.time() - 180
        self.store.put("pair_runtime:silver", state)
        pair = self.store.save_pair({**pair, "enabled": False})
        with self.no_writes():
            preview = self.engine.pairs.recovery.preview("silver")
            self.assertEqual(preview["status"], "review")
            self.engine.pairs.recovery.confirm("silver", preview["token"], acknowledge_unknown=True)
            state = self.store.get("pair_runtime:silver")
            self.assertIsNone(state["pending"])
            self.assertEqual(state["recovery_watch"]["batches"][0]["symbol"], "XAGUSD1")
            for order in state["recovery_watch"]["batches"][0]["legs"]:
                self.assertEqual(order["order"]["symbol"], "XAGUSD1")
            evidence = require_archived_orders_clear(self.engine, pair, state=state)
            self.assertEqual(len(evidence), 2)

    def test_paper_recovery_history_excludes_previous_gold_orders(self):
        self.create()
        broker = self.brokers["silver"]["long"]
        broker.state["orders"] = {
            "old_gold": {"symbol": "XAUUSD1", "clientOrderId": "old_gold"},
            "current_silver": {"symbol": "XAGUSD1", "clientOrderId": "current_silver"},
        }
        broker.save()
        rows, window = self.engine.pairs.recovery._history(broker,
            {"symbol": "XAGUSD1", "created_at": time.time() - 180})
        self.assertEqual([row["clientOrderId"] for row in rows], ["current_silver"])
        self.assertEqual(window["rows"], 1)

    def test_silver_failed_leg_repairs_only_silver(self):
        self.create()
        with patch.object(self.brokers["silver"]["short"], "submit", side_effect=ExchangeError("balance", code=-2019)):
            state = self.tick()
        self.assertEqual(state["phase"], "repairing", state)
        self.assertTrue(all(leg["order"]["symbol"] == "XAGUSD1" for leg in state["pending"]["repairs"]))
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertFalse(state["last_batch"]["completed"])

    def test_ordinary_upgrade_changes_only_silver_leverage(self):
        self.create(kind="ordinary")
        del self.engine.capacities
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        for broker in self.brokers["silver"].values():
            self.assertEqual(broker.state["leverages"]["XAGUSD1"], 10)
            self.assertEqual(broker.state["leverages"]["XAUUSD1"], 5)
            self.assertFalse(broker.state["orders"])
        self.tick()
        for broker in self.brokers["silver"].values():
            self.assertEqual(broker.state["leverages"]["XAGUSD1"], 20)
            self.assertEqual(broker.state["leverages"]["XAUUSD1"], 5)
        self.assertGreater(dec(self.tick()["owned"]["LONG"]), 0)

    def test_silver_planning_requires_silver_fees_and_account_capacity(self):
        pair = self.create(kind="ordinary")
        for change in ({"fees": {"XAUUSD1": dec("0")}},
                       {"current_leverage_caps": {"XAUUSD1": (5, dec("1000000"))}, "brackets": {}}):
            snapshots = self.snapshots(pair)
            snapshots["long"] = replace(snapshots["long"], **change)
            with self.subTest(change=change), self.assertRaises(TradingError):
                plan_ordinary(pair, snapshots, self.market.book("XAGUSD1"), self.market.rules["XAGUSD1"], {5: "1000000"})

    def test_wrong_runtime_symbols_block_queries_orders_and_transfers(self):
        pair = self.create()
        with patch.object(self.brokers["silver"]["long"], "submit", side_effect=AmbiguousOrder("unknown")), \
                patch.object(self.brokers["silver"]["long"], "query", side_effect=ExchangeError("not found", code=-2013)):
            original = self.tick()
        mutations = {
            "runtime": lambda state: state.update(symbol="XAUUSD1"),
            "pending": lambda state: state["pending"].update(symbol="XAUUSD1"),
            "config": lambda state: state["pending"]["config"].update(symbol="XAUUSD1"),
            "order": lambda state: state["pending"]["legs"][0]["order"].update(symbol="XAUUSD1"),
            "repair": lambda state: state["pending"]["repairs"].append({"order": {"symbol": "XAUUSD1"}}),
            "watch": lambda state: state.update(recovery_watch={"batches": [{"legs": [{"order": {"symbol": "XAUUSD1"}}]}]}),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                state = deepcopy(original)
                mutate(state)
                pending = deepcopy(state["pending"])
                self.store.put("pair_runtime:silver", state)
                with self.no_writes(), ExitStack() as stack:
                    for broker in self.brokers["silver"].values():
                        stack.enter_context(patch.object(broker, "query", side_effect=AssertionError("wrong symbol query")))
                    result = self.tick()
                self.assertEqual(result["phase"], "attention", result)
                self.assertEqual(result["pending"], pending)

    def test_unmarked_legacy_gold_order_cannot_be_reinterpreted_as_silver(self):
        pair = self.create()
        state = {**runtime_default(), "recovery_watch": {"batches": [
            {"legs": [{"key": "long", "order": {"symbol": "XAUUSD1"}}]}]}}
        with self.no_writes(), patch.object(self.trader, "_members", side_effect=AssertionError("no broker read")):
            with self.assertRaisesRegex(PairPositionError, "标的"):
                require_archived_orders_clear(self.engine, pair, state=state)

    def test_archived_batches_bind_orders_to_their_own_symbols(self):
        pair = self.create()
        state = {**runtime_default(), "symbol": "XAGUSD1", "recovery_watch": {"batches": [
            {"symbol": symbol, "legs": [{"key": key, "order": {"symbol": symbol}}
                                       for key in ("long", "short")]}
            for symbol in ("XAUUSD1", "XAGUSD1")]}}
        for top_symbol in (None, "XAUUSD1", "XAGUSD1"):
            with self.subTest(top_symbol=top_symbol):
                checked = deepcopy(state)
                if top_symbol is not None:
                    checked["recovery_watch"]["symbol"] = top_symbol
                self.assertEqual(require_runtime_symbols(pair, checked), "XAGUSD1")
        for change in (lambda watch: watch["batches"][0].update(symbol="XAGUSD1"),
                       lambda watch: watch["batches"][0].update(symbol="CLUSD1"),
                       lambda watch: watch["batches"][0].update(symbol=None),
                       lambda watch: watch["batches"][0]["legs"][0]["order"].update(symbol="XAGUSD1"),
                       lambda watch: watch.update(symbol=[])):
            changed = deepcopy(state)
            change(changed["recovery_watch"])
            with self.assertRaisesRegex(PairPositionError, "标的"):
                require_runtime_symbols(pair, changed)

    def test_wrong_plan_or_market_rules_cannot_authorize_submission(self):
        pair = self.create(kind="ordinary")
        snapshots = self.snapshots(pair)
        with self.assertRaisesRegex(PairPositionError, "标的"):
            plan_ordinary(pair, snapshots, self.market.book("XAGUSD1"), self.market.rules["XAUUSD1"], {5: "1000000"})
        plan = plan_ordinary(pair, snapshots, self.market.book("XAGUSD1"), self.market.rules["XAGUSD1"], {5: "1000000"})
        state = runtime_default()
        _, brokers, state["identities"] = self.trader._members(pair)
        with self.no_writes(), self.assertRaisesRegex(PairPositionError, "计划标的"):
            self.trader._start(pair, state, brokers, snapshots, {}, replace(plan, symbol="XAUUSD1"), kind="ordinary")
        self.assertIsNone(self.store.get("pair_runtime:silver"))

    def test_unmarked_nonzero_legacy_baseline_cannot_be_reused_for_silver(self):
        pair = self.create()
        state = runtime_default()
        state["owned"] = {"LONG": "1", "SHORT": "1"}
        with self.assertRaisesRegex(PairPositionError, "缺少 XAGUSD1"):
            require_runtime_symbols(pair, state)

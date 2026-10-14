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
from trading.cycle import validate_cycle
from trading.engine import Engine
from trading.exchange import AmbiguousOrder, ExchangeError
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader, runtime_default
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
        self.brokers = {}
        self.margin = patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": False})
        self.margin.start()
        self.addCleanup(self.margin.stop)

    def create(self, symbol="XAGUSD1", *, kind="cycle", pair_id="silver"):
        members = {}
        for side in ("long", "short"):
            aid = pair_id + "_" + side
            self.store.save_account({**account(aid), "enabled": False})
            broker = PaperBroker(aid, self.market, self.store)
            self.engine.brokers[aid] = members[side] = broker
        self.brokers[pair_id] = members
        pair = validate_pair({"id": pair_id, "name": pair_id, "symbol": symbol,
            "long_account_id": pair_id + "_long", "short_account_id": pair_id + "_short", "enabled": True,
            "ordinary": {"enabled": kind == "ordinary", "min_open_leverage": 5},
            "cycle": {"enabled": kind == "cycle", "spread_notional": "1000", "spread_limit_bp": "5",
                      "min_notional": "500", "max_notional": "1000", "hold_seconds": 60}})
        return self.store.save_pair(pair, create=True)

    def tick(self, pair_id="silver"):
        symbol = self.store.pair(pair_id)["symbol"]
        self.engine.markets[symbol] = {"status": "ok", "checked_at": time.time(),
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

    def test_silver_cycle_pause_closes_recorded_increment_after_restart(self):
        pair = self.create()
        state = self.tick()
        self.assertEqual(state["phase"], "holding", state)
        self.assertEqual(state["progress"]["config"]["symbol"], "XAGUSD1")
        self.store.save_pair({**pair, "enabled": False})
        self.trader = PairTrader(self.engine)
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assertIsNone(state["pending"])
        for broker in self.brokers[pair["id"]].values():
            self.assertEqual(len(broker.state["orders"]), 2)
            self.assertTrue(all(row["symbol"] == "XAGUSD1" for row in broker.state["orders"].values()))
            self.assertTrue(all(not p.qty for p in broker.snapshot(["XAGUSD1"]).positions))

    def test_gold_legacy_runtime_without_symbol_still_closes(self):
        pair = self.create("XAUUSD1", pair_id="gold")
        state = self.tick("gold")
        self.assertEqual(state["phase"], "holding", state)
        state.pop("symbol")
        self.store.put("pair_runtime:gold", state)
        self.store.save_pair({**pair, "enabled": False})
        self.trader = PairTrader(self.engine)
        state = self.tick("gold")
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)

    def test_two_groups_keep_capacity_positions_and_recovery_separate(self):
        self.create("XAUUSD1", pair_id="gold")
        silver = self.create()
        gold_state = self.tick("gold")
        self.assertEqual(gold_state["phase"], "holding", gold_state)
        self.engine.markets["XAUUSD1"] = {"status": "failed"}
        silver_state = self.tick()
        self.assertEqual(silver_state["phase"], "holding", silver_state)
        self.assertNotEqual(gold_state["progress"]["quantities"], silver_state["progress"]["quantities"])
        gold_runtime = deepcopy(self.store.get("pair_runtime:gold"))
        self.store.save_pair({**silver, "enabled": False})
        self.assertEqual(self.tick()["progress"]["completed_cycles"], 1)
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

    def test_silver_ordinary_baseline_survives_cycle_pause(self):
        pair = self.create(kind="ordinary")
        with patch.object(self.engine, "capacities", return_value={5: "1000000", 10: "0", 20: "0"}):
            owned = self.tick()["owned"]
        self.assertGreater(dec(owned["LONG"]), 0)
        pair = self.store.save_pair({**pair, "ordinary": {**pair["ordinary"], "enabled": False},
                                    "cycle": {**pair["cycle"], "enabled": True}})
        self.assertEqual(self.tick()["phase"], "holding")
        self.store.save_pair({**pair, "enabled": False})
        state = self.tick()
        self.assertEqual(state["owned"], owned)
        self.assertEqual(state["progress"]["completed_cycles"], 1)
        for side, snapshot in self.snapshots(pair).items():
            position = snapshot.pair("XAGUSD1")[0 if side == "long" else 1]
            self.assertEqual(position.qty, dec(owned[side.upper()]))

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
            "progress": lambda state: state["progress"].update(config={"symbol": "XAUUSD1"}),
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

    def test_frozen_silver_cycle_with_gold_config_blocks_close(self):
        self.create()
        state = self.tick()
        self.assertEqual(state["phase"], "holding", state)
        state["progress"]["config"]["symbol"] = "XAUUSD1"
        state["progress"]["opened_at"] = time.time() - 100
        self.store.put("pair_runtime:silver", state)
        with self.no_writes():
            self.assertEqual(self.tick()["phase"], "attention")

    def test_archived_gold_order_cannot_be_queried_for_silver(self):
        pair = self.create()
        state = {**runtime_default(), "recovery_watch": {"batches": [
            {"legs": [{"key": "long", "order": {"symbol": "XAUUSD1"}}]}]}}
        with self.no_writes(), patch.object(self.trader, "_members", side_effect=AssertionError("no broker read")):
            with self.assertRaisesRegex(PairPositionError, "标的"):
                require_archived_orders_clear(self.engine, pair, state=state)

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

    def test_single_account_cycle_default_still_excludes_silver(self):
        with self.assertRaises(TradingError):
            validate_cycle({"symbol": "XAGUSD1"})

"""ADL closes fresh net exposure and never repeats an uncertain exchange write."""
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tests.helpers import account
from trading import adl
from trading.adl_exchange import ReductionPosition, ReductionRule, ReductionSnapshot
from trading.exchange import AmbiguousOrder, ExchangeError, LiveBroker
from trading.models import TradingError, dec
from trading.pair_execution import runtime_default
from trading.pairing import validate_pair
from trading.store import Store


SYMBOL = "BTCUSDT"


def position(direction, quantity, *, symbol=SYMBOL, position_side=None, mark="1000"):
    amount = dec(quantity)
    return ReductionPosition(symbol, position_side or direction, amount, dec(mark), dec(mark), 17,
                             -amount if direction == "SHORT" else amount)


def rule(symbol=SYMBOL, *, step="0.1", minimum="0.1", maximum="100"):
    return ReductionRule(symbol, dec(step), dec("0.1"), dec(minimum), dec(maximum), dec("5"), "USDT", "USDT")


def receipt(order, quantity=None, *, status="FILLED"):
    return {"symbol": order["symbol"], "positionSide": order["positionSide"], "side": order["side"],
            "clientOrderId": order["newClientOrderId"], "status": status,
            "executedQty": order["quantity"] if quantity is None else quantity,
            "avgPrice": "1000", "orderId": "exchange-" + order["newClientOrderId"]}


class ReductionPlanTests(unittest.TestCase):
    def test_native_manual_reverse_holdings_are_aggregated_across_both_accounts(self):
        snapshots = {"a": SimpleNamespace(positions=(position("LONG", "2"), position("SHORT", "5"))),
                     "b": SimpleNamespace(positions=(position("LONG", "1"), position("SHORT", "1")))}
        planned = adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()})
        self.assertEqual(planned["account_id"], "a")
        self.assertEqual(planned["excess_before"], "3")
        self.assertEqual((planned["order"]["positionSide"], planned["order"]["side"]), ("SHORT", "BUY"))
        self.assertNotIn("reduceOnly", planned["order"])
        self.assertLessEqual(dec(planned["order"]["quantity"]), dec(planned["excess_before"]))

    def test_one_way_reduction_keeps_both_and_reduce_only_in_each_economic_direction(self):
        for direction, opposite, side in (("LONG", "SHORT", "SELL"), ("SHORT", "LONG", "BUY")):
            with self.subTest(direction=direction):
                snapshots = {"a": SimpleNamespace(positions=(position(direction, "1.05", position_side="BOTH"),)),
                             "b": SimpleNamespace(positions=(position(opposite, "0.2", position_side="BOTH"),))}
                planned = adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()})
                self.assertEqual(planned["order"]["positionSide"], "BOTH")
                self.assertEqual(planned["order"]["reduceOnly"], "true")
                self.assertEqual(planned["order"]["side"], side)
                self.assertEqual(dec(planned["order"]["quantity"]), dec("0.8"))
                self.assertLessEqual(dec(planned["order"]["quantity"]), dec("0.85"))

    def test_residual_below_one_lot_never_rounds_across_balance(self):
        snapshots = {"a": SimpleNamespace(positions=(position("LONG", "1.01"),)),
                     "b": SimpleNamespace(positions=(position("SHORT", "1"),))}
        with self.assertRaisesRegex(TradingError, "小于可执行"):
            adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()})

    def test_residual_beyond_decimal_context_precision_is_never_treated_as_zero(self):
        snapshots = {"a": SimpleNamespace(positions=(position("LONG", "1"),)),
                     "b": SimpleNamespace(positions=(position("SHORT", "1.000000000000000000000000000001"),))}
        with self.assertRaisesRegex(TradingError, "小于可执行"):
            adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()})
        planned = adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule(step="1e-30", minimum="1e-30")})
        self.assertEqual(dec(planned["excess_before"]), Decimal("1e-30"))
        self.assertEqual(dec(planned["order"]["quantity"]), Decimal("1e-30"))
        self.assertEqual((planned["order"]["positionSide"], planned["order"]["side"]), ("SHORT", "BUY"))

    def test_configured_notional_limit_is_exact_and_never_overridden_by_minimum_lot(self):
        snapshots = {"a": SimpleNamespace(positions=(position("LONG", "3", mark="333"),)),
                     "b": SimpleNamespace(positions=(position("SHORT", "1", mark="333"),))}
        planned = adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()}, "100")
        self.assertEqual(dec(planned["order"]["quantity"]), dec("0.3"))
        self.assertLessEqual(dec(planned["order"]["quantity"]) * dec("333"), dec("100"))
        for limit in ("1", "33.299999999999999999999999999999"):
            with self.subTest(limit=limit), self.assertRaisesRegex(TradingError, "单批金额上限.*最小市价数量"):
                adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()}, limit)
        edge = adl.plan_reduction(snapshots, [SYMBOL], {SYMBOL: rule()}, "33.3")
        self.assertEqual(dec(edge["order"]["quantity"]), dec("0.1"))


class AdlControllerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.now = 1000.0
        clock = patch("trading.adl.time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        for aid in ("a", "b"):
            self.store.save_account({**account(aid, mode="live"), "enabled": False})
        self.store.save_pair(validate_pair({"id": "pair", "name": "测试配对", "long_account_id": "a",
            "short_account_id": "b", "enabled": True, "ordinary": {"enabled": True}}), create=True)
        self.store.put("pair_runtime:pair", runtime_default())
        self.holdings = {"a": [position("LONG", "2")], "b": [position("SHORT", "3")]}
        self.position_updates = {aid: {(p.symbol, p.position_side): 999.0 for p in rows}
                                 for aid, rows in self.holdings.items()}
        self.open_orders = {"a": [], "b": []}
        self.brokers, self.reads, self.sent, self.persisted_at_send, self.exchange_orders = {}, [], [], [], {}
        self.submit_unknown = False
        self.query_visible = True
        self.snapshot_filled = True
        for aid in ("a", "b"):
            api = SimpleNamespace(credentials={"user": "wallet-" + aid, "signer": "signer-" + aid})
            broker = self.brokers[aid] = LiveBroker({}, SimpleNamespace(), api=api)
            broker.submit = Mock(side_effect=lambda orders, aid=aid, **_: self.submit(aid, orders))
            broker.query = Mock(side_effect=lambda symbol, cid, aid=aid, **_: self.query(aid, symbol, cid))
            broker.cancel = Mock()
        self.engine = SimpleNamespace(store=self.store, market=object(), workspace=SimpleNamespace(active=False),
            shutdown=threading.Event(), live_allowed=lambda _: True, broker=lambda acc: self.brokers[acc["id"]],
            wake_adl=Mock())
        self.controller = adl.AdlController(self.engine)
        snapshots = patch("trading.adl.adl_exchange.reduction_snapshot", side_effect=self.snapshot)
        snapshots.start()
        self.addCleanup(snapshots.stop)
        rules = patch("trading.adl.adl_exchange.reduction_rule", side_effect=lambda _, symbol: rule(symbol))
        rules.start()
        self.addCleanup(rules.stop)

    def snapshot(self, broker):
        aid = next(aid for aid, current in self.brokers.items() if current is broker)
        self.reads.append((aid, deepcopy(self.holdings[aid])))
        return ReductionSnapshot(tuple(self.holdings[aid]), True, True, deepcopy(self.open_orders[aid]), self.now,
            broker._snapshot_generation, position_updates=dict(self.position_updates[aid]), _broker=broker, _api=broker.api,
            _account_identity=tuple(broker.api.credentials[key] for key in ("user", "signer")))

    def submit(self, aid, orders):
        self.persisted_at_send.append(self.state())
        self.assertEqual(len(orders), 1)
        order = deepcopy(orders[0])
        direction = "LONG" if order["side"] == "SELL" else "SHORT"
        totals = {side: sum((p.quantity for rows in self.holdings.values() for p in rows
            if p.symbol == order["symbol"] and p.side == side), Decimal(0)) for side in ("LONG", "SHORT")}
        self.sent.append({"account_id": aid, "order": order, "net_before": abs(totals["LONG"] - totals["SHORT"])})
        if self.snapshot_filled:
            rows = self.holdings[aid]
            for index, current in enumerate(rows):
                if current.symbol == order["symbol"] and current.position_side == order["positionSide"] and current.side == direction:
                    remaining = current.quantity - dec(order["quantity"])
                    self.assertGreaterEqual(remaining, 0)
                    rows[index] = replace(current, quantity=remaining,
                                          signed_quantity=-remaining if direction == "SHORT" else remaining)
                    self.position_updates[aid][current.symbol, current.position_side] = self.now
                    break
            else:
                self.fail("Reduction selected a nonexistent position")
        result = receipt(order)
        self.exchange_orders[aid, order["newClientOrderId"]] = result
        self.brokers[aid]._snapshot_generation += 1
        if self.submit_unknown:
            raise AmbiguousOrder("POST timed out", http_status=504)
        return [result]

    def query(self, aid, symbol, cid):
        if not self.query_visible or (aid, cid) not in self.exchange_orders:
            raise ExchangeError("order absent", code=-2013, http_status=404)
        result = deepcopy(self.exchange_orders[aid, cid])
        self.assertEqual(result["symbol"], symbol)
        return result

    def payload(self, *, quantity="1", status="PARTIALLY_FILLED", order_id=42, symbol=SYMBOL):
        return {"e": "ORDER_TRADE_UPDATE", "E": int(self.now * 1000), "o": {
            "c": "adl_autoclose", "s": symbol, "i": order_id, "ps": "LONG", "S": "SELL",
            "q": "3", "z": quantity, "X": status, "ap": "1000", "T": int(self.now * 1000)}}

    def observe(self, *, projected=True, **changes):
        event = self.payload(**changes)
        if projected:
            self.position_updates["a"][event["o"]["s"], event["o"]["ps"]] = event["o"]["T"] / 1000
        self.controller.observe("a", self.brokers["a"], event)

    def state(self):
        return self.store.get("adl_pair:pair")

    def tick(self, advance=0):
        self.now += advance
        return self.controller.tick(self.store.pair("pair"))

    def records(self):
        with self.store.connect() as db:
            return [row[0] for row in db.execute("SELECT data FROM kv WHERE key GLOB 'adl_event:*'")]

    def test_zero_fill_new_adl_never_authorizes_reduction_but_confirmed_fill_does(self):
        self.observe(quantity="0", status="NEW_ADL")
        self.assertIsNone(self.tick())
        self.assertIsNone(self.state())
        self.assertTrue(self.store.pair("pair")["enabled"])
        self.assertEqual(self.sent, [])
        self.observe()
        self.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertFalse(self.store.pair("pair")["enabled"])

    def test_each_batch_uses_fresh_actual_net_and_has_a_durable_id_before_send(self):
        self.holdings = {"a": [position("LONG", "6"), position("SHORT", "1")],
                         "b": [position("LONG", "1"), position("SHORT", "3")]}
        self.observe()
        for _ in range(4):
            self.tick(1)
        state = self.state()
        self.assertEqual(state["status"], "completed")
        self.assertEqual(len(self.sent), 3)
        self.assertEqual(len(self.reads), 8)
        self.assertEqual([sent["net_before"] for sent in self.sent], [dec("3"), dec("2"), dec("1")])
        self.assertEqual(state["before"]["a"]["positions"][0]["quantity"], "6")
        self.assertEqual(state["after"]["a"]["positions"][0]["quantity"], "3")
        self.assertEqual(len({sent["order"]["newClientOrderId"] for sent in self.sent}), 3)
        for sent, persisted in zip(self.sent, self.persisted_at_send):
            self.assertLessEqual(dec(sent["order"]["quantity"]), sent["net_before"])
            self.assertEqual(persisted["batches"][-1]["order"], sent["order"])
            self.assertEqual(persisted["batches"][-1]["state"], "sending")
            self.assertEqual(sent["order"]["symbol"], SYMBOL)
            self.assertNotIn("reduceOnly", sent["order"])

    def test_configured_cap_is_frozen_for_the_incident_and_survives_restart(self):
        self.store.save_pair({**self.store.pair("pair"), "adl": {"enabled": True, "batch_notional": "250"}})
        self.observe()
        self.tick()
        self.assertEqual(self.state()["config"], {"enabled": True, "batch_notional": "250"})
        self.assertEqual(dec(self.sent[0]["order"]["quantity"]), dec("0.2"))
        self.controller = adl.AdlController(self.engine)
        # A freshly read pair object cannot replace an existing incident policy.
        pair = {**self.store.pair("pair"), "adl": {"enabled": False, "batch_notional": "1000"}}
        self.now += 1
        self.controller.tick(pair)
        self.assertEqual(dec(self.sent[1]["order"]["quantity"]), dec("0.2"))
        self.assertEqual(self.state()["config"], {"enabled": True, "batch_notional": "250"})

    def test_disabled_automatic_reduction_still_pauses_reports_and_can_complete_after_manual_balance(self):
        config = {"enabled": False, "batch_notional": "125"}
        self.store.save_pair({**self.store.pair("pair"), "adl": config})
        self.observe()
        with patch("trading.adl.adl_exchange.reduction_rule") as rules:
            self.tick()
            self.assertEqual(self.state()["config"], config)
            self.assertEqual(self.state()["status"], "blocked")
            self.assertIn("自动减仓已关闭", self.state()["reason"])
            self.assertFalse(self.store.pair("pair")["enabled"])
            self.assertEqual(self.sent, [])
            self.assertTrue(all(not broker.cancel.called for broker in self.brokers.values()))
            self.assertTrue(self.state()["before"])
            with self.store.connect() as db:
                reports = [row[0] for row in db.execute("SELECT message FROM outbox WHERE category='adl'")]
            self.assertTrue(any("ADL 已确认" in report for report in reports))
            self.assertTrue(any("自动减仓：关闭" in report for report in reports))
            self.tick(adl.MAX_SECONDS + 1)
            self.assertFalse(self.state().get("halted", False))
            self.holdings["b"] = [position("SHORT", "2")]
            self.controller = adl.AdlController(self.engine)
            original_snapshot = self.snapshot
            with patch("trading.adl.adl_exchange.reduction_snapshot",
                       side_effect=lambda broker: replace(original_snapshot(broker), can_trade=False)):
                self.tick(10)
            self.assertEqual(self.state()["status"], "completed")
            self.assertTrue(self.state()["hold"])
            self.assertEqual(self.sent, [])
            rules.assert_not_called()

    def test_disabled_automatic_reduction_queries_old_orders_without_cancel_and_preserves_unknown(self):
        self.store.save_pair({**self.store.pair("pair"), "adl": {"enabled": False}})
        runtime = self.archived_runtime()
        for batch in runtime["recovery_watch"]["batches"]:
            for leg in batch["legs"]:
                leg["receipt"] = receipt(leg["order"], "0", status="NEW")
        self.store.put("pair_runtime:pair", runtime)
        self.query_visible = False
        self.observe()
        self.tick()
        self.tick(2)
        self.tick(2)
        started = self.state()["created_at"]
        self.controller = adl.AdlController(self.engine)
        self.now = started + 120
        self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertIn("自动减仓已关闭", self.state()["reason"])
        self.assertEqual(self.sent, [])
        for broker in self.brokers.values():
            self.assertEqual(broker.query.call_count, 3)
            broker.cancel.assert_not_called()
        for item in self.state()["prior_orders"]:
            self.assertEqual(item["resolution"], "positions_verified_unknown")
            self.assertEqual(item["state"], "sending")
            self.assertEqual(item["receipt"]["status"], "NEW")
        self.holdings["b"] = [position("SHORT", "2")]
        self.tick(10)
        self.assertEqual(self.state()["status"], "completed")
        self.assertTrue(self.state()["watch_unknown"])

    def test_legacy_incident_without_config_retains_default_execution_policy(self):
        self.observe()
        self.tick()
        legacy = self.state()
        legacy.pop("config")
        self.store.put("adl_pair:pair", legacy)
        self.controller = adl.AdlController(self.engine)
        self.tick(1)
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(self.state()["config"], {"enabled": True, "batch_notional": "1000"})

    def test_smaller_than_minimum_notional_cap_blocks_without_sending_and_manual_balance_finishes(self):
        self.store.save_pair({**self.store.pair("pair"), "adl": {"batch_notional": "99.99"}})
        self.observe()
        self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertIn("单批金额上限 99.99 USDT", self.state()["reason"])
        self.assertEqual(self.sent, [])
        self.holdings["b"] = [position("SHORT", "2")]
        self.tick(10)
        self.assertEqual(self.state()["status"], "completed")

    def test_scan_health_only_advances_after_complete_success_and_keeps_real_attempt_time(self):
        account = self.store.account("a")
        key = f"adl_scan:pair:a:{adl._owner(self.brokers['a'])}"
        complete = {"events": [], "remaining": [], "error": None, "blocked": None, "retry_after": 0}

        def finish_success(*args, **kwargs):
            self.assertEqual(self.store.get(key)["attempt_at"], self.now)
            self.now += 2
            return deepcopy(complete)

        with patch("trading.adl.adl_events.scan_force_orders", side_effect=finish_success):
            self.controller.poll(account)
        saved = self.store.get(key)
        self.assertEqual(saved["attempt_at"], 1000)
        self.assertEqual(saved["checked_at"], 1002)
        self.now = 1003
        with patch("trading.adl.adl_events.scan_force_orders") as scan:
            self.controller.poll(account)
            scan.assert_not_called()
        self.assertEqual(self.store.get(key), saved)

        self.now = 1060
        failed = {**complete, "remaining": [[1000000, 1060000]], "error": "历史查询失败"}
        with patch("trading.adl.adl_events.scan_force_orders", return_value=failed):
            self.controller.poll(account)
        failed_saved = self.store.get(key)
        self.assertEqual(failed_saved["checked_at"], 1002)
        self.assertEqual(failed_saved["attempt_at"], 1060)
        self.assertEqual(failed_saved["error"], "历史查询失败")
        self.controller = adl.AdlController(self.engine)
        self.now = 1069
        with patch("trading.adl.adl_events.scan_force_orders") as scan:
            self.controller.poll(account)
            scan.assert_not_called()
        self.assertEqual(self.store.get(key), failed_saved)

        self.now = 1070
        partial = {**complete, "remaining": [[1030000, 1060000]]}
        with patch("trading.adl.adl_events.scan_force_orders", return_value=partial):
            self.controller.poll(account)
        self.assertEqual(self.store.get(key)["checked_at"], 1002)
        self.assertEqual(self.store.get(key)["attempt_at"], 1070)
        self.now = 1071
        with patch("trading.adl.adl_events.scan_force_orders", side_effect=finish_success):
            self.controller.poll(account)
        self.assertEqual(self.store.get(key)["checked_at"], 1073)
        self.assertEqual(self.store.get(key)["attempt_at"], 1071)
        self.assertIsNone(self.store.get(key)["error"])

    def test_first_incomplete_or_blocked_scan_never_claims_successful_health(self):
        account = self.store.account("a")
        key = f"adl_scan:pair:a:{adl._owner(self.brokers['a'])}"
        result = {"events": [], "remaining": [[1000000, 1000000]], "error": None,
                  "blocked": "最小时间窗仍满页", "retry_after": 0}
        with patch("trading.adl.adl_events.scan_force_orders", return_value=result):
            self.controller.poll(account)
        self.assertNotIn("checked_at", self.store.get(key))
        self.assertEqual(self.store.get(key)["attempt_at"], 1000)
        self.assertEqual(self.store.get(key)["error"], "最小时间窗仍满页")

    def test_unknown_result_is_never_resent_and_restart_queries_original_client_id(self):
        self.submit_unknown = True
        self.query_visible = False
        self.observe()
        self.tick()
        original_id = self.sent[0]["order"]["newClientOrderId"]
        self.assertEqual(self.state()["batches"][0]["state"], "sending")
        self.controller = adl.AdlController(self.engine)
        self.tick(1)
        self.tick(3)
        self.assertEqual(len(self.sent), 1)
        self.assertNotEqual(self.state()["status"], "completed")
        self.assertTrue(self.brokers["b"].query.call_count)
        self.assertTrue(all(call.args == (SYMBOL, original_id) for call in self.brokers["b"].query.call_args_list))
        self.query_visible = True
        self.tick(3)
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(len(self.sent), 1)

    def unknown_with_three_queries(self):
        self.submit_unknown = True
        self.snapshot_filled = False
        self.query_visible = False
        self.observe()
        self.tick()
        original = deepcopy(self.state()["batches"][0])
        self.tick(1)
        self.tick(2)
        self.controller = adl.AdlController(self.engine)
        self.tick(2)
        self.assertEqual(self.brokers["b"].query.call_count, 3)
        self.assertEqual(len(self.sent), 1)
        return original

    def test_bounded_unknown_recovery_uses_new_id_and_late_fill_reopens_paused_monitoring(self):
        original = self.unknown_with_three_queries()
        original_id = original["order"]["newClientOrderId"]
        self.submit_unknown = False
        self.snapshot_filled = True
        self.now = original["sent_at"] + 119.999
        self.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.brokers["b"].query.call_count, 3)
        self.now = original["sent_at"] + 120
        self.tick()
        self.assertEqual(len(self.sent), 2)
        self.assertNotEqual(self.sent[1]["order"]["newClientOrderId"], original_id)
        self.assertEqual(dec(self.sent[1]["order"]["quantity"]), self.sent[1]["net_before"])
        unknown = self.state()["batches"][0]
        self.assertEqual(unknown["state"], "sending")
        self.assertEqual(unknown["resolution"], "positions_verified_unknown")
        self.assertIsNone(unknown.get("receipt"))
        self.tick(1)
        completed = self.state()
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["hold"])
        self.assertFalse(self.store.pair("pair")["enabled"])

        # The unknown original BUY finally reduces the short leg after the
        # replacement batch already brought the real accounts into balance.
        self.holdings["b"] = [position("SHORT", "1")]
        self.position_updates["b"][SYMBOL, "SHORT"] = self.now + 1
        self.tick(10)
        self.assertEqual(len(self.sent), 3)
        self.assertEqual((self.sent[-1]["order"]["positionSide"], self.sent[-1]["order"]["side"]), ("LONG", "SELL"))
        self.assertEqual(dec(self.sent[-1]["order"]["quantity"]), dec("1"))
        self.assertNotEqual(self.sent[-1]["order"]["newClientOrderId"], original_id)
        self.assertEqual(self.state()["parent_id"], completed["id"])
        self.tick(1)
        self.assertEqual(self.state()["status"], "completed")
        self.assertFalse(self.store.pair("pair")["enabled"])
        history = self.store.get("adl_incident:" + completed["id"])
        self.assertEqual(history["batches"][0]["state"], "sending")
        self.assertIsNone(history["batches"][0].get("receipt"))
        self.assertEqual(self.brokers["b"].query.call_count, 3)
        with self.store.connect() as db:
            reports = {row[0].split(":completed:", 1)[0] for row in db.execute(
                "SELECT id FROM outbox WHERE category='adl' AND id LIKE '%:completed:%'")}
        self.assertEqual(len(reports), 2)

    def test_bounded_recovery_requires_fresh_scene_without_active_orders_and_keeps_query_cap(self):
        original = self.unknown_with_three_queries()
        self.submit_unknown = False
        self.snapshot_filled = True
        self.now = original["sent_at"] + 120
        with patch.object(self.controller, "_read", side_effect=TradingError("完整持仓读取失败")):
            self.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.brokers["b"].query.call_count, 3)
        self.open_orders["b"] = [{"symbol": SYMBOL, "clientOrderId": original["order"]["newClientOrderId"],
            "positionSide": "SHORT", "side": "BUY", "status": "NEW", "origQty": "1", "executedQty": "0"}]
        self.tick(10)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.brokers["b"].query.call_count, 3)
        self.assertNotEqual(self.state()["status"], "completed")
        self.open_orders["b"] = []
        self.tick(10)
        self.assertEqual(len(self.sent), 2)
        self.assertNotEqual(self.sent[1]["order"]["newClientOrderId"], original["order"]["newClientOrderId"])

    def test_cumulative_duplicate_is_deduplicated_across_restart_and_later_increment_is_handled(self):
        self.observe()
        self.tick()
        self.tick(1)
        first = self.state()["id"]
        self.controller = adl.AdlController(self.engine)
        self.observe()
        self.tick(1)
        self.assertEqual(self.state()["id"], first)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(len(self.sent), 1)
        self.holdings["a"] = [position("LONG", "1")]
        self.observe(quantity="2")
        self.tick(1)
        self.tick(1)
        self.assertNotEqual(self.state()["id"], first)
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.state()["events"][0]["executed_qty"], "2")

    def test_filled_receipt_without_updated_positions_cannot_authorize_the_next_batch(self):
        self.snapshot_filled = False
        self.observe()
        self.tick()
        self.tick(1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.state()["status"], "blocked")
        self.assertIn("尚未反映", self.state()["reason"])

    def test_fill_update_time_allows_new_net_exposure_but_rejects_older_balanced_projection(self):
        exchange_fill_times = iter((1000.0, 1000.5))
        def submit_with_source_time(orders, **_):
            result = self.submit("b", orders)
            result[0]["updateTime"] = int(next(exchange_fill_times) * 1000)
            return result
        self.brokers["b"].submit.side_effect = submit_with_source_time
        self.observe()
        self.tick()
        self.assertEqual(len(self.sent), 1)

        # A separate opening adds one short after the first close. Its actual
        # position projection covers that close, despite the larger quantity.
        self.holdings["b"] = [position("SHORT", "3")]
        self.position_updates["b"][SYMBOL, "SHORT"] = 1000.25
        self.tick(1)
        self.assertEqual(len(self.sent), 2)
        self.assertEqual(self.sent[1]["net_before"], dec("1"))
        self.assertEqual(dec(self.sent[1]["order"]["quantity"]), dec("1"))

        # The second close now appears balanced, but the exchange's source
        # clock still predates its receipt. Local read time cannot repair that.
        self.position_updates["b"][SYMBOL, "SHORT"] = 1000.4
        self.tick(1)
        self.assertNotEqual(self.state()["status"], "completed")
        self.assertEqual(len(self.sent), 2)
        self.position_updates["b"][SYMBOL, "SHORT"] = 1000.5
        self.tick(10)
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(len(self.sent), 2)

    def test_old_balanced_rest_projection_cannot_complete_before_adl_fill_reaches_positions(self):
        self.holdings["b"] = [position("SHORT", "2")]
        event_time = self.now
        self.observe(projected=False)
        self.tick()
        self.assertNotEqual(self.state()["status"], "completed")
        self.assertEqual(self.state()["before"], {})
        self.assertEqual(self.sent, [])
        self.holdings["a"] = [position("LONG", "1")]
        self.position_updates["a"][SYMBOL, "LONG"] = event_time
        self.tick(10)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["net_before"], dec("1"))
        self.assertEqual(self.state()["before"]["a"]["positions"][0]["quantity"], "1")
        self.tick(1)
        self.assertEqual(self.state()["status"], "completed")

    def test_missing_exchange_position_update_time_cannot_authorize_a_reduction(self):
        self.observe(projected=False)
        self.position_updates["a"].clear()
        self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertEqual(self.state()["before"], {})
        self.assertEqual(self.sent, [])

    def test_late_adl_after_position_read_prevents_completion_until_a_new_scene(self):
        self.holdings["b"] = [position("SHORT", "2")]
        self.observe()
        original_read = self.controller._read
        def read_with_late_event(brokers):
            snapshots = original_read(brokers)
            self.observe(order_id=43)
            return snapshots
        with patch.object(self.controller, "_read", side_effect=read_with_late_event):
            self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertIn("新的 ADL", self.state()["reason"])
        self.tick(10)
        self.assertEqual(self.state()["status"], "completed")
        self.assertEqual(len(self.state()["events"]), 2)
        self.assertEqual(self.sent, [])

    def test_completed_incident_keeps_strategy_paused_until_explicit_enable(self):
        self.holdings["b"] = [position("SHORT", "2")]
        self.observe()
        self.tick()
        self.assertEqual(self.state()["status"], "completed")
        self.assertTrue(self.state()["hold"])
        self.assertFalse(self.store.pair("pair")["enabled"])
        with self.assertRaises(TradingError):
            self.controller.require_clear("pair")
        self.tick(1)
        self.assertTrue(self.state()["hold"])
        pair = self.store.pair("pair")
        self.controller.before_enable(pair)
        enabled = self.store.save_pair({**pair, "enabled": True})
        self.controller.after_enable(enabled)
        self.controller.require_clear("pair")
        self.assertFalse(self.state()["hold"])
        self.assertIsNone(self.tick())

    def test_legacy_pending_unknown_order_is_only_queried_and_never_retransmitted(self):
        order = {"symbol": "XAUUSD1", "positionSide": "LONG", "side": "BUY", "quantity": "1",
                 "newClientOrderId": "legacy-order", "type": "MARKET"}
        runtime = runtime_default()
        runtime["pending"] = {"id": "legacy-batch", "pair_id": "pair", "symbol": "XAUUSD1", "phase": "open",
            "identities": self.controller._context(self.store.pair("pair"))[2], "kind": "ordinary", "created_at": 990,
            "legs": [{"key": "long", "order": order, "dispatch": "sending", "receipt": None},
                {"key": "short", "order": {**order, "positionSide": "SHORT", "side": "SELL",
                    "newClientOrderId": "legacy-short"}, "dispatch": "sending", "receipt": None}], "repairs": []}
        self.store.put("pair_runtime:pair", runtime)
        self.observe()
        self.tick()
        self.controller = adl.AdlController(self.engine)
        self.tick(3)
        self.assertEqual(self.sent, [])
        self.assertTrue(self.brokers["a"].query.called)
        self.assertTrue(all(call.args == ("XAUUSD1", "legacy-order") for call in self.brokers["a"].query.call_args_list))
        self.assertEqual(self.store.get("pair_runtime:pair")["pending"], runtime["pending"])

    def archived_runtime(self):
        pair = self.store.pair("pair")
        identities = self.controller._context(pair)[2]
        runtime = runtime_default()
        runtime["owned"] = {"LONG": "100", "SHORT": "100"}
        runtime["progress"]["baseline"] = dict(runtime["owned"])
        runtime["recovery_watch"] = {"batches": [{"id": "archived", "symbol": "XAUUSD1", "identities": identities,
            "legs": [{"key": key, "order": {"symbol": "XAUUSD1", "positionSide": direction, "side": side,
                "quantity": "1", "type": "MARKET", "newClientOrderId": "archived-" + key}}
                for key, direction, side in (("long", "LONG", "BUY"), ("short", "SHORT", "SELL"))]}]}
        self.store.put("pair_runtime:pair", runtime)
        return runtime

    def test_archived_order_timeout_is_checked_before_any_adl_reduction(self):
        runtime = self.archived_runtime()
        for broker in self.brokers.values():
            broker.query.side_effect = AmbiguousOrder("archived query timeout", http_status=504)
        self.observe()
        self.tick()
        self.assertEqual(self.sent, [])
        self.assertNotEqual(self.state()["status"], "completed")
        self.assertTrue(self.brokers["a"].query.called)
        self.assertTrue(self.brokers["b"].query.called)
        self.assertEqual(self.store.get("pair_runtime:pair")["recovery_watch"], runtime["recovery_watch"])

    def test_archived_unknown_orders_use_current_reality_after_bounded_queries_not_old_strategy_baseline(self):
        self.archived_runtime()
        self.observe()
        self.tick()
        started = self.state()["created_at"]
        self.tick(2)
        self.tick(2)
        self.assertEqual(self.sent, [])
        self.assertTrue(all(broker.query.call_count == 3 for broker in self.brokers.values()))
        self.controller = adl.AdlController(self.engine)
        self.now = started + 120
        self.tick()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0]["order"]["symbol"], SYMBOL)
        self.assertEqual(dec(self.sent[0]["order"]["quantity"]), dec("1"))
        self.assertEqual(self.state()["frozen_runtime"]["owned"], {"LONG": "100", "SHORT": "100"})
        for previous in self.state()["prior_orders"]:
            self.assertEqual(previous["state"], "sending")
            self.assertEqual(previous["resolution"], "positions_verified_unknown")
            self.assertIsNone(previous.get("receipt"))
            self.assertNotEqual(previous["order"]["newClientOrderId"], self.sent[0]["order"]["newClientOrderId"])
        self.tick(1)
        self.assertEqual(self.state()["status"], "completed")
        self.assertTrue(all(broker.query.call_count == 3 for broker in self.brokers.values()))

    def test_archived_order_identity_mismatch_is_rejected_before_query_or_submit(self):
        runtime = self.archived_runtime()
        runtime["recovery_watch"]["batches"][0]["identities"]["long"]["user"] = "different-wallet"
        self.store.put("pair_runtime:pair", runtime)
        self.observe()
        self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertEqual(self.sent, [])
        self.assertTrue(all(not broker.query.called for broker in self.brokers.values()))

    def complete_with_race(self, change):
        self.holdings["b"] = [position("SHORT", "2")]
        self.observe()
        original_guard = self.controller._guard
        original_complete = self.controller._complete
        def guard_then_change(pair, incident, accounts, brokers, snapshots=None):
            original_guard(pair, incident, accounts, brokers, snapshots)
            if snapshots is not None:
                change()
        def complete_with_guard_race(*args):
            with patch.object(self.controller, "_guard", side_effect=guard_then_change):
                return original_complete(*args)
        with patch.object(self.controller, "_complete", side_effect=complete_with_guard_race):
            self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertNotIn("completed_at", self.state())
        self.assertEqual(self.sent, [])

    def test_pair_revision_change_after_final_guard_prevents_durable_completion(self):
        self.complete_with_race(lambda: self.store.save_pair({**self.store.pair("pair"), "name": "并发修改"}))
        self.assertIn("配对配置已变化", self.state()["reason"])

    def test_account_change_after_final_guard_prevents_durable_completion(self):
        self.complete_with_race(lambda: self.store.save_account({**self.store.account("a"), "name": "并发修改"}))
        self.assertIn("账户配置已变化", self.state()["reason"])

    def test_durable_adl_increment_after_final_guard_prevents_marking_old_quantity_handled(self):
        def new_fill():
            original = self.state()["events"][0]
            with self.store.connect() as db:
                adl._merge_event(db, self.store.pair("pair"), self.store.account("a"), original["owner"],
                                 {**original, "executed_qty": "2"})
        self.complete_with_race(new_fill)
        self.assertIn("成交证据已更新", self.state()["reason"])
        with self.store.connect() as db:
            records = adl._unhandled(db, "pair")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0][1]["handled_qty"], "0")

    def test_maintenance_before_processing_records_blocked_incident_without_read_or_send(self):
        self.engine.workspace.active = True
        self.observe()
        self.tick()
        self.assertEqual(self.state()["status"], "blocked")
        self.assertIn("维护", self.state()["reason"])
        self.assertEqual(self.sent, [])
        self.assertEqual(self.reads, [])

    def test_snapshot_generation_change_before_send_fails_closed(self):
        self.observe()
        original_read = self.controller._read
        def invalidate(brokers):
            snapshots = original_read(brokers)
            self.brokers["a"]._snapshot_generation += 1
            return snapshots
        with patch.object(self.controller, "_read", side_effect=invalidate):
            self.tick()
        self.assertEqual(self.sent, [])
        self.assertNotEqual(self.state()["status"], "completed")

    def test_guard_failure_after_batch_persist_is_known_not_sent_and_never_queried(self):
        self.observe()
        original_send = self.controller._send
        def invalidate_before_send(pair, incident, accounts, brokers, snapshots, batch):
            brokers[batch["account_id"]]._snapshot_generation += 1
            return original_send(pair, incident, accounts, brokers, snapshots, batch)
        with patch.object(self.controller, "_send", side_effect=invalidate_before_send):
            self.tick()
        previous = self.state()["batches"][0]
        self.assertTrue(previous["not_sent"])
        self.assertEqual(previous["state"], "terminal")
        self.assertIsNone(previous.get("receipt"))
        self.assertEqual(self.sent, [])
        self.tick(1)
        self.assertEqual(len(self.sent), 1)
        self.assertNotEqual(self.sent[0]["order"]["newClientOrderId"], previous["order"]["newClientOrderId"])
        self.assertTrue(all(not broker.query.called for broker in self.brokers.values()))

    def test_credential_identity_change_before_send_fails_closed(self):
        self.observe()
        original_read = self.controller._read
        def replace_identity(brokers):
            snapshots = original_read(brokers)
            self.brokers["a"].api.credentials["user"] = "different-wallet"
            return snapshots
        with patch.object(self.controller, "_read", side_effect=replace_identity):
            self.tick()
        self.assertEqual(self.sent, [])
        self.assertNotEqual(self.state()["status"], "completed")


if __name__ == "__main__":
    unittest.main()

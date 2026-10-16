"""ADL scheduling and mutation admission; all brokers and events are offline."""
from copy import deepcopy
import json
from types import SimpleNamespace
import time
import unittest
from unittest.mock import Mock, patch

from tests.helpers import Fixture, account
from tests.test_cycle_ws_scheduler import _Future, _Harness
from trading.adl import AdlController
from trading.engine import Engine
from trading.exchange import ExchangeError, LiveBroker, RequestNotSent
from trading.models import TradingError
from trading.pair_execution import PairTrader, runtime_default
from trading.pairing import validate_pair
from trading.user_stream import PrivateAccountStream


def paired_config(**changes):
    return validate_pair({"id": "gold", "name": "黄金", "long_account_id": "test",
                          "short_account_id": "second", "enabled": False,
                          "cycle": {"enabled": True}, **changes})


class AdlIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.pair = self.f.store.save_pair(paired_config(), create=True)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.addCleanup(self.engine.dashboard_reports.close)
        self.engine.brokers["test"] = self.f.broker
        self.engine.adl = Mock(tick=Mock(return_value=None), poll=Mock(return_value=None))

    def make_live(self):
        for aid in ("test", "second"):
            row = self.f.store.account(aid)
            self.f.store.save_account({**row, "mode": "live"})
        self.engine.live_allowed = Mock(return_value=True)
        api = SimpleNamespace(budget=None, close=Mock(),
                              call=Mock(side_effect=AssertionError("unexpected HTTP")))
        broker = LiveBroker({}, self.f.market, api=api)
        api.credentials = {"user": "0x123", "signer": "0x456"}
        self.engine.brokers["test"] = broker
        self.addCleanup(broker.close)
        return broker

    def test_adl_state_intercepts_paused_old_cycle_and_margin_before_trader(self):
        old = {"pending": {"id": "old"}, "progress": {"quantities": {"LONG": "1", "SHORT": "1"}}}
        self.f.store.put("pair_runtime:gold", old)
        self.engine.adl.tick.return_value = {"phase": "adl_complete", "retry_after": 2}
        self.engine.pairs.trader = Mock(tick=Mock(side_effect=AssertionError("old strategy executed")))
        self.assertEqual(self.engine.pairs.tick("gold"), 2)
        self.engine.adl.tick.assert_called_once()
        self.engine.pairs.trader.tick.assert_not_called()
        self.assertEqual(self.f.store.get("pair_runtime:gold"), old)

    def test_without_adl_pair_keeps_existing_trader_path(self):
        self.engine.pairs.trader = Mock(tick=Mock(return_value={}))
        self.assertEqual(self.engine.pairs.tick("gold"), 30)
        self.engine.pairs.trader.tick.assert_called_once()

    def test_repeated_pause_preserves_active_adl_revision_and_processing(self):
        self.engine.adl.require_clear.side_effect = TradingError("ADL 应急处理中")
        self.engine.adl.tick.return_value = {"phase": "adl_active", "retry_after": 1}
        self.engine.pairs.trader = Mock(tick=Mock(side_effect=AssertionError("old strategy executed")))
        saved = self.engine.pairs.enable("gold", False)
        self.assertEqual(saved["revision"], self.pair["revision"])
        self.assertEqual(self.f.store.pair("gold"), self.pair)
        self.assertEqual(self.engine.pairs.tick("gold"), 1)
        self.engine.adl.tick.assert_called_once()
        self.engine.pairs.trader.tick.assert_not_called()

    def test_ordinary_recovery_balance_and_submit_guard_stop_on_adl(self):
        trader = PairTrader(self.engine)
        self.engine.adl.require_clear.side_effect = TradingError("ADL 等待核对")
        for action in (lambda: trader.tick(self.pair),
                       lambda: trader._recover(self.pair, {"pending": {"id": "old"}}, {}),
                       lambda: trader._balance(self.pair, {}, {}, {})):
            with self.assertRaisesRegex(TradingError, "ADL"):
                action()
        with self.assertRaisesRegex(RequestNotSent, "ADL"):
            trader._config_guard(self.pair, {}, opening=False)

    def test_each_prepared_leg_rechecks_adl_before_transport(self):
        trader = PairTrader(self.engine)
        trader._save = Mock()
        self.engine.adl.require_clear.side_effect = TradingError("ADL 新事件")
        leg = {"key": "long", "order": {"symbol": "XAUUSD1", "newClientOrderId": "old-order",
                "side": "BUY", "positionSide": "LONG", "type": "MARKET", "quantity": "1"}}
        state = {"symbol": "XAUUSD1", "identities": {},
                 "pending": {"kind": "ordinary", "phase": "open", "symbol": "XAUUSD1", "legs": [leg]}}
        broker = Mock()
        trader._dispatch(self.pair, state, {"long": broker}, [leg])
        broker.submit.assert_not_called()
        self.assertEqual(leg["submit_evidence"]["kind"], "request_not_sent")
        self.assertEqual(leg["receipt"]["executedQty"], "0")

    def test_adl_arriving_during_snapshot_read_skips_finally_balance(self):
        pair = deepcopy(self.pair)
        pair["margin"]["enabled"] = True
        pair = self.f.store.save_pair(pair)
        runtime = runtime_default()
        runtime["progress"].update(quantities={"LONG": "1", "SHORT": "1"}, opened_at=0,
                                   config={"hold_seconds": 1})
        self.f.store.put("pair_runtime:gold", runtime)
        trader = PairTrader(self.engine)

        def fail_read(*args, **kwargs):
            self.engine.adl.require_clear.side_effect = TradingError("ADL 新事件")
            raise TradingError("持仓被ADL事件更新")

        with patch.object(trader, "_read", side_effect=fail_read), \
                patch.object(trader, "_balance", side_effect=AssertionError("ordinary finally balanced")):
            trader.tick(pair)

    def test_management_and_recovery_cannot_clear_adl_hold(self):
        self.engine.adl.require_clear.side_effect = TradingError("ADL 保持暂停")
        recovery = self.engine.pairs.recovery
        with patch.object(recovery, "check", side_effect=AssertionError("old recovery ran")):
            for action in (lambda: self.engine.pairs.configure("gold", {"name": "changed"}),
                           lambda: self.engine.pairs.delete("gold"),
                           lambda: self.engine.pairs.reconcile_flat("gold"),
                           lambda: self.engine.pairs.preview_recovery("gold"),
                           lambda: self.engine.pairs.check_recovery("gold"),
                           lambda: self.engine.pairs.confirm_recovery("gold", "token"),
                           lambda: self.engine.pairs.skip_recovery("gold", "batch"),
                           lambda: self.engine.pairs.preview_baseline("gold"),
                           lambda: self.engine.pairs.confirm_baseline("gold", "token")):
                with self.assertRaisesRegex(TradingError, "ADL"):
                    action()
        self.assertEqual(self.f.store.pair("gold"), self.pair)

    def test_start_rejects_pending_adl_before_legacy_recovery_or_writes(self):
        self.f.store.put("pair_runtime:gold", {"pending": {"kind": "ordinary", "phase": "open"}})
        self.engine.adl.before_enable.side_effect = TradingError("ADL 尚未完成")
        with patch.object(self.engine.pairs.recovery, "check", side_effect=AssertionError("old recovery ran")):
            with self.assertRaisesRegex(TradingError, "ADL"):
                self.engine.pairs.enable("gold", True)
        self.engine.adl.after_enable.assert_not_called()
        self.assertFalse(self.f.store.pair("gold")["enabled"])

    def test_completed_hold_is_released_only_after_successful_strategy_activation(self):
        seen = []
        self.engine.adl.before_enable.side_effect = lambda pair: seen.append(("before", self.f.store.pair("gold")["enabled"]))
        self.engine.adl.after_enable.side_effect = lambda pair: seen.append(("after", self.f.store.pair("gold")["enabled"]))
        saved = self.engine.pairs.enable("gold", True)
        self.assertTrue(saved["enabled"])
        self.assertEqual(seen, [("before", False), ("after", True)])
        self.engine.adl.require_clear.assert_any_call("gold", allow_completed=True)

    def test_failed_start_does_not_release_completed_hold(self):
        with patch.object(self.engine.pairs, "_read_members", side_effect=TradingError("snapshot failed")):
            with self.assertRaisesRegex(TradingError, "snapshot failed"):
                self.engine.pairs.enable("gold", True)
        self.engine.adl.before_enable.assert_called_once()
        self.engine.adl.after_enable.assert_not_called()
        self.assertFalse(self.f.store.pair("gold")["enabled"])

    def test_margin_only_start_also_releases_hold_after_activation(self):
        pair = deepcopy(self.pair)
        pair["cycle"]["enabled"] = False
        pair["margin"]["enabled"] = True
        self.f.store.save_pair(pair)
        seen = []
        self.engine.adl.after_enable.side_effect = lambda pair: seen.append(self.f.store.pair("gold")["enabled"])
        with patch("trading.margin_balance.MarginBalancer.verify_members"):
            self.assertTrue(self.engine.pairs.enable("gold", True)["enabled"])
        self.engine.adl.before_enable.assert_called_once()
        self.assertEqual(seen, [True])

    def test_paused_live_pair_keeps_private_stream_without_snapshot_refresh(self):
        broker = self.make_live()
        broker.start_cycle_hot_data = Mock()
        broker.refresh_cycle_hot_snapshot = Mock(side_effect=AssertionError("paused pair refreshed REST"))
        self.assertEqual(self.engine.poll_cycle_hot_data("test"), 30)
        self.assertEqual(broker.start_cycle_hot_data.call_args.args, (["XAUUSD1"],))
        broker.refresh_cycle_hot_snapshot.assert_not_called()
        broker.api.call.assert_not_called()
        raw = {"e": "ORDER_TRADE_UPDATE", "o": {"c": "adl_autoclose"}}
        broker._adl_on_event(raw)
        self.engine.adl.observe.assert_called_once_with("test", broker, raw)

    def test_history_poll_includes_paused_bound_live_account_and_respects_gate(self):
        self.assertEqual(self.engine.poll_adl("test"), 30)
        self.engine.adl.poll.assert_not_called()
        self.make_live()
        self.assertEqual(self.engine.poll_adl("test"), 1)
        self.engine.adl.poll.assert_called_once_with(self.f.store.account("test"))
        self.engine.adl.poll.reset_mock()
        self.engine.live_allowed.return_value = False
        self.assertEqual(self.engine.poll_adl("test"), 30)
        self.engine.adl.poll.assert_not_called()

    def test_wake_callback_uses_only_local_memory(self):
        with patch.object(self.f.store, "pair_for_account", side_effect=AssertionError("callback read DB")), \
                patch.object(self.f.store, "account", side_effect=AssertionError("callback read DB")):
            self.engine.wake_adl("test")
            self.engine.wake_adl("test")
        self.assertEqual(self.engine._adl_wakes, {"test"})
        self.assertTrue(self.engine.scheduler_event.is_set())

    @staticmethod
    def confirmed_event(stamp):
        return {"e": "ORDER_TRADE_UPDATE", "E": stamp, "T": stamp,
                "o": {"s": "XAUUSD1", "i": 10, "c": "adl_autoclose", "ps": "LONG", "S": "SELL",
                      "q": "1", "z": "1", "l": "1", "X": "FILLED", "x": "TRADE", "T": stamp}}

    def test_queued_live_event_survives_first_history_baseline(self):
        broker = self.make_live()
        self.engine.adl = AdlController(self.engine)
        now = time.time()
        raw = self.confirmed_event(int((now - 1) * 1000))
        self.engine.adl.observe("test", broker, raw)
        result = {"events": [], "remaining": [], "blocked": None, "error": None, "retry_after": 0}
        with patch("trading.adl.adl_events.scan_force_orders", return_value=result):
            self.engine.poll_adl("test")
        with self.f.store.connect() as db:
            rows = db.execute("SELECT data FROM kv WHERE key GLOB 'adl_event:*'").fetchall()
        self.assertEqual(len(rows), 1)
        with self.assertRaisesRegex(TradingError, "ADL"):
            self.engine.adl.require_clear("gold")
        self.assertEqual(self.engine.adl.queue, {})

    def test_new_event_during_completed_hold_activation_restores_pause(self):
        broker = self.make_live()
        self.engine.adl = AdlController(self.engine)
        self.f.store.put("adl_pair:gold", {"id": "completed", "status": "completed", "hold": True})
        pair = self.f.store.save_pair({**self.pair, "enabled": True})
        self.engine.adl.observe("test", broker, self.confirmed_event(int(time.time() * 1000)))
        with self.assertRaisesRegex(TradingError, "ADL"):
            self.engine.adl.after_enable(pair)
        self.assertFalse(self.f.store.pair("gold")["enabled"])
        self.assertTrue(self.f.store.get("adl_pair:gold")["hold"])

    def test_reconnect_does_not_bypass_history_rate_limit_deadline(self):
        broker = self.make_live()
        self.engine.adl = AdlController(self.engine)
        now = time.time()
        result = {"events": [], "remaining": [[int(now * 1000), int(now * 1000)]],
                  "blocked": None, "error": "retry", "retry_after": 180}
        with patch("trading.adl.time.time", return_value=now), \
                patch("trading.adl.adl_events.scan_force_orders", return_value=result) as scan:
            self.engine.poll_adl("test")
            self.engine.adl.reconnected("test", broker)
            self.engine.poll_adl("test")
        self.assertEqual(scan.call_count, 1)

    def test_history_rate_limit_deadline_survives_controller_restart_and_reconnect(self):
        broker = self.make_live()
        self.engine.adl = AdlController(self.engine)
        now = 1_800_000_000.0
        broker.api.call.side_effect = [ExchangeError("rate limited", retry_after=180, http_status=429), []]
        with patch("trading.adl.time.time", return_value=now) as clock:
            self.engine.poll_adl("test")
            with self.f.store.connect() as db:
                key, raw = db.execute("SELECT key,data FROM kv WHERE key GLOB 'adl_scan:*'").fetchone()
            saved = json.loads(raw)
            self.assertEqual(saved["retry_at"], now + 180)
            self.assertTrue(saved["windows"])
            self.engine.adl = AdlController(self.engine)
            clock.return_value = now + 179
            self.engine.adl.reconnected("test", broker)
            self.engine.poll_adl("test")
            self.assertEqual(broker.api.call.call_count, 1)
            self.assertEqual(self.f.store.get(key), saved)
            clock.return_value = now + 180
            self.engine.poll_adl("test")
        self.assertEqual(broker.api.call.call_count, 2)
        self.assertEqual(self.f.store.get(key)["windows"], [])

    def test_unfinished_orders_remain_queryable_after_cursor_passes_creation_and_accept_later_fills(self):
        broker = self.make_live()
        self.engine.adl = AdlController(self.engine)
        baseline = 1_800_000_000
        first_event = baseline + 20
        rest_first_event = baseline + 140
        rest_created = (baseline + 120) * 1000
        ws_created = (baseline - 10) * 1000
        phase, queries = "baseline", []

        def row(order_id, created, updated, status, executed, original):
            return {"symbol": "XAUUSD1", "orderId": order_id, "clientOrderId": "adl_autoclose",
                    "positionSide": "LONG", "side": "SELL", "origQty": original, "executedQty": executed,
                    "status": status, "time": created, "updateTime": updated}

        def query(method, path, params, **kwargs):
            self.assertEqual((method, path), ("GET", "/fapi/v3/forceOrders"))
            window = (params["startTime"], params["endTime"])
            queries.append((phase, window))
            if phase == "baseline":
                return []
            if phase in ("initial", "advance"):
                # Return the same cumulative partial fill with a numerically
                # equal original quantity in a different decimal spelling.
                return [row(20, rest_created, int(clock.return_value * 1000),
                            "PARTIALLY_FILLED", "1", "2.00")] if window[0] <= rest_created <= window[1] else []
            if window[0] <= ws_created <= window[1]:
                self.assertLessEqual(window[0], first_event * 1000 - 60000)
                return [row(10, ws_created, int(clock.return_value * 1000), "FILLED", "2", "2.000")]
            if window[0] <= rest_created <= window[1]:
                self.assertLessEqual(window[0], rest_created - 1)
                self.assertGreaterEqual(window[1], rest_created + 1)
                return [row(20, rest_created, int(clock.return_value * 1000), "FILLED", "2", "2.000")]
            return []

        broker.api.call.side_effect = query
        with patch("trading.adl.time.time", return_value=baseline) as clock:
            self.engine.poll_adl("test")
            phase, clock.return_value = "initial", rest_first_event
            candidate = self.confirmed_event(first_event * 1000)
            candidate["o"].update(q="2", z="0", l="0", X="NEW_ADL", x="NEW")
            self.engine.adl.observe("test", broker, candidate)
            self.engine.poll_adl("test")
            with self.f.store.connect() as db:
                initial = {json.loads(raw)["order_id"]: json.loads(raw)
                           for (raw,) in db.execute("SELECT data FROM kv WHERE key GLOB 'adl_event:*'")}
            self.assertEqual(initial["10"]["executed_qty"], "0")
            self.assertEqual(initial["20"]["executed_qty"], "1")
            self.assertEqual(initial["20"]["order_at"], rest_created / 1000)
            phase, clock.return_value = "advance", baseline + 400
            partial = self.confirmed_event((baseline + 400) * 1000)
            partial["o"].update(i=20, q="2.000", z="1", l="0", X="PARTIALLY_FILLED")
            self.engine.adl.observe("test", broker, partial)
            self.engine.poll_adl("test")
            with self.f.store.connect() as db:
                scan = json.loads(db.execute("SELECT data FROM kv WHERE key GLOB 'adl_scan:*'").fetchone()[0])
                saved = {json.loads(raw)["order_id"]: json.loads(raw)
                         for (raw,) in db.execute("SELECT data FROM kv WHERE key GLOB 'adl_event:*'")}
            self.assertEqual(scan["cursor_ms"], (baseline + 400) * 1000)
            self.assertEqual(saved["20"]["first_event_at"], rest_first_event)
            self.assertEqual(saved["20"]["order_at"], rest_created / 1000)
            self.assertFalse(saved["20"].get("conflict"))
            phase, clock.return_value = "upgrade", baseline + 500
            self.engine.poll_adl("test")
            with self.f.store.connect() as db:
                scan = json.loads(db.execute("SELECT data FROM kv WHERE key GLOB 'adl_scan:*'").fetchone()[0])
            self.assertEqual(scan["windows"], [[rest_created - 1, rest_created + 1]])
            self.assertEqual(scan["cursor_ms"], (baseline + 400) * 1000)
            clock.return_value += 1
            self.engine.poll_adl("test")
        windows = [window for label, window in queries if label == "upgrade"]
        self.assertEqual(len(windows), 3)
        self.assertGreater(windows[0][0], rest_created)
        self.assertGreater(windows[0][0], first_event * 1000)
        self.assertLessEqual(windows[1][0], first_event * 1000 - 60000)
        self.assertEqual(windows[2], (rest_created - 1, rest_created + 1))
        with self.f.store.connect() as db:
            final = {json.loads(raw)["order_id"]: json.loads(raw)
                     for (raw,) in db.execute("SELECT data FROM kv WHERE key GLOB 'adl_event:*'")}
        self.assertEqual(set(final), {"10", "20"})
        for event in final.values():
            self.assertEqual((event["status"], event["executed_qty"]), ("FILLED", "2"))
            self.assertFalse(event.get("conflict"))
            self.assertEqual(event["first_event_at"], first_event if event["order_id"] == "10" else rest_first_event)


class AdlPrivateStreamHookTests(unittest.TestCase):
    def test_current_stream_forwards_raw_payload_and_state_once_per_transition(self):
        broker = LiveBroker({}, Mock(), api=Mock(budget=None))
        self.addCleanup(broker.close)
        event_listener, state_listener = Mock(), Mock()
        broker.set_adl_listener(on_event=event_listener, on_reconnected=state_listener)
        with patch.object(PrivateAccountStream, "start"):
            broker.start_cycle_hot_data(["XAUUSD1"])
        token = broker._cycle_stream_token
        raw = {"e": "ORDER_TRADE_UPDATE", "o": {"c": "adl_autoclose", "X": "NEW_ADL"}}
        with patch.object(broker._private_evidence, "payload") as normal:
            broker._cycle_stream_payload(token, raw)
            normal.assert_called_once_with(raw)
            event_listener.assert_called_once_with(raw)
            broker._cycle_stream_payload(object(), raw)
            self.assertEqual(event_listener.call_count, 1)
        broker._cycle_stream_state(token, True)
        broker._cycle_stream_state(token, True)
        broker._cycle_stream_state(token, False)
        broker._cycle_stream_state(object(), True)
        self.assertEqual(state_listener.call_count, 2)
        broker.stop_cycle_hot_data()
        broker._cycle_stream_payload(token, raw)
        broker._cycle_stream_state(token, True)
        self.assertEqual(event_listener.call_count, 1)
        self.assertEqual(state_listener.call_count, 2)
        broker.api.call.assert_not_called()


class AdlSchedulerHookTests(unittest.TestCase):
    def test_event_during_history_request_wakes_pair_once_and_requeues_history_after_completion(self):
        fixture = Fixture()
        self.addCleanup(fixture.close)
        harness = _Harness(fixture)
        for aid in ("test", "second"):
            fixture.store.save_account({**account(aid), "mode": "live", "enabled": False})
        fixture.store.save_pair(paired_config(), create=True)
        harness.engine.live_allowed = Mock(return_value=True)
        held = _Future(60, done=False)
        history, pairs = [], []

        def poll(aid):
            history.append((aid, harness.ticks))
            return held if aid == "test" and sum(row[0] == "test" for row in history) == 1 else 60

        def tick(pair_id):
            pairs.append(harness.ticks)
            return 60

        def control(step):
            harness.ticks = 100 + step
            if step == 1:
                harness.engine.wake_adl("test")
            elif step == 3:
                held.complete = True
            elif step == 4:
                harness.engine.shutdown.set()

        with patch.object(harness.engine, "poll_adl", side_effect=poll), \
                patch.object(harness.engine, "poll_cycle_hot_data", return_value=30), \
                patch.object(harness.engine, "poll_cycle_history", return_value=30), \
                patch.object(harness.engine.pairs, "tick", side_effect=tick):
            harness.run(control)
        self.assertEqual([stamp for aid, stamp in history if aid == "test"], [100, 103])
        self.assertEqual([stamp for aid, stamp in history if aid == "second"], [100])
        self.assertEqual(pairs, [100, 101])


if __name__ == "__main__":
    unittest.main()

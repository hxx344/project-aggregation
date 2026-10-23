from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

import monitor
from trading.engine import Engine
from trading.exchange import API, MarketData
from trading.listing_alerts import WATCH_PREFIX
from trading.models import TradingError
from trading.server import create_app
from trading.store import Store


class ListingAlertTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "state.sqlite3"
        self.store = Store(self.path)
        self.now = 1000.0
        clock = patch("trading.store.time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.state = {"initialized": True, "checked_at": self.now, "rows": {}}
        self.observe("0")

    def observe(self, amount, *, leverage=200, symbol="BTCUSD1", **fields):
        self.state["checked_at"] = self.now
        self.state["rows"][symbol] = {"symbol": symbol, "status": "TRADING", "max_leverage": leverage,
            "capacity": amount, "remaining": amount, "bracket_cap": "1000000", "checked_at": self.now,
            "brackets_checked_at": self.now, "error": None, **fields}
        self.store.save_listing_state(self.state)

    def select(self, enabled=True, symbol="BTCUSD1"):
        self.store.set_listing_watch(symbol, enabled)

    def observe_rule(self, amount, *, requested=20, leverage=None, symbol="BTCUSD1", sample_fields=None, **fields):
        source = {"requested_leverage": requested, "leverage": requested if leverage is None else leverage,
                  "capacity": amount, "remaining": amount, "bracket_cap": "1e100",
                  "checked_at": self.now, "brackets_checked_at": self.now, "error": None,
                  **(sample_fields or {})}
        self.observe("999", symbol=symbol, capacity_alert_sample=source, **fields)

    def configure_rule(self, leverage=20, threshold="100", symbol="BTCUSD1"):
        return self.store.edit_monitoring({"notification_types": ["listing_capacity"],
            "listing_capacity_leverage": leverage, "listing_capacity_threshold": threshold}, symbol=symbol)

    def gate(self, symbol="BTCUSD1"):
        return self.store.get(WATCH_PREFIX + symbol)

    def outbox(self):
        with self.store.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM outbox ORDER BY rowid")]

    def send(self):
        item = self.store.due_notifications()[0]
        self.store.notification_result(item, True)
        return item

    def test_selection_queues_existing_positive_once_and_persists_after_restart(self):
        self.observe("0.000000000000000000001")
        self.assertEqual(self.store.pending_notifications(), 0)
        self.select()
        item = self.send()
        self.assertIn("最大杠杆：200x", item["message"])
        self.assertIn("1E-21 USD1", item["message"])
        self.store = Store(self.path)
        self.assertEqual(self.store.listing_watch_symbols(), ["BTCUSD1"])
        self.select()
        self.now += 60
        self.observe("5")
        self.assertEqual(len(self.outbox()), 1)
        self.assertEqual(self.store.pending_notifications(), 0)

    def test_zero_then_positive_rearms_but_positive_amount_changes_do_not(self):
        self.select()
        self.assertEqual(self.outbox(), [])
        self.observe("0.0001")
        self.send()
        self.observe("900")
        self.assertEqual(len(self.outbox()), 1)
        self.observe("0")
        self.observe("1")
        self.assertEqual(len(self.outbox()), 2)
        self.assertEqual(self.store.pending_notifications(), 1)

    def test_leverage_change_rearms_and_cancels_old_leverage(self):
        self.select()
        self.observe("3")
        old = self.store.due_notifications()[0]
        self.observe("5", leverage=100)
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        item = self.store.due_notifications()[0]
        self.assertNotEqual(item["id"], old["id"])
        self.assertIn("最大杠杆：100x", item["message"])
        self.send()
        self.observe("5", leverage=50)
        self.assertEqual(self.store.pending_notifications(), 1)

    def test_unknown_data_does_not_reset_a_delivered_positive_episode(self):
        self.select()
        self.observe("1")
        self.send()
        for fields in ({"error": "network"}, {"capacity": None}, {"checked_at": 0},
                       {"brackets_checked_at": self.now - 180}, {"status": "MISSING"}):
            row = {**self.state["rows"]["BTCUSD1"], **fields}
            self.state["rows"]["BTCUSD1"] = row
            self.store.save_listing_state(self.state)
            self.assertTrue(self.gate()["notified"])
            self.now += 1
            self.observe("1")
            self.assertEqual(self.store.pending_notifications(), 0)
        self.assertEqual(len(self.outbox()), 1)

    def test_invalid_samples_never_queue_or_rearm(self):
        self.select()
        for fields in ({"capacity": "NaN"}, {"capacity": "-1"}, {"capacity": "99"},
                       {"remaining": None}, {"checked_at": self.now + 2}, {"checked_at": True},
                       {"max_leverage": True}, {"max_leverage": 0}, {"brackets_checked_at": float("inf")}):
            row = {"symbol": "BTCUSD1", "status": "TRADING", "max_leverage": 200, "capacity": "1",
                   "remaining": "1", "bracket_cap": "100", "checked_at": self.now, "brackets_checked_at": self.now, **fields}
            self.state["rows"]["BTCUSD1"] = row
            self.store.save_listing_state(self.state)
            self.assertEqual(self.outbox(), [], fields)

    def test_partial_new_maximum_stops_old_message_and_complete_sample_rearms(self):
        self.select()
        self.observe("1")
        old = self.store.due_notifications()[0]
        self.observe(None, leverage=100, error="exact tier missing")
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        self.assertEqual(self.gate()["leverage"], 200)
        self.observe("3", leverage=100)
        self.assertNotEqual(self.store.due_notifications()[0]["id"], old["id"])

    def test_delivery_rechecks_catalog_freshness_at_boundary(self):
        self.select()
        self.observe("1")
        item = self.store.due_notifications()[0]
        self.now += 179.9
        self.assertIsNotNone(self.store.notification_for_delivery(item["id"]))
        self.now = 1180
        self.assertIsNone(self.store.notification_for_delivery(item["id"]))
        self.assertEqual(self.store.due_notifications(), [])

    def test_catalog_failure_pauses_pending_then_recovers_same_episode(self):
        self.select()
        self.observe("1")
        old = self.store.due_notifications()[0]
        self.state["error"] = "catalog failed"
        self.store.save_listing_state(self.state)
        self.assertEqual(self.store.due_notifications(), [])
        self.state["error"] = None
        self.observe("2")
        self.assertEqual(self.store.due_notifications()[0]["id"], old["id"])

    def test_stale_zero_cannot_rearm_or_replace_newer_positive_sample(self):
        self.select()
        self.observe("1")
        self.send()
        self.observe("0", checked_at=self.now - 1)
        self.assertTrue(self.gate()["notified"])
        self.observe("5")
        self.assertEqual(self.store.due_notifications(), [])

    def test_cancel_and_reselect_make_fresh_episode_and_old_ack_cannot_consume_it(self):
        self.observe("1")
        self.select()
        old = self.store.due_notifications()[0]
        self.select(False)
        self.assertEqual(self.store.listing_watch_symbols(), [])
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        self.select()
        new = self.store.due_notifications()[0]
        self.store.notification_result(old, True)
        self.assertEqual(self.gate()["pending_id"], new["id"])
        self.assertFalse(self.gate()["notified"])

    def test_inflight_zero_to_positive_keeps_new_notification_after_old_success(self):
        self.select()
        self.observe("1")
        old = self.store.due_notifications()[0]
        self.observe("0")
        self.observe("2")
        current = self.store.due_notifications()[0]
        self.store.notification_result(old, True)
        self.assertEqual(self.store.due_notifications()[0]["id"], current["id"])

    def test_refresh_preserves_failure_backoff_and_restart_pending_id(self):
        self.select()
        self.observe("1")
        item = self.store.due_notifications()[0]
        self.store.notification_result(item, False)
        before = self.outbox()[0]
        self.store = Store(self.path)
        self.now += 1
        self.observe(None, error="network")
        self.observe("2")
        after = self.outbox()[0]
        self.assertEqual((after["id"], after["attempts"], after["due_at"]), (before["id"], 1, before["due_at"]))
        self.assertEqual(self.store.due_notifications(), [])
        self.now = before["due_at"]
        self.assertIn("公开可用额度：2 USD1", self.store.due_notifications()[0]["message"])

    def test_poll_snapshot_cannot_overwrite_selection_changes(self):
        self.observe("1")
        old_snapshot = deepcopy(self.state)
        self.select()
        self.store.save_listing_state(old_snapshot)
        self.assertEqual(self.store.listing_watch_symbols(), ["BTCUSD1"])
        self.select(False)
        self.store.save_listing_state(old_snapshot)
        self.assertEqual(self.store.listing_watch_symbols(), [])
        self.assertEqual(self.store.due_notifications(), [])

    def test_concurrent_instances_queue_only_one_message(self):
        other = Store(self.path)
        self.observe("1")
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(store.set_listing_watch, "BTCUSD1", True) for store in (self.store, other)]
            for job in jobs:
                job.result(timeout=5)
        self.assertEqual(len(self.outbox()), 1)

    def test_queue_failure_rolls_back_selection_and_sample_gate_atomically(self):
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER fail_watch BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test'); END")
        self.observe("1")
        with self.assertRaises(sqlite3.IntegrityError):
            self.select()
        self.assertEqual(self.store.listing_watch_symbols(), [])
        self.observe("0")
        self.select()
        before = self.store.get("usd1_listings")
        with self.assertRaises(sqlite3.IntegrityError):
            self.observe("1")
        self.assertEqual(self.store.get("usd1_listings"), before)
        self.assertFalse(self.gate()["notified"])
        self.assertIsNone(self.gate()["pending_id"])

    def test_different_symbols_and_original_listing_messages_are_independent(self):
        self.observe("2", symbol="龙虾USD1")
        self.select(symbol="龙虾USD1")
        self.observe("1")
        self.select()
        self.store.save_listing_state(self.state, [("usd1-listing:BTCUSD1", "old listing notice")])
        self.select(False)
        messages = self.store.due_notifications()
        self.assertEqual(len(messages), 2)
        self.assertTrue(any("龙虾USD1" in item["message"] for item in messages))
        self.assertTrue(any(item["message"] == "old listing notice" for item in messages))

    def test_only_known_symbols_and_strict_booleans_can_be_saved(self):
        for symbol, enabled in (("UNKNOWNUSD1", True), ("BTCUSD1", 1), ("BTCUSD1", "true"), ("a:b", True)):
            with self.subTest(symbol=symbol, enabled=enabled), self.assertRaises(TradingError):
                self.store.set_listing_watch(symbol, enabled)
        self.select()
        self.state["rows"]["BTCUSD1"]["status"] = "MISSING"
        self.store.save_listing_state(self.state)
        self.select(False)
        self.assertEqual(self.store.listing_watch_symbols(), [])

    def test_fixed_10_20_and_arbitrary_tiers_use_exact_requested_sample(self):
        for leverage in (10, 20, 37):
            with self.subTest(leverage=leverage):
                self.configure_rule(leverage)
                self.assertEqual(self.store.due_notifications(), [])
                self.observe_rule("101", requested=leverage, error="maximum tier unavailable")
                item = self.send()
                self.assertIn(f"指定杠杆：{leverage}x", item["message"])
                self.assertIn("触发条件：> 100 USD1", item["message"])
                self.assertIn("额度采样时间：", item["message"])
                self.assertIn("档位采样时间：", item["message"])

    def test_decimal_equality_and_strict_exceed_preserve_precision_and_rearm(self):
        threshold = "9007199254740993.0000000000000000000001"
        above = "9007199254740993.0000000000000000000002"
        self.configure_rule(threshold=threshold)
        self.observe_rule(threshold)
        self.assertEqual(self.outbox(), [])
        self.observe_rule(above)
        self.send()
        self.observe_rule("9007199254740994")
        self.assertEqual(len(self.outbox()), 1)
        self.observe_rule(threshold)
        self.assertFalse(self.gate()["notified"])
        self.observe_rule(above)
        self.assertEqual(len(self.outbox()), 2)

    def test_threshold_change_rechecks_matching_fresh_sample_and_old_ack_is_isolated(self):
        self.observe_rule("101")
        self.configure_rule(threshold="100")
        old = self.store.due_notifications()[0]
        self.configure_rule(threshold="99")
        new = self.store.due_notifications()[0]
        self.assertNotEqual(old["id"], new["id"])
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        self.store.notification_result(old, True)
        self.assertEqual(self.gate()["pending_id"], new["id"])
        self.assertFalse(self.gate()["notified"])
        self.send()
        self.configure_rule(threshold="102")
        self.assertEqual(self.store.due_notifications(), [])
        self.observe_rule("103")
        self.assertEqual(len(self.store.due_notifications()), 1)

    def test_leverage_change_waits_for_matching_sample_and_rejects_old_poll(self):
        self.observe_rule("101")
        self.configure_rule()
        old = self.store.due_notifications()[0]
        old_state = deepcopy(self.state)
        revision = self.store.monitoring_settings()["revision"]
        self.configure_rule(leverage=10)
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        self.store.save_listing_state(old_state, policy_revision=revision)
        self.assertEqual(self.store.due_notifications(), [])
        self.observe_rule("101", requested=10)
        current = self.store.due_notifications()[0]
        self.store.notification_result(old, True)
        self.assertEqual(self.gate()["pending_id"], current["id"])
        self.assertFalse(self.gate()["notified"])

    def test_default_mode_only_falls_back_when_independent_sample_is_absent(self):
        self.configure_rule(leverage=None, threshold="100")
        self.observe("101")
        self.send()
        self.observe("0", capacity_alert_sample=None)
        self.assertTrue(self.gate()["notified"])
        self.observe_rule("0", requested=None, leverage=200, sample_fields={"error": "failed"})
        self.assertTrue(self.gate()["notified"])
        self.observe_rule("0", requested=20)
        self.assertTrue(self.gate()["notified"])
        self.observe_rule("0", requested=None, leverage=200)
        self.assertFalse(self.gate()["notified"])
        self.observe_rule("101", requested=None, leverage=200, error="legacy row failed")
        self.assertEqual(len(self.store.due_notifications()), 1)

    def test_fixed_rule_cannot_use_legacy_maximum_or_malformed_independent_samples(self):
        self.configure_rule()
        self.observe("1000", leverage=20)
        self.assertEqual(self.outbox(), [])
        for fields in ({"requested_leverage": None}, {"requested_leverage": True},
                       {"requested_leverage": "20"}, {"leverage": 10}, {"leverage": True},
                       {"capacity": None}, {"capacity": "0"}, {"remaining": None},
                       {"error": "missing exact tier"}, {"checked_at": self.now - 180},
                       {"brackets_checked_at": self.now - 180}, {"checked_at": self.now + 2}):
            with self.subTest(fields=fields):
                self.observe_rule("101", sample_fields=fields)
                self.assertEqual(self.outbox(), [])

    def test_unknown_custom_sample_does_not_rearm_and_recovery_preserves_backoff(self):
        self.configure_rule()
        self.observe_rule("101")
        old = self.store.due_notifications()[0]
        self.store.notification_result(old, False)
        before = self.outbox()[0]
        self.store = Store(self.path)
        self.now += 1
        self.observe_rule("0", sample_fields={"error": "network"})
        self.assertEqual(self.store.due_notifications(), [])
        self.observe_rule("102")
        after = self.outbox()[0]
        self.assertEqual((after["id"], after["attempts"], after["due_at"]),
                         (before["id"], 1, before["due_at"]))
        self.now = before["due_at"]
        self.send()
        self.observe_rule("0", sample_fields={"error": "network"})
        self.observe_rule("0", sample_fields={"checked_at": self.now - 180})
        self.assertTrue(self.gate()["notified"])
        self.observe_rule("102")
        self.assertEqual(self.store.due_notifications(), [])

    def test_custom_sample_is_rechecked_at_delivery_and_threshold_edit_cannot_freshen_it(self):
        self.configure_rule()
        self.observe_rule("101")
        old = self.store.due_notifications()[0]
        self.now += 180
        self.assertIsNone(self.store.notification_for_delivery(old["id"]))
        self.configure_rule(threshold="1")
        self.assertEqual(self.store.due_notifications(), [])
        self.assertIsNone(self.gate()["pending_id"])
        self.observe_rule("2")
        self.assertEqual(len(self.store.due_notifications()), 1)

    def test_each_symbol_rule_and_notification_episode_are_independent(self):
        self.observe_rule("101")
        self.observe_rule("51", requested=10, symbol="ETHUSD1")
        self.configure_rule()
        self.configure_rule(leverage=10, threshold="50", symbol="ETHUSD1")
        messages = self.store.due_notifications()
        self.assertEqual(len(messages), 2)
        eth_gate = self.gate("ETHUSD1")
        self.configure_rule(threshold="102")
        self.assertEqual(self.gate("ETHUSD1"), eth_gate)
        self.assertEqual(len(self.store.due_notifications()), 1)
        self.assertIn("ETHUSD1", self.store.due_notifications()[0]["message"])

    def test_rule_change_and_new_pending_are_atomic_on_enqueue_failure(self):
        self.observe_rule("101")
        self.configure_rule()
        before_config, before_gate, before_outbox = self.store.monitoring_settings(), self.gate(), self.outbox()
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER fail_rule BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.configure_rule(threshold="99")
        self.assertEqual(self.store.monitoring_settings(), before_config)
        self.assertEqual(self.gate(), before_gate)
        self.assertEqual(self.outbox(), before_outbox)

    def test_equivalent_rules_keep_pending_backoff_and_delivered_episode_across_restart(self):
        self.observe_rule("101")
        self.configure_rule(threshold="100.00")
        old = self.store.due_notifications()[0]
        self.store.notification_result(old, False)
        before_config, before_gate, before_outbox = self.store.monitoring_settings(), self.gate(), self.outbox()
        self.configure_rule(threshold="1e2")
        self.assertEqual(self.store.monitoring_settings(), before_config)
        self.assertEqual(self.gate(), before_gate)
        self.assertEqual(self.outbox(), before_outbox)
        self.store = Store(self.path)
        self.now = before_outbox[0]["due_at"]
        self.observe_rule("102")
        self.assertEqual(self.send()["id"], old["id"])
        self.configure_rule(threshold="100.000")
        self.observe_rule("103")
        self.assertTrue(self.gate()["notified"])
        self.assertEqual(len(self.outbox()), 1)

    def test_legacy_gate_missing_fingerprint_keeps_its_episode_with_new_default_sample(self):
        self.observe("1")
        self.select()
        self.send()
        self.assertNotIn("rule", self.gate())
        self.store = Store(self.path)
        self.observe_rule("2", requested=None, leverage=200)
        self.assertTrue(self.gate()["notified"])
        self.assertEqual(len(self.outbox()), 1)


class ListingAlertAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "state.sqlite3")
        api = API(transport=httpx.MockTransport(lambda _: httpx.Response(500)))
        self.addCleanup(api.close)
        self.engine = Engine(self.store, market=MarketData(api=api))
        import time
        now = time.time()
        self.store.save_listing_state({"initialized": True, "checked_at": now, "rows": {"BTCUSD1": {
            "symbol": "BTCUSD1", "status": "TRADING", "max_leverage": 200, "capacity": "1", "remaining": "1",
            "bracket_cap": "100", "checked_at": now, "brackets_checked_at": now}}})
        with patch.dict(os.environ, {"ASTER_DASHBOARD_PASSWORD": "listing-alert-test-password"}, clear=True):
            app = create_app(self.engine, start_engine=False)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.client.headers["origin"] = "http://testserver"
        self.url = "/api/listings/BTCUSD1/capacity-alert"

    def login(self):
        self.assertEqual(self.client.post("/api/login", json={"password": "listing-alert-test-password"}).status_code, 200)

    def test_no_account_selection_state_and_feishu_delivery(self):
        self.login()
        self.assertEqual(self.client.patch(self.url, json={"enabled": True}).status_code, 200)
        state = self.client.get("/api/state").json()
        self.assertEqual(state["accounts"], [])
        self.assertEqual(state["listings"]["watched_symbols"], ["BTCUSD1"])
        with patch.object(self.engine, "notification_config", return_value={"webhook": "https://example.invalid", "cooldown_seconds": 0}), patch("monitor.send_feishu") as send:
            self.engine.notify()
            self.assertEqual(send.call_count, 1)
            self.assertIn("最大杠杆额度提醒", send.call_args.args[1])
        self.assertEqual(self.store.pending_notifications(), 0)
        self.assertEqual(self.client.patch(self.url, json={"enabled": False}).status_code, 200)

    def test_auth_origin_and_schema_validation(self):
        self.assertEqual(self.client.patch(self.url, json={"enabled": True}).status_code, 401)
        self.login()
        self.assertEqual(self.client.patch(self.url, json={"enabled": True}, headers={"origin": "https://bad.invalid"}).status_code, 403)
        for body in ({}, {"enabled": 1}, {"enabled": "true"}, {"enabled": None}, {"enabled": True, "extra": 1}):
            self.assertEqual(self.client.patch(self.url, json=body).status_code, 422)
        self.assertEqual(self.client.patch("/api/listings/UNKNOWNUSD1/capacity-alert", json={"enabled": True}).status_code, 409)
        self.assertEqual(self.store.listing_watch_symbols(), [])

    def test_demo_cannot_enable_alerts(self):
        self.engine.demo = True
        self.assertEqual(self.client.patch(self.url, json={"enabled": True}).status_code, 409)
        self.assertEqual(self.store.listing_watch_symbols(), [])

    def test_capacity_rule_api_saves_decimal_strings_and_explicit_maximum_null(self):
        self.login()
        url = "/api/monitoring/symbols/BTCUSD1"
        body = {"notification_types": ["listing_capacity"], "listing_capacity_leverage": 37,
                "listing_capacity_threshold": "9007199254740993.00000000000000000001"}
        self.assertEqual(self.client.patch(url, json=body).status_code, 200)
        state = self.client.get("/api/monitoring").json()
        row = next(row for row in state["symbols"] if row["symbol"] == "BTCUSD1")
        for key, value in body.items():
            self.assertEqual(row[key], value)
        before = self.store.monitoring_settings()
        self.assertEqual(self.client.patch(url, json={"listing_capacity_threshold": body["listing_capacity_threshold"] + "0"}).status_code, 200)
        self.assertEqual(self.store.monitoring_settings(), before)
        self.assertEqual(self.client.patch(url, json={"listing_capacity_leverage": None}).status_code, 200)
        self.assertIsNone(self.store.monitoring_settings()["symbols"]["BTCUSD1"]["listing_capacity_leverage"])
        self.assertEqual(self.client.patch(self.url, json={"enabled": True}).status_code, 200)
        self.assertEqual(self.store.monitoring_settings()["symbols"]["BTCUSD1"]["listing_capacity_threshold"], body["listing_capacity_threshold"])

    def test_capacity_rule_api_rejects_invalid_inputs_atomically(self):
        self.login()
        url = "/api/monitoring/symbols/BTCUSD1"
        before = self.store.monitoring_settings()
        invalid = [{"listing_capacity_leverage": value} for value in (True, False, "10", 10.0, 0, -1, 10001)]
        invalid += [{"listing_capacity_threshold": value} for value in
                    (None, True, 0, 2.5, "", "NaN", "Infinity", "-1", "1e101", "1e-101", "1" * 129,
                     "1_000", "١٢", "１２", "1e１", "-0", "-0.00")]
        invalid += [{"listing_capacity_leverage": None, "notification_types": None},
                    {"listing_capacity_leverage": None, "monitor_enabled": None}]
        for body in invalid:
            with self.subTest(body=body):
                response = self.client.patch(url, json={"notification_types": ["listing_capacity"], **body})
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(self.store.monitoring_settings(), before)
                self.assertEqual(self.store.listing_watch_symbols(), [])

    def test_capacity_rule_api_uses_same_trimmed_ascii_decimal_grammar_as_store(self):
        self.login()
        url = "/api/monitoring/symbols/BTCUSD1"
        for value in ("  +1.25e2  ", ".5", "5.", "1E-100", "+0", " " + "9" * 128 + " "):
            with self.subTest(value=value):
                self.assertEqual(self.client.patch(url, json={"listing_capacity_threshold": value}).status_code, 200)
                self.assertEqual(self.store.monitoring_settings()["symbols"]["BTCUSD1"]["listing_capacity_threshold"], value.strip())

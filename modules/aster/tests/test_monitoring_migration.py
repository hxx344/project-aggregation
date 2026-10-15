"""Real v1 storage migration and v2 notification authority/compatibility."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from trading import monitoring
from trading.models import TradingError
from trading.store import Store
from tests.test_monitoring_settings import catalog


class MonitoringMigrationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")

    def test_migration_uses_actual_watch_and_all_three_legacy_gates(self):
        for global_enabled in (False, True):
            for alerts in (False, True):
                for selected in (False, True):
                    with self.subTest(global_enabled=global_enabled, alerts=alerts, selected=selected):
                        old = {"revision": 17, "listing_capacity_alerts": global_enabled,
                               "symbols": {"BTCUSD1": {"monitor": False, "alerts": alerts,
                                                        "max_capacity_alert": not selected}}}
                        new = monitoring.migrate_v1_to_v2(old, {"BTCUSD1": {"enabled": selected}})
                        self.assertEqual(new["revision"], 17)
                        self.assertFalse(new["symbols"]["BTCUSD1"]["monitor_enabled"])
                        self.assertEqual("listing_capacity" in new["symbols"]["BTCUSD1"]["notification_types"],
                                         global_enabled and alerts and selected)
                        self.assertNotIn("listing_capacity", new["default_notification_types"])
                        self.assertNotIn("strategy_capacity", new["symbols"]["BTCUSD1"]["notification_types"])
                        self.assertNotIn("schema_version", old)

    def test_startup_migration_preserves_delivery_state_and_backup_exactly(self):
        old = {"revision": 42, "monitoring_enabled": False, "discovery_enabled": False,
               "hourly_summary_alerts": False, "hourly_summary_interval_minutes": 15,
               "relay_health_alerts": False, "trade_summary_alerts": False,
               "symbols": {"XAUUSD1": {"monitor": False, "alerts": True}}}
        self.store.put(monitoring.KEY, old)
        self.store.put("usd1_listings", catalog("BTCUSD1", "XAUUSD1"))
        preserved = {
            "usd1_watch:BTCUSD1": {"enabled": True, "notified": True, "pending_id": "usd1-capacity:BTCUSD1:pending",
                                  "resume_after": 123, "checked_at": 456, "leverage": 100},
            "hourly_summary_schedule": {"next_due_at": 9999, "last_sent_at": 999},
            "relay_health_notifications": {"incident": {"fault_sent": True}},
            "position_imbalance_notifications": {"targets": {"history": {"symbol": "XAUUSD1"}}},
        }
        for key, value in preserved.items():
            self.store.put(key, value)
        with self.store.connect() as db:
            db.execute("INSERT INTO outbox(id,message,due_at,attempts) VALUES ('usd1-capacity:BTCUSD1:pending','original',9000,3)")
            outbox = [tuple(row) for row in db.execute("SELECT * FROM outbox")]
        restarted = Store(self.store.path)
        config = restarted.monitoring_settings()
        self.assertEqual((config["schema_version"], config["revision"]), (2, 42))
        self.assertFalse(config["auto_discover"])
        self.assertFalse(config["hourly_summary_alerts"])
        self.assertEqual(config["hourly_summary_interval_minutes"], 15)
        self.assertFalse(config["relay_health_alerts"])
        self.assertIn("listing_capacity", config["symbols"]["BTCUSD1"]["notification_types"])
        self.assertEqual(restarted.get("monitoring_settings_v1_backup"), old)
        for key, value in preserved.items():
            self.assertEqual(restarted.get(key), value)
        with restarted.connect() as db:
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM outbox")], outbox)
            serialized = db.execute("SELECT data FROM kv WHERE key=?", (monitoring.KEY,)).fetchone()[0]
        with patch("trading.monitoring.write", side_effect=AssertionError("migration repeated")):
            again = Store(self.store.path)
        self.assertEqual(again.monitoring_settings(), config)
        self.assertEqual(again.get("monitoring_settings_v1_backup"), old)
        with again.connect() as db:
            self.assertEqual(db.execute("SELECT data FROM kv WHERE key=?", (monitoring.KEY,)).fetchone()[0], serialized)

    def test_readonly_legacy_fallback_does_not_write_or_acquire_writer_lock(self):
        old = {"revision": 9, "symbols": {"XAUUSD1": {"monitor": False, "alerts": False}}}
        self.store.put(monitoring.KEY, old)
        with self.store.connect() as writer:
            writer.execute("BEGIN IMMEDIATE")
            with self.store.read_snapshot() as reader:
                config = reader.monitoring_settings()
                self.assertEqual(config["schema_version"], 2)
                self.assertEqual(config["revision"], 9)
                self.assertFalse(config["symbols"]["XAUUSD1"]["monitor_enabled"])
            self.assertTrue(writer.in_transaction)
        self.assertEqual(self.store.get(monitoring.KEY), old)

    def test_failed_migration_rolls_back_backup_and_original_settings(self):
        old = {"revision": 13, "feishu_enabled": False}
        self.store.put(monitoring.KEY, old)
        real_write = monitoring.write
        def fail_after_write(db, config):
            real_write(db, config)
            self.assertTrue(db.in_transaction)
            raise RuntimeError("migration failed")
        with patch("trading.monitoring.write", side_effect=fail_after_write):
            with self.assertRaisesRegex(RuntimeError, "migration failed"):
                Store(self.store.path)
        self.assertEqual(self.store.get(monitoring.KEY), old)
        self.assertIsNone(self.store.get("monitoring_settings_v1_backup"))

    def test_migrated_watch_can_be_disabled_after_catalog_entry_disappears(self):
        self.store.put(monitoring.KEY, {"revision": 3})
        self.store.put("usd1_watch:OLDUSD1", {"enabled": True, "notified": True})
        restarted = Store(self.store.path)
        restarted.set_listing_watch("OLDUSD1", False)
        self.assertEqual(restarted.listing_watch_symbols(), [])
        self.assertNotIn("listing_capacity", restarted.monitoring_settings()["symbols"]["OLDUSD1"]["notification_types"])


class MonitoringV2Tests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.store.save_listing_state(catalog("BTCUSD1", "ETHUSD1", "XAUUSD1"))

    def options(self, symbol="BTCUSD1"):
        return self.store.monitoring_settings()["symbols"][symbol]

    def queue(self, category="new_listing", symbol="BTCUSD1", identity="queued"):
        with self.store.connect() as db:
            db.execute("INSERT INTO outbox(id,message,due_at,category,symbols) VALUES (?,?,0,?,?)",
                       (identity, "unchanged message", category, json.dumps([symbol])))
        return identity

    def test_v2_selection_is_authoritative_over_legacy_global_flags(self):
        self.store.edit_monitoring({kind + "_alerts": False for kind in monitoring.NOTIFICATION_TYPES})
        self.store.edit_monitoring({"notification_types": list(monitoring.NOTIFICATION_TYPES)}, symbol="XAUUSD1")
        config = self.store.monitoring_settings()
        for kind in monitoring.NOTIFICATION_TYPES:
            self.assertFalse(config[kind + "_alerts"])
            self.assertTrue(monitoring.allowed(config, kind, ["XAUUSD1"]))
            self.assertFalse(monitoring.allowed(config, kind, ["BTCUSD1"]))
        # The old per-symbol projection cannot silently override v2 membership.
        config["symbols"]["XAUUSD1"]["alerts"] = False
        self.assertTrue(monitoring.allowed(config, "trade_summary", ["XAUUSD1"]))

    def test_master_monitor_and_discovery_preserve_account_notifications(self):
        self.store.edit_monitoring({"notification_types": list(monitoring.NOTIFICATION_TYPES)}, symbol="XAUUSD1")
        for edit in ({"monitoring_enabled": False}, {"auto_discover": False}):
            self.store.edit_monitoring(edit)
            config = self.store.monitoring_settings()
            self.assertFalse(monitoring.allowed(config, "new_listing", ["XAUUSD1"]))
            self.assertTrue(monitoring.allowed(config, "trade_summary", ["XAUUSD1"]))
            self.assertTrue(monitoring.allowed(config, "position_imbalance", ["XAUUSD1"]))
        self.store.edit_monitoring({"feishu_enabled": False})
        self.assertFalse(monitoring.allowed(self.store.monitoring_settings(), "trade_summary", ["XAUUSD1"]))

    def test_defaults_only_affect_future_symbols_and_explicit_capacity_arms_new_watch(self):
        old = deepcopy(self.options())
        self.store.edit_monitoring({"default_notification_types": ["listing_capacity", "strategy_capacity"],
                                   "auto_monitor_new": False})
        self.assertEqual(self.options(), old)
        self.store.save_listing_state(catalog("BTCUSD1", "ETHUSD1", "XAUUSD1", "NEWUSD1"))
        self.assertEqual(self.options("NEWUSD1")["notification_types"], ["listing_capacity"])
        self.assertFalse(self.options("NEWUSD1")["monitor_enabled"])
        self.assertEqual(self.store.listing_watch_symbols(), ["NEWUSD1"])
        self.assertEqual(self.store.due_notifications(), [])

    def test_legacy_capacity_endpoint_and_v2_types_keep_watch_in_sync(self):
        self.store.set_listing_watch("BTCUSD1", True)
        self.assertIn("listing_capacity", self.options()["notification_types"])
        self.store.edit_monitoring({"notification_types": ["trade_summary"]}, symbol="BTCUSD1")
        self.assertEqual(self.store.listing_watch_symbols(), [])
        self.store.edit_monitoring({"notification_types": ["listing_capacity"]}, symbol="BTCUSD1")
        self.assertEqual(self.store.listing_watch_symbols(), ["BTCUSD1"])
        self.store.set_listing_watch("BTCUSD1", False)
        self.assertEqual(self.options()["notification_types"], [])

    def test_legacy_global_capacity_toggle_only_restores_selected_symbols(self):
        self.store.set_listing_watch("BTCUSD1", True)
        self.store.edit_monitoring({"listing_capacity_alerts": False})
        self.assertNotIn("listing_capacity", self.options()["notification_types"])
        self.store.edit_monitoring({"listing_capacity_alerts": True})
        self.assertIn("listing_capacity", self.options()["notification_types"])
        self.assertNotIn("listing_capacity", self.options("ETHUSD1")["notification_types"])
        self.assertNotIn("listing_capacity", self.store.monitoring_settings()["default_notification_types"])

    def test_invalid_types_and_alias_conflicts_leave_all_state_unchanged(self):
        before = self.store.monitoring_settings()
        for edit in ({"notification_types": None}, {"notification_types": [1]},
                     {"notification_types": "new_listing"}, {"notification_types": ["unknown"]},
                     {"notification_types": ["hourly_summary"]}, {"notification_types": ["new_listing", "new_listing"]},
                     {"notification_types": ["strategy_capacity"]},
                     {"notification_types": [], "alerts": True},
                     {"monitor_enabled": True, "monitor": False}):
            with self.subTest(edit=edit), self.assertRaises(TradingError):
                self.store.edit_monitoring(edit, symbol="BTCUSD1")
            self.assertEqual(self.store.monitoring_settings(), before)
        for edit in ({"auto_discover": True, "discovery_enabled": False}, {"schema_version": 2},
                     {"default_notification_types": [], "new_listing_alerts": False}):
            with self.subTest(edit=edit), self.assertRaises(TradingError):
                self.store.edit_monitoring(edit)
            self.assertEqual(self.store.monitoring_settings(), before)

    def test_empty_symbol_event_is_denied_but_system_categories_remain_separate(self):
        self.store.edit_monitoring({"default_notification_types": []})
        config = self.store.monitoring_settings()
        for kind in monitoring.NOTIFICATION_TYPES:
            self.assertFalse(monitoring.allowed(config, kind, []))
        self.assertTrue(monitoring.allowed(config, "hourly_summary", []))
        self.assertTrue(monitoring.allowed(config, "relay_health", []))

    def test_same_values_and_reordered_types_do_not_change_revision(self):
        self.store.edit_monitoring({"notification_types": ["trade_summary", "new_listing"]}, symbol="BTCUSD1")
        before = self.store.monitoring_settings()
        self.assertEqual(self.store.edit_monitoring({"notification_types": ["new_listing", "trade_summary"]}, symbol="BTCUSD1"), before)
        self.assertEqual(self.store.edit_monitoring({"auto_discover": before["auto_discover"]}), before)

    def test_repeated_legacy_edits_preserve_new_clients_precise_selection(self):
        self.store.edit_monitoring({"notification_types": ["new_listing"]}, symbol="BTCUSD1")
        before = self.store.monitoring_settings()
        self.assertEqual(self.store.edit_monitoring({"alerts": True}, symbol="BTCUSD1"), before)
        self.assertEqual(self.store.edit_monitoring({"trade_summary_alerts": True}), before)
        self.store.edit_monitoring({"listing_capacity_alerts": False})
        self.store.edit_monitoring({"notification_types": ["listing_capacity"]}, symbol="BTCUSD1")
        before = self.store.monitoring_settings()
        self.assertEqual(self.store.set_listing_watch("BTCUSD1", True), before)
        self.store.edit_monitoring({"alerts": True, "monitor": False}, symbol="BTCUSD1")
        self.assertEqual(self.options()["notification_types"], ["listing_capacity"])
        self.assertFalse(self.options()["monitor_enabled"])

    def test_two_instances_preserve_independent_edits(self):
        with ThreadPoolExecutor(2) as pool:
            jobs = [pool.submit(Store(self.store.path).edit_monitoring, changes, symbol="BTCUSD1")
                    for changes in ({"monitor_enabled": False}, {"notification_types": ["trade_summary"]})]
            for job in jobs:
                job.result(timeout=10)
        self.assertFalse(self.options()["monitor_enabled"])
        self.assertEqual(self.options()["notification_types"], ["trade_summary"])

    def test_type_removal_cancels_pending_and_reenable_does_not_replay(self):
        identity = self.queue()
        self.store.notification_result({"id": identity}, False)
        self.store.edit_monitoring({"notification_types": []}, symbol="BTCUSD1")
        self.store.edit_monitoring({"notification_types": ["new_listing"]}, symbol="BTCUSD1")
        self.assertIsNone(self.store.notification_for_delivery(identity))
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT message,expires_at FROM outbox WHERE id=?", (identity,)).fetchone()[:],
                             ("unchanged message", 0))

    def test_type_change_resets_only_its_position_observation(self):
        targets = {symbol: {"symbol": symbol, "candidate": {"count": 3}}
                   for symbol in ("BTCUSD1", "ETHUSD1")}
        self.store.put("position_imbalance_notifications", {"targets": targets})
        self.store.edit_monitoring({"notification_types": ["trade_summary"]}, symbol="BTCUSD1")
        self.assertEqual(self.store.get("position_imbalance_notifications")["targets"],
                         {"ETHUSD1": targets["ETHUSD1"]})

    def test_watch_failure_rolls_back_config_and_outbox_with_connection_scope(self):
        before = self.store.monitoring_settings()
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER fail_watch BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'test'); END")
        with self.store.connection_scope():
            with self.assertRaises(sqlite3.IntegrityError):
                self.store.edit_monitoring({"notification_types": ["listing_capacity"]}, symbol="BTCUSD1")
            self.assertEqual(self.store.monitoring_settings(), before)
            self.assertEqual(self.store.listing_watch_symbols(), [])
        self.assertEqual(self.store.due_notifications(), [])


if __name__ == "__main__":
    unittest.main()

"""ADL reports share the global delivery switch, independent of symbol choices."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from trading import monitoring
from trading.store import Store


class AdlMonitoringTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "trading.sqlite3")

    def queue(self):
        with self.store.connect() as db:
            db.execute("INSERT INTO outbox(id,message,due_at,category,symbols) VALUES (?,?,0,?,?)",
                       ("adl-incident:detected", "ADL report", "adl", json.dumps(["UNLISTEDUSDT"])))

    def test_unknown_and_unmonitored_symbols_ignore_optional_notification_types(self):
        config = self.store.monitoring_settings()
        config.update(monitoring_enabled=False, auto_discover=False, auto_monitor_new=False,
                      default_notification_types=[])
        config["symbols"]["BTCUSDT"] = {"monitor_enabled": False, "notification_types": [], "alerts": False}
        for symbols in ([], ["BTCUSDT"], ["UNKNOWNUSDT"], ["BTCUSDT", "UNKNOWNUSDT"]):
            with self.subTest(symbols=symbols):
                self.assertTrue(monitoring.allowed(config, "adl", symbols))
                muted = deepcopy(config)
                muted["feishu_enabled"] = False
                self.assertFalse(monitoring.allowed(muted, "adl", symbols))
        self.assertNotIn("adl", monitoring.NOTIFICATION_TYPES)

    def test_queue_and_final_delivery_respect_global_switch_and_durable_cancellation(self):
        self.store.edit_monitoring({"monitoring_enabled": False, "auto_discover": False,
                                   "default_notification_types": []})
        self.queue()
        self.assertEqual([item["id"] for item in self.store.due_notifications()], ["adl-incident:detected"])
        self.assertIsNotNone(self.store.notification_for_delivery("adl-incident:detected"))
        self.store.edit_monitoring({"feishu_enabled": False})
        self.assertEqual(self.store.due_notifications(), [])
        self.assertIsNone(self.store.notification_for_delivery("adl-incident:detected"))
        self.store.edit_monitoring({"feishu_enabled": True})
        self.assertIsNone(self.store.notification_for_delivery("adl-incident:detected"))


if __name__ == "__main__":
    unittest.main()

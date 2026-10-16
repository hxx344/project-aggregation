"""Durable, identity-scoped ADL display with no broker construction or HTTP."""
from copy import deepcopy
import hashlib
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests.test_adl_notifications import incident
from tests import test_adl_pair_config as config_cases
from tests.test_pair_integration import pair_config
from trading.adl_view import report_view, status_view
from trading.exchange import LiveBroker


class AdlViewTests(unittest.TestCase):
    setUp = config_cases.AdlPairConfigTests.setUp

    def create(self):
        return self.engine.pairs.create(pair_config())

    def seed_live(self, pair, now=1000):
        for index, aid in enumerate(("test", "second")):
            account = self.f.store.account(aid)
            self.f.store.save_account({**account, "mode": "live"})
            broker = object.__new__(LiveBroker)
            broker.api = SimpleNamespace(credentials={"user": "current-user-" + str(index)})
            self.engine.brokers[aid] = broker
            owner = hashlib.sha256(broker.api.credentials["user"].encode()).hexdigest()[:32]
            self.f.store.put(f"adl_scan:gold:{aid}:{owner}", {"checked_at": now, "windows": [], "error": None})
        return pair

    def save_incident(self, **values):
        item = {**incident(), "pair_id": "gold", "hold": True, **values}
        self.f.store.put("adl_pair:gold", item)
        return item

    def test_inactive_and_waiting_do_not_claim_monitoring_or_create_brokers(self):
        pair = self.create()
        with patch.object(self.engine, "broker", side_effect=AssertionError("display must not construct brokers")):
            view = status_view(self.engine, self.f.store, pair, {}, now=1000)
            self.assertEqual(view["monitoring"]["status"], "inactive")
            for aid in ("test", "second"):
                self.f.store.save_account({**self.f.store.account(aid), "mode": "live"})
            self.engine.brokers.clear()
            with patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "1"}):
                view = status_view(self.engine, self.f.store, pair, {}, now=1000)
                self.assertEqual(view["monitoring"]["status"], "waiting")
            with patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "0"}):
                self.assertEqual(status_view(self.engine, self.f.store, pair, {}, now=1000)["monitoring"]["status"], "inactive")

    def test_only_current_owner_complete_fresh_scans_produce_monitoring(self):
        pair = self.seed_live(self.create())
        with patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "1"}), patch.object(self.engine, "broker", side_effect=AssertionError):
            view = status_view(self.engine, self.f.store, pair, {}, now=1020)
            self.assertEqual(view["monitoring"], {"status": "monitoring", "reason": "两侧 ADL 历史补查已完成", "checked_at": 1000})
            self.assertEqual(status_view(self.engine, self.f.store, pair, {}, now=1121)["monitoring"]["status"], "degraded")
            self.f.store.put("adl_scan:gold:test:old-user-owner", {"checked_at": 1020, "windows": []})
            self.engine.brokers["test"].api.credentials["user"] = "new-user"
            view = status_view(self.engine, self.f.store, pair, {}, now=1020)
            self.assertEqual(view["monitoring"]["status"], "waiting")
            self.assertIsNone(view["monitoring"]["checked_at"])

    def test_error_pending_windows_missing_completion_and_future_time(self):
        pair = self.seed_live(self.create())
        owner = hashlib.sha256(b"current-user-0").hexdigest()[:32]
        for scan, expected in (({"checked_at": 999, "error": "raw private error"}, "degraded"),
                               ({"checked_at": 999, "windows": [[0, 1]]}, "degraded"),
                               ({"attempt_at": 999, "windows": []}, "waiting"),
                               ({"checked_at": 1003, "windows": []}, "degraded")):
            with self.subTest(scan=scan), patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "1"}):
                self.f.store.put(f"adl_scan:gold:test:{owner}", scan)
                view = status_view(self.engine, self.f.store, pair, {}, now=1000)
                self.assertEqual(view["monitoring"]["status"], expected)
                self.assertNotIn("raw private", str(view))

    def test_runtime_adl_is_ignored_and_inactive_retains_durable_incident(self):
        pair = self.create()
        self.f.store.put("pair_runtime:gold", {"adl": {"id": "stale", "status": "active"}})
        view = self.engine.pairs.states()[0]["state"]["adl"]
        self.assertIsNone(view["incident"])
        self.assertFalse(view["report_available"])
        item = self.save_incident(config={"enabled": False, "batch_notional": "25"})
        view = self.engine.pairs.states()[0]["state"]["adl"]
        self.assertEqual(view["monitoring"]["status"], "inactive")
        self.assertEqual(view["incident"]["id"], item["id"])
        self.assertEqual(view["incident"]["config"], item["config"])
        self.assertTrue(view["configuration_locked"])
        self.assertTrue(view["report_available"])
        self.assertFalse(view["pending_event"])

    def test_configuration_lock_includes_pending_events_and_regular_activity(self):
        pair = self.create()
        with self.engine.adl.lock:
            self.engine.adl.queue[("test", 1, "XAUUSD1", 7)] = (None, {"confirmed": True})
        self.assertTrue(status_view(self.engine, self.f.store, pair, {})["configuration_locked"])
        self.assertTrue(status_view(self.engine, self.f.store, pair, {})["pending_event"])
        self.engine.adl.queue.clear()
        self.f.store.put("adl_event:owner:XAUUSD1:7", {"pair_id": "gold", "executed_qty": "1"})
        self.assertTrue(status_view(self.engine, self.f.store, pair, {})["configuration_locked"])
        self.assertTrue(status_view(self.engine, self.f.store, pair, {})["pending_event"])
        self.f.store.put("adl_event:owner:XAUUSD1:7", {"pair_id": "gold", "executed_qty": "1", "handled_qty": "1"})
        for runtime in ({"pending": {}}, {"progress": {"quantities": {"SHORT": "2"}}}):
            self.assertTrue(status_view(self.engine, self.f.store, pair, runtime)["configuration_locked"])
            self.assertFalse(status_view(self.engine, self.f.store, pair, runtime)["pending_event"])
        self.f.store.put("pair_margin:gold", {"status": "unknown"})
        self.assertTrue(status_view(self.engine, self.f.store, pair, {})["configuration_locked"])

    def test_report_whitelist_redacts_private_metadata_and_preserves_unknown_orders(self):
        self.create()
        item = self.save_incident(reason="核对失败 user-private signer-private ASTER_PRIVATE token=top-secret https://private.invalid/signed?q=1",
            identities={"long": {"user": "user-private", "signer": "signer-private", "env_prefix": "ASTER_PRIVATE"}},
            accounts={"test": {"private_key": "hidden-secret"}}, frozen_runtime={"raw_secret": "frozen-secret"})
        item["batches"][0].update(resolution="positions_verified_unknown", error="signature=sign-secret", resolved_at=1010)
        item["batches"][0]["receipt"].update(private_key="raw-receipt-secret")
        self.f.store.put("adl_pair:gold", item)
        before = deepcopy(self.f.store.get("adl_pair:gold"))
        with self.f.store.read_snapshot() as reader:
            report = report_view(reader, "gold", now=1020)
        text = "\n".join(report["messages"])
        for private in ("user-private", "signer-private", "ASTER_PRIVATE", "top-secret", "private.invalid", "hidden-secret",
                        "frozen-secret", "sign-secret", "raw-receipt-secret"):
            self.assertNotIn(private, text)
        self.assertIn("原单成交结果仍未知", text)
        self.assertIn("回报状态：仍未知；累计成交：未知", text)
        self.assertEqual(self.f.store.get("adl_pair:gold"), before)
        self.assertIsNone(report_view(self.f.store, "other"))


if __name__ == "__main__":
    unittest.main()

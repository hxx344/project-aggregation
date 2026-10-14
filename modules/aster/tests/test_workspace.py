"""Workspace integration regressions: isolated stores and mocked transports only."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from tests.helpers import account
from trading.engine import Engine
from trading.exchange import API, LiveBroker, RateBudget, RequestNotSent
from trading.paper import DemoMarket
from trading.margin_balance import MarginBalancer
from trading.pair_execution import PairTrader
from trading.pairing import validate_pair
from trading.server import create_app
from trading.store import Store


SECRET = "workspace-test-private-secret"


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "trading.sqlite3")
        self.engine = Engine(self.store, market=DemoMarket())
        self.addCleanup(self.engine.dashboard_reports.close)
        self.engine.process_lock.acquire()
        self.addCleanup(self.engine.process_lock.release)
        self.engine.thread = SimpleNamespace(is_alive=lambda: True)
        self.engine.workspace.set_maintenance(True)

    def live(self, handler=lambda request: httpx.Response(200, json=[])):
        value = account("live")
        value.update(mode="live", enabled=True)
        self.store.save_account(value)
        credentials = {"user": "test-user", "signer": "test-signer", "private_key": "test-key"}
        api = API(credentials, transport=httpx.MockTransport(handler), budget=RateBudget())
        api.signed_parameters = lambda values: values
        self.addCleanup(api.close)
        broker = LiveBroker(credentials, DemoMarket(), api=api)
        self.engine.brokers[value["id"]] = broker
        patcher = patch("trading.workspace_control.credentials_for", return_value=credentials)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.engine.broker(value)
        return value, broker

    def test_managed_identity_origin_and_login_contract(self):
        app = create_app(self.engine, start_engine=False, workspace_secret=SECRET)
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/state").status_code, 403)
            self.assertEqual(client.get("/__workspace/update-status").status_code, 403)
            client.headers.update({"x-workspace-key": SECRET, "origin": "http://testserver"})
            self.assertTrue(client.get("/api/state").json()["workspaceManaged"])
            for path in ("/api/login", "/api/logout"):
                self.assertEqual(client.post(path, json={"password": "ignored"} if path.endswith("login") else None).status_code, 409)
            self.assertEqual(client.post("/api/accounts", json={}, headers={"origin": "https://attacker.invalid"}).status_code, 403)
            self.assertEqual(client.post("/__workspace/maintenance", json={"active": "false"}).status_code, 422)
            self.assertEqual(client.post("/__workspace/maintenance", json={"active": False}).status_code, 200)
            self.assertTrue(client.get("/__workspace/update-status").json()["busy"])

    def test_maintenance_preserves_configuration_and_resumes(self):
        value = account("paper")
        self.store.save_account(value)
        broker = self.engine.broker(value)
        original = deepcopy(self.store.account("paper"))
        with patch.object(broker, "snapshot", side_effect=AssertionError("new work must not start")):
            self.assertEqual(self.engine.tick_account("paper"), 5)
            self.assertEqual(self.engine.tick_cycle_account(value, broker, None), 5)
            self.assertEqual(self.engine.tick_migration(value, None, broker), 5)
        with self.assertRaises(RequestNotSent):
            broker.set_leverage("XAUUSD1", 10)
        self.assertEqual(self.store.account("paper"), original)
        self.engine.workspace.set_maintenance(False)
        broker.set_leverage("XAUUSD1", 10)
        self.assertEqual(broker.state["leverages"]["XAUUSD1"], 10)
        self.assertEqual(self.store.account("paper"), original)

    def test_fresh_complete_open_orders_do_not_trust_unknown_snapshot(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(200, json=[])
        _, broker = self.live(handler)
        with patch.object(broker, "snapshot", side_effect=AssertionError("snapshot omits external orders")):
            self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].url.path, "/fapi/v3/openOrders")
        self.assertNotIn("symbol", calls[0].url.params)
        # A successful empty read is never reused after the next request fails.
        broker.api.http.close()
        self.assertTrue(self.engine.workspace.update_status()["busy"])

    def test_pending_orders_errors_invalid_versions_and_ownership_block(self):
        _, broker = self.live()
        with patch.object(broker.api, "call", return_value=[{"orderId": 1}]):
            self.assertTrue(self.engine.workspace.update_status()["busy"])
        with patch.object(broker.api, "call", return_value=None):
            self.assertTrue(self.engine.workspace.update_status()["busy"])
        def invalidate(*args, **kwargs):
            broker._snapshot_generation += 1
            return []
        with patch.object(broker.api, "call", side_effect=invalidate):
            self.assertTrue(self.engine.workspace.update_status()["busy"])
        with patch("trading.workspace_control.time.monotonic", side_effect=[1, 32]):
            self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.engine.process_lock.release()
        self.assertTrue(self.engine.workspace.update_status()["busy"])

    def test_status_detects_local_intents_pair_recovery_and_margin(self):
        for aid in ("long", "short"):
            value = account(aid)
            value["enabled"] = False
            self.store.save_account(value)
        self.store.save_pair(validate_pair({"id": "gold", "name": "Pair", "long_account_id": "long",
            "short_account_id": "short"}), create=True)
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        for key, state in (("pair_runtime:gold", {"pending": {"id": "pending"}}),
                           ("pair_runtime:gold", {"recovery_watch": []}),
                           ("pair_margin:gold", {"pending": {"status": "unknown"}})):
            self.store.put(key, state)
            self.assertTrue(self.engine.workspace.update_status()["busy"])
            self.store.put(key, {})
        self.store.put("post_fill_check:long", {"pending": True})
        self.assertTrue(self.engine.workspace.update_status()["busy"])

    def test_pair_and_margin_scheduling_do_not_mutate_enabled_configuration(self):
        for aid in ("long", "short"):
            value = account(aid)
            value["enabled"] = False
            self.store.save_account(value)
        pair = self.store.save_pair(validate_pair({"id": "gold", "name": "Pair", "long_account_id": "long",
            "short_account_id": "short", "enabled": True, "ordinary": {"enabled": True},
            "margin": {"enabled": True, "master_env_prefix": "ASTER_MASTER"}}), create=True)
        trader = PairTrader(self.engine)
        with patch.object(trader, "_read", side_effect=AssertionError("no new pair snapshot during maintenance")):
            state = trader.tick(pair)
            self.assertEqual(state["phase"], "maintenance")
        balancer = MarginBalancer(self.engine)
        with patch.object(balancer, "_plan", side_effect=AssertionError("no new transfer plan during maintenance")):
            self.assertTrue(balancer.tick(pair, {})["blocks_trading"])
        self.assertEqual(self.store.pair("gold"), pair)
        self.assertIsNone(self.store.get("pair_runtime:gold")["pending"])

    def test_running_account_worker_keeps_update_busy(self):
        value = account("paper")
        self.store.save_account(value)
        entered, release = threading.Event(), threading.Event()
        def worker():
            with self.engine.account_lock("paper"):
                entered.set()
                release.wait(3)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(worker)
            self.assertTrue(entered.wait(2))
            self.assertTrue(self.engine.workspace.update_status()["busy"])
            release.set()
            pending.result(timeout=3)

    def test_send_gate_closes_after_signing_and_keeps_existing_reads(self):
        sent = []
        _, broker = self.live(lambda request: sent.append(request) or httpx.Response(200, json=[]))
        self.engine.workspace.set_maintenance(False)
        def sign(values):
            self.engine.workspace.set_maintenance(True)
            return values
        broker.api.signed_parameters = sign
        with self.assertRaises(RequestNotSent):
            broker.api.call("POST", "/fapi/v3/order", signed=True)
        self.assertEqual(sent, [])
        broker.api.call("GET", "/fapi/v3/order", signed=True)
        self.assertEqual(len(sent), 1)

    def test_inflight_admission_and_status_race_fail_closed(self):
        entered, release = threading.Event(), threading.Event()
        def handler(request):
            entered.set()
            release.wait(3)
            return httpx.Response(200, json=[])
        _, broker = self.live(handler)
        self.engine.workspace.set_maintenance(False)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(broker.api.call, "POST", "/fapi/v3/order", signed=True)
            self.assertTrue(entered.wait(2))
            self.engine.workspace.set_maintenance(True)
            self.assertTrue(self.engine.workspace.update_status()["busy"])
            release.set()
            pending.result(timeout=3)
        def changed(*args, **kwargs):
            self.engine.workspace.set_maintenance(False)
            self.engine.workspace.set_maintenance(True)
            return []
        with patch.object(broker.api, "call", side_effect=changed):
            self.assertTrue(self.engine.workspace.update_status()["busy"])


if __name__ == "__main__":
    unittest.main()

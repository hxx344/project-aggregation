"""Authenticated pair-group controls exercise the same origin boundary as accounts."""
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.helpers import Fixture, account, clear_of_utc_midnight
from tests.pair_fixtures import seed_legacy_pending
from tests.test_pair_integration import pair_config
from trading.engine import Engine
from trading.server import create_app


class PairApiTests(unittest.TestCase):
    def setUp(self):
        clear_of_utc_midnight(self)
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.engine = Engine(self.f.store, market=self.f.market)
        with patch.dict(os.environ, {"ASTER_DASHBOARD_PASSWORD": "pair-test-password"}):
            self.app = create_app(self.engine, start_engine=False)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.client.headers["origin"] = str(self.client.base_url).rstrip("/")

    def login(self):
        self.assertEqual(self.client.post("/api/login", json={"password": "pair-test-password"}).status_code, 200)

    def test_authentication_origin_and_strict_config(self):
        self.assertEqual(self.client.get("/api/pairs").status_code, 401)
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 401)
        self.assertEqual(self.client.post("/api/pairs/gold/pause").status_code, 401)
        self.login()
        response = self.client.post("/api/pairs", json=pair_config(), headers={"origin": "https://other.invalid"})
        self.assertEqual(response.status_code, 403)
        for values in ({"symbol": "CLUSD1"}, {"api_secret": "never-store"}, {"margin": {"enabled": "true"}},
                       {"ordinary": {"enabled": True}}, {"ordinary": {"enabled": False}}):
            response = self.client.post("/api/pairs", json=pair_config(**values))
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.f.store.pairs(), [])

    def test_create_edit_pause_and_release_keeps_positions(self):
        self.login()
        response = self.client.post("/api/pairs", json=pair_config())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["pair"]["enabled"])
        self.assertFalse(response.json()["pair"]["ordinary"]["enabled"])
        self.assertEqual(self.client.get("/api/pairs").json()["pairs"][0]["state"]["phase"], "paused")
        self.assertEqual(self.client.get("/api/state").json()["pairs"][0]["id"], "gold")
        revision = self.f.store.pair("gold")["revision"]
        for changes in ({"ordinary": {"enabled": True}}, {"enabled": True}):
            response = self.client.patch("/api/pairs/gold", json=changes)
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.f.store.pair("gold")["revision"], revision)
        response = self.client.patch("/api/pairs/gold", json={"name": "白银配对"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["pair"]["name"], "白银配对")
        self.assertFalse(response.json()["pair"]["ordinary"]["enabled"])
        response = self.client.post("/api/pairs/gold/pause")
        self.assertEqual(response.status_code, 200, response.text)
        broker = self.engine.broker(self.f.store.account("test"))
        broker.state["positions"]["XAUUSD1:LONG"].update(qty="0.25", entry="4412.015")
        broker.save()
        response = self.client.delete("/api/pairs/gold")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.get("/api/pairs").json(), {"pairs": []})
        self.assertEqual(self.engine.broker(self.f.store.account("test")).state["positions"]["XAUUSD1:LONG"]["qty"], "0.25")

    def test_nonzero_or_duplicate_members_are_rejected_without_creating_group(self):
        self.login()
        response = self.client.post("/api/pairs", json=pair_config(short_account_id="test"))
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.f.store.pair("gold"))
        response = self.client.post("/api/pairs", json=pair_config(enabled=True))
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.f.store.pair("gold"))

    def test_start_requires_margin_and_leaves_actual_positions_unadopted(self):
        self.login()
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 200)
        for aid, side, qty in (("test", "LONG", "0.25"), ("second", "SHORT", "0.5")):
            broker = self.engine.broker(self.f.store.account(aid))
            broker.state["positions"]["XAUUSD1:" + side].update(qty=qty, entry="4412.015")
            broker.save()
        response = self.client.post("/api/pairs/gold/enable")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("请先开启保证金平衡", response.text)
        self.assertFalse(self.f.store.pair("gold")["enabled"])
        response = self.client.patch("/api/pairs/gold", json={"margin": {"enabled": True}})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.post("/api/pairs/gold/enable")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["pair"]["enabled"])
        state = self.f.store.get("pair_runtime:gold")
        self.assertEqual(state["phase"], "monitoring")
        self.assertIsNone(state["pending"])
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(self.client.post("/api/pairs/gold/enable").status_code, 409)
        self.assertEqual(self.f.store.get("pair_runtime:gold"), state)

    def test_removed_order_recovery_routes_are_not_served(self):
        endpoints = ("/api/pairs/gold/recovery-check", "/api/pairs/gold/recovery-preview",
                     "/api/pairs/gold/recovery-confirm", "/api/pairs/gold/recovery-skip",
                     "/api/pairs/gold/baseline-preview", "/api/pairs/gold/baseline-confirm",
                     "/api/pairs/gold/reconcile-flat", "/api/pairs/gold/margin-only")
        body = {"token": "a" * 32, "acknowledge_unknown": True}
        self.login()
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 200)
        seed_legacy_pending(self.f.store)
        runtime = self.f.store.get("pair_runtime:gold")
        for endpoint in endpoints:
            with self.subTest(endpoint=endpoint):
                self.assertIn(self.client.post(endpoint, json=body).status_code, (404, 405))
        self.assertEqual(self.f.store.get("pair_runtime:gold"), runtime)

    def test_legacy_pending_orders_block_start_edit_and_release(self):
        self.login()
        self.assertEqual(self.client.post("/api/pairs", json=pair_config(margin={"enabled": True})).status_code, 200)
        runtime = seed_legacy_pending(self.f.store)
        pair = self.f.store.pair("gold")
        for method, path, body in (("post", "/api/pairs/gold/enable", None),
                                   ("patch", "/api/pairs/gold", {"name": "blocked"}),
                                   ("delete", "/api/pairs/gold", None)):
            with self.subTest(method=method, path=path):
                kwargs = {"json": body} if body is not None else {}
                response = getattr(self.client, method)(path, **kwargs)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertIn("旧版本配对开仓", response.text)
        self.assertEqual(self.f.store.pair("gold"), pair)
        self.assertEqual(self.f.store.get("pair_runtime:gold"), runtime)
        self.assertEqual(self.f.store.pair_for_account("test")["id"], "gold")

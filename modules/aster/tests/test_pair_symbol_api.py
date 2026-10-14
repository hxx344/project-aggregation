"""Pair catalogue, immutable identity and silver account binding through the API."""
from copy import deepcopy
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.helpers import Fixture, account
from tests.test_pair_integration import pair_config
from trading.engine import Engine, DEFAULT_POLICY
from trading.models import TradingError
from trading.pair_symbols import supported_symbols_list, validate_symbol
from trading.pairing import validate_pair
from trading.server import create_app


class PairSymbolApiTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.engine = Engine(self.f.store, market=self.f.market)
        with patch.dict(os.environ, {"ASTER_DASHBOARD_PASSWORD": "pair-symbol-test-password"}):
            app = create_app(self.engine, start_engine=False)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.client.headers["origin"] = str(self.client.base_url).rstrip("/")

    def login(self):
        self.assertEqual(self.client.post("/api/login", json={"password": "pair-symbol-test-password"}).status_code, 200)

    def create_silver(self):
        response = self.client.post("/api/pairs", json=pair_config(id="silver", symbol="XAGUSD1"))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["pair"]

    def test_catalogue_requires_auth_and_is_the_backend_allowlist(self):
        self.assertEqual(self.client.get("/api/pairs/supported-symbols").status_code, 401)
        self.login()
        response = self.client.get("/api/pairs/supported-symbols")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"symbols": supported_symbols_list()})
        self.assertEqual([row["symbol"] for row in response.json()["symbols"]], ["XAUUSD1", "XAGUSD1"])
        for symbol in (None, [], {}, "CLUSD1", "xagusd1", "UNKNOWN"):
            with self.subTest(symbol=symbol), self.assertRaises(TradingError):
                validate_symbol(symbol)

    def test_omitted_symbols_keep_gold_and_silver_cycle_inherits_pair(self):
        golden = validate_pair(pair_config())
        self.assertEqual(golden["symbol"], "XAUUSD1")
        self.assertEqual(golden["cycle"]["symbol"], "XAUUSD1")
        self.login()
        silver = self.create_silver()
        self.assertFalse(silver["enabled"])
        self.assertEqual(silver["cycle"]["symbol"], "XAGUSD1")
        self.assertNotIn("XAGUSD1", DEFAULT_POLICY["symbols"])

    def test_api_rejects_conflicting_cycle_and_unknown_symbols(self):
        self.login()
        for values, status in (({"symbol": "BTCUSD1"}, 422),
                               ({"symbol": "XAGUSD1", "cycle": {"symbol": "XAUUSD1"}}, 409),
                               ({"symbol": "XAGUSD1", "cycle": {"symbol": "CLUSD1"}}, 422)):
            response = self.client.post("/api/pairs", json=pair_config(**values))
            self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(self.f.store.pairs(), [])

    def test_symbol_is_immutable_and_partial_cycle_edits_keep_silver(self):
        self.login()
        pair = self.create_silver()
        response = self.client.patch("/api/pairs/silver", json={"symbol": "XAUUSD1"})
        self.assertEqual(response.status_code, 422)
        with self.assertRaises(TradingError):
            self.engine.pairs.configure("silver", {"symbol": "XAUUSD1"})
        self.assertEqual(self.f.store.pair("silver"), pair)
        response = self.client.patch("/api/pairs/silver", json={"cycle": {"hold_seconds": 90}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["pair"]["cycle"]["symbol"], "XAGUSD1")
        response = self.client.patch("/api/pairs/silver", json={"cycle": {"symbol": "XAUUSD1"}})
        self.assertEqual(response.status_code, 409)

    def test_silver_start_adopts_only_silver_positions_and_reconcile_clears_them(self):
        self.login()
        self.create_silver()
        for aid, side, qty in (("test", "LONG", "2"), ("second", "SHORT", "3")):
            broker = self.engine.broker(self.f.store.account(aid))
            broker.state["positions"]["XAGUSD1:" + side].update(qty=qty, entry="30")
            broker.save()
        response = self.client.post("/api/pairs/silver/enable")
        self.assertEqual(response.status_code, 200, response.text)
        runtime = self.f.store.get("pair_runtime:silver")
        self.assertEqual(runtime["owned"], {"LONG": "2", "SHORT": "3"})
        self.assertIn("XAGUSD1", runtime["reason"])
        for snapshot in runtime["snapshots"].values():
            self.assertEqual(set(snapshot["account_capacity"]), {"XAGUSD1"})
            self.assertTrue(all(position["symbol"] == "XAGUSD1" for position in snapshot["positions"]
                                if float(position["qty"])))
        self.client.post("/api/pairs/silver/pause")
        self.assertEqual(self.client.post("/api/pairs/silver/reconcile-flat").status_code, 409)
        for aid in ("test", "second"):
            broker = self.engine.broker(self.f.store.account(aid))
            for position in broker.state["positions"].values():
                position.update(qty="0", entry="0")
            broker.save()
        self.assertEqual(self.client.post("/api/pairs/silver/reconcile-flat").status_code, 200)
        self.assertEqual(self.f.store.get("pair_runtime:silver")["owned"], {"LONG": "0", "SHORT": "0"})

    def test_gold_holdings_block_silver_binding_without_mutating_account(self):
        self.login()
        broker = self.engine.broker(self.f.store.account("test"))
        broker.state["positions"]["XAUUSD1:LONG"].update(qty="1", entry="4000")
        broker.save()
        original = deepcopy(broker.state)
        response = self.client.post("/api/pairs", json=pair_config(id="silver", symbol="XAGUSD1"))
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(broker.state, original)
        self.assertIsNone(self.f.store.pair("silver"))

    def test_single_account_cycle_does_not_gain_silver_permission(self):
        self.login()
        response = self.client.patch("/api/accounts/test", json={"cycle": {"symbol": "XAGUSD1"}})
        self.assertEqual(response.status_code, 422, response.text)

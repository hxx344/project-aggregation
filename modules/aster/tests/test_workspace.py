"""Workspace integration regressions: isolated stores and mocked transports only."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from tests.helpers import account
from tests.test_exchange_hardening import account_responses
from trading.engine import Engine
from trading.exchange import API, AmbiguousOrder, ExchangeError, LiveBroker, RateBudget, RequestNotSent
from trading.execution import Executor
from trading.models import TradingError
from trading.paper import DemoMarket
from trading.margin_balance import MarginBalancer
from trading.pair_execution import PairTrader
from tests.pair_legacy_fixtures import runtime_default
from trading.pair_recovery import require_archived_orders_clear
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

    def archived_pair(self):
        self.requests, self.outcomes, self.inventories = [], {}, {}
        self.reality_responses = {}
        self.before_response = lambda side, request: None
        self.credentials = {
            "ASTER_" + side.upper(): {"user": side + "-user", "signer": side + "-signer", "private_key": "test-key"}
            for side in ("long", "short")}
        patcher = patch("trading.workspace_control.credentials_for", side_effect=lambda prefix: self.credentials[prefix])
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)
        for side in ("long", "short"):
            value = account(side, mode="live")
            value["enabled"] = False
            self.store.save_account(value)
            self.connect_archived_member(self.engine, side)
        pair = self.store.save_pair(validate_pair({"id": "gold", "name": "Pair", "long_account_id": "long",
            "short_account_id": "short", "enabled": False}), create=True)
        with patch.object(self.engine, "live_allowed", return_value=True):
            identities = PairTrader(self.engine)._members(pair)[2]
        legs = [{"key": side, "order": {"symbol": pair["symbol"], "positionSide": side.upper(),
            "side": "BUY" if side == "long" else "SELL", "type": "MARKET", "quantity": "0.2",
            "newClientOrderId": "archived-" + side}} for side in ("long", "short")]
        state = {**runtime_default(), "identities": identities,
            "recovery_watch": {"batches": [{"id": "archived-batch", "symbol": pair["symbol"],
                                           "identities": identities, "legs": legs}]}}
        self.store.put("pair_runtime:gold", state)
        return pair, state

    def connect_archived_member(self, engine, side):
        def handler(request):
            self.requests.append((side, request))
            self.before_response(side, request)
            if request.method != "GET":
                raise AssertionError("update checks must not write to the exchange")
            if request.url.path == "/fapi/v3/openOrders":
                return httpx.Response(200, json=self.inventories.get(side, []))
            if request.url.path in self.reality_responses.get(side, {}):
                return httpx.Response(200, json=self.reality_responses[side][request.url.path])
            if request.url.path != "/fapi/v3/order":
                raise AssertionError("unexpected exchange read")
            outcome = self.outcomes.get(side)
            if isinstance(outcome, Exception):
                raise outcome
            if outcome is None:
                return httpx.Response(400, json={"code": -2013, "msg": "Order does not exist"})
            return httpx.Response(200, json=outcome)
        value = engine.store.account(side)
        credentials = deepcopy(self.credentials[value["env_prefix"]])
        api = API(credentials, transport=httpx.MockTransport(handler), budget=RateBudget())
        api.signed_parameters = lambda values: values
        self.addCleanup(api.close)
        engine.brokers[side] = LiveBroker(credentials, engine.market, api=api)
        return engine.broker(value)

    @staticmethod
    def archived_receipt(side="long", *, status="EXPIRED", quantity="0"):
        return {"symbol": "XAUUSD1", "clientOrderId": "archived-" + side,
            "positionSide": side.upper(), "side": "BUY" if side == "long" else "SELL",
            "type": "MARKET", "status": status, "executedQty": quantity,
            "origQty": "0.2", "avgPrice": "4412.015" if quantity != "0" else "0"}

    def durable_state(self):
        with self.store.connect() as db:
            return tuple(db.iterdump())

    @staticmethod
    def pending_intent(account_id="live", *, kind="pair", terminal=False):
        intent = {"id": "original-intent", "kind": kind, "account_id": account_id,
            "symbol": "XAUUSD1", "leverage": 5, "status": "pending", "created_at": time.time(),
            "baseline": {"LONG": "0", "SHORT": "0"}, "receipts": {}, "repairs": [], "repair_attempts": 0}
        if kind == "leverage":
            intent.update(previous=5, target=10, change_response={"symbol": "XAUUSD1", "leverage": 10})
        else:
            intent["orders"] = [Executor.order("XAUUSD1", side, "BUY" if side == "LONG" else "SELL",
                "0.2", "original-" + side.lower()) for side in ("LONG", "SHORT")]
            if terminal:
                intent["receipts"] = {order["newClientOrderId"]: {**order, "clientOrderId": order["newClientOrderId"],
                    "status": "FILLED", "executedQty": "0.2", "avgPrice": "4412.015"} for order in intent["orders"]}
        return intent

    def pending_transfer(self, pair, status="unknown"):
        self.credentials["ASTER_MASTER"] = {"user": "master-user", "signer": "master-signer", "private_key": "test-key"}
        if pair["margin"]["master_env_prefix"] != "ASTER_MASTER":
            pair = self.store.save_pair({**pair, "margin": {**pair["margin"], "master_env_prefix": "ASTER_MASTER"}})
        members = {side: self.store.account(side) for side in ("long", "short")}
        children = {side: self.credentials[members[side]["env_prefix"]] for side in members}
        pending = {"request_id": "original-transfer", "status": status, "source": "long", "destination": "short",
            "amount": "10", "created_at": time.time(), "identity": MarginBalancer._fingerprint(
                pair, members, children, self.credentials["ASTER_MASTER"])}
        self.store.put("pair_margin:gold", {"pending": pending, "last_transfer": pending})
        return pair, pending

    def restart_engine(self):
        self.engine.process_lock.release()
        reopened = Store(self.store.path)
        restarted = Engine(reopened, market=DemoMarket())
        restarted.process_lock.acquire()
        self.addCleanup(restarted.process_lock.release)
        restarted.thread = SimpleNamespace(is_alive=lambda: True)
        restarted.workspace.set_maintenance(True)
        return reopened, restarted

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
        clock = SimpleNamespace(monotonic=lambda: instant[0])
        instant = [1]
        def expire(*args, **kwargs):
            instant[0] = 32
            return []
        with patch("trading.workspace_control.time", clock), patch.object(broker.api, "call", side_effect=expire):
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

    def test_durable_single_intents_and_post_fill_do_not_block_safe_restart(self):
        requests = []
        self.live(lambda request: requests.append(request) or httpx.Response(200, json=[]))
        for kind, terminal in (("pair", False), ("pair", True), ("leverage", False)):
            with self.subTest(kind=kind, terminal=terminal):
                intent = self.pending_intent(kind=kind, terminal=terminal)
                self.store.save_intent(intent)
                self.store.put("post_fill_check:live", {"symbol": "XAUUSD1", "leverage": 5})
                before = self.durable_state()
                requests.clear()
                result = self.engine.workspace.update_status()
                self.assertFalse(result["busy"], result)
                self.assertEqual(self.durable_state(), before)
                self.assertEqual(self.store.intent("live"), intent)
                self.assertEqual([(request.method, request.url.path) for request in requests],
                                 [("GET", "/fapi/v3/openOrders")])

    def test_legacy_boolean_post_fill_markers_remain_restartable(self):
        self.live()
        for marker in (True, False):
            with self.subTest(marker=marker):
                self.store.put("post_fill_check:live", marker)
                before = self.durable_state()
                self.assertFalse(self.engine.workspace.update_status()["busy"])
                self.assertEqual(self.durable_state(), before)
                self.assertIs(Store(self.store.path).get("post_fill_check:live"), marker)
        self.store.put("post_fill_check:missing", True)
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("不存在", result["reason"])

    def test_pair_unknown_terminal_leverage_and_transfer_records_survive_admission(self):
        pair, original = self.archived_pair()
        pair, _ = self.pending_transfer(pair)
        for kind, terminal in (("ordinary", False), ("ordinary", True), ("leverage", False)):
            with self.subTest(kind=kind, terminal=terminal):
                state = deepcopy(original)
                pending = {"id": "original-pair-batch", "kind": kind, "symbol": pair["symbol"],
                    "identities": state["identities"], "created_at": time.time(), "before": {"LONG": "0", "SHORT": "0"}}
                if kind == "leverage":
                    pending.update(previous_leverage=5, target_leverage=10, results={"long": {"unknown": True}})
                else:
                    pending.update(pair_id=pair["id"], phase="open", quantity="0.2", leverage=5,
                        target={"LONG": "0.2", "SHORT": "0.2"}, repairs=[], repair_attempts=0,
                        legs=[{**leg, "receipt": self.archived_receipt(leg["key"], status="FILLED", quantity="0.2")
                               if terminal else None, "dispatch": "unknown"}
                              for leg in state["recovery_watch"]["batches"][0]["legs"]])
                state["pending"] = pending
                self.store.put("pair_runtime:gold", state)
                for status in ("submitting", "unknown", "accepted", "acknowledged"):
                    self.pending_transfer(pair, status)
                    self.requests.clear()
                    before = self.durable_state()
                    result = self.engine.workspace.update_status()
                    self.assertFalse(result["busy"], result)
                    self.assertEqual(self.durable_state(), before)
                    self.assertEqual(len(self.requests), 2)
                    self.assertTrue(all(request.method == "GET" and request.url.path == "/fapi/v3/openOrders"
                                        for _, request in self.requests))
        runtime, margin = self.store.get("pair_runtime:gold"), self.store.get("pair_margin:gold")
        reopened, restarted = self.restart_engine()
        for side in ("long", "short"):
            self.connect_archived_member(restarted, side)
        before = self.durable_state()
        self.requests.clear()
        self.assertFalse(restarted.workspace.update_status()["busy"])
        self.assertEqual(self.durable_state(), before)
        self.assertEqual(reopened.get("pair_runtime:gold"), runtime)
        self.assertEqual(reopened.get("pair_margin:gold"), margin)
        self.assertTrue(all(request.method == "GET" and request.url.path == "/fapi/v3/openOrders"
                            for _, request in self.requests))

    def test_inactive_pair_history_does_not_bind_update_to_old_credentials(self):
        _, state = self.archived_pair()
        state.pop("recovery_watch")
        self.store.put("pair_runtime:gold", state)
        self.credentials["ASTER_LONG"]["user"] = "new-user"
        self.engine.brokers["long"].api.credentials = deepcopy(self.credentials["ASTER_LONG"])
        before = self.durable_state()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.assertEqual(self.durable_state(), before)
        self.assertEqual(len(self.requests), 2)

    def test_deleted_account_and_pair_history_is_not_an_orphaned_recovery(self):
        _, state = self.archived_pair()
        state.pop("recovery_watch")
        self.store.put("pair_runtime:gold", state)
        self.store.put("pair_margin:gold", {"pending": None, "last_transfer": {"status": "confirmed"}})
        self.store.delete_pair("gold")
        for side, empty in (("long", None), ("short", False)):
            self.store.put("post_fill_check:" + side, empty)
            self.store.delete_account(side)
        before = self.durable_state()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.assertEqual(self.durable_state(), before)
        self.assertEqual(self.requests, [])
        # Deletion proof never exempts a later orphaned active record.
        self.store.put("pair_runtime:gold", {**state, "pending": {"id": "orphan"}})
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.store.put("pair_runtime:gold", state)
        self.store.put("post_fill_check:long", {"symbol": "XAUUSD1"})
        self.assertTrue(self.engine.workspace.update_status()["busy"])

    def test_orphaned_and_malformed_inventory_fails_before_exchange_reads(self):
        requests = []
        self.live(lambda request: requests.append(request) or httpx.Response(200, json=[]))
        for key in ("post_fill_check:missing", "pair_runtime:missing", "pair_margin:missing"):
            with self.subTest(key=key):
                self.store.put(key, {"symbol": "XAUUSD1"})
                result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"])
                self.assertIn("不存在", result["reason"])
                with self.store.connect() as db:
                    db.execute("DELETE FROM kv WHERE key=?", (key,))
        self.store.save_intent(self.pending_intent("missing"))
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("不存在", result["reason"])
        with self.store.connect() as db:
            db.execute("DELETE FROM intents")
        self.store.save_intent(self.pending_intent())
        with self.store.connect() as db:
            db.execute("UPDATE intents SET data='{}'")
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("不一致", result["reason"])
        with self.store.connect() as db:
            db.execute("UPDATE intents SET data='not-json'")
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.assertEqual(requests, [])
        with patch.object(self.store, "read_snapshot", side_effect=OSError("unreadable")):
            result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("读取失败", result["reason"])

    def test_complete_durable_inventory_is_compared_after_exchange_reads(self):
        self.live()
        initial = self.pending_intent()
        self.store.save_intent(initial)
        self.store.put("post_fill_check:live", {"symbol": "XAUUSD1", "leverage": 5})
        broker = self.engine.brokers["live"]
        def change_intent():
            self.store.save_intent({**initial, "last_error": "unknown"})
        def complete_intent():
            self.store.save_intent({**initial, "status": "complete"})
        def add_orphan():
            self.store.save_intent({**self.pending_intent("missing"), "id": "orphan"})
        def change_post_fill():
            self.store.put("post_fill_check:live", {"symbol": "XAUUSD1", "leverage": 10})
        def add_orphan_post_fill():
            self.store.put("post_fill_check:missing", {"symbol": "XAUUSD1"})
        def add_orphan_pair():
            self.store.put("pair_runtime:missing", {})
        def add_orphan_margin():
            self.store.put("pair_margin:missing", {})
        for mutate in (change_intent, complete_intent, add_orphan, change_post_fill,
                       add_orphan_post_fill, add_orphan_pair, add_orphan_margin):
            with self.subTest(mutation=mutate.__name__):
                before = self.durable_state()
                def read(*args, **kwargs):
                    mutate()
                    return []
                with patch.object(broker.api, "call", side_effect=read):
                    result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"], result)
                self.assertIn("发生变化", result["reason"])
                self.assertNotEqual(self.durable_state(), before)
                with self.store.connect() as db:
                    db.execute("DELETE FROM intents")
                    db.execute("DELETE FROM kv WHERE key GLOB 'post_fill_check:*' OR key GLOB 'pair_runtime:*' OR key GLOB 'pair_margin:*'")
                self.store.save_intent(initial)
                self.store.put("post_fill_check:live", {"symbol": "XAUUSD1", "leverage": 5})

    def test_transfer_identity_and_durable_races_still_block(self):
        pair, _ = self.archived_pair()
        pair, original = self.pending_transfer(pair)
        self.store.put("pair_margin:gold", {"pending": {**original, "identity": "wrong-account"}})
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("身份不一致", result["reason"])
        self.assertEqual(self.requests, [])
        self.store.put("pair_margin:gold", {"pending": original})
        def change_margin(side, request):
            if side == "short":
                self.store.put("pair_margin:gold", {"pending": {**original, "status": "accepted"}})
        self.before_response = change_margin
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.store.put("pair_margin:gold", {"pending": original})
        def change_master(side, request):
            if side == "short":
                self.credentials["ASTER_MASTER"]["private_key"] = "replacement-key"
        self.before_response = change_master
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("主账户凭据", result["reason"])

    def test_pair_pending_identity_mismatch_blocks_without_historical_reads(self):
        pair, state = self.archived_pair()
        state["pending"] = {"id": "original-leverage", "kind": "leverage", "symbol": pair["symbol"],
            "identities": deepcopy(state["identities"]), "previous_leverage": 5, "target_leverage": 10,
            "results": {"long": {"unknown": True}}}
        state["pending"]["identities"]["long"]["user"] = "other-user"
        self.store.put("pair_runtime:gold", state)
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("身份不一致", result["reason"])
        self.assertEqual(self.requests, [])

    def test_pending_intent_restart_queries_original_ids_without_resubmission(self):
        requests = []
        def handler(request):
            requests.append(request)
            self.assertEqual(request.method, "GET")
            if request.url.path == "/fapi/v3/openOrders":
                return httpx.Response(200, json=[])
            self.assertEqual(request.url.path, "/fapi/v3/order")
            return httpx.Response(400, json={"code": -2013, "msg": "Order does not exist"})
        value, broker = self.live(handler)
        original = self.pending_intent()
        self.store.save_intent(original)
        post_fill = {"symbol": "XAUUSD1", "leverage": 5}
        self.store.put("post_fill_check:live", post_fill)
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        reopened, restarted = self.restart_engine()
        restarted.brokers["live"] = broker
        restarted.broker(value)
        before = self.durable_state()
        self.assertFalse(restarted.workspace.update_status()["busy"])
        self.assertEqual(self.durable_state(), before)
        self.assertEqual(reopened.intent("live"), original)
        self.assertEqual(reopened.get("post_fill_check:live"), post_fill)
        restarted.workspace.set_maintenance(False)
        requests.clear()
        result = Executor(reopened, broker, restarted.market).reconcile(value)
        self.assertIn("不重复提交", result)
        self.assertEqual({request.url.params["origClientOrderId"] for request in requests},
                         {"original-long", "original-short"})
        self.assertEqual(reopened.intent("live")["status"], "pending")
        self.assertEqual(reopened.intent("live")["orders"], original["orders"])
        self.assertEqual(reopened.get("post_fill_check:live"), post_fill)

    def test_archived_watch_is_preserved_without_historical_reads(self):
        _, original = self.archived_pair()
        for status in (None, "CANCELED", "EXPIRED", "REJECTED"):
            with self.subTest(status=status):
                self.outcomes = {} if status is None else {
                    side: self.archived_receipt(side, status=status) for side in ("long", "short")}
                self.requests.clear()
                before = self.durable_state()
                result = self.engine.workspace.update_status()
                self.assertFalse(result["busy"], result)
                self.assertEqual(result["checkedAccounts"], 2)
                self.assertEqual(self.durable_state(), before)
                self.assertEqual(self.store.get("pair_runtime:gold"), original)
                orders = [(side, request) for side, request in self.requests if request.url.path == "/fapi/v3/order"]
                self.assertEqual(orders, [])
                inventory = [(side, request) for side, request in self.requests if request.url.path.endswith("/openOrders")]
                self.assertEqual({side for side, _ in inventory}, {"long", "short"})
                self.assertEqual(len(self.requests), 2)
                for _, request in self.requests:
                    self.assertEqual(request.method, "GET")
                for _, request in inventory:
                    self.assertNotIn("symbol", request.url.params)

    def test_large_archived_index_and_repair_legs_do_not_block_safe_restart(self):
        _, state = self.archived_pair()
        batch = state["recovery_watch"]["batches"][0]
        batch["legs"].append(deepcopy(batch["legs"][0]))
        batch["legs"][-1]["order"]["newClientOrderId"] = "archived-repair"
        state["recovery_watch"].update(batches=[{**deepcopy(batch), "id": str(index)} for index in range(9)],
            retired_identities=deepcopy(state["identities"]), retired_symbols=["XAUUSD1"])
        self.store.put("pair_runtime:gold", state)
        result = self.engine.workspace.update_status()
        self.assertFalse(result["busy"], result)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.store.get("pair_runtime:gold"), state)
        state["recovery_watch"]["retired_identities"]["long"]["user"] = "other-user"
        self.store.put("pair_runtime:gold", state)
        self.requests.clear()
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.assertEqual(self.requests, [])

    def test_historical_outcomes_do_not_block_restart_or_trigger_recovery(self):
        self.archived_pair()
        cases = {
            "filled": self.archived_receipt(status="FILLED", quantity="0.2"),
            "terminal_partial_fill": self.archived_receipt(status="CANCELED", quantity="0.1"),
            "active_zero": self.archived_receipt(status="NEW"),
            "read_error": ExchangeError("unavailable"),
            "ambiguous_missing": AmbiguousOrder("unknown", code=-2013),
            "rate_limited_missing": ExchangeError("retry", code=-2013, retry_after=30, http_status=400),
            "server_error_missing": ExchangeError("unavailable", code=-2013, http_status=503),
            "wrong_client_id": {**self.archived_receipt(), "clientOrderId": "unrelated"},
            "wrong_quantity": {**self.archived_receipt(), "origQty": "0.3"},
            "invalid_payload": [],
        }
        for label, outcome in cases.items():
            with self.subTest(outcome=label):
                self.outcomes = {"long": outcome}
                self.requests.clear()
                before = self.durable_state()
                self.assertFalse(self.engine.workspace.update_status()["busy"])
                self.assertEqual(len(self.requests), 2)
                self.assertTrue(all(request.url.path == "/fapi/v3/openOrders" for _, request in self.requests))
                self.assertTrue(all(request.method == "GET" for _, request in self.requests))
                self.assertEqual(self.durable_state(), before)

    def test_archived_watch_does_not_authorize_from_display_clear_cache(self):
        self.archived_pair()
        self.engine.pair_watch_diagnostics["gold"] = {"status": "clear"}
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.assertEqual(self.engine.pair_watch_diagnostics["gold"]["status"], "clear")
        self.requests.clear()
        self.outcomes["long"] = self.archived_receipt(status="FILLED", quantity="0.2")
        self.inventories["long"] = [{"orderId": 1}]
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.assertTrue(all(request.url.path == "/fapi/v3/openOrders" for _, request in self.requests))

    def test_clear_archived_watch_still_requires_complete_account_inventory(self):
        self.archived_pair()
        # Even a disabled live account outside this pair belongs to the inventory.
        extra = account("external", mode="live")
        extra["enabled"] = False
        self.store.save_account(extra)
        self.credentials["ASTER_EXTERNAL"] = {"user": "external-user", "signer": "external-signer", "private_key": "test-key"}
        self.connect_archived_member(self.engine, "external")
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        for side, outcome in (("long", [{"orderId": 9, "symbol": "XAGUSD1"}]),
                              ("external", [{"orderId": 10, "symbol": "BTCUSDT"}]), ("short", None)):
            with self.subTest(side=side, outcome=outcome):
                self.inventories = {side: outcome}
                self.requests.clear()
                self.assertTrue(self.engine.workspace.update_status()["busy"])
                inventory = [(aid, request) for aid, request in self.requests if request.url.path.endswith("/openOrders")]
                self.assertIn(side, {aid for aid, _ in inventory})
                self.assertTrue(all("symbol" not in request.url.params for _, request in inventory))

    def test_malformed_watch_or_changed_identity_and_symbol_block_before_order_reads(self):
        _, original = self.archived_pair()
        changes = {
            "empty": lambda state: state.update(recovery_watch={"batches": []}),
            "non_mapping": lambda state: state.update(recovery_watch=[]),
            "bad_legs": lambda state: state["recovery_watch"]["batches"][0].update(legs=[None, None]),
            "identity": lambda state: state["recovery_watch"]["batches"][0]["identities"]["long"].update(user="another-user"),
            "symbol": lambda state: state["recovery_watch"]["batches"][0]["legs"][0]["order"].update(symbol="XAGUSD1"),
        }
        for label, change in changes.items():
            with self.subTest(change=label):
                state = deepcopy(original)
                change(state)
                self.store.put("pair_runtime:gold", state)
                self.requests.clear()
                self.assertTrue(self.engine.workspace.update_status()["busy"])
                self.assertEqual(self.requests, [])

    def test_archived_watch_read_only_mode_preserves_identity_and_execution_gate(self):
        pair, _ = self.archived_pair()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.requests.clear()
        with self.assertRaises(TradingError):
            require_archived_orders_clear(self.engine, pair)
        self.assertEqual(self.requests, [])
        # A read-only caller still cannot combine two aliases of one real account.
        credentials = {**self.credentials["ASTER_SHORT"], "user": "long-user"}
        self.credentials["ASTER_SHORT"] = credentials
        self.engine.brokers["short"].api.credentials = deepcopy(credentials)
        with self.assertRaisesRegex(TradingError, "同一个真实账户"):
            PairTrader(self.engine)._members(pair, read_only=True)
        self.assertTrue(self.engine.workspace.update_status()["busy"])

    def test_watch_query_races_block_on_watch_version_identity_and_broker_changes(self):
        _, original = self.archived_pair()
        broker = self.engine.brokers["long"]
        original_credentials = deepcopy(self.credentials)
        def change_watch():
            state = deepcopy(original)
            state["recovery_watch"]["batches"][0]["legs"][0]["order"]["newClientOrderId"] = "new-watch-order"
            self.store.put("pair_runtime:gold", state)
        def change_version():
            broker._snapshot_generation += 1
        def change_credentials():
            self.credentials["ASTER_LONG"] = {**self.credentials["ASTER_LONG"], "private_key": "replacement-key"}
        def change_broker():
            self.engine.brokers["long"] = object()
        for change in (change_watch, change_version, change_credentials, change_broker):
            with self.subTest(change=change.__name__):
                self.store.put("pair_runtime:gold", original)
                self.credentials = deepcopy(original_credentials)
                self.engine.brokers["long"] = broker
                self.requests.clear()
                def mutate(side, request):
                    if side == "short" and request.url.path == "/fapi/v3/openOrders":
                        change()
                self.before_response = mutate
                self.assertTrue(self.engine.workspace.update_status()["busy"])
                self.assertEqual(len(self.requests), 2)

    def test_complete_order_checks_share_deadline_and_bound_remaining_read_timeout(self):
        self.archived_pair()
        instant = [100]
        clock = SimpleNamespace(monotonic=lambda: instant[0], time=time.time)
        def delay(side, request):
            if request.url.path == "/fapi/v3/openOrders":
                instant[0] = 129 if side == "long" else 131
        self.before_response = delay
        with patch("trading.workspace_control.time", clock), patch("trading.workspace_control.ThreadPoolExecutor",
                side_effect=lambda **kwargs: ThreadPoolExecutor(max_workers=1)):
            result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertEqual(len(self.requests), 2)
        self.assertEqual([request.extensions["timeout"]["read"] for _, request in self.requests], [8, 1])
        self.assertTrue(all(request.url.path == "/fapi/v3/openOrders" for _, request in self.requests))

    def test_final_local_recheck_cannot_outlive_order_evidence_deadline(self):
        self.archived_pair()
        instant = [100]
        clock = SimpleNamespace(monotonic=lambda: instant[0], time=time.time)
        durable_inventory = self.engine.workspace._durable_inventory
        def slow_final_check(accounts, pairs):
            result = durable_inventory(accounts, pairs)
            if len(self.requests) == 2:
                instant[0] = 131
            return result
        with patch("trading.workspace_control.time", clock), \
                patch.object(self.engine.workspace, "_durable_inventory", side_effect=slow_final_check):
            result = self.engine.workspace.update_status()
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(instant[0], 131)
        self.assertTrue(result["busy"])
        self.assertIn("过期", result["reason"])

    def test_update_check_preserves_watch_across_store_and_engine_restart(self):
        pair, original = self.archived_pair()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.engine.process_lock.release()
        reopened = Store(self.store.path)
        restarted = Engine(reopened, market=DemoMarket())
        restarted.process_lock.acquire()
        self.addCleanup(restarted.process_lock.release)
        restarted.thread = SimpleNamespace(is_alive=lambda: True)
        restarted.workspace.set_maintenance(True)
        for side in ("long", "short"):
            self.connect_archived_member(restarted, side)
        self.assertEqual(reopened.get("pair_runtime:gold"), original)
        self.assertEqual(restarted.pair_watch_diagnostics, {})
        self.assertFalse(restarted.workspace.update_status()["busy"])
        self.outcomes["long"] = self.archived_receipt(status="FILLED", quantity="0.2")
        self.assertFalse(restarted.workspace.update_status()["busy"])
        restarted.workspace.set_maintenance(False)
        pair = reopened.save_pair({**pair, "enabled": True})
        for side in ("long", "short"):
            responses = account_responses()
            for path in ("/fapi/v3/accountWithJoinMargin", "/fapi/v3/positionRisk"):
                rows = responses[path]["positions"] if path.endswith("accountWithJoinMargin") else responses[path]
                for row in rows:
                    row.update(positionAmt="0.2" if side == "long" and row["positionSide"] == "LONG" else "0",
                               entryPrice="4412.015", leverage="5")
                    if path.endswith("positionRisk"):
                        row["markPrice"] = "4412.015"
            responses["/fapi/v3/accountWithJoinMargin"]["assets"][0].update(
                crossWalletBalance="10000", availableBalance="9000")
            self.reality_responses[side] = responses
        self.requests.clear()
        with patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "1"}):
            with self.assertRaisesRegex(TradingError, "实际仓位仍不平衡"):
                PairTrader(restarted)._config_guard(pair, original["identities"], opening=True)
            # This is also the guard immediately before a margin transfer is journaled.
            with self.assertRaisesRegex(TradingError, "实际仓位仍不平衡"):
                require_archived_orders_clear(restarted, pair)
        self.assertEqual(reopened.get("pair_runtime:gold"), original)
        self.assertEqual(sum(request.url.path == "/fapi/v3/order" for _, request in self.requests), 4)
        self.assertEqual(sum(request.url.path == "/fapi/v3/openOrders" for _, request in self.requests), 4)
        self.assertTrue(all(request.method == "GET" for _, request in self.requests))

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

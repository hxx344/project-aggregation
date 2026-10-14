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
from trading.engine import Engine
from trading.exchange import API, AmbiguousOrder, ExchangeError, LiveBroker, RateBudget, RequestNotSent
from trading.models import TradingError
from trading.paper import DemoMarket
from trading.margin_balance import MarginBalancer
from trading.pair_execution import PairTrader, runtime_default
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

    def archived_pair(self):
        self.requests, self.outcomes, self.inventories = [], {}, {}
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

    def test_archived_watch_allows_fresh_absence_and_terminal_zero_without_writes(self):
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
                self.assertEqual({(side, request.url.params["origClientOrderId"]) for side, request in orders},
                                 {("long", "archived-long"), ("short", "archived-short")})
                inventory = [(side, request) for side, request in self.requests if request.url.path.endswith("/openOrders")]
                self.assertEqual({side for side, _ in inventory}, {"long", "short"})
                self.assertEqual(len(self.requests), 4)
                for _, request in self.requests:
                    self.assertEqual(request.method, "GET")
                for _, request in inventory:
                    self.assertNotIn("symbol", request.url.params)

    def test_archived_watch_rejects_activity_failed_reads_and_ambiguous_absence(self):
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
                self.assertTrue(self.engine.workspace.update_status()["busy"])
                self.assertTrue(any(request.url.path == "/fapi/v3/order" for _, request in self.requests))
                self.assertTrue(all(request.method == "GET" for _, request in self.requests))
                self.assertEqual(self.durable_state(), before)

    def test_archived_watch_does_not_authorize_from_display_clear_cache(self):
        self.archived_pair()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.assertEqual(self.engine.pair_watch_diagnostics["gold"]["status"], "clear")
        self.requests.clear()
        self.outcomes["long"] = self.archived_receipt(status="FILLED", quantity="0.2")
        self.assertTrue(self.engine.workspace.update_status()["busy"])
        self.assertTrue(any(request.url.params.get("origClientOrderId") == "archived-long"
                            for _, request in self.requests))

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
                    if side == "short" and request.url.path == "/fapi/v3/order":
                        change()
                self.before_response = mutate
                self.assertTrue(self.engine.workspace.update_status()["busy"])
                self.assertTrue(any(request.url.params.get("origClientOrderId") == "archived-short"
                                    for _, request in self.requests))

    def test_archived_checks_share_deadline_and_bound_remaining_read_timeout(self):
        self.archived_pair()
        instant = [100]
        clock = SimpleNamespace(monotonic=lambda: instant[0], time=time.time)
        def delay(side, request):
            if request.url.path == "/fapi/v3/order":
                instant[0] = 129 if side == "long" else 131
        self.before_response = delay
        with patch("trading.workspace_control.time", clock), patch("trading.pair_recovery.time", clock):
            result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertEqual(len(self.requests), 2)
        self.assertEqual([request.extensions["timeout"]["read"] for _, request in self.requests], [8, 1])
        self.assertTrue(all(request.url.path == "/fapi/v3/order" for _, request in self.requests))

    def test_final_local_recheck_cannot_outlive_order_evidence_deadline(self):
        self.archived_pair()
        instant = [100]
        clock = SimpleNamespace(monotonic=lambda: instant[0], time=time.time)
        local_pending = self.engine.workspace._local_pending
        def slow_final_check(accounts, pairs):
            result = local_pending(accounts, pairs)
            if len(self.requests) == 4:
                instant[0] = 131
            return result
        with patch("trading.workspace_control.time", clock), patch("trading.pair_recovery.time", clock), \
                patch.object(self.engine.workspace, "_local_pending", side_effect=slow_final_check):
            result = self.engine.workspace.update_status()
        self.assertEqual(len(self.requests), 4)
        self.assertEqual(instant[0], 131)
        self.assertTrue(result["busy"])
        self.assertIn("过期", result["reason"])

    def test_update_check_preserves_watch_across_store_and_engine_restart(self):
        pair, original = self.archived_pair()
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.engine.process_lock.release()
        reopened = Store(self.store.path)
        restarted = Engine(reopened, market=DemoMarket())
        self.addCleanup(restarted.dashboard_reports.close)
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
        self.assertTrue(restarted.workspace.update_status()["busy"])
        restarted.workspace.set_maintenance(False)
        pair = reopened.save_pair({**pair, "enabled": True})
        self.requests.clear()
        with patch.dict(os.environ, {"ASTER_ALLOW_LIVE": "1"}):
            with self.assertRaisesRegex(TradingError, "成交或活动回执"):
                PairTrader(restarted)._config_guard(pair, original["identities"], opening=True)
            # This is also the guard immediately before a margin transfer is journaled.
            with self.assertRaisesRegex(TradingError, "成交或活动回执"):
                require_archived_orders_clear(restarted, pair)
        self.assertEqual(reopened.get("pair_runtime:gold"), original)
        self.assertEqual(len(self.requests), 2)
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

"""Shared-account integration with mock transports; no exchange traffic."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import importlib.util
import os
import time
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qsl

from eth_account import Account
import httpx

from tests.helpers import account
from trading.engine import Engine
from trading.exchange import API, AmbiguousOrder, LiveBroker, RateBudget, RequestNotSent
from trading.execution import Executor
from trading.models import TradingError
from trading.paper import DemoMarket
from trading.store import Store
from trading.account_writer import ManagedWriter, digest
from trading.pairing import validate_pair
from trading.pair_execution import PairTrader
from tests.pair_legacy_fixtures import empty_progress
from trading.recovery import broker_identity
from trading.margin_balance import MarginBalancer


CORE = Path(__file__).resolve().parents[3] / "server" / "execution" / "account_writer.py"


class AccountWriterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = {"WORKSPACE_MANAGED": "1", "WORKSPACE_WRITER_MODULE": str(CORE),
            "WORKSPACE_WRITER_DB": str(Path(self.directory.name) / "writer.sqlite"), "WORKSPACE_RUNTIME_ID": "aster-test",
            "WORKSPACE_MAINTENANCE": "0", "ASTER_ALLOW_LIVE": "1"}
        self.credentials = {}
        for index, aid in enumerate(("long", "short", "master"), 1):
            key = bytes([index]) * 32
            credentials = {"user": "0x" + str(index) * 40, "signer": Account.from_key(key).address,
                           "private_key": "0x" + key.hex()}
            self.credentials[aid] = credentials
            for field, value in credentials.items():
                self.environment["ASTER_" + aid.upper() + "_" + field.upper()] = value
        self.patcher = patch.dict(os.environ, self.environment)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.store = Store(Path(self.directory.name) / "state.sqlite")
        for aid in ("long", "short"):
            self.store.save_account(account(aid, mode="live"))
        self.engine = Engine(self.store, market=DemoMarket())
        self.addCleanup(self.engine.account_writer.close)
        self.requests = []
        self.fail_write = False
        self.after_send = lambda: None
        self.invalid_identity = False
        self.invalid_order = False
        self.extra_orders = {}
        self.batch_rows = None
        self.order_query = None
        for aid in ("long", "short"):
            def respond(request, aid=aid):
                self.requests.append((aid, request.method, request.url.path))
                if request.method == "GET":
                    if request.url.path == "/fapi/v3/order":
                        if self.order_query is not None:
                            return self.order_query(request.url.params["origClientOrderId"])
                        return httpx.Response(200, json=self.receipt(aid))
                    return httpx.Response(200, json={} if self.invalid_identity else {"assets": [], "positions": []})
                self.after_send()
                if self.fail_write:
                    raise httpx.ReadTimeout("injected", request=request)
                if request.url.path == "/fapi/v3/batchOrders" and self.batch_rows is not None:
                    return httpx.Response(200, json=self.batch_rows)
                params = dict(parse_qsl(request.content.decode()))
                order = self.extra_orders.get(params.get("newClientOrderId"))
                receipt = ({**order, "clientOrderId": order["newClientOrderId"], "orderId": "remote-" + order["newClientOrderId"],
                    "origQty": order["quantity"], "executedQty": order["quantity"], "avgPrice": "100", "status": "FILLED"}
                    if order else self.receipt(aid))
                if self.invalid_order:
                    receipt["side"] = "SELL"
                return httpx.Response(200, json=receipt)
            api = API(self.credentials[aid], transport=httpx.MockTransport(respond), budget=RateBudget())
            api.signed_parameters = lambda params: params
            broker = LiveBroker(self.credentials[aid], self.engine.market, api=api)
            self.engine.brokers[aid] = broker
            self.addCleanup(api.close)
        self.engine.account_writer.initialize()
        self.orders = {aid: Executor.order("XAUUSD1", "LONG", "BUY", 1, aid + "-original") for aid in ("long", "short")}

    def receipt(self, aid):
        order = self.orders[aid]
        return {**order, "clientOrderId": order["newClientOrderId"], "orderId": "remote-" + aid,
                "origQty": "1", "executedQty": "1", "avgPrice": "100", "status": "FILLED"}

    def other_writer(self, identity):
        spec = importlib.util.spec_from_file_location("test_aster_writer_core", CORE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        writer = module.AccountWriter(os.environ["WORKSPACE_WRITER_DB"], "native", "native-test")
        self.addCleanup(writer.close)
        writer.bind("aster", identity, "one")
        return writer

    def test_wallet_is_only_verified_after_authenticated_read(self):
        writer = self.engine.account_writer
        self.assertTrue(writer.ready)
        self.assertEqual(writer.connections["long"]["identity"]["accountId"], self.credentials["long"]["user"])
        self.assertEqual(self.requests, [("long", "GET", "/fapi/v3/accountWithJoinMargin"),
                                         ("short", "GET", "/fapi/v3/accountWithJoinMargin")])

    def test_second_account_conflict_prevents_both_legs(self):
        writer = self.engine.account_writer
        identity = writer.connections["short"]["identity"]
        self.other_writer(identity).claim([identity])
        with self.assertRaises(Exception):
            with writer.accounts(["long", "short"]):
                self.engine.broker(self.store.account("long")).submit([self.orders["long"]])
        self.assertTrue(all(method == "GET" for _, method, _ in self.requests))

    def test_parallel_legs_share_one_prepared_parent_and_complete_account_ticket(self):
        writer = self.engine.account_writer
        with writer.accounts(["long", "short"]) as ticket:
            self.assertEqual(len(ticket["claims"]), 2)
            def send(aid):
                self.assertEqual(len(writer.current.get()["claims"]), 2)
                return self.engine.broker(self.store.account(aid)).submit([self.orders[aid]])
            with writer.batch("aster:test-pair:original", {"orders": list(self.orders.values())}), ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(writer.wrap(send), aid) for aid in ("long", "short")]
                self.assertTrue(all(future.result()[0]["status"] == "FILLED" for future in futures))
            self.assertEqual(writer.registry.unresolved(ticket), [])
        self.assertEqual(sum(method == "POST" for _, method, _ in self.requests), 2)

    def test_unknown_request_is_durable_and_no_new_identity_is_sent(self):
        writer = self.engine.account_writer
        self.fail_write = True
        with writer.accounts(["long"]):
            with self.assertRaises(AmbiguousOrder):
                self.engine.broker(self.store.account("long")).submit([self.orders["long"]])
            self.fail_write = False
            replacement = {**self.orders["long"], "newClientOrderId": "replacement"}
            with self.assertRaises(RequestNotSent):
                self.engine.broker(self.store.account("long")).submit([replacement])
        self.assertEqual(sum(method == "POST" for _, method, _ in self.requests), 1)

    def test_old_response_cannot_commit_to_module_store_after_binding_changes(self):
        writer = self.engine.account_writer
        self.store.put("protected-result", "before")
        self.after_send = lambda: writer.registry.bind("long", writer.connections["long"]["identity"], "rotated")
        with writer.accounts(["long"]):
            with self.assertRaises(Exception):
                self.engine.broker(self.store.account("long")).submit([self.orders["long"]])
            with self.assertRaises(TradingError):
                self.store.put("protected-result", "late")
        self.assertEqual(self.store.get("protected-result"), "before")

    def test_listen_key_remains_available_without_trading_ownership(self):
        api = self.engine.broker(self.store.account("long")).api
        identity = self.engine.account_writer.connections["long"]["identity"]
        self.other_writer(identity).claim([identity])
        api.call("POST", "/fapi/v3/listenKey", signed=True)
        self.assertEqual(self.requests[-1][2], "/fapi/v3/listenKey")
        with self.assertRaises(RequestNotSent):
            self.engine.broker(self.store.account("long")).submit([self.orders["long"]])

    def test_unknown_original_is_only_resolved_after_matching_frozen_order_query(self):
        writer = self.engine.account_writer
        self.store.save_intent({"id": "persisted-original", "kind": "pair", "account_id": "long", "status": "pending",
            "symbol": "XAUUSD1", "orders": [deepcopy(self.orders["long"])], "receipts": {}, "repairs": []})
        with writer.accounts(["long"]) as ticket:
            broker = self.engine.broker(self.store.account("long"))
            self.fail_write = True
            with self.assertRaises(AmbiguousOrder):
                broker.submit([self.orders["long"]])
            self.assertEqual(len(writer.registry.unresolved(ticket)), 1)
            # Wrong quantity cannot settle the durable original operation.
            wrong = {**self.receipt("long"), "origQty": "2"}
            writer.observe_order("long", "XAUUSD1", "long-original", wrong)
            self.assertEqual(len(writer.registry.unresolved(ticket)), 1)
            broker.query("XAUUSD1", "long-original")
            self.assertEqual(writer.registry.unresolved(ticket), [])

    def test_mismatched_success_envelope_remains_unknown(self):
        writer = self.engine.account_writer
        self.invalid_order = True
        with writer.accounts(["long"]) as ticket:
            with self.assertRaises(AmbiguousOrder):
                self.engine.broker(self.store.account("long")).submit([self.orders["long"]])
            self.assertEqual(len(writer.registry.unresolved(ticket)), 1)

    def mixed_batch(self, rejected_row, query):
        """Managed same-account batch: LONG fills, SHORT gets an error-code row."""
        orders = [Executor.order("XAUUSD1", "LONG", "BUY", 1, "mixed-long"),
                  Executor.order("XAUUSD1", "SHORT", "SELL", 1, "mixed-short")]
        filled = {**orders[0], "clientOrderId": "mixed-long", "orderId": "remote-mixed-long", "origQty": "1",
                  "executedQty": "1", "avgPrice": "100", "status": "FILLED"}
        self.batch_rows, self.order_query = [filled, rejected_row], query
        account = self.store.account("long")
        broker = self.engine.broker(account)
        executor = Executor(self.store, broker, self.engine.market)
        intent = {"id": "managed-mixed", "kind": "pair", "account_id": "long", "symbol": "XAUUSD1", "leverage": 5,
                  "status": "pending", "created_at": time.time(), "baseline": {"LONG": "0", "SHORT": "0"},
                  "orders": orders, "receipts": {}, "repairs": [], "repair_attempts": 0}
        self.store.save_intent(intent)
        writer = self.engine.account_writer
        with writer.accounts(["long"]) as ticket:
            executor.send(intent, orders)
            after_send = len(writer.registry.unresolved(ticket))
            # Stop at the existing repair path's position read; reaching it is the point.
            with patch.object(broker, "snapshot", side_effect=TradingError("stop before repair")):
                try:
                    result = executor.reconcile(account, intent)
                except TradingError as exc:
                    result = str(exc)
            unresolved = writer.registry.unresolved(ticket)
        return after_send, result, self.store.intent("long"), unresolved

    def test_managed_partial_batch_rejection_confirms_only_the_unknown_leg(self):
        rejected = {"code": -4164, "msg": "Order's notional must be no smaller than 5."}
        absent = lambda cid: httpx.Response(400, json={"code": -2013, "msg": "Order does not exist."})
        after_send, result, intent, unresolved = self.mixed_batch(rejected, absent)
        # The other leg's fill is kept; only the coded leg is unknown until queried.
        self.assertEqual(after_send, 1)
        self.assertEqual(intent["receipts"]["mixed-long"]["status"], "FILLED")
        short = intent["receipts"]["mixed-short"]
        self.assertEqual((short["status"], short["reject_code"], short["query_absent"]), ("REJECTED", -4164, True))
        self.assertEqual(unresolved, [])
        self.assertEqual(result, "stop before repair")
        self.assertEqual([(m, p) for _, m, p in self.requests if p.endswith("Orders") or p.endswith("/order")],
                         [("POST", "/fapi/v3/batchOrders"), ("GET", "/fapi/v3/order")])

    def test_managed_partial_batch_found_order_counts_as_submitted(self):
        def found(cid):
            order = Executor.order("XAUUSD1", "SHORT", "SELL", 1, cid)
            return httpx.Response(200, json={**order, "clientOrderId": cid, "orderId": "remote-" + cid, "origQty": "1",
                                             "executedQty": "1", "avgPrice": "100", "status": "FILLED"})
        _, result, intent, unresolved = self.mixed_batch({"code": -2022, "msg": "ReduceOnly Order is rejected."}, found)
        self.assertEqual(intent["receipts"]["mixed-short"]["status"], "FILLED")
        self.assertNotIn("query_absent", intent["receipts"]["mixed-short"])
        self.assertEqual(unresolved, [])
        self.assertEqual(result, "stop before repair")

    def assert_leg_stays_unknown(self, row, query):
        _, result, intent, unresolved = self.mixed_batch(row, query)
        self.assertEqual(intent["receipts"]["mixed-long"]["status"], "FILLED")
        self.assertNotIn("mixed-short", intent["receipts"])
        self.assertEqual(len(unresolved), 1)
        self.assertNotEqual(result, "stop before repair")
        self.assertFalse(any(m == "POST" and p == "/fapi/v3/order" for _, m, p in self.requests))

    def test_managed_partial_batch_failed_lookup_stays_unknown(self):
        self.assert_leg_stays_unknown({"code": -4164, "msg": "min notional"}, lambda cid: httpx.Response(503, json={}))

    def test_managed_partial_batch_throttled_lookup_is_not_absence(self):
        self.assert_leg_stays_unknown({"code": -4164, "msg": "min notional"},
            lambda cid: httpx.Response(429, json={"code": -2013, "msg": "Order does not exist."}))

    def test_managed_partial_batch_timeout_row_is_not_rejected_by_absence(self):
        self.assert_leg_stays_unknown({"code": -1007, "msg": "Timeout waiting for response."},
            lambda cid: httpx.Response(400, json={"code": -2013, "msg": "Order does not exist."}))

    def test_managed_partial_batch_unknown_server_error_is_not_rejected_by_absence(self):
        self.assert_leg_stays_unknown({"code": -1000, "msg": "An unknown error occurred."},
            lambda cid: httpx.Response(400, json={"code": -2013, "msg": "Order does not exist."}))

    def test_managed_partial_batch_internal_error_is_not_rejected_by_absence(self):
        self.assert_leg_stays_unknown({"code": -1001, "msg": "Internal error; unable to process your request."},
            lambda cid: httpx.Response(400, json={"code": -2013, "msg": "Order does not exist."}))

    def restart_writer(self):
        self.engine.account_writer.close()
        writer = ManagedWriter(self.engine)
        self.engine.account_writer = self.store.account_writer = writer
        self.addCleanup(writer.close)
        writer.initialize()
        self.assertTrue(writer.ready, writer.error)
        return writer

    def pair(self, *, margin=False):
        for aid in ("long", "short"):
            member = self.store.account(aid)
            member["enabled"] = False
            self.store.save_account(member)
        value = validate_pair({"id": "gold", "name": "gold", "long_account_id": "long", "short_account_id": "short",
            "margin": {"enabled": margin, "master_env_prefix": "ASTER_MASTER" if margin else ""}})
        return self.store.save_pair(value, create=True)

    def terminal_pair(self, pair):
        self.orders["short"] = Executor.order("XAUUSD1", "SHORT", "SELL", 1, "short-original")
        _, _, identities = PairTrader(self.engine)._members(pair)
        legs = [{"key": aid, "order": deepcopy(self.orders[aid]), "receipt": self.receipt(aid), "dispatch": "sending"}
                for aid in ("long", "short")]
        pending = {"id": "crash-pair-original", "kind": "ordinary", "phase": "open", "symbol": "XAUUSD1",
            "identities": identities, "created_at": time.time(), "quantity": "1", "before": {"LONG": "0", "SHORT": "0"},
            "target": {"LONG": "1", "SHORT": "1"}, "leverage": 5, "legs": legs, "repairs": [], "repair_attempts": 0,
            "config": {"symbol": pair["symbol"], "leverage": 5}}
        return {"symbol": "XAUUSD1", "phase": "reconciling", "identities": identities,
            "owned": {"LONG": "0", "SHORT": "0"}, "progress": empty_progress(), "pending": pending, "daily_volume": {}}

    def test_discarded_pair_batch_settles_shared_unknown_operations(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        for leg in state["pending"]["legs"]:
            leg["receipt"] = None
        operation = "aster:pair-orders:" + state["pending"]["id"] + ":long-original:short-original"
        writer = self.engine.account_writer
        leverage = "aster:pair-leverage:" + state["pending"]["id"]
        with writer.accounts(["long", "short"]) as ticket:
            writer.registry.prepare(ticket, operation, {"orders": list(self.orders.values())})
            writer.registry.import_unknown(ticket, leverage, {"leverage": 5})
            self.store.put("pair_runtime:gold", state)
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            unresolved = [row["operationId"] for row in restarted.registry.unresolved(ticket)]
            self.assertIn(operation, unresolved)
            self.assertIn(leverage, unresolved)
            self.assertGreater(len(restarted.registry.unresolved(ticket)), 1)
        self.engine.pairs.discard_legacy_orders()
        archive = self.store.get("pair_discarded_orders:gold")
        self.assertEqual((archive[0]["long_account_id"], archive[0]["short_account_id"]), ("long", "short"))
        # The archive, not the pair row, names the accounts to settle.
        with self.store.connect() as db:
            db.execute("DELETE FROM pair_members WHERE pair_id='gold'")
            db.execute("DELETE FROM pairs WHERE id='gold'")
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])
        self.assertIsNone(self.store.get("pair_runtime:gold")["pending"])
        self.assertTrue(self.store.get("pair_discarded_orders:gold")[0]["writer_settled"])

    def test_crash_after_durable_pair_terminal_receipts_settles_parent_and_legacy(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        operation = "aster:pair-orders:" + state["pending"]["id"] + ":long-original:short-original"
        writer = self.engine.account_writer
        with writer.accounts(["long", "short"]) as ticket:
            writer.registry.prepare(ticket, operation, {"orders": list(self.orders.values())})
            self.store.put("pair_runtime:gold", state)
            self.assertEqual(len(writer.registry.unresolved(ticket)), 1)
        # Stop exactly after the receipt commit and before the parent finish.
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])
        # Settling the shared operation leaves the legacy batch itself for manual review.
        self.assertEqual(self.store.get("pair_runtime:gold")["pending"], state["pending"])
        self.assertTrue(all(method == "GET" and path != "/fapi/v3/order" for _, method, path in self.requests))

    def test_crash_after_durable_single_account_batch_receipts_settles_original_and_legacy(self):
        writer = self.engine.account_writer
        orders = [self.orders["long"], Executor.order("XAUUSD1", "SHORT", "SELL", 1, "same-account-short")]
        receipts = {order["newClientOrderId"]: {**order, "clientOrderId": order["newClientOrderId"],
                    "orderId": "remote-" + order["newClientOrderId"], "origQty": "1", "executedQty": "1",
                    "avgPrice": "100", "status": "FILLED"} for order in orders}
        intent = {"id": "single-crash", "kind": "pair", "account_id": "long", "status": "pending",
            "symbol": "XAUUSD1", "created_at": time.time(), "orders": orders, "receipts": receipts, "repairs": [],
            "bounded_recovery": {"identity": broker_identity(self.store.account("long"), self.engine.broker(self.store.account("long")))}}
        operation = "aster:batchOrders:POST:" + digest([order["newClientOrderId"] for order in orders])
        with writer.accounts(["long"]) as ticket:
            writer.registry.prepare(ticket, operation, {"orders": orders})
            self.store.save_intent(intent)
            self.assertEqual(len(writer.registry.unresolved(ticket)), 1)
        restarted = self.restart_writer()
        with restarted.accounts(["long"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])
        self.assertFalse(any(method != "GET" for _, method, _ in self.requests))

    def test_crash_after_adl_terminal_receipt_settles_original_without_new_queries(self):
        pair = self.pair()
        _, _, identities = PairTrader(self.engine)._members(pair)
        incident = {"id": "adl-crash", "pair_id": "gold", "status": "active", "hold": True, "identities": identities,
            "frozen_runtime": {}, "batches": [{"account_id": "long", "order": self.orders["long"],
                "state": "terminal", "receipt": self.receipt("long")}], "prior_orders": []}
        writer = self.engine.account_writer
        with writer.accounts(["long", "short"]) as ticket:
            writer.registry.prepare(ticket, "aster:order:POST:long-original", {"order": self.orders["long"]})
            self.store.put("adl_pair:gold", incident)
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])

    def test_persisted_transfer_acknowledgement_settles_shared_state_before_balance_refresh(self):
        pair = self.pair(margin=True)
        real_api = API
        def offline_master(credentials=None, **kwargs):
            return real_api(credentials, transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"assets": [], "positions": []})), budget=RateBudget())
        with patch("trading.exchange.API", side_effect=offline_master):
            writer = self.engine.account_writer
            writer.refresh_bindings()
            writer.verify_connection("master:ASTER_MASTER")
            members = {side: self.store.account(side) for side in ("long", "short")}
            created = time.time()
            pending = {"request_id": "transfer-original", "source": "long", "destination": "short", "amount": "1",
                "created_at": created, "status": "acknowledged", "acknowledged_at": created + .01,
                "acknowledgement_code": 200, "identity": MarginBalancer._fingerprint(pair, members,
                    {side: self.credentials[side] for side in members}, self.credentials["master"])}
            with writer.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
                writer.registry.prepare(ticket, "aster:transfer:transfer-original", {"source": "long", "destination": "short", "amount": "1"})
                self.store.put("pair_margin:gold", {"pending": pending})
            restarted = self.restart_writer()
            with restarted.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
                self.assertEqual(restarted.registry.unresolved(ticket), [])
        self.assertFalse(any(method != "GET" for _, method, _ in self.requests))

    def test_persisted_two_repair_dispatch_settles_its_parent_after_restart(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        repairs = []
        for aid, side, direction in (("long", "LONG", "SELL"), ("short", "SHORT", "BUY")):
            order = Executor.order("XAUUSD1", side, direction, 1, "repair-" + aid + "-original")
            self.extra_orders[order["newClientOrderId"]] = order
            receipt = {**order, "clientOrderId": order["newClientOrderId"], "orderId": "remote-" + order["newClientOrderId"],
                       "origQty": "1", "executedQty": "1", "avgPrice": "100", "status": "FILLED"}
            repairs.append({"key": aid, "order": order, "receipt": receipt, "dispatch": "sending"})
        expected = "aster:pair-orders:crash-pair-original:repair-long-original:repair-short-original"
        state["pending"]["repairs"] = repairs
        state["pending"]["writer_dispatches"] = [{"operationId": expected,
            "clientOrderIds": ["repair-long-original", "repair-short-original"]}]
        writer = self.engine.account_writer
        # A legacy version stopped after the durable terminal receipts and before the shared finish.
        with writer.accounts(["long", "short"]) as ticket:
            writer.registry.prepare(ticket, expected, {"orders": [repair["order"] for repair in repairs]})
            self.store.put("pair_runtime:gold", state)
            self.assertEqual([row["operationId"] for row in writer.registry.unresolved(ticket)], [expected])
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])
        self.assertFalse(any(method != "GET" for _, method, _ in self.requests))
        self.assertEqual(self.store.get("pair_runtime:gold")["pending"], state["pending"])

if __name__ == "__main__":
    unittest.main()

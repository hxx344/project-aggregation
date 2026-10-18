"""Shared-account integration with mock transports; no exchange traffic."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import importlib.util
import os
import json
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
from trading.pair_execution import PairTrader, empty_progress
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
        self.addCleanup(self.engine.dashboard_reports.close)
        self.addCleanup(self.engine.account_writer.close)
        self.requests = []
        self.fail_write = False
        self.after_send = lambda: None
        self.invalid_identity = False
        self.invalid_order = False
        self.extra_orders = {}
        for aid in ("long", "short"):
            def respond(request, aid=aid):
                self.requests.append((aid, request.method, request.url.path))
                if request.method == "GET":
                    if request.url.path == "/fapi/v3/order":
                        return httpx.Response(200, json=self.receipt(aid))
                    return httpx.Response(200, json={} if self.invalid_identity else {"assets": [], "positions": []})
                self.after_send()
                if self.fail_write:
                    raise httpx.ReadTimeout("injected", request=request)
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
            "cycle": {"enabled": False}, "ordinary": {"enabled": True},
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
            "config": {**pair["cycle"], "leverage": 5}}
        return {"symbol": "XAUUSD1", "phase": "reconciling", "identities": identities,
            "owned": {"LONG": "0", "SHORT": "0"}, "progress": empty_progress(), "pending": pending, "daily_volume": {}}

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
            self.assertTrue(PairTrader(self.engine)._query(pair, self.store.get("pair_runtime:gold"), self.engine.brokers))
        self.assertTrue(all(method == "GET" and path != "/fapi/v3/order" for _, method, path in self.requests))

    def test_manual_recovery_fresh_queries_have_complete_account_context(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        for leg in state["pending"]["legs"]:
            leg["receipt"] = None
        self.store.put("pair_runtime:gold", state)
        writer = self.engine.account_writer
        with writer.accounts(["long", "short"]) as ticket:
            writer.registry.import_unknown(ticket, "aster:legacy:pair_runtime:gold:crash-pair-original", {"original": "frozen"})
        def original_id_reads(trader, current_pair, current, brokers, **kwargs):
            self.assertEqual(len(writer.current.get()["claims"]), 2)
            for aid in ("long", "short"):
                brokers[aid].query("XAUUSD1", aid + "-original")
            raise TradingError("stop after strict original queries")
        with patch.object(PairTrader, "_recover", original_id_reads):
            self.engine.pairs.check_recovery("gold")
        with writer.accounts(["long", "short"]) as ticket:
            self.assertEqual(writer.registry.unresolved(ticket), [])
        self.assertFalse(any(method != "GET" for _, method, _ in self.requests))

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

    def test_real_two_repair_dispatch_recovers_its_persisted_parent_after_finish_crash(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        repairs = []
        for aid, side, direction in (("long", "LONG", "SELL"), ("short", "SHORT", "BUY")):
            order = Executor.order("XAUUSD1", side, direction, 1, "repair-" + aid + "-original")
            self.extra_orders[order["newClientOrderId"]] = order
            repairs.append({"key": aid, "order": order, "receipt": None, "dispatch": "prepared"})
        state["pending"]["repairs"] = repairs
        self.store.put("pair_runtime:gold", state)
        writer = self.engine.account_writer
        class FinishCrash(RuntimeError):
            pass
        with writer.accounts(["long", "short"]) as ticket:
            with patch.object(writer.registry, "finish", side_effect=FinishCrash("after durable terminal, before shared finish")):
                with self.assertRaises(FinishCrash):
                    PairTrader(self.engine)._dispatch(pair, state, self.engine.brokers, repairs, reconciliation=True)
            saved = self.store.get("pair_runtime:gold")["pending"]
            expected = "aster:pair-orders:crash-pair-original:repair-long-original:repair-short-original"
            self.assertEqual(saved["writer_dispatches"], [{"operationId": expected,
                "clientOrderIds": ["repair-long-original", "repair-short-original"]}])
            self.assertTrue(all(leg["receipt"]["status"] == "FILLED" for leg in saved["repairs"]))
            self.assertEqual([row["operationId"] for row in writer.registry.unresolved(ticket)], [expected])
        writes = sum(method != "GET" for _, method, _ in self.requests)
        self.assertEqual(writes, 2)
        restarted = self.restart_writer()
        with restarted.accounts(["long", "short"]) as ticket:
            self.assertEqual(restarted.registry.unresolved(ticket), [])
        self.assertEqual(sum(method != "GET" for _, method, _ in self.requests), writes)

    def test_managed_dispatch_without_original_batch_id_still_rejects_before_transport(self):
        pair = self.pair()
        state = self.terminal_pair(pair)
        state["pending"].pop("id")
        writer = self.engine.account_writer
        before = list(self.requests)
        with writer.accounts(["long", "short"]) as ticket:
            with self.assertRaisesRegex(TradingError, "原批次"):
                PairTrader(self.engine)._dispatch(pair, state, self.engine.brokers, state["pending"]["legs"])
            self.assertEqual(writer.registry.unresolved(ticket), [])
        self.assertEqual(self.requests, before)
        self.assertNotIn("writer_dispatches", state["pending"])


if __name__ == "__main__":
    unittest.main()

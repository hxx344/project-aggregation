"""Margin transfers through the real managed writer and HTTPX dispatch hooks."""
from contextlib import closing, contextmanager, nullcontext
from copy import deepcopy
import inspect
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qsl

from eth_account import Account
import httpx

from tests.helpers import account
from trading import margin_balance
from trading.account_writer import ManagedWriter
from trading.exchange import API, BudgetWait, LiveBroker, RateBudget, RequestNotSent, TransferRejected
from trading.margin_balance import MarginBalancer, TransferAPI
from trading.models import AccountSnapshot, TradingError, positive
from trading.pairing import PairManager, validate_pair
from trading.paper import DemoMarket
from trading.store import Store
from trading.workspace_control import WorkspaceControl


CORE = Path(__file__).resolve().parents[3] / "server" / "execution" / "account_writer.py"


def valid_unsettled_f30b4aa(record):
    """Frozen rollback validator from f30b4aa:modules/aster/trading/margin_balance.py.

    _valid_unsettled and _identifier are copied with the old bounds/types
    inlined, so changes to the current validator cannot make this test pass.
    """
    def identifier(value):
        if type(value) is int and value > 0:
            return str(value)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value):
            return value
        return None

    if not (isinstance(record, dict) and identifier(record.get("request_id"))
            and {record.get("source"), record.get("destination")} == {"long", "short"}
            and isinstance(record.get("identity"), str)
            and type(record.get("created_at")) in (int, float) and math.isfinite(record["created_at"])
            and record["created_at"] > 0
            and type(record.get("failures")) is int and 0 <= record["failures"] <= 3
            and type(record.get("empty")) is int and 0 <= record["empty"] <= 2
            and ("queried_at" not in record or type(record["queried_at"]) in (int, float)
                 and math.isfinite(record["queried_at"]))
            and isinstance(record.get("before_receipts", {}), dict)
            and (record.get("transaction_id") is None or identifier(record["transaction_id"]))):
        return False
    evidence = record.get("evidence", [])
    if not (isinstance(evidence, list) and len(evidence) <= 20
            and all(isinstance(item, list) and len(item) == 3 and item[0] in ("long", "short")
                    and item[1] in frozenset({"TRANSFER", "SUBUSER_ASSET_TRANSFER"})
                    and identifier(item[2]) == item[2] for item in evidence)
            and not (evidence and record["empty"])):
        return False
    try:
        positive(record.get("amount"))
    except TradingError:
        return False
    return True


class ManagedMarginTransferTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        environment = {"WORKSPACE_MANAGED": "1", "WORKSPACE_WRITER_MODULE": str(CORE),
            "WORKSPACE_WRITER_DB": str(Path(directory.name) / "writer.sqlite"),
            "WORKSPACE_RUNTIME_ID": "managed-margin-test", "WORKSPACE_MAINTENANCE": "0", "ASTER_ALLOW_LIVE": "1"}
        self.credentials = {}
        for index, aid in enumerate(("long", "short", "master"), 1):
            key = bytes([index]) * 32  # Deterministic public test keys only.
            credentials = {"user": "0x" + str(index) * 40, "signer": Account.from_key(key).address,
                           "private_key": "0x" + key.hex()}
            self.credentials[aid] = credentials
            for field, value in credentials.items():
                environment["ASTER_" + aid.upper() + "_" + field.upper()] = value
        patcher = patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = Store(Path(directory.name) / "state.sqlite")
        self.members = {aid: account(aid, mode="live") for aid in ("long", "short")}
        for member in self.members.values():
            member["enabled"] = False
            self.store.save_account(member)
        self.pair = self.store.save_pair(validate_pair({"id": "gold", "name": "gold", "enabled": True,
            "long_account_id": "long", "short_account_id": "short", "ordinary": {"enabled": False},
            "margin": {"enabled": True, "master_env_prefix": "ASTER_MASTER"}}), create=True)
        self.requests = []
        self.request_queries = []
        self.fail_dispatch = False
        self.reject_code = None
        self.income_rows = {}
        self.income_error = False
        self.income_handler = None
        # Pre-send receipt snapshots (bounded wall-clock wait) are recorded apart from
        # settlement reads and answer from what was visible before sending.
        self.snapshot_requests = []
        self.snapshot_rows = {}
        self.snapshot_handler = None
        self.api_instances = []
        self.balances = {"long": "3000", "short": "1000", "master": "0"}
        self.engine = SimpleNamespace(store=self.store, market=DemoMarket(), brokers={},
            live_allowed=lambda member: True, shutdown=threading.Event(), scheduler_event=threading.Event())
        self.engine.workspace = WorkspaceControl(self.engine)
        self.engine.broker = lambda member: self.engine.brokers[member["id"]]
        for aid in self.members:
            self.engine.brokers[aid] = self.engine.workspace.bind(LiveBroker(self.credentials[aid], self.engine.market,
                api=self.api(self.credentials[aid])))
        # Keep the real API, signer, request hooks and shared SQLite registry.
        # Only the external transport is replaced; no account admission is faked.
        for target, factory in (("trading.exchange.API", self.api), ("trading.margin_balance.API", self.api),
                                ("trading.margin_balance.TransferAPI", self.transfer_api)):
            patcher = patch(target, factory)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.writer = ManagedWriter(self.engine)
        self.engine.account_writer = self.store.account_writer = self.writer
        self.addCleanup(self.writer.close)
        self.writer.initialize()
        self.assertTrue(self.writer.ready, self.writer.error)
        self.assertEqual(set(self.writer.connections), {"long", "short", "master:ASTER_MASTER"})
        self.assertTrue(all(row["identity"] for row in self.writer.connections.values()))
        self.balancer = MarginBalancer(self.engine)

    def api(self, credentials=None, transport=None, budget=None, *, before_submit=None, transfer=False):
        aid = next(aid for aid, value in self.credentials.items() if value["user"] == credentials["user"])

        def respond(request):
            if (request.method == "GET" and request.url.path.endswith("/income")
                    and request.extensions.get("timeout", {}).get("read") == margin_balance.TRANSFER_SNAPSHOT_TIMEOUT_SECONDS):
                params = dict(parse_qsl(request.url.query.decode()))
                self.snapshot_requests.append((aid, params))
                if self.snapshot_handler is not None:
                    return self.snapshot_handler(aid, params, request)
                return httpx.Response(200, json=self.snapshot_rows.get(aid, []))
            self.requests.append((aid, request.method, request.url.path))
            self.request_queries.append(request.url.query.decode())
            if request.method == "GET" and request.url.path.endswith("/accountWithJoinMargin"):
                wallet = self.balances[aid]
                return httpx.Response(200, json={"accountId": {"long": 10, "short": 20, "master": 1}[aid],
                    "canTrade": True, "assets": [{"asset": "USD1", "marginBalance": wallet,
                        "availableBalance": wallet, "maxWithdrawAmount": wallet, "walletBalance": wallet,
                        "crossWalletBalance": wallet, "crossUnPnl": "0", "maintMargin": "0"}], "positions": []})
            if request.method == "GET" and request.url.path.endswith("/getSubAccountList"):
                return httpx.Response(200, json=[{"accountId": 1, "parentAccount": True},
                    {"accountId": 10, "parentAccount": False, "sourceAddr": self.credentials["long"]["user"]},
                    {"accountId": 20, "parentAccount": False, "sourceAddr": self.credentials["short"]["user"]}])
            if request.method == "GET" and request.url.path.endswith("/income"):
                if self.income_error:
                    raise httpx.ConnectError("injected income failure", request=request)
                if self.income_handler is not None:
                    return self.income_handler(aid, dict(parse_qsl(request.url.query.decode())), request)
                return httpx.Response(200, json=self.income_rows.get(aid, []))
            if request.method == "POST" and request.url.path.endswith("/subAccountTransfer"):
                if self.fail_dispatch:
                    raise httpx.ReadTimeout("injected after dispatch", request=request)
                if self.reject_code is not None:
                    return httpx.Response(400, json={"code": self.reject_code, "msg": "injected exchange rejection"})
                params = dict(parse_qsl(request.content.decode()))
                self.assertEqual(params["amount"], "1000.00000000")
                self.balances.update(long="2000", short="2000")
                return httpx.Response(200, json={"code": 200, "msg": "success", "tranId": "transfer-123"})
            raise AssertionError((aid, request.method, request.url.path))

        cls = TransferAPI if transfer else API
        extra = {"before_submit": before_submit} if transfer else {}
        api = cls(credentials, transport=httpx.MockTransport(respond), budget=budget or RateBudget(), **extra)
        self.api_instances.append(api)
        self.addCleanup(api.close)
        return api

    def transfer_api(self, credentials=None, transport=None, budget=None, *, before_submit=None):
        return self.api(credentials, transport, budget, before_submit=before_submit, transfer=True)

    def snapshots(self):
        return {aid: broker.transfer_snapshot() for aid, broker in self.engine.brokers.items()}

    def state(self):
        return self.store.get("pair_margin:gold", {})

    def posts(self):
        return [request for request in self.requests if request[1] == "POST"]

    def unresolved(self):
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
            return self.writer.registry.unresolved(ticket)

    def shared_operations(self):
        with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
            return [{"operation_id": row[0], "body_hash": row[1], "state": row[2]} for row in db.execute(
                "SELECT operation_id,body_hash,state FROM aw_operations ORDER BY operation_id")]

    def restart_writer(self):
        self.writer.close()
        self.writer = ManagedWriter(self.engine)
        self.engine.account_writer = self.store.account_writer = self.writer
        self.addCleanup(self.writer.close)
        self.writer.initialize()
        return self.writer

    def veto_next_send(self):
        original = margin_balance.TransferAPI
        vetoed = False

        def make(*args, before_submit, **kwargs):
            def veto_once():
                nonlocal vetoed
                if not vetoed:
                    vetoed = True
                    raise RequestNotSent("injected local veto")
                return before_submit()
            return original(*args, before_submit=veto_once, **kwargs)

        return patch("trading.margin_balance.TransferAPI", side_effect=make)

    def unsettled_rejection(self):
        with self.veto_next_send(), \
                patch.object(self.writer.registry, "finish", side_effect=RuntimeError("shared finish unavailable")), \
                patch.object(self.writer, "settle_transfer", side_effect=RuntimeError("shared settlement unavailable")):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.posts(), [], result)
        state = self.state()
        self.assertIsNone(state.get("pending"), result)
        self.assertEqual(state["last_transfer"]["status"], "rejected")
        evidence = state["last_transfer"]["writer_rejection"]
        self.assertEqual(set(evidence), {"schema_version", "operation_id", "body_hash", "request_sent", "settled"})
        self.assertEqual(evidence["schema_version"], 1)
        self.assertIs(evidence["request_sent"], False)
        self.assertIs(evidence["settled"], False)
        self.assertEqual(evidence["operation_id"], "aster:transfer:" + state["last_transfer"]["request_id"])
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "sending"}])
        return state

    def pair_manager(self):
        locks = {aid: threading.RLock() for aid in self.members}
        self.engine.lock = threading.RLock()
        self.engine.registration_lock = threading.RLock()
        self.engine.accounts_generation = 0
        self.engine.account_lock = lambda aid: locks[aid]
        self.engine.revoke_account_reads = lambda *args: None
        self.engine.adl = SimpleNamespace(require_clear=lambda *args, **kwargs: None)
        self.engine.demo = False
        self.engine.pairs = PairManager(self.engine)
        return self.engine.pairs

    def test_normal_managed_transfer_reaches_transport_once(self):
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.posts(), [("master", "POST", "/fapi/v3/subAccountTransfer")], result)
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertIsNone(self.state().get("pending"))
        self.assertEqual(self.unresolved(), [])

    def test_shared_unknown_rejects_new_transfer_without_an_unknown_private_request(self):
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
            operation = self.writer.registry.prepare(ticket, "aster:original-blocker", {"original": "unknown"})
            self.writer.registry.finish(operation, "unknown")
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.posts(), [], result)
        self.assertEqual(result["status"], "rejected", result)
        self.assertIsNone(self.state().get("pending"), result)
        self.assertEqual(self.state()["last_transfer"]["status"], "rejected")
        self.assertEqual([row["operationId"] for row in self.unresolved()], ["aster:original-blocker"])
        self.assertEqual(self.state()["last_transfer"].get("write_admission"),
                         {"code": "ACCOUNT_UNRESOLVED", "phase": "before_send"})
        self.assertIsInstance(result.get("error"), str, result)
        self.assertIn("ACCOUNT_UNRESOLVED", result["error"])
        self.assertIn("ACCOUNT_UNRESOLVED", result["reason"])

    def test_before_submit_rejection_does_not_poison_shared_transfer(self):
        with self.veto_next_send():
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.posts(), [], result)
        self.assertEqual(result["status"], "rejected", result)
        self.assertIsNone(self.state().get("pending"), result)
        self.assertEqual(self.unresolved(), [])
        self.assertIsInstance(result.get("error"), str, result)
        self.assertTrue(result["error"], result)
        state = self.state()
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(self.posts(), [("master", "POST", "/fapi/v3/subAccountTransfer")])
        self.assertIsNone(self.state().get("pending"), result)
        self.assertEqual(self.unresolved(), [])

    def test_untyped_batch_failure_keeps_the_original_shared_operation_unknown(self):
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            with self.assertRaisesRegex(RuntimeError, "local preflight"):
                with self.writer.batch("aster:transfer:local-preflight", {"amount": "1000"}):
                    raise RuntimeError("local preflight")
        self.assertEqual(self.posts(), [])
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [("aster:transfer:local-preflight", "unknown")])

    def test_local_rejection_after_one_dispatched_request_cannot_release_the_batch(self):
        transfer = self.transfer_api(self.credentials["master"])
        self.writer.bind_api(transfer, "master:ASTER_MASTER")
        params = {"fromAccountAddress": self.credentials["long"]["user"],
            "toAccountAddress": self.credentials["short"]["user"], "asset": "USD1",
            "amount": "1000.00000000", "kindType": "FUTURE_FUTURE"}
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            with self.assertRaises(RequestNotSent):
                with self.writer.batch("aster:transfer:partially-dispatched", params):
                    transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
                    raise RequestNotSent("injected later request veto")
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [("aster:transfer:partially-dispatched", "unknown")])

    def test_dispatched_timeout_remains_unresolved_after_balances_change(self):
        self.fail_dispatch = True
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1, result)
        self.assertEqual(result["status"], "unknown", result)
        pending = self.state()["pending"]
        operation_id = "aster:transfer:" + pending["request_id"]
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [(operation_id, "unknown")])
        # Independent activity can produce the expected balance delta; it is
        # not a receipt for the timed-out original HTTP request.
        self.balances.update(long="2000", short="2000")
        self.fail_dispatch = False
        state = self.state()
        state["next_check_at"] = 0
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1, result)
        self.assertNotIn(result["status"], {"confirmed", "acknowledged"}, result)
        self.assertNotIn(self.state()["last_transfer"]["status"], {"confirmed", "acknowledged"})
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [(operation_id, "unknown")])
        # A second evaluation with a fresh imbalance must still never resend
        # or settle the original shared operation based on an empty history.
        self.balances.update(long="3000", short="1000")
        state = self.state()
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1, result)
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [(operation_id, "unknown")])

    def income_queries(self):
        return [request for request in self.requests if request[2].endswith("/income")]

    def skip_timed_out_transfer(self):
        """Time out one dispatch, then let the next check archive it with new balances."""
        self.fail_dispatch = True
        self.balancer.tick(self.pair, self.snapshots())
        self.fail_dispatch = False
        operation_id = "aster:transfer:" + self.state()["pending"]["request_id"]
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()], [(operation_id, "unknown")])
        return operation_id

    def due(self, age=0, *, shared=True, skipped=True):
        """Make the next check due and move the follow-up's and shared rows' clocks back by ``age`` seconds."""
        state = self.state()
        for record in state.get("unsettled_transfers", []):
            for field in ("created_at",) + (("skipped_at",) if skipped else ()):
                if field in record:
                    record[field] -= age
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        if shared and age:
            with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
                db.execute("UPDATE aw_operations SET created_at=created_at-?,updated_at=updated_at-? WHERE state IN ('sending','unknown')",
                           (int(age * 1000), int(age * 1000)))
                db.commit()
        self.balancer._swept_at.clear()

    def shared_state(self, operation_id):
        return next(row["state"] for row in self.shared_operations() if row["operation_id"] == operation_id)

    def receipt(self, tran_id):
        created = self.state()["unsettled_transfers"][0]["created_at"]
        return {"asset": "USD1", "incomeType": "TRANSFER", "tranId": tran_id,
                "time": int(created * 1000) + 5000}

    def settlement(self, operation_id):
        request_id = operation_id.rsplit(":", 1)[1]
        return self.store.get("pair_margin_skipped:gold:" + request_id)["settlement"]

    def assert_new_transfer_after_cooldown(self):
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 2, result)
        self.assertEqual(self.unresolved(), [])

    def test_skipped_unknown_is_rejected_once_the_original_expired(self):
        operation_id = self.skip_timed_out_transfer()
        # The skip leaves a cooldown and next check; the pending settlement wins.
        self.assertGreater(self.state()["cooldown_until"], margin_balance.time.time())
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertIn("过期", result["reason"])
        shown = margin_balance.MarginBalancer.status_view(self.pair, self.state(), result)
        self.assertEqual(shown["reason"], result["reason"])
        shown = margin_balance.MarginBalancer.status_view(self.pair, self.state())
        self.assertEqual((shown["status"], shown["blocks_trading"]), ("unknown", True), shown)
        self.assertNotIn("人工", shown["reason"])
        # Expiry runs from the shared row's last update, not the local record.
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1, shared=False)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((len(self.posts()), self.income_queries(), result["status"]), (1, [], "unknown"), result)
        self.assertEqual(self.shared_state(operation_id), "unknown")
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS - 5)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((self.income_queries(), result["status"]), ([], "unknown"), result)
        # Expired: one read labels it, then the shared write is settled.
        self.restart_writer()
        self.due(5)
        created = self.state()["unsettled_transfers"][0]["created_at"]
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "rejected")
        self.assertEqual(len(self.income_queries()), 2)
        # The label window starts before the local send time to absorb skew.
        self.assertIn("startTime=" + str(int((created - margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS) * 1000)),
                      self.request_queries[self.requests.index(self.income_queries()[-1])])
        # The settling check does not also plan a new transfer.
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)
        self.assertFalse(result["blocks_trading"], result)
        self.assertIn("过有效期", result["reason"])
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual(self.settlement(operation_id), {"outcome": "rejected", "by": "expiry",
            "basis": "nonce_expired_no_receipt", "note": "两侧流水均无该笔划转",
            "settled_at": self.settlement(operation_id)["settled_at"]})
        # Without a receipt the ordinary cooldown applies.
        self.assertLessEqual(self.state()["cooldown_until"] - margin_balance.time.time(),
                             margin_balance.TRANSFER_SETTLE_COOLDOWN_SECONDS)
        self.assertNotIn("迟到", result["reason"])
        self.assert_new_transfer_after_cooldown()

    def test_expired_unknown_with_matching_receipts_is_confirmed_without_resend(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1)
        row = self.receipt("late-1")
        self.income_rows = {"long": [{**row, "income": "-1000.00000000"}],
                            "short": [{**row, "income": "1000.00000000"}]}
        # The original landed late; fresh balances already reflect it.
        self.balances.update(long="2000", short="2000")
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "confirmed")
        self.assertEqual(result["status"], "cooldown", result)
        # Without the original tranId this is attribution, not verification.
        self.assertIn("记为到账", result["reason"])
        self.assertIn("延长冷却", result["reason"])
        self.assertEqual(len(self.posts()), 1, result)
        self.assertEqual(len(self.income_queries()), 2)
        self.assertIn(["TRANSFER", "late-1"], self.state()["used_receipts"])
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual(self.settlement(operation_id)["outcome"], "confirmed")
        self.assertEqual(self.settlement(operation_id)["basis"], "late_receipt_confirmed")

    def test_failed_or_partial_history_still_settles_by_expiry_with_one_read(self):
        for case in ("failed", "partial"):
            with self.subTest(case=case):
                before = len(self.income_queries())
                operation_id = self.skip_timed_out_transfer()
                self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1)
                self.income_error = case == "failed"
                self.income_rows = {"long": [{**self.receipt("half"), "income": "-1000.00000000"}]} if case == "partial" else {}
                result = self.balancer.tick(self.pair, self.snapshots())
                self.assertEqual(self.shared_state(operation_id), "rejected")
                self.assertEqual(result["status"], "cooldown", result)
                self.assertNotIn("unsettled_transfers", self.state())
                self.assertIn("暂不可读" if case == "failed" else "部分匹配", self.settlement(operation_id)["note"])
                # One read: a failed first side stops it, a partial one reads both.
                self.assertEqual(len(self.income_queries()) - before, 1 if case == "failed" else 2)
                self.income_error, self.income_rows = False, {}
                # Let the next case time out a fresh dispatch.
                self.balances.update(long="3000", short="1000")
                self.due()
        self.assertEqual(len(self.posts()), 2)

    def test_follow_up_without_a_shared_unknown_is_dropped(self):
        operation_id = self.skip_timed_out_transfer()
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            self.writer.resolve_prefix(operation_id, rejected=True)
        self.due(margin_balance.TRANSFER_HISTORY_WAIT_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.income_queries(), [])
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 2)
        self.assertNotIn("unsettled_transfers", self.state())

    def test_follow_up_with_another_identity_settles_by_expiry_without_reads(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state["unsettled_transfers"][0]["identity"] = "other-accounts"
        self.store.put("pair_margin:gold", state)
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.income_queries(), len(self.posts())), ("cooldown", [], 1), result)
        self.assertEqual(self.shared_state(operation_id), "rejected")
        self.assertIn("身份", self.settlement(operation_id)["note"])
        self.assertEqual(self.settlement(operation_id)["basis"], "identity_changed")

    def test_sweep_settles_expired_rows_without_a_follow_up(self):
        operation_id = self.skip_timed_out_transfer()
        # A pre-fix skip, or a corrupt follow-up: only the shared rows remain.
        state = self.state()
        state["unsettled_transfers"] = [{"request_id": "broken"}]
        self.store.put("pair_margin:gold", state)
        legacy = "aster:legacy:pair_margin:gold:" + "a" * 32
        other = "aster:legacy:order:untouched"
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
            self.writer.registry.import_unknown(ticket, legacy, {"kind": "order", "purpose": "margin"})
            self.writer.registry.import_unknown(ticket, other, {"kind": "order", "purpose": "margin"})
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertIn("过期", result["reason"])
        self.assertNotIn("unsettled_transfers", self.state())
        # Not yet expired: still checked on the very next tick, not throttled.
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.income_queries(), len(self.posts())), ("cooldown", [], 1), result)
        self.assertEqual((self.shared_state(operation_id), self.shared_state(legacy), self.shared_state(other)),
                         ("rejected", "rejected", "unknown"))
        # The archive of a swept write records that no read was made.
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_follow_up")
        # The remaining unknown non-transfer write has expired as well, so it
        # no longer blocks the next transfer (ordinary orders stay blocked).
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 2), result)

    def test_skipped_write_left_sending_settles_once_the_skip_expires(self):
        original = self.store.put

        def put(key, value):
            last = value.get("last_transfer") if key == "pair_margin:gold" and isinstance(value, dict) else None
            if isinstance(last, dict) and isinstance(last.get("writer_rejection"), dict):
                raise sqlite3.OperationalError("injected no-send journal failure")
            return original(key, value)

        with self.veto_next_send(), patch.object(self.store, "put", side_effect=put):
            self.balancer.tick(self.pair, self.snapshots())
        operation_id = "aster:transfer:" + self.state()["pending"]["request_id"]
        self.assertEqual(self.shared_state(operation_id), "sending")
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(self.shared_state(operation_id), "sending")
        # The follow-up must not be dropped as "settled elsewhere".
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertEqual(len(self.state()["unsettled_transfers"]), 1)
        # A "sending" row expires from the skip, which proves the sender ended.
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1, skipped=False)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id)), ("unknown", "sending"), result)
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id), self.posts()), ("cooldown", "rejected", []), result)
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 1), result)

    def test_label_is_read_once_even_if_settling_fails(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1)
        with patch.object(margin_balance.MarginBalancer, "_resolve_skipped", side_effect=RuntimeError("busy")):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertEqual((len(self.income_queries()), self.shared_state(operation_id)), (2, "unknown"))
        cooldown = self.state()["cooldown_until"]
        self.assertGreater(cooldown, time.time())
        self.assertEqual(self.state()["unsettled_transfers"][0]["label"],
                         {"note": "两侧流水均无该笔划转", "basis": "nonce_expired_no_receipt",
                          "cooldown_until": cooldown})
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id), len(self.income_queries())), ("cooldown", "rejected", 2))
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_receipt")
        self.assertEqual(self.state()["cooldown_until"], cooldown)

    def test_swept_rows_keep_guards_and_settle_after_balancing_is_disabled(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        del state["unsettled_transfers"]  # As left by a release before follow-ups.
        self.store.put("pair_margin:gold", state)
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertEqual(self.state()["unsettled_operations"], [operation_id])
        shown = margin_balance.MarginBalancer.status_view(self.pair, self.state())
        self.assertEqual((shown["status"], shown["blocks_trading"]), ("unknown", True), shown)
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        with self.assertRaisesRegex(TradingError, "保证金划转结果尚未核实"):
            self.store.delete_pair("gold")
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id), self.income_queries()), ("cooldown", "rejected", []), result)
        self.assertNotIn("unsettled_operations", self.state())
        self.store.delete_pair("gold")

    def test_disabled_balancing_keeps_scan_guard_after_filtering_only_invalid_follow_up(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state["unsettled_transfers"] = [{"request_id": "broken"}]
        self.store.put("pair_margin:gold", state)
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        for _ in range(2):
            result = self.balancer.tick(self.pair, self.snapshots())
            self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
            self.assertTrue(MarginBalancer.unsettled_shared(self.state()))
            self.assertEqual(self.state()["unsettled_operations"], [operation_id])
            self.assertIn("master:ASTER_MASTER", self.writer.connections)
        with self.assertRaisesRegex(TradingError, "保证金划转结果尚未核实"):
            self.store.delete_pair("gold")
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, None)
        self.assertEqual(self.income_queries(), [])
        self.assertFalse(MarginBalancer.unsettled_shared(self.state()))

    def test_filter_crash_preserves_disabled_scan_guard_until_restart_settles(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state["unsettled_transfers"] = [{"request_id": "broken"}]
        self.store.put("pair_margin:gold", state)
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        put = self.store.put

        def put_then_exit(key, value):
            put(key, value)
            if key == "pair_margin:gold" and value.get("unsettled_transfers") == []:
                raise SystemExit("after filtering corrupt follow-ups")
        with patch.object(self.store, "put", side_effect=put_then_exit), self.assertRaises(SystemExit):
            self.balancer.tick(self.pair, self.snapshots())
        self.assertTrue(MarginBalancer.unsettled_shared(self.state()))
        self.assertEqual(self.shared_state(operation_id), "unknown")
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        self.assertIn("master:ASTER_MASTER", self.writer.connections)
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, None)
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_follow_up")
        self.assertFalse(MarginBalancer.unsettled_shared(self.state()))

    def test_disabled_valid_follow_up_keeps_master_until_orphan_sweep_finishes(self):
        operation_id = self.skip_timed_out_transfer()
        orphan = self.legacy_operation("orphan-after-valid")
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        result = self.settle_expired()
        self.assert_settled_once(operation_id, result, "两侧流水均无该笔划转")
        self.assertEqual(self.shared_state(orphan), "rejected")
        self.assertFalse(MarginBalancer.unsettled_shared(self.state()))

    def test_disabled_or_clean_pairs_do_not_touch_the_writer_on_every_tick(self):
        disabled = self.store.save_pair(validate_pair({**self.pair, "margin": {**self.pair["margin"], "enabled": False}}))
        with patch.object(self.writer, "accounts", wraps=self.writer.accounts) as accounts:
            self.balancer.tick(disabled, self.snapshots())
            # tick() itself binds the two members; the sweep never adds the master.
            self.assertEqual([call.args[0] for call in accounts.call_args_list], [["long", "short"]])
        self.balancer._settle_skipped(self.pair, self.balancer._members(self.pair), self.state(),
                                      margin_balance.validate_margin(self.pair["margin"]))
        with patch.object(self.writer, "accounts", wraps=self.writer.accounts) as accounts:
            self.assertIsNone(self.balancer._settle_skipped(self.pair, self.balancer._members(self.pair), self.state(),
                                                            margin_balance.validate_margin(self.pair["margin"])))
            self.assertEqual(accounts.call_count, 0)

    def test_disabled_balancing_still_settles_while_pair_deletion_waits(self):
        operation_id = self.skip_timed_out_transfer()
        # Persist the disabled configuration: the master binding must survive it.
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        with self.assertRaisesRegex(TradingError, "保证金划转结果尚未核实"):
            self.store.delete_pair("gold")
        disabled = self.pair
        self.due()
        result = self.balancer.tick(disabled, self.snapshots())
        # The pending settlement stays visible while balancing is disabled.
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        shown = margin_balance.MarginBalancer.status_view(disabled, self.state())
        self.assertEqual(shown["status"], "unknown", shown)
        self.due(margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS + 1)
        self.balancer.tick(disabled, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "rejected")
        self.assertEqual((len(self.posts()), len(self.income_queries())), (1, 2))
        self.assertNotIn("unsettled_transfers", self.state())
        self.store.delete_pair("gold")

    # -- Label reads: unreadable rows, paged history, throttles, restarts (#130 #131 #132) --

    SPAN = margin_balance.TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS

    def follow_up(self):
        return self.state()["unsettled_transfers"][0]

    def settle_expired(self):
        """Age the skipped write past its expiry and run one check."""
        self.due(self.SPAN + 1)
        return self.balancer.tick(self.pair, self.snapshots())

    def window(self):
        created = self.follow_up()["created_at"]
        return (int((created - margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS) * 1000),
                int((created + self.SPAN) * 1000))

    def paged_income(self, rows, *, exclusive_end=False, fail_on=None):
        """Serve /income like the exchange: at most one page per time window."""
        calls = []

        def handler(aid, params, request):
            low, high = int(params["startTime"]), int(params["endTime"])
            calls.append((aid, low, high))
            if fail_on is not None and len(calls) == fail_on:
                raise httpx.ConnectError("injected page failure", request=request)
            inside = sorted((row for row in rows.get(aid, []) if low <= row["time"]
                             and (row["time"] < high if exclusive_end else row["time"] <= high)),
                            key=lambda row: row["time"])
            return httpx.Response(200, json=inside[:int(params["limit"])])
        self.income_handler = handler
        return calls

    @staticmethod
    def busy_rows(count, start, end):
        step = (end - start) / count
        return [{"asset": "USD1", "incomeType": "COMMISSION", "income": "-0.01", "tranId": index + 1,
                 "symbol": "BTCUSDT", "time": int(start + index * step)} for index in range(count)]

    def legacy_operation(self, request_id):
        operation_id = "aster:legacy:pair_margin:gold:" + request_id
        payload = {"id": None, "request_id": request_id, "kind": "margin", "symbol": None, "target_leverage": None,
                   "amount": "1000", "source": "long", "destination": "short", "orders": []}
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"], recovery=True) as ticket:
            self.writer.registry.import_unknown(ticket, operation_id, payload)
        return operation_id

    def assert_settled_once(self, operation_id, result, note, *, outcome="rejected"):
        self.assertEqual((self.shared_state(operation_id), result["status"], len(self.posts())),
                         (outcome, "cooldown", 1), result)
        self.assertNotIn("unsettled_transfers", self.state())
        if note is not None:
            self.assertIn(note, self.settlement(operation_id)["note"])

    def test_unreadable_transfer_candidates_label_the_read_unreadable_not_absent(self):
        damages = {"tranId": lambda row: {key: value for key, value in row.items() if key != "tranId"},
                   "time": lambda row: {**row, "time": "soon"},
                   "type": lambda row: {**row, "incomeType": None},
                   "amount": lambda row: {**row, "income": "abc"}}
        for name, damage in damages.items():
            with self.subTest(damage=name):
                operation_id = self.skip_timed_out_transfer()
                self.income_rows = {"long": [], "short": [damage({**self.receipt("bad"), "income": "1000.00000000"})]}
                result = self.settle_expired()
                self.assertEqual(self.shared_state(operation_id), "rejected")
                self.assertEqual(result["status"], "cooldown", result)
                self.assertRegex(self.settlement(operation_id)["note"], "暂不可读.*(无法解析|无法分类)")
                self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_unreadable")
                self.income_rows = {}
                self.balances.update(long="3000", short="1000")
                self.due()

    def test_blank_required_receipt_fields_are_unreadable_not_absent(self):
        for field in ("asset", "incomeType", "tranId", "time", "income"):
            for blank in ("", " \t "):
                with self.subTest(field=field, blank=blank):
                    self.income_rows = {}
                    self.due()
                    operation_id = self.skip_timed_out_transfer()
                    self.due(self.SPAN + 1)
                    row = {**self.receipt("blank-field"), "income": "1000.00000000", field: blank}
                    self.income_rows = {"short": [row]}
                    result = self.balancer.tick(self.pair, self.snapshots())
                    self.assertEqual((self.shared_state(operation_id), result["status"]), ("rejected", "cooldown"), result)
                    audit = self.settlement(operation_id)
                    self.assertEqual(audit["basis"], "nonce_expired_unreadable")
                    self.assertRegex(audit["note"], "暂不可读.*(无法解析|无法分类)")
                    self.assertNotIn("evidence", audit)

    def test_blank_classification_keeps_valid_receipts_before_and_after_it(self):
        for field in ("asset", "incomeType"):
            for blank in ("", " \t "):
                with self.subTest(field=field, blank=blank):
                    self.income_rows = {}
                    self.due()
                    self.requests = [request for request in self.requests if request[1] != "POST"]
                    operation_id = self.skip_timed_out_transfer()
                    self.due(self.SPAN + 1)
                    row = {**self.receipt("before-blank"), "income": "-1000.00000000"}
                    self.income_rows = {"long": [row, {**row, "tranId": "blank", field: blank},
                                                 {**row, "tranId": "after-blank"}]}
                    result = self.balancer.tick(self.pair, self.snapshots())
                    self.assert_settled_once(operation_id, result, "暂不可读")
                    audit = self.settlement(operation_id)
                    self.assertEqual(audit["basis"], "nonce_expired_partial_receipt")
                    self.assertCountEqual(audit["evidence"],
                        [["long", "TRANSFER", "before-blank"], ["long", "TRANSFER", "after-blank"]])
                    self.assertEqual(self.state().get("used_receipts", []), [])

    def test_clearly_unrelated_rows_are_excluded_from_the_label(self):
        operation_id = self.skip_timed_out_transfer()
        unrelated = [{"asset": "USD1", "incomeType": "COMMISSION", "income": "-0.1", "time": 1},
                     {"asset": "BTC", "incomeType": "TRANSFER", "income": "x"}]
        self.income_rows = {"long": unrelated, "short": unrelated}
        self.assert_settled_once(operation_id, self.settle_expired(), "两侧流水均无该笔划转")

    def split_and_confirm(self, *, exclusive_end):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        start, end = self.window()
        middle = (start + end) // 2
        receipt = {"asset": "USD1", "incomeType": "TRANSFER", "tranId": "late-page", "time": middle}
        busy = self.busy_rows(1200, start, end)
        calls = self.paged_income({"long": busy + [{**receipt, "income": "-1000.00000000"}],
                                   "short": busy + [{**receipt, "income": "1000.00000000"}]}, exclusive_end=exclusive_end)
        self.balances.update(long="2000", short="2000")
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, None, outcome="confirmed")
        # The full first page is split into two halves sharing the midpoint.
        self.assertEqual([call[1:] for call in calls if call[0] == "long"], [(start, end), (start, middle), (middle, end)])

    def test_full_income_page_is_split_by_time_with_an_inclusive_end(self):
        self.split_and_confirm(exclusive_end=False)

    def test_full_income_page_is_split_by_time_with_an_exclusive_end(self):
        self.split_and_confirm(exclusive_end=True)

    def test_page_boundary_999_rows_is_one_read_and_1000_rows_splits(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        start, end = self.window()
        calls = self.paged_income({"long": self.busy_rows(999, start, end), "short": self.busy_rows(1000, start, end)})
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(([call[0] for call in calls].count("long"), [call[0] for call in calls].count("short")), (1, 3))
        self.assert_settled_once(operation_id, result, "两侧流水均无该笔划转")

    def test_history_that_cannot_be_read_completely_still_settles_with_one_read(self):
        same = lambda start: [{"asset": "USD1", "incomeType": "COMMISSION", "income": "-0.01", "tranId": index + 1,
                               "time": start + 5000} for index in range(1000)]
        cases = {"page bound": ({}, "上限", margin_balance.TRANSFER_INCOME_MAX_PAGES),
                 "two milliseconds": ({"TRANSFER_INCOME_MAX_PAGES": 64}, "极短时间窗", None),
                 "failed page": (None, "网络连接失败", 2)}
        for name, (limits, note, count) in cases.items():
            with self.subTest(case=name):
                operation_id = self.skip_timed_out_transfer()
                self.due(self.SPAN + 1)
                start, end = self.window()
                calls = (self.paged_income({"long": self.busy_rows(1200, start, end)}, fail_on=2) if limits is None
                         else self.paged_income({"long": same(start)}))
                with patch.multiple(margin_balance, **(limits or {})) if limits else nullcontext():
                    result = self.balancer.tick(self.pair, self.snapshots())
                self.assertEqual((self.shared_state(operation_id), result["status"]), ("rejected", "cooldown"), result)
                self.assertIn(note, self.settlement(operation_id)["note"])
                if count is not None:
                    self.assertEqual(len(calls), count)
                else:
                    self.assertLessEqual(calls[-1][2] - calls[-1][1], 1)
                self.income_handler = None
                self.balances.update(long="3000", short="1000")
                self.due()

    def test_many_conflicting_receipts_settle_without_manual_review(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        # Receipts sit inside the aged window.
        self.income_rows = {"long": [{**self.receipt("debit-" + str(index)), "income": "-1000.00000000"}
                                     for index in range(21)]}
        self.assert_settled_once(operation_id, self.balancer.tick(self.pair, self.snapshots()), "部分匹配")

    def throttle_after_source_receipt(self):
        """Read the source debit, then hit a throttle on the destination; restart and clear it."""
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        debit = {**self.receipt("late-2"), "income": "-1000.00000000"}

        def handler(aid, params, request):
            if aid == "short":
                return httpx.Response(429, headers={"Retry-After": "1"}, json={"code": -1003, "msg": "Too many requests"})
            return httpx.Response(200, json=[debit])
        self.income_handler = handler
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id)), ("unknown", "unknown"), result)
        self.assertNotIn("label", self.follow_up())
        # The debit already read is durable proof that the transfer may exist.
        self.assertEqual(self.follow_up()["evidence"], [["long", "TRANSFER", "late-2"]])
        # The throttle clears, then the process restarts.
        for api in self.api_instances:
            api.budget.until = 0
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        self.income_handler = None
        self.due()
        return operation_id, debit

    def test_invalid_follow_up_keeps_valid_partial_evidence_and_cooldown(self):
        operation_id, _ = self.throttle_after_source_receipt()
        invalid_id = "invalid-follow-up"
        invalid_op = self.legacy_operation(invalid_id)
        self.store.put("pair_margin_skipped:gold:" + invalid_id, {"result": {"status": "skipped"}})
        self.due(self.SPAN + 1)
        state = self.state()
        state["unsettled_transfers"].insert(0, {"request_id": invalid_id})
        self.store.put("pair_margin:gold", state)
        settled_at = time.time()
        with patch("time.time", return_value=settled_at):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, None)
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "late-2"]])
        self.assertEqual(self.shared_state(invalid_op), "rejected")
        self.assertEqual(self.settlement(invalid_op)["basis"], "nonce_expired_no_follow_up")
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        with patch("time.time", return_value=settled_at + 31):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)

    def test_invalid_follow_up_keeps_persisted_label_and_deadline(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        self.income_rows = {"long": [{**self.receipt("saved-debit"), "income": "-1000.00000000"}]}
        with patch.object(MarginBalancer, "_resolve_skipped", side_effect=RuntimeError("injected settlement failure")):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        state = self.state()
        valid = state["unsettled_transfers"][0]
        label = deepcopy(valid["label"])
        # Even a JSON value that is unhashable must only invalidate its own row.
        state["unsettled_transfers"].append({**deepcopy(valid), "request_id": "broken", "source": ["long"]})
        self.store.put("pair_margin:gold", state)
        queried = len(self.income_queries())
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        with patch("time.time", return_value=label["cooldown_until"] - 269):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(len(self.income_queries()), queried)
        self.assertEqual(self.state()["cooldown_until"], label["cooldown_until"])
        self.assertEqual(self.settlement(operation_id)["basis"], label["basis"])
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "saved-debit"]])

    def test_invalid_follow_up_keeps_unexpired_valid_follow_up(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        valid = deepcopy(state["unsettled_transfers"][0])
        state["unsettled_transfers"].append({"request_id": "broken"})
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id)), ("unknown", "unknown"), result)
        self.assertEqual(self.state().get("unsettled_transfers"), [valid])
        self.assertEqual((self.income_queries(), len(self.posts())), ([], 1))

    def test_upgrade_then_throttle_keeps_follow_up_valid_for_f30b4aa_rollback(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        state = self.state()
        record = state["unsettled_transfers"][0]
        record.update(empty=1, failures=0, evidence=[], queried_at=record["created_at"] + 1)
        record.pop("skipped_at")
        self.assertTrue(valid_unsettled_f30b4aa(record))
        self.store.put("pair_margin:gold", state)
        debit = {**self.receipt("upgrade-debit"), "income": "-1000.00000000"}

        def handler(aid, params, request):
            if aid == "short":
                return httpx.Response(429, headers={"Retry-After": "1"}, json={"code": -1003, "msg": "Too many requests"})
            return httpx.Response(200, json=[debit])
        self.income_handler = handler
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id)), ("unknown", "unknown"), result)
        persisted = self.follow_up()
        self.assertNotIn("label", persisted)
        self.assertEqual(persisted["evidence"], [["long", "TRANSFER", "upgrade-debit"]])
        # A downgrade reads this exact durable record, before any label exists.
        self.assertTrue(valid_unsettled_f30b4aa(persisted), persisted)
        self.assertEqual(persisted["empty"], 0)
        self.assertFalse(valid_unsettled_f30b4aa({**persisted, "empty": 1}))
        self.assertEqual(len(self.posts()), 1)

    def test_malformed_evidence_is_ignored_and_settles_within_one_read(self):
        variants = {"unhashable kind": [["long", ["TRANSFER"], "x"]], "dict kind": [["long", {"k": 1}, "x"]],
                    "unhashable side": [[["long"], "TRANSFER", "x"]], "integer tranId": [["long", "TRANSFER", 7]],
                    "not a list": {"long": "x"}}
        for name, evidence in variants.items():
            with self.subTest(evidence=name):
                before = len(self.income_queries())
                operation_id = self.skip_timed_out_transfer()
                state = self.state()
                state["unsettled_transfers"][0]["evidence"] = evidence
                self.store.put("pair_margin:gold", state)
                self.assert_settled_once(operation_id, self.settle_expired(), "两侧流水均无该笔划转")
                self.assertEqual(len(self.income_queries()) - before, 2)
                self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_receipt")
                self.assertNotIn("evidence", self.settlement(operation_id))
                self.due()
                # Each case times out one fresh dispatch of its own.
                self.requests = [request for request in self.requests if request[1] != "POST"]

    def test_partial_receipt_waits_a_longer_cooldown_then_sends_one_new_request(self):
        operation_id = self.skip_timed_out_transfer()
        original = operation_id.removeprefix("aster:transfer:")
        self.due(self.SPAN + 1)
        # Only the source debit is visible: the credit may still be in flight.
        self.income_rows = {"long": [{**self.receipt("in-flight"), "income": "-1000.00000000"}]}
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertIn("已见一侧流水，可能为迟到到账", result["reason"])
        remaining = self.state()["cooldown_until"] - margin_balance.time.time()
        self.assertGreater(remaining, margin_balance.TRANSFER_SETTLE_COOLDOWN_SECONDS + 60)
        self.assertLessEqual(remaining, margin_balance.TRANSFER_PARTIAL_SETTLE_COOLDOWN_SECONDS)
        # Past the ordinary cooldown but inside the extended one: no new POST.
        state = self.state()
        state["next_check_at"] = 0
        state["cooldown_until"] -= margin_balance.TRANSFER_SETTLE_COOLDOWN_SECONDS + 1
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)
        # The credit never landed: fresh balances still differ, so exactly one
        # new request is sent, never the original.
        self.income_rows = {}
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 2), result)
        self.assertNotEqual(self.state()["last_transfer"]["request_id"], original)
        self.assertEqual(self.unresolved(), [])

    def crash_after_partial_settlement(self, *, after_cleanup):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        self.income_rows = {"long": [{**self.receipt("crash-debit"), "income": "-1000.00000000"}]}
        self.balances.update(long="2000", short="1000")
        # An unintended new 500 USD1 dispatch must be observable, not rejected
        # by the fixture's normal 1000 USD1 acknowledgement assertion.
        self.fail_dispatch = True
        resolve, put = MarginBalancer._resolve_skipped, self.store.put

        def resolve_then_exit(*args, **kwargs):
            resolve(*args, **kwargs)
            raise SystemExit("after shared settlement")

        def put_then_exit(key, value):
            put(key, value)
            if key == "pair_margin:gold" and value.get("unsettled_transfers") == []:
                raise SystemExit("after private cleanup")

        settled_at = time.time()
        crash = (patch.object(self.store, "put", side_effect=put_then_exit) if after_cleanup
                 else patch.object(MarginBalancer, "_resolve_skipped", staticmethod(resolve_then_exit)))
        with patch("time.time", return_value=settled_at), crash, self.assertRaises(SystemExit):
            self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "rejected")
        queried = len(self.income_queries())
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        # Use the persisted cooldown, without the due() helper clearing it.
        for elapsed in (1, 31, 299):
            with patch("time.time", return_value=settled_at + elapsed):
                result = self.balancer.tick(self.pair, self.snapshots())
            self.assertEqual((len(self.posts()), result["status"]), (1, "cooldown"), result)
            self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        self.assertEqual(len(self.income_queries()), queried)
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "crash-debit"]])
        # Expiry still permits a genuinely new request from fresh balances.
        self.fail_dispatch = False
        self.balances.update(long="3000", short="1000")
        with patch("time.time", return_value=settled_at + 301):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((len(self.posts()), result["status"]), (2, "acknowledged"), result)
        self.assertNotEqual(self.state()["last_transfer"]["request_id"], operation_id.rsplit(":", 1)[1])

    def test_partial_cooldown_and_audit_survive_crash_after_shared_settlement(self):
        self.crash_after_partial_settlement(after_cleanup=False)

    def test_partial_cooldown_survives_crash_after_private_cleanup(self):
        self.crash_after_partial_settlement(after_cleanup=True)

    def test_full_page_receipt_survives_successful_empty_subwindows(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        start, end = self.window()
        debit = {**self.receipt("first-page"), "income": "-1000.00000000"}
        page = self.busy_rows(999, start, end) + [debit]
        calls = []

        def handler(aid, params, request):
            calls.append(aid)
            return httpx.Response(200, json=page if len(calls) == 1 else [])
        self.income_handler = handler
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(calls, ["long", "long", "long", "short"])
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "first-page"]])

    def test_bad_row_keeps_valid_receipts_on_either_side_of_the_same_page(self):
        for side, bad_first in (("long", False), ("long", True), ("short", False), ("short", True)):
            with self.subTest(side=side, bad_first=bad_first):
                self.income_rows = {}
                self.due()
                self.requests = [request for request in self.requests if request[1] != "POST"]
                operation_id = self.skip_timed_out_transfer()
                self.due(self.SPAN + 1)
                row = self.receipt("mixed-page")
                debit, credit = {**row, "income": "-1000.00000000"}, {**row, "income": "1000.00000000"}
                self.income_rows = {"long": [debit], "short": [credit]}
                bad = {**row, "tranId": "unreadable", "income": "abc"}
                self.income_rows[side].insert(0 if bad_first else 1, bad)
                result = self.balancer.tick(self.pair, self.snapshots())
                self.assert_settled_once(operation_id, result, "暂不可读")
                audit = self.settlement(operation_id)
                self.assertEqual(audit["basis"], "nonce_expired_partial_receipt")
                expected = [["long", "TRANSFER", "mixed-page"]]
                if side == "short":
                    expected.append(["short", "TRANSFER", "mixed-page"])
                self.assertEqual(audit["evidence"], expected)
                self.assertNotIn(["TRANSFER", "mixed-page"], self.state().get("used_receipts", []))

    def test_legacy_accepted_read_keeps_partial_evidence_when_it_is_later_skipped(self):
        self.fail_dispatch = True
        self.balancer.tick(self.pair, self.snapshots())
        self.fail_dispatch = False
        state = self.state()
        pending = state["pending"]
        operation_id = "aster:transfer:" + pending["request_id"]
        pending["status"] = "accepted"
        pending["created_at"] -= self.SPAN + 1
        pending["history_recovery"] = {"first_observed_at": pending["created_at"], "query_rounds": 2}
        row = {"asset": "USD1", "incomeType": "TRANSFER", "tranId": "legacy-debit",
               "time": int(pending["created_at"] * 1000) + 5000, "income": "-1000.00000000"}
        self.income_rows = {"long": [{**row, "tranId": "bad", "income": "abc"}, row]}
        state["next_check_at"] = 0
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "skipped", result)
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        self.income_rows = {}
        result = self.settle_expired()
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "legacy-debit"]])

    def test_label_without_basis_from_the_previous_build_keeps_its_class(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        state = self.state()
        state["unsettled_transfers"][0]["label"] = {"note": "两侧流水只部分匹配"}
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.income_queries(), [])
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertIn("迟到到账", result["reason"])

    def test_receipts_on_both_sides_from_an_incomplete_read_are_not_confirmed(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        start, end = self.window()
        row = self.receipt("both")
        debit, credit = {**row, "income": "-1000.00000000"}, {**row, "income": "1000.00000000"}
        page = sorted(self.busy_rows(999, start, end) + [credit], key=lambda value: value["time"])
        calls = []

        def handler(aid, params, request):
            calls.append(aid)
            if aid == "long":
                return httpx.Response(200, json=[debit])
            if calls.count("short") == 1:
                # A full page: the read must split it, and the next part fails.
                return httpx.Response(200, json=page)
            raise httpx.ConnectError("injected page failure", request=request)
        self.income_handler = handler
        self.assert_settled_once(operation_id, self.balancer.tick(self.pair, self.snapshots()), "暂不可读")
        settlement = self.settlement(operation_id)
        self.assertEqual(settlement["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(settlement["evidence"], [["long", "TRANSFER", "both"], ["short", "TRANSFER", "both"]])
        self.assertNotIn(["TRANSFER", "both"], self.state().get("used_receipts", []))

    def test_evidence_merged_across_reads_is_bounded(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        first = [{**self.receipt("a-%02d" % index), "income": "-1000.00000000"} for index in range(15)]
        later = [{**self.receipt("b-%02d" % index), "income": "-1000.00000000"} for index in range(10)]

        def handler(aid, params, request):
            if aid == "short":
                return httpx.Response(429, headers={"Retry-After": "1"}, json={"code": -1003, "msg": "Too many requests"})
            return httpx.Response(200, json=first)
        self.income_handler = handler
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        self.assertEqual(len(self.follow_up()["evidence"]), 15)
        for api in self.api_instances:
            api.budget.until = 0
        self.income_handler = None
        self.income_rows = {"long": later}
        self.due()
        self.assert_settled_once(operation_id, self.balancer.tick(self.pair, self.snapshots()), "部分匹配")
        evidence = self.settlement(operation_id)["evidence"]
        self.assertEqual(len(evidence), margin_balance.TRANSFER_EVIDENCE_LIMIT)
        # Earlier receipts are kept first; later ones fill the bound in order.
        self.assertEqual(evidence, [["long", "TRANSFER", "a-%02d" % index] for index in range(15)]
                         + [["long", "TRANSFER", "b-%02d" % index] for index in range(5)])

    def test_receipt_seen_before_a_throttle_survives_a_later_empty_read(self):
        operation_id, _ = self.throttle_after_source_receipt()
        queried = len(self.income_queries())
        # The history view is unstable: neither side shows the transfer now.
        self.income_rows = {}
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.income_queries()) - queried, 2)
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertNotIn("两侧流水均无", self.settlement(operation_id)["note"])
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "late-2"]])
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")

    def test_late_destination_credit_stays_partial_after_source_disappears(self):
        operation_id, debit = self.throttle_after_source_receipt()
        # The credit lands late and the source view no longer lists the debit.
        self.income_rows = {"short": [{**debit, "income": "1000.00000000"}]}
        self.balances.update(long="2000", short="2000")
        settled_at = time.time()
        with patch("time.time", return_value=settled_at):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertNotIn(["TRANSFER", "late-2"], self.state().get("used_receipts", []))
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        with patch("time.time", return_value=settled_at + 31):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)
        # The next decision uses the fresh, already balanced reads: no resend.
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1, result)
        self.assertEqual(self.unresolved(), [])

    def test_previous_transfer_receipts_across_reads_cannot_confirm_timed_out_request(self):
        operation_id = self.skip_timed_out_transfer()  # A has no exchange transaction ID.
        self.due(self.SPAN + 1)
        self.assertNotIn("transaction_id", self.follow_up())
        previous = {**self.receipt("previous-B"), "time": int((self.follow_up()["created_at"] - 30) * 1000),
                    "income": "-1000.00000000"}

        def handler(aid, params, request):
            if aid == "short":
                return httpx.Response(429, headers={"Retry-After": "1"}, json={"code": -1003, "msg": "Too many requests"})
            return httpx.Response(200, json=[previous])
        self.income_handler = handler
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        self.assertEqual(self.follow_up()["evidence"], [["long", "TRANSFER", "previous-B"]])
        for api in self.api_instances:
            api.budget.until = 0
        self.income_handler = None
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        self.due()
        # Only B's credit is visible in the next complete read; A is still unknown.
        self.income_rows = {"short": [{**previous, "income": "1000.00000000"}]}
        settled_at = time.time()
        with patch("time.time", return_value=settled_at):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(self.settlement(operation_id)["evidence"],
                         [["long", "TRANSFER", "previous-B"], ["short", "TRANSFER", "previous-B"]])
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        self.assertNotIn(["TRANSFER", "previous-B"], self.state().get("used_receipts", []))
        with patch("time.time", return_value=settled_at + 31):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)

    def test_previous_transfer_in_one_complete_read_is_not_confirmation_without_original_id(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        previous = {**self.receipt("previous-B"), "time": int((self.follow_up()["created_at"] - 30) * 1000)}
        self.income_rows = {"long": [{**previous, "income": "-1000.00000000"}],
                            "short": [{**previous, "income": "1000.00000000"}]}
        settled_at = time.time()
        with patch("time.time", return_value=settled_at):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, "部分匹配")
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_partial_receipt")
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        self.assertNotIn(["TRANSFER", "previous-B"], self.state().get("used_receipts", []))

    # -- Attribution without the original tranId: pre-send snapshot (#184) --

    def receipt_pair(self, tran_id, offset):
        row = {**self.receipt(tran_id), "time": int((self.follow_up()["created_at"] + offset) * 1000)}
        return {"long": {**row, "income": "-1000.00000000"}, "short": {**row, "income": "1000.00000000"}}

    def settle_at(self, *receipts):
        """Expire the follow-up, then serve (tranId, seconds after creation) receipts on both sides."""
        self.due(self.SPAN + 1)
        pairs = [self.receipt_pair(tran_id, offset) for tran_id, offset in receipts]
        self.income_rows = {side: [pair[side] for pair in pairs] for side in ("long", "short")}
        settled_at = time.time()
        with patch("time.time", return_value=settled_at):
            return self.balancer.tick(self.pair, self.snapshots()), settled_at

    def reset_for_next_transfer(self):
        """Clear the settled cooldown and request log so a subtest can time out a new transfer."""
        self.income_rows = {}
        self.balances.update(long="3000", short="1000")
        self.due()
        self.requests, self.request_queries, self.snapshot_requests = [], [], []

    def test_pre_send_snapshot_is_recorded_on_the_follow_up_with_a_short_bounded_read(self):
        self.snapshot_rows = {"long": [{"asset": "USD1", "incomeType": "TRANSFER", "tranId": "pre-B", "time": 1,
                                        "income": "-1000.00000000"},
                                       {"asset": "USD1", "incomeType": "TRANSFER", "tranId": "other", "time": 1,
                                        "income": "-5.00000000"}]}
        self.skip_timed_out_transfer()
        record = self.follow_up()
        self.assertNotIn("transaction_id", record)
        # Only same-amount, same-direction receipts are kept, per read side.
        self.assertEqual(record["before_receipts"], {"long": [["TRANSFER", "pre-B"]], "short": []})
        self.assertEqual(sorted(aid for aid, _ in self.snapshot_requests), ["long", "short"])
        created = int(record["created_at"] * 1000)
        for _, params in self.snapshot_requests:
            start = int(params["startTime"])
            # The window starts a full clock tolerance before sending and
            # runs to the exchange's own now: no future endTime is sent.
            self.assertNotIn("endTime", params)
            self.assertLessEqual(start, created - margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS * 1000)
            self.assertLess(created - start, (margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS + 5) * 1000)

    def test_external_same_amount_transfer_after_creation_is_attributed_with_a_note_and_long_cooldown(self):
        operation_id = self.skip_timed_out_transfer()  # A has no tranId; B is not in the snapshot.
        result, settled_at = self.settle_at(("external-B", 5))
        # Indistinguishable from A: still confirmed, but the label says so.
        self.assert_settled_once(operation_id, result, "可能误认其他同额划转", outcome="confirmed")
        settlement = self.settlement(operation_id)
        self.assertEqual(settlement["basis"], "late_receipt_confirmed")
        self.assertNotIn("缺少发送前流水快照", settlement["note"])
        self.assertIn("记为到账", result["reason"])
        self.assertIn("可能为其他同额划转", result["reason"])
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        with patch("time.time", return_value=settled_at + 31):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)

    def test_original_and_external_receipts_late_together_are_ambiguous_not_confirmed(self):
        operation_id = self.skip_timed_out_transfer()
        result, settled_at = self.settle_at(("A", 5), ("external-B", 20))
        self.assert_settled_once(operation_id, result, "归属歧义")
        settlement = self.settlement(operation_id)
        self.assertEqual(settlement["basis"], "nonce_expired_ambiguous_receipt")
        self.assertIn("2/2", settlement["note"])
        self.assertEqual(len(settlement["evidence"]), 4)
        self.assertIn("无法归属", result["reason"])
        self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
        self.assertEqual(self.state().get("used_receipts", []), [])

    def test_snapshot_excludes_pre_send_receipts_across_sixty_seconds_of_clock_skew(self):
        # Exchange clock ahead: an earlier B carries a time after the local
        # send. Behind: B sits inside the early evidence window.
        for skew in (margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS, -margin_balance.TRANSFER_CLOCK_TOLERANCE_SECONDS):
            for original in (False, True):
                with self.subTest(skew=skew, original=original):
                    self.snapshot_rows = {"long": [{"asset": "USD1", "incomeType": "TRANSFER", "tranId": "pre-B",
                                                    "time": 1, "income": "-1000.00000000"}],
                                          "short": [{"asset": "USD1", "incomeType": "TRANSFER", "tranId": "pre-B",
                                                     "time": 1, "income": "1000.00000000"}]}
                    operation_id = self.skip_timed_out_transfer()
                    # B's exchange time lands 55 s after/before the local send.
                    result, settled_at = self.settle_at(("pre-B", 55 if skew > 0 else -55),
                                                        *([("A-" + str(skew), 10)] if original else []))
                    settlement = self.settlement(operation_id)
                    if original:
                        self.assert_settled_once(operation_id, result, "无原交易编号", outcome="confirmed")
                        self.assertEqual(settlement["basis"], "late_receipt_confirmed")
                        self.assertEqual(settlement["evidence"],
                                         [["long", "TRANSFER", "A-" + str(skew)], ["short", "TRANSFER", "A-" + str(skew)]])
                    else:
                        self.assert_settled_once(operation_id, result, "两侧流水均无该笔划转")
                        self.assertEqual(settlement["basis"], "nonce_expired_no_receipt")
                        self.assertNotIn("evidence", settlement)
                        self.assertEqual(self.state()["cooldown_until"], settled_at + 30)
                    self.assertNotIn(["TRANSFER", "pre-B"], self.state().get("used_receipts", []))
                    self.snapshot_rows = {}
                    self.reset_for_next_transfer()

    def test_follow_up_without_snapshot_keeps_the_previous_conservative_labels(self):
        cases = {"old record, earlier B in the tolerance window": ([("pre-B", -55), ("A-1", 10)],
                     "nonce_expired_ambiguous_receipt", "rejected"),
                 "old record, original only": ([("A-2", 10)], "late_receipt_confirmed", "confirmed"),
                 # The exchange clock running behind moves A before the local
                 # send: never confirmed without the original tranId.
                 "early original": ([("A-3", -50)], "nonce_expired_partial_receipt", "rejected")}
        for name, (rows, basis, outcome) in cases.items():
            with self.subTest(name):
                operation_id = self.skip_timed_out_transfer()
                if name.startswith("old record"):
                    # Written before the snapshot existed.
                    state = self.state()
                    state["unsettled_transfers"][0].pop("before_receipts")
                    self.store.put("pair_margin:gold", state)
                result, settled_at = self.settle_at(*rows)
                self.assert_settled_once(operation_id, result, None, outcome=outcome)
                self.assertEqual(self.settlement(operation_id)["basis"], basis)
                if outcome == "confirmed":
                    self.assertIn("缺少发送前流水快照", self.settlement(operation_id)["note"])
                self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
                self.reset_for_next_transfer()

    def test_snapshot_failure_degrades_to_sending_without_it(self):
        def network(aid, params, request):
            raise httpx.ConnectError("injected snapshot failure", request=request)

        def rows(count):
            # The snapshot sends no endTime; fill the page from its start.
            def handler(aid, params, request):
                self.assertNotIn("endTime", params)
                start = int(params["startTime"])
                return httpx.Response(200, json=self.busy_rows(count, start, start + 120_000))
            return handler
        full = margin_balance.TRANSFER_INCOME_PAGE_ROWS
        cases = {"full page": (rows(full), None, set()), "network": (network, None, set()),
                 "budget": (None, 10 ** 6, set()),
                 "one side": (lambda aid, params, request: network(aid, params, request) if aid == "short"
                              else httpx.Response(200, json=[]), None, {"long"}),
                 # Control: one row short of a full page is a complete read.
                 "page minus one": (rows(full - 1), None, {"long", "short"})}
        for name, (handler, weight, sides) in cases.items():
            with self.subTest(name):
                self.snapshot_handler, self.snapshot_requests = handler, []
                with patch.object(margin_balance, "TRANSFER_SNAPSHOT_WEIGHT", weight or margin_balance.TRANSFER_SNAPSHOT_WEIGHT):
                    operation_id = self.skip_timed_out_transfer()
                # The transfer was sent once anyway; nothing is retried.
                self.assertEqual(len(self.posts()), 1)
                self.assertEqual(len(self.snapshot_requests), 0 if name == "budget" else 2)
                self.assertEqual(set(self.follow_up().get("before_receipts", {})), sides)
                self.snapshot_handler = None
                for api in self.api_instances:
                    api.budget.until = 0
                result, settled_at = self.settle_at(("A-" + name.replace(" ", "-"), 5))
                self.assert_settled_once(operation_id, result, "可能误认其他同额划转", outcome="confirmed")
                note = self.settlement(operation_id)["note"]
                if sides == {"long", "short"}:
                    self.assertNotIn("缺少发送前流水快照", note)
                else:
                    self.assertIn("缺少发送前流水快照", note)
                self.reset_for_next_transfer()

    @contextmanager
    def timed_snapshot(self):
        """Record how long each pre-send snapshot took, apart from the rest of the check."""
        durations, original = [], self.balancer._before_receipts

        def timed(*args):
            started, wall = time.monotonic(), time.time()
            try:
                return original(*args)
            finally:
                durations.append({"started": wall, "seconds": time.monotonic() - started})
        with patch.object(self.balancer, "_before_receipts", side_effect=timed):
            yield durations

    def test_slow_snapshot_reads_are_abandoned_by_wall_clock_and_the_transfer_is_sent(self):
        # HTTPX timeouts apply per stage, so a read can outlast them (the mock
        # transport ignores them entirely). A stale account snapshot at the
        # send would block trading and repeat every check.
        release = threading.Event()
        self.addCleanup(release.set)

        def slow(seconds, *, fail=False):
            def handler(aid, params, request):
                release.wait(seconds)
                if fail:
                    raise httpx.ReadTimeout("injected snapshot timeout", request=request)
                return httpx.Response(200, json=[])
            return handler
        cases = {"each side 4.5 s": (slow(4.5), set()),
                 "one side hangs": (lambda aid, params, request: slow(60)(aid, params, request) if aid == "short"
                                    else httpx.Response(200, json=[]), {"long"}),
                 "both sides time out": (slow(4.5, fail=True), set())}
        for name, (handler, sides) in cases.items():
            with self.subTest(name):
                self.snapshot_handler, self.snapshot_requests = handler, []
                self.fail_dispatch = True
                with self.timed_snapshot() as durations:
                    result = self.balancer.tick(self.pair, self.snapshots())
                self.fail_dispatch = False
                self.snapshot_handler = None
                self.assertEqual((result["status"], len(self.posts())), ("unknown", 1), result)
                self.assertEqual(sorted(aid for aid, _ in self.snapshot_requests), ["long", "short"])
                self.assertLess(durations[0]["seconds"], margin_balance.TRANSFER_SNAPSHOT_TIMEOUT_SECONDS + 0.5, result)
                operation_id = "aster:transfer:" + self.state()["pending"]["request_id"]
                self.due()
                self.assertEqual(self.balancer.tick(self.pair, self.snapshots())["status"], "skipped")
                # Only completely read sides are recorded; a missing side is
                # not an empty snapshot and settles by the previous rules.
                self.assertEqual(set(self.follow_up().get("before_receipts", {})), sides)
                result, settled_at = self.settle_at(("A-" + name.replace(" ", "-"), 5))
                self.assert_settled_once(operation_id, result, "缺少发送前流水快照", outcome="confirmed")
                self.assertEqual(self.state()["cooldown_until"], settled_at + 300)
                self.reset_for_next_transfer()

    def test_snapshot_never_spends_the_account_snapshot_freshness_reserve(self):
        reserve = margin_balance.TRANSFER_SNAPSHOT_FRESHNESS_RESERVE_SECONDS
        window = margin_balance.ACCOUNT_SNAPSHOT_MAX_AGE_SECONDS
        release = threading.Event()
        self.addCleanup(release.set)
        self.snapshot_handler = lambda aid, params, request: (release.wait(4.5), httpx.Response(200, json=[]))[1]
        # The first age leaves under a second for the snapshot, the second
        # less than the minimum. Earlier steps of the check also age the
        # snapshot, so the allowed wait is derived from when it started.
        for age in (window - reserve - 1, window - reserve - margin_balance.TRANSFER_SNAPSHOT_MIN_SECONDS + 0.1):
            with self.subTest(age=age):
                self.requests, self.request_queries, self.snapshot_requests = [], [], []
                self.balances.update(long="3000", short="1000")
                state = self.state()
                state.update(pending=None, next_check_at=0, cooldown_until=0)
                self.store.put("pair_margin:gold", state)
                snapshots = self.snapshots()
                for snapshot in snapshots.values():
                    snapshot.timestamp -= age
                with self.timed_snapshot() as durations:
                    result = self.balancer.tick(self.pair, snapshots)
                self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 1), result)
                fresh_until = min(snapshot.timestamp for snapshot in snapshots.values()) + window
                wait = min(margin_balance.TRANSFER_SNAPSHOT_TIMEOUT_SECONDS, fresh_until - durations[0]["started"] - reserve)
                self.assertLess(wait, margin_balance.TRANSFER_SNAPSHOT_TIMEOUT_SECONDS - 0.4)
                self.assertEqual(len(self.snapshot_requests), 2 if wait >= margin_balance.TRANSFER_SNAPSHOT_MIN_SECONDS else 0)
                self.assertLess(durations[0]["seconds"], max(wait, 0) + 0.3, result)
                self.assertNotIn("before_receipts", self.state()["last_transfer"])

    def test_freshness_window_matches_the_account_snapshot_check(self):
        default = inspect.signature(AccountSnapshot.require_fresh).parameters["max_age"].default
        self.assertEqual(margin_balance.ACCOUNT_SNAPSHOT_MAX_AGE_SECONDS, default)

    def test_expired_unknown_with_the_original_tranid_is_verified_with_the_ordinary_cooldown(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state["unsettled_transfers"][0]["transaction_id"] = "late-1"
        self.store.put("pair_margin:gold", state)
        # A same-amount transfer with another tranId is not this request.
        result, settled_at = self.settle_at(("late-1", 5), ("external-B", 20))
        self.assert_settled_once(operation_id, result, None, outcome="confirmed")
        settlement = self.settlement(operation_id)
        self.assertEqual(settlement["basis"], "late_receipt_confirmed")
        self.assertNotIn("note", settlement)
        self.assertIn("已由两侧流水核实到账", result["reason"])
        self.assertNotIn("延长冷却", result["reason"])
        self.assertNotIn("可能为其他同额划转", result["reason"])
        self.assertEqual(self.state()["cooldown_until"], settled_at + margin_balance.TRANSFER_SETTLE_COOLDOWN_SECONDS)
        self.assertIn(["TRANSFER", "late-1"], self.state()["used_receipts"])
        self.assertNotIn(["TRANSFER", "external-B"], self.state()["used_receipts"])

    def test_account_event_during_the_snapshot_wait_skips_the_send_without_blocking(self):
        def event(aid, params, request):
            self.engine.brokers[aid].invalidate_account_reads("injected account event")
            return httpx.Response(200, json=[])
        self.snapshot_handler = event
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"], len(self.posts())), ("waiting", False, 0), result)
        self.assertIn("未发送", result["reason"])
        state = self.state()
        self.assertIsNone(state.get("pending"))
        self.assertIs(state["retry_without_blocking"], True)
        # Nothing was prepared: no shared operation, unknown or not.
        self.assertEqual((self.shared_operations(), self.unresolved()), ([], []))
        # Until the next check the pair keeps trading.
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], result["blocks_trading"], len(self.posts())), ("waiting", False, 0), result)
        self.snapshot_handler = None
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 1), result)
        self.assertNotIn("blocked_reason", self.state())

    def busy_account_events(self):
        """Replay fills, ACCOUNT_UPDATE and private stream reconnects landing inside every snapshot wait."""
        reasons = iter(["ORDER_TRADE_UPDATE", "ACCOUNT_UPDATE", "私有流重连"] * 20)

        def event(aid, params, request):
            self.engine.brokers[aid].invalidate_account_reads(next(reasons))
            return httpx.Response(200, json=[])
        self.snapshot_handler = event

    def revoked_round(self):
        """Run one due check; return its view and the levels of its skip log lines."""
        self.due()
        with self.assertLogs("aster.trading", level="INFO") as logs:
            result = self.balancer.tick(self.pair, self.snapshots())
        levels = [record.levelname for record in logs.records
                  if "revoked during receipt snapshot" in record.getMessage()]
        return result, levels

    def test_frequent_account_events_count_consecutive_skips_and_escalate_at_the_threshold(self):
        threshold = margin_balance.TRANSFER_SNAPSHOT_REVOKED_WARN_SKIPS
        self.busy_account_events()
        for count in range(1, 2 * threshold + 2):
            with self.subTest(count=count):
                if count == threshold:
                    # The streak is durable: a restarted balancer keeps counting.
                    self.balancer = MarginBalancer(self.engine)
                result, levels = self.revoked_round()
                self.assertEqual((result["status"], result["blocks_trading"], len(self.posts())), ("waiting", False, 0), result)
                self.assertEqual(self.state()["snapshot_revoked_skips"], count)
                self.assertIn(f"已连续 {count} 次因此未发送", result["reason"])
                self.assertEqual("请留意较薄一侧的保证金" in result["reason"], count >= threshold, result["reason"])
                # A WARNING each time the streak reaches a multiple of the threshold, INFO otherwise.
                self.assertEqual(levels, ["WARNING" if count % threshold == 0 else "INFO"])
                # Never prepared: no shared operation, unknown write or pending follow-up.
                self.assertIsNone(self.state().get("pending"))
                self.assertEqual((self.shared_operations(), self.unresolved()), ([], []))
                # The stored reason keeps the escalation visible until the next check.
                between = self.balancer.tick(self.pair, self.snapshots())
                self.assertEqual((between["status"], between["blocks_trading"], between["reason"]),
                                 ("waiting", False, result["reason"]))
                status = MarginBalancer.status_view(self.pair, self.state())
                self.assertEqual((status["status"], status["blocks_trading"], status["reason"]),
                                 ("waiting", False, result["reason"]))
        # Reaching the send ends the streak, whatever the transfer's outcome.
        self.snapshot_handler = None
        self.fail_dispatch = True
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("unknown", 1), result)
        self.assertNotIn("snapshot_revoked_skips", self.state())

    def test_revoked_skip_streak_resets_when_no_transfer_is_needed_or_balancing_stops(self):
        threshold = margin_balance.TRANSFER_SNAPSHOT_REVOKED_WARN_SKIPS
        enabled = self.pair
        stops = {"balanced": None,
                 "balancing disabled": {**enabled, "margin": {**enabled["margin"], "enabled": False}},
                 "pair paused": {**enabled, "enabled": False}}
        for name, stopped in stops.items():
            with self.subTest(name):
                self.busy_account_events()
                for _ in range(threshold - 1):
                    self.revoked_round()
                self.assertEqual(self.state()["snapshot_revoked_skips"], threshold - 1)
                self.snapshot_handler = None
                if stopped is None:
                    self.balances.update(long="2000", short="2000")
                    self.due()
                    result = self.balancer.tick(self.pair, self.snapshots())
                    self.assertEqual(result["status"], "waiting", result)
                    self.balances.update(long="3000", short="1000")
                else:
                    self.pair = self.store.save_pair(validate_pair({**stopped, "revision": self.pair["revision"]}))
                    result = self.balancer.tick(self.pair, self.snapshots())
                    self.assertIn(result["status"], {"disabled", "paused"}, result)
                    self.pair = self.store.save_pair(validate_pair({**enabled, "revision": self.pair["revision"]}))
                self.assertNotIn("snapshot_revoked_skips", self.state())
                self.assertEqual(len(self.posts()), 0)
                # The next streak starts from one and needs the full threshold again.
                self.busy_account_events()
                result, levels = self.revoked_round()
                self.assertEqual((self.state()["snapshot_revoked_skips"], levels), (1, ["INFO"]))
                self.assertNotIn("请留意", result["reason"])
                self.snapshot_handler = None
                state = self.state()
                state.pop("snapshot_revoked_skips")
                self.store.put("pair_margin:gold", state)

    def test_throttled_snapshot_defers_the_transfer_like_any_throttle_and_never_leaves_it_unknown(self):
        self.snapshot_handler = lambda aid, params, request: httpx.Response(
            429, headers={"Retry-After": "1"}, json={"code": -1003, "msg": "Too many requests"})
        result = self.balancer.tick(self.pair, self.snapshots())
        # Both sides are read in parallel; the shared cooldown refuses the POST locally.
        self.assertEqual(sorted(aid for aid, _ in self.snapshot_requests), ["long", "short"])
        self.assertEqual((result["status"], len(self.posts()), self.unresolved()), ("rejected", 0, []), result)
        self.assertIsNone(self.state()["pending"])
        self.snapshot_handler, self.snapshot_requests = None, []
        for api in self.api_instances:
            api.budget.until = 0
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 1), result)
        self.assertEqual(sorted(aid for aid, _ in self.snapshot_requests), ["long", "short"])

    def test_receipt_on_one_side_with_an_unreadable_other_side_is_partial_not_unreadable(self):
        def network(request):
            raise httpx.ConnectError("injected", request=request)
        failures = {"network": network,
                    "tranId": lambda request: httpx.Response(200, json=[{**self.credit, "tranId": None}]),
                    "time": lambda request: httpx.Response(200, json=[{**self.credit, "time": "soon"}]),
                    "amount": lambda request: httpx.Response(200, json=[{**self.credit, "income": "abc"}])}
        for name, failure in failures.items():
            with self.subTest(failure=name):
                operation_id = self.skip_timed_out_transfer()
                self.due(self.SPAN + 1)
                debit = {**self.receipt("half-" + name), "income": "-1000.00000000"}
                self.credit = {**debit, "income": "1000.00000000"}
                self.income_handler = lambda aid, params, request: (
                    failure(request) if aid == "short" else httpx.Response(200, json=[debit]))
                self.assert_settled_once(operation_id, self.balancer.tick(self.pair, self.snapshots()), "部分匹配")
                self.assertIn("暂不可读", self.settlement(operation_id)["note"])
                self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "half-" + name]])
                self.income_handler = None
                self.balances.update(long="3000", short="1000")
                self.due()
                # Each case times out one fresh dispatch of its own.
                self.requests = [request for request in self.requests if request[1] != "POST"]

    def test_quota_wait_and_rate_limit_defer_the_label_but_not_past_its_bound(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        snapshots = self.snapshots()
        with patch.object(RateBudget, "require_available", side_effect=BudgetWait("本地额度等待", retry_after=5)):
            result = self.balancer.tick(self.pair, snapshots)
        self.assertEqual((result["status"], result["blocks_trading"]), ("unknown", True), result)
        self.assertIn("限流", result["reason"])
        self.assertEqual((self.income_queries(), self.shared_state(operation_id)), ([], "unknown"))
        self.assertNotIn("label", self.follow_up())
        self.income_handler = lambda aid, params, request: httpx.Response(
            429, headers={"Retry-After": "600"}, json={"code": -1003, "msg": "Too many requests"})
        result = self.balancer.tick(self.pair, snapshots)
        self.assertEqual((result["status"], len(self.income_queries())), ("unknown", 1), result)
        self.assertNotIn("label", self.follow_up())
        # The exchange cooldown is honoured: no further request is made.
        self.income_handler = None
        self.due(margin_balance.TRANSFER_LABEL_DEFER_SECONDS - 60)
        result = self.balancer.tick(self.pair, snapshots)
        self.assertEqual((result["status"], len(self.income_queries())), ("unknown", 1), result)
        # Past the bound the write settles even though nothing could be read.
        self.due(61)
        result = self.balancer.tick(self.pair, snapshots)
        self.assertEqual((self.shared_state(operation_id), result["status"], len(self.income_queries())),
                         ("rejected", "cooldown", 1), result)
        self.assertIn("暂不可读", self.settlement(operation_id)["note"])
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_unreadable")
        self.assertEqual(len(self.posts()), 1)

    def test_shared_settlement_before_private_cleanup_is_not_repeated_after_restart(self):
        operation_id = self.skip_timed_out_transfer()
        original = MarginBalancer._resolve_skipped

        def resolve_then_exit(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError("process exits before the private record is cleared")
        with patch.object(MarginBalancer, "_resolve_skipped", staticmethod(resolve_then_exit)):
            self.settle_expired()
        self.assertEqual(self.shared_state(operation_id), "rejected")
        self.assertIn("label", self.follow_up())
        cooldown = self.follow_up()["label"]["cooldown_until"]
        queried = len(self.income_queries())
        self.restart_writer()
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        # Cleanup replays the audit and original cooldown without another read
        # or another settlement of the old shared row.
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual((self.shared_state(operation_id), len(self.income_queries())), ("rejected", queried))
        self.assertEqual((result["status"], len(self.posts())), ("cooldown", 1), result)
        self.assertEqual(self.state()["cooldown_until"], cooldown)
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_receipt")
        self.assertEqual(self.unresolved(), [])
        self.assert_new_transfer_after_cooldown()

    def test_sweep_audit_survives_crash_after_shared_settlement(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state.pop("unsettled_transfers")
        self.store.put("pair_margin:gold", state)
        self.due()
        self.balancer.tick(self.pair, self.snapshots())
        self.pair = self.store.save_pair(validate_pair({**self.pair, "enabled": False,
            "margin": {**self.pair["margin"], "enabled": False}}))
        self.due(margin_balance.TRANSFER_NONCE_EXPIRY_SECONDS + 1)
        resolve = MarginBalancer._resolve_skipped

        def resolve_then_exit(*args, **kwargs):
            resolve(*args, **kwargs)
            raise SystemExit("after swept shared settlement")
        settled_at = time.time()
        with patch("time.time", return_value=settled_at), \
                patch.object(MarginBalancer, "_resolve_skipped", staticmethod(resolve_then_exit)), self.assertRaises(SystemExit):
            self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "rejected")
        cooldown = self.state()["cooldown_until"]
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        with patch("time.time", return_value=settled_at + 5), \
                patch.object(MarginBalancer, "_resolve_skipped", wraps=resolve) as retry:
            result = self.balancer.tick(self.pair, self.snapshots())
        archive = self.store.get("pair_margin_skipped:gold:" + operation_id.rsplit(":", 1)[1])
        self.assertIn("settlement", archive)
        self.assertEqual(archive["settlement"], {"outcome": "rejected", "settled_at": settled_at,
                         "by": "expiry", "basis": "nonce_expired_no_follow_up"})
        self.assertEqual((result["status"], len(self.posts()), self.income_queries()), ("cooldown", 1, []), result)
        self.assertEqual(self.state()["cooldown_until"], cooldown)
        retry.assert_not_called()
        self.assertNotIn("unsettled_transfer_audits", self.state())
        self.assertFalse(MarginBalancer.unsettled_shared(self.state()))

    def test_sweep_audit_write_failure_keeps_retry_marker(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state.pop("unsettled_transfers")
        self.store.put("pair_margin:gold", state)
        self.due(self.SPAN + 1)
        put = self.store.put
        archive_key = "pair_margin_skipped:gold:" + operation_id.rsplit(":", 1)[1]

        def fail_audit(key, value):
            if key == archive_key:
                raise sqlite3.OperationalError("injected swept audit write failure")
            return put(key, value)
        with patch.object(self.store, "put", side_effect=fail_audit):
            self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.shared_state(operation_id), "rejected")
        self.assertTrue(MarginBalancer.unsettled_shared(self.state()))
        self.assertIn(operation_id, self.state()["unsettled_transfer_audits"])
        cooldown = self.state()["cooldown_until"]
        self.restart_writer()
        self.balancer = MarginBalancer(self.engine)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assert_settled_once(operation_id, result, None)
        self.assertEqual(self.settlement(operation_id)["basis"], "nonce_expired_no_follow_up")
        self.assertEqual(self.state()["cooldown_until"], cooldown)
        self.assertNotIn("unsettled_transfer_audits", self.state())
        self.assertFalse(MarginBalancer.unsettled_shared(self.state()))

    def test_legacy_prefix_alone_is_settled(self):
        operation_id = self.skip_timed_out_transfer()
        request_id = operation_id.removeprefix("aster:transfer:")
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            self.writer.resolve_prefix(operation_id, rejected=True)
        legacy = self.legacy_operation(request_id)
        self.assertEqual(self.shared_state(legacy), "unknown")
        result = self.settle_expired()
        self.assertEqual((self.shared_state(legacy), result["status"], len(self.posts())), ("rejected", "cooldown", 1))
        self.assertNotIn("unsettled_transfers", self.state())

    def test_standard_and_legacy_prefixes_settle_together_across_a_failure_between_them(self):
        operation_id = self.skip_timed_out_transfer()
        legacy = self.legacy_operation(operation_id.removeprefix("aster:transfer:"))
        original = self.writer.registry.resolve
        calls = []

        def fail_second(*args, **kwargs):
            calls.append(args[0])
            if len(calls) == 2:
                raise TradingError("injected failure between prefixes")
            return original(*args, **kwargs)
        with patch.object(self.writer.registry, "resolve", side_effect=fail_second):
            result = self.settle_expired()
        self.assertEqual(result["status"], "unknown", result)
        self.assertEqual(sorted((self.shared_state(operation_id), self.shared_state(legacy))), ["rejected", "unknown"])
        queried = len(self.income_queries())
        self.restart_writer()
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((self.shared_state(operation_id), self.shared_state(legacy)), ("rejected", "rejected"))
        self.assertEqual((result["status"], len(self.income_queries()), len(self.posts())), ("cooldown", queried, 1), result)
        self.assertNotIn("unsettled_transfers", self.state())

    def test_label_window_runs_to_expiry_when_the_shared_row_was_updated_late(self):
        operation_id = self.skip_timed_out_transfer()
        self.due(self.SPAN + 1)
        # A restore or late finish moved the shared row's expiry past the
        # span: a receipt after created + span but before expiry still counts.
        state = self.state()
        state["unsettled_transfers"][0]["created_at"] -= 200
        self.store.put("pair_margin:gold", state)
        created = self.follow_up()["created_at"]
        row = {"asset": "USD1", "incomeType": "TRANSFER", "tranId": "late-finish",
               "time": int((created + self.SPAN + 120) * 1000)}
        self.income_rows = {"long": [{**row, "income": "-1000.00000000"}], "short": [{**row, "income": "1000.00000000"}]}
        self.balances.update(long="2000", short="2000")
        self.assert_settled_once(operation_id, self.balancer.tick(self.pair, self.snapshots()), None, outcome="confirmed")

    def test_corrupt_before_receipts_drop_the_follow_up_and_the_sweep_settles(self):
        operation_id = self.skip_timed_out_transfer()
        state = self.state()
        state["unsettled_transfers"][0]["before_receipts"] = {"long": "TRANSFER:1"}
        self.store.put("pair_margin:gold", state)
        result = self.settle_expired()
        self.assertEqual((self.shared_state(operation_id), result["status"], len(self.income_queries())),
                         ("rejected", "cooldown", 0), result)
        self.assertNotIn("unsettled_transfers", self.state())

    def test_follow_up_from_the_previous_release_settles_by_expiry(self):
        operation_id = self.skip_timed_out_transfer()
        # Written by the evidence-based release: extra counters and receipts.
        state = self.state()
        record = state["unsettled_transfers"][0]
        record.pop("skipped_at", None)
        record.update(empty=0, failures=2, queried_at=record["created_at"] + 1,
                      evidence=[["long", "TRANSFER", "seen"]])
        self.store.put("pair_margin:gold", state)
        # Receipts that release already saw are not forgotten.
        self.assert_settled_once(operation_id, self.settle_expired(), "部分匹配")
        self.assertEqual(self.settlement(operation_id)["evidence"], [["long", "TRANSFER", "seen"]])

    def test_official_acknowledgement_is_durable_before_shared_finish(self):
        original = self.writer.registry.finish
        observed = []

        def finish(operation, outcome):
            if operation["operationId"].startswith("aster:transfer:") and outcome == "confirmed":
                state = self.state()
                pending = state["pending"]
                self.assertEqual(pending["status"], "acknowledged")
                self.assertEqual(pending["acknowledgement_code"], 200)
                self.assertEqual(operation["operationId"], "aster:transfer:" + pending["request_id"])
                self.assertEqual(state["last_transfer"], pending)
                self.assertEqual(len(self.posts()), 1)
                observed.append(operation["operationId"])
            return original(operation, outcome)

        with patch.object(self.writer.registry, "finish", side_effect=finish):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(observed), 1)
        self.assertEqual(self.unresolved(), [])

    def test_restart_settles_durable_no_send_without_importing_a_legacy_unknown(self):
        state = self.unsettled_rejection()
        evidence = state["last_transfer"]["writer_rejection"]
        writer = self.restart_writer()
        self.assertTrue(writer.ready, writer.error)
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "rejected"}])
        self.assertIsNone(self.state().get("pending"))
        self.assertIs(self.state()["last_transfer"]["writer_rejection"]["settled"], True)
        self.assertEqual(self.unresolved(), [])

    def test_failed_private_no_send_commit_preserves_the_unresolved_original(self):
        original = self.store.put
        failed_commits = []

        def put(key, value):
            last = value.get("last_transfer") if key == "pair_margin:gold" and isinstance(value, dict) else None
            if isinstance(last, dict) and isinstance(last.get("writer_rejection"), dict):
                failed_commits.append(deepcopy(last["writer_rejection"]))
                raise sqlite3.OperationalError("injected no-send journal failure")
            return original(key, value)

        with self.veto_next_send(), patch.object(self.store, "put", side_effect=put):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(failed_commits), 1)
        self.assertEqual(self.posts(), [], result)
        self.assertEqual(result["status"], "unknown", result)
        pending = self.state()["pending"]
        self.assertEqual(pending["status"], "submitting")
        self.assertNotIn("writer_rejection", pending)
        operation_id = "aster:transfer:" + pending["request_id"]
        self.assertEqual(self.shared_operations(), [{"operation_id": operation_id,
            "body_hash": failed_commits[0]["body_hash"], "state": "sending"}])
        # A later account refresh cannot manufacture the failed no-send proof.
        state = self.state()
        state["next_check_at"] = 0
        self.store.put("pair_margin:gold", state)
        self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(self.posts(), [])
        self.assertIn(self.shared_operations()[0]["state"], {"sending", "unknown"})

    def test_tampered_no_send_body_hash_or_account_fingerprint_cannot_settle_unknown(self):
        saved = self.unsettled_rejection()
        evidence = saved["last_transfer"]["writer_rejection"]
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]) as ticket:
            self.writer.registry.finish({**ticket, "operationId": evidence["operation_id"],
                "bodyHash": evidence["body_hash"]}, "unknown")
        for field in ("body_hash", "identity"):
            with self.subTest(field=field):
                state = deepcopy(saved)
                last = state["last_transfer"]
                if field == "body_hash":
                    last["writer_rejection"]["body_hash"] = "0" * 64
                else:
                    last["identity"] = "different-account-fingerprint"
                self.store.put("pair_margin:gold", state)
                with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
                    with self.assertRaises(TradingError):
                        self.writer.settle_transfer(self.pair, last)
                self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
                    "body_hash": evidence["body_hash"], "state": "unknown"}])
                self.assertIs(self.state()["last_transfer"]["writer_rejection"]["settled"], False)
                self.assertEqual(self.posts(), [])

    def test_next_tick_settles_durable_no_send_before_one_new_dispatch(self):
        state = self.unsettled_rejection()
        rejected = deepcopy(state["last_transfer"])
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        original = self.writer.registry.prepare
        prepared = []

        def prepare(ticket, operation_id, payload):
            if operation_id.startswith("aster:transfer:"):
                self.assertEqual(self.shared_operations(), [{"operation_id": rejected["writer_rejection"]["operation_id"],
                    "body_hash": rejected["writer_rejection"]["body_hash"], "state": "rejected"}])
                prepared.append(operation_id)
            return original(ticket, operation_id, payload)

        with patch.object(self.writer.registry, "prepare", side_effect=prepare):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(len(prepared), 1)
        self.assertNotEqual(prepared[0], rejected["writer_rejection"]["operation_id"])
        self.assertEqual({row["operation_id"]: row["state"] for row in self.shared_operations()},
            {rejected["writer_rejection"]["operation_id"]: "rejected", prepared[0]: "confirmed"})
        self.assertEqual(self.unresolved(), [])

    def test_unsettled_no_send_blocks_public_pair_changes_and_store_bypasses_until_restart(self):
        from fastapi.testclient import TestClient
        from trading.server import create_app

        state = self.unsettled_rejection()
        evidence = state["last_transfer"]["writer_rejection"]
        self.pair_manager()
        secret = "managed-margin-public-route-test"
        app = create_app(self.engine, start_engine=False, workspace_secret=secret)
        with TestClient(app, headers={"X-Workspace-Key": secret, "Origin": "http://testserver"}) as client:
            paused = client.post("/api/pairs/gold/pause")
            self.assertEqual(paused.status_code, 200, paused.text)
            self.pair = paused.json()["pair"]
            self.assertFalse(self.pair["enabled"])
            self.assertIs(self.state()["last_transfer"]["writer_rejection"]["settled"], False)

            deleted = client.delete("/api/pairs/gold")
            self.assertEqual(deleted.status_code, 409, deleted.text)
            self.assertIn("共享结算", deleted.json()["detail"])
            changed = client.patch("/api/pairs/gold", json={"margin": {"master_env_prefix": "ASTER_ALTERNATE"}})
            self.assertEqual(changed.status_code, 409, changed.text)
            self.assertIn("共享结算", changed.json()["detail"])
            self.assertEqual(self.store.pair("gold"), self.pair)

            with self.assertRaises(TradingError):
                self.store.delete_pair("gold")
            replacement = deepcopy(self.pair)
            replacement["margin"]["master_env_prefix"] = "ASTER_ALTERNATE"
            with self.assertRaises(TradingError):
                self.store.save_pair(replacement)
            self.assertEqual(self.store.pair("gold"), self.pair)
            self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
                "body_hash": evidence["body_hash"], "state": "sending"}])

            writer = self.restart_writer()
            self.assertTrue(writer.ready, writer.error)
            self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
                "body_hash": evidence["body_hash"], "state": "rejected"}])
            changed = client.patch("/api/pairs/gold", json={"margin": {"master_env_prefix": "ASTER_ALTERNATE"}})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(self.store.pair("gold")["margin"]["master_env_prefix"], "ASTER_ALTERNATE")
        self.assertEqual(self.posts(), [])

    def test_paused_disabled_margin_trader_settles_no_send_without_market_reads_or_dispatch(self):
        from trading.pair_execution import PairTrader

        state = self.unsettled_rejection()
        evidence = state["last_transfer"]["writer_rejection"]
        manager = self.pair_manager()
        self.pair = manager.enable("gold", False)
        disabled = deepcopy(self.pair)
        disabled["margin"]["enabled"] = False
        self.pair = self.store.save_pair(disabled)
        view = MarginBalancer.status_view(self.pair, self.state())
        self.assertEqual(view["status"], "blocked", view)
        self.assertTrue(view["blocks_trading"])
        requests_before = list(self.requests)
        trader = PairTrader(self.engine)
        with patch.object(trader, "_read", side_effect=AssertionError("unexpected market or account read")), \
                patch.object(self.engine.market, "book", side_effect=AssertionError("unexpected market book")):
            result = trader.tick(self.pair)
        self.assertEqual(result["phase"], "paused", result)
        self.assertEqual(result["margin"]["status"], "disabled", result)
        self.assertEqual(self.requests, requests_before)
        self.assertEqual(self.posts(), [])
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.assertFalse(self.store.pair("gold")["margin"]["enabled"])
        self.assertIs(self.state()["last_transfer"]["writer_rejection"]["settled"], True)
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "rejected"}])

    def test_explicit_exchange_rejection_releases_shared_transfer_and_allows_one_new_request(self):
        self.reject_code = -2019
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(len(self.posts()), 1)
        self.assertIsNone(self.state().get("pending"))
        self.assertIn("-2019", result["reason"])
        self.assertIn("-2019", result["error"])
        operation_id = "aster:transfer:" + self.state()["last_transfer"]["request_id"]
        self.assertEqual({row["operation_id"]: row["state"] for row in self.shared_operations()},
                         {operation_id: "rejected"})
        self.reject_code = None
        state = self.state()
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 2)
        self.assertIsNone(self.state().get("pending"))
        self.assertEqual(self.unresolved(), [])

    def test_unknown_execution_code_remains_unknown_without_an_automatic_retry(self):
        self.reject_code = -1007
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        self.assertEqual(len(self.posts()), 1)
        pending = self.state()["pending"]
        self.assertEqual(pending["status"], "unknown")
        operation_id = "aster:transfer:" + pending["request_id"]
        self.assertEqual({row["operation_id"]: row["state"] for row in self.shared_operations()},
                         {operation_id: "unknown"})
        self.reject_code = None
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "unknown", result)
        self.assertEqual(len(self.posts()), 1)

    def test_restart_settles_durable_remote_rejection_by_original_body_without_another_post(self):
        self.reject_code = -2019
        with patch.object(self.writer.registry, "finish", side_effect=RuntimeError("shared finish unavailable")), \
                patch.object(self.writer, "settle_transfer", side_effect=RuntimeError("shared settlement unavailable")):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1, result)
        state = self.state()
        self.assertIsNone(state.get("pending"))
        last = state["last_transfer"]
        self.assertEqual(last["status"], "rejected")
        self.assertEqual(last["exchange_rejection_code"], -2019)
        evidence = last["writer_rejection"]
        self.assertEqual(set(evidence), {"schema_version", "operation_id", "body_hash", "request_sent", "settled", "exchange_code"})
        self.assertEqual(evidence["schema_version"], 1)
        self.assertIs(evidence["request_sent"], True)
        self.assertIs(evidence["settled"], False)
        self.assertIs(type(evidence["exchange_code"]), int)
        self.assertEqual(evidence["exchange_code"], -2019)
        self.assertEqual(evidence["operation_id"], "aster:transfer:" + last["request_id"])
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "sending"}])
        self.reject_code = None
        writer = self.restart_writer()
        self.assertTrue(writer.ready, writer.error)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "rejected"}])
        self.assertIs(self.state()["last_transfer"]["writer_rejection"]["settled"], True)
        self.assertEqual(self.unresolved(), [])

    def test_success_then_explicit_remote_rejection_does_not_reject_the_whole_batch(self):
        transfer = self.transfer_api(self.credentials["master"])
        self.writer.bind_api(transfer, "master:ASTER_MASTER")
        params = {"fromAccountAddress": self.credentials["long"]["user"],
            "toAccountAddress": self.credentials["short"]["user"], "asset": "USD1",
            "amount": "1000.00000000", "kindType": "FUTURE_FUTURE"}
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            with self.assertRaises(TransferRejected) as rejected:
                with self.writer.batch("aster:transfer:success-before-rejection", params):
                    transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
                    self.reject_code = -2019
                    transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
        self.assertEqual(rejected.exception.code, -2019)
        self.assertEqual(len(self.posts()), 2)
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [("aster:transfer:success-before-rejection", "unknown")])


    def test_rate_limit_deadline_survives_exit_after_proof_commit_and_new_process_budgets(self):
        created = time.time()
        self.reject_code = -1003
        with patch("time.time", return_value=created), \
                patch.object(self.writer.registry, "finish", side_effect=SystemExit("exit after durable rejection")):
            with self.assertRaises(SystemExit):
                self.balancer.tick(self.pair, self.snapshots())
        state = self.state()
        self.assertIsNone(state.get("pending"))
        last = state["last_transfer"]
        self.assertEqual(last["status"], "rejected")
        self.assertEqual(last["created_at"], created)
        self.assertIsInstance(state.get("api_notice"), dict)
        self.assertGreaterEqual(state["next_check_at"], created + 180)
        evidence = last["writer_rejection"]
        self.assertEqual(evidence["exchange_code"], -1003)
        self.assertIs(evidence["request_sent"], True)
        self.assertIs(evidence["settled"], False)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "sending"}])

        self.reject_code = None
        with patch("time.time", return_value=created + 31):
            # New process budgets have no in-memory cooldown; the journal alone
            # must retain the exchange's full 180-second retry deadline.
            old_budgets = [broker.api.budget for broker in self.engine.brokers.values()]
            for broker in self.engine.brokers.values():
                broker.api.budget = RateBudget()
                self.assertNotIn(broker.api.budget, old_budgets)
                broker.api.budget.require_available(5)
            writer = self.restart_writer()
            self.assertTrue(writer.ready, writer.error)
            self.balancer = MarginBalancer(self.engine)
            for broker in self.engine.brokers.values():
                broker.api.budget.require_available(5)
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "waiting", result)
        self.assertEqual(len(self.posts()), 1, result)
        self.assertGreaterEqual(self.state()["next_check_at"], created + 180)
        self.assertEqual(self.shared_operations(), [{"operation_id": evidence["operation_id"],
            "body_hash": evidence["body_hash"], "state": "rejected"}])

    def test_caught_remote_rejection_after_success_keeps_a_normally_exited_batch_unknown(self):
        transfer = self.transfer_api(self.credentials["master"])
        self.writer.bind_api(transfer, "master:ASTER_MASTER")
        params = {"fromAccountAddress": self.credentials["long"]["user"],
            "toAccountAddress": self.credentials["short"]["user"], "asset": "USD1",
            "amount": "1000.00000000", "kindType": "FUTURE_FUTURE"}
        with self.writer.accounts(["long", "short", "master:ASTER_MASTER"]):
            with self.writer.batch("aster:transfer:caught-rejection-after-success", params):
                transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
                self.reject_code = -2019
                with self.assertRaises(TransferRejected) as rejected:
                    transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
                self.assertEqual(rejected.exception.code, -2019)
        self.assertEqual(len(self.posts()), 2)
        self.assertEqual([(row["operationId"], row["state"]) for row in self.unresolved()],
                         [("aster:transfer:caught-rejection-after-success", "unknown")])


if __name__ == "__main__":
    unittest.main()

"""Margin transfers through the real managed writer and HTTPX dispatch hooks."""
from contextlib import closing, nullcontext
from copy import deepcopy
import os
from pathlib import Path
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
from trading.models import TradingError
from trading.pairing import PairManager, validate_pair
from trading.paper import DemoMarket
from trading.store import Store
from trading.workspace_control import WorkspaceControl


CORE = Path(__file__).resolve().parents[3] / "server" / "execution" / "account_writer.py"


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
            "note": "两侧流水均无该笔划转", "settled_at": self.settlement(operation_id)["settled_at"]})
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
        self.assertIn("核实到账", result["reason"])
        self.assertEqual(len(self.posts()), 1, result)
        self.assertEqual(len(self.income_queries()), 2)
        self.assertIn(["TRANSFER", "late-1"], self.state()["used_receipts"])
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual(self.settlement(operation_id)["outcome"], "confirmed")

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
        self.assertEqual(self.state()["unsettled_transfers"][0]["label"], {"note": "两侧流水均无该笔划转"})
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual((result["status"], self.shared_state(operation_id), len(self.income_queries())), ("cooldown", "rejected", 2))

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
                self.income_rows = {}
                self.balances.update(long="3000", short="1000")
                self.due()

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
        queried = len(self.income_queries())
        self.restart_writer()
        self.due()
        result = self.balancer.tick(self.pair, self.snapshots())
        # The follow-up clears without another read; the old row stays rejected
        # and only a new request from fresh balances is sent.
        self.assertNotIn("unsettled_transfers", self.state())
        self.assertEqual((self.shared_state(operation_id), len(self.income_queries())), ("rejected", queried))
        self.assertEqual((result["status"], len(self.posts())), ("acknowledged", 2), result)
        self.assertEqual(self.unresolved(), [])

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
        self.assert_settled_once(operation_id, self.settle_expired(), "两侧流水均无该笔划转")

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

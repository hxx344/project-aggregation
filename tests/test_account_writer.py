import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "execution"))
from account_writer import AccountWriter, AccountWriterError, account_key


def identity(account_id="112233445566", **extra):
    return {"authority": "binance", "environment": "mainnet", "accountId": account_id, **extra}


def margin_identities():
    return [{"authority": "aster", "environment": "mainnet", "accountId": "0x" + str(index) * 40} for index in (1, 2, 3)]


def margin_payload(values=None, amount="12.3456789"):
    values = margin_identities() if values is None else values
    return {"marginTransfer": {"version": 1, "method": "POST", "path": "/fapi/v3/subAccountTransfer",
            "params": {"fromAccountAddress": values[0]["accountId"], "toAccountAddress": values[1]["accountId"], "asset": "USD1", "amount": amount, "kindType": "FUTURE_FUTURE"},
            "source": dict(values[0]), "destination": dict(values[1]), "master": dict(values[2])}}


def legacy_order(client="legacy-L", **extra):
    return {"symbol": "BTCUSDT", "side": "BUY", "positionSide": "LONG", "type": "MARKET", "quantity": "0.01000", "newClientOrderId": client, "newOrderRespType": "RESULT", **extra}


def legacy_wrappers():
    return [
        {"symbol": "BTCUSDT", "target": 20},
        {"id": "pair-intent", "kind": "pair", "symbol": "BTCUSDT", "orders": [legacy_order("intent")], "target": None},
        {"id": "leverage-intent", "kind": "leverage", "symbol": "BTCUSDT", "orders": None, "target": "20"},
        {"id": "pair-pending", "request_id": None, "kind": "ordinary", "symbol": "BTCUSDT", "target_leverage": None, "amount": None, "source": None, "destination": None, "orders": [legacy_order("pending")]},
        {"id": "cycle-pending", "request_id": None, "kind": "cycle", "symbol": "BTCUSDT", "target_leverage": None, "amount": None, "source": None, "destination": None, "orders": [legacy_order("cycle")]},
        {"id": "leverage-pending", "request_id": None, "kind": "leverage", "symbol": "BTCUSDT", "target_leverage": 20, "amount": None, "source": None, "destination": None, "orders": []},
        {"id": "cycle-intent", "kind": "cycle", "symbol": "BTCUSDT", "orders": [legacy_order("cycle-intent")], "target": None},
        {"id": "migration-intent", "kind": "migration", "symbol": "SPCXUSD1", "orders": [legacy_order("migration-open", symbol="SPCXUSD1"), legacy_order("migration-close", symbol="XAUUSD1", side="SELL")], "target": None},
        {"id": "historical-cycle-leverage", "kind": "cycle_leverage", "symbol": "XAUUSD1", "orders": None, "target": 2},
    ]


def subset_ticket(ticket, keys):
    return {**ticket, "claims": [row for row in ticket["claims"] if row["accountKey"] in keys], "bindings": [row for row in ticket["bindings"] if row["accountKey"] in keys]}


class AccountWriterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="account-writer-py-")
        self.database_path = str(Path(self.directory.name) / "execution-control.sqlite")
        self.writers = []

    def tearDown(self):
        for writer in self.writers:
            try:
                writer.close()
            except AccountWriterError as error:
                if error.code not in ("REGISTRY_MISSING", "REGISTRY_REPLACED"):
                    raise
        self.directory.cleanup()

    def writer(self, module="greeks", **kwargs):
        writer = AccountWriter(self.database_path, module, f"test-{len(self.writers)}", **kwargs)
        self.writers.append(writer)
        return writer

    def ticket(self, writer, values=None):
        values = [identity()] if values is None else values
        for index, value in enumerate(values):
            writer.bind(f"connection-{index}", value, 1)
        return writer.claim(values)

    def error(self, expected, action):
        with self.assertRaises(AccountWriterError) as context:
            action()
        self.assertEqual(context.exception.code, expected)

    def recovery(self, **update):
        with closing(sqlite3.connect(self.database_path)) as database:
            old = json.loads(database.execute("SELECT value FROM aw_meta WHERE key='recovery_state'").fetchone()[0])
            value = {**old, **update}
            database.execute("UPDATE aw_meta SET value=? WHERE key='recovery_state'", (json.dumps(value),))
            database.commit()
            return value

    def test_six_legacy_unknown_orders_admit_only_strict_t0_after_lossless_backfill(self):
        writer = self.writer("aster")
        values = margin_identities()
        ticket = self.ticket(writer, values)
        originals = []
        for index in range(6):
            payload = {"order": legacy_order(f"old-{index}", **({"side": "SELL", "positionSide": "SHORT"} if index % 2 else {}))}
            original_ticket = subset_ticket(ticket, [account_key(values[index % 2])])
            operation_id = "aster:legacy:order:" + payload["order"]["newClientOrderId"]
            writer.import_unknown(original_ticket, operation_id, payload)
            originals.append((operation_id, payload, original_ticket))
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("UPDATE aw_operations SET intent_action=NULL,intent_target_hash=NULL")
            database.commit()
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "before-backfill", margin_payload()))
        for operation_id, payload, original_ticket in originals:
            with closing(sqlite3.connect(self.database_path)) as database:
                before = database.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            writer.import_unknown(original_ticket, operation_id, payload)
            with closing(sqlite3.connect(self.database_path)) as database:
                after = database.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            self.assertEqual(after[:-2], before[:-2])
            self.assertEqual(after[-2], "order")
            self.assertEqual(after[-1], after[2])
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "ordinary", {"order": legacy_order("new")}))
        transfer = writer.prepare(ticket, "opaque-request", margin_payload())
        self.assertTrue(writer.assert_owned(transfer))
        with closing(sqlite3.connect(self.database_path)) as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM aw_operations WHERE operation_id LIKE 'aster:legacy:order:%' AND state='unknown'").fetchone()[0], 6)
        writer.finish(transfer, "unknown")
        self.error("OPERATION_UNRESOLVED", lambda: writer.prepare(ticket, "opaque-request", margin_payload()))
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "different-request", margin_payload()))

    def test_margin_contract_rejects_forgery_and_exact_identity_or_amount_changes(self):
        writer = self.writer("aster")
        values = margin_identities()
        ticket = self.ticket(writer, values)
        for amount in (0, 1, True, "0", "-1", "01", "+1", "1e2", " 1", "0.000000001", "1000000000.00000001", "1000000001"):
            with self.subTest(amount=amount):
                self.error("INVALID_MARGIN_TRANSFER", lambda: writer.prepare(ticket, str(uuid.uuid4()), margin_payload(amount=amount)))
        cases = [
            ("method", "DELETE"), ("path", "/fapi/v1/subAccountTransfer"), ("version", True), ("purpose", "margin"),
            ("source", {**values[0], "environment": "testnet"}), ("source", {**values[0], "authority": "binance"}),
            ("master", values[0]), ("master", {**values[2], "parentAccountId": values[0]["accountId"]}),
        ]
        for key, value in cases:
            payload = margin_payload()
            payload["marginTransfer"][key] = value
            self.error("INVALID_MARGIN_TRANSFER", lambda: writer.prepare(ticket, str(uuid.uuid4()), payload))
        for key, value in (("asset", "USDT"), ("kindType", "SPOT_FUTURE"), ("fromAccountAddress", values[2]["accountId"]), ("toAccountAddress", values[2]["accountId"]), ("extra", "hidden")):
            payload = margin_payload()
            payload["marginTransfer"]["params"][key] = value
            self.error("INVALID_MARGIN_TRANSFER", lambda: writer.prepare(ticket, str(uuid.uuid4()), payload))
        payload = {**margin_payload(), "purpose": "T0"}
        self.error("INVALID_MARGIN_TRANSFER", lambda: writer.prepare(ticket, "extra-top", payload))
        self.error("INVALID_MARGIN_TRANSFER", lambda: writer.prepare(subset_ticket(ticket, [account_key(value) for value in values[:2]]), "missing-master", margin_payload()))
        other = self.writer("other")
        self.error("INVALID_MARGIN_TRANSFER", lambda: other.prepare(ticket, "other-module", margin_payload()))

    def test_unknown_payloads_and_transfer_unknown_block_both_prepare_and_final_guard(self):
        writer = self.writer("aster")
        ticket = self.ticket(writer, margin_identities())
        transfer = writer.prepare(ticket, "margin", margin_payload(amount="0.00000001"))
        bad = [
            {"kind": "order", "purpose": "margin"}, {"order": legacy_order(extra="hidden")},
            {"order": legacy_order(quantity="0")}, {"order": legacy_order(newClientOrderId="")},
            {"method": "POST", "path": "/fapi/v3/subAccountTransfer", "params": {"asset": "USD1"}},
            {"method": "POST", "path": "/fapi/v3/order", "params": {"symbol": "BTCUSDT"}},
            {"method": "POST", "path": "/fapi/v3/batchOrders", "params": {"batchOrders": "broken"}},
            {"method": "POST", "path": "/fapi/v3/leverage", "params": {"symbol": "BTCUSDT", "leverage": 20, "amount": "1"}},
            margin_payload(),
        ]
        for index, payload in enumerate(bad):
            operation_id = f"late-{index}"
            writer.import_unknown(ticket, operation_id, payload)
            self.error("ACCOUNT_UNRESOLVED", lambda: writer.assert_owned(transfer))
            self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "another", margin_payload()))
            writer.resolve(operation_id, ticket, "rejected")
        self.assertTrue(writer.assert_owned(transfer))
        self.error("INVALID_INTENT_TARGET", lambda: writer.import_unknown(ticket, "forged-amend", {"intentAction": "amend", "intentTarget": {"accountKey": account_key(margin_identities()[0]), "symbol": "BTCUSDT", "clientOrderId": "old"}, "transfer": {"amount": "1"}}))

    def test_active_sending_blocks_t0_but_fenced_historical_sending_remains_preserved(self):
        writer = self.writer("aster")
        values = margin_identities()
        ticket = self.ticket(writer, values)
        old = writer.prepare(ticket, "active", {"order": legacy_order()})
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "blocked", margin_payload()))
        writer.bind("connection-0", values[0], 2)
        rebound = writer.claim(values)
        self.assertEqual(rebound["claims"], ticket["claims"])
        self.error("BINDING_CHANGED", lambda: writer.assert_owned(old))
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(rebound, "after-binding-generation", margin_payload()))
        writer.close()
        old_alive = [True]
        successor = self.writer("aster", process_alive=lambda pid: old_alive[0])
        current = successor.claim(values)
        self.error("ACCOUNT_UNRESOLVED", lambda: successor.prepare(current, "closed-owner-still-alive", margin_payload()))
        old_alive[0] = False
        transfer = successor.prepare(current, "after-fence", margin_payload(amount="1000000000"))
        self.assertTrue(successor.assert_owned(transfer))
        invalid_tickets = []
        invalid = json.loads(json.dumps(ticket))
        invalid["bindings"] = []
        invalid_tickets.append(invalid)
        invalid = json.loads(json.dumps(ticket))
        invalid["bindings"][0]["generation"] = "1"
        invalid_tickets.append(invalid)
        for invalid in invalid_tickets:
            with closing(sqlite3.connect(self.database_path)) as database:
                database.execute("UPDATE aw_operations SET ticket_json=? WHERE operation_id='active'", (json.dumps(invalid),))
                database.commit()
            self.error("ACCOUNT_UNRESOLVED", lambda: successor.assert_owned(transfer))
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("UPDATE aw_operations SET ticket_json=? WHERE operation_id='active'", (json.dumps(ticket),))
            database.commit()
        self.assertTrue(successor.assert_owned(transfer))
        old_alive[0] = True
        self.error("ACCOUNT_UNRESOLVED", lambda: successor.assert_owned(transfer))
        old_alive[0] = False
        with closing(sqlite3.connect(self.database_path)) as database:
            self.assertEqual(database.execute("SELECT state FROM aw_operations WHERE operation_id=?", (old["operationId"],)).fetchone()[0], "sending")
            previous = database.execute("SELECT ticket_json,owner_id FROM aw_operations WHERE operation_id='active'").fetchone()
            database.execute("UPDATE aw_operations SET ticket_json=?,owner_id=? WHERE operation_id='active'", (json.dumps(current), current["ownerId"]))
            database.commit()
        self.error("ACCOUNT_UNRESOLVED", lambda: successor.assert_owned(transfer))
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("UPDATE aw_operations SET ticket_json=?,owner_id=? WHERE operation_id='active'", previous)
            database.commit()
        self.assertTrue(successor.assert_owned(transfer))
        self.recovery(state="quarantine", recoveryId=str(uuid.uuid4()))
        self.error("RECOVERY_REQUIRED", lambda: successor.assert_owned(transfer))
        self.recovery(state="retired", handoffId=str(uuid.uuid4()))
        self.error("AUTHORITY_RETIRED", lambda: successor.assert_owned(transfer))

    def test_classification_backfill_rejects_different_body_or_existing_classification(self):
        writer = self.writer("aster")
        ticket = self.ticket(writer, margin_identities())
        payload = {"order": legacy_order()}
        writer.import_unknown(ticket, "legacy", payload)
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("UPDATE aw_operations SET intent_action=NULL,intent_target_hash=NULL WHERE operation_id='legacy'")
            database.commit()
        self.error("OPERATION_CONFLICT", lambda: writer.import_unknown(ticket, "legacy", {"order": legacy_order("changed")}))
        writer.import_unknown(ticket, "legacy", payload)
        for action in ("leverage", None):
            with closing(sqlite3.connect(self.database_path)) as database:
                database.execute("UPDATE aw_operations SET intent_action=? WHERE operation_id='legacy'", (action,))
                database.commit()
            self.error("OPERATION_CONFLICT", lambda: writer.import_unknown(ticket, "legacy", payload))

    def test_actual_legacy_wrappers_backfill_losslessly_and_reject_funded_or_invalid_wrappers(self):
        writer = self.writer("aster")
        ticket = self.ticket(writer, margin_identities())
        for index, payload in enumerate(legacy_wrappers()):
            operation_id = f"wrapper-{index}"
            writer.import_unknown(ticket, operation_id, payload)
            with closing(sqlite3.connect(self.database_path)) as database:
                database.execute("UPDATE aw_operations SET intent_action=NULL,intent_target_hash=NULL WHERE operation_id=?", (operation_id,))
                database.commit()
                before = database.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            writer.import_unknown(ticket, operation_id, payload)
            with closing(sqlite3.connect(self.database_path)) as database:
                after = database.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            self.assertEqual(after[:-2], before[:-2])
            self.assertIn(after[-2], ("order", "leverage"))
            self.assertEqual(after[-1], before[2])
        transfer = writer.prepare(ticket, "wrapper-margin", margin_payload())
        self.assertTrue(writer.assert_owned(transfer))
        wrappers = legacy_wrappers()
        bad = [
            {"symbol": "BTCUSDT", "target": value} for value in (0, True, 126, "20.5")
        ] + [
            {**wrappers[0], "kind": "leverage"}, {**wrappers[1], "target": 20}, {**wrappers[1], "orders": []},
            {**wrappers[1], "orders": [legacy_order("wrong", symbol="ETHUSDT")]},
            {**wrappers[1], "orders": [legacy_order("duplicate"), legacy_order("duplicate")]},
            {**wrappers[2], "orders": []}, {**wrappers[2], "target": "20.5"},
            {**wrappers[3], "amount": "1"}, {**wrappers[3], "source": "wallet"}, {**wrappers[3], "destination": "wallet"},
            {**wrappers[3], "kind": "transfer"}, {**wrappers[3], "target_leverage": 20},
            {**wrappers[5], "orders": [legacy_order()]}, {**wrappers[5], "request_id": ""},
            {**wrappers[6], "orders": [legacy_order("wrong-cycle-symbol", symbol="ETHUSDT")]},
            {**wrappers[7], "kind": "unknown-strategy"}, {**wrappers[7], "target": 20},
            {**wrappers[7], "orders": [legacy_order("bad-migration", symbol="SPCXUSD1", quantity="0")]},
            {**wrappers[7], "orders": [legacy_order("duplicate-migration"), legacy_order("duplicate-migration")]},
            {**wrappers[8], "orders": []}, {**wrappers[8], "target": 0},
            {key: value for key, value in wrappers[3].items() if key != "amount"},
        ]
        for index, payload in enumerate(bad):
            operation_id = f"bad-wrapper-{index}"
            writer.import_unknown(ticket, operation_id, payload)
            with closing(sqlite3.connect(self.database_path)) as database:
                self.assertIsNone(database.execute("SELECT intent_action FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()[0])
            self.error("ACCOUNT_UNRESOLVED", lambda: writer.assert_owned(transfer))
            writer.resolve(operation_id, ticket, "rejected")
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "ordinary-still-blocked", {"order": legacy_order("new")}))
        writer.import_unknown(ticket, "transfer-unknown", margin_payload())
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.assert_owned(transfer))

    def test_live_sender_past_final_guard_stays_exclusive_after_generation_change_or_close(self):
        writer = self.writer("aster")
        values = margin_identities()
        ticket = self.ticket(writer, values)
        operation = writer.prepare(ticket, "barrier-order", {"order": legacy_order("barrier")})
        admitted, release = threading.Event(), threading.Event()
        sent, failures = [], []
        def transport():
            try:
                writer.assert_owned(operation)
                admitted.set()
                if not release.wait(5):
                    raise TimeoutError("transport barrier timed out")
                sent.append("old-order")
            except Exception as error:
                failures.append(error)
        sender = threading.Thread(target=transport)
        sender.start()
        try:
            self.assertTrue(admitted.wait(5))
            writer.bind("connection-0", values[0], 2)
            current = writer.claim(values)
            self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(current, "after-generation", margin_payload()))
            writer.close()
            successor = self.writer("aster")
            current = successor.claim(values)
            self.error("ACCOUNT_UNRESOLVED", lambda: successor.prepare(current, "closed-live", margin_payload()))
        finally:
            release.set()
            sender.join(5)
        self.assertFalse(sender.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(sent, ["old-order"])

    def test_quarantine_preserves_recovery_but_rejects_new_and_late_send(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        operation = writer.prepare(ticket, "before-restore", {"clientId": "original"})
        gate = self.recovery(state="quarantine", recoveryId=str(uuid.uuid4()), admittedTarget={"accountId": "never-leak"})
        self.assertEqual(writer.recovery_protection_version, 1)
        self.assertEqual(writer.recoveryProtectionVersion, 1)
        self.error("RECOVERY_REQUIRED", lambda: writer.assert_owned(operation))
        self.error("RECOVERY_REQUIRED", lambda: writer.prepare(ticket, "after-restore", {}))
        self.assertTrue(writer.assert_owned(operation, 0))
        writer.finish(operation, "unknown")
        writer.close()
        recovery = self.writer()
        recovered = recovery.claim([identity()])
        self.assertEqual(recovery.import_unknown(recovered, "before-restore", {"clientId": "original"})["state"], "unknown")
        recovery.resolve("before-restore", recovered)
        self.assertEqual(recovery.import_unknown(recovered, "imported-recovery", {})["state"], "unknown")
        recovery.resolve("imported-recovery", recovered, "rejected")
        self.error("RECOVERY_REQUIRED", lambda: recovery.assert_owned(recovered, 1))
        self.assertEqual(recovery.snapshot()["recovery"]["authorityId"], gate["authorityId"])
        self.assertNotIn("never-leak", json.dumps(recovery.snapshot()))

    def test_retired_authority_rejects_zero_budget_and_constructor(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        operation = writer.prepare(ticket, "late-result", {})
        self.recovery(state="retired", handoffId=str(uuid.uuid4()))
        for action in [lambda: writer.assert_owned(ticket), lambda: writer.assert_owned(operation, 0), lambda: writer.finish(operation, "confirmed"), lambda: writer.import_unknown(ticket, "late-import", {}), lambda: writer.resolve("late-result", ticket), lambda: writer.claim([identity()]), lambda: writer.bind("other", identity("101"), 1), self.writer]:
            self.error("AUTHORITY_RETIRED", action)
        self.assertEqual(writer.snapshot()["recovery"]["state"], "retired")
        writer.close()

    def test_invalid_missing_or_unknown_recovery_metadata_is_not_repaired(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        good = writer.snapshot()["recovery"]
        cases = [("{", "INVALID_RECOVERY_STATE"), (json.dumps({**good, "schemaVersion": 2}), "UNSUPPORTED_RECOVERY_SCHEMA"), (json.dumps({**good, "schemaVersion": True}), "INVALID_RECOVERY_STATE"), (json.dumps({**good, "authorityId": "invalid"}), "INVALID_RECOVERY_STATE"), (json.dumps({**good, "admittedTarget": []}), "INVALID_RECOVERY_STATE"), (None, "INVALID_RECOVERY_STATE")]
        for raw, expected in cases:
            with closing(sqlite3.connect(self.database_path)) as database:
                database.execute("DELETE FROM aw_meta WHERE key='recovery_state'")
                if raw is not None:
                    database.execute("INSERT INTO aw_meta VALUES ('recovery_state',?)", (raw,))
                database.commit()
            self.error(expected, lambda: writer.assert_owned(ticket, 0))
            self.error(expected, self.writer)
            self.error(expected, writer.snapshot)
        writer.close()

    def test_m1_initialization_preserves_new_authority_on_subsequent_start(self):
        old = self.writer()
        old.close()
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("DELETE FROM aw_meta WHERE key IN ('recovery_state','recovery_schema')")
            database.commit()
        first = self.writer()
        second = self.writer("hub")
        self.assertEqual(first.snapshot()["recovery"], second.snapshot()["recovery"])
        self.assertEqual(first.snapshot()["recovery"]["state"], "normal")

    def test_published_m1_and_m2_registry_never_recreate_missing_marker(self):
        writer = self.writer()
        writer.close()
        marker = Path(self.database_path + ".required")
        for state in ("normal", "quarantine", "retired"):
            self.recovery(state=state)
            body = marker.read_bytes()
            before = Path(self.database_path).read_bytes()
            marker.unlink()
            self.error("REGISTRY_MISSING", self.writer)
            self.assertFalse(marker.exists())
            self.assertEqual(Path(self.database_path).read_bytes(), before)
            marker.write_bytes(body)
            marker.chmod(0o600)
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("DELETE FROM aw_meta WHERE key IN ('recovery_schema','recovery_state')")
            database.commit()
        marker.unlink()
        self.error("REGISTRY_MISSING", self.writer)
        self.assertFalse(marker.exists())

    def test_normal_registry_clone_without_marker_does_not_rebind(self):
        writer = self.writer()
        writer.close()
        copied = Path(self.directory.name) / "copied.sqlite"
        before = Path(self.database_path).read_bytes()
        copied.write_bytes(before)
        copied.chmod(0o600)
        self.database_path = str(copied)
        self.error("REGISTRY_MISSING", self.writer)
        self.assertFalse(Path(str(copied) + ".required").exists())
        self.assertEqual(copied.read_bytes(), before)

    def test_rejected_registry_with_crash_wal_is_read_only(self):
        script = 'import os,sys; sys.path.insert(0,sys.argv[2]); from account_writer import AccountWriter; w=AccountWriter(sys.argv[1],"greeks","crashed"); os._exit(0)'
        result = subprocess.run([sys.executable, "-I", "-B", "-c", script, self.database_path, str(Path(__file__).resolve().parents[1] / "server" / "execution")], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        wal = Path(self.database_path + "-wal")
        self.assertGreater(wal.stat().st_size, 0)
        Path(self.database_path + ".required").unlink()
        main_before, wal_before = Path(self.database_path).read_bytes(), wal.read_bytes()
        self.error("REGISTRY_MISSING", self.writer)
        self.assertEqual(Path(self.database_path).read_bytes(), main_before)
        self.assertEqual(wal.read_bytes(), wal_before)
        self.assertFalse(Path(self.database_path + ".required").exists())

    def test_identity_and_binding_revision(self):
        self.assertEqual(account_key(identity("000123")), account_key(identity("123", parentAccountId="5")))
        self.assertNotEqual(account_key(identity("124", parentAccountId="5")), account_key(identity("123", parentAccountId="5")))
        self.assertNotEqual(account_key(identity("123")), account_key(identity("123", environment="demo")))
        writer = self.writer()
        old = self.ticket(writer)
        writer.bind("connection-0", identity(), 2)
        self.error("BINDING_CHANGED", lambda: writer.assert_owned(old, 0))
        new = writer.claim([identity()])
        self.assertEqual(new["claims"], old["claims"])
        writer.release_binding("connection-0")
        writer.bind("connection-0", identity(), 2)
        self.error("BINDING_CHANGED", lambda: writer.assert_owned(new, 0))
        self.assertGreater(writer.claim([identity()])["bindings"][0]["generation"], new["bindings"][0]["generation"])

    def test_atomic_claim_and_permanent_module_pin(self):
        first = self.writer()
        self.ticket(first)
        first.close()
        other = self.writer("hub")
        other.bind("a", identity(), 1)
        other.bind("b", identity("31"), 1)
        self.error("ACCOUNT_PINNED", lambda: other.claim([identity("31"), identity()]))
        with closing(sqlite3.connect(self.database_path)) as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM aw_accounts WHERE module_id='hub'").fetchone()[0], 0)

    def test_alive_dead_takeover_and_fence(self):
        first = self.writer(now=lambda: 1000)
        old = self.ticket(first)
        alive = self.writer(now=lambda: 100000)
        self.error("OWNER_ALIVE", lambda: alive.claim([identity()]))
        new = self.writer(now=lambda: 100000, process_alive=lambda pid: False)
        ticket = new.claim([identity()])
        self.assertEqual(ticket["claims"][0]["fence"], old["claims"][0]["fence"] + 1)
        self.error("OWNERSHIP_LOST", lambda: first.assert_owned(old, 0))
        self.error("WRITER_RETIRED", lambda: first.claim([identity()]))

    def test_expiry_and_rollback_never_resurrect(self):
        current = [1000]
        writer = self.writer(now=lambda: current[0])
        ticket = self.ticket(writer)
        current[0] += 20000
        writer.assert_owned(ticket)
        current[0] += 60000
        self.error("LEASE_EXPIRED", lambda: writer.assert_owned(ticket, 0))
        current[0] -= 100
        self.error("WRITER_RETIRED", lambda: writer.claim([identity()]))
        rollback = self.writer("hub", now=lambda: current[0])
        rollback_ticket = self.ticket(rollback, [identity("51")])
        current[0] -= 1
        self.error("CLOCK_ROLLBACK", lambda: rollback.assert_owned(rollback_ticket, 0))

    def test_unknown_recovery_ledger_and_forbidden_payload(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        payload = {"clientId": "original", "quantity": 0.1}
        for key in ("apiKey", "secret_key", "signature", "timestamp", "nonce"):
            self.error("UNSAFE_PAYLOAD", lambda key=key: writer.prepare(ticket, "unsafe", {key: "DO-NOT-PERSIST"}))
        operation = writer.prepare(ticket, "original", payload)
        writer.finish(operation, "unknown")
        self.error("OPERATION_UNRESOLVED", lambda: writer.prepare(ticket, "original", payload))
        self.error("OPERATION_CONFLICT", lambda: writer.prepare(ticket, "original", {"quantity": "2"}))
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "next", payload))
        writer.import_unknown(ticket, "legacy-one", {"clientId": "one"})
        writer.import_unknown(ticket, "legacy-two", {"clientId": "two"})
        self.assertEqual(len(writer.unresolved(ticket)), 3)
        writer.resolve("original", ticket)
        writer.resolve("legacy-one", ticket, "rejected")
        writer.resolve("legacy-two", ticket)
        self.assertEqual(writer.import_unknown(ticket, "legacy-one", {"clientId": "one"})["state"], "rejected")
        self.error("ALREADY_SUBMITTED", lambda: writer.prepare(ticket, "original", payload))
        self.assertNotIn("112233445566", json.dumps(writer.snapshot()))

    def test_unknown_scope_and_freeze(self):
        first = self.writer()
        first.bind("legacy", None, 1, {"authority": "binance", "environment": "mainnet"})
        other = self.writer("hub")
        other.bind("actual", identity(), 1)
        self.error("UNVERIFIED_BINDING", lambda: other.claim([identity()]))
        first.release_binding("legacy")
        ticket = other.claim([identity()])
        first.bind("legacy", identity(), 2)
        first.freeze([identity()])
        self.error("ACCOUNT_ISOLATED", lambda: other.assert_owned(ticket, 0))
        self.assertEqual(other.snapshot()["isolations"][0]["reason"], "legacy-conflict")

    def test_group_sending_allows_pair_unknown_and_new_owner_still_block(self):
        writer = self.writer()
        ticket = self.ticket(writer, [identity("71"), identity("72")])
        first = writer.prepare(ticket, "first", {"groupId": "trusted-pair", "leg": 1})
        writer.prepare(ticket, "second", {"groupId": "trusted-pair", "leg": 2})
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "other", {"groupId": "another"}))
        writer.finish(first, "unknown")
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "third", {"groupId": "trusted-pair", "leg": 3}))
        writer.resolve("first", ticket)
        writer.close()
        replacement = self.writer()
        current = replacement.claim([identity("71"), identity("72")])
        self.error("ACCOUNT_UNRESOLVED", lambda: replacement.prepare(current, "third", {"groupId": "trusted-pair", "leg": 3}))
        replacement.resolve("second", current)
        self.assertEqual(replacement.prepare(current, "third", {"groupId": "trusted-pair", "leg": 3})["state"], "sending")

    def test_late_operation_send_and_zero_budget_writeback(self):
        writer = self.writer()
        ticket = self.ticket(writer, [identity("71"), identity("72")])
        first = writer.prepare(ticket, "one", {"groupId": "pair", "leg": 1})
        second = writer.prepare(ticket, "two", {"groupId": "pair", "leg": 2})
        self.assertTrue(writer.assert_owned(second, 35000))
        writer.finish(first, "unknown")
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.assert_owned(second, 35000))
        self.error("OPERATION_UNRESOLVED", lambda: writer.assert_owned(first, 35000))
        self.error("OPERATION_CONFLICT", lambda: writer.assert_owned({**second, "bodyHash": "wrong"}, 35000))
        self.assertTrue(writer.assert_owned(second, 0))
        writer.finish(second, "confirmed")
        self.error("ALREADY_SUBMITTED", lambda: writer.assert_owned(second, 35000))
        self.assertTrue(writer.assert_owned(second, 0))

    def test_same_order_cancel_exception_retains_unknown_amend(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        target = {"symbol": "BTCUSDT", "clientOrderId": "original"}
        amend = writer.prepare(ticket, "amend", {"intentAction": "amend", "intentTarget": target})
        writer.finish(amend, "unknown")
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "wrong-cancel", {"intentAction": "cancel", "intentTarget": {**target, "clientOrderId": "other"}}))
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "new-create", {"kind": "create"}))
        cancel = writer.prepare(ticket, "cancel", {"intentAction": "cancel", "intentTarget": target})
        self.assertTrue(writer.assert_owned(cancel, 35000))
        writer.finish(cancel, "confirmed")
        self.assertEqual([row["operationId"] for row in writer.unresolved(ticket)], ["amend"])
        self.error("ALREADY_SUBMITTED", lambda: writer.prepare(ticket, "cancel", {"intentAction": "cancel", "intentTarget": target}))

    def test_heartbeat_quarantines_one_account_without_retiring_another(self):
        current = [1000]
        writer = self.writer(now=lambda: current[0])
        ticket = self.ticket(writer, [identity("71"), identity("72")])
        standalone = writer.claim([identity("72")])
        other = self.writer("hub", now=lambda: current[0])
        other.bind("conflict", identity("71"), 1)
        other.freeze([identity("71")])
        current[0] = 2000
        time.sleep(5.2)
        self.assertTrue(writer.assert_owned(standalone, 0))
        self.error("ACCOUNT_ISOLATED", lambda: writer.assert_owned(ticket, 0))
        self.assertFalse(writer.retired)
        with closing(sqlite3.connect(self.database_path)) as database:
            row = database.execute("SELECT lease_until FROM aw_accounts WHERE account_key=?", (account_key(identity("72")),)).fetchone()
        self.assertEqual(row[0], 62000)

    def test_heartbeat_retries_a_briefly_locked_registry_instead_of_retiring(self):
        current = [1000]
        writer = self.writer(now=lambda: current[0])
        ticket = self.ticket(writer)
        lock = sqlite3.connect(self.database_path, isolation_level=None)
        try:
            lock.execute("BEGIN IMMEDIATE")
            time.sleep(5.2)
        finally:
            lock.rollback()
            lock.close()
        self.assertFalse(writer.retired)
        current[0] = 2000
        time.sleep(5.2)
        self.assertFalse(writer.retired)
        self.assertTrue(writer.assert_owned(ticket, 0))
        with closing(sqlite3.connect(self.database_path)) as database:
            row = database.execute("SELECT lease_until FROM aw_accounts WHERE account_key=?", (account_key(identity()),)).fetchone()
        self.assertEqual(row[0], 62000)

    def test_same_client_id_on_other_account_is_not_same_cancel_target(self):
        writer = self.writer()
        ticket = self.ticket(writer, [identity("71"), identity("72")])
        target = {"symbol": "BTCUSDT", "clientOrderId": "same-client-id"}
        self.error("INVALID_INTENT_TARGET", lambda: writer.prepare(ticket, "ambiguous", {"intentAction": "amend", "intentTarget": target}))
        amend = writer.prepare(ticket, "amend-a", {"intentAction": "amend", "intentTarget": {**target, "accountKey": account_key(identity("71"))}})
        writer.finish(amend, "unknown")
        self.error("ACCOUNT_UNRESOLVED", lambda: writer.prepare(ticket, "cancel-b", {"intentAction": "cancel", "intentTarget": {**target, "accountKey": account_key(identity("72"))}}))
        cancel = writer.prepare(ticket, "cancel-a", {"intentAction": "cancel", "intentTarget": {**target, "accountKey": account_key(identity("71"))}})
        self.assertTrue(writer.assert_owned(cancel, 35000))

    def test_thread_sharing_and_busy_fail_closed(self):
        writer = self.writer()
        ticket = self.ticket(writer)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            self.assertTrue(all(pool.map(lambda _: writer.assert_owned(ticket, 0), range(40))))
        lock = sqlite3.connect(self.database_path, isolation_level=None)
        try:
            lock.execute("BEGIN IMMEDIATE")
            self.error("REGISTRY_BUSY", lambda: writer.assert_owned(ticket))
        finally:
            lock.rollback()
            lock.close()

    def test_missing_and_replaced_registry_never_restart_at_fence_one(self):
        writer = self.writer()
        self.ticket(writer)
        writer.close()
        original = Path(self.database_path)
        saved = original.with_suffix(".original")
        original.rename(saved)
        self.error("REGISTRY_MISSING", lambda: self.writer("hub"))
        self.assertFalse(original.exists())
        original.write_bytes(saved.read_bytes())
        self.error("REGISTRY_REPLACED", lambda: self.writer("hub"))
        original.unlink()
        saved.rename(original)
        recovered = self.writer()
        self.assertEqual(recovered.claim([identity()])["claims"][0]["fence"], 2)

    @unittest.skipIf(os.name == "nt", "POSIX ownership and sticky-directory behavior runs in native POSIX CI")
    def test_writable_ancestor_and_trusted_sticky_temp_directory(self):
        ancestor = Path(self.directory.name) / "public-parent"
        parent = ancestor / "protected-data"
        parent.mkdir(parents=True, mode=0o700)
        ancestor.chmod(0o777)
        self.database_path = str(parent / "execution-control.sqlite")
        self.error("UNSAFE_DATABASE_PATH", self.writer)
        ancestor.chmod(0o1777)
        self.assertEqual(len(self.ticket(self.writer())["claims"]), 1)


if __name__ == "__main__":
    unittest.main()

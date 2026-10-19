"""The operator diagnostic reads real WAL evidence and never exposes raw state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "diagnose-aster-margin.py"
SECRET = "PRIVATE_DIAGNOSTIC_SENTINEL_4dc1f1"


class AsterMarginDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="aster-margin-diag-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / ("data #" + ("?" if os.name == "posix" else "%3F") + " " + SECRET)
        (self.root / "modules" / "aster").mkdir(parents=True)
        self.shared_path = self.root / "execution-control.sqlite"
        self.private_path = self.root / "modules" / "aster" / "trading.sqlite3"
        self.shared = self.open_database(self.shared_path)
        self.private = self.open_database(self.private_path)
        self.shared.executescript("CREATE TABLE aw_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);"
            "CREATE TABLE aw_operations(operation_id TEXT PRIMARY KEY,module_id TEXT,state TEXT,"
            "body_hash TEXT,created_at INTEGER,ticket_json TEXT,account_keys TEXT);")
        self.private.executescript("CREATE TABLE pairs(id TEXT PRIMARY KEY,data TEXT NOT NULL);"
            "CREATE TABLE kv(key TEXT PRIMARY KEY,data TEXT NOT NULL);")
        self.shared.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.private.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        # All evidence below is WAL-only until the writer connections close.
        self.shared.execute("INSERT INTO aw_meta VALUES ('recovery_state',?)", (json.dumps({
            "state": "quarantine", "admittedTarget": {"private_key": SECRET}, "authorityId": SECRET}),))
        self.operation("aster:transfer:old-request", "unknown")
        self.operation("aster:transfer:confirmed-request", "confirmed")
        self.operation("aster:" + SECRET, "unknown", module="crossex")
        self.pair("gold")
        self.journal("gold", {"pending": {"request_id": "old-request", "status": "unknown", "amount": "1000",
            "created_at": 1760000000, "identity": SECRET, "user": SECRET, "private_key": SECRET},
            "last_transfer": {"request_id": "new-local-request", "status": "rejected", "amount": "1.25",
                "created_at": 1760000001, "write_admission": {"code": "ACCOUNT_UNRESOLVED", "phase": "before_send", "detail": SECRET},
                "writer_rejection": {"operation_id": SECRET, "body_hash": SECRET, "settled": False}},
            "blocked_reason": SECRET, "api_notice": {"text": SECRET}})
        self.shared.commit()
        self.private.commit()

    def open_database(self, path):
        database = sqlite3.connect(path)
        database.execute("PRAGMA journal_mode=WAL")
        database.execute("PRAGMA wal_autocheckpoint=0")
        self.addCleanup(database.close)
        return database

    def operation(self, operation_id, state, module="aster"):
        self.shared.execute("INSERT OR REPLACE INTO aw_operations VALUES (?,?,?,?,?,?,?)",
            (operation_id, module, state, "a" * 64, 1760000000000, json.dumps({"signature": SECRET}), SECRET))

    def pair(self, pair_id):
        self.private.execute("INSERT OR REPLACE INTO pairs VALUES (?,?)", (pair_id, json.dumps({
            "id": pair_id, "symbol": "XAUUSD1", "enabled": True, "name": SECRET,
            "margin": {"enabled": True, "master_env_prefix": SECRET}, "user": SECRET, "signer": SECRET})))

    def journal(self, pair_id, value):
        self.private.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", ("pair_margin:" + pair_id, json.dumps(value)))

    def run_tool(self, root=None):
        result = subprocess.run([sys.executable, "-I", str(SCRIPT), str(root or self.root)],
            capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.stderr, "")
        self.assertNotIn(SECRET, result.stdout)
        return result.returncode, json.loads(result.stdout)

    def fingerprint(self):
        result = {}
        for database in (self.shared_path, self.private_path):
            for path in (database, Path(str(database) + "-wal")):
                info = path.stat()
                result[str(path)] = (hashlib.sha256(path.read_bytes()).hexdigest(), info.st_size, info.st_mtime_ns)
        return result

    def test_live_wal_is_read_without_data_wal_or_gate_changes(self):
        before = self.fingerprint()
        code, result = self.run_tool()
        self.assertEqual(code, 0, result)
        self.assertEqual(result["recoveryState"], "quarantine")
        self.assertEqual(result["sharedOperations"]["items"], [{"operationId": "aster:transfer:old-request",
            "state": "unknown", "createdAt": 1760000000000, "bodyHash": "a" * 64}])
        pending = result["marginJournals"]["items"][0]["pending"]
        self.assertEqual(pending["sharedOperations"][0]["state"], "unknown")
        self.assertEqual(pending["requestId"], "old-request")
        local = result["marginJournals"]["items"][0]["lastTransfer"]
        self.assertEqual(local["sharedOperations"], [])
        self.assertEqual(local["writeAdmission"], {"code": "ACCOUNT_UNRESOLVED", "phase": "before_send"})
        self.assertEqual(local["writerRejection"], {"present": True, "settled": False})
        self.assertEqual(result["pairs"]["items"], [{"id": "gold", "symbol": "XAUUSD1", "enabled": True, "marginEnabled": True}])
        self.assertIn("does not prove", result["notice"])
        self.assertIn("separate snapshots", result["notice"])
        self.assertEqual(self.fingerprint(), before)
        self.assertEqual(json.loads(self.shared.execute("SELECT value FROM aw_meta").fetchone()[0])["state"], "quarantine")

    def test_correlates_confirmed_and_legacy_original_without_settling_them(self):
        self.operation("aster:legacy:pair_margin:gold:confirmed-request", "unknown")
        self.shared.commit()
        self.journal("gold", {"last_transfer": {"request_id": "confirmed-request", "status": "acknowledged",
            "writer_rejection": {"settled": True}}})
        self.private.commit()
        before = self.fingerprint()
        code, result = self.run_tool()
        self.assertEqual(code, 0)
        local = result["marginJournals"]["items"][0]["lastTransfer"]
        self.assertEqual({row["state"] for row in local["sharedOperations"]}, {"unknown", "confirmed"})
        self.assertEqual(local["writerRejection"], {"present": True, "settled": True})
        self.assertEqual(self.fingerprint(), before)

    def test_row_limits_are_reported_and_ids_are_safely_truncated(self):
        for index in range(201):
            self.operation("aster:transfer:extra-" + str(index), "sending")
        self.operation("aster:transfer:" + "x" * 250, "unknown")
        for index in range(101):
            self.pair("pair-" + str(index))
            self.journal("pair-" + str(index), {})
        self.shared.commit()
        self.private.commit()
        code, result = self.run_tool()
        self.assertEqual(code, 0)
        for name, limit in (("sharedOperations", 200), ("pairs", 100), ("marginJournals", 100)):
            self.assertTrue(result[name]["truncated"])
            self.assertEqual(len(result[name]["items"]), limit)
        for row in result["sharedOperations"]["items"]:
            self.assertLessEqual(len(row["operationId"]), 200)

    def test_long_original_identifier_and_unrecognized_fields_cannot_leak(self):
        self.shared.execute("DELETE FROM aw_operations")
        self.operation("aster:transfer:" + "x" * 250, "unknown")
        self.operation("aster:transfer:<unsafe>\n", "unknown")
        self.shared.commit()
        self.journal("gold", {"pending": {"request_id": "bad<id>", "status": "unknown", "amount": SECRET,
            "write_admission": {"code": SECRET, "phase": SECRET}, "created_at": SECRET,
            "writer_rejection": {"settled": SECRET}}})
        self.private.commit()
        code, result = self.run_tool()
        self.assertEqual(code, 0)
        operations = result["sharedOperations"]["items"]
        self.assertTrue(any(item.get("operationIdTruncated") and len(item["operationId"]) == 200 for item in operations))
        self.assertTrue(any(item["operationId"] is None for item in operations))
        pending = result["marginJournals"]["items"][0]["pending"]
        self.assertIsNone(pending["requestId"])
        self.assertNotIn("amount", pending)
        self.assertNotIn("created_at", pending)
        self.assertEqual(pending["writeAdmission"], {"code": None, "phase": None})
        self.assertEqual(pending["writerRejection"], {"present": True, "settled": None})

    def test_missing_database_is_never_created(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "modules" / "aster").mkdir(parents=True)
            before = set(root.rglob("*"))
            code, result = self.run_tool(root)
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "DATABASE_MISSING")
            self.assertEqual(set(root.rglob("*")), before)

    def test_missing_private_database_does_not_create_it_or_open_shared_database(self):
        self.private.close()
        self.private_path.unlink()
        before = set(self.root.rglob("*"))
        shared_before = self.shared_path.read_bytes()
        code, result = self.run_tool()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "DATABASE_MISSING")
        self.assertEqual(set(self.root.rglob("*")), before)
        self.assertEqual(self.shared_path.read_bytes(), shared_before)

    def test_relative_path_is_rejected_without_echoing_it(self):
        code, result = self.run_tool(Path(SECRET))
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "INVALID_ARGUMENT")

    def test_hardlinked_database_is_rejected(self):
        alias = self.root / "hardlink"
        try:
            os.link(self.shared_path, alias)
        except (OSError, NotImplementedError):
            self.skipTest("Hard links are unavailable on this filesystem")
        code, result = self.run_tool()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "UNSAFE_PATH")

    def test_hardlinked_wal_is_rejected(self):
        try:
            os.link(Path(str(self.shared_path) + "-wal"), self.root / "wal-alias")
        except (OSError, NotImplementedError):
            self.skipTest("Hard links are unavailable on this filesystem")
        code, result = self.run_tool()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "UNSAFE_PATH")

    def test_symlinked_data_directory_is_rejected(self):
        alias = Path(self.directory.name) / "alias"
        try:
            os.symlink(self.root, alias, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks require unavailable platform privileges")
        code, result = self.run_tool(alias)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "UNSAFE_PATH")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO check is unavailable")
    def test_special_database_file_is_rejected_before_sqlite_open(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.mkfifo(root / "execution-control.sqlite")
            code, result = self.run_tool(root)
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "UNSAFE_PATH")

    @unittest.skipUnless(os.name == "posix", "Real UID ownership is a POSIX-only check")
    def test_posix_database_owner_matches_real_and_effective_caller(self):
        self.assertEqual(os.getuid(), self.shared_path.stat().st_uid)
        self.assertEqual(os.geteuid(), self.shared_path.stat().st_uid)
        self.assertEqual(self.run_tool()[0], 0)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0,
        "Actual chown ownership rejection requires a POSIX root runner")
    def test_root_cannot_read_service_owned_database(self):
        original = self.shared_path.stat()
        try:
            os.chown(self.shared_path, original.st_uid + 1, original.st_gid)
            code, result = self.run_tool()
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "OWNER_MISMATCH")
        finally:
            os.chown(self.shared_path, original.st_uid, original.st_gid)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0,
        "Actual sidecar chown rejection requires a POSIX root runner")
    def test_sidecar_with_different_owner_is_rejected(self):
        sidecar = Path(str(self.private_path) + "-shm")
        original = sidecar.stat()
        try:
            os.chown(sidecar, original.st_uid + 1, original.st_gid)
            code, result = self.run_tool()
            self.assertEqual(code, 1)
            self.assertEqual(result["error"], "OWNER_MISMATCH")
        finally:
            os.chown(sidecar, original.st_uid, original.st_gid)

    def test_invalid_json_constants_oversized_and_malformed_json_are_redacted(self):
        for raw in ('{"pending": NaN}', '{"private_key":"' + SECRET + '","extra":Infinity}',
                '{"extra":1e999}', '{"extra":' + "9" * 40 + '}', SECRET,
                json.dumps({"extra": SECRET * 10000})):
            with self.subTest(raw_length=len(raw)):
                self.private.execute("UPDATE kv SET data=? WHERE key='pair_margin:gold'", (raw,))
                self.private.commit()
                code, result = self.run_tool()
                self.assertEqual(code, 1)
                self.assertEqual(result["error"], "INVALID_DATA")

    def test_database_errors_are_fixed_json_without_exception_or_path(self):
        self.shared.execute("DROP TABLE aw_operations")
        self.shared.commit()
        code, result = self.run_tool()
        self.assertEqual(code, 1)
        self.assertEqual(result, {"schema": "aster-margin-diagnostics/v1", "error": "DATABASE_UNAVAILABLE"})

    def test_readonly_connection_rejects_sql_writes(self):
        spec = importlib.util.spec_from_file_location("aster_margin_diagnostic_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        before = self.fingerprint()
        with module._open_readonly(self.shared_path) as database:
            with self.assertRaises(sqlite3.DatabaseError):
                database.execute("UPDATE aw_meta SET value='normal'")
            with self.assertRaises(sqlite3.DatabaseError):
                database.execute("ATTACH DATABASE ':memory:' AS other")
        self.assertEqual(self.fingerprint(), before)


if __name__ == "__main__":
    unittest.main()

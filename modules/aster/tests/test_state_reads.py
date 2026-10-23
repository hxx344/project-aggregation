"""HTTP status reads committed state without waiting for writers or exposing removed features."""
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import threading
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.helpers import Fixture, account
from trading.engine import Engine
from trading.server import create_app
from trading.store import dumps


class StateReadTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.engine = Engine(self.f.store, market=self.f.market)

    def test_state_contains_all_account_events_and_no_removed_feature_fields(self):
        self.f.store.save_account(account("second"))
        self.f.store.event("test", "info", "first account event")
        self.f.store.event("second", "info", "second account event")
        self.f.store.event("", "info", "global event")
        state = self.engine.state()
        self.assertEqual({e["account_id"] for e in state["events"]}, {"test", "second", ""})
        for row in state["accounts"]:
            for key in ("cycle", "migration", "migration_run_id", "cycle_state", "cycle_trades",
                        "cycle_trades_revision", "migration_state"):
                self.assertNotIn(key, row)

    def test_http_state_ignores_old_compact_query(self):
        with patch.dict("os.environ", {"ASTER_DASHBOARD_PASSWORD": "test-only-state-password"}), \
             TestClient(create_app(self.engine, start_engine=False)) as client:
            client.headers["origin"] = "http://testserver"
            self.assertEqual(client.post("/api/login", json={"password": "test-only-state-password"}).status_code, 200)
            plain = client.get("/api/state")
            compact = client.get("/api/state?compact=true&history_account=test")
        self.assertEqual((plain.status_code, compact.status_code), (200, 200))
        self.assertEqual([a["id"] for a in plain.json()["accounts"]], [a["id"] for a in compact.json()["accounts"]])
        self.assertEqual(plain.json()["events"], compact.json()["events"])

    def test_status_reads_committed_state_without_waiting_for_store_writer(self):
        entered, release = threading.Event(), threading.Event()
        def writer():
            with self.f.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                modified = self.f.store.account("test")
                modified["name"] = "uncommitted"
                db.execute("UPDATE accounts SET data=? WHERE id='test'", (dumps(modified),))
                entered.set()
                release.wait(timeout=5)
        with ThreadPoolExecutor(max_workers=2) as pool:
            writing = pool.submit(writer)
            try:
                self.assertTrue(entered.wait(timeout=1))
                result = pool.submit(self.engine.state).result(timeout=1)
                self.assertEqual(result["accounts"][0]["name"], self.f.account["name"])
            finally:
                release.set()
                writing.result(timeout=2)
        self.assertEqual(self.engine.state()["accounts"][0]["name"], "uncommitted")

    def test_read_snapshot_is_consistent_read_only_and_does_not_block_writes(self):
        with self.f.store.read_snapshot() as reader:
            before = reader.account("test")
            changed = {**before, "name": "committed later"}
            self.f.store.save_account(changed)
            self.assertEqual(reader.account("test"), before)
            self.assertEqual(self.f.store.account("test")["name"], "committed later")
            with self.assertRaises(sqlite3.OperationalError):
                reader.put("must-not-write", True)
        self.assertIsNone(self.f.store.get("must-not-write"))

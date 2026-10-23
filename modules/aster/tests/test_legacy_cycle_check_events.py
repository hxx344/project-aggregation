"""Historical cycle-check events stay readable after the feature was removed."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
from unittest import TestCase

from trading.store import Store


SYMBOL = "XAUUSD1"
EVENT_FIELDS = {"id", "account_id", "kind", "message", "created_at"}
VALID = {"symbol": SYMBOL, "phase": "open", "count": 3, "first_at": 90, "last_at": 100}


class LegacyCycleCheckEventTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(Path(self.directory.name) / "events.sqlite3")

    def insert(self, account, kind, message, raw):
        with self.store.connect() as db:
            return db.execute("INSERT INTO events(account_id,kind,message,created_at,cycle_check) VALUES (?,?,?,?,?)",
                              (account, kind, message, 100, raw)).lastrowid

    def account_events(self, account):
        return [event for event in self.store.events(limit=1000) if event["account_id"] == account]

    def test_valid_historical_metadata_remains_visible(self):
        metadata = {**VALID, "diagnostic": {"symbol": SYMBOL, "checks": [{"actual": "0.11", "passed": False}]}}
        self.insert("first", "cycle_check", "采样价差 0.11 bp", json.dumps(metadata))
        row, = self.account_events("first")
        self.assertEqual((row["kind"], row["message"]), ("cycle_check", "采样价差 0.11 bp"))
        self.assertEqual(row["cycle_check"], metadata)

    def test_invalid_metadata_is_preserved_and_never_hides_the_event(self):
        cases = [None, "{broken", "null", "[]", json.dumps({**VALID, "count": True}),
                 json.dumps({**VALID, "count": 0}), json.dumps({**VALID, "phase": "holding"}),
                 json.dumps({**VALID, "symbol": "OTHER"}), json.dumps({**VALID, "first_at": 101}),
                 json.dumps({**VALID, "last_at": float("nan")}), json.dumps({**VALID, "diagnostic": []}),
                 json.dumps({**VALID, "diagnostic": {"symbol": "CLUSD1"}}),
                 json.dumps({**VALID, "unexpected": True})]
        for index, raw in enumerate(cases):
            account = "invalid_" + str(index)
            with self.subTest(raw=raw):
                old_id = self.insert(account, "cycle_check", "必须保留的损坏旧记录", raw)
                row, = self.account_events(account)
                self.assertEqual(set(row), EVENT_FIELDS)
                self.assertEqual(row["message"], "必须保留的损坏旧记录")
                with self.store.connect() as db:
                    self.assertEqual(db.execute("SELECT cycle_check FROM events WHERE id=?", (old_id,)).fetchone()[0], raw)

    def test_regular_event_with_forged_metadata_is_not_treated_as_a_cycle_check(self):
        self.insert("first", "error", "真实错误必须保留", json.dumps(VALID))
        row, = self.account_events("first")
        self.assertEqual(set(row), EVENT_FIELDS)
        self.assertEqual(row["message"], "真实错误必须保留")

    def test_legacy_database_upgrade_is_idempotent_and_preserves_old_rows(self):
        path = Path(self.directory.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(path)) as db, db:
            db.execute("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,created_at REAL NOT NULL)")
            db.executemany("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)",
                           [("first", "wait", "旧循环检查", 90), ("first", "error", "旧错误", 95)])
            original = db.execute("SELECT * FROM events ORDER BY id").fetchall()
        upgraded = Store(path)
        Store(path)
        with upgraded.connect() as db:
            added = [row for row in db.execute("PRAGMA table_info(events)") if row["name"] == "cycle_check"]
            self.assertEqual(len(added), 1)
            self.assertEqual((added[0]["type"], added[0]["notnull"]), ("TEXT", 0))
            self.assertEqual([tuple(row) for row in db.execute("SELECT id,account_id,kind,message,created_at FROM events ORDER BY id")], original)
            # Older code's explicit-column insertion still works after upgrade.
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)", ("second", "order", "旧代码订单", 96))
        rows = upgraded.events()
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(set(row) == EVENT_FIELDS for row in rows))

    def test_latest_events_query_uses_index_without_sorting_all_history(self):
        with self.store.connect() as db:
            plan = " ".join(row[3] for row in db.execute("EXPLAIN QUERY PLAN SELECT * FROM events ORDER BY created_at DESC,id DESC LIMIT ?", (100,)))
        self.assertIn("USING INDEX idx_events_created", plan)
        self.assertNotIn("USE TEMP B-TREE", plan)

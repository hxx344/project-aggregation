"""Removed single-account strategies leave read-only, paused legacy evidence."""
from copy import deepcopy
import json
from unittest import TestCase
from unittest.mock import Mock, patch

from tests.helpers import Fixture, account, seed_market_capacity
from trading.account_legacy import (LEGACY_CONFIG_REASON, LEGACY_PENDING_REASON, legacy_intent,
                                    legacy_position)
from trading.engine import Engine
from trading.execution import Executor
from trading.models import TradingError
from trading.store import dumps


class LegacyClassificationTests(TestCase):
    def test_only_unfinished_removed_intents_are_legacy(self):
        for intent in ({"status": "pending", "kind": "cycle"}, {"status": "submitted", "kind": "cycle_leverage"},
                       {"status": "pending", "kind": "migration"},
                       {"status": "pending", "kind": "leverage", "purpose": "migration"}):
            with self.subTest(intent=intent):
                self.assertTrue(legacy_intent(intent))
        for intent in (None, [], {"status": "complete", "kind": "cycle"}, {"status": "aborted", "kind": "migration"},
                       {"status": "pending", "kind": "pair"}, {"status": "pending", "kind": "leverage"},
                       {"status": "pending", "kind": "leverage", "purpose": "ordinary"}):
            with self.subTest(intent=intent):
                self.assertFalse(legacy_intent(intent))

    def test_held_or_malformed_progress_is_legacy_and_flat_progress_is_not(self):
        for progress in ({"quantities": {"LONG": "0.001", "SHORT": "0"}}, {"opened_at": 1},
                         {"phase": "opening"}, {"phase": ["complete"]}, {"quantities": []},
                         {"quantities": {"LONG": "bad"}}, {"quantities": {"LONG": None}},
                         {"quantities": {"LONG": True}}, {"phase": "waiting_open", "quantities": {"BROKEN": "0"}},
                         "corrupt", ["LONG"], [], False, 0, ""):
            with self.subTest(progress=progress):
                self.assertTrue(legacy_position(progress))
        for progress in (None, {}, {"phase": "waiting_open"}, {"phase": "disabled"},
                         {"phase": "complete", "quantities": {"LONG": "0", "SHORT": "0E-8"}, "completed": 7}):
            with self.subTest(progress=progress):
                self.assertFalse(legacy_position(progress))


class AccountLegacyStoreTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)

    def write_raw(self, data):
        with self.f.store.connect() as db:
            db.execute("UPDATE accounts SET data=? WHERE id=?", (dumps(data), data["id"]))

    def raw(self):
        with self.f.store.connect() as db:
            return json.loads(db.execute("SELECT data FROM accounts WHERE id='test'").fetchone()[0])

    def test_old_enabled_feature_is_stripped_and_paused_without_rewriting_on_read(self):
        stored = {**account(), "cycle": {"enabled": True, "symbol": "XAUUSD1"},
                  "migration": {"enabled": False}, "migration_run_id": "old-run"}
        self.write_raw(stored)
        for loaded in (self.f.store.account("test"), self.f.store.accounts()[0]):
            self.assertFalse({"cycle", "migration", "migration_run_id"} & set(loaded))
            self.assertFalse(loaded["enabled"])
            self.assertEqual(loaded["pause_reason"], LEGACY_CONFIG_REASON)
        self.assertEqual(self.raw(), stored)
        self.f.store.save_account(self.f.store.account("test"))
        kept = self.raw()
        self.assertEqual({key: kept[key] for key in ("cycle", "migration", "migration_run_id")},
                         {key: stored[key] for key in ("cycle", "migration", "migration_run_id")})
        self.assertFalse(kept["enabled"])
        self.f.store.save_account(self.f.store.account("test"), discard_removed=True)
        self.assertFalse({"cycle", "migration", "migration_run_id"} & set(self.raw()))

    def test_automatic_legacy_pause_keeps_removed_settings_until_user_saves(self):
        cycle = {"enabled": True, "symbol": "XAUUSD1", "leverage": 5}
        self.write_raw({**account(), "cycle": cycle, "migration_run_id": "old-run"})
        self.f.store.put("cycle:test", {"phase": "holding", "quantities": {"LONG": "0.002", "SHORT": "0.002"}})
        engine = Engine(self.f.store, market=self.f.market)
        engine.brokers["test"] = self.f.broker
        self.assertEqual(engine.tick_account("test"), 30)
        self.assertEqual(self.f.store.account("test")["pause_reason"], LEGACY_PENDING_REASON)
        raw = self.raw()
        self.assertEqual((raw["cycle"], raw["migration_run_id"], raw["enabled"]), (cycle, "old-run", False))
        engine.enable("test", False)
        self.assertEqual(self.raw()["cycle"], cycle)
        self.f.store.put("cycle:test", {"phase": "waiting_open", "quantities": {"LONG": "0", "SHORT": "0"}})
        engine.configure("test", {"margin_limit": "0.5"})
        self.assertFalse({"cycle", "migration_run_id"} & set(self.raw()))

    def test_disabled_old_feature_does_not_pause_ordinary_trading(self):
        self.write_raw({**account(), "cycle": {"enabled": False}, "migration": {"enabled": False}})
        loaded = self.f.store.account("test")
        self.assertTrue(loaded["enabled"])
        self.assertNotIn("pause_reason", loaded)
        self.assertNotIn("cycle", loaded)

    def test_paused_account_never_opens_ordinary_batch(self):
        self.write_raw({**account(), "migration": {"enabled": True}})
        engine = Engine(self.f.store, market=self.f.market)
        engine.brokers["test"] = self.f.broker
        seed_market_capacity(engine)
        engine.tick_account("test")
        self.assertIsNone(self.f.store.intent("test"))
        self.assertEqual(self.f.broker.state["orders"], {})
        self.assertFalse(self.f.store.account("test")["enabled"])


class AccountLegacyJournalTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.brokers["test"] = self.f.broker

    def assert_tick_pauses_without_broker(self):
        with patch.object(self.engine, "broker", side_effect=AssertionError("legacy work reached a broker")):
            self.assertEqual(self.engine.tick_account("test"), 30)
        saved = self.f.store.account("test")
        self.assertFalse(saved["enabled"])
        self.assertEqual(saved["pause_reason"], LEGACY_PENDING_REASON)
        self.assertEqual(self.engine.views["test"]["status"], "attention")

    def test_legacy_intent_blocks_tick_controls_reconcile_and_deletion(self):
        for kind, extra in (("cycle", {}), ("cycle_leverage", {}), ("migration", {}),
                            ("leverage", {"purpose": "migration", "symbol": "XAUUSD1"})):
            with self.subTest(kind=kind):
                self.setUp()
                intent = {"id": "legacy-" + kind, "account_id": "test", "status": "pending", "kind": kind, **extra}
                self.f.store.save_intent(intent)
                before = deepcopy(self.f.store.intent("test"))
                self.assert_tick_pauses_without_broker()
                with self.assertRaisesRegex(TradingError, LEGACY_PENDING_REASON):
                    self.engine.retry("test")
                for action in (lambda: self.engine.enable("test", True),
                               lambda: self.engine.configure("test", {"margin_limit": "0.5"}),
                               lambda: self.engine.delete_account("test")):
                    with self.assertRaises(TradingError):
                        action()
                broker = Mock()
                self.assertEqual(Executor(self.f.store, broker, self.f.market).reconcile(self.f.store.account("test")),
                                 LEGACY_PENDING_REASON)
                self.assertEqual(broker.mock_calls, [])
                with self.assertRaisesRegex(TradingError, LEGACY_PENDING_REASON):
                    self.f.store.complete_leverage(deepcopy(before), 5)
                self.assertEqual(self.f.store.intent("test"), before)
                self.assertIsNotNone(self.f.store.account("test"))
                self.assertIsNone(self.f.store.get("open_after_leverage:test:XAUUSD1"))

    def test_legacy_post_fill_or_held_progress_blocks_ordinary_writes(self):
        for key, value in (("post_fill_check:test", {"kind": "migration", "symbol": "XAUUSD1"}),
                           ("cycle:test", {"phase": "complete", "quantities": {"LONG": "0.002", "SHORT": "0"}}),
                           ("cycle:test", {"phase": "waiting_open", "quantities": {"BROKEN": "0"}}),
                           ("cycle:test", []), ("cycle:test", False)):
            with self.subTest(key=key, value=value):
                self.setUp()
                self.f.store.put(key, value)
                self.assert_tick_pauses_without_broker()
                shown = next(row for row in self.engine.state()["accounts"] if row["id"] == "test")
                self.assertTrue(shown["deletion_block"])
                executor = Executor(self.f.store, Mock(), self.f.market)
                account_row = self.f.store.account("test")
                with self.assertRaisesRegex(TradingError, LEGACY_PENDING_REASON):
                    executor.open_pair(account_row, None, "XAUUSD1", None, None)
                with self.assertRaisesRegex(TradingError, LEGACY_PENDING_REASON):
                    executor.leverage(account_row, "XAUUSD1", 5, 10)
                with self.assertRaises(TradingError):
                    self.engine.delete_account("test")
                self.assertEqual(self.f.store.get(key), value)
                self.assertIsNotNone(self.f.store.account("test"))

    def test_flat_completed_progress_allows_deletion(self):
        self.f.store.put("cycle:test", {"phase": "complete", "quantities": {"LONG": "0", "SHORT": "0"}})
        self.engine.enable("test", False)
        self.engine.delete_account("test")
        self.assertIsNone(self.f.store.account("test"))
        self.assertIsNotNone(self.f.store.get("cycle:test"))

class PairCreationLegacyTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.brokers["test"] = self.f.broker

    def create(self):
        return self.engine.pairs.create({"id": "gold", "name": "黄金配对", "long_account_id": "test",
                                         "short_account_id": "second", "ordinary": {"enabled": True}})

    def test_held_or_malformed_single_account_progress_blocks_pair_creation(self):
        for progress in ({"quantities": {"LONG": "0.001"}}, {"quantities": {"LONG": "bad"}},
                         {"quantities": []}, {"quantities": {"BROKEN": "0"}}, {"phase": "closing"}, "corrupt", []):
            with self.subTest(progress=progress):
                self.f.store.put("cycle:test", progress)
                with self.assertRaisesRegex(TradingError, LEGACY_PENDING_REASON):
                    self.create()
                self.assertIsNone(self.f.store.pair("gold"))
                self.assertEqual(self.f.store.get("cycle:test"), progress)
        self.f.store.put("cycle:test", {"phase": "complete", "quantities": {"LONG": "0", "SHORT": "0"}})
        self.assertEqual(self.create()["id"], "gold")

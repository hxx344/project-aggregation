"""Cycle preparation stays durable while avoiding redundant display work."""
from contextlib import contextmanager
import copy
from dataclasses import replace
import json
import sqlite3
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from trading.cycle import CyclePlan
from trading.cycle_execution import CycleExecutor
from trading.cycle_quality import ObservedBroker
from trading.exchange import AmbiguousOrder, ExchangeError
from trading.models import TradingError, dec
from trading.paper import PaperBroker
from trading import recovery
from trading.store import Store
from tests import test_cycle_execution_quality as quality_cases


class CyclePreSubmitOptimizationTests(unittest.TestCase):
    setUp = quality_cases.CycleExecutionQualityTests.setUp
    start = quality_cases.CycleExecutionQualityTests.start
    quality = quality_cases.CycleExecutionQualityTests.quality

    def final_observation(self, phase="open", **changes):
        depth = self.f.market.depth("XAUUSD1")
        long, short = ("8824.04", "8824.02") if phase == "open" else ("8824.02", "8824.04")
        # This reference-amount spread deliberately differs from the batch's.
        plan = CyclePlan(phase, "XAUUSD1", dec(2), 2, dec(long), dec(short), dec("99"))
        return {"depth": depth, "quality_plan": replace(plan, **changes),
                "checked_at": time.time(), "checked_monotonic": time.monotonic()}

    def test_intent_index_and_event_commit_together_before_broker_submit(self):
        statements = []
        saved_account = self.f.store.account("test")
        connect, original = self.f.store.connect, self.f.broker.submit
        @contextmanager
        def observed_connection():
            with connect() as db:
                db.set_trace_callback(statements.append)
                yield db
        def submit(orders):
            statements.append("BROKER_SUBMIT")
            with connect() as db:
                self.assertFalse(db.in_transaction)
                pending = db.execute("SELECT id,account_id,status,data FROM intents").fetchone()
                self.assertEqual((pending["account_id"], pending["status"]), ("test", "pending"))
                durable = json.loads(pending["data"])
                self.assertEqual(durable["orders"], orders)
                self.assertEqual(durable["receipts"], {})
                marker = durable["bounded_recovery"]
                self.assertEqual(marker["identity"], recovery.broker_identity(saved_account, self.f.broker))
                self.assertEqual(marker["config"], recovery.recovery_config(saved_account))
                self.assertEqual(marker["checks"], {order["newClientOrderId"]: 0 for order in orders})
                self.assertLessEqual(marker["first_observed_at"], marker["last_send_at"])
                self.assertLessEqual(marker["last_send_at"], time.time())
                indexed = db.execute("SELECT * FROM cycle_volume_sync WHERE intent_id=?", (pending["id"],)).fetchone()
                self.assertEqual((indexed["account_id"], indexed["status"]), ("test", "pending"))
                self.assertIsNone(indexed["synced_at"])
                events = db.execute("SELECT account_id,kind,message FROM events").fetchall()
                self.assertEqual([tuple(event) for event in events],
                                 [("test", "cycle", "XAUUSD1 独立循环同时加仓多空，每边 2，2x")])
                self.assertEqual(db.execute("PRAGMA synchronous").fetchone()[0], 2)
            return original(orders)
        with patch.object(self.f.store, "connect", side_effect=observed_connection), \
             patch.object(self.f.broker, "submit", side_effect=submit) as sent:
            self.start()
        prefix = statements[:statements.index("BROKER_SUBMIT")]
        # Consistent read snapshots may commit too; only the durable write
        # transaction must combine intent, index and event before the send.
        writes, transaction = [], []
        for sql in prefix:
            if sql.startswith("BEGIN"):
                transaction = []
            elif sql == "COMMIT":
                if transaction:
                    writes.append(transaction)
            elif sql.startswith(("INSERT ", "UPDATE ", "DELETE ")) and (not transaction or transaction[-1] != sql):
                # The trace callback repeats the outer statement for each
                # trigger step (intents feed the position activity counters).
                transaction.append(sql)

        def tables(statements):
            return [sql.split()[2].split("(")[0] for sql in statements]

        # Creation includes the bounded-recovery marker in the same FULL commit.
        self.assertEqual([tables(write) for write in writes],
                         [["intents", "cycle_volume_sync", "events"]])
        self.assertTrue(writes[0][0].startswith("INSERT INTO intents VALUES"))
        self.assertEqual(sent.call_count, 1)
        self.assertEqual(self.quality()["actual"]["status"], "filled")
        database = self.quality()["timing"]["database"]
        self.assertEqual(database["connections"], 1)
        self.assertGreaterEqual(database["connection_ms"], 0)
        self.assertGreaterEqual(database["lock_wait_ms"], 0)

    def test_index_or_event_failure_rolls_back_the_whole_batch_and_never_sends(self):
        for table in ("cycle_volume_sync", "events"):
            with self.subTest(table=table):
                with self.f.store.connect() as db:
                    db.execute(f"CREATE TRIGGER stop_creation BEFORE INSERT ON {table} "
                               "BEGIN SELECT RAISE(ABORT, 'creation interrupted'); END")
                try:
                    with patch.object(self.f.broker, "submit") as submit, \
                         self.assertRaisesRegex(sqlite3.IntegrityError, "creation interrupted"):
                        self.start()
                    submit.assert_not_called()
                    with self.f.store.connect() as db:
                        for name in ("intents", "cycle_volume_sync", "events"):
                            self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)
                finally:
                    with self.f.store.connect() as db:
                        db.execute("DROP TRIGGER stop_creation")
        self.assertEqual(self.f.store.get("cycle:test")["phase"], "waiting_open")

    def test_exception_before_commit_rolls_back_and_never_sends(self):
        connect = self.f.store.connect
        @contextmanager
        def interrupted_connection():
            with connect() as db:
                touched = []
                db.set_trace_callback(lambda sql: touched.append(sql) if sql.startswith("INSERT INTO intents") else None)
                yield db
                if touched:
                    raise sqlite3.OperationalError("commit interrupted")
        with patch.object(self.f.store, "connect", side_effect=interrupted_connection), \
             patch.object(self.f.broker, "submit") as submit, self.assertRaisesRegex(sqlite3.OperationalError, "commit interrupted"):
            self.start()
        submit.assert_not_called()
        with connect() as db:
            for name in ("intents", "cycle_volume_sync", "events"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)

    def test_created_pending_survives_restart_without_resubmitting_or_duplicating_event(self):
        create = self.f.store.create_cycle_intent
        def crash_after_commit(intent, message):
            create(intent, message)
            raise RuntimeError("crash before send")
        with patch.object(self.f.store, "create_cycle_intent", side_effect=crash_after_commit), \
             patch.object(self.f.broker, "submit") as submit, \
             self.assertRaisesRegex(RuntimeError, "crash before send"):
            self.start()
        submit.assert_not_called()
        pending = self.f.store.intent("test")
        self.assertEqual(pending["status"], "pending")
        self.assertEqual(pending["bounded_recovery"]["checks"],
                         {order["newClientOrderId"]: 0 for order in pending["orders"]})
        store = Store(self.f.store.path)
        broker = PaperBroker("test", self.f.market, store)
        restored = CycleExecutor(store, broker, self.f.market)
        with patch.object(broker, "submit", side_effect=AssertionError("original order must not be resent")):
            restored.reconcile(self.f.account)
        self.assertIsNone(store.intent("test"))
        self.assertEqual(store.get("cycle:test")["phase"], "waiting_open")
        with store.connect() as db:
            intent = db.execute("SELECT status FROM intents WHERE id=?", (pending["id"],)).fetchone()
            indexed = db.execute("SELECT status FROM cycle_volume_sync WHERE intent_id=?", (pending["id"],)).fetchone()
            self.assertEqual(intent["status"], indexed["status"])
            self.assertIn(intent["status"], ("complete", "aborted"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE message LIKE '%同时加仓%'").fetchone()[0], 1)

    def test_creation_rejects_an_existing_id_without_updating_it(self):
        create = self.f.store.create_cycle_intent
        def crash_after_commit(intent, message):
            create(intent, message)
            raise RuntimeError("before send")
        with patch.object(self.f.store, "create_cycle_intent", side_effect=crash_after_commit), self.assertRaises(RuntimeError):
            self.start()
        original = self.f.store.intent("test")
        changed = copy.deepcopy(original)
        changed["quantity"] = "999"
        with self.assertRaises(sqlite3.IntegrityError):
            self.f.store.create_cycle_intent(changed, "must not be inserted")
        self.assertEqual(self.f.store.intent("test"), original)
        with self.f.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)

    def test_send_marker_failure_leaves_no_partial_intent_and_never_sends(self):
        with patch("trading.execution.recovery.mark_send", side_effect=TradingError("invalid recovery identity")), \
             patch.object(self.f.broker, "submit") as submit, \
             self.assertRaisesRegex(TradingError, "invalid recovery identity"):
            self.start()
        submit.assert_not_called()
        self.assertFalse(self.executor.last_send_attempted)
        with self.f.store.connect() as db:
            for name in ("intents", "cycle_volume_sync", "events"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)
        self.assertEqual(self.f.store.get("cycle:test"), self.progress)

    def test_writer_guard_failure_rolls_back_marker_index_and_event_without_sending(self):
        revoked = []
        def assert_current():
            # Inspect the still-uncommitted transaction at the real Store guard.
            db = self.f.store._connection_local.db
            row = db.execute("SELECT data FROM intents").fetchone()
            if row is not None:
                intent = json.loads(row[0])
                self.assertIn("last_send_at", intent["bounded_recovery"])
                for name in ("intents", "cycle_volume_sync", "events"):
                    self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 1)
                revoked.append(intent["id"])
                raise TradingError("writer ownership revoked")
        writer = SimpleNamespace(assert_current=assert_current)
        with patch.object(self.f.store, "account_writer", writer, create=True), \
             patch.object(self.f.broker, "submit") as submit, \
             self.assertRaisesRegex(TradingError, "writer ownership revoked"):
            self.start()
        self.assertEqual(len(revoked), 1)
        submit.assert_not_called()
        self.assertFalse(self.executor.last_send_attempted)
        with self.f.store.connect() as db:
            for name in ("intents", "cycle_volume_sync", "events"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)
        self.assertEqual(self.f.store.get("cycle:test"), self.progress)

    def test_observation_failure_cannot_count_a_failed_commit_as_a_send(self):
        with patch("trading.cycle_execution.ObservedBroker", side_effect=RuntimeError("display unavailable")), \
             patch.object(self.f.store, "create_cycle_intent", side_effect=sqlite3.OperationalError("commit failed")), \
             patch.object(self.f.broker, "submit") as submit, \
             self.assertRaisesRegex(sqlite3.OperationalError, "commit failed"):
            self.start()
        submit.assert_not_called()
        self.assertFalse(self.executor.last_send_attempted)
        self.assertIsNone(self.f.store.intent("test"))
        self.assertIsNone(self.executor._cycle_submit_guard)

    def test_crash_after_fills_before_receipt_commit_recovers_original_orders_once(self):
        original = self.f.broker.submit
        def accepted_then_crashed(orders):
            original(orders)
            raise RuntimeError("crash before receipt commit")
        with patch.object(self.f.broker, "submit", side_effect=accepted_then_crashed) as submit, \
             self.assertRaisesRegex(RuntimeError, "crash before receipt commit"):
            self.start()
        submit.assert_called_once()
        pending = self.f.store.intent("test")
        self.assertEqual(pending["receipts"], {})
        self.assertIn("last_send_at", pending["bounded_recovery"])
        store = Store(self.f.store.path)
        broker = PaperBroker("test", self.f.market, store)
        restored = CycleExecutor(store, broker, self.f.market)
        with patch.object(broker, "submit", side_effect=AssertionError("must not resend")), \
             patch.object(broker, "query", wraps=broker.query) as query:
            restored.reconcile(self.f.account)
            restored.reconcile(self.f.account)
        self.assertEqual([call.args[1] for call in query.call_args_list],
                         [order["newClientOrderId"] for order in pending["orders"]])
        self.assertIsNone(store.intent("test"))
        self.assertEqual(store.get("cycle:test")["quantities"], {"LONG": "2", "SHORT": "2"})
        self.assertEqual(store.get("cycle:test")["phase"], "holding")
        with store.connect() as db:
            index = db.execute("SELECT status,synced_at FROM cycle_volume_sync WHERE intent_id=?", (pending["id"],)).fetchone()
            self.assertEqual(index["status"], "complete")
            self.assertIsNotNone(index["synced_at"])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE message LIKE '%同时加仓%'").fetchone()[0], 1)

    def test_unknown_send_keeps_original_marker_and_bounded_queries_across_restart(self):
        with patch.object(self.f.broker, "submit", side_effect=AmbiguousOrder("unknown send")) as submit, \
             patch.object(self.executor, "reconcile", return_value="restart before queries"):
            self.start()
        submit.assert_called_once()
        pending = self.f.store.intent("test")
        self.assertEqual(pending["receipts"], {})
        store = Store(self.f.store.path)
        broker = PaperBroker("test", self.f.market, store)
        restored = CycleExecutor(store, broker, self.f.market)
        with patch.object(broker, "submit", side_effect=AssertionError("must not resend")), \
             patch.object(broker, "query", side_effect=ExchangeError("not visible", code=-2013)) as query:
            for _ in range(5):
                restored.reconcile(self.f.account)
        self.assertEqual(query.call_count, 6)
        current = store.intent("test")
        self.assertEqual(current["orders"], pending["orders"])
        self.assertEqual(current["receipts"], {})
        self.assertEqual(current["bounded_recovery"]["last_send_at"], pending["bounded_recovery"]["last_send_at"])
        self.assertEqual(current["bounded_recovery"]["checks"],
                         {order["newClientOrderId"]: 3 for order in pending["orders"]})
        with store.connect() as db:
            index = db.execute("SELECT status,synced_at FROM cycle_volume_sync WHERE intent_id=?", (pending["id"],)).fetchone()
            self.assertEqual(index["status"], "pending")
            self.assertIsNone(index["synced_at"])

    def test_final_plan_reuses_exact_batch_amounts_without_rescanning(self):
        final = self.final_observation()
        with patch("trading.cycle_quality._depth_sweeps", side_effect=AssertionError("no display rescan")) as sweep:
            self.start(before_submit=lambda snapshot: final)
        sweep.assert_not_called()
        estimate = self.quality()["final_estimate"]
        self.assertEqual(estimate["status"], "available")
        self.assertEqual((estimate["buy_vwap"], estimate["sell_vwap"]), ("4412.02", "4412.01"))
        self.assertEqual(estimate["spread_bp"], self.quality()["actual"]["spread_bp"])
        self.assertNotEqual(estimate["spread_bp"], "99")
        self.assertEqual(estimate["sampled_at"], final["depth"].timestamp)

    def test_final_close_plan_maps_short_to_buy_and_long_to_sell(self):
        self.start()
        final = self.final_observation("close")
        with patch("trading.cycle_quality._depth_sweeps", side_effect=AssertionError("no display rescan")):
            self.start("close", before_submit=lambda snapshot: final)
        estimate = self.quality()["final_estimate"]
        self.assertEqual((estimate["buy_vwap"], estimate["sell_vwap"]), ("4412.02", "4412.01"))
        self.assertEqual(estimate["spread_bp"], self.quality()["actual"]["spread_bp"])

    def test_mismatched_observation_is_unknown_and_cannot_change_order_quantity(self):
        final = self.final_observation(qty=dec(999))
        with patch.object(self.f.broker, "submit", wraps=self.f.broker.submit) as submit:
            self.start(before_submit=lambda snapshot: final)
        self.assertEqual(self.quality()["final_estimate"]["status"], "unavailable")
        self.assertEqual([order["quantity"] for order in submit.call_args.args[0]], ["2", "2"])
        self.assertEqual(self.quality()["actual"]["status"], "filled")

    def test_plan_identity_and_stale_depth_are_not_reported_as_valid_observations(self):
        from trading.cycle_quality import estimate_from_plan
        for changes in ({"symbol": "CLUSD1"}, {"phase": "close"}):
            final = self.final_observation(**changes)
            result = estimate_from_plan("2", final["quality_plan"], final["depth"], final["checked_at"],
                                        symbol="XAUUSD1", phase="open")
            self.assertEqual(result["status"], "unavailable")
        final = self.final_observation()
        depth = replace(final["depth"], timestamp=time.time() - 4)
        result = estimate_from_plan("2", final["quality_plan"], depth, final["checked_at"], symbol="XAUUSD1", phase="open")
        self.assertEqual(result["status"], "unavailable")

    def test_observation_clock_failure_does_not_swallow_trading_failure(self):
        with patch("trading.cycle_quality.time", SimpleNamespace(monotonic=Mock(side_effect=RuntimeError("no clock")), time=time.time)):
            with patch.object(self.f.broker, "cycle_snapshot", side_effect=TradingError("account check failed")), \
                 patch.object(self.f.broker, "submit") as submit, self.assertRaisesRegex(TradingError, "account check failed"):
                book = self.f.market.book("XAUUSD1")
                plan = CyclePlan("open", "XAUUSD1", dec(2), 2, dec(2) * book.ask, dec(2) * book.bid, dec("0.02"))
                snapshot = PaperBroker.cycle_snapshot(self.f.broker, ["XAUUSD1"])
                self.executor.start(self.f.account, snapshot, plan, self.progress)
            submit.assert_not_called()
            self.start()
        self.assertEqual(self.quality()["actual"]["status"], "filled")
        self.assertTrue(all(value is None for value in self.quality()["timing"]["pre_submit"].values()))

    def test_nonoverlapping_stage_timings_and_remainder_are_persisted(self):
        final = self.final_observation()
        final["checked_monotonic"] = 100.239
        ticks = [100.200, 100.220, 100.230, 100.240, 100.250, 100.280, 100.400, 100.450]
        timer = SimpleNamespace(monotonic=Mock(side_effect=ticks), time=time.time)
        trigger = {"source": "bbo", "received_at": time.time(), "received_monotonic": 100,
                   "pre_submit": {"queue_ms": 30, "initial_account_ms": 80, "planning_ms": 40}}
        with patch("trading.cycle_quality.time", timer):
            self.start(trigger=trigger, before_submit=lambda snapshot: final)
        parts = self.quality()["timing"]["pre_submit"]
        expected = {"queue_ms": 30, "initial_account_ms": 80, "planning_ms": 40,
                    "final_account_ms": 20, "final_check_ms": 10, "persist_ms": 30, "other_ms": 190}
        for key, value in expected.items():
            self.assertAlmostEqual(parts[key], value)
        self.assertAlmostEqual(self.quality()["timing"]["trigger_to_request_ms"], 400)
        self.assertEqual(self.executor.last_completed_intent["execution_quality"], self.quality())
        with self.f.store.connect() as db:
            stored = json.loads(db.execute("SELECT data FROM intents WHERE id=?", (self.quality()["intent_id"],)).fetchone()[0])
        self.assertEqual(stored["execution_quality"]["timing"]["pre_submit"], parts)

    def test_missing_or_overlapping_measurements_leave_remainder_unknown(self):
        normal = {"queue_ms": 10, "initial_account_ms": 20, "planning_ms": 30,
                  "final_account_ms": 10, "final_check_ms": 10, "persist_ms": 20, "other_ms": 123}
        for change, expected in (({"queue_ms": None}, None), ({"persist_ms": 50}, None), ({}, 0)):
            with self.subTest(change=change):
                quality = {"timing": {"pre_submit": {**normal, **change}}}
                timer = SimpleNamespace(monotonic=Mock(side_effect=[100.1, 100.15]), time=time.time)
                with patch("trading.cycle_quality.time", timer):
                    ObservedBroker(SimpleNamespace(submit=lambda orders: []), quality, 100).submit([])
                self.assertEqual(quality["timing"]["pre_submit"]["other_ms"], expected)


if __name__ == "__main__":
    unittest.main()

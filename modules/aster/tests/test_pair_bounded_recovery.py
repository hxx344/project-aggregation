"""Finite original-ID evidence must hand off to fresh, atomic position checks."""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
import time
import unittest
from unittest.mock import patch

from tests import test_pair_integration as integration
from tests import test_pair_order_recovery as fixtures
from trading.engine import Engine
from trading.exchange import BudgetWait, ExchangeError, RequestNotSent
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader
from trading.pair_planning import PairRecoveryConflict
from trading.pair_recovery import _watch_evidence_key, recovery_ready, require_archived_orders_clear
from trading.store import Store


class PairBoundedRecoveryTests(unittest.TestCase):
    setUp = integration.PairIntegrationTests.setUp
    seed = fixtures.PairOrderRecoveryTests.seed
    state = fixtures.PairOrderRecoveryTests.state
    broker = fixtures.PairOrderRecoveryTests.broker
    no_writes = fixtures.PairOrderRecoveryTests.no_writes

    def setup_trader(self):
        trader = PairTrader(self.engine)
        self.engine.pairs.trader = trader
        return trader

    def unknown(self, error=None):
        stack = ExitStack()
        for side in ("long", "short"):
            stack.enter_context(patch.object(self.broker(side), "query", side_effect=error or
                ExchangeError("not found", code=-2013)))
        return stack

    def age(self, seconds=121):
        state = self.state()
        state["pending"]["bounded_recovery"]["observed_at"] = time.time() - seconds
        self.f.store.put("pair_runtime:gold", state)

    def ready(self, kind="ordinary"):
        original = self.seed()
        state = self.state()
        state["pending"].update(kind=kind, bounded_recovery={"observed_at": time.time() - 121})
        for leg in state["pending"]["legs"]:
            leg["recovery_query_attempts"] = 3
        self.f.store.put("pair_runtime:gold", state)
        self.setup_trader()
        return original

    def quantities(self, long="3.239", short="3.239"):
        for key, value in (("long", long), ("short", short)):
            broker = self.broker(key)
            broker.state["positions"]["XAUUSD1:" + key.upper()]["qty"] = value
            broker.save()

    def test_three_real_attempts_and_120_seconds_are_both_required_across_restart(self):
        self.seed()
        self.setup_trader()
        with self.no_writes(), self.unknown():
            for _ in range(3):
                self.engine.pairs.tick("gold")
        state = self.state()
        self.assertIsNotNone(state["pending"])
        self.assertEqual([leg["recovery_query_attempts"] for leg in state["pending"]["legs"]], [3, 3])
        self.age()
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.addCleanup(restarted.dashboard_reports.close)
        with ExitStack() as stack:
            for aid in ("test", "second"):
                broker = restarted.broker(restarted.store.account(aid))
                for method in ("query", "submit", "set_leverage"):
                    stack.enter_context(patch.object(broker, method, side_effect=AssertionError("old request must not repeat")))
            restarted.pairs.tick("gold")
        state = self.state()
        self.assertIsNone(state["pending"], state["reason"])
        self.assertEqual(state["last_batch"]["resolution"], "positions_adopted_unknown")
        self.assertTrue(state["volume_unknown"])
        self.assertEqual(state["volume_unknown_until_utc"], datetime.now(timezone.utc).date().isoformat())
        batch = self.f.store.get("pair_batch:" + fixtures.BATCH_ID)
        self.assertFalse(batch["completed"])
        self.assertTrue(all(leg["receipt"] is None for leg in batch["legs"]))

    def test_old_creation_time_does_not_skip_three_attempts_or_first_observation_window(self):
        self.seed()
        self.setup_trader()
        with self.no_writes(), self.unknown():
            self.engine.pairs.tick("gold")
            self.age()
            self.engine.pairs.tick("gold")
            self.assertIsNotNone(self.state()["pending"])
            self.engine.pairs.tick("gold")
        self.assertIsNone(self.state()["pending"], self.state()["reason"])

    def test_budget_and_request_not_sent_do_not_consume_attempts(self):
        local = ExchangeError("接口冷却中：缓存冷却", retry_after=10)
        local.local_cooldown = True
        for exc in (BudgetWait("budget", retry_after=10), RequestNotSent("not sent", retry_after=10), local):
            self.seed()
            self.setup_trader()
            with self.no_writes(), self.unknown(exc):
                for _ in range(4):
                    self.engine.pairs.tick("gold")
            self.assertTrue(all(not leg.get("recovery_query_attempts") for leg in self.state()["pending"]["legs"]))

    def test_real_http_429_response_counts_once_but_local_backoff_does_not(self):
        self.seed()
        self.setup_trader()
        with self.no_writes(), self.unknown(ExchangeError("接口冷却中：HTTP 429", retry_after=180, http_status=429)):
            self.engine.pairs.tick("gold")
        self.assertEqual([leg["recovery_query_attempts"] for leg in self.state()["pending"]["legs"]], [1, 1])
        with self.no_writes(), self.unknown(RequestNotSent("接口冷却中：HTTP 429", retry_after=179)):
            self.engine.pairs.tick("gold")
        self.assertEqual([leg["recovery_query_attempts"] for leg in self.state()["pending"]["legs"]], [1, 1])

    def test_only_three_original_queries_are_sent_while_waiting_for_age(self):
        self.seed()
        self.setup_trader()
        with self.no_writes(), ExitStack() as stack:
            queries = [stack.enter_context(patch.object(self.broker(side), "query", side_effect=
                ExchangeError("not found", code=-2013))) for side in ("long", "short")]
            for _ in range(8):
                self.engine.pairs.tick("gold")
        self.assertEqual([query.call_count for query in queries], [3, 3])
        self.assertIsNotNone(self.state()["pending"])

    def test_active_receipt_cannot_enter_reality_stage_and_keeps_querying_original_id(self):
        self.ready()
        state = self.state()
        state["pending"]["bounded_recovery"]["stage"] = "positions"
        active, complete = state["pending"]["legs"]
        active["receipt"] = fixtures.receipt_for(active, status="PARTIALLY_FILLED", qty="0.1")
        complete["receipt"] = fixtures.receipt_for(complete, status="FILLED", qty="0.2")
        saved_receipt = deepcopy(active["receipt"])
        terminal = fixtures.receipt_for(active, status="FILLED", qty="0.2")
        self.f.store.put("pair_runtime:gold", state)
        self.quantities()
        self.assertFalse(recovery_ready(state["pending"]))
        wall = time.time()
        with self.no_writes(), patch("time.time", side_effect=lambda: wall), \
                patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("active order")), \
                patch.object(self.broker(), "query", side_effect=[ExchangeError("not found", code=-2013), terminal]) as query:
            self.engine.pairs.tick("gold")
            self.assertEqual(self.state()["pending"]["legs"][0]["receipt"], saved_receipt)
            self.engine.pairs.trader = PairTrader(self.engine)
            wall += 29
            self.engine.pairs.check_recovery("gold")
            self.assertEqual(query.call_count, 1)
            self.assertIsNotNone(self.state()["pending"])
            wall += 1
            self.engine.pairs.tick("gold")
            self.assertEqual(query.call_count, 2)
        self.assertIsNone(self.state()["pending"])
        self.assertTrue(self.state()["last_batch"]["completed"])

    def test_recent_repair_resets_safety_window_even_for_an_old_batch(self):
        self.ready()
        state = self.state()
        state["pending"]["last_possible_send_at"] = time.time()
        repair = deepcopy(state["pending"]["legs"][0])
        repair["order"].update(side="SELL", newClientOrderId="new-repair")
        state["pending"]["repairs"].append(repair)
        self.f.store.put("pair_runtime:gold", state)
        with self.no_writes(), self.unknown():
            self.engine.pairs.tick("gold")
        self.assertIsNotNone(self.state()["pending"])

    def test_balanced_cycle_positions_become_baseline_without_automatic_close(self):
        self.ready("cycle")
        self.quantities()
        with self.no_writes(), self.unknown():
            self.engine.pairs.tick("gold")
        state = self.state()
        self.assertIsNone(state["pending"], state["reason"])
        self.assertEqual(state["owned"], {"LONG": "3.239", "SHORT": "3.239"})
        self.assertEqual(state["progress"]["quantities"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(state["progress"]["completed_cycles"], 4)

    def test_unbalanced_and_incomplete_orders_and_stale_snapshots_keep_pending(self):
        for case in ("unbalanced", "open_orders", "missing_orders", "stale", "equity"):
            self.ready()
            self.quantities("3.039", "3.039")
            original = self.engine.pairs._read_members
            if case == "unbalanced":
                self.quantities("3.239", "3.039")
            def read(*args, **kwargs):
                snapshots, guards = original(*args, **kwargs)
                snap = snapshots["long"]
                if case == "stale":
                    snap.timestamp -= 20
                if case == "equity":
                    snap.equity = dec("0")
                if case == "open_orders":
                    raise TradingError("actual active orders")
                if case == "missing_orders":
                    raise TradingError("incomplete full-account orders")
                return snapshots, guards
            with self.subTest(case=case), self.no_writes(), patch.object(self.engine.pairs, "_read_members", side_effect=read):
                self.engine.pairs.tick("gold")
                self.assertIsNotNone(self.state()["pending"])

    def test_runtime_cas_does_not_overwrite_a_concurrent_change(self):
        self.ready()
        original = self.engine.pairs._read_members
        newer = deepcopy(self.state())
        newer["concurrent_marker"] = "retain me"
        def read(*args, **kwargs):
            result = original(*args, **kwargs)
            Store(self.f.store.path).put("pair_runtime:gold", newer)
            return result
        with self.no_writes(), patch.object(self.engine.pairs, "_read_members", side_effect=read):
            self.engine.pairs.tick("gold")
        self.assertEqual(self.state(), newer)
        self.assertIsNone(self.f.store.get("pair_batch:" + fixtures.BATCH_ID))

    def test_auto_archived_watch_never_requeries_but_checks_actual_positions(self):
        self.ready()
        with self.no_writes():
            self.engine.pairs.tick("gold")
        pair = self.f.store.pair("gold")
        with self.no_writes(), patch.object(self.broker(), "query", side_effect=AssertionError("retired")), \
                patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
            require_archived_orders_clear(self.engine, pair)
            self.assertEqual(read.call_count, 1)
            self.quantities("3.239", "3.039")
            with self.assertRaises(TradingError):
                require_archived_orders_clear(self.engine, pair)

    def test_background_late_balanced_positions_reach_adoption_before_quantity_guard(self):
        self.ready()
        self.engine.pairs.tick("gold")
        self.f.store.save_pair({**self.f.store.pair("gold"), "enabled": True})
        self.quantities()
        with patch.object(self.broker(), "submit", side_effect=AssertionError("old state cannot trade")):
            self.engine.pairs.tick("gold")
        self.assertEqual(self.state()["owned"], {"LONG": "3.239", "SHORT": "3.239"})
        self.assertNotIn("attention", self.state())

    def test_tenth_archive_compacts_active_index_and_retains_every_original_batch(self):
        self.ready()
        template = deepcopy(self.state()["pending"])
        with self.no_writes():
            for index in range(10):
                state = self.state()
                pending = deepcopy(template)
                pending["id"] = f"archive-{index}"
                for leg in pending["legs"]:
                    leg["order"]["newClientOrderId"] = leg["key"] + pending["id"]
                state["pending"] = pending
                self.f.store.put("pair_runtime:gold", state)
                self.engine.pairs.tick("gold")
                self.assertIsNone(self.state()["pending"], self.state()["reason"])
        watch = self.state()["recovery_watch"]
        self.assertEqual(len(watch["batches"]), 8)
        self.assertEqual(watch["retired_symbols"], ["XAUUSD1"])
        self.assertEqual(watch["retired_identities"], self.state()["identities"])
        self.assertTrue(all(self.f.store.get(f"pair_batch:archive-{index}") for index in range(10)))
        with patch.object(self.broker(), "query", side_effect=AssertionError("retired indexes do not query")):
            require_archived_orders_clear(self.engine, self.f.store.pair("gold"))

    def test_legacy_watch_without_creation_time_uses_durable_observation_window(self):
        self.ready()
        self.engine.pairs.tick("gold")
        state = self.state()
        template = deepcopy(state["recovery_watch"]["batches"][0])
        state["recovery_watch"]["batches"] = []
        for index in range(8):
            row = deepcopy(template)
            row["id"] = f"legacy-{index}"
            row.pop("created_at")
            row.pop("bounded_queries_complete")
            for leg in row["legs"]:
                leg["order"]["newClientOrderId"] = leg["key"] + row["id"]
            state["recovery_watch"]["batches"].append(row)
        pending = deepcopy(self.f.store.get("pair_batch:" + fixtures.BATCH_ID))
        pending["id"] = "ninth-legacy"
        # This is another batch, not a retry of the archived batch's reserved read.
        pending["bounded_recovery"] = {"observed_at": time.time() - 121, "stage": "positions"}
        for leg in pending["legs"]:
            leg["order"]["newClientOrderId"] = leg["key"] + pending["id"]
        state["pending"] = pending
        self.f.store.put("pair_runtime:gold", state)
        with self.no_writes():
            self.engine.pairs.tick("gold")
        self.assertIsNotNone(self.state()["pending"])
        with self.f.store.connect() as db:
            key = db.execute("SELECT key FROM kv WHERE key LIKE 'pair_watch_evidence:%'").fetchone()[0]
        observed = Store(self.f.store.path).get(key)
        self.assertGreater(observed["first_observed_at"], 0)
        observed["first_observed_at"] -= 121
        self.f.store.put(key, observed)
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.addCleanup(restarted.dashboard_reports.close)
        retry_at = self.state()["pending"]["bounded_recovery"]["next_check_at"]
        with patch("time.time", return_value=retry_at):
            restarted.pairs.tick("gold")
        self.assertIsNone(self.state()["pending"], self.state()["reason"])
        self.assertEqual(len(self.state()["recovery_watch"]["batches"]), 8)
        self.assertEqual(self.f.store.get(key)["retired_batch"]["id"], "legacy-0")
        self.assertNotIn("created_at", self.f.store.get(key)["retired_batch"])

    def test_late_balanced_fill_is_adopted_once_and_repeated_receipt_does_not_block(self):
        original = self.seed()
        preview = self.engine.pairs.preview_recovery("gold")
        self.engine.pairs.confirm_recovery("gold", preview["token"], acknowledge_unknown=True)
        self.setup_trader()
        self.quantities()
        with self.no_writes(), ExitStack() as stack:
            for leg in original["pending"]["legs"]:
                stack.enter_context(patch.object(self.broker(leg["key"]), "query", return_value=
                    fixtures.receipt_for(leg, status="FILLED", qty="0.2")))
            with self.assertRaises(PairRecoveryConflict):
                require_archived_orders_clear(self.engine, self.f.store.pair("gold"))
            require_archived_orders_clear(self.engine, self.f.store.pair("gold"))
            require_archived_orders_clear(self.engine, self.f.store.pair("gold"))
        self.assertEqual(self.state()["owned"], {"LONG": "3.239", "SHORT": "3.239"})
        self.assertEqual(self.state()["daily_volume"], original["daily_volume"])

    def test_failed_archived_queries_are_bounded_across_restart(self):
        self.seed()
        preview = self.engine.pairs.preview_recovery("gold")
        self.engine.pairs.confirm_recovery("gold", preview["token"], acknowledge_unknown=True)
        self.setup_trader()
        pair = self.f.store.pair("gold")
        with self.no_writes(), self.unknown(ExchangeError("query unavailable")):
            for _ in range(2):
                with self.assertRaises(TradingError):
                    require_archived_orders_clear(self.engine, pair)
            with self.f.store.connect() as db:
                keys = [row[0] for row in db.execute("SELECT key FROM kv WHERE key LIKE 'pair_watch_evidence:%'")]
            for key in keys:
                observation = self.f.store.get(key)
                observation["first_observed_at"] -= 121
                self.f.store.put(key, observation)
            require_archived_orders_clear(self.engine, pair)
        with patch.object(self.broker(), "query", side_effect=AssertionError("retired")):
            require_archived_orders_clear(self.engine, pair)

    def test_archived_local_cooldown_does_not_consume_query_budget(self):
        self.seed()
        preview = self.engine.pairs.preview_recovery("gold")
        self.engine.pairs.confirm_recovery("gold", preview["token"], acknowledge_unknown=True)
        local = ExchangeError("接口冷却中：本地缓存", retry_after=10)
        local.local_cooldown = True
        with self.no_writes(), self.unknown(local), self.assertRaises(TradingError):
            require_archived_orders_clear(self.engine, self.f.store.pair("gold"))
        with self.f.store.connect() as db:
            key = db.execute("SELECT key FROM kv WHERE key LIKE 'pair_watch_evidence:%'").fetchone()[0]
        self.assertTrue(all(not row.get("recovery_query_attempts") for row in self.f.store.get(key)["legs"].values()))

    def flat_watch(self, *, manual=False):
        self.seed({"LONG": "0", "SHORT": "0"})
        if manual:
            preview = self.engine.pairs.preview_recovery("gold")
            self.engine.pairs.confirm_recovery("gold", preview["token"], acknowledge_unknown=True)
        else:
            state = self.state()
            state["pending"]["bounded_recovery"] = {"observed_at": time.time() - 121}
            for leg in state["pending"]["legs"]:
                leg["recovery_query_attempts"] = 3
            self.f.store.put("pair_runtime:gold", state)
            self.setup_trader()
            self.engine.pairs.tick("gold")
        self.assertIsNone(self.state()["pending"], self.state()["reason"])

    def test_exhausted_flat_watch_can_be_deleted_without_losing_original_audit(self):
        self.flat_watch()
        watch = deepcopy(self.state()["recovery_watch"])
        audit = self.f.store.get("pair_order_recovery:gold:" + fixtures.BATCH_ID)
        batch = self.f.store.get("pair_batch:" + fixtures.BATCH_ID)
        with self.no_writes(), self.unknown(AssertionError("retired original ids cannot be requeried")):
            self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))
        self.assertIsNone(self.state().get("recovery_watch"))
        self.assertEqual(self.f.store.get("pair_deleted_watch:gold")["watch"], watch)
        self.assertEqual(self.f.store.get("pair_order_recovery:gold:" + fixtures.BATCH_ID), audit)
        self.assertEqual(self.f.store.get("pair_batch:" + fixtures.BATCH_ID), batch)
        self.assertTrue(all(self.f.store.pair_for_account(aid) is None for aid in ("test", "second")))

    def test_manual_watch_deletion_requires_three_reads_and_persisted_window(self):
        self.flat_watch(manual=True)
        batch = self.state()["recovery_watch"]["batches"][0]
        key = _watch_evidence_key("gold", batch)
        with self.no_writes(), self.unknown(), ExitStack() as stack:
            queries = [stack.enter_context(patch.object(self.broker(side), "query", side_effect=
                ExchangeError("not found", code=-2013))) for side in ("long", "short")]
            for _ in range(4):
                with self.assertRaises(TradingError):
                    self.engine.pairs.delete("gold")
            self.assertEqual([query.call_count for query in queries], [3, 3])
        observed = self.f.store.get(key)
        observed["first_observed_at"] -= 121
        self.f.store.put(key, observed)
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.addCleanup(restarted.dashboard_reports.close)
        with patch.object(restarted.broker(restarted.store.account("test")), "query", side_effect=AssertionError("exhausted")):
            restarted.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))

    def test_compacted_archive_is_also_exhausted_before_deletion(self):
        self.flat_watch()
        state = self.state()
        archived = deepcopy(state["recovery_watch"]["batches"][0])
        archived.pop("bounded_queries_complete")
        archived["id"] = "older-compacted"
        for leg in archived["legs"]:
            leg["order"]["newClientOrderId"] = "old-" + leg["key"]
        state["recovery_watch"]["retired_identities"] = state["identities"]
        state["recovery_watch"]["retired_symbols"] = ["XAUUSD1"]
        self.f.store.put("pair_runtime:gold", state)
        key = _watch_evidence_key("gold", archived)
        self.f.store.put(key, {"retired_batch": archived, "first_observed_at": time.time() - 121,
            "legs": {leg["order"]["newClientOrderId"]: {"recovery_query_attempts": 2} for leg in archived["legs"]}})
        with self.no_writes(), ExitStack() as stack:
            queries = [stack.enter_context(patch.object(self.broker(side), "query", side_effect=
                ExchangeError("not found", code=-2013))) for side in ("long", "short")]
            self.engine.pairs.delete("gold")
            self.assertEqual([query.call_count for query in queries], [1, 1])
        self.assertEqual(self.f.store.get("pair_deleted_watch:gold")["evidence"][key]["retired_batch"], archived)

    def test_delete_cas_preserves_watch_on_runtime_margin_or_evidence_change(self):
        for change in ("runtime", "margin", "evidence"):
            self.flat_watch()
            original_read = self.engine.pairs._read_members
            before = self.state()
            def read(*args, **kwargs):
                result = original_read(*args, **kwargs)
                if change == "runtime":
                    Store(self.f.store.path).put("pair_runtime:gold", {**before, "concurrent": True})
                elif change == "margin":
                    Store(self.f.store.path).put("pair_margin:gold", {"pending": {"id": "new-transfer"}})
                else:
                    Store(self.f.store.path).put("pair_watch_evidence:gold:concurrent", {"retired": False})
                return result
            with self.subTest(change=change), self.no_writes(), \
                    patch.object(self.engine.pairs, "_read_members", side_effect=read), self.assertRaises(TradingError):
                self.engine.pairs.delete("gold")
            self.assertEqual(self.state()["recovery_watch"], before["recovery_watch"])
            self.assertIsNotNone(self.f.store.pair("gold"))
            self.assertIsNone(self.f.store.get("pair_deleted_watch:gold"))
            self.f.store.put("pair_margin:gold", {})

    def terminal_cycle(self, case="mismatch"):
        self.seed()
        self.setup_trader()
        state = self.state()
        pending = state["pending"]
        pending.update(kind="cycle", created_at=time.time() - 200)
        for leg in pending["legs"]:
            leg["receipt"] = fixtures.receipt_for(leg, status="FILLED", qty="0.2", timestamp=int((time.time() - 120) * 1000))
        self.quantities("3.439", "3.439")
        if case == "leverage":
            self.quantities("3.239", "3.239")
            pending["leverage"] = 10
        elif case == "repairs":
            self.quantities("3.239", "3.239")
            pending["repair_attempts"] = 3
            for leg in pending["legs"]:
                leg["receipt"]["status"] = "EXPIRED"
        for side in ("long", "short"):
            broker = self.broker(side)
            # These cases explicitly model later manual positions/leverage.
            broker.state["positions"]["XAUUSD1:" + side.upper()]["updateTime"] = int(time.time() * 1000)
            broker.save()
        self.f.store.put("pair_runtime:gold", state)

    def test_terminal_cycle_mismatch_leverage_and_exhausted_repairs_have_finite_safe_exit(self):
        for case in ("mismatch", "leverage", "repairs"):
            self.terminal_cycle(case)
            with self.subTest(case=case), self.no_writes(), self.unknown(AssertionError("terminal receipts must not be requeried")):
                for _ in range(4):
                    self.engine.pairs.tick("gold")
                self.assertEqual(self.state()["pending"]["recovery_query_attempts"], 3)
                self.assertIsNotNone(self.state()["pending"])
                self.age()
                self.engine.pairs.tick("gold")
            state = self.state()
            self.assertIsNone(state["pending"], state["reason"])
            self.assertEqual(state["last_batch"]["resolution"], "terminal_positions_adopted")
            self.assertFalse(state["last_batch"]["completed"])
            self.assertEqual(state["progress"]["completed_cycles"], 4)
            self.assertEqual(state["progress"]["quantities"], {"LONG": "0", "SHORT": "0"})
            batch = self.f.store.get("pair_batch:" + fixtures.BATCH_ID)
            self.assertTrue(all(leg["receipt"]["executedQty"] == "0.2" for leg in batch["legs"]))
            day = datetime.now(timezone.utc).date().isoformat()
            self.assertEqual({key: dec(value) for key, value in state["daily_volume"][day].items()},
                {"long": dec("882.403"), "short": dec("882.403")})

    def test_terminal_cycle_unsafe_actual_positions_remain_pending_after_budget(self):
        self.terminal_cycle()
        with self.no_writes():
            for _ in range(3):
                self.engine.pairs.tick("gold")
            self.age()
            self.quantities("3.439", "3.239")
            self.engine.pairs.tick("gold")
        self.assertIsNotNone(self.state()["pending"])
        self.assertEqual(self.state()["pending"]["bounded_recovery"]["stage"], "positions")


class PairLeverageBoundedTests(unittest.TestCase):
    def setUp(self):
        from tests.test_pair_upgrade_capacity import PairUpgradeExecutionTests
        PairUpgradeExecutionTests.setUp(self)

    def publish(self, capacity):
        from tests.test_pair_upgrade_capacity import PairUpgradeExecutionTests
        PairUpgradeExecutionTests.publish(self, capacity)

    def test_common_actual_leverage_ends_unknown_and_cooldown_allows_ordinary(self):
        state = self.state
        state["pending"] = {"id": "bounded-upgrade", "kind": "leverage", "symbol": "XAUUSD1",
            "identities": state["identities"], "created_at": time.time() - 3600,
            "before": state["owned"], "target_leverage": 20, "previous_leverage": 10,
            "results": {"long": {"unknown": True}, "short": {"unknown": True}},
            "bounded_recovery": {"observed_at": time.time() - 121}, "recovery_query_attempts": 3}
        self.store.put("pair_runtime:gold", state)
        self.engine.pairs.trader = self.trader
        current = self.trader.tick(self.pair)
        self.assertIsNone(current["pending"], current["reason"])
        self.assertEqual(current["leverage_recovery_cooldown"]["target"], 20)
        with ExitStack() as stack:
            for broker in self.brokers.values():
                stack.enter_context(patch.object(broker, "set_leverage", side_effect=AssertionError("cooldown must plan ordinary")))
            next_state = self.trader.tick(self.pair)
        self.assertIsNone(next_state["pending"], next_state["reason"])
        self.assertEqual(next_state["last_batch"]["kind"], "ordinary")
        self.assertGreater(dec(next_state["owned"]["LONG"]), 3)

    def test_leverage_cached_cooldown_is_not_a_real_read_attempt(self):
        self.state["pending"] = {"kind": "leverage", "symbol": "XAUUSD1"}
        local = ExchangeError("接口冷却中：缓存", retry_after=10)
        local.local_cooldown = True
        with patch.object(self.trader, "_read", side_effect=local), self.assertRaises(TradingError):
            self.trader._recover_leverage(self.pair, self.state, self.brokers)
        self.assertNotIn("recovery_query_attempts", self.state["pending"])
        remote = ExchangeError("接口冷却中：HTTP 429", retry_after=180, http_status=429)
        with patch.object(self.trader, "_read", side_effect=remote), self.assertRaises(TradingError):
            self.trader._recover_leverage(self.pair, self.state, self.brokers)
        self.assertEqual(self.state["pending"]["recovery_query_attempts"], 1)


class PairBoundedLiveTests(unittest.TestCase):
    setUp = integration.PairSnapshotLifecycleTests.setUp
    tearDown = integration.PairSnapshotLifecycleTests.tearDown
    seed = fixtures.PairOrderRecoveryTests.seed
    state = fixtures.PairOrderRecoveryTests.state
    broker = fixtures.PairOrderRecoveryTests.broker
    no_writes = fixtures.PairOrderRecoveryTests.no_writes
    setup_trader = PairBoundedRecoveryTests.setup_trader
    ready = PairBoundedRecoveryTests.ready
    flat_watch = PairBoundedRecoveryTests.flat_watch

    def test_watch_deletion_requires_complete_full_account_orders(self):
        from tests.test_cycle_account_snapshot import ORDERS
        self.flat_watch()
        before = self.state()
        for orders in (None, {"orders": []}, [{"symbol": "SPCXUSD1"}]):
            self.broker().api.responses[ORDERS] = orders
            with self.subTest(orders=orders), self.no_writes(), self.assertRaises(TradingError):
                self.engine.pairs.delete("gold")
            self.assertEqual(self.state(), before)
            self.assertIsNotNone(self.f.store.pair("gold"))
        self.broker().api.responses[ORDERS] = []
        with self.no_writes():
            self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))

    def test_watch_deletion_rechecks_live_identity_event_and_freshness_at_commit(self):
        self.flat_watch()
        before = self.state()
        original = self.engine.pairs._read_members
        credentials = deepcopy(self.broker().api.credentials)
        for change in ("identity", "event", "stale"):
            def read(*args, **kwargs):
                result = original(*args, **kwargs)
                if change == "identity":
                    self.broker().api.credentials["user"] = "0x" + "9" * 40
                elif change == "event":
                    self.broker()._cycle_account_event("ACCOUNT_UPDATE")
                else:
                    result[0]["long"].timestamp -= 20
                return result
            with self.subTest(change=change), self.no_writes(), \
                    patch.object(self.engine.pairs, "_read_members", side_effect=read), self.assertRaises(TradingError):
                self.engine.pairs.delete("gold")
            self.broker().api.credentials = deepcopy(credentials)
            self.assertEqual(self.state(), before)
            self.assertIsNone(self.f.store.get("pair_deleted_watch:gold"))

    def test_market_recovery_never_queries_full_account_open_orders(self):
        from tests.test_cycle_account_snapshot import ORDERS
        for orders in (None, {"orders": []}, [{"symbol": "SPCXUSD1"}]):
            self.ready()
            self.broker().api.responses[ORDERS] = orders
            for broker in self.live.values():
                broker.api.calls.clear()
            with self.subTest(orders=orders), self.no_writes():
                self.engine.pairs.tick("gold")
            self.assertIsNone(self.state()["pending"], self.state()["reason"])
            self.assertIsNotNone(self.f.store.get("pair_batch:" + fixtures.BATCH_ID))
            self.assertTrue(all(not any(call[1] == ORDERS for call in broker.api.calls)
                                for broker in self.live.values()))

    def test_fresh_full_account_reads_allow_unknown_adoption_without_requery(self):
        from tests.test_cycle_account_snapshot import ORDERS
        self.ready()
        for broker in self.live.values():
            broker.api.calls.clear()
        with self.no_writes():
            self.engine.pairs.tick("gold")
        self.assertIsNone(self.state()["pending"], self.state()["reason"])
        for broker in self.live.values():
            self.assertFalse(any(call[1] == ORDERS for call in broker.api.calls))
            self.assertTrue(any(call[1].endswith("accountWithJoinMargin") for call in broker.api.calls))
            self.assertFalse(any(call[1] == "/fapi/v3/order" for call in broker.api.calls))

    def test_identity_change_or_account_event_after_read_keeps_unknown_batch(self):
        for change in ("identity", "event", "stale"):
            self.ready()
            original = self.engine.pairs._read_members
            credentials = deepcopy(self.broker().api.credentials)
            def read(*args, **kwargs):
                result = original(*args, **kwargs)
                if change == "identity":
                    self.broker().api.credentials["user"] = "0x" + "9" * 40
                elif change == "event":
                    self.broker()._cycle_account_event("ACCOUNT_UPDATE")
                else:
                    result[0]["long"].timestamp -= 20
                return result
            with self.subTest(change=change), self.no_writes(), \
                    patch.object(self.engine.pairs, "_read_members", side_effect=read):
                self.engine.pairs.tick("gold")
            self.assertIsNotNone(self.state()["pending"])
            self.assertIsNone(self.f.store.get("pair_batch:" + fixtures.BATCH_ID))
            self.broker().api.credentials = credentials


if __name__ == "__main__":
    unittest.main()

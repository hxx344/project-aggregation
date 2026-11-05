"""Known fills of archived and compacted watches constrain every adopted snapshot's direction times."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_integration as integration
from tests import test_pair_order_recovery as fixtures
from trading import pair_recovery
from trading.models import TradingError, dec, wire
from trading.pair_execution import PairTrader
from trading.pair_planning import PairRecoveryConflict
from trading.pair_recovery import _watch_evidence_key, require_archived_orders_clear

SYMBOL = "XAUUSD1"
SIDES = (("long", "LONG"), ("short", "SHORT"))


class PairHistoryTimeTests(TestCase):
    setUp = integration.PairIntegrationTests.setUp
    state = fixtures.PairOrderRecoveryTests.state
    broker = fixtures.PairOrderRecoveryTests.broker
    no_writes = fixtures.PairOrderRecoveryTests.no_writes

    def positions(self, qty=None, update_time="keep", sides=SIDES):
        for key, side in sides:
            broker = self.broker(key)
            row = broker.state["positions"][SYMBOL + ":" + side]
            if qty is not None:
                row["qty"] = qty
            if update_time is None:
                row.pop("updateTime", None)
            elif update_time != "keep":
                row["updateTime"] = update_time
            broker.save()

    def records(self, *prefixes):
        with self.f.store.connect() as db:
            return {row[0]: row[1] for row in db.execute("SELECT key,data FROM kv")
                    if row[0].startswith(prefixes)}

    def recent_fill(self):
        # Inside the bounded lag window, so a trailing direction time waits.
        self.fill_time = int((time.time() - 30) * 1000)

    def unknown_pending(self, template, batch_id):
        state = self.state()
        pending = deepcopy(template)
        pending.update(id=batch_id, before=dict(state["owned"]), created_at=time.time() - 3600,
            target={side: wire(dec(qty) + dec("0.2")) for side, qty in state["owned"].items()},
            bounded_recovery={"observed_at": time.time() - 121})
        for leg in pending["legs"]:
            leg.update(receipt=None, dispatch="sending", recovery_query_attempts=3)
            leg["order"]["newClientOrderId"] = leg["key"][0] + batch_id.replace("-", "")
        state["pending"] = pending
        self.f.store.put("pair_runtime:gold", state)

    def compacted(self, before="3.039", fill="0.2"):
        """An archived batch late-fills at a known time, then eight newer archives retire it."""
        self.recent_fill()
        original = fixtures.seed_pending(self.engine, {"LONG": before, "SHORT": before})
        manager = self.engine.pairs
        manager.confirm_recovery("gold", manager.preview_recovery("gold")["token"], True)
        manager.trader = PairTrader(self.engine)
        total = wire(dec(before) + dec(fill))
        self.positions(total, self.fill_time + 5)
        pair = self.f.store.pair("gold")
        with self.no_writes(), ExitStack() as stack:
            for leg in original["pending"]["legs"]:
                stack.enter_context(patch.object(self.broker(leg["key"]), "query", return_value=
                    fixtures.receipt_for(leg, status="FILLED", qty=fill, timestamp=self.fill_time)))
            with self.assertRaises(PairRecoveryConflict):
                require_archived_orders_clear(self.engine, pair)
        self.assertEqual(self.state()["owned"], {"LONG": total, "SHORT": total})
        self.template = self.f.store.get("pair_order_recovery:gold:" + fixtures.BATCH_ID)["pending"]
        for index in range(8):
            self.unknown_pending(self.template, f"newer-{index}")
            with self.no_writes():
                manager.tick("gold")
            self.assertIsNone(self.state()["pending"], self.state()["reason"])
        watch = self.state()["recovery_watch"]
        self.assertEqual(len(watch["batches"]), 8)
        self.assertNotIn(fixtures.BATCH_ID, [batch["id"] for batch in watch["batches"]])
        self.assertEqual(watch["history"]["retired"], 1)
        return pair

    def no_queries(self):
        stack = ExitStack()
        for key in ("long", "short"):
            stack.enter_context(patch.object(self.broker(key), "query",
                side_effect=AssertionError("compacted archives are not requeried")))
        return stack

    def stale_reads(self, update_time, **match):
        original = self.engine.pairs._read_members

        def read(*args, **kwargs):
            snapshots, guards = original(*args, **kwargs)
            if all(kwargs.get(name) == value for name, value in match.items()):
                snapshots = {key: replace(snapshot, positions=[
                    replace(position, update_time=update_time) if position.symbol == SYMBOL else position
                    for position in snapshot.positions]) for key, snapshot in snapshots.items()}
            return snapshots, guards

        return patch.object(self.engine.pairs, "_read_members", side_effect=read)

    def test_compacted_known_fill_waits_for_a_newer_direction_update(self):
        pair = self.compacted()
        with self.no_writes(), self.no_queries():
            for stale in (SIDES, SIDES[:1], SIDES[1:]):
                with self.subTest(stale=[side for _, side in stale]):
                    self.positions(update_time=self.fill_time + 5)
                    self.positions(update_time=self.fill_time - 1000, sides=stale)
                    before = self.state()
                    with self.assertRaisesRegex(TradingError, "早于历史已知成交"):
                        require_archived_orders_clear(self.engine, pair)
                    self.assertEqual(self.state(), before)
            # The next snapshot covering the fill releases the wait by itself.
            self.positions(update_time=self.fill_time + 5)
            self.assertEqual(require_archived_orders_clear(self.engine, pair), [])

    def test_a_lag_that_never_catches_up_is_released_after_the_bounded_wait(self):
        pair = self.compacted()
        self.positions(update_time=self.fill_time - 1000)
        with self.no_writes(), self.no_queries(), patch.object(pair_recovery.time, "monotonic", return_value=500) as clock:
            with self.assertRaisesRegex(TradingError, "早于历史已知成交"):
                require_archived_orders_clear(self.engine, pair)
            for elapsed in (119, 120, 121):
                clock.return_value = 500 + elapsed
                status = pair_recovery.history_time_status(self.f.store, pair, self.state(),
                    self.engine.pairs._read_members(pair, adopt=True, startup=True)[0])
                self.assertEqual(status["ok"], elapsed >= 120)
                self.assertEqual(status["sides"]["LONG"]["lag_expired"], elapsed >= 120)
            require_archived_orders_clear(self.engine, pair)

    def test_stale_balanced_change_is_not_adopted_after_compaction(self):
        self.compacted()
        self.unknown_pending(self.template, "late-adoption")
        self.positions("3.439", self.fill_time - 1000)
        with self.no_writes():
            self.engine.pairs.tick("gold")
        self.assertIsNotNone(self.state()["pending"])
        self.assertEqual(self.state()["owned"], {"LONG": "3.239", "SHORT": "3.239"})
        self.positions(update_time=int(time.time() * 1000))
        state = self.state()
        state["pending"]["bounded_recovery"].update(next_check_at=0, attempted_at=0)
        self.f.store.put("pair_runtime:gold", state)
        with self.no_writes():
            self.engine.pairs.tick("gold")
        self.assertIsNone(self.state()["pending"], self.state()["reason"])
        self.assertEqual(self.state()["owned"], {"LONG": "3.439", "SHORT": "3.439"})

    def test_enable_checks_the_snapshot_it_adopts(self):
        self.compacted()
        with self.no_writes(), self.stale_reads(self.fill_time - 1000, startup=True):
            with self.assertRaisesRegex(TradingError, "历史"):
                self.engine.pairs.enable("gold", True)
        self.assertFalse(self.f.store.pair("gold")["enabled"])
        self.engine.pairs.enable("gold", True)
        self.assertTrue(self.f.store.pair("gold")["enabled"])

    def test_baseline_review_waits_on_its_own_snapshot_and_keeps_its_contract(self):
        self.compacted()
        with self.no_writes(), self.stale_reads(self.fill_time - 1000, startup=True):
            with self.assertRaisesRegex(TradingError, "早于历史已知成交"):
                self.engine.pairs.preview_baseline("gold")
        review = self.engine.pairs.preview_baseline("gold")
        self.assertNotIn("history", review)
        watch = deepcopy(self.state()["recovery_watch"])
        self.engine.pairs.confirm_baseline("gold", review["token"], True)
        self.assertEqual(self.state()["recovery_watch"], watch)

    def test_delete_is_not_restricted_by_history_times(self):
        self.compacted(before="0")
        self.positions("0", int(time.time() * 1000))
        review = self.engine.pairs.preview_baseline("gold")
        self.engine.pairs.confirm_baseline("gold", review["token"], True)
        self.assertEqual(self.state()["owned"], {"LONG": "0", "SHORT": "0"})
        for key, observed in self.records("pair_watch_evidence:gold:").items():
            observed = self.f.store.get(key)
            if observed.get("retired_batch", {}).get("id") == fixtures.BATCH_ID:
                observed.update(retired=True, first_observed_at=observed["first_observed_at"] - 121)
                self.f.store.put(key, observed)
        with self.no_writes(), self.stale_reads(self.fill_time - 1000, flat=True):
            self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))

    def legacy(self, *, missing, untimed_hot=False):
        """HEAD-format compacted watch: no history summary, two retired archives."""
        self.recent_fill()
        state = fixtures.seed_pending(self.engine, {"LONG": "0.2", "SHORT": "0.2"})
        pending, store = state["pending"], self.f.store
        batches = []
        for index in range(10):
            batch = {"id": f"legacy-{index}", "symbol": SYMBOL, "created_at": time.time() - 3600,
                     "bounded_queries_complete": True, "identities": deepcopy(state["identities"]),
                     "legs": [{"key": leg["key"], "order": {**leg["order"],
                         "newClientOrderId": f"legacy-{index}-{leg['key']}"}} for leg in pending["legs"]]}
            journal = {**deepcopy(pending), **deepcopy(batch)}
            if index == 0 or index == 3 and untimed_hot:
                for leg in journal["legs"]:
                    leg["receipt"] = fixtures.receipt_for(leg, status="FILLED", qty="0.2", timestamp=self.fill_time)
                    if index == 3:
                        leg["receipt"].pop("updateTime")
            store.put("pair_batch:" + batch["id"], journal)
            store.put("pair_order_recovery:gold:" + batch["id"], {"status": "positions_adopted_unknown",
                                                                  "pending": journal})
            batches.append(batch)
        for retired in batches[:1] if missing else batches[:2]:
            store.put(_watch_evidence_key("gold", retired), {"retired_batch": retired, "retired": True,
                                                              "first_observed_at": time.time() - 121})
        watch = {"batches": batches[2:], "retired_identities": deepcopy(state["identities"]),
                 "retired_symbols": [SYMBOL]}
        state.update(pending=None, phase="paused", recovery_watch=watch)
        store.put("pair_runtime:gold", state)
        PairTrader(self.engine)
        return store.pair("gold")

    def test_missing_times_and_an_unprovable_archive_set_do_not_block(self):
        pair = self.legacy(missing=True, untimed_hot=True)
        originals = self.records("pair_watch_evidence:", "pair_batch:", "pair_order_recovery:", "pair_runtime:")
        scans = []
        scan = pair_recovery._kv_prefix
        with self.no_writes(), self.no_queries(), patch.object(pair_recovery, "_kv_prefix",
                side_effect=lambda store, prefix: scans.append(prefix) or scan(store, prefix)):
            for update_time in (None, 0):
                self.positions(update_time=update_time)
                self.assertEqual(require_archived_orders_clear(self.engine, pair), [])
            self.assertEqual(len(scans), 2)
            migrated = self.f.store.get("pair_watch_history:gold")["history"]
            self.assertIn("审计", migrated["unproven"]["reason"])
            self.assertEqual(migrated["unproven"]["missing"], ["legacy-1"])
            # The fills that are known still constrain a trailing direction time.
            self.positions(update_time=self.fill_time - 1000)
            with self.assertRaisesRegex(TradingError, "早于历史已知成交"):
                require_archived_orders_clear(self.engine, pair)
            self.positions(update_time=self.fill_time + 5)
            status = pair_recovery.history_time_status(self.f.store, pair, self.state(),
                self.engine.pairs._read_members(pair, adopt=True, startup=True)[0])
            self.assertTrue(status["ok"])
            self.assertEqual(status["sides"]["LONG"]["untimed"], 1)
        self.assertEqual(self.records("pair_watch_evidence:", "pair_batch:", "pair_order_recovery:",
                                      "pair_runtime:"), originals)
        # An upgraded pair without direction times starts as before.
        self.positions(update_time=None)
        self.engine.pairs.enable("gold", True)
        self.assertTrue(self.f.store.pair("gold")["enabled"])

    def test_complete_legacy_archives_are_proven_by_their_audit_records(self):
        pair = self.legacy(missing=False)
        with self.no_writes(), self.no_queries():
            self.positions(update_time=self.fill_time - 5)
            with self.assertRaisesRegex(TradingError, "历史"):
                require_archived_orders_clear(self.engine, pair)
            self.positions(update_time=self.fill_time + 5)
            require_archived_orders_clear(self.engine, pair)
        self.assertIsNone(self.f.store.get("pair_watch_history:gold")["history"]["unproven"])

    def test_history_reads_do_not_grow_with_retired_archives(self):
        self.recent_fill()
        state = fixtures.seed_pending(self.engine, {"LONG": "0.2", "SHORT": "0.2"})
        pending, store, pair = state["pending"], self.f.store, self.f.store.pair("gold")
        reads = {}
        for retired in (4, 24):
            watch = None
            for index in range(retired + 8):
                batch_id = f"n{retired}-{index}"
                batch = {"id": batch_id, "symbol": SYMBOL, "created_at": time.time() - 3600,
                         "bounded_queries_complete": True, "identities": deepcopy(state["identities"]),
                         "legs": [{"key": leg["key"], "order": {**leg["order"],
                             "newClientOrderId": f"{batch_id}-{leg['key']}"}} for leg in pending["legs"]]}
                journal = {**deepcopy(pending), **deepcopy(batch)}
                if index < retired:
                    for leg in journal["legs"]:
                        leg["receipt"] = fixtures.receipt_for(leg, status="FILLED", qty="0.1",
                                                              timestamp=self.fill_time - index)
                store.put("pair_batch:" + batch_id, journal)
                watch = pair_recovery._append_watch(store, "gold", watch, batch)
            self.assertEqual(watch["history"]["retired"], retired)
            store.put("pair_runtime:gold", {**state, "pending": None, "phase": "paused", "recovery_watch": watch})
            self.positions(update_time=self.fill_time - 10 ** 4)
            with self.no_writes(), self.no_queries(), \
                    patch.object(pair_recovery, "_kv_prefix", side_effect=AssertionError("no archive scans")), \
                    patch.object(store, "get", wraps=store.get) as get:
                with self.assertRaisesRegex(TradingError, "历史"):
                    require_archived_orders_clear(self.engine, pair)
            reads[retired] = get.call_count
            self.positions(update_time=self.fill_time + 5)
            require_archived_orders_clear(self.engine, pair)
        self.assertEqual(reads[4], reads[24])

    def test_rollback_compaction_behind_the_summary_is_remigrated(self):
        pair = self.compacted()
        state = self.state()
        watch = state["recovery_watch"]
        # An older build keeps the unknown history field but compacts without updating it.
        dropped = watch["batches"][0]
        self.f.store.put(_watch_evidence_key("gold", dropped), {"retired_batch": deepcopy(dropped), "retired": True,
                                                                "first_observed_at": time.time() - 121})
        added = deepcopy(watch["batches"][-1])
        added["id"] = "rollback-9"
        for leg in added["legs"]:
            leg["order"]["newClientOrderId"] = leg["key"][0] + "rollback9"
        self.f.store.put("pair_order_recovery:gold:rollback-9", {"status": "manual_archived_unresolved",
                                                                 "pending": deepcopy(added)})
        watch["batches"] = watch["batches"][1:] + [added]
        self.f.store.put("pair_runtime:gold", state)
        with self.no_writes(), self.no_queries():
            self.positions(update_time=self.fill_time - 1000)
            with self.assertRaisesRegex(TradingError, "历史"):
                require_archived_orders_clear(self.engine, pair)
            migrated = self.f.store.get("pair_watch_history:gold")["history"]
            self.assertIsNone(migrated["unproven"])
            self.assertEqual(migrated["retired"], 2)
            self.positions(update_time=self.fill_time + 5)
            require_archived_orders_clear(self.engine, pair)

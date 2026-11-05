"""Regression probes for history's actual snapshot and local elapsed-time boundary."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_trading as trading_fixtures
from tests import test_pair_order_recovery as recovery_fixtures
from tests import test_pair_budget as live_fixtures
from trading import pair_recovery
from trading.models import TradingError
from trading.pair_execution import runtime_default
from trading.pair_planning import plan_ordinary
from trading.store import Store

SYMBOL = "XAUUSD1"


class PairHistoryGuardTests(TestCase):
    def setUp(self):
        trading_fixtures.PairTradingTests.setUp(self)
        self.fill_time = int(time.time() * 1000)
        identities = self.trader._members(self.pair)[2]
        self.state = {**runtime_default(), "identities": identities}
        self.watch = {"batches": [], "retired_identities": identities, "retired_symbols": [SYMBOL]}
        history = pair_recovery._empty_history([])
        history.update(retired=1, fills={SYMBOL: {
            side: {"count": 1, "time": self.fill_time, "untimed": 0} for side in ("LONG", "SHORT")}})
        self.watch["history"] = history
        # A valid retired hot batch avoids querying any original IDs.
        pending = recovery_fixtures.seed_pending(self.engine, {"LONG": "0", "SHORT": "0"})["pending"]
        batch = {"id": "hot", "symbol": SYMBOL, "identities": identities,
                 "legs": pending["legs"], "bounded_queries_complete": True}
        self.watch["batches"] = [batch]
        history["batches_digest"] = pair_recovery._batches_digest([batch])
        self.state["recovery_watch"] = self.watch
        self.store.put("pair_runtime:gold", self.state)
        for key, broker in self.brokers.items():
            broker.state["positions"][SYMBOL + ":" + key.upper()]["updateTime"] = self.fill_time + 1
            broker.save()

    def reads(self, stamp):
        snapshots, guards = self.trader._read(self.brokers, SYMBOL)
        snapshots = deepcopy(snapshots)
        for snapshot in snapshots.values():
            snapshot.positions = [replace(row, update_time=stamp) if row.symbol == SYMBOL else row
                                  for row in snapshot.positions]
        return snapshots, guards

    def status(self, snapshots, *, store=None, state=None):
        return pair_recovery.history_time_status(
            store or self.store, self.pair, state or self.state, snapshots)

    def live(self, orders=None):
        live_fixtures.PairBudgetTests.live_brokers(self)
        identities = self.trader._members(self.pair)[2]
        self.state["identities"] = self.watch["retired_identities"] = identities
        for batch in self.watch["batches"]:
            batch["identities"] = identities
        self.store.put("pair_runtime:gold", self.state)
        for key, broker in self.brokers.items():
            original = broker.api.call

            def call(method, path, *args, key=key, original=original, **kwargs):
                if method == "GET" and path == "/fapi/v3/openOrders":
                    self.assertEqual(kwargs.get("timeout"), 8)
                    return (orders or {}).get(key, [])
                return original(method, path, *args, **kwargs)

            mock = patch.object(broker.api, "call", side_effect=call)
            mock.start()
            self.addCleanup(mock.stop)

    def test_opening_cannot_substitute_a_new_read_for_the_planned_snapshot(self):
        snapshots, guards = self.reads(self.fill_time - 1)
        plan = plan_ordinary(self.pair, snapshots, self.market.book(SYMBOL),
                             self.market.rules[SYMBOL], self.engine.capacities(SYMBOL))
        with ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "submit", wraps=broker.submit))
                     for broker in self.brokers.values()]
            try:
                self.trader._start(self.pair, self.state, self.brokers, snapshots, guards, plan, kind="ordinary")
            except TradingError as exc:
                self.assertIn("历史已知成交", str(exc))
        self.assertEqual(sum(send.call_count for send in sends), 0)

    def test_original_snapshot_guards_are_rechecked_after_history_queries(self):
        snapshots, guards = self.reads(self.fill_time + 1)
        plan = plan_ordinary(self.pair, snapshots, self.market.book(SYMBOL),
                             self.market.rules[SYMBOL], self.engine.capacities(SYMBOL))
        def refuse():
            raise TradingError("original read revoked")
        for key in ("long", "short"):
            with self.subTest(revoked=key), ExitStack() as stack:
                sends = [stack.enter_context(patch.object(broker, "submit", wraps=broker.submit))
                         for broker in self.brokers.values()]
                revoked = {**guards, key: refuse}
                with self.assertRaisesRegex(TradingError, "original read revoked"):
                    self.trader._start(self.pair, self.state, self.brokers, snapshots, revoked, plan, kind="ordinary")
                self.assertEqual(sum(send.call_count for send in sends), 0)

    def test_covered_snapshots_send_both_legs_without_replacement_reads(self):
        snapshots, guards = self.reads(self.fill_time + 1)
        plan = plan_ordinary(self.pair, snapshots, self.market.book(SYMBOL),
                             self.market.rules[SYMBOL], self.engine.capacities(SYMBOL))
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("replacement read")), \
                patch.object(self.trader, "_recover"), ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "submit", wraps=broker.submit))
                     for broker in self.brokers.values()]
            self.trader._start(self.pair, self.state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertEqual(sum(send.call_count for send in sends), 2)

    def test_final_dispatch_rechecks_late_history_against_prepared_snapshots(self):
        snapshots, guards = self.reads(self.fill_time + 1)
        plan = plan_ordinary(self.pair, snapshots, self.market.book(SYMBOL),
                             self.market.rules[SYMBOL], self.engine.capacities(SYMBOL))
        dispatch = self.trader._dispatch

        def late_fill(*args, **kwargs):
            for side in ("LONG", "SHORT"):
                self.watch["history"]["fills"][SYMBOL][side]["time"] = self.fill_time + 2
            self.store.put("pair_runtime:gold", self.state)
            # A replacement read would now pass, but the prepared snapshots do not.
            for key, broker in self.brokers.items():
                broker.state["positions"][SYMBOL + ":" + key.upper()]["updateTime"] = self.fill_time + 3
                broker.save()
            return dispatch(*args, **kwargs)

        with patch.object(self.trader, "_dispatch", side_effect=late_fill), \
                patch.object(self.trader, "_recover"), ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "submit", wraps=broker.submit))
                     for broker in self.brokers.values()]
            self.trader._start(self.pair, self.state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertEqual(sum(send.call_count for send in sends), 0)
        for leg in self.state["pending"]["legs"]:
            self.assertTrue(leg["receipt"]["local_not_sent"])
            self.assertIn("历史已知成交", leg["receipt"]["reject_reason"])

    def test_leverage_cannot_substitute_a_new_read_for_the_checked_snapshot(self):
        snapshots, guards = self.reads(self.fill_time - 1)
        self.engine.markets[SYMBOL]["capacities"]["10"] = "1000000"
        with ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "set_leverage", wraps=broker.set_leverage))
                     for broker in self.brokers.values()]
            try:
                self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 10)
            except TradingError as exc:
                self.assertIn("历史已知成交", str(exc))
        self.assertEqual(sum(send.call_count for send in sends), 0)

    def test_leverage_live_fallback_checks_the_brokers_last_snapshot(self):
        self.live()
        self.engine.markets[SYMBOL]["capacities"]["10"] = "1000000"
        snapshots, guards = self.reads(self.fill_time + 1)
        with patch.object(self.trader, "_recover_leverage"), ExitStack() as stack:
            writes = []
            for key, broker in self.brokers.items():
                stale = deepcopy(snapshots[key])
                stale.positions = [replace(row, update_time=self.fill_time - 1)
                                   if row.symbol == SYMBOL else row for row in stale.positions]
                # Exercise LiveBroker.set_leverage's stale-token fallback.
                broker.leverage_snapshot = None
                stack.enter_context(patch.object(broker, "snapshot", return_value=stale))
                writes.append(stack.enter_context(patch.object(broker, "_account_write", wraps=broker._account_write)))
            self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 10)
        self.assertEqual(sum(write.call_count for write in writes), 0)
        self.assertTrue(all(row["rejected"] for row in self.state["pending"]["results"].values()))
        self.assertTrue(all("历史已知成交" in row["reason"] for row in self.state["pending"]["results"].values()))

    def test_reusing_planned_snapshots_preserves_the_full_account_order_check(self):
        orders = {"long": [{"symbol": "XAGUSD1", "status": "NEW"}]}
        self.live(orders)
        snapshots, guards = self.reads(self.fill_time + 1)
        plan = plan_ordinary(self.pair, snapshots, self.market.book(SYMBOL),
                             self.market.rules[SYMBOL], self.engine.capacities(SYMBOL))
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("replacement read")), \
                ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "submit", wraps=broker.submit))
                     for broker in self.brokers.values()]
            with self.assertRaisesRegex(TradingError, "挂单"):
                self.trader._start(self.pair, self.state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertEqual(sum(send.call_count for send in sends), 0)

    def test_leverage_history_failure_after_prepare_is_known_not_sent(self):
        snapshots, guards = self.reads(self.fill_time + 1)
        self.engine.markets[SYMBOL]["capacities"]["10"] = "1000000"
        save = self.trader._save

        def late_fill(pair, state):
            if state.get("pending"):
                for side in ("LONG", "SHORT"):
                    self.watch["history"]["fills"][SYMBOL][side]["time"] = self.fill_time + 2
            save(pair, state)

        with patch.object(self.trader, "_save", side_effect=late_fill), ExitStack() as stack:
            sends = [stack.enter_context(patch.object(broker, "set_leverage", wraps=broker.set_leverage))
                     for broker in self.brokers.values()]
            self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 10)
        self.assertEqual(sum(send.call_count for send in sends), 0)
        self.assertIsNone(self.state["pending"])
        self.assertTrue(all(broker.state["leverages"][SYMBOL] == 5 for broker in self.brokers.values()))

    def test_monotonic_wait_ignores_fast_slow_and_rolled_back_wall_clock(self):
        snapshots, _ = self.reads(self.fill_time - 1)
        for skew in (-30, 30):
            # A new Store is a fresh process-local observation, with unchanged durable data.
            store = Store(self.store.path)
            with self.subTest(skew=skew), \
                    patch.object(pair_recovery.time, "monotonic", return_value=1000) as mono, \
                    patch.object(pair_recovery.time, "time", return_value=self.fill_time / 1000 + skew) as wall:
                self.assertFalse(self.status(snapshots, store=store)["ok"])
                for elapsed in (100, 119, 120, 121):
                    mono.return_value = 1000 + elapsed
                    wall.return_value = self.fill_time / 1000 + skew + elapsed
                    self.assertEqual(self.status(snapshots, store=store)["ok"], elapsed >= 120)
                wall.return_value -= 3600
                mono.return_value = 1122
                self.assertTrue(self.status(snapshots, store=store)["ok"])

    def test_wall_clock_jump_during_the_wait_neither_shortens_nor_extends_it(self):
        snapshots, _ = self.reads(self.fill_time - 1)
        with patch.object(pair_recovery.time, "monotonic", return_value=4000) as mono, \
                patch.object(pair_recovery.time, "time", return_value=self.fill_time / 1000) as wall:
            self.assertFalse(self.status(snapshots)["ok"])
            mono.return_value = 4050
            wall.return_value += 3600
            self.assertFalse(self.status(snapshots)["ok"])
            mono.return_value = 4119
            wall.return_value -= 7200
            self.assertFalse(self.status(snapshots)["ok"])
            mono.return_value = 4120
            self.assertTrue(self.status(snapshots)["ok"])

    def test_restart_starts_a_new_window_and_no_timer_is_persisted(self):
        snapshots, _ = self.reads(self.fill_time - 1)
        before = self.store.get("pair_runtime:gold")
        with patch.object(pair_recovery.time, "monotonic", return_value=2000) as mono:
            self.assertFalse(self.status(snapshots)["ok"])
            mono.return_value = 2120
            self.assertTrue(self.status(snapshots)["ok"])
            restarted = Store(self.store.path)
            self.assertFalse(self.status(snapshots, store=restarted)["ok"])
            mono.return_value = 2239
            self.assertFalse(self.status(snapshots, store=restarted)["ok"])
            mono.return_value = 2240
            self.assertTrue(self.status(snapshots, store=restarted)["ok"])
        self.assertEqual(self.store.get("pair_runtime:gold"), before)

    def test_resolved_wait_is_removed_and_later_staleness_gets_a_full_window(self):
        stale, _ = self.reads(self.fill_time - 1)
        current, _ = self.reads(self.fill_time)
        with patch.object(pair_recovery.time, "monotonic", return_value=3000) as mono:
            self.assertFalse(self.status(stale)["ok"])
            mono.return_value = 3119
            self.assertTrue(self.status(current)["ok"])
            self.assertNotIn(self.pair["id"], pair_recovery._history_waits[self.store])
            mono.return_value = 3120
            self.assertFalse(self.status(stale)["ok"])
            mono.return_value = 3239
            self.assertFalse(self.status(stale)["ok"])
            mono.return_value = 3240
            self.assertTrue(self.status(stale)["ok"])

    def test_new_fill_and_identity_replace_old_wait_keys(self):
        snapshots, _ = self.reads(self.fill_time - 1)
        with patch.object(pair_recovery.time, "monotonic", return_value=5000) as mono:
            self.assertFalse(self.status(snapshots)["ok"])
            for index in range(1, 10):
                mono.return_value += 120
                self.assertTrue(self.status(snapshots)["ok"])
                self.watch["history"]["fills"][SYMBOL]["LONG"]["time"] = self.fill_time + index
                self.state["identities"]["short"]["env_prefix"] = f"CHANGED_{index}"
                self.assertFalse(self.status(snapshots)["ok"])
                self.assertEqual(len(pair_recovery._history_waits[self.store][self.pair["id"]]), 2)
            state = {**self.state, "recovery_watch": None}
            self.assertTrue(self.status(snapshots, state=state)["ok"])
            self.assertNotIn(self.pair["id"], pair_recovery._history_waits[self.store])

    def test_wait_cache_is_bounded_and_eviction_restarts_conservatively(self):
        snapshots, _ = self.reads(self.fill_time - 1)
        with patch.object(pair_recovery.time, "monotonic", return_value=6000) as mono:
            self.assertFalse(self.status(snapshots)["ok"])
            for index in range(pair_recovery.HISTORY_WAIT_MAX_PAIRS):
                pair_recovery.history_time_status(self.store, {**self.pair, "id": f"pair-{index}"},
                                                  self.state, snapshots)
            self.assertEqual(len(pair_recovery._history_waits[self.store]), pair_recovery.HISTORY_WAIT_MAX_PAIRS)
            self.assertNotIn(self.pair["id"], pair_recovery._history_waits[self.store])
            mono.return_value = 6120
            self.assertFalse(self.status(snapshots)["ok"])
            mono.return_value = 6240
            self.assertTrue(self.status(snapshots)["ok"])

    def test_retirement_markers_without_either_archive_prefix_are_unproven(self):
        state = deepcopy(self.state)
        state["recovery_watch"].pop("history")
        snapshots, _ = self.reads(self.fill_time - 1)
        status = self.status(snapshots, state=state)
        self.assertTrue(status["ok"])
        self.assertIsNotNone(status["unproven"])
        self.assertIn("退役", status["unproven"]["reason"])

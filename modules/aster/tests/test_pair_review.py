"""Independent regression cases for transient recovery and reduction priority."""
from dataclasses import replace
from datetime import datetime, timezone
from fractions import Fraction
import sqlite3
from threading import Lock
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_trading as fixtures
from trading.exchange import AmbiguousOrder, ExchangeError, RequestNotSent
from trading.models import TradingError, dec, wire
from trading.pair_execution import PairTrader, runtime_default


class PairReviewTests(TestCase):
    setUp = fixtures.PairTradingTests.setUp
    tick = fixtures.PairTradingTests.tick
    snapshots = fixtures.PairTradingTests.snapshots
    expire = fixtures.PairTradingTests.expire
    assert_flat = fixtures.PairTradingTests.assert_flat

    def test_batch_history_write_failure_keeps_recoverable_pending(self):
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER reject_pair_history BEFORE INSERT ON kv "
                       "WHEN NEW.key LIKE 'pair_batch:%' "
                       "BEGIN SELECT RAISE(ABORT, 'simulated disk write failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.tick()
        state = self.store.get("pair_runtime:gold")
        self.assertIsNotNone(state["pending"])
        self.assertEqual(state["progress"]["phase"], "waiting_open")
        self.assertEqual(state["daily_volume"], {})
        batch_id = state["pending"]["id"]
        self.assertIsNone(self.store.get("pair_batch:" + batch_id))
        count = sum(len(b.state["orders"]) for b in self.brokers.values())
        with self.store.connect() as db:
            db.execute("DROP TRIGGER reject_pair_history")
        state = self.tick()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["phase"], "holding")
        self.assertTrue(self.store.get("pair_batch:" + batch_id)["completed"])
        self.assertEqual(sum(len(b.state["orders"]) for b in self.brokers.values()), count)

    def test_revoked_recovery_snapshot_preserves_pending_until_fresh_read(self):
        original = self.trader._read
        reads = 0

        def read(brokers, symbol, **kwargs):
            nonlocal reads
            reads += 1
            snapshots, guards = original(brokers, symbol, **kwargs)
            if reads == 2:
                guards["long"] = lambda: (_ for _ in ()).throw(TradingError("账户快照已撤销"))
            return snapshots, guards

        with patch.object(self.trader, "_read", side_effect=read):
            state = self.tick()
        self.assertIsNotNone(state["pending"])
        self.assertEqual(state["progress"]["phase"], "waiting_open")
        self.assertNotIn("last_batch", state)
        count = sum(len(b.state["orders"]) for b in self.brokers.values())
        state = self.tick()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["phase"], "holding")
        self.assertEqual(sum(len(b.state["orders"]) for b in self.brokers.values()), count)

    def test_revoked_leverage_confirmation_preserves_pending(self):
        state = runtime_default()
        _, _, identities = self.trader._members(self.pair)
        pending = {"id": "revoked-leverage", "kind": "leverage", "identities": identities,
                   "before": {"LONG": "0", "SHORT": "0"}, "target_leverage": 5,
                   "previous_leverage": 2, "results": {}}
        state["pending"] = pending
        snapshots, guards = self.trader._read(self.brokers, "XAUUSD1")
        guards["short"] = lambda: (_ for _ in ()).throw(TradingError("账户快照已撤销"))
        with patch.object(self.trader, "_read", return_value=(snapshots, guards)):
            with self.assertRaisesRegex(TradingError, "已撤销"):
                self.trader._recover_leverage(self.pair, state, self.brokers)
        self.assertIs(state["pending"], pending)
        self.trader._recover_leverage(self.pair, state, self.brokers)
        self.assertIsNone(self.store.get("pair_runtime:gold")["pending"])

    def lag_position_reads(self, lagging):
        original_read = self.trader._read
        reads = 0

        def read(brokers, symbol, **kwargs):
            nonlocal reads
            reads += 1
            snapshots, guards = original_read(brokers, symbol, **kwargs)
            if lagging(reads):
                snapshots = {key: replace(snapshot, positions=[replace(p, qty=dec(0)) for p in snapshot.positions])
                             for key, snapshot in snapshots.items()}
            return snapshots, guards

        return patch.object(self.trader, "_read", side_effect=read)

    def order_count(self):
        return sum(len(b.state["orders"]) for b in self.brokers.values())

    def test_persistent_position_read_lag_stays_bounded_without_new_orders(self):
        with self.lag_position_reads(lambda reads: reads >= 2):
            self.tick()
            count = self.order_count()
            for _ in range(3):
                state = self.tick()
        self.assertIsNotNone(state["pending"])
        self.assertTrue(state["pending"]["terminal_position_recovery"])
        self.assertEqual(state["phase"], "reconciling")
        self.assertEqual(self.order_count(), count)

    def test_terminal_margin_recovery_only_reduces_added_quantity_and_never_resends(self):
        with self.lag_position_reads(lambda reads: reads == 2):
            self.tick()
        count = self.order_count()
        with self.lag_position_reads(lambda reads: True), \
             patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")):
            state = self.tick()
        self.assertEqual(state["pending"]["repairs"], [])
        self.assertEqual(self.order_count(), count)
        original = self.brokers["long"].submit

        def lose_receipt(orders):
            self.assert_reducing_journal(orders, "long")
            original(orders)
            raise AmbiguousOrder("repair receipt lost")

        with patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")), \
             patch.object(self.brokers["long"], "submit", side_effect=lose_receipt):
            state = self.tick()
        pending = state["pending"]
        self.assertIsNotNone(pending, state)
        self.assertTrue(pending["terminal_margin_rollback"])
        self.assertEqual(len(pending["repairs"]), 2)
        for leg in pending["repairs"]:
            order = leg["order"]
            self.assertEqual(order["side"], "SELL" if leg["key"] == "long" else "BUY")
            self.assertEqual(dec(order["quantity"]), dec(pending["quantity"]))
        self.assertEqual(self.order_count(), count + 2)
        with patch.object(self.brokers["long"], "query", side_effect=ExchangeError("not visible", code=-2013)):
            for _ in range(2):
                state = self.tick()
                self.assertIsNotNone(state["pending"])
                self.assertEqual(self.order_count(), count + 2)
        self.trader = PairTrader(self.engine)
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertEqual(self.order_count(), count + 2)
        self.assertFalse(state["last_batch"]["completed"])
        self.assert_flat()

    def assert_reducing_journal(self, orders, key):
        pending = self.store.get("pair_runtime:gold")["pending"]
        for order in orders:
            self.assertEqual(order["positionSide"], key.upper())
            self.assertEqual(order["side"], "SELL" if key == "long" else "BUY")
            saved = [leg for leg in pending["repairs"] if leg["order"] == order]
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["dispatch"], "sending")

    def terminal_partial_close(self):
        self.tick()
        self.expire()
        read = self.trader._read
        book = self.market.book
        submit = {key: broker.submit for key, broker in self.brokers.items()}
        book_lock = Lock()

        def partial(key):
            def send(orders):
                with book_lock, patch.object(self.market, "book", side_effect=lambda symbol: replace(
                        book(symbol), ask_qty=dec("0.2"), bid_qty=dec("0.1"))):
                    return submit[key](orders)
            return send

        def lag(*args, **kwargs):
            snapshots, guards = read(*args, **kwargs)
            pending = (self.store.get("pair_runtime:gold") or {}).get("pending")
            if pending and pending["phase"] == "close":
                snapshots = {key: replace(snapshot, positions=[
                    replace(p, qty=dec(pending["before"][p.side]), update_time=None)
                    if p.symbol == "XAUUSD1" and p.side == key.upper() else p for p in snapshot.positions])
                    for key, snapshot in snapshots.items()}
            return snapshots, guards

        with patch.object(self.brokers["long"], "submit", side_effect=partial("long")), \
             patch.object(self.brokers["short"], "submit", side_effect=partial("short")), \
             patch.object(self.trader, "_read", side_effect=lag):
            state = self.tick()
        self.assertTrue(state["pending"]["terminal_position_recovery"], state)
        self.assertEqual(state["pending"]["repairs"], [])
        return state

    def test_terminal_partial_close_repairs_to_balance_without_resending_or_losing_cycle(self):
        state = self.terminal_partial_close()
        count = self.order_count()
        expected = self.trader._receipt_quantities(state["pending"])
        difference = expected["LONG"] - expected["SHORT"]
        self.assertGreater(difference, 0)
        with self.lag_position_reads(lambda reads: True):
            state = self.tick()
        self.assertEqual(state["pending"]["repairs"], [])
        self.assertEqual(self.order_count(), count)
        original = self.brokers["long"].submit

        def lose_receipt(orders):
            self.assert_reducing_journal(orders, "long")
            self.assertEqual(Fraction(dec(orders[0]["quantity"])), difference)
            original(orders)
            raise AmbiguousOrder("repair receipt lost")

        with patch.object(self.brokers["long"], "submit", side_effect=lose_receipt), \
             patch.object(self.brokers["short"], "submit", side_effect=AssertionError("balanced side must not reduce")):
            state = self.tick()
        self.assertEqual(len(state["pending"]["repairs"]), 1)
        self.assertEqual(self.order_count(), count + 1)
        with patch.object(self.brokers["long"], "query", side_effect=ExchangeError("not visible", code=-2013)):
            for _ in range(2):
                state = self.tick()
                self.assertIsNotNone(state["pending"])
                self.assertEqual(self.order_count(), count + 1)
        self.trader = PairTrader(self.engine)
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(state["progress"]["baseline"], state["owned"])
        self.assertEqual(state["progress"]["quantities"], dict.fromkeys(("LONG", "SHORT"), wire(expected["SHORT"])))
        self.assertEqual(state["progress"]["completed_cycles"], 0)
        self.assertEqual(self.order_count(), count + 1)
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assert_flat()

    def test_terminal_close_repair_floors_exact_residual_without_crossing_balance(self):
        self.terminal_partial_close()
        state = self.store.get("pair_runtime:gold")
        pending = state["pending"]
        pending["legs"][0]["receipt"]["executedQty"] = "0.1"
        pending["legs"][1]["receipt"]["executedQty"] = "0.1019999999999999999999999999999"
        self.store.put("pair_runtime:gold", state)
        expected = self.trader._receipt_quantities(pending)
        snapshots, guards = self.trader._read(self.brokers, "XAUUSD1")
        snapshots = {key: replace(snapshot, positions=[
            replace(p, qty=dec(wire(expected[p.side]))) if p.symbol == "XAUUSD1" and p.side == key.upper() else p
            for p in snapshot.positions]) for key, snapshot in snapshots.items()}
        with patch.object(self.trader, "_read", return_value=(snapshots, guards)), \
             patch.object(self.brokers["long"], "submit", side_effect=RequestNotSent("budget")) as submit:
            state = self.tick()
        self.assertEqual(submit.call_count, 1)
        order = submit.call_args.args[0][0]
        self.assertEqual(dec(order["quantity"]), dec("0.001"))
        self.assertLessEqual(Fraction(dec(order["quantity"])), expected["LONG"] - expected["SHORT"])
        self.assertEqual(order["side"], "SELL")

    def exhaust_bounded_reads(self, lagging):
        """Lag through all three bounded reads, then open the 120 s full check."""
        with lagging:
            for _ in range(4):
                state = self.tick()
        self.assertTrue(state["pending"]["terminal_position_recovery"])
        self.assertEqual(state["pending"]["recovery_query_attempts"], 3)
        runtime = self.store.get("pair_runtime:gold")
        pending = runtime["pending"]
        pending["bounded_recovery"]["observed_at"] -= 121
        pending["last_possible_send_at"] = pending.get("last_possible_send_at", time.time()) - 121
        self.store.put("pair_runtime:gold", runtime)

    def test_lag_through_bounded_reads_still_completes_cycle_at_full_check(self):
        lagging = self.lag_position_reads(lambda reads: 2 <= reads <= 4)
        self.exhaust_bounded_reads(lagging)
        count = self.order_count()
        with lagging:
            state = self.tick()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["phase"], "holding")
        self.assertEqual(state["progress"]["baseline"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(self.order_count(), count)
        self.expire()
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assert_flat()

    def test_failed_full_check_read_keeps_the_retry_cadence(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        with patch.object(self.engine.pairs, "_read_members", side_effect=ExchangeError("network")) as read:
            self.tick()
            state = self.tick()
        self.assertEqual(read.call_count, 1)
        self.assertIsNotNone(state["pending"])
        self.assertGreater(state["pending"]["bounded_recovery"]["next_check_at"], time.time() + 20)

    def test_full_check_reuses_one_read_when_receipts_are_not_reflected(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        original = self.engine.pairs._read_members

        def lag(*args, **kwargs):
            snapshots, guards = original(*args, **kwargs)
            return ({key: replace(snapshot, positions=[replace(p, qty=dec(0), update_time=None)
                                                       for p in snapshot.positions])
                     for key, snapshot in snapshots.items()}, guards)

        with patch.object(self.engine.pairs, "_read_members", side_effect=lag) as read, \
             patch.object(self.trader, "_read", side_effect=AssertionError("full check owns the read")):
            state = self.tick()
            self.tick()
        self.assertEqual(read.call_count, 1)
        self.assertIsNotNone(state["pending"], state)
        self.assertEqual(state["pending"]["bounded_recovery"]["failure_count"], 1)
        self.assertIn("方向持仓更新时间", state["reason"])
        self.assertNotIn("last_batch", state)

    def test_full_check_failure_uses_shared_backoff_and_status_fields(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        now = time.time()
        failure = ExchangeError("rate limited", http_status=429, retry_after=40)
        with patch("trading.pair_recovery.time.time", return_value=now), \
             patch.object(self.engine.pairs, "_read_members", side_effect=failure) as read:
            state = self.tick()
            gate = state["pending"]["bounded_recovery"]
            self.assertEqual(gate["failure_count"], 1)
            self.assertEqual(gate["next_check_at"], now + 40)
            self.assertEqual(gate["phase"], "reconciling")
            self.assertTrue(gate["reason"])
            self.assertIsNotNone(gate["api_notice"])
            self.tick()
            self.assertEqual(read.call_count, 1)
        with patch("trading.pair_recovery.time.time", return_value=now + 41), \
             patch.object(self.engine.pairs, "_read_members", side_effect=failure) as read:
            state = self.tick()
            gate = state["pending"]["bounded_recovery"]
            self.assertEqual(gate["failure_count"], 2)
            self.assertEqual(gate["next_check_at"], now + 101)
            self.tick()
            self.assertEqual(read.call_count, 1)

    def test_full_check_reservation_preserves_a_concurrent_runtime(self):
        from trading.pair_planning import PairRecoveryConflict
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        stale = self.store.get("pair_runtime:gold")
        current = self.store.get("pair_runtime:gold")
        current["owned"]["LONG"] = "0.001"
        self.store.put("pair_runtime:gold", current)
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("no read after conflict")), \
             self.assertRaises(PairRecoveryConflict):
            self.engine.pairs.recovery.adopt_unknown(self.trader, self.pair, stale)
        self.assertEqual(self.store.get("pair_runtime:gold"), current)

    def test_full_check_waits_for_position_review_without_consuming_its_deadline(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        state = self.store.get("pair_runtime:gold")
        now = time.time()
        state["pending"].update(kind="ordinary", position_review=True,
            position_review_attempted_at=now, position_review_retry_at=now + 60)
        self.store.put("pair_runtime:gold", state)
        with patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
            state = self.tick()
            self.assertEqual(read.call_count, 0)
            self.assertNotIn("next_check_at", state["pending"]["bounded_recovery"])
            state = self.store.get("pair_runtime:gold")
            state["pending"]["position_review_retry_at"] = now - 1
            self.store.put("pair_runtime:gold", state)
            state = self.tick()
            self.assertEqual(read.call_count, 1)
        self.assertIsNone(state["pending"], state)

    def test_full_check_clock_rollback_restores_saved_delay_then_completes(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        state = self.store.get("pair_runtime:gold")
        now = time.time()
        state["pending"]["bounded_recovery"].update(attempted_at=now + 60, next_check_at=now + 120)
        self.store.put("pair_runtime:gold", state)
        with patch("trading.pair_recovery.time.time", return_value=now), \
             patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
            state = self.tick()
            self.assertEqual(read.call_count, 0)
            self.assertEqual(state["pending"]["bounded_recovery"]["next_check_at"], now + 60)
        with patch("trading.pair_recovery.time.time", return_value=now + 61), \
             patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
            state = self.tick()
            self.assertEqual(read.call_count, 1)
        self.assertIsNone(state["pending"], state)

    def test_full_check_adoption_failure_after_deadline_uses_one_read_and_backoff(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        original = self.engine.pairs._read_members
        now = time.time()

        def unbalanced(*args, **kwargs):
            snapshots, guards = original(*args, **kwargs)
            snapshot = snapshots["short"]
            snapshots["short"] = replace(snapshot, positions=[
                replace(p, qty=dec(0)) if p.side == "SHORT" else p for p in snapshot.positions])
            return snapshots, guards

        for elapsed, expected_failures, delay in ((0, 1, 30), (31, 2, 60)):
            with patch("trading.pair_recovery.time.time", return_value=now + elapsed), \
                 patch.object(self.engine.pairs, "_read_members", side_effect=unbalanced) as read:
                state = self.tick()
                self.assertEqual(read.call_count, 1)
                gate = state["pending"]["bounded_recovery"]
                self.assertEqual(gate["failure_count"], expected_failures)
                self.assertEqual(gate["phase"], "attention")
                self.assertEqual(gate["next_check_at"], now + elapsed + delay)
                state = self.tick()
                self.assertEqual(read.call_count, 1)
                self.assertEqual(state["reason"], gate["reason"])

    def test_full_check_margin_failure_can_reduce_verified_fills(self):
        self.exhaust_bounded_reads(self.lag_position_reads(lambda reads: reads >= 2))
        count = self.order_count()
        with patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")), \
             patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
            state = self.tick()
        self.assertEqual(read.call_count, 1)
        self.assertEqual(len(state["pending"]["repairs"]), 2)
        self.assertEqual(self.order_count(), count + 2)
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assert_flat()

    def test_ordinary_partial_fill_after_read_lag_finishes_from_positions(self):
        self.ordinary_partial_fill_after_read_lag(("LONG",))

    def test_ordinary_both_lagging_positions_are_not_adopted_as_manual_rollback(self):
        self.ordinary_partial_fill_after_read_lag(("LONG", "SHORT"), update_time=1)

    def test_ordinary_missing_position_times_do_not_authorize_manual_rollback(self):
        self.ordinary_partial_fill_after_read_lag(("LONG", "SHORT"))

    def ordinary_partial_fill_after_read_lag(self, lagged_sides, update_time=None):
        pair = self.store.pair("gold")
        pair["cycle"]["enabled"] = False
        pair["ordinary"]["enabled"] = True
        self.store.save_pair(pair)
        book, sent = self.market.book, []
        originals = {key: broker.submit for key, broker in self.brokers.items()}
        book_lock = Lock()

        def thin(key):
            def submit(orders):
                sent.append(key)
                with book_lock, patch.object(self.market, "book", side_effect=lambda symbol: replace(
                        book(symbol), ask_qty=dec("0.01"), bid_qty=dec("0.01"))):
                    return originals[key](orders)
            return submit

        lagging = []

        def lag(original):
            def read(*args, **kwargs):
                snapshots, guards = original(*args, **kwargs)
                if sent and not lagging:
                    snapshots = {key: replace(snapshot, positions=[replace(p, qty=dec(0), update_time=update_time)
                                                                   if p.side in lagged_sides else p
                                                                   for p in snapshot.positions])
                                 for key, snapshot in snapshots.items()}
                return snapshots, guards
            return read

        # Every read in the submitting tick carries the old positions, including
        # the independent member read. Request freshness cannot prove rollback.
        with patch.object(self.brokers["long"], "submit", side_effect=thin("long")), \
             patch.object(self.brokers["short"], "submit", side_effect=thin("short")), \
             patch.object(self.trader, "_read", side_effect=lag(self.trader._read)), \
             patch.object(self.engine.pairs, "_read_members", side_effect=lag(self.engine.pairs._read_members)):
            for _ in range(4):
                state = self.tick()
                if sent:
                    break
            lagging.append(False)
            self.assertIsNotNone(state["pending"], state)
            self.assertTrue(state["pending"]["terminal_position_recovery"])
            if len(lagged_sides) == 2:
                self.assertEqual(state["phase"], "reconciling")
                self.assertNotIn("attention", state)
            self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
            batch_id = state["pending"]["id"]
            self.assertIsNone(self.store.get("pair_batch:" + batch_id))
            state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertEqual(state["owned"], {"LONG": "0.01", "SHORT": "0.01"})
        self.assertEqual(len(sent), 2)
        audit = self.store.get("pair_batch:" + batch_id)["manual_position_reconciliation"]
        self.assertEqual({side: dec(qty) for side, qty in audit["external_reduction"].items()},
                         {"LONG": dec(0), "SHORT": dec(0)})

    def test_terminal_ordinary_margin_recovery_reduces_instead_of_adopting_over_limit_fills(self):
        pair = self.store.pair("gold")
        pair["cycle"]["enabled"] = False
        pair["ordinary"]["enabled"] = True
        self.store.save_pair(pair)
        read = self.trader._read

        def lag(*args, **kwargs):
            snapshots, guards = read(*args, **kwargs)
            if (self.store.get("pair_runtime:gold") or {}).get("pending"):
                snapshots = {key: replace(snapshot, positions=[replace(p, qty=dec(0), update_time=None)
                                                               for p in snapshot.positions])
                             for key, snapshot in snapshots.items()}
            return snapshots, guards

        with patch.object(self.trader, "_read", side_effect=lag), \
             patch.object(self.engine.pairs.recovery, "reconcile_positions", return_value=False):
            for _ in range(4):
                state = self.tick()
                if state.get("pending"):
                    break
        self.assertTrue(state["pending"]["terminal_position_recovery"], state)
        count = self.order_count()
        with patch("trading.pair_execution.opening_margin_limit", return_value=dec("0.000001")):
            state = self.tick()
        self.assertTrue(state["pending"]["terminal_margin_rollback"])
        self.assertEqual(len(state["pending"]["repairs"]), 2)
        for leg in state["pending"]["repairs"]:
            self.assertEqual(leg["order"]["side"], "SELL" if leg["key"] == "long" else "BUY")
            self.assertEqual(dec(leg["order"]["quantity"]), dec(state["pending"]["quantity"]))
        state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertEqual(self.order_count(), count + 2)
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assert_flat()

    def test_terminal_repair_honors_read_only_adl_and_attempt_limit(self):
        self.terminal_partial_close()
        count = self.order_count()
        state = self.store.get("pair_runtime:gold")
        self.trader._recover(self.pair, state, self.brokers, read_only=True)
        self.assertEqual(state["phase"], "repairing")
        self.assertEqual(state["pending"]["repairs"], [])
        self.assertEqual(self.order_count(), count)
        with patch.object(self.engine.adl, "require_clear", side_effect=TradingError("ADL guard")), \
             self.assertRaisesRegex(TradingError, "ADL guard"):
            self.trader._recover(self.pair, state, self.brokers)
        self.assertEqual(self.order_count(), count)
        state["pending"]["repair_attempts"] = 3
        self.store.put("pair_runtime:gold", state)
        state = self.tick()
        self.assertIsNotNone(state["pending"])
        self.assertEqual(state["pending"]["repairs"], [])
        self.assertEqual(self.order_count(), count)

    def test_transient_position_read_lag_does_not_strand_verified_cycle(self):
        original_read = self.trader._read
        reads = 0

        def read(brokers, symbol, **kwargs):
            nonlocal reads
            reads += 1
            snapshots, guards = original_read(brokers, symbol, **kwargs)
            if reads == 2:
                snapshots = {key: replace(snapshot, positions=[replace(p, qty=dec(0)) for p in snapshot.positions])
                             for key, snapshot in snapshots.items()}
            return snapshots, guards

        with patch.object(self.trader, "_read", side_effect=read):
            state = self.tick()
        self.assertIsNotNone(state["pending"])
        state = self.tick()
        self.assertIsNone(state["pending"])
        self.assertEqual(state["phase"], "holding")
        self.expire()
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assert_flat()

    def test_nonpending_transfer_validation_failure_does_not_block_cycle_reduction(self):
        state = self.tick()
        self.assertEqual(state["phase"], "holding")
        self.expire()
        pair = self.store.pair("gold")
        pair["margin"]["enabled"] = True
        self.store.save_pair(pair)
        self.margin.stop()
        with patch("trading.margin_balance.MarginBalancer._check_snapshots", side_effect=TradingError("划转资格检查失败")):
            state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assert_flat()

    def test_local_unsent_repairs_do_not_exhaust_exchange_recovery_attempts(self):
        original = self.brokers["long"].submit

        def unavailable(orders):
            if orders[0]["side"] == "SELL":
                raise RequestNotSent("本地额度不足，未发送")
            return original(orders)

        with patch.object(self.brokers["long"], "submit", side_effect=unavailable), \
             patch.object(self.brokers["short"], "submit", side_effect=ExchangeError("余额不足", code=-2019)):
            for _ in range(4):
                runtime = self.store.get("pair_runtime:gold")
                if runtime and runtime.get("pending"):
                    runtime["pending"]["repair_retry_at"] = time.time() - 1
                    self.store.put("pair_runtime:gold", runtime)
                self.tick()
        for _ in range(3):
            runtime = self.store.get("pair_runtime:gold")
            if runtime and runtime.get("pending"):
                runtime["pending"]["repair_retry_at"] = time.time() - 1
                self.store.put("pair_runtime:gold", runtime)
            state = self.tick()
            if not state["pending"]:
                break
        self.assertIsNone(state["pending"], state)
        self.assert_flat()

    def test_failed_opening_rolls_back_then_waits_before_new_fee_bearing_attempt(self):
        with patch.object(self.brokers["short"], "submit", side_effect=ExchangeError("余额不足", code=-2019)):
            self.tick()
            state = self.tick()
            self.assertIsNone(state["pending"])
            original_count = len(self.brokers["long"].state["orders"])
            self.tick()
        self.assertEqual(len(self.brokers["long"].state["orders"]), original_count)
        self.assert_flat()

    def test_cross_midnight_volume_uncertainty_blocks_only_affected_utc_day(self):
        now = datetime.now(timezone.utc)
        boundary = now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        instant = boundary + 2

        class FrozenUTC(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls.fromtimestamp(instant, tz)

        state = runtime_default()
        pending = {"created_at": boundary - 1, "legs": [{"key": "long", "receipt": {
            "executedQty": "1", "avgPrice": "100", "updateTime": (boundary + 1) * 1000}}], "repairs": []}
        with patch("trading.pair_execution.datetime", FrozenUTC), patch("trading.pair_execution.time.time", return_value=instant):
            PairTrader._account_volume(state, pending)
        self.assertTrue(state["volume_unknown"])
        pair = self.store.pair("gold")
        pair["cycle"]["daily_volume_limit"] = "1000"
        pair = self.store.save_pair(pair)
        with self.assertRaisesRegex(TradingError, "尚未核实"):
            PairTrader._daily_remaining(pair, state)
        self.store.put("pair_runtime:gold", state)
        instant += 86400
        with patch("trading.pair_execution.datetime", FrozenUTC):
            state = self.tick()
        self.assertFalse(state.get("volume_unknown"), state)
        self.assertEqual(state["phase"], "holding", state)

    def test_uncertain_daily_volume_does_not_block_tracked_position_close(self):
        state = self.tick()
        state.update(volume_unknown=True, volume_unknown_until_utc="9999-12-31")
        self.store.put("pair_runtime:gold", state)
        self.expire()
        pair = self.store.pair("gold")
        pair["cycle"]["daily_volume_limit"] = "1000"
        self.store.save_pair(pair)
        state = self.tick()
        self.assertEqual(state["progress"]["completed_cycles"], 1, state)
        self.assert_flat()

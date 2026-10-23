"""Known terminal fills keep position evidence and reduction authority offline."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_review as review
from tests import test_pair_trading as fixtures
from tests import test_pair_margin_poll_efficiency as margin_fixtures
from trading.exchange import RequestNotSent
from trading.margin_balance import MarginBalancer
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader
from trading.pair_recovery import require_archived_orders_clear


SYMBOL = "XAUUSD1"


class PairFullCheckTests(TestCase):
    setUp = fixtures.PairTradingTests.setUp
    tick = fixtures.PairTradingTests.tick
    expire = fixtures.PairTradingTests.expire
    snapshots = fixtures.PairTradingTests.snapshots
    assert_flat = fixtures.PairTradingTests.assert_flat
    order_count = review.PairReviewTests.order_count
    assert_reducing_journal = review.PairReviewTests.assert_reducing_journal
    terminal_partial_close = review.PairReviewTests.terminal_partial_close

    def full_check_due(self):
        state = self.store.get("pair_runtime:gold")
        pending = state["pending"]
        pending.update(recovery_query_attempts=3, last_possible_send_at=time.time() - 121)
        pending["bounded_recovery"] = {"observed_at": time.time() - 121}
        self.store.put("pair_runtime:gold", state)
        return deepcopy(state)

    def terminal_open(self, kind):
        pair = self.store.pair("gold")
        pair["ordinary"]["enabled"] = kind == "ordinary"
        pair["cycle"]["enabled"] = kind == "cycle"
        self.pair = self.store.save_pair(pair)

        def lag(original):
            def read(*args, **kwargs):
                snapshots, guards = original(*args, **kwargs)
                pending = (self.store.get("pair_runtime:gold") or {}).get("pending")
                if pending and pending["kind"] != "leverage":
                    snapshots = {key: replace(snapshot, positions=[
                        replace(p, qty=dec(pending["before"][p.side]), update_time=None)
                        if p.symbol == SYMBOL and p.side == key.upper() else p for p in snapshot.positions])
                        for key, snapshot in snapshots.items()}
                return snapshots, guards
            return read

        with patch.object(self.trader, "_read", side_effect=lag(self.trader._read)), \
             patch.object(self.engine.pairs, "_read_members", side_effect=lag(self.engine.pairs._read_members)):
            for _ in range(8):
                state = self.tick()
                if (state.get("pending") or {}).get("terminal_position_recovery"):
                    break
        self.assertTrue(state["pending"]["terminal_position_recovery"], state)
        self.assertEqual(state["pending"]["kind"], kind)
        self.assertEqual(state["pending"]["repairs"], [])
        return self.full_check_due()

    def test_known_fills_require_direction_times_at_full_check_for_both_kinds(self):
        for kind in ("ordinary", "cycle"):
            for stamp in (None, 1):
                for quantity in ("baseline", "balanced_partial"):
                    with self.subTest(kind=kind, stamp=stamp, quantity=quantity):
                        self.setUp()
                        original = self.terminal_open(kind)
                        count = self.order_count()
                        read_members = self.engine.pairs._read_members

                        def lag(*args, **kwargs):
                            snapshots, guards = read_members(*args, **kwargs)
                            return {key: replace(snapshot, positions=[
                                replace(p, qty=(dec("0.001") if quantity == "balanced_partial" else dec(0)),
                                    update_time=stamp)
                                if p.symbol == SYMBOL and p.side == key.upper() else p
                                for p in snapshot.positions]) for key, snapshot in snapshots.items()}, guards

                        with patch.object(self.engine.pairs, "_read_members", side_effect=lag) as read:
                            state = self.tick()
                            self.assertIsNotNone(state["pending"], state)
                            self.assertEqual(state["pending"]["id"], original["pending"]["id"])
                            self.assertEqual(state["owned"], original["owned"])
                            self.assertEqual(state["progress"], original["progress"])
                            self.assertEqual(state["pending"]["bounded_recovery"]["failure_count"], 1)
                            self.assertIn("方向持仓更新时间", state["reason"])
                            self.assertIsNone(self.store.get("pair_batch:" + original["pending"]["id"]))
                            self.trader = PairTrader(self.engine)
                            self.tick()
                            self.assertEqual(read.call_count, 1)
                        self.assertEqual(self.order_count(), count)
                        state = self.store.get("pair_runtime:gold")
                        state["pending"]["bounded_recovery"]["next_check_at"] = time.time() - 1
                        self.store.put("pair_runtime:gold", state)
                        state = self.tick()
                        self.assertIsNone(state["pending"], state)
                        if kind == "cycle":
                            self.assertEqual(state["owned"], original["owned"])
                            self.assertGreater(dec(state["progress"]["quantities"]["LONG"]), 0)
                            self.expire()
                            state = self.tick()
                            self.assertEqual(state["progress"]["completed_cycles"], 1, state)
                            self.assert_flat()
                        else:
                            self.assertEqual(state["owned"], original["pending"]["target"])

    def test_balanced_manual_reconciliation_requires_direction_times(self):
        for stamp in (None, 1):
            with self.subTest(stamp=stamp):
                self.setUp()
                original = self.terminal_open("ordinary")
                state = self.store.get("pair_runtime:gold")
                snapshots, guards = self.engine.pairs._read_members(self.pair, adopt=True)
                snapshots = {key: replace(snapshot, positions=[
                    replace(p, qty=dec("0.001"), update_time=stamp) if p.side == key.upper() else p
                    for p in snapshot.positions]) for key, snapshot in snapshots.items()}
                self.trader._publish_snapshots(state, snapshots, SYMBOL)
                self.store.put("pair_runtime:gold", self.trader._durable(state))
                with self.assertRaisesRegex(TradingError, "方向持仓更新时间"):
                    self.engine.pairs.recovery.reconcile_positions(self.trader, self.pair, state,
                        source="automatic_positions", member_read=(snapshots, guards))
                self.assertEqual(state["pending"]["id"], original["pending"]["id"])
                self.assertEqual(state["owned"], original["owned"])

    def pending_transfer(self, status="acknowledged"):
        record = {"request_id": "offline-transfer", "source": "long", "destination": "short",
            "amount": "10", "created_at": time.time() - 10, "status": status, "identity": "offline"}
        self.store.put("pair_margin:gold", {"pending": record})
        return {"pending": record}

    def test_full_check_reduces_known_open_fills_with_pending_transfer(self):
        for kind in ("ordinary", "cycle"):
            with self.subTest(kind=kind):
                self.setUp()
                original = self.terminal_open(kind)
                margin = self.pending_transfer()
                count = self.order_count()
                with patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")), \
                     patch("trading.pair_execution.opening_margin_limit", return_value=dec("0.000001")), \
                     patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read:
                    state = self.tick()
                self.assertEqual(read.call_count, 1)
                self.assertEqual(len(state["pending"]["repairs"]), 2, state)
                for leg in state["pending"]["repairs"]:
                    self.assert_reducing_journal([leg["order"]], leg["key"])
                    self.assertEqual(dec(leg["order"]["quantity"]), dec(original["pending"]["quantity"]))
                state = self.tick()
                self.assertIsNone(state["pending"], state)
                self.assertEqual(state["owned"], original["owned"])
                self.assertEqual(self.order_count(), count + 2)
                self.assertEqual(self.store.get("pair_margin:gold"), margin)
                self.assert_flat()

    def test_full_check_reduces_known_open_fills_with_nonpositive_equity(self):
        for kind in ("ordinary", "cycle"):
            for equity in ("0", "-1"):
                with self.subTest(kind=kind, equity=equity):
                    self.setUp()
                    original = self.terminal_open(kind)
                    count = self.order_count()
                    with ExitStack() as stack:
                        for broker in self.brokers.values():
                            snapshot = broker.snapshot
                            stack.enter_context(patch.object(broker, "snapshot", side_effect=lambda *a, _read=snapshot, **kw:
                                replace(_read(*a, **kw), equity=dec(equity))))
                        # The same low-equity accounts still cannot be adopted.
                        with self.assertRaisesRegex(TradingError, "正的 USD1 权益"):
                            self.engine.pairs._read_members(self.pair, adopt=True)
                        state = self.tick()
                        self.assertEqual(len(state["pending"]["repairs"]), 2, state)
                        state = self.tick()
                    self.assertIsNone(state["pending"], state)
                    self.assertEqual(state["owned"], original["owned"])
                    self.assertEqual(self.order_count(), count + 2)
                    self.assert_flat()

    def test_full_check_close_reduces_with_pending_transfer_and_nonpositive_equity(self):
        self.terminal_partial_close()
        original = self.full_check_due()
        count = self.order_count()
        margin = self.pending_transfer()
        with ExitStack() as stack:
            for broker in self.brokers.values():
                snapshot = broker.snapshot
                stack.enter_context(patch.object(broker, "snapshot", side_effect=lambda *a, _read=snapshot, **kw:
                    replace(_read(*a, **kw), equity=dec(0))))
            state = self.tick()
            self.assertEqual(len(state["pending"]["repairs"]), 1, state)
            state = self.tick()
        self.assertIsNone(state["pending"], state)
        self.assertEqual(state["owned"], original["owned"])
        self.assertGreater(dec(state["progress"]["quantities"]["LONG"]), 0)
        self.assertEqual(state["progress"]["quantities"]["LONG"], state["progress"]["quantities"]["SHORT"])
        self.assertEqual(self.order_count(), count + 1)
        self.assertEqual(self.store.get("pair_margin:gold"), margin)

    def test_pending_transfer_still_blocks_reality_adoption(self):
        for kind in ("ordinary", "cycle"):
            with self.subTest(kind=kind):
                self.setUp()
                original = self.terminal_open(kind)
                margin = self.pending_transfer()
                read_members = self.engine.pairs._read_members

                def changed(*args, **kwargs):
                    snapshots, guards = read_members(*args, **kwargs)
                    return {key: replace(snapshot, positions=[replace(p, qty=dec("0.001"))
                        if p.side == key.upper() else p for p in snapshot.positions])
                        for key, snapshot in snapshots.items()}, guards

                with patch.object(self.engine.pairs, "_read_members", side_effect=changed):
                    state = self.tick()
                self.assertEqual(state["pending"]["id"], original["pending"]["id"])
                self.assertEqual(state["owned"], original["owned"])
                self.assertEqual(state["pending"]["repairs"], [])
                self.assertIn("未决划转", state["reason"])
                self.assertEqual(self.store.get("pair_margin:gold"), margin)

    def test_full_check_reduction_honors_read_only_and_revoked_guards(self):
        self.terminal_partial_close()
        self.full_check_due()
        self.pending_transfer()
        count = self.order_count()
        state = self.store.get("pair_runtime:gold")
        self.trader._recover(self.pair, state, self.brokers, read_only=True)
        self.assertEqual(state["phase"], "repairing", state)
        self.assertEqual(state["pending"]["repairs"], [])
        self.full_check_due()
        read_members = self.engine.pairs._read_members

        def revoked(*args, **kwargs):
            snapshots, guards = read_members(*args, **kwargs)
            guards["long"] = (None, lambda: (_ for _ in ()).throw(RequestNotSent("划转撤销读租约")))
            return snapshots, guards

        with patch.object(self.engine.pairs, "_read_members", side_effect=revoked), \
             patch.object(self.brokers["long"], "submit", side_effect=AssertionError("revoked read cannot send")):
            state = self.tick()
        self.assertIsNotNone(state["pending"])
        self.assertEqual(self.order_count(), count)
        self.assertEqual(state["pending"]["repair_attempts"], 0)
        self.assertTrue(all(leg["receipt"]["local_not_sent"] for leg in state["pending"]["repairs"]))

    def test_repair_requires_the_other_side_lease_before_any_send(self):
        for revoked_key in ("long", "short"):
            with self.subTest(revoked=revoked_key):
                self.setUp()
                self.terminal_partial_close()
                self.full_check_due()
                count = self.order_count()
                read_members = self.engine.pairs._read_members

                def revoked(*args, _key=revoked_key, **kwargs):
                    snapshots, guards = read_members(*args, **kwargs)
                    guards[_key] = (None, lambda: (_ for _ in ()).throw(RequestNotSent("对侧持仓变化撤销读租约")))
                    return snapshots, guards

                with patch.object(self.engine.pairs, "_read_members", side_effect=revoked), \
                     patch.object(self.brokers["long"], "submit", side_effect=AssertionError("stale pair read")), \
                     patch.object(self.brokers["short"], "submit", side_effect=AssertionError("stale pair read")):
                    state = self.tick()
                self.assertEqual(self.order_count(), count)
                self.assertEqual(state["pending"]["repair_attempts"], 0)
                self.assertTrue(state["pending"]["repairs"])
                self.assertTrue(all(leg["receipt"]["local_not_sent"] for leg in state["pending"]["repairs"]))

    def test_pre_upgrade_pending_keeps_prior_adoption_without_direction_times(self):
        for kind in ("ordinary", "cycle"):
            with self.subTest(kind=kind):
                self.setUp()
                original = self.terminal_open(kind)
                self.assertIs(original["pending"]["position_time_evidence"], True)
                state = self.store.get("pair_runtime:gold")
                del state["pending"]["position_time_evidence"]
                self.store.put("pair_runtime:gold", state)
                for broker in self.brokers.values():
                    for position in broker.state["positions"].values():
                        position.pop("updateTime", None)
                    broker.save()
                count = self.order_count()
                read_members = self.engine.pairs._read_members

                def rolled_back(*args, **kwargs):
                    snapshots, guards = read_members(*args, **kwargs)
                    return {key: replace(snapshot, positions=[
                        replace(p, qty=dec(0), update_time=None)
                        if p.symbol == SYMBOL and p.side == key.upper() else p
                        for p in snapshot.positions]) for key, snapshot in snapshots.items()}, guards

                with patch.object(self.engine.pairs, "_read_members", side_effect=rolled_back):
                    state = self.tick()
                self.assertIsNone(state["pending"], state["reason"])
                self.assertEqual(self.order_count(), count)
                self.assertEqual(state["owned"], original["owned"])
    def test_legacy_exact_projection_completes_without_direction_times(self):
        for kind in ("ordinary", "cycle"):
            for full_check in (False, True):
                with self.subTest(kind=kind, full_check=full_check):
                    self.setUp()
                    original = self.terminal_open(kind)
                    if not full_check:
                        state = self.store.get("pair_runtime:gold")
                        state["pending"]["recovery_query_attempts"] = 0
                        state["pending"]["bounded_recovery"] = {"observed_at": time.time()}
                        self.store.put("pair_runtime:gold", state)
                    for broker in self.brokers.values():
                        for position in broker.state["positions"].values():
                            position.pop("updateTime", None)
                        broker.save()
                    count = self.order_count()
                    state = self.tick()
                    self.assertIsNone(state["pending"], state["reason"])
                    self.assertEqual(self.order_count(), count)
                    self.assertNotIn("recovery_watch", state)
                    if kind == "cycle":
                        self.assertEqual(state["owned"], original["owned"])
                        self.assertEqual(state["progress"]["phase"], "holding")
                        self.assertGreater(dec(state["progress"]["quantities"]["LONG"]), 0)
                    else:
                        self.assertEqual(state["owned"], original["pending"]["target"])

    def test_full_check_with_watch_reuses_one_read_and_its_guards(self):
        for revoked in (False, True):
            with self.subTest(revoked=revoked):
                self.setUp()
                original = self.terminal_open("ordinary")
                state = self.store.get("pair_runtime:gold")
                for leg in state["pending"]["legs"]:
                    leg["receipt"]["status"] = "EXPIRED"
                old = {"id": "legacy-hot", "symbol": SYMBOL, "created_at": time.time() - 3600,
                    "identities": deepcopy(state["identities"]), "bounded_queries_complete": True,
                    "legs": [{"key": leg["key"], "order": {**leg["order"],
                        "newClientOrderId": "legacy-" + leg["key"]}} for leg in state["pending"]["legs"]]}
                state["recovery_watch"] = {"batches": [old], "retired_identities": state["identities"],
                                          "retired_symbols": [SYMBOL]}
                self.store.put("pair_runtime:gold", state)
                for broker in self.brokers.values():
                    for position in broker.state["positions"].values():
                        position.pop("updateTime", None)
                    broker.save()

                def historical(*args, **kwargs):
                    snapshots, guards = kwargs["member_read"]
                    self.assertTrue(all(p.update_time is None for s in snapshots.values() for p in s.positions))
                    if revoked:
                        def invalid():
                            raise RequestNotSent("历史查询期间原读租约失效")
                        guards[self.pair["long_account_id"]] = (None, invalid)
                    return require_archived_orders_clear(*args, **kwargs)

                count = self.order_count()
                with patch.object(self.engine.pairs, "_read_members", wraps=self.engine.pairs._read_members) as read, \
                     patch("trading.pair_recovery.require_archived_orders_clear", side_effect=historical) as history:
                    result = self.tick()
                self.assertEqual(read.call_count, 1)
                self.assertEqual(history.call_count, 1)
                self.assertEqual(self.order_count(), count)
                self.assertEqual(result["recovery_watch"], state["recovery_watch"])
                if revoked:
                    self.assertEqual(result["pending"]["id"], original["pending"]["id"])
                    self.assertEqual(result["pending"]["bounded_recovery"]["failure_count"], 1)
                    self.assertIn("失效", result["reason"])
                    self.assertEqual(result["owned"], original["owned"])
                else:
                    self.assertIsNone(result["pending"], result["reason"])
                    self.assertEqual(result["owned"], original["pending"]["target"])


class PairFullCheckLiveTests(TestCase):
    live_brokers = margin_fixtures.PairMarginPollEfficiencyTests.live_brokers
    pending_transfer = margin_fixtures.PairMarginPollEfficiencyTests.pending
    tick = fixtures.PairTradingTests.tick
    terminal_open = PairFullCheckTests.terminal_open
    full_check_due = PairFullCheckTests.full_check_due

    def setUp(self):
        if hasattr(self, "paper"):
            del self.paper
        margin_fixtures.PairMarginPollEfficiencyTests.setUp(self)
        self.engine.capacities = lambda symbol: {5: dec(1000000), 10: dec(0), 20: dec(0)}
        tick = patch.object(MarginBalancer, "tick", return_value={"blocks_trading": False})
        tick.start()
        self.addCleanup(tick.stop)
        for side, broker in self.brokers.items():
            original = broker.api.call

            def call(method, path, *args, _call=original, _side=side, **kwargs):
                result = _call(method, path, *args, **kwargs)
                if path in ("/fapi/v3/accountWithJoinMargin", "/fapi/v3/positionRisk"):
                    rows = result["positions"] if isinstance(result, dict) else result
                    times = {(p.symbol, p.side): p.update_time
                             for p in self.paper[_side].snapshot([SYMBOL]).positions}
                    for row in rows:
                        row["updateTime"] = times[(row["symbol"], row["positionSide"])]
                return result

            broker.api.call = call
            broker.cycle_cache.configure([SYMBOL])
            broker.cycle_cache.set_connected(True)
            self.assertTrue(broker.cycle_cache.publish(broker.cycle_cache.begin_refresh(),
                replace(self.paper[side].snapshot([SYMBOL]), open_orders=None), self.ticks))

    def order_count(self):
        return sum(len(b.state["orders"]) for b in self.paper.values())

    def test_all_pending_transfer_statuses_allow_verified_reductions(self):
        for kind in ("ordinary", "cycle"):
            for status in ("submitting", "acknowledged", "accepted", "unknown"):
                with self.subTest(kind=kind, status=status):
                    self.setUp()
                    original = self.terminal_open(kind)
                    self.pending_transfer(status)
                    margin = self.store.get("pair_margin:gold")
                    count = self.order_count()
                    with patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")), \
                         patch("trading.pair_execution.opening_margin_limit", return_value=dec("0.000001")):
                        state = self.tick()
                    self.assertEqual(len(state["pending"]["repairs"]), 2, state["reason"])
                    self.assertEqual(self.order_count(), count + 2)
                    self.assertTrue(all(leg["order"]["side"] == ("SELL" if leg["key"] == "long" else "BUY")
                        for leg in state["pending"]["repairs"]))
                    state = self.tick()
                    self.assertIsNone(state["pending"], state["reason"])
                    self.assertEqual(state["owned"], original["owned"])
                    self.assertEqual(self.store.get("pair_margin:gold"), margin)

    def test_transfer_invalidation_still_revokes_full_check_repair_authority(self):
        self.terminal_open("cycle")
        self.pending_transfer("unknown", transaction=False)
        count = self.order_count()
        config_guard = self.trader._config_guard
        revoked = []

        def guard(*args, **kwargs):
            config_guard(*args, **kwargs)
            if not revoked:
                revoked.append(True)
                MarginBalancer(self.engine)._invalidate(
                    {key: self.store.account(key) for key in ("long", "short")})

        with patch.object(self.trader, "_config_guard", side_effect=guard), \
             patch("trading.pair_execution.cycle_margin_limit", return_value=dec("0.000001")):
            state = self.tick()
        self.assertTrue(revoked)
        self.assertEqual(self.order_count(), count)
        self.assertIsNotNone(state["pending"], state["reason"])
        self.assertEqual(state["pending"]["repair_attempts"], 0)
        self.assertEqual(len(state["pending"]["repairs"]), 2)
        self.assertTrue(all(leg["receipt"]["local_not_sent"] for leg in state["pending"]["repairs"]))

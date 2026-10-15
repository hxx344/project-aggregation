"""Public upgrade capacity must cover both existing pair positions exactly."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from decimal import localcontext
import threading
import time
from unittest import TestCase
from unittest.mock import patch

from tests.helpers import Fixture
from tests import test_pair_budget as live_fixtures
from tests import test_pair_trading as pair_fixtures
from trading.exchange import AmbiguousOrder
from trading.models import TradingError, dec
from trading.pair_execution import runtime_default
from trading.pair_planning import ordinary_upgrade, plan_ordinary
from trading.pairing import validate_pair


SYMBOL = "XAUUSD1"


class PairUpgradePlanningTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.pair = validate_pair({"id": "gold", "name": "黄金配对", "long_account_id": "long",
                                   "short_account_id": "short", "ordinary": {"enabled": True}})
        self.book = replace(self.f.market.book(SYMBOL), mark=dec("100"))

    def snapshots(self, *, leverage=10, quantities=("100", "100"), marks=("100", "100")):
        result = {}
        for key, side, qty, mark in zip(("long", "short"), ("LONG", "SHORT"), quantities, marks):
            snap = deepcopy(self.f.broker.snapshot([SYMBOL]))
            snap.positions = [replace(p, leverage=leverage,
                                      qty=dec(qty) if p.side == side else dec("0"), mark=dec(mark))
                              if p.symbol == SYMBOL else p for p in snap.positions]
            result[key] = snap
        return result

    def test_upgrade_skips_public_capacity_above_threshold_below_combined_holdings(self):
        self.assertIsNone(ordinary_upgrade(self.pair, self.snapshots(), self.book, {20: dec("15000")}))

    def test_upgrade_requires_public_capacity_strictly_above_combined_holdings(self):
        self.assertIsNone(ordinary_upgrade(self.pair, self.snapshots(), self.book, {20: dec("20000")}))

    def test_exact_capacity_above_combined_holdings_permits_upgrade(self):
        snapshots = self.snapshots()
        capacity = dec("20000.000000000000000000000001")
        with localcontext() as context:
            context.prec = 8
            self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book, {20: capacity}), 20)

    def test_both_accounts_count_even_when_each_alone_fits_public_capacity(self):
        snapshots = self.snapshots(quantities=("80", "90"))
        self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("16000")}))
        self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("17000.01")}), 20)

    def test_holding_value_uses_the_higher_mark_for_each_account(self):
        snapshots = self.snapshots(marks=("125", "75"))
        for capacity in ("20000", "22500"):
            with self.subTest(capacity=capacity):
                self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec(capacity)}))
        self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("22500.01")}), 20)

    def test_private_target_bracket_remains_a_separate_account_limit(self):
        for key in ("long", "short"):
            with self.subTest(account=key):
                snapshots = self.snapshots()
                snapshots[key].brackets[SYMBOL][0]["notionalCap"] = "9999"
                self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("50000")}))
                snapshots[key].brackets[SYMBOL][0]["notionalCap"] = "10000"
                self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("50000")}), 20)

    def test_upgrade_can_skip_insufficient_middle_tier(self):
        snapshots = self.snapshots(leverage=5)
        self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book,
                                         {10: dec("15000"), 20: dec("25000")}), 20)

    def test_empty_pair_still_upgrades_when_strict_threshold_is_met(self):
        snapshots = self.snapshots(quantities=("0", "0"))
        self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("10000")}))
        self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book,
                                         {20: dec("10000.000000000000000000000001")}), 20)

    def test_other_symbol_holdings_do_not_block_this_symbols_upgrade(self):
        snapshots = self.snapshots()
        for snap in snapshots.values():
            snap.positions = [replace(p, qty=dec("5")) if p.symbol == "XAGUSD1" else p
                              for p in snap.positions]
        self.assertEqual(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("50000")}), 20)

    def test_opposite_holdings_keep_their_existing_symbol_leverage(self):
        for key, opposite in (("long", "SHORT"), ("short", "LONG")):
            with self.subTest(account=key):
                snapshots = self.snapshots()
                snapshots[key].positions = [replace(p, qty=dec("1")) if p.symbol == SYMBOL and p.side == opposite else p
                                            for p in snapshots[key].positions]
                self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, {20: dec("50000")}))

    def test_missing_or_below_threshold_capacity_cannot_authorize_upgrade(self):
        for capacities in ({}, {20: dec("9999")}, {20: dec("10000")}):
            with self.subTest(capacities=capacities):
                self.assertIsNone(ordinary_upgrade(self.pair, self.snapshots(), self.book, capacities))

    def test_upgrade_rejects_stale_or_future_book(self):
        for age in (4, -2):
            with self.subTest(age=age), self.assertRaises(TradingError):
                ordinary_upgrade(self.pair, self.snapshots(), replace(self.book, timestamp=time.time() - age),
                                 {20: dec("50000")})

    def test_minimum_leverage_message_explains_combined_capacity_blocker(self):
        self.pair["ordinary"]["min_open_leverage"] = 20
        snapshots = self.snapshots()
        capacities = {20: dec("15000")}
        self.assertIsNone(ordinary_upgrade(self.pair, snapshots, self.book, capacities))
        with self.assertRaises(TradingError) as caught:
            plan_ordinary(self.pair, snapshots, self.book, self.f.market.rules[SYMBOL], capacities)
        self.assertIn("20x", str(caught.exception))
        self.assertIn("公开额度 15000 USD1", str(caught.exception))
        self.assertIn("两账户现有持仓总价值 20000 USD1", str(caught.exception))
        self.assertNotIn("可申请自动升档", str(caught.exception))


class PairUpgradeExecutionTests(TestCase):
    live_brokers = live_fixtures.PairBudgetTests.live_brokers

    def setUp(self):
        pair_fixtures.PairTradingTests.setUp(self)
        self.pair["cycle"]["enabled"] = False
        self.pair["ordinary"]["enabled"] = True
        self.pair = self.store.save_pair(self.pair)
        for key, broker in self.brokers.items():
            broker.state["leverages"][SYMBOL] = 10
            broker.state["positions"][SYMBOL + ":" + key.upper()].update(
                qty="3", entry=str(self.market.book(SYMBOL).mark))
            broker.save()
        self.state = runtime_default()
        self.state.update(symbol=SYMBOL, owned={"LONG": "3", "SHORT": "3"},
                          identities=self.trader._members(self.pair)[2])
        self.store.put("pair_runtime:gold", self.state)
        self.publish("30000")

    def publish(self, capacity):
        self.engine.markets[SYMBOL] = {"status": "ok", "checked_at": time.time(),
                                      "capacities": {"10": "100000", "20": capacity}}

    def tick(self):
        return self.trader.tick(self.store.pair("gold"))

    def leverage(self):
        self.state["identities"] = self.trader._members(self.pair)[2]
        snapshots, guards = self.trader._read(self.brokers, SYMBOL)
        self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 20)
        return self.state

    def capture_pending(self, after_prepare=None):
        original = self.trader._save
        captured = []

        def save(pair, state):
            original(pair, state)
            pending = state.get("pending")
            if pending:
                captured.append(deepcopy(pending))
                if pending["kind"] == "leverage" and not pending["results"] and after_prepare:
                    after_prepare()

        return captured, patch.object(self.trader, "_save", side_effect=save)

    def test_insufficient_upgrade_capacity_keeps_10x_and_allows_ordinary_open(self):
        self.publish("20000")
        captured, saving = self.capture_pending()
        with saving, ExitStack() as stack:
            changes = [stack.enter_context(patch.object(broker, "set_leverage", wraps=broker.set_leverage))
                       for broker in self.brokers.values()]
            state = self.tick()
        for change in changes:
            change.assert_not_called()
        self.assertTrue(captured)
        self.assertEqual({pending["kind"] for pending in captured}, {"ordinary"})
        self.assertIsNone(state["pending"], state)
        self.assertGreater(dec(state["owned"]["LONG"]), 3, state)
        self.assertEqual(state["owned"]["LONG"], state["owned"]["SHORT"])
        for broker in self.brokers.values():
            self.assertEqual(broker.state["leverages"][SYMBOL], 10)
            self.assertEqual(len(broker.state["orders"]), 1)

    def test_opposite_position_skips_upgrade_but_allows_ordinary_open_at_current_leverage(self):
        broker = self.brokers["long"]
        broker.state["positions"][SYMBOL + ":SHORT"].update(qty="1", entry=str(self.market.book(SYMBOL).mark))
        external = deepcopy(broker.state["positions"][SYMBOL + ":SHORT"])
        broker.save()
        captured, saving = self.capture_pending()
        with saving, ExitStack() as stack:
            changes = [stack.enter_context(patch.object(item, "set_leverage", wraps=item.set_leverage))
                       for item in self.brokers.values()]
            state = self.tick()
        self.assertEqual({pending["kind"] for pending in captured}, {"ordinary"})
        self.assertIsNone(state["pending"], state)
        self.assertGreater(dec(state["owned"]["LONG"]), 3)
        self.assertEqual(broker.state["positions"][SYMBOL + ":SHORT"], external)
        for change in changes:
            change.assert_not_called()
        for item in self.brokers.values():
            self.assertEqual(item.state["leverages"][SYMBOL], 10)

    def test_execution_rechecks_capacity_before_creating_leverage_pending(self):
        self.publish("20000")
        with patch.object(self.trader, "_save", wraps=self.trader._save) as save, ExitStack() as stack:
            changes = [stack.enter_context(patch.object(broker, "set_leverage"))
                       for broker in self.brokers.values()]
            with self.assertRaisesRegex(TradingError, "两账户现有持仓总价值"):
                self.leverage()
        for change in changes:
            change.assert_not_called()
        save.assert_not_called()
        self.assertIsNone(self.state["pending"])
        self.assertIsNone(self.store.get("pair_runtime:gold")["pending"])

    def test_capacity_loss_between_planning_and_execution_creates_no_leverage_pending(self):
        original = self.trader._leverage

        def execute(*args, **kwargs):
            self.publish("20000")
            return original(*args, **kwargs)

        captured, saving = self.capture_pending()
        with saving, patch.object(self.trader, "_leverage", side_effect=execute) as selected, ExitStack() as stack:
            changes = [stack.enter_context(patch.object(broker, "set_leverage"))
                       for broker in self.brokers.values()]
            state = self.tick()
        selected.assert_called_once()
        for change in changes:
            change.assert_not_called()
        self.assertEqual(captured, [])
        self.assertIsNone(state["pending"], state)
        self.assertIn("两账户现有持仓总价值", state["reason"])

    def test_paper_send_rechecks_capacity_after_pending_is_persisted(self):
        captured, saving = self.capture_pending(lambda: self.publish("20000"))
        with saving, ExitStack() as stack:
            changes = [stack.enter_context(patch.object(broker, "set_leverage", wraps=broker.set_leverage))
                       for broker in self.brokers.values()]
            state = self.leverage()
        for change in changes:
            change.assert_not_called()
        results = captured[-1]["results"]
        self.assertTrue(all(results[key].get("rejected") for key in self.brokers), results)
        self.assertTrue(all("两账户现有持仓总价值" in result["reason"] for result in results.values()))
        self.assertIsNone(state["pending"], state)

    def test_paper_send_rechecks_price_after_pending_is_persisted(self):
        original = self.market.book
        price_changed = False

        def change_price():
            nonlocal price_changed
            price_changed = True

        def book(symbol):
            current = original(symbol)
            return replace(current, mark=dec("6000")) if symbol == SYMBOL and price_changed else current

        captured, saving = self.capture_pending(change_price)
        with saving, patch.object(self.market, "book", side_effect=book), ExitStack() as stack:
            changes = [stack.enter_context(patch.object(broker, "set_leverage", wraps=broker.set_leverage))
                       for broker in self.brokers.values()]
            state = self.leverage()
        for change in changes:
            change.assert_not_called()
        results = captured[-1]["results"]
        self.assertTrue(all(results[key].get("rejected") for key in self.brokers), results)
        self.assertTrue(all("36000 USD1" in result["reason"] for result in results.values()))
        self.assertIsNone(state["pending"], state)

    def test_unknown_previous_upgrade_remains_read_only_when_capacity_falls(self):
        pending = {"id": "unknown-upgrade", "kind": "leverage", "symbol": SYMBOL,
                   "identities": deepcopy(self.state["identities"]), "before": {"LONG": "3", "SHORT": "3"},
                   "created_at": time.time(), "target_leverage": 20, "previous_leverage": 10,
                   "results": {key: {"unknown": True} for key in self.brokers}}
        self.state["pending"] = deepcopy(pending)
        self.store.put("pair_runtime:gold", self.state)
        self.publish("20000")
        with ExitStack() as stack:
            writes = [stack.enter_context(patch.object(broker, method))
                      for broker in self.brokers.values() for method in ("set_leverage", "submit")]
            for _ in range(2):
                state = self.tick()
                self.assertEqual(state["phase"], "reconciling", state)
                self.assertEqual({key: state["pending"][key] for key in pending}, pending)
        for write in writes:
            write.assert_not_called()
        self.assertEqual({key: self.store.get("pair_runtime:gold")["pending"][key] for key in pending}, pending)

    def test_live_token_fallback_rechecks_last_snapshot_mark_before_post(self):
        self.live_brokers()
        self.state["identities"] = self.trader._members(self.pair)[2]
        snapshots, guards = self.trader._read(self.brokers, SYMBOL, fresh_modes=True)
        for key, broker in self.brokers.items():
            broker.leverage_snapshot = (snapshots[key], time.monotonic() - 2)
        captured, saving = self.capture_pending()
        with saving, ExitStack() as stack:
            reads = []
            for broker in self.brokers.values():
                original = broker.snapshot

                def snapshot(*args, _read=original, **kwargs):
                    current = _read(*args, **kwargs)
                    current.positions = [replace(p, mark=dec("6000")) if p.symbol == SYMBOL and p.qty else p
                                         for p in current.positions]
                    return current

                reads.append(stack.enter_context(patch.object(broker, "snapshot", side_effect=snapshot)))
            self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 20)
        self.assertTrue(all(read.call_args_list[0].kwargs.get("fresh_modes") for read in reads))
        self.assertTrue(all(not any(method == "POST" for method, _, _ in broker.api.calls)
                            for broker in self.brokers.values()))
        results = captured[-1]["results"]
        self.assertTrue(all(results[key].get("rejected") for key in self.brokers), results)
        self.assertTrue(all("两账户现有持仓总价值" in result["reason"] for result in results.values()))
        self.assertIsNone(self.state["pending"], self.state)

    def test_live_upgrade_with_sufficient_capacity_confirms_both_accounts(self):
        self.live_brokers()
        state = self.leverage()
        self.assertIsNone(state["pending"], state)
        for key, broker in self.brokers.items():
            self.assertEqual([(method, path) for method, path, _ in broker.api.calls if method == "POST"],
                             [("POST", "/fapi/v3/leverage")])
            self.assertEqual(self.paper[key].state["leverages"][SYMBOL], 20)

    def test_live_final_read_of_new_opposite_position_prevents_leverage_post(self):
        self.live_brokers()
        self.state["identities"] = self.trader._members(self.pair)[2]
        snapshots, guards = self.trader._read(self.brokers, SYMBOL, fresh_modes=True)
        for key, broker in self.brokers.items():
            broker.leverage_snapshot = (snapshots[key], time.monotonic() - 2)
        captured, saving = self.capture_pending()
        with saving, ExitStack() as stack:
            for key, broker in self.brokers.items():
                original = broker.snapshot

                def snapshot(*args, _read=original, _key=key, **kwargs):
                    current = _read(*args, **kwargs)
                    current.positions = [replace(p, qty=dec("0.1")) if p.symbol == SYMBOL and p.side != _key.upper() else p
                                         for p in current.positions]
                    return current

                stack.enter_context(patch.object(broker, "snapshot", side_effect=snapshot))
            self.trader._leverage(self.pair, self.state, self.brokers, snapshots, guards, 20)
        self.assertTrue(all(not any(method == "POST" for method, _, _ in broker.api.calls)
                            for broker in self.brokers.values()))
        self.assertTrue(all(row.get("rejected") and "非本组方向仓位" in row["reason"]
                            for row in captured[-1]["results"].values()))
        self.assertIsNone(self.state["pending"], self.state)

    def test_one_live_upgrade_sent_before_capacity_loss_keeps_pending_without_replay(self):
        for outcome in ("unknown", "success"):
            with self.subTest(outcome=outcome):
                self.live_brokers()
                self.state["pending"] = None
                self.store.put("pair_runtime:gold", self.state)
                self.publish("30000")
                capacity_changed = threading.Event()
                original_long = self.paper["long"].set_leverage
                original_short = self.brokers["short"].set_leverage

                def first_request(symbol, leverage):
                    # OfflineAPI has already recorded a real broker POST here.
                    response = original_long(symbol, leverage) if outcome == "success" else None
                    self.publish("20000")
                    capacity_changed.set()
                    if outcome == "unknown":
                        raise AmbiguousOrder("offline leverage response lost")
                    return response

                def second_request(symbol, leverage, *, checked_snapshot, before_submit):
                    def check(snapshot):
                        self.assertTrue(capacity_changed.wait(timeout=3), "first leverage request never reached API")
                        before_submit(snapshot)

                    return original_short(symbol, leverage, checked_snapshot=checked_snapshot, before_submit=check)

                with patch.object(self.paper["long"], "set_leverage", side_effect=first_request) as first, \
                     patch.object(self.brokers["short"], "set_leverage", side_effect=second_request):
                    state = self.leverage()
                first.assert_called_once_with(SYMBOL, 20)
                self.assertEqual(state["phase"], "reconciling", state)
                pending = deepcopy(state["pending"])
                self.assertIsNotNone(pending)
                results = pending["results"]
                if outcome == "unknown":
                    self.assertTrue(results["long"].get("unknown"), results)
                else:
                    self.assertEqual(results["long"]["response"]["leverage"], 20)
                self.assertTrue(results["short"].get("rejected"), results)
                self.assertIn("两账户现有持仓总价值", results["short"]["reason"])
                self.assertEqual(self.paper["long"].state["leverages"][SYMBOL], 20 if outcome == "success" else 10)
                self.assertEqual(self.paper["short"].state["leverages"][SYMBOL], 10)

                with ExitStack() as stack:
                    writes = [stack.enter_context(patch.object(broker, method))
                              for broker in self.brokers.values() for method in ("set_leverage", "submit")]
                    for _ in range(2):
                        recovered = self.tick()
                        self.assertEqual(recovered["phase"], "reconciling", recovered)
                        self.assertEqual({key: value for key, value in recovered["pending"].items()
                                          if key != "recovery_query_attempts"},
                                         {key: value for key, value in pending.items()
                                          if key != "recovery_query_attempts"})
                for write in writes:
                    write.assert_not_called()
                self.assertEqual(self.store.get("pair_runtime:gold")["pending"], recovered["pending"])
                for key, broker in self.brokers.items():
                    self.assertEqual([(method, path) for method, path, _ in broker.api.calls if method == "POST"],
                                     [("POST", "/fapi/v3/leverage")] if key == "long" else [])
                    self.assertEqual(self.paper[key].state["orders"], {})

"""Independent funds checks through real paper ledgers and pair scheduling."""
from dataclasses import replace
from copy import copy
import time
from unittest import TestCase
from unittest.mock import patch

from tests import pair_fixtures as fixtures
from trading.exchange import RequestNotSent
from trading.margin_balance import MarginBalancer
from trading.models import dec
from trading.pair_execution import PairTrader
from trading.pair_planning import LEGACY_ORDERS_REASON


class PairMarginLifelineTests(TestCase):
    def setUp(self):
        fixtures.PairTradingTests.setUp(self)
        self.margin.stop()
        self.wall = time.time()
        clock = patch("time.time", side_effect=lambda: self.wall)
        clock.start()
        self.addCleanup(clock.stop)
        self.engine.pairs.trader = self.trader
        self.strategy_market = copy(self.market)
        self.trader.market = self.strategy_market
        self.enable_margin()

    tick = fixtures.PairTradingTests.tick

    def enable_margin(self):
        self.pair = self.store.pair("gold")
        self.pair["margin"].update(enabled=True, cooldown_seconds=1)
        self.pair = self.store.save_pair(self.pair)

    def wallet(self, side, amount):
        broker = self.brokers[side]
        broker.state["wallet"] = str(amount)
        self.store.put("paper:" + side, broker.state)

    def assert_transferred(self, state):
        self.assertEqual(state["margin"]["status"], "paper_confirmed", state)
        self.assertEqual(dec(self.brokers["long"].state["wallet"]), 25000)
        self.assertEqual(dec(self.brokers["short"].state["wallet"]), 25000)
        journal = self.store.get("pair_margin:gold")
        self.assertIsNone(journal["pending"])
        self.assertEqual(dec(journal["last_transfer"]["amount"]), 1000)

    def assert_no_orders(self):
        self.assertTrue(all(not broker.state["orders"] for broker in self.brokers.values()))

    def test_mismatched_position_or_leverage_does_not_block_real_transfer(self):
        for mismatch in ("quantity", "leverage"):
            with self.subTest(mismatch=mismatch):
                self.store.put("pair_runtime:gold", {})
                self.store.put("pair_margin:gold", {})
                self.wallet("long", 26000)
                self.wallet("short", 24000)
                long = self.brokers["long"]
                long.state["leverages"]["XAUUSD1"] = 10 if mismatch == "leverage" else 5
                position = long.state["positions"]["XAUUSD1:LONG"]
                position.update(qty="0.01" if mismatch == "quantity" else "0", entry="4412.015")
                self.store.put("paper:long", long.state)
                state = self.tick()
                self.assertEqual(state["margin"]["status"], "paper_confirmed", state)
                self.assertIsNone(state["pending"])
                self.assert_no_orders()
                self.assertEqual(dec(self.brokers["long"].state["wallet"]) +
                                 dec(self.brokers["short"].state["wallet"]), 50000)
                self.wall += 5
                # Funds-only pairs never reconcile positions or leverages.
                state = self.tick()
                self.assertEqual(state["phase"], "monitoring", state)
                self.assertNotIn("attention", state)
                self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
                self.assert_no_orders()

    def test_funds_keep_their_own_deadline(self):
        self.wallet("long", 26000)
        self.wallet("short", 24000)
        with patch.object(self.trader, "_read", wraps=self.trader._read) as reads:
            # The scheduler sleeps exactly until the funds check deadline.
            self.assertEqual(self.engine.pairs.tick("gold"), 5)
            state = self.store.get("pair_runtime:gold")
            self.assert_transferred(state)
            self.assertEqual(reads.call_count, 1)
            self.wall += 1
            self.assertEqual(self.engine.pairs.tick("gold"), 4)
            self.assertEqual(reads.call_count, 1)  # Not due yet: no account read.
            self.wall += 4
            self.wallet("long", 26000)
            self.wallet("short", 24000)
            self.assertEqual(self.engine.pairs.tick("gold"), 5)
            self.assert_transferred(self.store.get("pair_runtime:gold"))
            self.assertEqual(reads.call_count, 2)
        self.assert_no_orders()

    def test_market_failure_never_reaches_funds_checks_across_restart(self):
        with patch.object(self.strategy_market, "book", side_effect=RequestNotSent("market backoff", retry_after=60)) as book:
            self.assertEqual(self.engine.pairs.tick("gold"), 5)
            self.wall += 5
            self.wallet("long", 26000)
            self.wallet("short", 24000)
            self.trader = PairTrader(self.engine)
            self.trader.market = self.strategy_market
            self.engine.pairs.trader = self.trader
            self.assertEqual(self.engine.pairs.tick("gold"), 5)
            self.assert_transferred(self.store.get("pair_runtime:gold"))
            self.wall += 55
            self.engine.pairs.tick("gold")
            book.assert_not_called()
        self.assert_no_orders()

    def test_margin_fallback_cannot_borrow_recovery_budget_or_poll_during_backoff(self):
        fixtures.PairBudgetTests.live_brokers(self)
        self.budget.reserve(1500)
        before = self.budget.snapshot()["used"]
        state = self.tick()
        self.assertEqual(state["margin"]["status"], "waiting", state)
        self.assertFalse(state["margin"]["blocks_trading"])
        self.assertEqual(state["margin"]["api_notice"]["kind"], "budget")
        self.assertEqual(self.budget.snapshot()["used"], before)
        self.assertTrue(all(not broker.api.calls for broker in self.brokers.values()))
        self.wall += 1
        state = self.tick()
        self.assertTrue(all(not broker.api.calls for broker in self.brokers.values()))
        self.assertGreater(state["margin"]["retry_after"], 1)
        self.assertEqual(state["margin"]["api_notice"]["kind"], "budget")

    def test_account_modes_and_open_orders_do_not_block_transfers(self):
        original = self.trader._read
        for mode in ("isolated", "hedge", "multi", "missing_symbol", "orders"):
            with self.subTest(mode=mode):
                self.wallet("long", 26000)
                self.wallet("short", 24000)
                self.store.put("pair_runtime:gold", {})
                self.store.put("pair_margin:gold", {})

                def read(brokers, symbol, **options):
                    snapshots, guards = original(brokers, symbol, **options)
                    snapshot = snapshots["long"]
                    if mode == "isolated":
                        snapshots["long"] = replace(snapshot, positions=[replace(position, isolated=True)
                            if position.symbol == "XAUUSD1" else position for position in snapshot.positions])
                    elif mode == "hedge":
                        snapshots["long"] = replace(snapshot, hedge_mode=False)
                    elif mode == "multi":
                        snapshots["long"] = replace(snapshot, multi_assets=True)
                    elif mode == "orders":
                        snapshots["long"] = replace(snapshot, open_orders=[{"orderId": "external"}])
                    else:
                        snapshots["long"] = replace(snapshot, positions=[position for position in snapshot.positions
                            if position.symbol != "XAUUSD1"])
                    return snapshots, guards

                with patch.object(self.trader, "_read", side_effect=read):
                    state = self.tick()
                self.assert_transferred(state)
                self.assert_no_orders()

    def test_legacy_unknown_orders_allow_transfer_without_new_orders(self):
        legacy = fixtures.seed_legacy_pending(self.store)
        self.wallet("long", 26000)
        self.wallet("short", 24000)
        with patch.object(MarginBalancer, "_paper", wraps=MarginBalancer(self.engine)._paper) as transfers:
            for index in range(3):
                state = self.tick()
                if index == 0:
                    self.assert_transferred(state)
                self.assertEqual(state["phase"], "attention", state)
                self.assertEqual(state["reason"], LEGACY_ORDERS_REASON)
                self.assertEqual(state["pending"], legacy["pending"])
                self.wall += 1
            self.assertEqual(transfers.call_count, 1)
        self.assertEqual(self.store.get("pair_margin:gold")["last_transfer"]["status"], "paper_confirmed")
        self.assert_no_orders()

    def test_paused_pair_blocks_funds_and_stale_runtime_identity_needs_attention(self):
        self.wallet("long", 26000)
        self.wallet("short", 24000)
        self.pair = self.store.save_pair({**self.pair, "enabled": False})
        self.assertEqual(self.tick()["phase"], "paused")
        self.assertEqual(self.brokers["long"].state["wallet"], "26000")
        self.pair = self.store.save_pair({**self.pair, "enabled": True})
        state = self.store.get("pair_runtime:gold")
        state["identities"]["long"]["env_prefix"] = "DIFFERENT_BINDING"
        self.store.put("pair_runtime:gold", state)
        state = self.tick()
        self.assertEqual(state["phase"], "attention")
        self.assertEqual(dec(self.brokers["long"].state["wallet"]), 25000)
        self.assertEqual(state["margin"]["status"], "paper_confirmed")
        self.assert_no_orders()

    def test_margin_does_not_consult_or_adopt_archived_strategy_orders(self):
        watch = {"batches": [{"id": "archived", "symbol": fixtures.SYMBOL, "legs": []}]}
        self.store.put("pair_runtime:gold", {"recovery_watch": watch})
        self.wallet("long", 26000)
        self.wallet("short", 24000)
        state = self.tick()
        self.assert_transferred(state)
        self.assertEqual(state["phase"], "attention", state)
        self.assertEqual(state["reason"], LEGACY_ORDERS_REASON)
        self.assertEqual(state["recovery_watch"], watch)
        self.assert_no_orders()

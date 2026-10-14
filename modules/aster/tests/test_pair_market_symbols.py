"""Pair-only markets share data without expanding single-account strategies."""
from copy import deepcopy
import json
import time
from unittest import TestCase
from unittest.mock import Mock, patch

from tests.helpers import Fixture, account
from trading.capacity_relay_server import RelayConfig
from trading.engine import DEFAULT_POLICY, Engine, FAST_CAPACITY_POLL_INTERVAL, validate_account
from trading.exchange import LiveBroker, MarketData
from trading.models import MARKET_SYMBOLS, SYMBOLS, TradingError, dec
from trading.pairing import validate_pair
from trading.paper import PaperBroker


SILVER = "XAGUSD1"
GOLD = "XAUUSD1"


class PairMarketSymbolsTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.engine = Engine(self.f.store, market=self.f.market)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})

    def pair(self, *, cycle=False, mode="paper"):
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid, mode), "enabled": False})
        value = validate_pair({"id": "silver", "name": "白银配对", "symbol": SILVER,
            "long_account_id": "test", "short_account_id": "second", "enabled": True,
            "cycle": {"enabled": cycle}, "ordinary": {"enabled": not cycle}})
        return self.f.store.save_pair(value, create=True)

    def test_active_pair_requires_its_market_even_when_original_monitors_are_all_on(self):
        self.assertEqual(self.engine.capacity_market_symbols(), {GOLD})
        self.assertNotIn(SILVER, DEFAULT_POLICY["symbols"])
        self.pair()
        self.assertEqual(self.engine.required_monitoring_symbols(), {SILVER: ["白银配对"]})
        self.assertEqual(self.engine.monitored_market_symbols(), set(MARKET_SYMBOLS))
        self.assertEqual(self.engine.capacity_market_symbols(), {GOLD, SILVER})
        self.f.store.edit_monitoring({"monitoring_enabled": False})
        self.assertEqual(self.engine.monitored_market_symbols(), {SILVER})
        self.assertEqual(self.engine.capacity_market_symbols(), {SILVER})
        self.assertEqual(DEFAULT_POLICY["symbols"], list(SYMBOLS))
        with self.assertRaises(TradingError):
            validate_account({**account(), "policy": {**DEFAULT_POLICY, "symbols": [SILVER]}})

    def test_paused_pair_with_pending_work_keeps_silver_data(self):
        pair = self.pair()
        self.f.store.save_pair({**pair, "enabled": False})
        self.f.store.put("pair_runtime:silver", {"pending": {"symbol": SILVER}})
        self.assertIn(SILVER, self.engine.capacity_market_symbols())
        self.assertIn(SILVER, self.engine.monitored_market_symbols())

    def test_pair_ordinary_and_cycle_capacity_targets_use_selected_market_and_leverage(self):
        pair = self.pair()
        self.assertEqual(self.engine.fast_capacity_targets(self.f.store.accounts()), {SILVER: {5, 10, 20}})
        pair = {**pair, "ordinary": {**pair["ordinary"], "enabled": False},
                "cycle": {**pair["cycle"], "enabled": True}}
        self.f.store.save_pair(pair)
        self.f.store.put("pair_runtime:silver", {"snapshots": {
            side: {"timestamp": time.time(), "positions": [
                {"symbol": GOLD, "leverage": 20}, {"symbol": SILVER, "leverage": 7}]}
            for side in ("long", "short")}})
        self.assertEqual(self.engine.fast_capacity_targets(self.f.store.accounts()), {SILVER: {7}})
        intervals, _, enabled = self.engine.capacity_poll_schedule({SILVER: {7}})
        self.assertTrue(enabled)
        self.assertEqual(intervals[SILVER], FAST_CAPACITY_POLL_INTERVAL)

    def test_live_cycle_capacity_reads_silver_hot_leverage(self):
        self.pair(cycle=True, mode="live")
        brokers = [Mock(spec=LiveBroker), Mock(spec=LiveBroker)]
        for aid, broker in zip(("test", "second"), brokers):
            broker.cycle_cache = Mock()
            broker.cycle_cache.current_leverage.return_value = 7
            self.engine.brokers[aid] = broker
        with patch.object(self.engine, "live_allowed", return_value=True):
            self.assertEqual(self.engine.fast_capacity_targets(self.f.store.accounts()), {SILVER: {7}})
        for broker in brokers:
            broker.cycle_cache.current_leverage.assert_called_once_with(SILVER)

    def test_pair_private_stream_and_public_signals_follow_silver(self):
        self.pair(mode="live")
        broker = Mock(spec=LiveBroker)
        with patch.object(self.engine, "live_allowed", return_value=True), \
                patch.object(self.engine, "broker", return_value=broker):
            self.assertEqual(self.engine.poll_cycle_hot_data("test"), 30)
        self.assertEqual(broker.start_cycle_hot_data.call_args.args, ([SILVER],))
        self.engine.on_cycle_market_update(SILVER, "depth", time.time(), time.monotonic())
        self.assertTrue(self.engine.fresh_cycle_signal(self.engine.cycle_market_updates[SILVER]))

    def test_pair_cycle_capacity_explicitly_accepts_silver_but_account_default_does_not(self):
        pair = self.pair(cycle=True)
        self.engine.markets[SILVER] = {"status": "ok", "checked_at": time.time(), "capacities": {"5": "1000000"}}
        with self.assertRaises(TradingError):
            self.engine.require_cycle_open_capacity(pair["cycle"], 5)
        self.assertEqual(self.engine.require_cycle_open_capacity(pair["cycle"], 5, symbols=MARKET_SYMBOLS), dec("1000000"))

    def test_capacity_failure_is_isolated_and_silver_does_not_report_a_notification_error(self):
        self.pair()
        original = self.f.market.capacities

        def capacities(symbol, levels):
            if symbol == GOLD:
                raise TradingError("gold feed unavailable")
            return original(symbol, levels)

        with patch.object(self.f.market, "capacities", side_effect=capacities):
            self.engine.poll_market(SILVER)
            self.engine.poll_market(GOLD)
        self.assertEqual(self.engine.capacities(SILVER)[5], dec("156800"))
        with self.assertRaises(TradingError):
            self.engine.capacities(GOLD)
        self.engine.demo = False
        with patch.object(self.engine, "capacity_alert_config", return_value=None):
            self.engine.observe_capacity_alerts(SILVER, {5: dec(1)}, time.time())
        self.assertNotIn(SILVER, self.engine.capacity_notification_errors)
        self.f.store.edit_monitoring({"monitor": False}, symbol=SILVER)
        self.assertIn(SILVER, self.engine.required_monitoring_symbols())

    def test_legacy_paper_ledger_upgrade_is_idempotent_and_preserves_receipts_and_balances(self):
        old = deepcopy(self.f.broker.state)
        old["wallet"] = "23456.789"
        old["orders"]["receipt"] = {"symbol": GOLD, "status": "FILLED"}
        old["positions"][GOLD + ":LONG"] = {"qty": "2", "entry": "4100"}
        old["leverages"].pop(SILVER)
        for side in ("LONG", "SHORT"):
            old["positions"].pop(SILVER + ":" + side)
        self.f.store.put("paper:test", old)
        upgraded = PaperBroker("test", self.f.market, self.f.store, seed=True)
        self.assertEqual(upgraded.state["wallet"], old["wallet"])
        self.assertEqual(upgraded.state["orders"], old["orders"])
        self.assertEqual(upgraded.state["positions"][GOLD + ":LONG"], old["positions"][GOLD + ":LONG"])
        for position in upgraded.snapshot([SILVER]).pair(SILVER):
            self.assertEqual(position.qty, 0)
            self.assertEqual(position.leverage, 5)
        with patch.object(self.f.store, "put", wraps=self.f.store.put) as save:
            upgraded.reload()
            reopened = PaperBroker("test", self.f.market, self.f.store)
        save.assert_not_called()
        self.assertEqual(reopened.state, upgraded.state)

    def test_empty_unselected_silver_needs_no_quote_but_selected_or_held_silver_does(self):
        original = self.f.market.book

        def quote(symbol):
            if symbol == SILVER:
                raise TradingError("silver feed unavailable")
            return original(symbol)

        with patch.object(self.f.market, "book", side_effect=quote):
            self.f.broker.snapshot([GOLD]).require_ready(GOLD)
            with self.assertRaisesRegex(TradingError, "silver feed"):
                self.f.broker.snapshot([SILVER])
            self.f.broker.state["positions"][SILVER + ":LONG"]["qty"] = "1"
            with self.assertRaisesRegex(TradingError, "silver feed"):
                self.f.broker.snapshot([GOLD])

    def test_demo_silver_can_fill_and_recover_a_thousand_notional_order(self):
        book = self.f.market.book(SILVER)
        self.assertGreaterEqual(book.bid * book.bid_qty, 1000)
        self.assertGreaterEqual(book.ask * book.ask_qty, 1000)
        bids, asks = self.f.market.depth(SILVER).sweeps
        self.assertGreaterEqual(min(bids.notional, asks.notional), 1000)
        receipt, = self.f.broker.submit([{"symbol": SILVER, "positionSide": "LONG", "side": "BUY",
            "type": "MARKET", "quantity": "19", "newClientOrderId": "silver-order"}])
        self.assertEqual(receipt["status"], "FILLED")
        reopened = PaperBroker("test", self.f.market, self.f.store)
        self.assertEqual(reopened.query(SILVER, "silver-order"), receipt)
        self.assertEqual(reopened.snapshot([SILVER]).pair(SILVER)[0].qty, 19)

    @staticmethod
    def exchange_row(symbol):
        return {"symbol": symbol, "status": "TRADING", "marginAsset": "USD1", "orderTypes": ["MARKET"],
            "filters": [{"filterType": "LOT_SIZE", "minQty": "0.01", "maxQty": "100000", "stepSize": "0.01"},
                        {"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                        {"filterType": "MIN_NOTIONAL", "notional": "5"}]}

    def test_rule_loading_and_stream_depth_support_silver_without_blocking_old_markets(self):
        api = Mock()
        market = MarketData(api=api)
        self.addCleanup(market.close_stream)
        self.assertIn(SILVER, market.stream.symbols)
        self.assertIn(SILVER, market.depth_stream.symbols)
        api.call.return_value = {"symbols": [self.exchange_row(symbol) for symbol in MARKET_SYMBOLS]}
        market.load_rules()
        self.assertEqual(market.rules[SILVER].step, dec("0.01"))
        silver = self.exchange_row(SILVER)
        silver["filters"] = "invalid"
        api.call.return_value = {"symbols": [*[self.exchange_row(symbol) for symbol in SYMBOLS], silver]}
        market.load_rules()
        self.assertEqual(set(market.rules), set(SYMBOLS))
        stream = market.depth_stream
        stream._connected = True
        stream._connection = 1
        now = int(time.time() * 1000)
        stream._handle_message(json.dumps({"stream": "xagusd1@depth@100ms", "data": {
            "e": "depthUpdate", "s": SILVER, "E": now, "T": now, "U": 10, "u": 12, "pu": 9,
            "b": [], "a": []}}))
        api.call.return_value = {"E": now, "T": now, "lastUpdateId": 12,
            "bids": [["52.31", "100"]], "asks": [["52.32", "100"]]}
        market.depth(SILVER).require_fresh()
        market.cycle_depth(SILVER).require_fresh()
        self.assertEqual(api.call.call_args.args[2]["symbol"], SILVER)

    def test_relay_default_includes_silver_and_explicit_configuration_is_preserved(self):
        env = {"ASTER_RELAY_TOKEN": "a" * 32}
        self.assertEqual(RelayConfig.from_env(env).symbols, (GOLD, SILVER))
        self.assertEqual(RelayConfig.from_env({**env, "ASTER_RELAY_SYMBOLS": GOLD}).symbols, (GOLD,))

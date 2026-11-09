"""Request counts and write boundaries using real brokers and offline ledgers."""
import time
from unittest import TestCase
from unittest.mock import patch

from tests import pair_fixtures as fixtures
from trading.exchange import PublicCapacitySample
from trading.models import TradingError, dec
from trading.pairing import validate_pair


class PairRequestEfficiencyTests(TestCase):
    setUp = fixtures.PairBudgetTests.setUp
    live_brokers = fixtures.PairBudgetTests.live_brokers

    def read_count(self):
        return sum(path == "/fapi/v3/accountWithJoinMargin"
                   for broker in self.brokers.values() for _, path, _ in broker.api.calls)

    def test_funds_only_minute_makes_no_private_position_or_mode_reads(self):
        wall, ticks = time.time(), time.monotonic()
        with patch("time.time", side_effect=lambda: wall), patch("time.monotonic", side_effect=lambda: ticks):
            self.live_brokers()
            # A running group always has funds management on; the balancer itself is stubbed.
            self.pair = self.store.save_pair(validate_pair({**self.pair, "margin": {"enabled": True}}))
            self.budget.configure_capacity_reserve(301)
            with self.budget.capacity_monitoring():
                self.budget.reserve(301)
            for index in range(30):
                if index == 10:
                    self.brokers["long"]._private_account_event("ACCOUNT_CONFIG_UPDATE")
                if index == 20:
                    self.pair = self.store.save_pair({**self.pair, "name": "新配置"})
                state = self.trader.tick(self.pair)
                self.assertEqual(state["phase"], "monitoring")
                self.assertIsNone(state["pending"])
                used = self.budget.snapshot()["used"]
                wall += 2
                ticks += 2
            # Pairs no longer plan orders: no account, position-mode or
            # multi-asset reads; only the independent public feed is spent.
            self.assertEqual([call for b in self.brokers.values() for call in b.api.calls], [])
            self.assertEqual(used, 301)

    def test_skipping_private_read_keeps_existing_margin_block_visible(self):
        self.live_brokers()
        self.pair["margin"]["enabled"] = True
        self.pair = self.store.save_pair(self.pair)
        with patch("trading.margin_balance.MarginBalancer.tick", return_value={
                "blocks_trading": True, "reason": "划转归属检查暂不可用"}):
            self.assertEqual(self.trader.tick(self.pair)["phase"], "margin_wait")
            state = self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 0)
        self.assertEqual(state["phase"], "margin_wait")
        self.assertEqual(state["reason"], "划转归属检查暂不可用")

    def hot_broker(self):
        self.live_brokers()
        self.store.save_account({**self.store.account("long"), "mode": "live"})
        patcher = patch.object(self.engine, "live_allowed", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        return self.brokers["long"]

    def test_pair_member_keeps_event_stream_without_hot_rest_reads(self):
        broker = self.hot_broker()
        with patch.object(broker, "start_private_stream") as stream:
            self.assertEqual(self.engine.poll_private_stream("long"), 30)
        stream.assert_called_once_with()
        self.assertFalse(broker.api.calls)

    def test_funds_runtime_and_legacy_orders_do_not_refresh_hot_data(self):
        broker = self.hot_broker()
        for pending in (None, {"id": "unresolved"}):
            with self.subTest(pending=pending):
                self.store.put("pair_runtime:gold", {"pending": pending})
                with patch.object(broker, "start_private_stream"):
                    self.engine.poll_private_stream("long")
        self.assertFalse(broker.api.calls)

    def test_engine_does_not_renew_shared_public_sample_timestamp(self):
        source_time = time.time() - 9
        sample = PublicCapacitySample({5: dec(100000)}, source_time)
        with patch.object(self.market, "capacities", return_value=sample):
            self.engine.poll_market("XAUUSD1")
        row = self.engine.markets["XAUUSD1"]
        self.assertEqual(row["checked_at"], source_time)
        self.assertEqual(row["capacity_checked_at"]["5"], source_time)
        with self.assertRaisesRegex(TradingError, "过期"):
            self.engine.capacities("XAUUSD1")

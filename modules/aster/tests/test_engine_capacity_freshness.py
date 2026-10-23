from dataclasses import replace
import os
import unittest
from unittest.mock import patch

from trading.cycle import DEFAULT_CYCLE
from trading.engine import Engine
from trading.models import TradingError, dec
from .helpers import Fixture


class CapacityFreshnessTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.now = 1000.0
        self.book = self.f.market.book("XAUUSD1")

    def test_capacity_request_latency_cannot_renew_cache_or_alert_freshness(self):
        def slow_capacity(*args):
            self.now += 9
            return {5: dec(20000)}

        with patch("trading.engine.time.time", side_effect=lambda: self.now), \
             patch.dict(os.environ, {"FEISHU_WEBHOOK_URL": "https://open.feishu.cn/open-apis/bot/v2/hook/test"}, clear=True), \
             patch.object(self.f.market, "capacities", side_effect=slow_capacity), \
             patch.object(self.f.market, "book", side_effect=lambda symbol: replace(self.book, timestamp=self.now)):
            self.engine.poll_market("XAUUSD1")
            with self.assertRaisesRegex(TradingError, "额度快照"):
                self.engine.capacities("XAUUSD1")
        self.assertEqual(self.engine.markets["XAUUSD1"]["checked_at"], 1000)
        self.assertEqual(self.f.store.pending_notifications(), 0)

    def test_slow_book_read_does_not_extend_capacity_lifetime(self):
        def slow_book(symbol):
            self.now += 7
            return replace(self.book, timestamp=self.now)

        with patch("trading.engine.time.time", side_effect=lambda: self.now), \
             patch.object(self.f.market, "capacities", return_value={5: dec(20000)}), \
             patch.object(self.f.market, "book", side_effect=slow_book):
            self.engine.poll_market("XAUUSD1")
            self.engine.poll_book("XAUUSD1")
            self.assertEqual(self.engine.capacities("XAUUSD1"), {5: dec(20000)})
            self.now += 2
            with self.assertRaisesRegex(TradingError, "额度快照"):
                self.engine.capacities("XAUUSD1")

    def test_clock_rollback_cannot_keep_a_future_capacity_cache_usable(self):
        with patch("trading.engine.time.time", side_effect=lambda: self.now):
            self.engine.poll_market("XAUUSD1")
            self.now -= 2
            with self.assertRaisesRegex(TradingError, "额度快照"):
                self.engine.capacities("XAUUSD1")

    def test_missing_tier_time_blocks_ordinary_open_until_a_new_sample(self):
        self.engine.brokers["test"] = self.f.broker
        with patch("trading.engine.time.time", side_effect=lambda: self.now), \
             patch.object(self.f.market, "capacities", return_value={5: dec(500000)}):
            for stamps in (None, {}, {"10": self.now}, {"5": None}):
                with self.subTest(stamps=stamps), patch.object(self.f.broker, "submit") as submit:
                    self.engine.poll_market("XAUUSD1")
                    row = self.engine.markets["XAUUSD1"]
                    if stamps is None:
                        row.pop("capacity_checked_at")
                    else:
                        row["capacity_checked_at"] = stamps
                    self.assertEqual(self.engine.capacities("XAUUSD1"), {})
                    self.engine.tick_account("test")
                    submit.assert_not_called()
                    self.assertIsNone(self.f.store.intent("test"))
            self.engine.poll_market("XAUUSD1")
            with patch.object(self.f.broker, "submit", wraps=self.f.broker.submit) as submit:
                self.engine.tick_account("test")
                submit.assert_called_once()
            self.assertGreater(self.f.broker.snapshot(["XAUUSD1"]).pair("XAUUSD1")[0].qty, 0)

    def test_missing_tier_time_revokes_priority_and_availability(self):
        owners = self.f.store.accounts()
        values = {5: dec(500000)}
        with patch("trading.engine.time.time", side_effect=lambda: self.now):
            for stamps in (None, {}, {"10": self.now}, {"5": None}):
                with self.subTest(stamps=stamps):
                    self.engine.wake_capacity_accounts("XAUUSD1", values, self.now, owners,
                                                       capacity_checked_at={"5": self.now})
                    self.assertIn("XAUUSD1", self.engine.work("test").priority)
                    self.assertIsNotNone(self.engine.ordinary_capacity_observation(owners[0], "XAUUSD1", 5))
                    self.engine.wake_capacity_accounts("XAUUSD1", values, self.now, owners,
                                                       capacity_checked_at=stamps)
                    self.assertNotIn("XAUUSD1", self.engine.work("test").priority)
                    self.assertIsNone(self.engine.ordinary_capacity_observation(owners[0], "XAUUSD1", 5))

    def test_partial_sample_cannot_renew_other_tiers_for_ordinary_or_cycle_open(self):
        self.engine.brokers["test"] = self.f.broker
        self.engine.capacity_targets = {"XAUUSD1": {10}}
        self.engine.capacity_accounts = self.f.store.accounts()
        with patch("trading.engine.time.time", side_effect=lambda: self.now), \
             patch("trading.engine.time.monotonic", side_effect=lambda: self.now):
            with patch.object(self.f.market, "capacities", return_value={5: dec(500000), 10: dec(0)}):
                self.engine.poll_market("XAUUSD1")
            self.now += 9
            self.engine.capacity_full_checked["XAUUSD1"] = self.now
            with patch.object(self.f.market, "capacities", return_value={10: dec(0)}) as sample:
                self.engine.poll_market("XAUUSD1")
            sample.assert_called_once_with("XAUUSD1", {10})
            self.assertEqual(self.engine.markets["XAUUSD1"]["capacity_checked_at"], {"5": 1000, "10": 1009})
            self.assertEqual(self.engine.capacities("XAUUSD1"), {10: dec(0)})
            with self.assertRaises(TradingError):
                self.engine.require_cycle_open_capacity(DEFAULT_CYCLE, 5)
            with patch.object(self.f.broker, "submit") as submit:
                self.engine.tick_account("test")
                submit.assert_not_called()
            self.assertIsNone(self.f.store.intent("test"))

"""Request counts and write boundaries using real brokers and offline ledgers."""
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_budget as fixtures
from trading.exchange import PublicCapacitySample
from trading.models import TradingError, dec


class PairRequestEfficiencyTests(TestCase):
    setUp = fixtures.PairBudgetTests.setUp
    live_brokers = fixtures.PairBudgetTests.live_brokers

    def ordinary(self):
        self.live_brokers()
        self.pair["ordinary"]["enabled"] = True
        self.pair = self.store.save_pair(self.pair)
        patcher = patch.object(self.engine, "capacities", return_value={5: dec(0), 10: dec(0), 20: dec(0)})
        self.capacities = patcher.start()
        self.addCleanup(patcher.stop)

    def read_count(self):
        return sum(path == "/fapi/v3/accountWithJoinMargin"
                   for broker in self.brokers.values() for _, path, _ in broker.api.calls)

    def test_waiting_minute_fits_actual_execution_limit_with_public_feed(self):
        wall, ticks = time.time(), time.monotonic()
        with patch("time.time", side_effect=lambda: wall), patch("time.monotonic", side_effect=lambda: ticks):
            self.ordinary()
            self.budget.configure_capacity_reserve(301)
            with self.budget.capacity_monitoring():
                self.budget.reserve(301)
            for _ in range(30):
                state = self.trader.tick(self.pair)
                self.assertNotIn("请求预算", state["reason"])
                self.assertIsNone(state["pending"])
                used = self.budget.snapshot()["used"]
                wall += 2
                ticks += 2
            self.assertEqual(self.read_count(), 20)  # Ten rounds, not thirty.
            self.assertEqual(sum(path == fixtures.DUAL for b in self.brokers.values()
                                 for _, path, _ in b.api.calls), 2)
            self.assertEqual(sum(path == fixtures.MULTI for b in self.brokers.values()
                                 for _, path, _ in b.api.calls), 2)
            # Ten paired account/risk/tier reads (220), the initial dual and
            # multi-asset checks (120), and the independent public feed (301).
            # The existing 600-second multi-asset TTL needs no repeat this minute.
            self.assertEqual(used, 641)
            self.assertLess(used, self.budget.snapshot()["execution_limit"])
            self.assertTrue(all(method == "GET" for b in self.brokers.values() for method, _, _ in b.api.calls))

    def test_public_opportunity_forces_new_private_read_before_order_planning(self):
        self.ordinary()
        self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 2)
        self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 2)
        self.capacities.return_value = {5: dec(10000000), 10: dec(0), 20: dec(0)}
        with patch.object(self.trader, "_start") as submit:
            self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 4)
        submit.assert_called_once()

    def test_configuration_events_revoke_negative_observation_immediately(self):
        self.ordinary()
        self.trader.tick(self.pair)
        self.brokers["long"]._private_account_event("ACCOUNT_CONFIG_UPDATE")
        self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 4)
        self.assertEqual(sum(path == fixtures.DUAL for _, path, _ in self.brokers["long"].api.calls), 2)

    def test_pair_revision_and_margin_pending_cannot_reuse_wait(self):
        self.ordinary()
        self.trader.tick(self.pair)
        self.pair = self.store.save_pair({**self.pair, "name": "新配置"})
        self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 4)
        self.store.put("pair_margin:gold", {"pending": {"status": "unknown"}})
        # Base setup stubs all balance checks as nonblocking. This scheduler
        # case needs the unresolved-transfer result that its marker represents.
        with patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": True}) as balance:
            self.assertEqual(self.trader.tick(self.pair)["phase"], "margin_wait")
        balance.assert_called_once()
        self.assertEqual(self.read_count(), 4)  # Reconciliation has no snapshot consumer.
        self.store.put("pair_margin:gold", {})
        self.trader.tick(self.pair)  # The old negative observation was revoked.
        self.assertEqual(self.read_count(), 6)

    def test_skipping_private_read_keeps_existing_margin_block_visible(self):
        self.ordinary()
        self.pair["margin"]["enabled"] = True
        self.pair = self.store.save_pair(self.pair)
        with patch("trading.margin_balance.MarginBalancer.tick", return_value={
                "blocks_trading": True, "reason": "划转归属检查暂不可用"}):
            self.assertEqual(self.trader.tick(self.pair)["phase"], "margin_wait")
            state = self.trader.tick(self.pair)
        self.assertEqual(self.read_count(), 0)
        self.assertEqual(state["phase"], "margin_wait")
        self.assertEqual(state["reason"], "划转归属检查暂不可用")

    def test_account_event_does_not_postpone_existing_margin_deadline(self):
        self.ordinary()
        self.pair["margin"].update(enabled=True, check_interval_seconds=5)
        self.pair = self.store.save_pair(self.pair)
        wall, ticks = time.time(), time.monotonic()
        with patch("time.time", side_effect=lambda: wall), patch("time.monotonic", side_effect=lambda: ticks):
            self.trader.tick(self.pair)
            self.store.put("pair_margin:gold", {"next_check_at": wall + 5})
            wall += 4
            ticks += 4
            self.brokers["long"]._private_account_event("ACCOUNT_UPDATE")
            self.trader.tick(self.pair)
            self.assertEqual(self.read_count(), 4)
            wall += 2
            ticks += 2
            self.trader.tick(self.pair)
            self.assertEqual(self.read_count(), 6)

    def hot_broker(self):
        self.live_brokers()
        self.store.save_account({**self.store.account("long"), "mode": "live"})
        patcher = patch.object(self.engine, "live_allowed", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        return self.brokers["long"]

    def test_ordinary_keeps_event_stream_without_unused_hot_rest_reads(self):
        broker = self.hot_broker()
        self.pair["ordinary"]["enabled"] = True
        self.store.save_pair(self.pair)
        with patch.object(broker, "start_private_stream") as stream:
            self.assertEqual(self.engine.poll_private_stream("long"), 30)
        stream.assert_called_once_with()
        self.assertFalse(broker.api.calls)

    def test_monitor_only_and_order_recovery_do_not_refresh_hot_data(self):
        broker = self.hot_broker()
        for pending in (None, {"id": "unresolved"}):
            with self.subTest(pending=pending):
                self.pair["ordinary"]["enabled"] = False
                self.pair = self.store.save_pair(self.pair)
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

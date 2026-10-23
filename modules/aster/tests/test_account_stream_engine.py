"""Private account streams follow paired live accounts and stay independent of trading."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tests.helpers import Fixture
from tests.scheduler_fixtures import _Future, _Harness
from trading.engine import Engine
from trading.exchange import LiveBroker


SYMBOL = "XAUUSD1"


class AccountStreamEngineTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.row = deepcopy(self.f.account)
        self.row.update(mode="live")
        self.f.store.save_account(self.row)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.live_allowed = Mock(return_value=True)
        self.api = SimpleNamespace(budget=None, close=Mock(),
            call=Mock(side_effect=AssertionError("Engine test reached a live API")))
        self.broker = LiveBroker({}, self.f.market, api=self.api)
        self.engine.brokers["test"] = self.broker
        self.broker.start_private_stream = Mock()

    def attach_stream(self):
        stream = Mock()
        self.broker.private_stream = stream
        self.broker._private_stream_token = object()
        return stream

    def live_harness(self):
        harness = _Harness(self.f)
        row = self.f.store.account("test")
        row["mode"] = "live"
        self.f.store.save_account(row)
        harness.engine.live_allowed = Mock(return_value=True)
        broker = Mock(spec=LiveBroker)
        broker.api = SimpleNamespace(budget=None, call=Mock(side_effect=AssertionError("scheduler made HTTP")))
        harness.engine.brokers["test"] = broker
        return harness, broker

    def test_paired_live_account_starts_private_stream_without_rest(self):
        pair = {"id": "silver", "symbol": "XAGUSD1", "enabled": True}
        with patch.object(self.f.store, "pair_for_account", return_value=pair):
            self.assertEqual(self.engine.poll_private_stream("test"), 30)
        self.broker.start_private_stream.assert_called_once_with()
        self.api.call.assert_not_called()

    def test_inactive_accounts_stop_existing_stream_without_creating_a_broker(self):
        pair = {"id": "gold", "symbol": SYMBOL, "enabled": True}
        for state in ("unpaired", "enabled_unpaired", "paper", "not_authorized", "shutdown", "missing"):
            with self.subTest(state=state):
                row = deepcopy(self.row)
                paired = None if state in ("unpaired", "enabled_unpaired") else pair
                if state == "enabled_unpaired":
                    row["enabled"] = True
                elif state == "paper":
                    row["mode"] = "paper"
                self.f.store.save_account(row)
                self.engine.live_allowed.return_value = state != "not_authorized"
                self.engine.shutdown.clear()
                if state == "shutdown":
                    self.engine.shutdown.set()
                self.engine.brokers.clear()
                with patch.object(self.engine, "broker", side_effect=AssertionError("inactive account created a broker")), \
                     patch.object(self.f.store, "account", return_value=None if state == "missing" else row), \
                     patch.object(self.f.store, "pair_for_account", return_value=paired):
                    self.assertEqual(self.engine.poll_private_stream("test"), 30)
                    self.engine.brokers["test"] = self.broker
                    stream = self.attach_stream()
                    generation = self.broker._snapshot_generation
                    self.assertEqual(self.engine.poll_private_stream("test"), 30)
                    stream.close.assert_called_once_with()
                    self.assertIsNone(self.broker.private_stream)
                    self.assertGreater(self.broker._snapshot_generation, generation)
                self.broker.start_private_stream.assert_not_called()
        self.api.call.assert_not_called()

    def test_unexpected_background_worker_failure_retains_backoff_across_repeated_wakes(self):
        harness, broker = self.live_harness()
        attempts = []

        def failed_worker(aid):
            attempts.append(harness.ticks)
            return _Future(error=RuntimeError("unexpected background failure"))

        def control(step):
            if step < 5:
                self.assertEqual(attempts, [100])
                # Consume the failed future at time 100 before advancing time.
                harness.ticks = {1: 100, 2: 101, 3: 129.999, 4: 130}[step]
                if step >= 2:
                    self.assertEqual(harness.engine.work("test").stream_backoff, 130)
                for _ in range(20):
                    harness.engine.wake_private_stream("test")
            else:
                self.assertEqual(attempts, [100, 130])
                harness.engine.shutdown.set()

        with patch.object(harness.engine, "poll_private_stream", side_effect=failed_worker), \
             self.assertLogs("aster.trading", level="ERROR") as logs:
            harness.run(control)
        self.assertEqual(attempts, [100, 130])
        self.assertEqual(harness.iteration, 5)
        self.assertTrue(any("private-stream:test" in entry for entry in logs.output))
        broker.api.call.assert_not_called()

    def test_unpaired_stream_shutdown_does_not_schedule_immediate_repeat_polling(self):
        harness, _ = self.live_harness()
        harness.engine.brokers["test"] = self.broker
        stream = self.attach_stream()
        attempts = []
        original_poll = harness.engine.poll_private_stream

        def poll(aid):
            attempts.append(harness.ticks)
            return original_poll(aid)

        def control(step):
            if step < 5:
                self.assertEqual(attempts, [100])
                harness.ticks = {1: 100, 2: 101, 3: 129.999, 4: 130}[step]
            else:
                self.assertEqual(attempts, [100, 130])
                harness.engine.shutdown.set()

        with patch.object(harness.engine, "poll_private_stream", side_effect=poll):
            harness.run(control)
        self.assertEqual(attempts, [100, 130])
        stream.close.assert_called_once_with()
        self.broker.start_private_stream.assert_not_called()
        self.api.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()

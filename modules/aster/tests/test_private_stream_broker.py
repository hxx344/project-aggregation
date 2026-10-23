"""Private account stream lifecycle and account writes revoke ordinary snapshot reads."""
from concurrent.futures import ThreadPoolExecutor
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from trading.exchange import ExchangeError, LiveBroker
from trading.models import TradingError
from trading.paper import PAPER_BRACKETS
from .account_fixtures import ACCOUNT, BRACKET, RISK, SYMBOL, LocalQuoteMarket, join_margin_responses, risk_row
from .test_exchange_hardening import FixtureAPI


class PrivateStreamBrokerTests(unittest.TestCase):
    def make_broker(self):
        responses = join_margin_responses()
        responses["/fapi/v3/positionSide/dual"] = {"dualSidePosition": True}
        responses[RISK] = [risk_row(row) for row in responses[ACCOUNT]["positions"]]
        responses[BRACKET] = {"symbol": SYMBOL, "brackets": PAPER_BRACKETS}
        api = FixtureAPI(responses)
        api.close = Mock()
        return LiveBroker({}, LocalQuoteMarket(), api=api), api

    def test_private_event_revokes_ordinary_leverage_authority(self):
        broker, _ = self.make_broker()
        snapshot = broker.snapshot([SYMBOL], fresh_modes=True)
        self.assertIs(broker.leverage_snapshot[0], snapshot)
        broker.require_snapshot_current(snapshot)
        broker._private_account_event("ACCOUNT_UPDATE")
        self.assertIsNone(broker.leverage_snapshot)
        with self.assertRaises(TradingError):
            broker.require_snapshot_current(snapshot)

    def test_write_revokes_reads_before_send_and_reads_started_during_write(self):
        broker, api = self.make_broker()
        before = broker.snapshot([SYMBOL])
        entered, release = threading.Event(), threading.Event()
        original = api.call
        def call(method, path, *args, **kwargs):
            if method == "POST":
                with self.assertRaises(TradingError):
                    broker.require_snapshot_current(before)
                entered.set()
                self.assertTrue(release.wait(3))
                return {"orderId": 1}
            return original(method, path, *args, **kwargs)
        api.call = call
        with ThreadPoolExecutor(max_workers=1) as pool:
            write = pool.submit(broker.submit, [{"symbol": SYMBOL}])
            self.assertTrue(entered.wait(3))
            try:
                during = broker.snapshot([SYMBOL])
            finally:
                release.set()
            self.assertEqual(write.result(timeout=3), [{"orderId": 1}])
        with self.assertRaises(TradingError):
            broker.require_snapshot_current(during)

    def test_cancel_and_failed_write_revoke_reads_without_retrying(self):
        broker, api = self.make_broker()
        snapshot = broker.snapshot([SYMBOL])
        def cancel(method, path, *args, **kwargs):
            self.assertEqual(method, "DELETE")
            with self.assertRaises(TradingError):
                broker.require_snapshot_current(snapshot)
            return {"status": "CANCELED"}
        with patch.object(api, "call", side_effect=cancel):
            self.assertEqual(broker.cancel(SYMBOL, "test-order"), {"status": "CANCELED"})
        snapshot = broker.snapshot([SYMBOL])
        error = ExchangeError("mock rejection")
        with patch.object(api, "call", side_effect=error) as rejected:
            with self.assertRaises(ExchangeError) as caught:
                broker.submit([{"symbol": SYMBOL}])
        self.assertIs(caught.exception, error)
        rejected.assert_called_once()
        with self.assertRaises(TradingError):
            broker.require_snapshot_current(snapshot)

    def test_stop_revokes_reads_but_allows_a_new_stream_without_closing_api(self):
        broker, api = self.make_broker()
        streams = [Mock(), Mock()]
        with patch("trading.exchange.PrivateAccountStream", side_effect=streams) as factory:
            broker.start_private_stream()
            snapshot = broker.snapshot([SYMBOL])
            broker.stop_private_stream()
            with self.assertRaises(TradingError):
                broker.require_snapshot_current(snapshot)
            self.assertIsNone(broker.private_stream)
            api.close.assert_not_called()
            broker.start_private_stream()
        self.assertEqual(factory.call_count, 2)
        streams[0].close.assert_called_once()
        self.assertIs(broker.private_stream, streams[1])

    def test_start_uses_one_stream_and_close_stops_it_before_api(self):
        broker, api = self.make_broker()
        order = []
        api.close.side_effect = lambda: order.append("api")
        stream = Mock()
        stream.close.side_effect = lambda: order.append("stream")
        with patch("trading.exchange.PrivateAccountStream", return_value=stream) as factory:
            broker.start_private_stream()
            broker.start_private_stream()
        factory.assert_called_once()
        self.assertEqual(api.calls, [])
        broker.close()
        self.assertEqual(order, ["stream", "api"])
        with self.assertRaises(TradingError):
            broker.start_private_stream()

    def test_restarted_private_stream_ignores_previous_stream_callbacks(self):
        broker, api = self.make_broker()
        streams = []
        def make_stream(api, *, on_state, on_event, on_payload=None):
            stream = SimpleNamespace(on_state=on_state, on_event=on_event, on_payload=on_payload,
                start=Mock(side_effect=lambda: on_state(True)),
                close=Mock(side_effect=lambda: on_state(False)))
            streams.append(stream)
            return stream
        with patch("trading.exchange.PrivateAccountStream", side_effect=make_stream):
            broker.start_private_stream()
            broker.stop_private_stream()
            broker.start_private_stream()
        snapshot = broker.snapshot([SYMBOL])
        api.calls.clear()
        streams[0].on_state(False)
        streams[0].on_state(True)
        streams[0].on_event("ACCOUNT_UPDATE")
        streams[0].on_event("ACCOUNT_CONFIG_UPDATE")
        broker.require_snapshot_current(snapshot)
        self.assertEqual(api.calls, [])
        streams[1].on_event("ACCOUNT_UPDATE")
        with self.assertRaises(TradingError):
            broker.require_snapshot_current(snapshot)


if __name__ == "__main__":
    unittest.main()

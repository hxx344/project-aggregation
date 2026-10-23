"""Exchange direction times survive pair reads, including explicit flat rows."""
import time
from unittest import TestCase

from tests.test_cycle_account_snapshot import cycle_account_responses, LocalQuoteMarket, ACCOUNT
from tests.test_exchange_hardening import FixtureAPI, account_responses
from trading.exchange import LiveBroker
from trading.models import TradingError
from trading.paper import DemoMarket


class PairPositionTimestampTests(TestCase):
    def test_risk_snapshot_preserves_each_flat_direction_time(self):
        responses = account_responses()
        stamps = [int(time.time() * 1000) - 2000, int(time.time() * 1000) - 1000]
        for source in ("/fapi/v3/positionRisk", "/fapi/v3/accountWithJoinMargin"):
            rows = responses[source] if source.endswith("positionRisk") else responses[source]["positions"]
            for row, stamp in zip(rows, stamps):
                row.update(positionAmt="0", entryPrice="0", updateTime=stamp)
        broker = LiveBroker({}, DemoMarket(), api=FixtureAPI(responses))
        positions = broker.snapshot(["XAUUSD1"]).pair("XAUUSD1")
        self.assertEqual([p.update_time for p in positions], stamps)
        self.assertEqual([p.qty for p in positions], [0, 0])

    def test_omitted_risk_flat_direction_retains_account_source_time(self):
        responses = account_responses()
        stamps = [int(time.time() * 1000) - 2000, int(time.time() * 1000) - 1000]
        responses["/fapi/v3/positionRisk"] = []
        for row, stamp in zip(responses[ACCOUNT]["positions"], stamps):
            row.update(positionAmt="0", entryPrice="0", updateTime=stamp)
        broker = LiveBroker({}, DemoMarket(), api=FixtureAPI(responses))
        self.assertEqual([p.update_time for p in broker.snapshot(["XAUUSD1"]).pair("XAUUSD1")], stamps)

    def test_account_cycle_snapshot_preserves_direction_times_without_risk_read(self):
        responses = cycle_account_responses()
        stamps = [int(time.time() * 1000) - 2000, int(time.time() * 1000) - 1000]
        for row, stamp in zip(responses[ACCOUNT]["positions"], stamps):
            row["updateTime"] = stamp
        api = FixtureAPI(responses)
        broker = LiveBroker({}, LocalQuoteMarket(), api=api)
        self.assertEqual([p.update_time for p in broker.cycle_snapshot(["XAUUSD1"]).pair("XAUUSD1")], stamps)
        self.assertNotIn("/fapi/v3/positionRisk", [call[1] for call in api.calls])

    def test_missing_time_is_not_replaced_by_request_or_account_time(self):
        responses = account_responses()
        for row in responses[ACCOUNT]["positions"]:
            row["updateTime"] = int(time.time() * 1000)
        broker = LiveBroker({}, DemoMarket(), api=FixtureAPI(responses))
        self.assertEqual([p.update_time for p in broker.snapshot(["XAUUSD1"]).pair("XAUUSD1")], [None, None])

    def test_invalid_or_future_position_times_are_rejected(self):
        for stamp in (True, -1, "1.5", "NaN", int(time.time() * 1000) + 60000):
            with self.subTest(stamp=stamp):
                responses = account_responses()
                responses["/fapi/v3/positionRisk"][0]["updateTime"] = stamp
                broker = LiveBroker({}, DemoMarket(), api=FixtureAPI(responses))
                with self.assertRaises(TradingError):
                    broker.snapshot(["XAUUSD1"])

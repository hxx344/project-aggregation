from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

import httpx

from trading.exchange import API, MarketData, RateBudget
from trading.listings import ListingMonitor
from trading.models import TradingError
from trading.store import Store
from tests.test_listings import brackets, detail, oi, symbol


class CapacityNotificationSampleTests(unittest.TestCase):
    def read(self, caps, remaining, leverage):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json=caps if request.method == "POST" else remaining)

        api = API(transport=httpx.MockTransport(handler), budget=RateBudget())
        self.addCleanup(api.close)
        result = MarketData(api).listing_detail("BTCUSD1", alert_leverage=leverage)
        self.assertEqual([request.method for request in requests], ["POST", "GET"])
        self.assertEqual(api.budget.snapshot()["used"], 2)
        return result

    def test_custom_integer_tier_uses_exact_oi_and_its_own_cap(self):
        caps = brackets()
        caps["data"]["brackets"][0]["riskBrackets"] = [
            {"minOpenPosLeverage": 1, "maxOpenPosLeverage": 25, "bracketNotionalCap": "80"},
            {"minOpenPosLeverage": 26, "maxOpenPosLeverage": 200, "bracketNotionalCap": "10"},
        ]
        remaining = oi(remaining="2")
        remaining["data"]["leverageOiRemainingMap"].update({"10": "7", "20": "6", "25": "99", "50": "5"})
        result = self.read(caps, remaining, 25)
        self.assertEqual(result["capacity"], "2")
        self.assertEqual(result["tier_capacities"], {"10": "7", "20": "6", "50": "5"})
        sample = result["capacity_alert_sample"]
        self.assertEqual((sample["requested_leverage"], sample["leverage"], sample["capacity"]), (25, 25, "80"))
        self.assertEqual((sample["remaining"], sample["bracket_cap"]), ("99", "80"))
        self.assertIsNone(sample["error"])
        self.assertEqual(sample["checked_at"], result["tier_checked_at"])
        self.assertEqual(sample["brackets_checked_at"], result["tier_brackets_checked_at"])

    def test_missing_maximum_oi_does_not_block_custom_tier(self):
        remaining = oi(leverage="20", remaining="2.123456789123456789")
        result = self.read(brackets(), remaining, 20)
        self.assertTrue(result["error"])
        self.assertIsNone(result["capacity"])
        self.assertEqual(result["capacity_alert_sample"]["capacity"], "2.123456789123456789")
        self.assertIsNone(result["capacity_alert_sample"]["error"])

    def test_missing_custom_tier_is_unknown_without_affecting_valid_maximum(self):
        remaining = oi(remaining="8")
        remaining["data"]["leverageOiRemainingMap"].update({"19": "50", "21": "60"})
        result = self.read(brackets(), remaining, 20)
        self.assertEqual(result["capacity"], "8")
        self.assertIsNone(result["error"])
        sample = result["capacity_alert_sample"]
        self.assertEqual(sample["requested_leverage"], 20)
        self.assertIsNone(sample["capacity"])
        self.assertTrue(sample["error"])
        self.assertIsNotNone(sample["checked_at"])

    def test_maximum_mode_has_distinct_identity_and_real_zero(self):
        result = self.read(brackets(), oi(remaining="0"), None)
        sample = result["capacity_alert_sample"]
        self.assertIsNone(sample["requested_leverage"])
        self.assertEqual((sample["leverage"], sample["capacity"]), (200, "0"))
        self.assertIsNone(sample["error"])

    def test_invalid_direct_leverage_never_requests_public_data(self):
        handler = Mock(return_value=httpx.Response(500))
        api = API(transport=httpx.MockTransport(handler))
        self.addCleanup(api.close)
        market = MarketData(api)
        for value in (True, 0, 10001, 20.5, "20"):
            with self.subTest(value=value), self.assertRaises(TradingError):
                market.listing_detail("BTCUSD1", alert_leverage=value)
        handler.assert_not_called()


class CapacityNotificationPollingTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.market = Mock()
        self.market.listing_symbols.return_value = {"symbols": [symbol()]}
        self.market.listing_detail.return_value = detail()
        self.monitor = ListingMonitor(self.store, self.market, threading.Event())
        self.poll()

    def poll(self):
        self.monitor.detail_due.clear()
        self.monitor.poll()
        return self.store.get("usd1_listings")["rows"]["BTCUSD1"]

    def test_per_symbol_selection_is_passed_to_the_same_detail_read(self):
        self.store.edit_monitoring({"listing_capacity_leverage": 25, "listing_capacity_threshold": "5000"}, symbol="BTCUSD1")
        self.poll()
        self.market.listing_detail.assert_called_with("BTCUSD1", alert_leverage=25)
        self.store.edit_monitoring({"listing_capacity_leverage": None}, symbol="BTCUSD1")
        self.poll()
        self.market.listing_detail.assert_called_with("BTCUSD1")

    def test_transport_failure_preserves_sample_identity_values_and_source_times(self):
        sample = {"requested_leverage": 20, "leverage": 20, "capacity": "12", "remaining": "12",
                  "bracket_cap": "100", "checked_at": 100, "brackets_checked_at": 90, "error": None}
        self.market.listing_detail.return_value = detail(capacity_alert_sample=sample)
        self.poll()
        self.market.listing_detail.return_value = detail(None, capacity_alert_sample={
            "requested_leverage": 50, "leverage": 50, "capacity": None, "checked_at": None,
            "brackets_checked_at": None, "error": "read failed"})
        retained = self.poll()["capacity_alert_sample"]
        self.assertEqual(retained, {**sample, "error": "read failed"})
        self.market.listing_detail.side_effect = TradingError("untrusted remote details")
        retained = self.poll()["capacity_alert_sample"]
        self.assertEqual({**retained, "error": None}, sample)
        self.assertNotIn("untrusted", retained["error"])

    def test_valid_read_with_missing_tier_replaces_old_sample_instead_of_reusing_it(self):
        self.market.listing_detail.return_value = detail(capacity_alert_sample={
            "requested_leverage": 20, "leverage": 20, "capacity": "12", "remaining": "12",
            "bracket_cap": "100", "checked_at": 100, "brackets_checked_at": 90, "error": None})
        self.poll()
        missing = {"requested_leverage": 50, "leverage": 50, "capacity": None, "remaining": None,
                   "bracket_cap": None, "checked_at": 200, "brackets_checked_at": 180, "error": "tier missing"}
        self.market.listing_detail.return_value = detail(capacity_alert_sample=missing)
        self.assertEqual(self.poll()["capacity_alert_sample"], missing)

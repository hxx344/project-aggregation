import unittest
from datetime import datetime, timedelta, timezone

from app.models import Position
from app.position_greeks import summarize_position_greeks, ticker_greeks

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


def position(symbol, side, size):
    return Position(symbol=symbol, side=side, size=size, avg_price=100, mark_price=100, unrealised_pnl=0, source="bybit")


def summary(positions, greeks, *, age=5, available=True):
    return summarize_position_greeks(positions, greeks, market_updated_at=NOW - timedelta(seconds=age),
                                     positions_available=available, stale_seconds=30, now=NOW)


FULL = {"delta": 0.2, "gamma": 0.00002, "vega": 40.0, "theta": -55.0}


class PositionGreeksTests(unittest.TestCase):
    def test_ticker_fields_parse_and_missing_values_stay_unknown(self):
        self.assertEqual(ticker_greeks({"delta": "0.25", "gamma": "0.00001", "vega": "12.5", "theta": "-3"}),
                         {"delta": 0.25, "gamma": 0.00001, "vega": 12.5, "theta": -3.0})
        self.assertEqual(ticker_greeks({"delta": "", "gamma": None, "vega": "NaN", "theta": "x"}),
                         {"delta": None, "gamma": None, "vega": None, "theta": None})
        self.assertEqual(ticker_greeks({"delta": "0"})["delta"], 0.0)

    def test_buy_adds_and_sell_subtracts_by_quantity(self):
        result = summary([position("C1", "Buy", 2), position("P1", "Sell", 0.5)],
                         {"C1": FULL, "P1": {"delta": -0.3, "gamma": 0.00004, "vega": 30.0, "theta": -20.0}})
        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["stale"])
        totals = result["totals"]
        self.assertAlmostEqual(totals["delta"], 2 * 0.2 - 0.5 * -0.3)
        self.assertAlmostEqual(totals["gamma"], 2 * 0.00002 - 0.5 * 0.00004)
        self.assertAlmostEqual(totals["vega"], 80 - 15)
        self.assertAlmostEqual(totals["theta"], -110 + 10)
        self.assertEqual(result["units"]["delta"], "BTC")

    def test_a_leg_missing_one_greek_blanks_only_that_total(self):
        result = summary([position("C1", "Buy", 1), position("P1", "Sell", 1)],
                         {"C1": FULL, "P1": {**FULL, "vega": None}})
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(result["totals"]["vega"])
        self.assertEqual(result["missing"]["vega"], ["P1"])
        self.assertAlmostEqual(result["totals"]["delta"], 0.0)

    def test_unknown_symbol_or_side_is_never_summed_as_zero(self):
        result = summary([position("C1", "Buy", 1), position("X", "Buy", 1)], {"C1": FULL})
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(all(value is None for value in result["totals"].values()))
        result = summary([position("C1", "Unknown", 1)], {"C1": FULL})
        self.assertIsNone(result["totals"]["delta"])

    def test_empty_positions_report_empty_without_zero_totals(self):
        result = summary([position("C1", "Buy", 0)], {"C1": FULL})
        self.assertEqual(result["status"], "empty")
        self.assertEqual(result["position_count"], 0)
        self.assertTrue(all(value is None for value in result["totals"].values()))

    def test_unavailable_positions_never_report_confirmed_empty(self):
        for positions in ([], [position("C1", "Buy", 0)]):
            with self.subTest(positions=positions):
                result = summary(positions, {"C1": FULL}, available=False)
                self.assertEqual(result["status"], "unavailable")
                self.assertFalse(result["positions_available"])
                self.assertTrue(result["stale"])
                self.assertEqual(result["position_count"], 0)
                self.assertTrue(all(value is None for value in result["totals"].values()))

    def test_staleness_and_missing_market(self):
        self.assertTrue(summary([position("C1", "Buy", 1)], {"C1": FULL}, age=31)["stale"])
        self.assertTrue(summary([position("C1", "Buy", 1)], {"C1": FULL}, available=False)["stale"])
        result = summarize_position_greeks([position("C1", "Buy", 1)], {"C1": FULL}, market_updated_at=None,
                                           positions_available=True, stale_seconds=30, now=NOW)
        self.assertEqual(result["status"], "unavailable")
        self.assertTrue(result["stale"])
        self.assertIsNone(result["totals"]["delta"])


class DashboardGreeksTests(unittest.IsolatedAsyncioTestCase):
    async def test_account_dashboard_empty_snapshots_follow_read_availability_and_recovery(self):
        from unittest.mock import AsyncMock, patch
        from app.main import _build_account_dashboard
        from app.models import AccountHealth

        reads = [RuntimeError("positions offline"), [], RuntimeError("positions offline"), []]
        with patch("app.main.engine.load_positions", new=AsyncMock(side_effect=reads)), \
             patch("app.main.engine.positions", []), \
             patch("app.main.engine.load_account_health", new=AsyncMock(return_value=AccountHealth())), \
             patch("app.main.engine.load_recent_executions", new=AsyncMock(return_value=[])), \
             patch("app.main.engine.ticker_greeks", {}), patch("app.main.engine.chain_source", "bybit"), \
             patch("app.main.engine.chain_updated_at", datetime.now(timezone.utc)), \
             patch("app.main.engine.log") as log:
            for available, status in [(False, "unavailable"), (True, "empty"),
                                      (False, "unavailable"), (True, "empty")]:
                with self.subTest(available=available, status=status):
                    payload = await _build_account_dashboard()
                    self.assertEqual(payload["positions"], {"available": available, "items": []})
                    self.assertEqual(payload["greeks"]["status"], status)
                    self.assertEqual(payload["greeks"]["positions_available"], available)
                    self.assertEqual(payload["greeks"]["stale"], not available)
                    self.assertEqual(payload["greeks"]["position_count"], 0)
                    self.assertTrue(all(value is None for value in payload["greeks"]["totals"].values()))
            self.assertEqual(log.call_count, 2)

    async def test_account_dashboard_retains_nonempty_cache_after_read_failure(self):
        from unittest.mock import AsyncMock, patch
        from app.main import _build_account_dashboard
        from app.models import AccountHealth

        held = [position("C1", "Sell", 1)]
        with patch("app.main.engine.load_positions", new=AsyncMock(side_effect=[held, RuntimeError("positions offline")])), \
             patch("app.main.engine.positions", held), \
             patch("app.main.engine.load_account_health", new=AsyncMock(return_value=AccountHealth())), \
             patch("app.main.engine.load_recent_executions", new=AsyncMock(return_value=[])), \
             patch("app.main.engine.ticker_greeks", {"C1": {**FULL, "vega": None}}), \
             patch("app.main.engine.chain_source", "bybit"), \
             patch("app.main.engine.chain_updated_at", datetime.now(timezone.utc)), \
             patch("app.main.engine.log"):
            confirmed = await _build_account_dashboard()
            payload = await _build_account_dashboard()
        self.assertTrue(confirmed["positions"]["available"])
        self.assertFalse(confirmed["greeks"]["stale"])
        self.assertFalse(payload["positions"]["available"])
        self.assertEqual(payload["positions"]["items"], [held[0].model_dump(mode="json")])
        self.assertEqual(payload["greeks"]["totals"], confirmed["greeks"]["totals"])
        self.assertEqual(payload["greeks"]["status"], "partial")
        self.assertFalse(payload["greeks"]["positions_available"])
        self.assertTrue(payload["greeks"]["stale"])
        self.assertAlmostEqual(payload["greeks"]["totals"]["delta"], -0.2)
        self.assertIsNone(payload["greeks"]["totals"]["vega"])
        self.assertEqual(payload["greeks"]["missing"]["vega"], ["C1"])

    async def test_account_dashboard_includes_greeks_from_retained_ticker_snapshot(self):
        from unittest.mock import AsyncMock, patch
        from app.main import _build_account_dashboard
        from app.models import AccountHealth
        held = [position("C1", "Sell", 1)]
        with patch("app.main.engine.load_positions", new=AsyncMock(return_value=held)), \
             patch("app.main.engine.load_account_health", new=AsyncMock(return_value=AccountHealth())), \
             patch("app.main.engine.load_recent_executions", new=AsyncMock(return_value=[])), \
             patch("app.main.engine.ticker_greeks", {"C1": FULL}), patch("app.main.engine.chain_source", "bybit"), \
             patch("app.main.engine.chain_updated_at", datetime.now(timezone.utc)):
            payload = await _build_account_dashboard()
        self.assertEqual(payload["greeks"]["status"], "ok")
        self.assertAlmostEqual(payload["greeks"]["totals"]["delta"], -0.2)
        self.assertFalse(payload["greeks"]["stale"])


if __name__ == "__main__":
    unittest.main()

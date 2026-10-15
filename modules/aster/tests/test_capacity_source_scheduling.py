"""Mixed public sources preserve local budgets and independent relay cadence."""
import unittest
from unittest.mock import Mock, patch

from tests.helpers import Fixture, account
from trading.engine import Engine, PUBLIC_POLL_ALLOWANCE
from trading.exchange import API, ExchangeError, MarketData, RateBudget
from trading.models import dec


XAU, XAG, SPCX, CL = "XAUUSD1", "XAGUSD1", "SPCXUSD1", "CLUSD1"


class CapacitySourceSchedulingTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        owner = account("local", mode="live")
        owner["policy"].update(symbols=[SPCX, CL])
        self.f.store.save_account(owner)
        self.budget = RateBudget()
        self.api = API(budget=self.budget)
        self.addCleanup(self.api.close)
        self.market = MarketData(self.api, capacity_relay=Mock())
        self.engine = Engine(self.f.store, market=self.market)
        self.addCleanup(self.engine.dashboard_reports.close)

    def configure(self, symbols=(XAU, XAG, SPCX, CL)):
        targets = {symbol: {5} for symbol in symbols}
        intervals, brackets, enabled = self.engine.capacity_poll_schedule(targets, symbols)
        self.engine.capacity_targets = targets
        self.engine.capacity_intervals = intervals
        self.engine.capacity_brackets_interval = brackets
        self.engine.capacity_poll_enabled = enabled
        return intervals, brackets, enabled

    def test_mixed_sources_charge_only_local_markets_at_slow_baseline(self):
        intervals, brackets, enabled = self.configure()
        self.assertTrue(enabled)
        self.assertEqual([intervals[s] for s in (XAU, XAG, SPCX, CL)], [.2, .2, 2, 2])
        self.assertEqual(brackets, 60)
        self.assertEqual(self.budget.snapshot()["capacity_reserve"], 62)

    def test_no_relay_still_keeps_other_markets_out_of_fast_sampling(self):
        self.market.capacity_relay = None
        intervals, brackets, enabled = self.configure((XAU, SPCX, CL))
        self.assertTrue(enabled)
        self.assertEqual([intervals[s] for s in (XAU, SPCX, CL)], [.2, 2, 2])
        self.assertEqual(sum(60 / intervals[s] + 60 / brackets for s in (XAU, SPCX, CL)), 363)
        self.assertEqual(self.budget.snapshot()["capacity_reserve"], 363)

    def test_constrained_local_budget_does_not_slow_relay_brackets_or_quota(self):
        self.budget.limit = 6
        intervals, brackets, enabled = self.configure()
        self.assertTrue(enabled)
        self.assertEqual([intervals[s] for s in (XAU, XAG)], [.2, .2])
        reserve = self.budget.snapshot()["capacity_reserve"]
        self.assertLessEqual(sum(60 / intervals[s] + 60 / brackets for s in (SPCX, CL)), reserve)
        with patch.object(self.market, "refresh_public_brackets") as read:
            self.assertEqual(self.engine.poll_public_brackets(XAU), 60)
            self.assertEqual(self.engine.poll_public_brackets(SPCX), brackets)
        self.assertEqual([call.args[0] for call in read.call_args_list], [XAU, SPCX])

    def test_zero_local_reserve_skips_local_io_but_keeps_relay_workers(self):
        self.budget.limit = 1
        self.configure()
        self.assertEqual(self.budget.snapshot()["capacity_reserve"], 0)
        with patch.object(self.market, "capacities", return_value={5: dec(100)}) as quota, \
             patch.object(self.market, "refresh_public_brackets") as brackets, \
             patch.object(self.engine, "observe_capacity_alerts"):
            for symbol in (XAU, SPCX, CL):
                self.engine.poll_market(symbol)
                self.engine.poll_public_brackets(symbol)
        self.assertEqual([call.args[0] for call in quota.call_args_list], [XAU])
        self.assertEqual([call.args[0] for call in brackets.call_args_list], [XAU])
        self.assertEqual(self.engine.markets[XAU]["status"], "ok")

    def test_private_schedule_includes_local_public_cost_with_relay_configured(self):
        owner = account("single", mode="live")
        owner["policy"].update(symbols=[CL])
        self.engine.view("single", snapshot={"positions": [
            {"symbol": CL, "side": side, "leverage": 5, "qty": "0"}
            for side in ("LONG", "SHORT")]})
        self.configure((XAU, CL))
        expected = 60 * 120 / (1469 - PUBLIC_POLL_ALLOWANCE)
        self.assertAlmostEqual(self.engine.scheduling([owner])["single"]["gap"], expected)

    def test_local_failures_keep_local_floor_and_exchange_cooldown(self):
        self.configure()
        for retry_after in (0, 180):
            failure = ExchangeError("public read failed", retry_after=retry_after)
            with self.subTest(retry_after=retry_after), \
                 patch.object(self.market, "capacities", side_effect=failure), \
                 patch.object(self.market, "refresh_public_brackets", side_effect=failure):
                self.assertEqual(self.engine.poll_market(SPCX), max(10, retry_after))
                self.assertEqual(self.engine.poll_public_brackets(SPCX), max(10, retry_after))
                self.assertEqual(self.engine.poll_market(XAU), max(.5, retry_after))
                self.assertEqual(self.engine.poll_public_brackets(XAU), max(1, retry_after))


if __name__ == "__main__":
    unittest.main()

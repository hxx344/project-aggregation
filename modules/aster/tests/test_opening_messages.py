"""Opening diagnostics must explain the actual automatic upgrade constraints."""
from copy import deepcopy
from dataclasses import replace
from unittest import TestCase

from tests.helpers import Fixture
from trading.models import dec, plan_pair


class OpeningMessagesTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.symbol = "XAUUSD1"
        self.rule = self.f.market.rules[self.symbol]
        self.book = self.f.market.book(self.symbol)

    def snapshot(self, leverage):
        snap = self.f.broker.snapshot([self.symbol])
        snap.positions = [replace(p, leverage=leverage) for p in snap.positions]
        return deepcopy(snap)

    def test_spread_message_uses_configured_limit(self):
        policy = {**self.f.account["policy"], "spread_limit": "0.0001"}
        book = replace(self.book, bid=dec("100"), ask=dec("100.02"), mark=dec("100.01"))
        plan = plan_pair(self.snapshot(5), book, self.rule, {5: dec("20000")}, policy)
        self.assertIn("1 bp", plan.reason)
        self.assertNotIn("万 5", plan.reason)

    def test_single_unsupported_high_leverage_does_not_promise_auto_recovery(self):
        plan = plan_pair(self.snapshot(25), self.book, self.rule, {}, self.f.account["policy"])
        self.assertEqual(plan.qty, 0)
        self.assertIn("不会自动降杠杆", plan.reason)

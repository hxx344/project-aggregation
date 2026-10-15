"""Skip impossible transfers using current account data, never authorize from it."""
from copy import deepcopy
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_margin as fixtures
from trading.account_cache import HotAccountUnavailable
from trading.models import Position, dec


class PairMarginPrecheckTests(TestCase):
    live = fixtures.PairMarginTests.live
    state = fixtures.PairMarginTests.state
    ready = fixtures.PairMarginTests.ready

    def setUp(self):
        fixtures.PairMarginTests.setUp(self)
        self.live()

    @staticmethod
    def blocked_snapshots(source):
        destination = "short" if source == "long" else "long"
        rows = {source: fixtures.snapshot(3000), destination: fixtures.snapshot(1000)}
        rows[source].available = dec("150.999999999")
        rows[destination].available = dec(0)
        return rows

    def test_repeated_cash_blocked_checks_make_no_requests_in_either_direction(self):
        now = [1000.0]
        with patch("time.time", side_effect=lambda: now[0]):
            for source in ("long", "short"):
                for occupied in (False, True):
                    with self.subTest(source=source, occupied=occupied):
                        for _ in range(12):
                            snapshots = self.blocked_snapshots(source)
                            if occupied:
                                snapshots[source].positions = [Position("BTCUSD1", "BOTH", dec(1), dec(99999), dec(99999), 1)]
                                snapshots[source].maintenance = dec(99999)
                            before = deepcopy(snapshots)
                            result = self.balancer.tick(self.pair, snapshots)
                            self.assertEqual(result["status"], "waiting", result)
                            self.assertFalse(result["blocks_trading"])
                            self.assertIsNone(result["pending"])
                            self.assertIsNone(result["plan"])
                            self.assertIn("现金保留", result["reason"])
                            self.assertEqual(result["next_check_at"], now[0] + 5)
                            self.assertEqual(snapshots, before)
                            now[0] += 5
        self.assertEqual(self.master_calls, [])
        self.assertEqual(self.refreshed, [])
        self.assertEqual(self.transfers, [])
        self.assertTrue(all(not broker.api.calls for broker in self.brokers.values()))

    def test_improved_snapshot_resumes_full_validation_on_next_check(self):
        result = self.balancer.tick(self.pair, self.blocked_snapshots("long"))
        self.assertEqual(result["status"], "waiting", result)
        self.ready()
        rows = {"long": fixtures.snapshot(3000), "short": fixtures.snapshot(1000)}
        for row in rows.values():
            row.account_read_generation = 0
        result = self.balancer.tick(self.pair, rows)
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(self.master_calls, [("GET", "/fapi/v3/getSubAccountList")])
        for broker in self.brokers.values():
            self.assertEqual([path for _, path, _ in broker.api.calls],
                ["/fapi/v3/accountWithJoinMargin"])
        self.assertEqual(len(self.transfers), 1)

    def test_optimistic_preview_does_not_replace_exchange_withdrawal_limit(self):
        rows = {"long": fixtures.snapshot(3000), "short": fixtures.snapshot(1000)}
        for row in rows.values():
            row.account_read_generation = 0
        self.brokers["long"].api.account["assets"][0]["maxWithdrawAmount"] = "0"
        result = self.balancer.tick(self.pair, rows)
        self.assertEqual(result["status"], "waiting", result)
        self.assertIn("来源账户可划余额", result["reason"])
        self.assertEqual(len(self.master_calls), 1)
        self.assertTrue(all(len(broker.api.calls) == 1 for broker in self.brokers.values()))
        self.assertEqual(self.transfers, [])

    def test_revoked_guard_blocks_negative_preview_without_network(self):
        rows = self.blocked_snapshots("long")
        def guard():
            raise HotAccountUnavailable("revoked test lease")
        with patch("time.time", return_value=rows["long"].timestamp):
            result = self.balancer.tick(self.pair, rows, snapshot_guards={"long": guard})
        self.assertEqual(result["status"], "blocked", result)
        self.assertEqual(self.master_calls, [])
        self.assertEqual(self.transfers, [])
        self.assertTrue(all(not broker.api.calls for broker in self.brokers.values()))

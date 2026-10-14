"""Legacy accepted transfers leave historical polling after a finite budget."""
from copy import deepcopy
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_margin as fixtures
from trading.exchange import ExchangeError, RequestNotSent
from trading.margin_balance import MarginBalancer


class PairMarginBoundedRecoveryTests(TestCase):
    setUp = fixtures.PairMarginTests.setUp
    live = fixtures.PairMarginTests.live
    state = fixtures.PairMarginTests.state
    ready = fixtures.PairMarginTests.ready
    legacy_pending = fixtures.PairMarginTests.legacy_pending
    receipts = fixtures.PairMarginTests.receipts

    def accepted(self):
        snapshots = self.live()
        self.legacy_pending(snapshots)
        self.original = deepcopy(self.state()["pending"])
        self.wall = [time.time()]
        self.clock = patch("time.time", side_effect=lambda: self.wall[0])
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.archive_key = "pair_margin_skipped:gold:" + self.original["request_id"]

    def tick(self, elapsed=0):
        self.wall[0] += elapsed
        self.ready()
        return self.balancer.tick(self.pair, {})

    def test_three_queries_then_no_more_history_and_restart_uses_fresh_balances(self):
        self.accepted()
        self.receipts()
        self.brokers["short"].api.rows[0]["tranId"] = "different-account-id"
        for _ in range(3):
            self.assertEqual(self.tick()["status"], "accepted")
        pending = self.state()["pending"]
        self.assertEqual(pending["history_recovery"]["query_rounds"], 3)
        self.balancer = MarginBalancer(self.engine)
        with patch.object(self.balancer, "_income", side_effect=AssertionError("historical polling exhausted")):
            self.assertEqual(self.tick(119)["status"], "accepted")
            self.refreshed.clear()
            result = self.tick(1)
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(self.refreshed, ["long", "short"])
        self.assertIsNone(self.state()["pending"])
        archive = self.store.get(self.archive_key)
        self.assertEqual(archive["original"]["status"], "accepted")
        self.assertNotIn("confirmed_at", archive["result"])
        self.assertEqual(len(self.transfers), 1)
        self.assertFalse(self.balancer.tick(self.pair, {})["blocks_trading"])

    def test_network_failures_consume_query_rounds_but_local_waits_do_not(self):
        self.accepted()
        for error in (RequestNotSent("local budget wait"), ExchangeError("接口冷却中：local wait")):
            with patch.object(self.brokers["long"].api, "call", side_effect=error):
                self.tick()
            self.assertEqual(self.state()["pending"]["history_recovery"]["query_rounds"], 0)
        with patch.object(self.brokers["long"].api, "call", side_effect=ExchangeError("network unavailable")):
            self.tick()
            self.tick(60)
            # Once the third real query fails, fresh balances can settle the
            # recovery path without any claim about the missing receipt.
            result = self.tick(60)
        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(self.store.get(self.archive_key)["original"]["history_recovery"]["query_rounds"], 3)
        self.assertEqual(len(self.transfers), 1)

    def test_balance_read_failure_retains_request_and_never_restarts_history_queries(self):
        self.accepted()
        for _ in range(3):
            self.tick()
        self.refresh_error = ExchangeError("balance unavailable")
        with patch.object(self.balancer, "_income", side_effect=AssertionError("no history retry")):
            result = self.tick(120)
            self.assertTrue(result["blocks_trading"])
            self.assertIsNotNone(self.state()["pending"])
            self.assertIsNone(self.store.get(self.archive_key))
            self.refresh_error = None
            self.assertEqual(self.tick()["status"], "skipped")
        self.assertEqual(len(self.transfers), 1)

    def test_matching_receipts_on_last_query_still_confirm_instead_of_skip(self):
        self.accepted()
        self.tick()
        self.tick(60)
        self.receipts()
        result = self.tick(60)
        self.assertEqual(result["status"], "confirmed", result)
        self.assertIsNone(self.store.get(self.archive_key))

    def test_completed_window_still_requires_three_actual_query_rounds(self):
        self.accepted()
        self.tick()
        result = self.tick(180)
        self.assertEqual(result["status"], "accepted", result)
        self.assertEqual(self.state()["pending"]["history_recovery"]["query_rounds"], 2)
        self.assertEqual(self.tick()["status"], "skipped")

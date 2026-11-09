"""Final-send freshness of paired market orders; offline APIs only.

Each leg is sized from its own account read. Persistence and shared admission
run after the leg's lease check, so the transport hook must check that read's
generation and age again, as the single-account path does.
"""
import unittest
from unittest.mock import patch

from tests import test_pair_warm_mode_recovery as pair_fixtures
from trading.models import dec


class PairFinalFreshnessTests(unittest.TestCase):
    setUp = pair_fixtures.PairWarmModeRecoveryTests.setUp
    live_brokers = pair_fixtures.PairWarmModeRecoveryTests.live_brokers
    warm = pair_fixtures.PairWarmModeRecoveryTests.warm
    clear_calls = pair_fixtures.PairWarmModeRecoveryTests.clear_calls
    ordinary_plan = pair_fixtures.PairWarmModeRecoveryTests.ordinary_plan

    def run_with_delay(self, delay):
        state, snapshots, guards, plan = self.ordinary_plan()
        broker = self.brokers["long"]
        call = broker.api.call
        delayed = []

        def admission(method, path, params=None, **options):
            # Runs inside the account write, after the leg's lease check and
            # before the final transport hook, where shared admission waits.
            if method == "POST" and path == "/fapi/v3/order" and not delayed:
                delayed.append(True)
                delay(broker, snapshots["long"])
            return call(method, path, params, **options)

        with patch.object(broker.api, "call", side_effect=admission):
            self.trader._start(self.pair, state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertTrue(delayed)
        return state, plan

    def assert_long_leg_not_sent(self, state, plan, reason):
        pending = state["pending"]
        long_leg, short_leg = pending["legs"]
        # Proven local no-send, never an unknown order to query.
        self.assertTrue(long_leg["receipt"]["local_not_sent"])
        self.assertEqual(long_leg["submit_evidence"]["kind"], "request_not_sent")
        self.assertIn(reason, long_leg["submit_error"])
        self.assertEqual(short_leg["receipt"]["status"], "FILLED")
        # Only this batch's filled short increment is reduced; no leg is added.
        self.assertEqual([(leg["key"], leg["order"]["side"], dec(leg["order"]["quantity"]))
                          for leg in pending["repairs"]], [("short", "BUY", plan.qty)])
        self.trader._recover(self.pair, state, self.brokers)
        self.assertIsNone(state["pending"], state)
        self.assertFalse(state["last_batch"]["completed"])
        self.assertTrue(all(dec(qty) == 0 for qty in state["owned"].values()), state["owned"])
        long_posts = [row for row in self.brokers["long"].api.calls if row[:2] == ("POST", "/fapi/v3/order")]
        self.assertEqual(long_posts, [])

    def test_account_event_during_admission_blocks_that_leg(self):
        event = lambda broker, _snapshot: broker._private_account_event("ACCOUNT_UPDATE")
        state, plan = self.run_with_delay(event)
        self.assert_long_leg_not_sent(state, plan, "发送前账户发生变化")

    def test_nine_second_admission_wait_blocks_that_leg(self):
        def wait(_broker, snapshot):
            snapshot.timestamp -= 9  # The 8-second account read aged past its window.
        state, plan = self.run_with_delay(wait)
        self.assert_long_leg_not_sent(state, plan, "账户快照已过期，本腿未发送")

    def test_stale_repair_basis_is_unsent_and_retried_without_spending_an_attempt(self):
        state, snapshots, guards, plan = self.ordinary_plan()
        posts = {"long": 0, "short": 0}

        def admission_for(key):
            broker = self.brokers[key]
            call = broker.api.call

            def admission(method, path, params=None, **options):
                if method == "POST" and path == "/fapi/v3/order":
                    posts[key] += 1
                    # Long opening leg, then the short repair, each see an
                    # account change after their lease check.
                    if (key, posts[key]) in {("long", 1), ("short", 2)}:
                        broker._private_account_event("ACCOUNT_UPDATE")
                return call(method, path, params, **options)
            return patch.object(broker.api, "call", side_effect=admission)

        with admission_for("long"), admission_for("short"):
            self.trader._start(self.pair, state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertEqual(posts["short"], 2)
        pending = state["pending"]
        repair = pending["repairs"][-1]
        self.assertTrue(repair["receipt"]["local_not_sent"])
        self.assertIn("发送前账户发生变化", repair["submit_error"])
        # A proven no-send does not spend the bounded repair budget.
        self.assertEqual(pending["repair_attempts"], 0)
        self.assertGreater(pending["repair_retry_at"], 0)
        short_posts = [row for row in self.brokers["short"].api.calls if row[:2] == ("POST", "/fapi/v3/order")]
        self.assertEqual(len(short_posts), 1)
        pending["repair_retry_at"] = 0
        self.trader._recover(self.pair, state, self.brokers)
        retried = state["pending"]["repairs"][-1]
        self.assertEqual((retried["receipt"]["status"], dec(retried["order"]["quantity"])), ("FILLED", plan.qty))
        self.assertEqual(state["pending"]["repair_attempts"], 1)
        self.trader._recover(self.pair, state, self.brokers)
        self.assertIsNone(state["pending"])
        self.assertTrue(all(dec(qty) == 0 for qty in state["owned"].values()), state["owned"])


if __name__ == "__main__":
    unittest.main()

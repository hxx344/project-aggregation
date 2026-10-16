"""Offline SQLite restart coverage for bounded ADL original-order recovery."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from trading.adl_recovery import UNKNOWN, reconcile_order
from trading.exchange import BudgetWait, ExchangeError, RequestNotSent
from trading.execution import Executor
from trading.models import TradingError
from trading.store import Store


class Crash(BaseException):
    pass


class Broker:
    def __init__(self, queries=(), cancellations=()):
        self.queries, self.cancellations = list(queries), list(cancellations)
        self.calls = []
        self.before = None

    def request(self, kind, symbol, client_id, timeout=None):
        if self.before:
            self.before(kind)
        self.calls.append((kind, symbol, client_id, timeout))
        responses = self.queries if kind == "query" else self.cancellations
        if not responses:
            raise AssertionError("Unexpected network request")
        response = responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return deepcopy(response)

    def query(self, symbol, client_id, *, timeout=None):
        return self.request("query", symbol, client_id, timeout)

    def cancel(self, symbol, client_id):
        return self.request("cancel", symbol, client_id)


class ADLRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "recovery.sqlite3"
        self.store = Store(self.path)
        self.item = {"order": Executor.order("BTCUSDT", "LONG", "SELL", 1, "adl-original"),
                     "state": "sending", "sent_at": 1000}
        self.persist()

    def persist(self):
        self.store.put("adl_pair:test", {"id": "incident", "batches": [self.item]})

    def restart(self):
        self.store = Store(self.path)
        self.item = self.saved()

    def saved(self):
        return self.store.get("adl_pair:test")["batches"][0]

    def receipt(self, status="NEW", qty="0", **changes):
        return {**self.item["order"], "clientOrderId": "adl-original", "orderId": 123,
                "status": status, "executedQty": qty, "avgPrice": "60000" if qty != "0" else "0",
                **changes}

    @staticmethod
    def unknown():
        return ExchangeError("private upstream details must not be copied", code=-2013)

    def run_recovery(self, broker, at):
        return reconcile_order(self.item, broker, self.persist, now=at)

    def test_unknown_requires_three_sent_queries_and_full_window_across_sqlite_restart(self):
        broker = Broker([self.unknown() for _ in range(3)])

        def before(kind):
            self.assertEqual(kind, "query")
            self.assertEqual(self.saved()["queries"], len(broker.calls) + 1)

        broker.before = before
        for at in (1001, 1003, 1005):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
            self.restart()
        self.assertEqual(self.run_recovery(broker, 1119), "waiting")
        self.assertEqual(self.run_recovery(broker, 1120), "reality")
        self.restart()
        self.assertEqual(self.run_recovery(broker, 5000), "reality")
        self.assertEqual(len(broker.calls), 3)
        self.assertTrue(all(call == ("query", "BTCUSDT", "adl-original", 3) for call in broker.calls))
        self.assertEqual(self.item["state"], "sending")
        self.assertNotIn("receipt", self.item)
        self.assertNotIn("resolution", self.item)
        self.assertEqual(self.item["error"], UNKNOWN)

    def test_old_send_time_does_not_skip_actual_queries(self):
        self.item["sent_at"] = 500
        broker = Broker([self.unknown() for _ in range(3)])
        self.assertEqual(self.run_recovery(broker, 1000), "waiting")
        self.assertEqual(self.run_recovery(broker, 1002), "waiting")
        self.assertEqual(self.run_recovery(broker, 1004), "reality")
        self.assertEqual(self.item["queries"], 3)

    def test_legacy_missing_send_time_uses_durable_first_observation(self):
        self.item.pop("sent_at")
        broker = Broker([self.unknown() for _ in range(3)])
        for at in (1000, 1002, 1004):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
        self.restart()
        self.assertEqual(self.item["first_observed_at"], 1000)
        self.assertEqual(self.run_recovery(broker, 1119), "waiting")
        self.assertEqual(self.run_recovery(broker, 1120), "reality")

    def test_latest_possible_send_starts_the_window(self):
        self.item["last_possible_send_at"] = 1050
        broker = Broker([self.unknown() for _ in range(3)])
        for at in (1051, 1053, 1055):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
        self.assertEqual(self.run_recovery(broker, 1169), "waiting")
        self.assertEqual(self.run_recovery(broker, 1170), "reality")

    def test_request_not_sent_budget_and_local_cooldown_refund_the_committed_attempt(self):
        local = ExchangeError("private cached throttle", retry_after=10)
        local.local_cooldown = True
        broker = Broker([RequestNotSent("private no-send", retry_after=10),
                         BudgetWait("private budget", retry_after=10), local])
        broker.before = lambda kind: self.assertEqual(self.saved()["queries"], 1)
        for at in (1001, 1020, 1040):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
            self.assertEqual(self.saved()["queries"], 0)
            self.assertEqual(self.item["error"], UNKNOWN)
            self.restart()
        self.assertEqual(len(broker.calls), 3)

    def test_real_http_throttle_counts_but_its_following_local_wait_does_not(self):
        broker = Broker([ExchangeError("private remote throttle", http_status=429, retry_after=10),
                         RequestNotSent("private local throttle", retry_after=10)])
        self.assertEqual(self.run_recovery(broker, 1000), "waiting")
        self.assertEqual(self.item["queries"], 1)
        self.assertEqual(self.run_recovery(broker, 1001), "waiting")
        self.assertEqual(len(broker.calls), 1)
        self.assertEqual(self.run_recovery(broker, 1010), "waiting")
        self.assertEqual(self.item["queries"], 1)

    def test_late_terminal_query_receipt_stops_recovery_without_waiting_for_120_seconds(self):
        broker = Broker([self.unknown(), self.unknown(), self.receipt("FILLED", "1")])
        self.run_recovery(broker, 1000)
        self.run_recovery(broker, 1002)
        self.assertEqual(self.run_recovery(broker, 1004), "terminal")
        self.restart()
        self.assertEqual(self.run_recovery(broker, 1200), "terminal")
        self.assertEqual(self.item["receipt"]["executedQty"], "1")
        self.assertEqual(len(broker.calls), 3)

    def test_independent_late_terminal_evidence_is_accepted_after_queries_are_exhausted(self):
        broker = Broker([self.unknown() for _ in range(3)])
        for at in (1000, 1002, 1004):
            self.run_recovery(broker, at)
        self.item["receipt"] = self.receipt("CANCELED", ".4")
        self.persist()
        self.restart()
        self.assertEqual(self.run_recovery(broker, 1100), "terminal")
        self.assertEqual(self.saved()["state"], "terminal")
        self.assertEqual(len(broker.calls), 3)

    def test_reality_resolution_never_queries_or_fabricates_a_receipt_after_restart(self):
        self.item.update(resolution="positions_verified_unknown", resolved_at=1200, queries=3)
        self.persist()
        self.restart()
        before = deepcopy(self.item)
        broker = Broker()
        self.assertEqual(self.run_recovery(broker, 9999), "reality")
        self.assertEqual(self.item, before)
        self.assertEqual(broker.calls, [])

    def test_unknown_cancel_is_sent_once_with_new_window_and_bounded_post_cancel_queries(self):
        self.item["receipt"] = self.receipt()
        broker = Broker([self.unknown() for _ in range(3)], [self.unknown()])

        def before(kind):
            saved = self.saved()
            self.assertTrue(saved["cancel_requested"])
            self.assertEqual(saved["last_possible_send_at"], 1011)
            if kind == "query":
                self.assertEqual(saved["post_cancel_queries"], len(broker.calls))

        broker.before = before
        self.assertEqual(self.run_recovery(broker, 1011), "waiting")
        self.restart()
        for at in (1013, 1015, 1017):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
            self.restart()
        self.assertEqual(self.run_recovery(broker, 1130), "waiting")
        self.assertEqual(self.run_recovery(broker, 1131), "reality")
        self.assertEqual([call[0] for call in broker.calls], ["cancel", "query", "query", "query"])
        self.assertEqual(self.item["receipt"]["status"], "NEW")
        self.assertEqual(self.item["state"], "sending")

    def test_known_active_receipt_can_cancel_after_original_query_budget_is_exhausted(self):
        broker = Broker([self.receipt() for _ in range(3)], [self.receipt("CANCELED")])
        for at in (1000, 1002, 1004):
            self.assertEqual(self.run_recovery(broker, at), "waiting")
        self.assertEqual(self.run_recovery(broker, 1009), "waiting")
        self.assertEqual(self.run_recovery(broker, 1010), "terminal")
        self.assertEqual([call[0] for call in broker.calls], ["query", "query", "query", "cancel"])
        self.assertEqual(self.item["queries"], 3)

    def test_active_query_then_cancel_uses_independent_post_cancel_budget(self):
        broker = Broker([self.receipt(), *[self.unknown() for _ in range(3)]], [self.unknown()])
        self.assertEqual(self.run_recovery(broker, 1011), "waiting")
        self.assertEqual(self.item["queries"], 1)
        self.assertEqual(self.item["post_cancel_queries"], 0)
        for at in (1013, 1015, 1017):
            self.run_recovery(broker, at)
        self.assertEqual(self.run_recovery(broker, 1131), "reality")
        self.assertEqual(self.item["queries"], 1)
        self.assertEqual(self.item["post_cancel_queries"], 3)
        self.assertEqual(len(broker.calls), 5)

    def test_cancel_proven_not_sent_can_retry_without_resetting_original_observation_window(self):
        self.item["receipt"] = self.receipt()
        broker = Broker(cancellations=[RequestNotSent("private cancellation budget"), self.receipt("CANCELED")])
        self.assertEqual(self.run_recovery(broker, 1011), "waiting")
        self.assertNotIn("cancel_requested", self.item)
        self.assertNotIn("last_possible_send_at", self.item)
        self.assertNotIn("post_cancel_queries", self.item)
        self.restart()
        self.assertEqual(self.run_recovery(broker, 1013), "terminal")
        self.assertEqual(self.item["last_possible_send_at"], 1013)

    def test_crash_after_query_intent_does_not_spend_an_extra_query_on_restart(self):
        broker = Broker([Crash(), self.unknown(), self.unknown()])
        with self.assertRaises(Crash):
            self.run_recovery(broker, 1000)
        self.restart()
        self.assertEqual(self.item["queries"], 1)
        self.run_recovery(broker, 1002)
        self.run_recovery(broker, 1004)
        self.assertEqual(self.run_recovery(broker, 1120), "reality")
        self.assertEqual(len(broker.calls), 3)

    def test_crash_after_cancel_intent_never_sends_another_cancellation(self):
        self.item["receipt"] = self.receipt()
        broker = Broker([self.unknown() for _ in range(3)], [Crash()])
        with self.assertRaises(Crash):
            self.run_recovery(broker, 1010)
        self.restart()
        self.assertTrue(self.item["cancel_requested"])
        for at in (1012, 1014, 1016):
            self.run_recovery(broker, at)
        self.assertEqual(self.run_recovery(broker, 1130), "reality")
        self.assertEqual(sum(call[0] == "cancel" for call in broker.calls), 1)

    def test_receipt_regressions_and_identity_conflicts_preserve_last_valid_evidence(self):
        original = self.receipt("PARTIALLY_FILLED", ".4", updateTime=10)
        invalid = [self.receipt("PARTIALLY_FILLED", ".3"), self.receipt("NEW", ".4"),
                   self.receipt("PARTIALLY_FILLED", ".5", orderId=124),
                   self.receipt("PARTIALLY_FILLED", ".5", updateTime=9),
                   self.receipt("PARTIALLY_FILLED", ".5", origQty="2"),
                   self.receipt("FILLED", ".8"), self.receipt(clientOrderId="another-order")]
        for bad in invalid:
            with self.subTest(receipt=bad):
                self.item = {"order": deepcopy(self.item["order"]), "state": "sending", "sent_at": 1000,
                             "receipt": deepcopy(original)}
                broker = Broker([bad, self.receipt("FILLED", "1", updateTime=11)])
                self.assertEqual(self.run_recovery(broker, 1000), "waiting")
                self.assertEqual(self.item["receipt"], original)
                self.assertEqual(self.item["error"], UNKNOWN)
                self.assertEqual(self.run_recovery(broker, 1002), "terminal")

    def test_prepared_not_sent_terminal_needs_no_synthetic_receipt(self):
        self.item.update(state="terminal", not_sent=True)
        broker = Broker()
        self.assertEqual(self.run_recovery(broker, 1000), "terminal")
        self.assertNotIn("receipt", self.item)
        self.assertEqual(broker.calls, [])

    def test_terminal_state_cannot_hide_an_active_receipt(self):
        self.item.update(state="terminal", receipt=self.receipt())
        broker = Broker()
        with self.assertRaisesRegex(TradingError, "终态"):
            self.run_recovery(broker, 1000)
        self.assertEqual(broker.calls, [])

    def test_persistence_failure_prevents_query_and_cancel_network_calls(self):
        broker = Broker()

        def failed_save():
            raise OSError("disk unavailable")

        with self.assertRaises(OSError):
            reconcile_order(self.item, broker, failed_save, now=1000)
        self.item.update(first_observed_at=1000, receipt=self.receipt())
        with self.assertRaises(OSError):
            reconcile_order(self.item, broker, failed_save, now=1010)
        self.assertEqual(broker.calls, [])

    def test_future_send_time_cannot_shorten_the_window_and_invalid_metadata_is_rejected(self):
        self.item["sent_at"] = 1100
        broker = Broker()
        self.assertEqual(self.run_recovery(broker, 1000), "waiting")
        self.assertEqual(broker.calls, [])
        for key, value in (("sent_at", float("nan")), ("queries", -1), ("query_after", True)):
            self.item = {"order": deepcopy(self.item["order"]), "state": "sending", "sent_at": 1000, key: value}
            with self.subTest(key=key), self.assertRaises(TradingError):
                self.run_recovery(broker, 1000)
        self.assertEqual(broker.calls, [])


if __name__ == "__main__":
    unittest.main()

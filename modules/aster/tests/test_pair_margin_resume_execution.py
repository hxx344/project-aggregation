"""Unknown-transfer reservation and skipping for a funds-only pair with offline brokers."""
from contextlib import ExitStack, contextmanager
from copy import deepcopy
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_margin_poll_efficiency as fixtures
from trading.exchange import ExchangeError
from trading.margin_balance import MarginBalancer
from trading.models import TradingError


SYMBOL = "XAUUSD1"


class PairMarginResumeExecutionTests(TestCase):
    setUp = fixtures.PairMarginPollEfficiencyTests.setUp
    live_brokers = fixtures.PairMarginPollEfficiencyTests.live_brokers
    pending = fixtures.PairMarginPollEfficiencyTests.pending
    calls = fixtures.PairMarginPollEfficiencyTests.calls
    tick = fixtures.PairMarginPollEfficiencyTests.tick

    def unknown(self, amount="20000", *, ready=True):
        # Model an existing baseline during its bounded retry window. Due
        # unknowns are now skipped after new reads; this protects the window
        # before that durable transition, including failures and old journals.
        pending = self.pending("unknown", transaction=False)
        pending["amount"] = amount
        if ready:
            pending["trading_baseline_at"] = self.wall - 1
        self.store.put("pair_margin:gold", {"pending": pending, "next_check_at": self.wall + 30})
        return deepcopy(pending)

    def posts(self):
        return [row for row in self.calls() if row[0] != "GET"]

    def assert_original_transfer_retained(self, original):
        self.assertEqual(self.store.get("pair_margin:gold")["pending"], original)
        self.assertEqual(self.posts(), [])

    def assert_flat(self):
        for broker in self.paper.values():
            self.assertTrue(all(not row.qty for row in broker.snapshot([SYMBOL]).positions))

    def test_unknown_debit_in_retry_window_is_reserved_and_never_resent(self):
        original = self.unknown("24990")
        state = self.tick()
        self.assertEqual(state["phase"], "monitoring", state)
        self.assertFalse(state["margin"]["blocks_trading"], state)
        self.assertIsNone(state["pending"])
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertIn("预留 24990 USD1", state["reason"])
        self.assertIn("不重发原请求", state["reason"])
        self.assert_flat()
        self.assert_original_transfer_retained(original)

    def test_balance_preparation_error_waits_without_blocking_or_sending(self):
        self.paper["long"].state["wallet"] = "30000"
        self.paper["long"].save()
        with patch.object(MarginBalancer, "_live", side_effect=ExchangeError(
                "offline balance preparation unavailable")) as preparation:
            state = self.tick()
        preparation.assert_called_once()
        self.assertEqual(state["phase"], "monitoring", state)
        self.assertFalse(state["margin"]["blocks_trading"])
        journal = self.store.get("pair_margin:gold")
        self.assertIsNone(journal.get("pending"))
        self.assertTrue(journal["retry_without_blocking"])
        self.assertEqual(self.posts(), [])
        self.assert_flat()

    def test_unknown_without_baseline_is_skipped_after_fresh_reads_and_never_replayed(self):
        original = self.unknown(ready=False)
        self.store.put("pair_margin:gold", {"pending": original, "next_check_at": 0})
        with ExitStack() as stack:
            baseline_reads = [stack.enter_context(patch.object(broker, "transfer_snapshot", wraps=broker.transfer_snapshot))
                              for broker in self.brokers.values()]
            transfer = stack.enter_context(patch("trading.margin_balance.TransferAPI",
                side_effect=AssertionError("an unknown transfer must never be replayed")))
            state = self.tick()
            self.assertEqual(state["phase"], "margin_wait", state)
            self.assertEqual(self.posts(), [])
            self.assertTrue(all(read.call_count == 1 for read in baseline_reads))
            self.assertTrue(all(read.call_args.args == () and read.call_args.kwargs == {} for read in baseline_reads))
            journal = self.store.get("pair_margin:gold")
            self.assertIsNone(journal["pending"])
            self.assertEqual(journal["last_transfer"]["status"], "skipped")
            self.assertEqual(journal["last_transfer"]["request_id"], original["request_id"])
            self.assertEqual(journal["last_transfer"]["skipped_at"], self.wall)
            self.assertTrue(state["margin"]["blocks_trading"])
            state = self.tick()
            self.assertEqual(state["phase"], "monitoring", state)
            self.assertFalse(state["margin"]["blocks_trading"])
            transfer.assert_not_called()
            self.assertTrue(all(read.call_count == 1 for read in baseline_reads))
        self.assertIsNone(self.store.get("pair_margin:gold")["pending"])
        self.assertEqual(self.store.get("pair_margin:gold")["last_transfer"], journal["last_transfer"])
        self.assertEqual(self.posts(), [])
        self.assert_flat()

    def test_paused_enable_starts_funds_but_unknown_still_locks_configure_and_delete(self):
        self.engine.pairs.enable("gold", False)
        original = self.unknown(ready=False)

        class Master:
            def __init__(inner):
                inner.budget = self.budget

            def call(inner, method, path, *, signed=False, weight=1):
                self.assertEqual((method, path), ("GET", "/fapi/v3/getSubAccountList"))
                inner.budget.reserve(weight)
                return [{"accountId": 1, "parentAccount": True}] + [
                    {"accountId": index, "parentAccount": False, "sourceAddr": credentials["user"]}
                    for index, credentials in enumerate(self.children.values(), 10)]

        @contextmanager
        def master_context(balancer, pair, members):
            yield Master(), self.master, self.children

        with patch.object(MarginBalancer, "_master", master_context):
            # Starting funds management is how an unknown transfer gets resolved.
            enabled = self.engine.pairs.enable("gold", True)
            self.assertTrue(enabled["enabled"])
            self.engine.pairs.enable("gold", False)
            for action in (lambda: self.engine.pairs.configure("gold", {"name": "must remain unchanged"}),
                           lambda: self.engine.pairs.delete("gold")):
                with self.assertRaisesRegex(TradingError, "划转"):
                    action()
        self.assertEqual(self.store.pair("gold")["name"], self.pair["name"])
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.assert_flat()
        self.assert_original_transfer_retained(original)

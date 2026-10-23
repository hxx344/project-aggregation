"""ADL waits retain evidence without turning quota denial into a trading halt."""
import unittest
from unittest.mock import patch

from tests import test_adl_controller as fixtures
from trading import adl
from trading.exchange import BudgetWait
from trading.models import TradingError
from tests.pair_legacy_fixtures import runtime_default


class AdlLivenessTests(unittest.TestCase):
    def setUp(self):
        network = patch("httpx.Client.request", side_effect=AssertionError("live HTTP forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def case(self):
        case = fixtures.AdlControllerTests("test_each_batch_uses_fresh_actual_net_and_has_a_durable_id_before_send")
        case.setUp()
        self.addCleanup(case.doCleanups)
        return case

    def emit(self, case, item, status="NEW"):
        broker, order = case.brokers[item["account_id"]], item["order"]
        stamp = int(case.now * 1000)
        quantity = {"NEW": "0", "PARTIALLY_FILLED": "0.4", "FILLED": order["quantity"], "CANCELED": "0"}[status]
        event = {"e": "ORDER_TRADE_UPDATE", "E": stamp, "T": stamp, "o": {
            "s": order["symbol"], "c": order["newClientOrderId"], "i": 123,
            "ps": order["positionSide"], "S": order["side"], "q": order["quantity"],
            "z": quantity, "X": status, "ap": "0" if quantity == "0" else "1000",
            "T": stamp, "o": "MARKET", "ot": "MARKET"}}
        with broker._snapshot_lock:
            if not broker._private_evidence.connected:
                broker._private_evidence.reset(True)
            broker._private_account_event("ORDER_TRADE_UPDATE")
            broker._private_evidence.payload(event)
        self.assertIsNotNone(broker.order_event_receipt(order, include_active=True))

    def completed_unknown(self, case):
        original = case.unknown_with_three_queries()
        case.submit_unknown = False
        case.snapshot_filled = True
        case.now = original["sent_at"] + 120
        case.tick()
        case.tick(1)
        self.assertEqual(case.state()["status"], "completed")
        return original

    def test_local_submit_denials_survive_restart_without_spending_failure_or_batch_limits(self):
        case = self.case()
        case.brokers["b"].submit.side_effect = BudgetWait("local quota wait", retry_after=60)
        case.observe()
        with patch("trading.adl.MAX_BATCHES", 1):
            for index in range(3):
                case.now = 1000 + index * 60
                result = case.tick()
                incident = case.state()
                self.assertFalse(incident.get("halted", False))
                self.assertEqual(incident["retry_at"], case.now + 60)
                self.assertLessEqual(result["retry_after"], 10)
                self.assertEqual(len(incident["batches"]), index + 1)
                self.assertTrue(all(item["not_sent"] for item in incident["batches"]))
                reads = len(case.reads)
                case.controller = adl.AdlController(case.engine)
                case.tick(59)
                self.assertEqual(len(case.reads), reads)
                self.assertEqual(case.brokers["b"].submit.call_count, index + 1)
            case.brokers["b"].submit.side_effect = lambda orders, **_: case.submit("b", orders)
            case.tick(1)
            self.assertEqual(len(case.sent), 1)
            self.assertFalse(case.state().get("halted", False))
        self.assertTrue(all(not broker.query.called for broker in case.brokers.values()))

    def test_three_real_zero_fill_batches_still_halt(self):
        case = self.case()
        case.snapshot_filled = False
        case.brokers["b"].submit.side_effect = lambda orders, **_: [fixtures.receipt(orders[0], "0", status="EXPIRED")]
        case.observe()
        for _ in range(4):
            case.tick(1)
        self.assertTrue(case.state()["halted"])
        self.assertEqual(case.brokers["b"].submit.call_count, 3)
        self.assertIn("连续三批未成交", case.state()["reason"])

    def test_scene_budget_wait_persists_real_deadline_across_restart(self):
        case = self.case()
        case.observe()
        with patch.object(case.controller, "_read", side_effect=BudgetWait("scene wait", retry_after=120)) as read:
            case.tick()
            self.assertEqual(read.call_count, 1)
        self.assertEqual(case.state()["retry_at"], 1120)
        case.controller = adl.AdlController(case.engine)
        for _ in range(11):
            case.tick(10)
        self.assertEqual(case.reads, [])
        self.assertEqual(case.sent, [])
        case.tick(10)
        self.assertEqual(len(case.sent), 1)

    def test_budget_wait_captures_active_order_before_cache_expiry_without_rest(self):
        case = self.case()
        original = case.unknown_with_three_queries()
        case.now = original["sent_at"] + 120
        with patch.object(case.controller, "_read", side_effect=BudgetWait("scene wait", retry_after=60)):
            case.tick()
        case.now += 1
        self.emit(case, original)
        calls = case.brokers["b"].query.call_count
        reads = len(case.reads)
        case.tick()
        self.assertEqual(case.state()["batches"][0]["receipt"]["status"], "NEW")
        self.assertEqual(case.brokers["b"].query.call_count, calls)
        self.assertEqual(len(case.reads), reads)
        case.now += 59
        self.assertIsNone(case.brokers["b"].order_event_receipt(original["order"], include_active=True))
        case.controller = adl.AdlController(case.engine)
        case.tick()
        self.assertEqual(len(case.sent), 1)
        self.assertNotIn("resolution", case.state()["batches"][0])

    def test_frozen_orders_are_captured_even_when_initial_scene_is_rate_limited(self):
        case = self.case()
        case.archived_runtime()
        case.observe()
        with patch.object(case.controller, "_read", side_effect=BudgetWait("initial wait", retry_after=60)):
            case.tick()
        original = case.state()["prior_orders"][0]
        case.now += 1
        self.emit(case, original)
        case.tick()
        self.assertEqual(case.state()["prior_orders"][0]["receipt"]["status"], "NEW")
        self.assertTrue(all(not broker.query.called for broker in case.brokers.values()))
        self.assertEqual(case.sent, [])

    def test_leverage_journal_without_pair_id_keeps_latest_send_window_and_can_continue(self):
        case = self.case()
        pair = case.store.pair("pair")
        identities = case.controller._context(pair)[2]
        runtime = runtime_default()
        runtime["pending"] = {"id": "leverage", "kind": "leverage", "symbol": pair["symbol"],
            "identities": identities, "created_at": 800, "last_possible_send_at": 990,
            "before": {"LONG": "0", "SHORT": "0"}, "target_leverage": 20,
            "previous_leverage": 10, "results": {}}
        case.store.put("pair_runtime:pair", runtime)
        case.observe()
        case.tick()
        self.assertIn("观察窗口", case.state()["reason"])
        self.assertEqual(case.sent, [])
        case.now = 1110
        case.tick()
        self.assertEqual(len(case.sent), 1)
        self.assertTrue(all(not broker.query.called for broker in case.brokers.values()))

    def test_pending_margin_journal_does_not_block_adl_or_get_modified(self):
        case = self.case()
        margin = {"status": "unknown", "pending": {"client_id": "transfer-original", "amount": "50"}, "retry_at": 99999}
        case.store.put("pair_margin:pair", margin)
        case.observe()
        case.tick()
        self.assertEqual(len(case.sent), 1)
        self.assertEqual(case.store.get("pair_margin:pair"), margin)

    def test_controller_selects_market_only_but_unknown_or_limit_history_keeps_full_read(self):
        for kind in (None, "MARKET", "LIMIT", "missing"):
            with self.subTest(kind=kind):
                case = self.case()
                if kind is not None:
                    runtime = case.archived_runtime()
                    for leg in runtime["recovery_watch"]["batches"][0]["legs"]:
                        if kind == "missing":
                            leg["order"].pop("type")
                        else:
                            leg["order"]["type"] = kind
                    case.store.put("pair_runtime:pair", runtime)
                case.observe()
                with patch.object(case.controller, "_read", wraps=case.controller._read) as read:
                    case.tick()
                self.assertTrue(read.called)
                self.assertEqual(read.call_args.kwargs["market_only"], kind in (None, "MARKET"))

    def test_late_active_receipts_during_snapshot_windows_survive_expiry_and_restart(self):
        for status in ("NEW", "PARTIALLY_FILLED"):
            for window in ("before", "after", "failed"):
                with self.subTest(status=status, window=window):
                    case = self.case()
                    original = case.unknown_with_three_queries()
                    case.now = original["sent_at"] + 120
                    read = case.controller._read
                    def changed(brokers, **options):
                        if window == "before":
                            self.emit(case, original, status)
                        snapshots = read(brokers, **options)
                        if window != "before":
                            self.emit(case, original, status)
                        if window == "failed":
                            raise TradingError("snapshot failed after event")
                        return snapshots
                    with patch.object(case.controller, "_read", side_effect=changed):
                        case.tick()
                    self.assertEqual(len(case.sent), 1)
                    self.assertEqual(case.state()["batches"][0]["receipt"]["status"], status)
                    self.assertNotIn("resolution", case.state()["batches"][0])
                    case.now += 31
                    case.controller = adl.AdlController(case.engine)
                    case.tick()
                    self.assertEqual(len(case.sent), 1)
                    self.assertNotEqual(case.state()["status"], "completed")

    def test_late_active_before_send_or_complete_cannot_authorize_a_new_action(self):
        for operation in ("_send", "_complete"):
            with self.subTest(operation=operation):
                case = self.case()
                original = case.unknown_with_three_queries()
                case.now = original["sent_at"] + 120
                if operation == "_complete":
                    case.holdings["b"] = [fixtures.position("SHORT", "2")]
                action = getattr(case.controller, operation)
                def changed(*args, **kwargs):
                    self.emit(case, original)
                    return action(*args, **kwargs)
                with patch.object(case.controller, operation, side_effect=changed):
                    case.tick()
                self.assertEqual(len(case.sent), 1)
                self.assertNotEqual(case.state()["status"], "completed")
                self.assertEqual(case.state()["batches"][0]["receipt"]["status"], "NEW")

    def test_completed_watch_captures_during_quota_wait_then_tracks_original_until_terminal(self):
        case = self.case()
        original = self.completed_unknown(case)
        case.tick(10)
        with patch.object(case.controller, "_read", side_effect=BudgetWait("watch wait", retry_after=120)):
            case.tick(10)
        deadline = case.state()["watch_after"]
        case.now += 1
        self.emit(case, original)
        calls, reads = case.brokers["b"].query.call_count, len(case.reads)
        case.tick()
        self.assertEqual(case.state()["batches"][0]["receipt"]["status"], "NEW")
        self.assertEqual(case.brokers["b"].query.call_count, calls)
        self.assertEqual(len(case.reads), reads)
        case.now = deadline
        case.controller = adl.AdlController(case.engine)
        case.tick()
        case.tick(30)
        self.assertGreater(case.brokers["b"].query.call_count, calls)
        self.assertEqual(len(case.reads), reads)
        case.now += 1
        self.emit(case, original, "CANCELED")
        case.tick(10)
        self.assertEqual(case.state()["batches"][0]["state"], "terminal")
        self.assertGreater(len(case.reads), reads)

    def test_new_adl_incident_inherits_late_active_original_order(self):
        case = self.case()
        original = self.completed_unknown(case)
        case.now += 1
        self.emit(case, original)
        case.tick()
        parent = case.state()["id"]
        case.observe(quantity="2")
        case.tick(1)
        incident = case.state()
        self.assertEqual(incident["parent_id"], parent)
        carried = next(item for item in incident["prior_orders"] if item["order"] == original["order"])
        self.assertEqual(carried["receipt"]["status"], "NEW")
        self.assertNotEqual(incident["status"], "completed")
        self.assertEqual(len(case.sent), 2)

    def test_older_unknown_batch_reactivated_before_completion_keeps_original_id_tracking(self):
        case = self.case()
        original = case.unknown_with_three_queries()
        case.now = original["sent_at"] + 120
        case.submit_unknown = False
        case.snapshot_filled = True
        case.tick()
        self.assertEqual(len(case.sent), 2)
        case.now += 1
        self.emit(case, original)
        calls = case.brokers["b"].query.call_count
        case.tick()
        case.tick(2)
        self.assertGreater(case.brokers["b"].query.call_count, calls)
        self.assertEqual(case.brokers["b"].query.call_args.args, (original["order"]["symbol"], original["order"]["newClientOrderId"]))
        self.assertNotEqual(case.state()["status"], "completed")
        self.assertEqual(len(case.sent), 2)
        case.now += 1
        self.emit(case, original, "CANCELED")
        case.tick()
        self.assertEqual(case.state()["status"], "completed")

    def test_stream_fill_needs_position_projection_before_completing(self):
        case = self.case()
        original = case.unknown_with_three_queries()
        case.now = original["sent_at"] + 120
        self.emit(case, original, "FILLED")
        calls = case.brokers["b"].query.call_count
        case.tick()
        self.assertEqual(case.brokers["b"].query.call_count, calls)
        self.assertNotEqual(case.state()["status"], "completed")
        self.assertEqual(len(case.sent), 1)
        case.holdings["b"] = [fixtures.position("SHORT", "2")]
        case.position_updates["b"][fixtures.SYMBOL, "SHORT"] = case.now
        case.tick(10)
        self.assertEqual(case.state()["status"], "completed")
        self.assertEqual(len(case.sent), 1)

    def test_receipt_cas_conflict_keeps_newer_incident_journal(self):
        case = self.case()
        original = case.unknown_with_three_queries()
        self.emit(case, original)
        read = case.brokers["b"].order_event_receipt
        def concurrent(order, **options):
            result = read(order, **options)
            latest = case.state()
            latest["reason"] = "newer incident journal"
            case.store.put("adl_pair:pair", latest)
            return result
        with patch.object(case.brokers["b"], "order_event_receipt", side_effect=concurrent):
            with self.assertRaises(adl.AdlStateConflict):
                case.tick()
        self.assertEqual(case.state()["reason"], "newer incident journal")
        self.assertIsNone(case.state()["batches"][0].get("receipt"))
        self.assertEqual(len(case.sent), 1)


if __name__ == "__main__":
    unittest.main()

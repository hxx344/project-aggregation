from copy import deepcopy
import json
import unittest
from unittest.mock import Mock, patch

from trading.adl_events import parse_rest, parse_ws, scan_force_orders
from trading.exchange import ExchangeError, RequestNotSent
from trading.models import TradingError


STAMP = 1_750_000_000_000
NOW = STAMP / 1000


def ws_event(**changes):
    order = {"s": "XAUUSD1", "i": 123456789012345678, "c": "adl_autoclose",
             "ps": "LONG", "S": "SELL", "q": "2", "z": "2", "l": "1",
             "X": "FILLED", "x": "TRADE", "T": STAMP - 1, "ap": "2500"}
    order.update(changes)
    return {"e": "ORDER_TRADE_UPDATE", "E": STAMP, "T": STAMP - 1, "o": order}


def rest_row(**changes):
    row = {"symbol": "XAUUSD1", "orderId": 123456789012345678, "clientOrderId": "adl_autoclose",
           "positionSide": "LONG", "side": "SELL", "origQty": "2", "executedQty": "2",
           "status": "FILLED", "time": STAMP - 100, "updateTime": STAMP - 1,
           "avgPrice": "2500", "type": "LIMIT", "reduceOnly": False}
    row.update(changes)
    return row


class AdlEventParsingTests(unittest.TestCase):
    def test_websocket_and_rest_normalize_same_order_without_float_quantities(self):
        ws = parse_ws(ws_event(), now=NOW)
        rest = parse_rest(rest_row(orderId="123456789012345678"), now=NOW)
        self.assertEqual(ws["order_id"], "123456789012345678")
        for field in ("symbol", "order_id", "position_side", "side", "executed_qty",
                      "original_qty", "avg_price", "status", "event_at", "confirmed"):
            self.assertEqual(ws[field], rest[field], field)
        self.assertEqual(ws["source"], "websocket")
        self.assertEqual(rest["source"], "rest")
        self.assertEqual(rest["order_at"], (STAMP - 100) / 1000)
        json.dumps([ws, rest], allow_nan=False)

    def test_zero_filled_new_adl_is_only_a_candidate(self):
        for quantity in ("0", "2"):
            ws = parse_ws(ws_event(X="NEW_ADL", x="NEW", q=quantity, z="0", l="0", ap="0"), now=NOW)
            rest = parse_rest(rest_row(status="NEW_ADL", origQty=quantity, executedQty="0", avgPrice="0"), now=NOW)
            for result in (ws, rest):
                self.assertIsNotNone(result)
                self.assertFalse(result["confirmed"])
                self.assertIsNone(result["avg_price"])

    def test_short_closing_side_and_both_are_preserved(self):
        for side, position in (("BUY", "SHORT"), ("BUY", "BOTH"), ("SELL", "BOTH")):
            with self.subTest(side=side, position=position):
                ws = parse_ws(ws_event(S=side, ps=position), now=NOW)
                rest = parse_rest(rest_row(side=side, positionSide=position), now=NOW)
                self.assertEqual(ws["position_side"], position)
                self.assertEqual(rest["position_side"], position)

    def test_adl_does_not_require_liquidation_type_or_reduce_only(self):
        for kind in ("LIMIT", "MARKET", "LIQUIDATION"):
            ws = parse_ws(ws_event(o=kind, R=False), now=NOW)
            rest = parse_rest(rest_row(type=kind, reduceOnly=False), now=NOW)
            self.assertTrue(ws["confirmed"])
            self.assertTrue(rest["confirmed"])

    def test_only_exact_adl_marker_is_accepted(self):
        for client_id in ("autoclose-123", "adl_autoclose-1", "ADL_autoclose", None, ""):
            self.assertIsNone(parse_ws(ws_event(c=client_id), now=NOW))
            with self.assertRaises(TradingError):
                parse_rest(rest_row(clientOrderId=client_id), now=NOW)
        for event in (None, [], {}, {"e": "ACCOUNT_UPDATE"}, {"e": "ORDER_TRADE_UPDATE", "o": []}):
            self.assertIsNone(parse_ws(event, now=NOW))
        for row in (None, [], {}):
            with self.assertRaises(TradingError):
                parse_rest(row, now=NOW)

    def test_invalid_identity_quantity_direction_and_status_are_rejected(self):
        variants = [("s", "symbol", "xauusd1"), ("s", "symbol", "XAU USD1"),
                    ("i", "orderId", True), ("i", "orderId", 1.5), ("i", "orderId", "1e3"),
                    ("i", "orderId", 0), ("i", "orderId", 2 ** 63),
                    ("ps", "positionSide", "UNKNOWN"), ("S", "side", "BUY"),
                    ("q", "origQty", "NaN"), ("q", "origQty", "-2"),
                    ("z", "executedQty", "Infinity"), ("z", "executedQty", True),
                    ("z", "executedQty", "-1"), ("z", "executedQty", "3"),
                    ("z", "executedQty", "1e101"), ("X", "status", "UNKNOWN"),
                    ("X", "status", "NEW"), ("X", "status", "REJECTED"),
                    ("X", "status", "PARTIALLY_FILLED"),
                    ("ap", "avgPrice", "NaN"), ("ap", "avgPrice", "-1")]
        for ws_field, rest_field, value in variants:
            with self.subTest(field=ws_field, value=value):
                self.assertIsNone(parse_ws(ws_event(**{ws_field: value}), now=NOW))
                with self.assertRaises(TradingError):
                    parse_rest(rest_row(**{rest_field: value}), now=NOW)

    def test_last_fill_cannot_exceed_cumulative_and_partial_or_canceled_fills_survive(self):
        for value in ("3", "-1", "NaN", None, True):
            self.assertIsNone(parse_ws(ws_event(l=value), now=NOW))
        for status in ("PARTIALLY_FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "NEW_ADL"):
            event = ws_event(X=status, q="2", z="0.123456789012345678901234567890", l="0.01")
            result = parse_ws(event, now=NOW)
            self.assertTrue(result["confirmed"])
            self.assertEqual(result["executed_qty"], "0.123456789012345678901234567890")
        self.assertIsNone(parse_ws(ws_event(q="0", z="1"), now=NOW))
        self.assertIsNone(parse_ws(ws_event(z="0", l="0"), now=NOW))

    def test_timestamp_types_and_future_times_are_rejected_but_history_is_kept(self):
        for field in ("E", "T", "order_time"):
            for value in (None, True, -1, 0, float(STAMP), str(STAMP) + ".0", STAMP + 1001):
                with self.subTest(field=field, value=value):
                    event = ws_event()
                    (event["o"] if field == "order_time" else event)["T" if field == "order_time" else field] = value
                    self.assertIsNone(parse_ws(event, now=NOW))
        for field in ("time", "updateTime"):
            for value in (None, True, -1, float(STAMP), STAMP + 1001):
                with self.subTest(field=field, value=value), self.assertRaises(TradingError):
                    parse_rest(rest_row(**{field: value}), now=NOW)
        with self.assertRaises(TradingError):
            parse_rest(rest_row(time=STAMP), now=NOW)
        self.assertIsNotNone(parse_ws(ws_event(), now=NOW + 30 * 86400))
        self.assertTrue(parse_rest(rest_row(), now=NOW + 30 * 86400)["confirmed"])

    def test_duplicate_and_out_of_order_events_are_pure_evidence_without_in_memory_watermark(self):
        first = ws_event(X="PARTIALLY_FILLED", z="1", l="1")
        original = deepcopy(first)
        self.assertEqual(parse_ws(first, now=NOW), parse_ws(first, now=NOW))
        self.assertEqual(first, original)
        self.assertEqual(parse_ws(ws_event(), now=NOW)["executed_qty"], "2")
        self.assertEqual(parse_ws(first, now=NOW)["executed_qty"], "1")
        self.assertNotEqual(parse_ws(ws_event(i=1), now=NOW)["order_id"],
                            parse_ws(ws_event(i=2), now=NOW)["order_id"])


class ForceOrderScanTests(unittest.TestCase):
    def setUp(self):
        self.api = Mock()
        self.clock = patch("trading.adl_events.time.time", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def test_short_page_finishes_window_and_queries_full_account_with_correct_weight(self):
        windows = [[STAMP - 1000, STAMP]]
        self.api.call.return_value = [rest_row()]
        result = scan_force_orders(self.api, windows)
        self.assertEqual(result["remaining"], [])
        self.assertEqual(len(result["events"]), 1)
        self.assertIsNone(result["error"])
        self.assertIsNone(result["blocked"])
        self.assertEqual(windows, [[STAMP - 1000, STAMP]])
        self.api.call.assert_called_once_with("GET", "/fapi/v3/forceOrders",
            {"autoCloseType": "ADL", "startTime": STAMP - 1000, "endTime": STAMP, "limit": 100},
            signed=True, weight=50)

    def test_full_page_is_kept_and_split_with_overlap_then_resumed(self):
        page = [rest_row(orderId=i + 1) for i in range(100)]
        self.api.call.side_effect = [page, [], [rest_row()]]
        first = scan_force_orders(self.api, [[STAMP - 1000, STAMP]], request_limit=2)
        self.assertEqual(len(first["events"]), 100)
        self.assertEqual(first["remaining"], [[STAMP - 500, STAMP]])
        self.assertEqual(self.api.call.call_count, 2)
        self.assertEqual(self.api.call.call_args_list[1].args[2]["endTime"], STAMP - 500)
        second = scan_force_orders(self.api, first["remaining"])
        self.assertEqual(second["remaining"], [])
        self.assertEqual(len(second["events"]), 1)
        self.assertEqual(first["remaining"], [[STAMP - 500, STAMP]])

    def test_minimal_full_window_is_blocked_and_preserved_even_with_duplicates(self):
        self.api.call.return_value = [rest_row()] * 100
        for width in (0, 1):
            with self.subTest(width=width):
                windows = [[STAMP - width, STAMP], [STAMP, STAMP + 1]]
                result = scan_force_orders(self.api, windows, request_limit=10)
                self.assertEqual(result["remaining"], windows)
                self.assertEqual(len(result["events"]), 100)
                self.assertIsNotNone(result["blocked"])
                self.assertIsNone(result["error"])

    def test_failure_preserves_prior_progress_and_redacts_exception_message(self):
        error = RuntimeError("signature=secret&user=private")
        error.retry_after = 42.5
        self.api.call.side_effect = [[rest_row()], error]
        windows = [[STAMP - 1000, STAMP - 500], [STAMP - 500, STAMP]]
        result = scan_force_orders(self.api, windows)
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["remaining"], windows[1:])
        self.assertEqual(result["retry_after"], 42.5)
        self.assertNotIn("secret", result["error"])
        self.assertNotIn("private", result["error"])
        self.assertIsNone(result["blocked"])

    def test_failure_after_split_retains_children_and_evidence(self):
        self.api.call.side_effect = [[rest_row()] * 100, RuntimeError("network")]
        result = scan_force_orders(self.api, [[STAMP - 1000, STAMP]])
        self.assertEqual(len(result["events"]), 100)
        self.assertEqual(result["remaining"], [[STAMP - 1000, STAMP - 500], [STAMP - 500, STAMP]])
        self.assertIsNotNone(result["error"])

    def test_budget_rejection_and_rate_limit_keep_retry_delay_and_pending_window(self):
        for error in (RequestNotSent("local budget", retry_after=2.5),
                      ExchangeError("remote cooldown", retry_after=180, http_status=429)):
            with self.subTest(error=type(error).__name__):
                self.api.call.side_effect = error
                result = scan_force_orders(self.api, [[STAMP - 1000, STAMP]])
                self.assertEqual(result["remaining"], [[STAMP - 1000, STAMP]])
                self.assertEqual(result["retry_after"], error.retry_after)
                self.assertEqual(result["events"], [])
                self.assertIsNotNone(result["error"])

    def test_malformed_response_never_advances_window(self):
        for rows in ({"code": 0}, None, "[]", [rest_row()] * 101,
                     [rest_row(), rest_row(clientOrderId="autoclose-1"), rest_row(orderId=2)]):
            with self.subTest(rows_type=type(rows).__name__):
                self.api.call.return_value = rows
                result = scan_force_orders(self.api, [[STAMP - 1000, STAMP]])
                self.assertEqual(result["remaining"], [[STAMP - 1000, STAMP]])
                self.assertIsNotNone(result["error"])
        self.assertEqual(len(result["events"]), 2)

    def test_invalid_retry_delays_are_ignored(self):
        for delay in (None, True, -1, "NaN", float("inf"), "broken"):
            error = RuntimeError("redacted")
            error.retry_after = delay
            self.api.call.side_effect = error
            result = scan_force_orders(self.api, [[STAMP - 1000, STAMP]])
            self.assertEqual(result["retry_after"], 0)

    def test_zero_budget_and_empty_queue_make_no_request_and_invalid_input_raises(self):
        windows = [[STAMP - 1000, STAMP]]
        result = scan_force_orders(self.api, windows, request_limit=0)
        self.assertEqual(result["remaining"], windows)
        self.assertEqual(scan_force_orders(self.api, [])["remaining"], [])
        self.api.call.assert_not_called()
        for value in (-1, True, 1.5):
            with self.assertRaises(TradingError):
                scan_force_orders(self.api, windows, request_limit=value)
        for value in (None, {}, [[1]], [[2, 1]], [[True, 2]], [[0, float(STAMP)]]):
            with self.assertRaises(TradingError):
                scan_force_orders(self.api, value)
        self.api.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()

"""Offline contract tests against the current official Omni frontend field map."""
import copy
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("positions_helper", Path(__file__).resolve().parents[1] / "scripts" / "variational-diagnostic.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
TOKEN = "synthetic.var.positions"


def position(qty="1.000000000000000001", instrument_type="perpetual_future"):
    return {"position_info": {"qty": qty, "avg_entry_price": "90000.123456789012345678", "updated_at": "2026-10-01T00:00:00Z",
                              "company": "private-company", "pool_location": "private-pool", "counterparty": "private-counterparty",
                              "instrument": {"underlying": "BTC", "instrument_type": instrument_type, "settlement_asset": "USDC"}},
            "price_info": {"price": "91000.000000000000000001"}, "upnl": "-0.123456789012345678",
            "value": "-91000.123456789012345678", "estimated_liquidation_price": "50000.001", "token": TOKEN}


class Response(io.BytesIO):
    def __init__(self, value, status=200):
        super().__init__(json.dumps(value).encode())
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"

    def getcode(self):
        return self.status


class Opener:
    def __init__(self, value, status=200):
        self.value, self.status, self.calls = value, status, []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        return Response(self.value, self.status)


class PositionsTests(unittest.TestCase):
    def test_current_official_positions_path_is_one_fixed_get(self):
        opener = Opener([position()])
        result = helper.probe(TOKEN, opener, "sync-positions")
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(result["path"], "/api/positions")
        self.assertEqual(len(opener.calls), 1)
        request, timeout = opener.calls[0]
        self.assertEqual(request.full_url, "https://omni.variational.io/api/positions")
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(timeout, 20)
        self.assertEqual(request.get_header("Cookie"), "vr-token=" + TOKEN)
        payload = json.dumps(result)
        for secret in (TOKEN, "private-company", "private-pool", "private-counterparty"):
            self.assertNotIn(secret, payload)

    def test_precision_sides_optional_values_and_official_instrument_types(self):
        for instrument_type in ("perpetual_future", "perpetual_rwa_future", "perpetual_cfd", "swap"):
            with self.subTest(instrument_type=instrument_type):
                normalized = helper.normalize_positions([position("-1.000000000000000001", instrument_type)])[0]
                self.assertEqual(normalized["quantity"], "1.000000000000000001")
                self.assertEqual(normalized["side"], "short")
                self.assertEqual(normalized["quantityUnit"], "BTC")
                self.assertEqual(normalized["entryPrice"], "90000.123456789012345678")
                self.assertEqual(normalized["markPrice"], "91000.000000000000000001")
                self.assertEqual(normalized["notional"], "91000.123456789012345678")
                self.assertEqual(normalized["unrealizedPnl"], "-0.123456789012345678")
                self.assertEqual(normalized["pnlCurrency"], "USDC")
                self.assertEqual(normalized["liquidationPrice"], "50000.001")
                self.assertEqual(normalized["sourceUpdatedAt"], "2026-10-01T00:00:00.000Z")
        raw = position()
        for field in ("price_info", "upnl", "value", "estimated_liquidation_price"):
            raw.pop(field)
        normalized = helper.normalize_positions([raw])[0]
        for field in ("markPrice", "notional", "unrealizedPnl", "liquidationPrice", "leverage"):
            self.assertIsNone(normalized[field])

    def test_only_explicit_array_success_is_flat_and_zero_positions_are_excluded(self):
        for value in ([], [position("0")]):
            result = helper.probe(TOKEN, Opener(value), "sync-positions")
            self.assertEqual(result["outcome"], "ok")
            self.assertEqual(result["positions"], [])
        for value in ({}, {"positions": []}, {"result": [], "pagination": {}}, None, [position(), {}], [position(), position()]):
            result = helper.probe(TOKEN, Opener(value), "sync-positions")
            self.assertEqual(result["outcome"], "invalid_data")
            self.assertIsNone(result["positions"])

    def test_invalid_financial_data_and_unrecognized_instruments_fail_whole_snapshot(self):
        for value in (True, 1.25, "NaN", "Infinity", "1e-8", ""):
            raw = position(); raw["position_info"]["qty"] = value
            with self.assertRaises(ValueError):
                helper.normalize_positions([position(), raw])
        for mutation in (lambda p: p["position_info"]["instrument"].update(instrument_type="unknown"),
                         lambda p: p["position_info"].update(updated_at="2026-10-01T00:00:00"),
                         lambda p: p.update(price_info=[])):
            raw = position(); mutation(raw)
            with self.assertRaises(ValueError):
                helper.normalize_positions([raw])

    def test_instrument_identity_includes_chain_token_details_and_preserves_duplicate_underlyings(self):
        first = position()
        second = copy.deepcopy(first)
        second["position_info"]["instrument"]["dex_token_details"] = {"network": "ethereum", "address": "0x123"}
        result = helper.normalize_positions([first, second])
        self.assertNotEqual(result[0]["id"], result[1]["id"])
        self.assertNotEqual(result[0]["instrumentId"], result[1]["instrumentId"])

    def test_upstream_auth_failures_and_private_bodies_do_not_escape(self):
        for status, outcome in ((401, "unauthorized"), (403, "forbidden"), (429, "rate_limited"), (500, "network_error")):
            result = helper.probe(TOKEN, Opener({"positions": [position()], "private": TOKEN}, status), "sync-positions")
            self.assertEqual(result["outcome"], outcome)
            self.assertIsNone(result["positions"])
            self.assertNotIn(TOKEN, json.dumps(result))


if __name__ == "__main__":
    unittest.main()

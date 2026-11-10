import json
import tempfile
import time
import unittest
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

from trading.margin_balance import DEFAULT_MARGIN, MarginBalancer, validate_margin
from trading.margin_archive import add_note, archive_view
from trading.models import TradingError
from trading.store import Store
from tests.test_pair_margin import snapshot


class AbsoluteReserveTests(unittest.TestCase):
    def plan(self, long="3000", short="1000", **config):
        balances = {"long": snapshot(long), "short": snapshot(short)}
        return MarginBalancer._plan({}, {}, balances, {**DEFAULT_MARGIN, **config}, {"long": long, "short": short})

    def test_defaults_keep_legacy_plan_and_both_directions_use_their_reserve(self):
        self.assertFalse(validate_margin({})["absolute_reserve_enabled"])
        self.assertEqual(self.plan()["amount"], "1000.00000000")
        self.assertEqual(self.plan(long_reserve="2900")["amount"], "1000.00000000")
        self.assertEqual(self.plan(absolute_reserve_enabled=True, long_reserve="2900")["amount"], "100.00000000")
        reversed_plan = self.plan("1000", "3000", absolute_reserve_enabled=True, short_reserve="2950")
        self.assertEqual((reversed_plan["source"], reversed_plan["amount"]), ("short", "50.00000000"))

    def test_stricter_proportion_withdraw_limit_and_floor_win(self):
        balances = {"long": snapshot("3000"), "short": snapshot("1000")}
        cfg = {**DEFAULT_MARGIN, "absolute_reserve_enabled": True, "long_reserve": "1", "buffer_ratio": "0.99"}
        self.assertEqual(MarginBalancer._plan({}, {}, balances, cfg, {"long": "3000", "short": "1000"})["amount"], "30.00000000")
        self.assertEqual(MarginBalancer._plan({}, {}, balances, cfg, {"long": "0.123456789", "short": "1000"}, diagnostics={}), None)
        self.assertIsNone(self.plan(absolute_reserve_enabled=True, long_reserve="3000"))
        self.assertIsNone(self.plan("0", "-100", absolute_reserve_enabled=True, long_reserve="1"))
        balances["long"] = replace(balances["long"], equity=Decimal("-1"))
        cfg.update(long_reserve="2990")
        self.assertEqual(MarginBalancer._plan({}, {}, balances, cfg, {"long": "3", "short": "1000"})["amount"], "3.00000000")

    def test_invalid_values_and_stale_snapshots_remain_rejected(self):
        for config in ({"long_reserve": "-1"}, {"short_reserve": "NaN"}, {"long_reserve": "1000000001"}, {"absolute_reserve_enabled": 1}):
            with self.assertRaises(TradingError):
                validate_margin(config)
        balances = {"long": replace(snapshot("3000"), timestamp=time.time() - 30), "short": snapshot("1000")}
        with self.assertRaises(TradingError):
            MarginBalancer._check_snapshots({}, balances)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / "test.db")
        self.pair = {"id": "pair", "long_account_id": "a", "short_account_id": "b"}
        with self.store.connect() as db:
            db.execute("INSERT INTO pairs(id,data) VALUES (?,?)", ("pair", json.dumps(self.pair)))
        self.archive = {"pair_id": "pair", "original": {"request_id": "request", "source": "long", "destination": "short", "amount": "2", "created_at": 100, "status": "unknown", "identity": "SECRET_IDENTITY", "signature": "SECRET_SIGNATURE"},
            "result": {"status": "skipped", "skipped_at": 200}, "baseline": {"long": {"account_id": "a", "timestamp": 180}, "short": {"account_id": "b", "timestamp": 185}},
            "settlement": {"outcome": "rejected", "basis": "nonce_expired_unreadable", "settled_at": 300}}
        self.store.put("pair_margin_skipped:pair:request", self.archive)
        self.store.put("pair_margin:pair", {"pending": {"request_id": "other"}, "unsettled_transfers": ["protected"]})

    def test_notes_never_mutate_receipts_or_unlock_and_evidence_is_whitelisted(self):
        before = self.store.get("pair_margin:pair")
        add_note(self.store, "pair", "request", note="已联系交易所核对", source="工单123")
        with self.store.read_snapshot() as reader:
            result = archive_view(reader, "pair")
        self.assertIn("未知", result["items"][0]["basis"])
        self.assertEqual(result["items"][0]["notes"][0]["actor"], "authenticated_admin")
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(self.store.get("pair_margin:pair"), before)
        self.assertEqual(self.store.get("pair_margin_skipped:pair:request"), self.archive)

    def test_partial_and_late_receipts_remain_correlated_to_original(self):
        for basis, evidence in (("nonce_expired_partial_receipt", [["long", "TRANSFER", "debit"]]), ("late_receipt_confirmed", [["long", "TRANSFER", "debit"], ["short", "TRANSFER", "credit"]])):
            self.archive["settlement"].update(basis=basis, evidence=evidence)
            self.store.put("pair_margin_skipped:pair:request", self.archive)
            view = archive_view(self.store, "pair")["items"][0]
            self.assertEqual(view["request_id"], "request")
            self.assertEqual(len(view["receipts"]), len(evidence))

    def test_pair_rebinding_and_unknown_request_cannot_access_old_notes(self):
        with self.assertRaises(TradingError):
            add_note(self.store, "pair", "another", note="note", source="source")
        self.pair["long_account_id"] = "new"
        with self.store.connect() as db:
            db.execute("UPDATE pairs SET data=? WHERE id='pair'", (json.dumps(self.pair),))
        self.assertEqual(archive_view(self.store, "pair")["items"], [])
        with self.assertRaises(TradingError):
            add_note(self.store, "pair", "request", note="note", source="source")


if __name__ == "__main__":
    unittest.main()

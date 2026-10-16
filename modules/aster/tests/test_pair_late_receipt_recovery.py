"""Late private order events must survive recovery reads and cache expiry."""
from copy import deepcopy
import json
import time
import unittest
from unittest.mock import patch

from tests import test_pair_order_recovery as fixtures
from tests import test_pair_bounded_recovery as bounded
from tests.test_cycle_account_snapshot import ACCOUNT, RISK, risk_row
from trading.exchange import SnapshotSuperseded
from trading.models import TradingError, dec, wire
from trading.pair_execution import PairTrader
from trading.pair_planning import PairPositionError
from trading import pair_recovery
from trading.user_stream import PrivateAccountStream


class PairLateReceiptRecoveryTests(unittest.TestCase):
    tearDown = bounded.PairBoundedLiveTests.tearDown
    seed = bounded.PairBoundedLiveTests.seed
    state = bounded.PairBoundedLiveTests.state
    broker = bounded.PairBoundedLiveTests.broker
    no_writes = bounded.PairBoundedLiveTests.no_writes
    ready = bounded.PairBoundedLiveTests.ready
    setup_trader = bounded.PairBoundedLiveTests.setup_trader

    def setUp(self):
        bounded.PairBoundedLiveTests.setUp(self)
        network = patch("httpx.Client.request", side_effect=AssertionError("live HTTP forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def prepare(self):
        self.ready()
        with patch.object(PrivateAccountStream, "start"):
            for broker in self.live.values():
                if broker.cycle_stream is None:
                    broker.start_cycle_hot_data([fixtures.SYMBOL])
                    broker.cycle_stream._set_connected(True)
                    self.addCleanup(broker.stop_cycle_hot_data)
                else:
                    broker._private_evidence.reset(True)
                broker.api.calls.clear()
        return deepcopy(self.state()["pending"])

    def emit(self, pending, status, *, side=None):
        for index, leg in enumerate(pending["legs"]):
            if side is not None and leg["key"] != side:
                continue
            broker, order = self.broker(leg["key"]), leg["order"]
            quantity = {"NEW": "0", "PARTIALLY_FILLED": "0.1", "FILLED": order["quantity"]}[status]
            rows = broker.api.responses[ACCOUNT]["positions"]
            for row in rows:
                if row["symbol"] == fixtures.SYMBOL and row["positionSide"] == order["positionSide"]:
                    amount = dec(pending["before"][order["positionSide"]]) + dec(quantity)
                    row["positionAmt"] = wire(amount if order["positionSide"] == "LONG" else -amount)
            broker.api.responses[RISK] = [risk_row(row) for row in rows]
            stamp = int(time.time() * 1000)
            event = {"e": "ORDER_TRADE_UPDATE", "E": stamp, "T": stamp,
                "o": {"s": order["symbol"], "c": order["newClientOrderId"], "S": order["side"],
                      "ps": order["positionSide"], "o": "MARKET", "ot": "MARKET", "q": order["quantity"],
                      "i": 123 + index, "X": status, "x": "TRADE", "z": quantity,
                      "ap": "100" if dec(quantity) else "0", "T": stamp}}
            broker.cycle_stream._handle_message(json.dumps(event))
            self.assertEqual(broker.order_event_receipt(order, include_active=True)["status"], status)

    def during_read(self, pending, status, timing):
        original = self.engine.pairs._read_members

        def read(*args, **kwargs):
            if timing == "before_snapshot":
                self.emit(pending, status)
            result = original(*args, **kwargs)
            if timing in {"after_snapshot", "failed_snapshot"}:
                self.emit(pending, status)
            if timing == "failed_snapshot":
                raise SnapshotSuperseded("order event revoked the completed reads")
            return result

        return patch.object(self.engine.pairs, "_read_members", side_effect=read)

    def assert_retained(self, pending, status):
        saved = self.state()
        self.assertIsNotNone(saved["pending"], saved["reason"])
        self.assertEqual(saved["pending"]["id"], pending["id"])
        self.assertEqual([leg["receipt"]["status"] for leg in saved["pending"]["legs"]], [status, status])
        self.assertEqual(saved["owned"], pending["before"])
        self.assertIsNone(saved.get("recovery_watch"))
        self.assertIsNone(self.f.store.get("pair_batch:" + pending["id"]))
        self.assertIsNone(self.f.store.get("pair_order_recovery:gold:" + pending["id"]))

    def test_late_active_receipts_survive_snapshot_timing_expiry_and_trader_restart(self):
        for timing in ("before_snapshot", "after_snapshot", "failed_snapshot"):
            for status in ("NEW", "PARTIALLY_FILLED"):
                with self.subTest(timing=timing, status=status):
                    pending = self.prepare()
                    with self.no_writes(), self.during_read(pending, status, timing):
                        self.engine.pairs.tick("gold")
                    self.assert_retained(pending, status)
                    for broker in self.live.values():
                        self.assertFalse(any(call[1] == "/fapi/v3/order" for call in broker.api.calls))
                    self.setup_trader()
                    later = time.time() + 31
                    with patch("time.time", return_value=later), self.no_writes(), \
                            patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("active order")):
                        for leg in pending["legs"]:
                            self.assertIsNone(self.broker(leg["key"]).order_event_receipt(leg["order"], include_active=True))
                        self.engine.pairs.tick("gold")
                    self.assert_retained(pending, status)
                    for broker in self.live.values():
                        self.assertEqual(sum(call[1] == "/fapi/v3/order" for call in broker.api.calls), 1)

    def test_manual_preview_and_confirmation_restore_late_receipts(self):
        for action in ("preview", "confirm"):
            for timing in ("before_snapshot", "after_snapshot", "failed_snapshot"):
                with self.subTest(action=action, timing=timing):
                    pending = self.prepare()
                    review = self.engine.pairs.preview_recovery("gold") if action == "confirm" else None
                    with self.no_writes(), self.during_read(pending, "PARTIALLY_FILLED", timing):
                        if action == "preview":
                            result = self.engine.pairs.preview_recovery("gold")
                            self.assertEqual(result["status"], "receipts_found")
                        else:
                            with self.assertRaisesRegex(TradingError, "已找回原订单真实回执"):
                                self.engine.pairs.confirm_recovery("gold", review["token"], acknowledge_unknown=True)
                    self.assert_retained(pending, "PARTIALLY_FILLED")

    def test_late_terminal_receipts_follow_normal_fill_accounting_on_next_tick(self):
        pending = self.prepare()
        with self.no_writes(), self.during_read(pending, "FILLED", "after_snapshot"):
            self.engine.pairs.tick("gold")
        self.assert_retained(pending, "FILLED")
        with self.no_writes():
            self.engine.pairs.tick("gold")
        saved = self.state()
        self.assertIsNone(saved["pending"], saved["reason"])
        self.assertTrue(saved["last_batch"]["completed"])
        self.assertFalse(saved.get("volume_unknown", False))
        self.assertIsNone(saved.get("recovery_watch"))

    def test_snapshot_risk_does_not_discard_late_positive_receipts(self):
        pending = self.prepare()
        with self.no_writes(), self.during_read(pending, "NEW", "before_snapshot"), \
                patch.object(PairTrader, "_risk_snapshots", side_effect=AssertionError("save receipts before risk")):
            self.engine.pairs.tick("gold")
        self.assert_retained(pending, "NEW")

    def test_events_after_cache_recheck_survive_risk_or_final_commit_failure(self):
        for failure in ("risk", "commit"):
            with self.subTest(failure=failure):
                pending = self.prepare()
                commit = pair_recovery._commit_runtime

                def fail_risk(*args, **kwargs):
                    self.emit(pending, "NEW")
                    raise PairPositionError("full account risk remains excessive")

                def late_commit(engine, pair, runtime, **kwargs):
                    if runtime.get("pending") is None:
                        self.emit(pending, "NEW")
                    return commit(engine, pair, runtime, **kwargs)

                injection = (patch.object(PairTrader, "_risk_snapshots", side_effect=fail_risk)
                             if failure == "risk" else patch.object(pair_recovery, "_commit_runtime", side_effect=late_commit))
                with self.no_writes(), injection:
                    self.engine.pairs.tick("gold")
                self.assert_retained(pending, "NEW")
                later = time.time() + 31
                with patch("time.time", return_value=later), self.no_writes(), \
                        patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("active order")):
                    self.engine.pairs.tick("gold")
                self.assert_retained(pending, "NEW")

    def test_manual_final_commit_rechecks_event_and_only_restores_pending(self):
        pending = self.prepare()
        review = self.engine.pairs.preview_recovery("gold")
        recovery = self.engine.pairs.recovery
        commit = recovery._commit

        def late_commit(read, runtime, *args, **kwargs):
            if runtime.get("pending") is None:
                self.emit(pending, "NEW")
            return commit(read, runtime, *args, **kwargs)

        with self.no_writes(), patch.object(recovery, "_commit", side_effect=late_commit), \
                self.assertRaisesRegex(TradingError, "已找回原订单真实回执"):
            self.engine.pairs.confirm_recovery("gold", review["token"], acknowledge_unknown=True)
        self.assert_retained(pending, "NEW")
        self.assertNotIn("gold", recovery.previews)

    def test_receipt_restore_keeps_compare_and_swap_for_concurrent_runtime_change(self):
        pending = self.prepare()
        original = self.engine.pairs._read_members

        def read(*args, **kwargs):
            result = original(*args, **kwargs)
            self.emit(pending, "NEW")
            changed = self.state()
            changed["owned"]["LONG"] = "99"
            self.f.store.put("pair_runtime:gold", changed)
            return result

        with self.no_writes(), patch.object(self.engine.pairs, "_read_members", side_effect=read):
            self.engine.pairs.tick("gold")
        saved = self.state()
        self.assertEqual(saved["owned"]["LONG"], "99")
        self.assertTrue(all(leg["receipt"] is None for leg in saved["pending"]["legs"]))
        self.assertIsNone(saved.get("recovery_watch"))

    def test_existing_terminal_receipt_is_never_downgraded_by_active_stream_cache(self):
        pending = self.prepare()
        state = self.state()
        terminal = fixtures.receipt_for(pending["legs"][0])
        state["pending"]["legs"][0]["receipt"] = terminal
        self.f.store.put("pair_runtime:gold", state)
        original = self.engine.pairs._read_members

        def read(*args, **kwargs):
            self.emit(pending, "NEW", side="long")
            return original(*args, **kwargs)

        with self.no_writes(), patch.object(self.engine.pairs, "_read_members", side_effect=read):
            self.engine.pairs.tick("gold")
        saved = self.state()
        self.assertIsNone(saved["pending"], saved["reason"])
        batch = self.f.store.get("pair_batch:" + pending["id"])
        self.assertEqual(batch["legs"][0]["receipt"], terminal)
        self.assertIsNone(batch["legs"][1]["receipt"])


if __name__ == "__main__":
    unittest.main()

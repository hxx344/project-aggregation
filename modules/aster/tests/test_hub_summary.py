"""Portal summaries stay small and never initiate exchange/history work."""
from copy import deepcopy
from datetime import datetime, timezone
import time
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.helpers import Fixture, account
from trading.engine import Engine
from trading.hub_summary import hub_summary
from trading.server import create_app
from tests.pair_legacy_fixtures import runtime_default
from trading.pair_planning import LEGACY_ORDERS_REASON
from trading.pairing import validate_pair
from trading.store import _StoreSnapshot


class HubSummaryTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.ready, self.engine.error = True, None
        self.now = time.time()

    def live(self, aid="test", *, enabled=True, margin="12.5", stamp=None):
        saved = account(aid, "live")
        saved["enabled"] = enabled
        self.f.store.save_account(saved)
        self.engine.view(aid, snapshot={"timestamp": self.now if stamp is None else stamp,
                                       "occupied_margin": margin})

    def metrics(self, result):
        return {item["key"]: item["value"] for item in result["data"]["metrics"]}

    def pair(self, *, enabled=True, mode="live"):
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid, mode), "enabled": False})
        self.f.store.save_pair(validate_pair({
            "id": "gold", "name": "黄金配对", "long_account_id": "test", "short_account_id": "second",
            "enabled": enabled,
        }), create=True)
        runtime = {**runtime_default(), "updated_at": self.now,
                   "snapshots": {"long": {"timestamp": self.now - 3, "occupied_margin": "12.5"},
                                 "short": {"timestamp": self.now - 8, "occupied_margin": "17.5"}}}
        self.f.store.put("pair_runtime:gold", runtime)
        return runtime

    def test_enabled_pair_counts_members_and_reads_only_published_runtime(self):
        self.pair()
        with patch.object(self.engine, "state", side_effect=AssertionError("full state")), \
             patch.object(self.engine.pairs, "states", side_effect=AssertionError("full pair state")), \
             patch.object(self.engine, "broker", side_effect=AssertionError("exchange")), \
             patch.object(self.f.market, "book", side_effect=AssertionError("market request")), \
             patch.object(self.f.store, "get", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "accounts", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "pairs", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "read_snapshot", wraps=self.f.store.read_snapshot) as read_snapshot:
            result = hub_summary(self.engine, now=self.now, diagnostics=True)
        read_snapshot.assert_called_once_with()
        self.assertEqual(self.metrics(result), {"accounts": 2, "live_accounts": 2,
                                              "occupied_margin": 30})
        expected = datetime.fromtimestamp(self.now - 8, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(result["data"]["updatedAt"], expected)
        self.assertEqual(result["data"]["health"]["state"], "online")

    def margin_only_pair(self):
        runtime = self.pair()
        pair = self.f.store.pair("gold")
        self.f.store.save_pair({**pair, "margin": {**pair["margin"], "enabled": True}})
        for snapshot in runtime["snapshots"].values():
            snapshot["timestamp"] = self.now - 300
        runtime["margin_balances"] = {
            "long": {"timestamp": self.now - 3, "equity": "200", "available": "90", "wallet": "150"},
            "short": {"timestamp": self.now - 8, "equity": "220", "available": "110", "wallet": "180"},
        }
        runtime["margin"] = {"status": "waiting", "reason": "等待下一次保证金检查", "blocks_trading": False}
        self.f.store.put("pair_runtime:gold", runtime)
        return runtime

    def test_margin_only_uses_published_balances_without_reads_or_runtime_mutation(self):
        runtime = self.margin_only_pair()
        self.engine.view("test", snapshot={"timestamp": self.now - 200, "occupied_margin": "999"})
        self.engine.display_snapshots["second"] = {"timestamp": self.now - 180, "occupied_margin": "999"}
        before = deepcopy(runtime)
        with patch.object(self.engine, "state", side_effect=AssertionError("full state")), \
             patch.object(self.engine.pairs, "states", side_effect=AssertionError("full pair state")), \
             patch.object(self.engine, "broker", side_effect=AssertionError("exchange")), \
             patch.object(self.f.market, "book", side_effect=AssertionError("market request")), \
             patch.object(self.f.store, "get", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "accounts", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "pairs", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.f.store, "read_snapshot", wraps=self.f.store.read_snapshot) as read_snapshot:
            result = hub_summary(self.engine, now=self.now, diagnostics=True)
        read_snapshot.assert_called_once_with()
        self.assertEqual(self.metrics(result), {"accounts": 2, "live_accounts": 2,
                                              "occupied_margin": None})
        margin = next(row for row in result["data"]["metrics"] if row["key"] == "occupied_margin")
        self.assertRegex(margin.get("detail", ""), "[未不]采集")
        self.assertEqual(result["data"]["updatedAt"], datetime.fromtimestamp(
            self.now - 8, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        self.assertEqual(result["data"]["health"]["state"], "online")
        self.assertEqual(result["data"]["diagnostics"], [])
        self.assertEqual(self.f.store.get("pair_runtime:gold"), before)
        legacy = hub_summary(self.engine, now=self.now)
        result["data"].pop("diagnostics")
        self.assertEqual(result, legacy)

    def test_margin_only_balance_timestamps_keep_real_expiry_and_clock_tolerance(self):
        runtime = self.margin_only_pair()
        for timestamp, expected in ((self.now - 119, "online"), (self.now - 120, "stale"),
                                    (self.now + 60, "online"), (self.now + 61, "partial"),
                                    (None, "partial"), (0, "partial"), (True, "partial")):
            with self.subTest(timestamp=timestamp):
                current = deepcopy(runtime)
                current["margin_balances"]["short"]["timestamp"] = timestamp
                self.f.store.put("pair_runtime:gold", current)
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                self.assertEqual(result["data"]["health"]["state"], expected)
                self.assertIsNone(self.metrics(result)["occupied_margin"])
                if expected == "online":
                    self.assertEqual(result["data"]["diagnostics"], [])
                else:
                    self.assertTrue(any(row["kind"] == "fault" for row in result["data"]["diagnostics"]))
                if expected == "stale":
                    self.assertIn("过期", result["data"]["health"]["message"])
                    self.assertEqual(result["data"]["updatedAt"], datetime.fromtimestamp(
                        timestamp, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))

    def test_margin_only_missing_or_invalid_balances_never_borrow_complete_snapshots(self):
        runtime = self.margin_only_pair()
        for snapshot in runtime["snapshots"].values():
            snapshot["timestamp"] = self.now
        valid = runtime["margin_balances"]["short"]
        cases = [None, {}, [], {key: value for key, value in valid.items() if key != "timestamp"}]
        for field in ("equity", "available", "wallet"):
            cases.append({key: value for key, value in valid.items() if key != field})
            cases.extend({**valid, field: value} for value in (None, True, "nan", "Infinity", "invalid"))
        for balance in cases:
            with self.subTest(balance=balance):
                current = deepcopy(runtime)
                current["margin_balances"]["short"] = balance
                self.f.store.put("pair_runtime:gold", current)
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                self.assertEqual(result["data"]["health"]["state"], "partial")
                self.assertIsNone(self.metrics(result)["occupied_margin"])
                self.assertTrue(any(row["kind"] == "fault" for row in result["data"]["diagnostics"]))
        for balances in (None, {}, []):
            with self.subTest(balances=balances):
                self.f.store.put("pair_runtime:gold", {**runtime, "margin_balances": balances})
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                self.assertEqual(result["data"]["health"]["state"], "partial")
                self.assertIsNone(self.metrics(result)["occupied_margin"])

    def test_margin_only_does_not_replace_positions_needed_by_strategy_or_recovery(self):
        runtime = self.margin_only_pair()
        pair = self.f.store.pair("gold")
        cases = [("margin disabled", {}, {"margin": {**pair["margin"], "enabled": False}}),
                 ("pending empty", {"pending": {}}, {}),
                 ("pending order", {"pending": {"kind": "ordinary", "phase": "open"}}, {})]
        cases.extend((f"quantities {quantities}", {"progress": {"quantities": quantities}}, {}) for quantities in (
            {"LONG": "1", "SHORT": "0"}, {"LONG": "0", "SHORT": "-1"},
            {"LONG": "0"}, {"LONG": "0", "SHORT": "nan"},
            {"LONG": "0", "SHORT": True}, {"LONG": "0", "SHORT": "1e-999"},
            {"LONG": "0", "SHORT": "0", "OTHER": "1"}, None))
        for name, changes, configuration in cases:
            with self.subTest(name=name):
                self.f.store.save_pair({**pair, **configuration,
                                       "revision": self.f.store.pair("gold")["revision"]})
                self.f.store.put("pair_runtime:gold", {**deepcopy(runtime), **changes})
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                self.assertEqual(result["data"]["health"]["state"], "stale")
                self.assertEqual(self.metrics(result)["occupied_margin"], 30)
                self.assertIn("账户快照已过期", result["data"]["health"]["message"])

    def test_margin_only_mixed_accounts_do_not_publish_an_incomplete_margin_total(self):
        self.margin_only_pair()
        self.live("standalone", margin="10")
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(self.metrics(result), {"accounts": 3, "live_accounts": 3,
                                              "occupied_margin": None})
        self.assertEqual(result["data"]["health"]["state"], "online")
        self.assertEqual(result["data"]["diagnostics"], [])
        margin = next(row for row in result["data"]["metrics"] if row["key"] == "occupied_margin")
        self.assertRegex(margin.get("detail", ""), "[未不]采集")

    def test_margin_only_latest_durable_read_failure_survives_fresh_balances(self):
        runtime = self.margin_only_pair()
        reason = "账户读取失败：HTTP 500"
        journal = {"checked_at": self.now, "next_check_at": self.now + 10, "blocked_reason": reason}
        self.f.store.put("pair_margin:gold", journal)
        reads = []
        original_get = _StoreSnapshot.get

        def read(reader, key, *args):
            reads.append((id(reader), key))
            return original_get(reader, key, *args)

        with patch.object(_StoreSnapshot, "get", new=read), \
             patch.object(self.f.store, "get", side_effect=AssertionError("outside snapshot")), \
             patch.object(self.engine, "broker", side_effect=AssertionError("new account read")), \
             patch.object(self.f.store, "read_snapshot", wraps=self.f.store.read_snapshot) as read_snapshot:
            result = hub_summary(self.engine, now=self.now, diagnostics=True)
        read_snapshot.assert_called_once_with()
        self.assertEqual(len({identity for identity, _ in reads}), 1)
        self.assertTrue({"pair_runtime:gold", "pair_margin:gold"}.issubset({key for _, key in reads}))
        self.assertEqual(result["data"]["health"]["state"], "partial")
        self.assertIn(reason, result["data"]["health"]["message"])
        self.assertTrue(any(row["kind"] == "fault" and reason in row["message"]
                            for row in result["data"]["diagnostics"]))
        self.assertEqual(self.f.store.get("pair_runtime:gold"), runtime)
        self.assertEqual(self.f.store.get("pair_margin:gold"), journal)
        self.f.store.put("pair_margin:gold", {})
        recovered = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(recovered["data"]["health"]["state"], "online")
        self.assertEqual(recovered["data"]["diagnostics"], [])

    def test_margin_only_unresolved_transfer_remains_a_fault_with_current_balances(self):
        runtime = self.margin_only_pair()
        self.f.store.put("pair_margin:gold", {"pending": {"status": "unknown", "amount": "25",
                                                          "source": "long", "destination": "short"}})
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(result["data"]["health"]["state"], "partial")
        self.assertTrue(any(row["kind"] == "fault" for row in result["data"]["diagnostics"]))
        self.assertIn("划转", result["data"]["health"]["message"])
        self.assertIsNone(self.metrics(result)["occupied_margin"])
        runtime["margin"] = {"status": "acknowledged", "blocks_trading": True,
                             "reason": "交易所已确认划转，等待刷新余额"}
        self.f.store.put("pair_runtime:gold", runtime)
        self.f.store.put("pair_margin:gold", {"pending": {"status": "acknowledged", "amount": "25",
                                                          "source": "long", "destination": "short"}})
        waiting = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(waiting["data"]["health"]["state"], "online")
        self.assertEqual(waiting["data"]["diagnostics"], [])

    def test_margin_only_finite_zero_and_negative_balances_are_not_missing_data(self):
        runtime = self.margin_only_pair()
        for value in ("0", "-2.5"):
            with self.subTest(value=value):
                for balance in runtime["margin_balances"].values():
                    balance.update(equity=value, available=value, wallet=value)
                self.f.store.put("pair_runtime:gold", runtime)
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                self.assertEqual(result["data"]["health"]["state"], "online")
                self.assertEqual(result["data"]["diagnostics"], [])
                self.assertIsNone(self.metrics(result)["occupied_margin"])

    def test_diagnostics_are_opt_in_and_keep_legacy_values_and_health(self):
        self.pair()
        with patch.object(_StoreSnapshot, "intent", side_effect=AssertionError("opt-in only")):
            legacy = hub_summary(self.engine, now=self.now)
        self.assertNotIn("diagnostics", legacy["data"])
        self.assertEqual(hub_summary(self.engine, now=self.now, diagnostics=False), legacy)
        extended = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(extended["data"].pop("diagnostics"), [])
        self.assertEqual(extended, legacy)

    def test_standalone_snapshot_fault_keeps_stale_values_and_reports_no_volume(self):
        self.live()
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual(result["data"]["diagnostics"], [])
        self.assertNotIn("daily_volume", self.metrics(result))
        self.assertNotIn("成交量", result["data"]["health"]["message"])
        self.assertEqual(result["data"]["health"]["state"], "online")
        self.engine.views["test"]["snapshot"]["timestamp"] = self.now - 120
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual([(row["id"], row["kind"]) for row in result["data"]["diagnostics"]],
                         [("account:test:snapshot", "fault")])
        self.assertEqual(result["data"]["health"]["state"], "stale")
        legacy = hub_summary(self.engine, now=self.now)
        result["data"].pop("diagnostics")
        self.assertEqual(result, legacy)

    def test_pair_diagnostics_merge_both_members_and_keep_highest_kind(self):
        runtime = self.pair()
        runtime.update(phase="attention", attention="两侧仓位不一致，请人工核对")
        runtime["snapshots"]["short"] = {}
        self.f.store.put("pair_runtime:gold", runtime)
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        rows = result["data"]["diagnostics"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["id"], rows[0]["kind"]), ("pair:gold", "action"))
        for reason in ("两侧仓位不一致", "缺少账户快照"):
            self.assertIn(reason, rows[0]["message"])
        self.assertNotIn("成交量", rows[0]["message"])
        self.assertIsNone(result["data"]["updatedAt"])
        self.assertIsNone(self.metrics(result)["occupied_margin"])

    def test_pair_legacy_orders_are_action_and_removed_order_states_are_silent(self):
        runtime = self.pair()
        for changes, expected in (({"phase": "reconciling"}, []),
                                  ({"phase": "repairing"}, []),
                                  ({"daily_volume": None}, []),
                                  ({"volume_unknown": True}, []),
                                  ({"pending": {"kind": "ordinary", "phase": "open"}}, [("pair:gold", "action")]),
                                  ({"recovery_watch": {"batches": []}}, [("pair:gold", "action")]),
                                  ({"phase": "attention", "reason": "需要人工核对"}, [("pair:gold", "action")])):
            with self.subTest(changes=changes):
                self.f.store.put("pair_runtime:gold", {**runtime, **changes})
                result = hub_summary(self.engine, now=self.now, diagnostics=True)
                rows = result["data"]["diagnostics"]
                self.assertEqual([(row["id"], row["kind"]) for row in rows], expected)
                if "pending" in changes or "recovery_watch" in changes:
                    self.assertIn(LEGACY_ORDERS_REASON, rows[0]["message"])
                elif expected:
                    self.assertIn("需要人工核对", rows[0]["message"])
                # Diagnostics never turn into a summary fault or a volume metric.
                self.assertNotIn("daily_volume", self.metrics(result))
                self.assertEqual(result["data"]["health"]["state"], "online")
        for value in (None, {}, [], "invalid"):
            with self.subTest(runtime=value):
                self.f.store.put("pair_runtime:gold", value)
                rows = hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"]
                self.assertEqual([(row["id"], row["kind"]) for row in rows], [("pair:gold", "fault")])
                self.assertIn("配对运行记录缺失或无效", rows[0]["message"])

    def test_paused_attention_remains_visible_without_counting_paused_accounts(self):
        runtime = self.pair(enabled=False)
        runtime.update(phase="attention", attention="账户设置需要人工核对")
        runtime["snapshots"] = {}
        self.f.store.put("pair_runtime:gold", runtime)
        legacy = hub_summary(self.engine, now=self.now)
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        rows = result["data"].pop("diagnostics")
        self.assertEqual([(row["id"], row["kind"]) for row in rows], [("pair:gold", "action")])
        self.assertNotIn("快照", rows[0]["message"])
        self.assertEqual(result, legacy)
        self.assertEqual(self.metrics(result)["accounts"], 0)
        self.assertIsNone(self.metrics(result)["occupied_margin"])
        runtime.update(phase="paused", attention=None)
        self.f.store.put("pair_runtime:gold", runtime)
        self.assertEqual(hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"], [])
        # A paused pair still reports legacy order records: enabling it is refused.
        self.f.store.put("pair_runtime:gold", {**runtime, "recovery_watch": {"batches": []}})
        rows = hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"]
        self.assertEqual([(row["id"], row["kind"]) for row in rows], [("pair:gold", "action")])
        self.assertIn(LEGACY_ORDERS_REASON, rows[0]["message"])
        pair = self.f.store.pair("gold")
        self.f.store.save_pair({**pair, "pause_reason": "账户模式已变化，请确认"})
        rows = hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"]
        self.assertEqual([(row["id"], row["kind"]) for row in rows], [("pair:gold", "action")])
        self.assertIn("账户模式已变化", rows[0]["message"])

    def test_disabled_single_pause_reason_and_attention_intent_are_action_without_metrics(self):
        self.live(enabled=False)
        legacy = hub_summary(self.engine, now=self.now)
        self.assertEqual(hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"], [])
        saved = self.f.store.account("test")
        self.f.store.pause_account(saved, "仓位不一致，需要人工核对")
        self.f.store.save_intent({"id": "pending", "account_id": "test", "status": "attention",
                                  "kind": "pair", "last_error": "未完成批次需要人工核对"})
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        rows = result["data"].pop("diagnostics")
        self.assertEqual([(row["id"], row["kind"]) for row in rows], [("account:test:state", "action")])
        self.assertIn("仓位不一致", rows[0]["message"])
        self.assertIn("未完成批次", rows[0]["message"])
        self.assertEqual(result, legacy)
        self.assertEqual(self.metrics(result)["accounts"], 0)
        self.assertIsNone(self.metrics(result)["occupied_margin"])

    def test_service_faults_merge_and_diagnostic_overflow_remains_visible(self):
        self.engine.ready, self.engine.error = False, "行情暂不可用"
        self.engine.shutdown.set()
        result = hub_summary(self.engine, now=self.now, diagnostics=True)
        self.assertEqual([(row["id"], row["kind"]) for row in result["data"]["diagnostics"]],
                         [("service:engine", "fault")])
        self.assertIn("交易服务已停止", result["data"]["diagnostics"][0]["message"])
        records = [self.f.store.account_defaults({**account(f"account-{index}", "live"), "name": "账户😀" * 35})
                   for index in range(70)]
        with patch.object(_StoreSnapshot, "accounts", return_value=records):
            rows = hub_summary(self.engine, now=self.now, diagnostics=True)["data"]["diagnostics"]
        self.assertEqual(len(rows), 64)
        self.assertEqual((rows[-1]["id"], rows[-1]["kind"]), ("summary:more", "fault"))
        self.assertTrue(all(len(row["message"].encode("utf-16-le")) // 2 <= 500 for row in rows))

    def test_pair_and_standalone_accounts_are_deduplicated(self):
        self.pair()
        self.live("standalone", margin="10")
        self.live("test", enabled=False, margin="999", stamp=self.now - 60)
        saved = self.f.store.accounts()
        # Even a stale account list retaining the old enabled flag must not
        # double count the member or use its independent strategy report.
        records = [{**row, "enabled": True} if row["id"] == "test" else row for row in saved]
        with patch.object(_StoreSnapshot, "accounts", return_value=records + records[:1]):
            result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result), {"accounts": 3, "live_accounts": 3,
                                              "occupied_margin": 40})
        self.assertEqual(result["data"]["health"]["state"], "online")

    def test_paused_pairs_are_excluded_and_paper_members_only_count_as_enabled(self):
        self.pair(enabled=False)
        self.live("standalone", margin="10")
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result), {"accounts": 1, "live_accounts": 1,
                                              "occupied_margin": 10})
        pair = self.f.store.pair("gold")
        self.f.store.save_pair({**pair, "enabled": True})
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result), {"accounts": 3, "live_accounts": 1,
                                              "occupied_margin": 10})
        self.assertEqual(result["data"]["health"]["state"], "online")

    def test_pair_missing_or_old_side_never_borrows_runtime_freshness(self):
        runtime = self.pair()
        for snapshot, state, has_timestamp in (
            ({}, "partial", False),
            ({"occupied_margin": "17.5"}, "partial", False),
            ({"timestamp": self.now - 120, "occupied_margin": "17.5"}, "stale", True),
        ):
            with self.subTest(snapshot=snapshot):
                runtime["snapshots"]["short"] = snapshot
                self.f.store.put("pair_runtime:gold", runtime)
                result = hub_summary(self.engine, now=self.now)
                self.assertEqual(result["data"]["health"]["state"], state)
                self.assertEqual(result["data"]["updatedAt"] is not None, has_timestamp)
                self.assertIn("second", result["data"]["health"]["message"])

    def test_pair_uses_newest_valid_snapshot_from_runtime_view_or_display(self):
        runtime = self.pair()
        self.engine.view("test", snapshot={"timestamp": self.now - 2, "occupied_margin": "20"})
        self.engine.display_snapshots["second"] = {"timestamp": self.now - 1, "occupied_margin": "25"}
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result)["occupied_margin"], 45)
        expected = datetime.fromtimestamp(self.now - 2, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(result["data"]["updatedAt"], expected)
        # A corrupt future candidate must not hide another valid account read.
        runtime["snapshots"]["long"] = {"timestamp": self.now + 61, "occupied_margin": "999"}
        self.f.store.put("pair_runtime:gold", runtime)
        self.engine.display_snapshots["test"] = {"timestamp": "nan", "occupied_margin": "999"}
        self.assertEqual(hub_summary(self.engine, now=self.now), result)

    def test_pair_future_only_snapshot_is_unknown_but_clock_tolerance_is_preserved(self):
        runtime = self.pair()
        for ahead, state in ((61, "partial"), (60, "online")):
            with self.subTest(ahead=ahead):
                runtime["snapshots"]["short"]["timestamp"] = self.now + ahead
                self.f.store.put("pair_runtime:gold", runtime)
                result = hub_summary(self.engine, now=self.now)
                self.assertEqual(result["data"]["health"]["state"], state)
                self.assertEqual(result["data"]["updatedAt"] is None, ahead == 61)

    def test_uses_only_enabled_live_accounts_and_matches_units_without_heavy_reads(self):
        self.live()
        self.live("disabled", enabled=False, margin="999999")
        self.f.store.save_account(account("paper"))
        with patch.object(self.engine, "state", side_effect=AssertionError("full state")), \
             patch.object(self.f.market, "book", side_effect=AssertionError("market request")):
            result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result), {"accounts": 2, "live_accounts": 1, "occupied_margin": 12.5})
        self.assertEqual(result["data"]["health"]["state"], "online")
        self.assertEqual(result["data"]["health"]["staleAfterSeconds"], 120)
        self.assertEqual(next(m["unit"] for m in result["data"]["metrics"] if m["key"] == "occupied_margin"), "USD1")

    def test_missing_snapshot_is_null_partial_not_zero(self):
        self.live()
        self.engine.views.clear()
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(result["data"]["health"]["state"], "partial")
        self.assertIsNone(result["data"]["updatedAt"])
        self.assertIsNone(self.metrics(result)["occupied_margin"])
        self.assertIn("测试子账户（test）：缺少账户快照", result["data"]["health"]["message"])
        self.assertNotIn("成交统计", result["data"]["health"]["message"])

    def test_service_and_account_reasons_survive_health_priority(self):
        self.live(margin=None)
        self.engine.views["test"]["snapshot"]["timestamp"] = None
        self.engine.ready, self.engine.error = False, "交易规则加载失败"
        result = hub_summary(self.engine, now=self.now)
        message = result["data"]["health"]["message"]
        for reason in ("交易服务异常：交易规则加载失败", "交易服务尚未就绪", "测试子账户（test）：快照缺少有效更新时间", "测试子账户（test）：保证金数据缺失或无效"):
            self.assertIn(reason, message)
        self.engine.shutdown.set()
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(result["data"]["health"]["state"], "offline")
        self.assertIn("交易服务已停止", result["data"]["health"]["message"])
        self.assertIn("保证金数据缺失或无效", result["data"]["health"]["message"])
        self.assertNotIn("已连接", result["data"]["health"]["message"])

    def test_many_accounts_fit_the_portals_utf16_message_limit_without_heavy_reads(self):
        for index in range(15):
            aid = f"account-{index}"
            self.live(aid, margin=None)
            saved = self.f.store.account(aid)
            saved["name"] = "账户😀" * 10
            self.f.store.save_account(saved)
        self.live("disabled", enabled=False, margin=None)
        self.engine.error = {"secret": "never-serialize"}
        with patch.object(self.engine, "state", side_effect=AssertionError("full state")):
            message = hub_summary(self.engine, now=self.now)["data"]["health"]["message"]
        self.assertLessEqual(len(message.encode("utf-16-le")) // 2, 500)
        self.assertIn("另有", message)
        self.assertIn("account-0", message)
        self.assertIn("保证金数据缺失或无效", message)
        self.assertNotIn("disabled", message)
        self.assertNotIn("never-serialize", message)

    def test_oldest_published_snapshot_controls_staleness(self):
        self.live(stamp=self.now - 121)
        self.live("second", stamp=self.now - 10)
        result = hub_summary(self.engine, now=self.now)
        expected = datetime.fromtimestamp(self.now - 121, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.assertEqual(result["data"]["updatedAt"], expected)
        self.assertEqual(result["data"]["health"]["state"], "stale")
        self.assertIn("测试子账户（test）：账户快照已过期", result["data"]["health"]["message"])
        self.engine.display_snapshots["test"] = {"timestamp": self.now, "occupied_margin": "20"}
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(result["data"]["health"]["state"], "online")
        self.assertEqual(self.metrics(result)["occupied_margin"], 32.5)

    def test_demo_no_live_accounts_does_not_claim_zero_private_balances(self):
        self.engine.demo = True
        result = hub_summary(self.engine, now=self.now)
        self.assertEqual(self.metrics(result)["live_accounts"], 0)
        self.assertIsNone(self.metrics(result)["occupied_margin"])
        self.assertIn("演示", result["data"]["health"]["message"])
        self.engine.shutdown.set()
        self.assertEqual(hub_summary(self.engine)["data"]["health"]["state"], "offline")

    def test_missing_one_account_timestamp_does_not_borrow_another_accounts_freshness(self):
        self.live()
        self.live("second")
        self.engine.views["second"]["snapshot"].pop("timestamp")
        result = hub_summary(self.engine, now=self.now)
        self.assertIsNone(result["data"]["updatedAt"])
        self.assertEqual(result["data"]["health"]["state"], "partial")

    def test_endpoint_shares_authentication_and_no_store_with_state(self):
        self.live()
        with patch.dict("os.environ", {"ASTER_DASHBOARD_PASSWORD": "test-only-summary-password"}), \
             TestClient(create_app(self.engine, start_engine=False)) as client:
            self.assertEqual(client.get("/api/hub/summary?schemaVersion=2").status_code, 401)
            client.headers["origin"] = "http://testserver"
            self.assertEqual(client.post("/api/login", json={"password": "test-only-summary-password"}).status_code, 200)
            with patch.object(self.engine, "state", side_effect=AssertionError("full state")):
                result = client.get("/api/hub/summary?schemaVersion=2")
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["schemaVersion"], 2)
            self.assertNotIn("diagnostics", result.json()["data"])
            self.assertEqual(result.headers["cache-control"], "no-store")
            extended = client.get("/api/hub/summary?schemaVersion=2&diagnostics=1")
            self.assertEqual(extended.status_code, 200)
            self.assertEqual(extended.headers["cache-control"], "no-store")
            self.assertEqual(extended.json()["data"]["diagnostics"], [])
            self.assertNotIn("diagnostics", client.get("/api/hub/summary?schemaVersion=2&diagnostics=0").json()["data"])
            self.assertEqual(client.get("/api/hub/summary?schemaVersion=3").status_code, 422)
            client.post("/api/logout")
            self.assertEqual(client.get("/api/hub/summary?schemaVersion=2").status_code, 401)
            self.assertEqual(client.get("/api/hub/summary?schemaVersion=2&diagnostics=1").status_code, 401)


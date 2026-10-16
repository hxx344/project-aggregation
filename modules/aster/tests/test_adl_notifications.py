"""Recorded ADL reports and transactional outbox behavior, without delivery I/O."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from trading import adl_notifications as notifications
from trading.store import Store


def position(direction, quantity):
    return {"symbol": "XAUUSD1", "position_side": direction, "direction": direction, "quantity": quantity}


def incident():
    return {"id": "incident-1", "pair_id": "pair-1", "pair_name": "黄金配对", "status": "completed",
        "created_at": 1000.0, "completed_at": 1012.5, "strategy_status": "保持暂停", "symbols": ["XAUUSD1"],
        "events": [{"account_id": "a", "account_name": "账户甲", "symbol": "XAUUSD1", "order_id": "original-42",
            "position_side": "LONG", "side": "SELL", "executed_qty": "3", "original_qty": "6",
            "event_at": 1000.0, "order_at": 990.0, "avg_price": "3000.25", "source": "websocket",
            "status": "PARTIALLY_FILLED", "confirmed": True}],
        "before": {"a": {"name": "账户甲", "positions": [position("LONG", "10"), position("SHORT", "2")]},
            "b": {"name": "账户乙", "positions": [position("LONG", "1"), position("SHORT", "12")]}},
        "after": {"a": {"name": "账户甲", "positions": [position("LONG", "10"), position("SHORT", "2")]},
            "b": {"name": "账户乙", "positions": [position("LONG", "1"), position("SHORT", "9")]}},
        "batches": [{"account_id": "b", "account_name": "账户乙", "sent_at": 1001.0,
            "order": {"symbol": "XAUUSD1", "positionSide": "SHORT", "side": "BUY", "quantity": "3",
                "newClientOrderId": "adl-client-1"},
            "receipt": {"status": "FILLED", "executedQty": "3", "avgPrice": "3002.5", "orderId": "repair-43"}}]}


class AdlReportTests(unittest.TestCase):
    def test_recorded_config_controls_report_text_and_legacy_defaults(self):
        legacy = "\n".join(notifications.format_messages(incident(), "detected"))
        self.assertIn("本次自动减仓：开启", legacy)
        self.assertIn("单批名义金额上限：1000", legacy)
        item = incident()
        item["config"] = {"enabled": False, "batch_notional": "250.5"}
        item["batches"] = []
        for phase in ("detected", "blocked", "completed"):
            with self.subTest(phase=phase):
                text = "\n".join(notifications.format_messages(item, phase))
                self.assertIn("本次自动减仓：关闭", text)
                self.assertIn("单批名义金额上限：250.5", text)
                self.assertNotIn("将按实际多空残差分批减去多余持仓", text)
        blocked = "\n".join(notifications.format_messages(item, "blocked"))
        self.assertIn("不自动下单或撤单", blocked)

    def test_detected_reports_original_cumulative_reduction_and_source_time(self):
        item = incident()
        item.pop("after")
        item.pop("completed_at")
        item["batches"] = []
        text = "\n".join(notifications.format_messages(item, "detected"))
        for expected in ("ADL 已确认", "黄金配对", "original-42", "累计减仓：3", "原委托数量：6",
                         "3000.25", "websocket", "1970-01-01T00:16:40.000+00:00",
                         "1970-01-01T00:16:30.000+00:00", "分批减去多余持仓", "现场残差：3（空仓多余）"):
            self.assertIn(expected, text)
        self.assertNotIn("最终残差", text)
        self.assertNotIn("累计减仓：6", text)

    def test_completed_includes_both_accounts_four_directions_batches_and_actual_residual(self):
        text = "\n".join(notifications.format_messages(incident(), "completed"))
        for expected in ("账户「账户甲」(a) XAUUSD1：多仓 10；空仓 2",
                         "账户「账户乙」(b) XAUUSD1：多仓 1；空仓 12",
                         "账户「账户乙」(b) XAUUSD1：多仓 1；空仓 9", "第 1 批", "SHORT BUY",
                         "委托数量 3", "adl-client-1", "repair-43", "回报状态：FILLED",
                         "累计成交：3", "成交均价：3002.5", "最终残差：0（多空相等）", "耗时：12.500 秒",
                         "策略状态：保持暂停", "手续费及已实现盈亏：未提供原始成交明细，未计算"):
            self.assertIn(expected, text)

    def test_blocked_unknown_receipt_and_missing_after_are_not_success_or_zero(self):
        item = incident()
        item.pop("after")
        item.pop("completed_at")
        item["reported_at"] = 1008
        item["batches"][0].pop("receipt")
        item["batches"][0]["error"] = "发送超时，结果未知"
        text = "\n".join(notifications.format_messages(item, "blocked", reason="等待交易所原订单核对"))
        for expected in ("处理受阻", "等待交易所原订单核对", "发送超时，结果未知", "回报状态：未知，待核对",
                         "累计成交：未知", "成交均价：未知", "最终残差：未知", "耗时：8.000 秒"):
            self.assertIn(expected, text)
        self.assertNotIn("最终残差：0", text)

    def test_residual_is_exact_and_not_rounded_to_balance(self):
        item = incident()
        item["after"]["b"]["positions"][1]["quantity"] = "9.000000000000000000000000000001"
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("最终残差：0.000000000000000000000000000001（空仓多余）", text)

    def test_only_complete_empty_inventories_are_reported_as_zero(self):
        item = incident()
        for member in item["after"].values():
            member["positions"] = []
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("最终残差：0（多空相等）", text)
        for invalid in (None, "NaN", "Infinity", "-1", True):
            with self.subTest(invalid=invalid):
                changed = deepcopy(item)
                changed["after"]["a"]["positions"] = [position("LONG", invalid)]
                text = "\n".join(notifications.format_messages(changed, "completed"))
                self.assertIn("最终残差：未知", text)
        item["after"]["a"].pop("positions")
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("最终残差：未知", text)
        item["after"]["a"]["positions"] = [{}]
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("最终残差：未知", text)

    def test_partial_batch_reports_actual_fills_without_substituting_requested_quantity(self):
        item = incident()
        item["batches"][0]["receipt"].update(status="PARTIALLY_FILLED", executedQty="0.125", avgPrice=None)
        text = "\n".join(notifications.format_messages(item, "blocked"))
        self.assertIn("委托数量 3", text)
        self.assertIn("累计成交：0.125；成交均价：未知", text)
        self.assertIn("回报状态：PARTIALLY_FILLED", text)

    def test_prior_pending_orders_report_account_identity_and_unknown_without_invented_fill(self):
        item = incident()
        item["prior_orders"] = [{"account_id": "a", "sent_at": 999, "state": "sending",
            "order": {"symbol": "XAUUSD1", "positionSide": "LONG", "side": "BUY", "quantity": "2",
                      "newClientOrderId": "old-client-1"}},
            {"account_id": "b", "account_name": "原账户乙", "sent_at": 999.5, "state": "terminal",
             "order": {"symbol": "XAUUSD1", "positionSide": "SHORT", "side": "SELL", "quantity": "2",
                       "newClientOrderId": "old-client-2"},
             "receipt": {"orderId": "old-exchange-2", "status": "FILLED", "executedQty": "2", "avgPrice": "3000"}}]
        text = "\n".join(notifications.format_messages(item, "blocked"))
        for expected in ("原策略未决订单核对记录", "原未决订单 1：账户「账户甲」(a)",
                         "原未决订单 2：账户「原账户乙」(b)", "old-client-1", "old-client-2", "old-exchange-2",
                         "回报状态：未知，待核对；累计成交：未知", "回报状态：FILLED；累计成交：2",
                         "1970-01-01T00:16:39.000+00:00"):
            self.assertIn(expected, text)
        self.assertNotIn("累计成交：0", text)
        self.assertNotIn("回报状态：REJECTED", text)

    def test_completed_position_verified_unknown_orders_remain_explicitly_unknown(self):
        item = incident()
        item["prior_orders"] = [{"account_id": "a", "sent_at": 880, "state": "terminal",
            "resolution": "positions_verified_unknown", "resolved_at": 1000,
            "order": {"symbol": "XAUUSD1", "positionSide": "LONG", "side": "BUY", "quantity": "2",
                      "newClientOrderId": "unknown-original"}}]
        item["batches"][0].update(state="terminal", resolution="positions_verified_unknown", resolved_at=1010,
                                  receipt={"orderId": "uncertain-repair", "status": "NEW", "executedQty": "0"})
        text = "\n".join(notifications.format_messages(item, "completed"))
        for expected in ("unknown-original", "uncertain-repair", "回报状态：仍未知；累计成交：未知",
                         "已按两账户新鲜完整持仓核验后继续处理", "1970-01-01T00:16:50.000+00:00",
                         "已按当前实际仓位平衡；原单成交结果仍未知", "策略保持暂停，并继续观察迟到成交引起的持仓变化",
                         "最终残差：0（多空相等）"):
            self.assertIn(expected, text)
        self.assertEqual(text.count("原订单最终成交结果仍待确认"), 2)
        self.assertNotIn("累计成交：0", text)
        self.assertNotIn("回报状态：REJECTED", text)

    def test_reopened_incident_links_parent_and_keeps_known_partial_fill_distinct_from_final_result(self):
        item = incident()
        item.update(id="incident-reopened", parent_id="incident-original")
        item["batches"][0].update(state="terminal", resolution="positions_verified_unknown", resolved_at=1010)
        item["batches"][0]["receipt"].update(status="PARTIALLY_FILLED", executedQty="0.125")
        before = deepcopy(item)
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("事件：incident-reopened", text)
        self.assertIn("关联前次事件：incident-original", text)
        self.assertIn("回报状态：仍未知；累计成交：未知", text)
        self.assertIn("最后可核实累计成交（非最终）：0.125", text)
        self.assertEqual(item, before)

    def test_long_report_keeps_every_batch_and_numbers_each_bounded_part(self):
        item = incident()
        item["batches"] = [{**deepcopy(item["batches"][0]), "order": {
            **item["batches"][0]["order"], "newClientOrderId": f"client-{index:04d}"}}
            for index in range(160)]
        messages = notifications.format_messages(item, "completed")
        self.assertGreater(len(messages), 1)
        text = "\n".join(messages)
        for index, message in enumerate(messages, 1):
            self.assertLessEqual(len(message), 3000)
            self.assertIn(f"第 {index}/{len(messages)} 段", message.splitlines()[0])
        for index in range(160):
            self.assertEqual(text.count(f"client-{index:04d}"), 1)
        self.assertIn("最终残差：0（多空相等）", text)
        self.assertIn("策略状态：保持暂停", text)

    def test_oversized_reason_is_preserved_across_message_parts(self):
        reason = "数据核对异常" * 1000
        messages = notifications.format_messages(incident(), "blocked", reason=reason)
        self.assertTrue(all(len(message) <= 3000 for message in messages))
        body = "".join(message.split("\n", 1)[1].replace("\n", "") for message in messages)
        self.assertIn(reason, body)

    def test_formatting_does_not_mutate_incident_and_invalid_times_stay_unknown(self):
        item = incident()
        item["events"][0]["event_at"] = float("inf")
        item["completed_at"] = 999
        before = deepcopy(item)
        text = "\n".join(notifications.format_messages(item, "completed"))
        self.assertIn("来源时间（UTC）：未知", text)
        self.assertIn("耗时：未知", text)
        self.assertEqual(item, before)


class AdlOutboxTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")

    def rows(self):
        with self.store.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM outbox ORDER BY due_at,id")]

    def enqueue(self, item, phase, **kwargs):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return notifications.enqueue(db, item, phase, now=kwargs.pop("now", 1000), **kwargs)

    def test_enqueue_uses_category_symbols_and_phase_specific_stable_ids(self):
        item = incident()
        item["symbols"] = ["XAUUSD1", "CLUSD1", "XAUUSD1"]
        for phase in ("detected", "blocked", "completed"):
            self.enqueue(item, phase)
        rows = self.rows()
        self.assertEqual(len(rows), 3)
        self.assertEqual({row["id"] for row in rows}, {"adl:incident-1:detected:0001",
            "adl:incident-1:blocked:0:0001", "adl:incident-1:completed:0001"})
        for row in rows:
            self.assertEqual(row["category"], "adl")
            self.assertEqual(json.loads(row["symbols"]), ["XAUUSD1", "CLUSD1"])
            self.assertEqual(row["due_at"], 1000)
            self.assertIsNone(row["delivered_at"])

    def test_reenqueue_preserves_retry_backoff_attempts_message_and_delivered_status(self):
        item = incident()
        identities = self.enqueue(item, "completed")
        with self.store.connect() as db:
            db.execute("UPDATE outbox SET attempts=3,due_at=1100 WHERE id=?", (identities[0],))
        before = self.rows()
        self.enqueue(item, "completed", now=1050, reason="重试时的新文案")
        self.assertEqual(self.rows(), before)
        with self.store.connect() as db:
            db.execute("UPDATE outbox SET delivered_at=1101 WHERE id=?", (identities[0],))
        delivered = self.rows()
        self.enqueue(item, "completed", now=1200)
        self.assertEqual(self.rows(), delivered)

    def test_blocked_notice_version_allows_new_reason_but_deduplicates_same_version(self):
        item = incident()
        item["notice_version"] = 1
        self.enqueue(item, "blocked", reason="初次核对失败")
        self.enqueue(item, "blocked", reason="重复核对失败")
        self.assertEqual(len(self.rows()), 1)
        item["notice_version"] = 2
        self.enqueue(item, "blocked", reason="需要人工核对")
        self.assertEqual(len(self.rows()), 2)
        self.assertIn("需要人工核对", self.rows()[1]["message"])

    def test_reenqueue_cannot_append_changed_extra_parts_to_an_existing_report(self):
        original = self.enqueue(incident(), "completed")
        rows = self.rows()
        repeated = self.enqueue(incident(), "completed", reason="后续增加的资料" * 1000)
        self.assertEqual(repeated, original)
        self.assertEqual(self.rows(), rows)

    def test_caller_rollback_removes_report_and_enqueue_never_commits(self):
        with self.assertRaisesRegex(RuntimeError, "caller failed"):
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                notifications.enqueue(db, incident(), "detected", now=1000)
                raise RuntimeError("caller failed")
        self.assertEqual(self.rows(), [])

    def test_partial_insert_failure_rolls_back_all_parts_in_caller_transaction(self):
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER reject_second_adl_part BEFORE INSERT ON outbox "
                "WHEN NEW.id LIKE '%:0002' BEGIN SELECT RAISE(ABORT,'part failed'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.enqueue(incident(), "blocked", reason="long-reason" * 1000)
        self.assertEqual(self.rows(), [])

    def test_more_than_nine_parts_remain_in_natural_delivery_order(self):
        reason = "复核信息" * 10000
        identities = self.enqueue(incident(), "blocked", reason=reason)
        rows = self.rows()
        self.assertGreater(len(rows), 10)
        self.assertEqual([row["id"] for row in rows], identities)
        for index, row in enumerate(rows, 1):
            self.assertIn(f"第 {index}/{len(rows)} 段", row["message"].splitlines()[0])

    def test_bad_phase_or_identity_cannot_write_partial_report(self):
        for item, phase in ((incident(), "failed"), ({**incident(), "id": ""}, "detected")):
            with self.subTest(phase=phase, identity=item["id"]):
                with self.assertRaises(ValueError):
                    self.enqueue(item, phase)
                self.assertEqual(self.rows(), [])


if __name__ == "__main__":
    unittest.main()

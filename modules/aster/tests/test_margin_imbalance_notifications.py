"""Margin imbalance incidents: timing, repeats, recovery and settings, with local evidence only."""
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from trading import margin_imbalance_notifications as margin_alerts
from trading.margin_balance import DEFAULT_MARGIN
from trading.pair_execution import PairTrader
from trading.store import Store


def balances(long, short, at):
    return {"long": {"timestamp": at, "available": str(long)}, "short": {"timestamp": at, "available": str(short)}}


class MarginImbalanceStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.now = 1000.0
        clock = patch("trading.store.time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        with self.store.connect() as db:
            db.execute("INSERT INTO pairs(id,data) VALUES (?,?)", ("gold", json.dumps({"id": "gold"})))

    def observe(self, *, status="waiting", long=3000, short=1000, fresh=True, active=True, error=None, pending=None):
        view = {"status": status, "reason": "本次不划转", "error": error, "pending": pending}
        return self.store.observe_margin_imbalance({
            "pair_id": "gold", "name": "黄金", "symbol": "XAUUSD1", "mode": "live", "active": active, "view": view,
            "balances": balances(long, short, self.now) if fresh else None, "threshold": "10",
            "check_interval_seconds": 5, "cooldown_seconds": 30}, now=self.now)

    def advance(self, seconds, step=5, **kwargs):
        end = self.now + seconds
        while self.now < end:
            self.now = min(end, self.now + step)
            self.observe(**kwargs)

    def rows(self):
        with self.store.connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM outbox WHERE category='margin_imbalance' ORDER BY due_at,id")]

    def state(self):
        with self.store.connect() as db:
            return margin_alerts.read(db)

    def due(self):
        return [item for item in self.store.due_notifications() if item.get("category") == "margin_imbalance"]

    def send(self):
        items = self.due()
        self.assertEqual(len(items), 1)
        self.store.notification_result(items[0], True)
        return items[0]

    def test_alert_after_one_minute_then_repeats_every_two_minutes_and_recovers_once(self):
        self.observe()
        self.advance(55)
        self.assertEqual(self.due(), [])
        self.advance(5)
        fault = self.send()
        self.assertIn("保证金长时间不平衡", fault["message"])
        self.assertIn("差额：2000 USD1", fault["message"])
        self.advance(115)
        self.assertEqual(self.due(), [])
        self.advance(5)
        repeat = self.send()
        self.assertIn("第 1 次重复提醒", repeat["message"])
        self.advance(120)
        self.assertIn("第 2 次重复提醒", self.send()["message"])
        self.now += 5
        self.observe(long=1005, short=1000)
        recovery = self.send()
        self.assertIn("保证金已恢复平衡", recovery["message"])
        self.advance(300, long=1005, short=1000)
        self.assertEqual(self.due(), [])
        self.assertIsNone(self.state()["targets"]["gold"]["incident"])

    def test_failed_send_keeps_one_pending_alert_without_piling_up_repeats(self):
        self.observe()
        self.advance(60)
        self.store.notification_result(self.due()[0], True)
        self.advance(120)
        item = self.due()[0]
        self.store.notification_result(item, False)
        self.advance(600)
        pending = [row for row in self.rows() if row["delivered_at"] is None and row["expires_at"] != 0]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["id"], item["id"])

    def test_brief_imbalance_or_recovery_before_send_never_notifies(self):
        self.observe()
        self.advance(40)
        self.now += 5
        self.observe(long=1000, short=1000)
        self.advance(40)
        self.assertEqual(self.due(), [])
        self.advance(60)
        self.assertEqual(len(self.due()), 1)
        self.now += 5
        self.observe(long=1000, short=1000)
        self.assertEqual(self.due(), [])
        self.assertEqual(self.rows()[0]["expires_at"], 0)

    def test_stuck_transfer_without_balances_alerts(self):
        self.observe(status="unknown", fresh=False, pending={"request_id": "r"})
        self.advance(60, status="unknown", fresh=False, pending={"request_id": "r"})
        message = self.send()["message"]
        self.assertIn("自动划转持续受阻或结果未确认", message)
        self.assertIn("划转结果未知", message)

    def test_soft_read_error_counts_as_cannot_balance(self):
        self.observe(fresh=False, error="本轮保证金检查已跳过；HTTP 500")
        self.advance(60, fresh=False, error="本轮保证金检查已跳过；HTTP 500")
        self.assertIn("HTTP 500", self.send()["message"])

    def test_completed_transfer_restarts_window_and_ignores_older_balances(self):
        self.observe()
        self.advance(50)
        self.now += 5
        old = self.now - 30
        self.store.observe_margin_imbalance({
            "pair_id": "gold", "name": "黄金", "symbol": "XAUUSD1", "mode": "live", "active": True,
            "view": {"status": "confirmed", "reason": "已划转", "error": None, "pending": None},
            "balances": balances(3000, 1000, old), "threshold": "10",
            "check_interval_seconds": 5, "cooldown_seconds": 30}, now=self.now)
        self.advance(120, status="cooldown", fresh=False)
        self.assertEqual(self.due(), [])

    def test_paused_or_non_live_pair_cancels_without_recovery(self):
        self.observe()
        self.advance(60)
        self.store.notification_result(self.due()[0], True)
        self.now += 5
        self.observe(status="paused")
        self.advance(300, status="paused")
        self.assertEqual(self.due(), [])
        self.assertNotIn("gold", self.state().get("targets", {}))
        self.observe(active=False)
        self.assertEqual(self.due(), [])

    def test_observation_gap_restarts_confirmation_and_blocks_stale_delivery(self):
        self.observe()
        self.advance(50)
        self.now += 200
        self.observe()
        self.advance(55)
        self.assertEqual(self.due(), [])
        self.advance(5)
        self.assertEqual(len(self.due()), 1)
        self.now += 500
        self.assertEqual(self.due(), [])

    def test_disabling_alerts_resets_and_reenabling_starts_a_new_window(self):
        self.observe()
        self.advance(60)
        self.assertEqual(len(self.due()), 1)
        self.store.edit_monitoring({"margin_imbalance_alerts": False})
        self.assertEqual(self.due(), [])
        self.assertFalse(self.observe())
        self.store.edit_monitoring({"margin_imbalance_alerts": True})
        self.now += 5
        self.observe()
        self.assertEqual(self.due(), [])
        self.advance(60)
        self.assertEqual(len(self.due()), 1)

    def test_feishu_master_switch_also_blocks_alerts(self):
        self.store.edit_monitoring({"feishu_enabled": False})
        self.observe()
        self.advance(120)
        self.assertEqual(self.rows(), [])

    def test_deleted_pair_cancels_pending_alert(self):
        self.observe()
        self.advance(60)
        with self.store.connect() as db:
            db.execute("DELETE FROM pairs WHERE id='gold'")
        self.assertEqual(self.due(), [])


class TraderMarginObservationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        for side in ("long", "short"):
            self.store.save_account({"id": side, "name": side, "mode": "live", "env_prefix": "ASTER_" + side.upper(),
                "enabled": True, "policy": {"symbols": ["XAUUSD1"], "margin_limit": "0.5"}})
        with self.store.connect() as db:
            db.execute("INSERT INTO pairs(id,data) VALUES (?,?)", ("gold", json.dumps({"id": "gold"})))
        self.pair = {"id": "gold", "name": "黄金", "symbol": "XAUUSD1", "long_account_id": "long",
            "short_account_id": "short", "enabled": True,
            "margin": {**DEFAULT_MARGIN, "enabled": True, "threshold": "50", "master_env_prefix": "ASTER_MASTER"}}
        self.live = True
        self.engine = SimpleNamespace(store=self.store, market=None, shutdown=threading.Event(),
            live_allowed=lambda account: self.live, margin_imbalance_error="old")

    def observe(self, balances_value):
        PairTrader(self.engine)._observe_margin_alert(self.pair,
            {"status": "waiting", "reason": "等待", "error": None, "pending": None}, balances_value)

    def target(self):
        with self.store.connect() as db:
            return margin_alerts.read(db).get("targets", {}).get("gold")

    def test_uses_pair_threshold_and_live_gate(self):
        import time
        self.observe(balances(1040, 1000, time.time()))
        target = self.target()
        self.assertIsNone(self.engine.margin_imbalance_error)
        self.assertEqual(target["threshold"], "50")
        self.assertFalse(target["imbalanced"])
        self.live = False
        self.observe(balances(3000, 1000, time.time()))
        self.assertIsNone(self.target())

    def test_observation_failure_is_reported_without_raising(self):
        self.pair["margin"] = {"unexpected": True}
        with self.assertLogs("aster.trading", "ERROR"):
            self.observe(None)
        self.assertEqual(self.engine.margin_imbalance_error, "保证金不平衡提醒检查失败，等待重试")


if __name__ == "__main__":
    unittest.main()

"""Recovered requests must not be recreated by the next scheduler turn."""
from copy import deepcopy
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from tests import test_leverage_selection_recovery as ordinary_fixtures

XAU = ordinary_fixtures.XAU


class RecoveryEngineTests(unittest.TestCase):
    setUp = ordinary_fixtures.HigherLeverageSelectionTests.setUp

    def test_cooling_upgrade_still_allows_ordinary_orders_at_actual_leverage(self):
        self.f.broker.state["leverages"][XAU] = 5
        self.f.broker.save()
        self.engine.markets[XAU]["capacities"].update({"5": "1984153", "10": "1984153"})
        with patch("trading.engine.leverage_cooldown_active", side_effect=lambda store, account, broker, symbol, target:
                   symbol == XAU and target == 10), \
             patch.object(self.f.broker, "set_leverage", wraps=self.f.broker.set_leverage) as change, \
             patch.object(self.f.broker, "submit", wraps=self.f.broker.submit) as submit:
            self.engine.tick_account("test")
        change.assert_not_called()
        submit.assert_called_once()
        self.assertEqual({order["symbol"] for order in submit.call_args.args[0]}, {XAU})
        self.assertIsNone(self.f.store.intent("test"))

    def test_user_pause_clears_auto_resume_even_when_already_paused(self):
        account = self.f.store.account("test")
        account.update(enabled=False, pause_reason="pending old request")
        self.f.store.save_account(account)
        key = "recovery_auto_pause:test"
        self.f.store.put(key, {"intent_id": "old", "paused_account": deepcopy(account), "paused_at": 1})
        self.engine.enable("test", False)
        self.assertIsNone(self.f.store.get(key))
        self.assertFalse(self.f.store.account("test")["enabled"])

    def test_user_config_change_clears_auto_resume(self):
        account = self.f.store.account("test")
        account["enabled"] = False
        self.f.store.save_account(account)
        self.f.store.put("recovery_auto_pause:test", {"intent_id": "old", "paused_account": deepcopy(account)})
        self.engine.configure("test", {"threshold": "10000"})
        self.assertIsNone(self.f.store.get("recovery_auto_pause:test"))

    def test_adopted_unknown_orders_are_not_reported_as_zero_fills(self):
        for kind in ("unknown_current_state", "current_state_adopted"):
            with self.subTest(resolution=kind):
                executor = SimpleNamespace(last_completed_intent={"kind": "pair", "status": "aborted", "symbol": XAU,
                    "receipts": {}, "resolution": {"kind": kind}})
                self.engine.record_batch_outcome("test", executor)
                self.assertIsNone(self.f.store.get("order_cooldown:test:" + XAU))
                self.assertFalse(any("无新增仓位" in event["message"] for event in self.f.store.events()))

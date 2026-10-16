"""A paused strategy can stop new trading without erasing unresolved work."""
from contextlib import ExitStack
from copy import deepcopy
import unittest
from unittest.mock import patch

from tests import test_pair_api as api_cases
from tests import test_pair_integration as integration
from tests import test_pair_trading as trading_cases
from tests.test_pair_order_recovery import seed_pending
from trading.adl_view import status_view
from trading.exchange import ExchangeError
from trading.models import TradingError
from trading.pair_execution import PairTrader


class PairMarginOnlySwitchTests(unittest.TestCase):
    setUp = integration.PairIntegrationTests.setUp

    def test_pending_orders_and_transfers_are_preserved_without_exchange_reads(self):
        runtime = seed_pending(self.engine)
        runtime["recovery_watch"] = {"batches": [{"id": "older-unknown"}]}
        self.f.store.put("pair_runtime:gold", runtime)
        margin = {"status": "unknown", "pending": {"client_id": "original-transfer"}}
        self.f.store.put("pair_margin:gold", margin)
        original = self.f.store.pair("gold")
        with patch.object(self.engine, "broker", side_effect=AssertionError("no exchange work")):
            saved = self.engine.pairs.switch_to_margin_only("gold")
        expected = deepcopy(original)
        expected["ordinary"]["enabled"] = expected["cycle"]["enabled"] = False
        expected["margin"]["enabled"] = True
        expected["revision"] += 1
        self.assertEqual(saved, expected)
        self.assertEqual(self.f.store.get("pair_runtime:gold"), runtime)
        self.assertEqual(self.f.store.get("pair_margin:gold"), margin)
        self.assertEqual(self.engine.pairs.switch_to_margin_only("gold"), saved)
        with self.assertRaisesRegex(TradingError, "仍在核对"):
            self.engine.pairs.configure("gold", {"ordinary": {"enabled": True}})
        view = status_view(self.engine, self.f.store, saved, runtime)
        self.assertTrue(view["configuration_locked"])
        self.assertFalse(view["margin_only_switch_allowed"])

    def test_running_adl_and_invalid_journals_still_block_switch(self):
        runtime = seed_pending(self.engine)
        original = self.f.store.pair("gold")
        self.f.store.save_pair({**original, "enabled": True})
        with self.assertRaisesRegex(TradingError, "暂停"):
            self.engine.pairs.switch_to_margin_only("gold")
        original = self.f.store.save_pair({**self.f.store.pair("gold"), "enabled": False})
        for status in ("active", "blocked", "completed"):
            self.f.store.put("adl_pair:gold", {"status": status, "hold": True})
            with self.assertRaisesRegex(TradingError, "ADL"):
                self.engine.pairs.switch_to_margin_only("gold")
        self.f.store.put("adl_pair:gold", None)
        for key in ("pair_runtime:gold", "pair_margin:gold"):
            self.f.store.put(key, [])
            with self.assertRaisesRegex(TradingError, "日志无效"):
                self.engine.pairs.switch_to_margin_only("gold")
            self.f.store.put(key, runtime if key.startswith("pair_runtime") else {})
        self.assertEqual(self.f.store.pair("gold"), original)
        view = status_view(self.engine, self.f.store, original, runtime)
        self.assertTrue(view["configuration_locked"])
        self.assertTrue(view["margin_only_switch_allowed"])
        with self.engine.adl.lock:
            self.engine.adl.queue[("test", 1, "XAUUSD1", 7)] = (None, {"confirmed": True})
        with self.assertRaisesRegex(TradingError, "ADL"):
            self.engine.pairs.switch_to_margin_only("gold")
        self.assertFalse(status_view(self.engine, self.f.store, original, runtime)["margin_only_switch_allowed"])

    def test_start_preserves_unknown_batch_and_keeps_funds_checks_independent(self):
        runtime = seed_pending(self.engine)
        self.engine.pairs.switch_to_margin_only("gold")
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("no strategy adoption")):
            pair = self.engine.pairs.enable("gold", True)
        self.assertTrue(pair["enabled"])
        for field in ("pending", "owned", "progress", "daily_volume"):
            self.assertEqual(self.f.store.get("pair_runtime:gold")[field], runtime[field])
        trader = PairTrader(self.engine)
        with ExitStack() as stack:
            for account_id in ("test", "second"):
                broker = self.engine.broker(self.f.store.account(account_id))
                stack.enter_context(patch.object(broker, "submit", side_effect=AssertionError("no new orders")))
                stack.enter_context(patch.object(broker, "set_leverage", side_effect=AssertionError("no leverage writes")))
                stack.enter_context(patch.object(broker, "query", side_effect=ExchangeError("not found", code=-2013)))
            balance = stack.enter_context(patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": False}))
            state = trader.tick(pair)
        self.assertIsNotNone(state["pending"])
        self.assertEqual(balance.call_count, 1)
        self.assertTrue(balance.call_args.kwargs["pending_orders"])


class PairMarginOnlyCycleTests(unittest.TestCase):
    setUp = trading_cases.PairTradingTests.setUp
    tick = trading_cases.PairTradingTests.tick
    snapshots = trading_cases.PairTradingTests.snapshots
    assert_flat = trading_cases.PairTradingTests.assert_flat

    def test_existing_cycle_finishes_with_original_parameters_after_switch(self):
        state = self.tick()
        self.assertEqual(state["phase"], "holding")
        original_progress = deepcopy(state["progress"])
        self.engine.pairs.enable("gold", False)
        pair = self.engine.pairs.switch_to_margin_only("gold")
        self.assertEqual(self.store.get("pair_runtime:gold")["progress"], original_progress)
        self.assertFalse(pair["enabled"])
        self.tick()
        self.tick()
        self.assert_flat()
        self.assertIsNone(self.store.get("pair_runtime:gold")["pending"])
        self.assertFalse(self.store.pair("gold")["ordinary"]["enabled"])
        self.assertFalse(self.store.pair("gold")["cycle"]["enabled"])


class PairMarginOnlyApiTests(unittest.TestCase):
    setUp = api_cases.PairApiTests.setUp
    login = api_cases.PairApiTests.login

    def test_endpoint_keeps_write_boundary_and_rejects_configuration_payloads(self):
        endpoint = "/api/pairs/gold/margin-only"
        self.assertEqual(self.client.post(endpoint, json={}).status_code, 401)
        self.login()
        seed_pending(self.engine)
        original = self.f.store.pair("gold")
        self.assertEqual(self.client.post(endpoint, json={}, headers={"origin": "https://other.invalid"}).status_code, 403)
        for body in ({"symbol": "XAGUSD1"}, {"enabled": True}, {"ordinary": {"enabled": True}}):
            self.assertEqual(self.client.post(endpoint, json=body).status_code, 422)
        self.assertEqual(self.f.store.pair("gold"), original)
        response = self.client.post(endpoint, json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["pair"]["enabled"])
        self.assertIsNotNone(self.f.store.get("pair_runtime:gold")["pending"])

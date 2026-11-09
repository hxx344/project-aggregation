"""Two-account ownership and controls; no live API or funds are used."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import threading
import time
import unittest
from unittest.mock import patch

from tests.helpers import Fixture, account, clear_of_utc_midnight
from tests.account_fixtures import (ACCOUNT, BRACKET, ORDERS, RISK, SYMBOL,
    LocalQuoteMarket, join_margin_responses, risk_row)
from tests.test_exchange_hardening import FixtureAPI
from trading.engine import Engine
from trading.exchange import LiveBroker
from trading.models import TradingError
from trading.pairing import validate_pair
from trading.paper import PAPER_BRACKETS
from trading.store import Store


def pair_config(**changes):
    return {"id": "gold", "name": "黄金配对", "long_account_id": "test",
            "short_account_id": "second", **changes}


class PairIntegrationTests(unittest.TestCase):
    def setUp(self):
        clear_of_utc_midnight(self)
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second", "third"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.brokers["test"] = self.f.broker

    def create(self, **changes):
        return self.engine.pairs.create(pair_config(**changes))

    def test_create_reserves_members_and_blocks_every_old_account_write(self):
        pair = self.create()
        self.assertFalse(pair["enabled"])
        self.assertEqual(self.f.store.pair_for_account("test")["id"], "gold")
        self.assertEqual(self.f.store.pair_for_account("second")["id"], "gold")
        self.assertFalse(self.f.store.account("test")["enabled"])
        for action in (lambda: self.engine.enable("test", True), lambda: self.engine.enable("test", False),
                       lambda: self.engine.configure("test", {"order_notional": "2000"}),
                       lambda: self.engine.delete_account("test"), lambda: self.engine.retry("test")):
            with self.assertRaisesRegex(TradingError, "配对"):
                action()
        with patch("trading.engine.Executor.open_pair", side_effect=AssertionError("legacy writer")):
            self.assertEqual(self.engine.tick_account("test"), 30)
        state = self.engine.state()
        self.assertEqual(state["pairs"][0]["id"], "gold")
        member = next(row for row in state["accounts"] if row["id"] == "test")
        self.assertEqual(member["pair_direction"], "LONG")

    def test_pending_legacy_intents_block_creation_but_existing_positions_do_not(self):
        self.f.broker.state["positions"]["XAUUSD1:LONG"].update(qty="1", entry="4412")
        self.f.store.put("paper:test", self.f.broker.state)
        intent = {"id": "pending", "account_id": "test", "status": "pending", "kind": "leverage"}
        self.f.store.save_intent(intent)
        with self.assertRaisesRegex(TradingError, "未完成"):
            self.create()
        self.assertIsNone(self.f.store.pair("gold"))
        self.f.store.save_intent({**intent, "status": "complete"})
        # Funds pairs neither adopt nor constrain positions on either member.
        holdings = deepcopy(self.f.broker.state["positions"])
        self.create()
        self.assertEqual(self.f.store.pair_for_account("test")["id"], "gold")
        self.assertEqual(self.engine.broker(self.f.store.account("test")).state["positions"], holdings)

    def test_external_positions_survive_creation_and_release(self):
        brokers = {aid: self.engine.broker(self.f.store.account(aid)) for aid in ("test", "second")}
        for aid, symbol, side in (("test", "XAUUSD1", "SHORT"), ("test", "CLUSD1", "LONG"),
                                  ("second", "XAUUSD1", "LONG"), ("second", "SPCXUSD1", "SHORT")):
            broker = brokers[aid]
            broker.state["positions"][symbol + ":" + side].update(
                qty="0.1", entry=str(self.f.market.book(symbol).mark))
            broker.save()
        holdings = {aid: deepcopy(broker.state["positions"]) for aid, broker in brokers.items()}
        with patch("trading.paper.PaperBroker.submit", side_effect=AssertionError("read-only ownership checks")), \
                patch("trading.paper.PaperBroker.set_leverage", side_effect=AssertionError("read-only ownership checks")):
            self.create()
            # Leftover ownership from the removed ordinary strategy no longer has to be flat.
            self.f.store.put("pair_runtime:gold", {"owned": {"LONG": "1", "SHORT": "2"},
                "pending": None, "progress": {"quantities": {"LONG": "0", "SHORT": "0"}, "completed_cycles": 3},
                "daily_volume": {"2026-09-29": {"long": "100", "short": "200"}}})
            self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))
        for aid, broker in brokers.items():
            self.assertIsNone(self.f.store.pair_for_account(aid))
            self.assertEqual(broker.state["positions"], holdings[aid])

    def test_atomic_membership_excludes_overlapping_groups_from_other_store(self):
        other = Store(self.f.store.path)
        barrier = threading.Barrier(2)
        configs = [validate_pair(pair_config()), validate_pair(pair_config(id="other", long_account_id="third"))]

        def write(store, config):
            barrier.wait(timeout=2)
            try:
                store.save_pair(config, create=True)
                return True
            except TradingError:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(write, store, config) for store, config in zip((self.f.store, other), configs)]
            self.assertEqual(sorted(future.result() for future in futures), [False, True])
        self.assertEqual(len(self.f.store.pairs()), 1)

    def test_config_rejects_stale_revision_and_retains_frozen_members(self):
        pair = self.create()
        updated = self.engine.pairs.configure("gold", {"name": "新的名称"})
        self.assertGreater(updated["revision"], pair["revision"])
        with self.assertRaisesRegex(TradingError, "已变化"):
            self.f.store.save_pair(pair)
        with self.assertRaisesRegex(TradingError, "方向固定"):
            self.engine.pairs.configure("gold", {"long_account_id": "third"})
        with self.assertRaisesRegex(TradingError, "仅可修改"):
            self.engine.pairs.configure("gold", {"ordinary": {"enabled": True}})
        stored = self.f.store.pair("gold")
        self.assertEqual(stored["revision"], updated["revision"])
        self.assertFalse(stored["ordinary"]["enabled"])
        self.assertNotIn("cycle", stored)

    def test_pending_and_unknown_transfer_block_changes_and_release(self):
        self.create()
        self.f.store.put("pair_runtime:gold", {"pending": {"id": "uncertain"}})
        with self.assertRaisesRegex(TradingError, "旧版本配对开仓"):
            self.engine.pairs.configure("gold", {"name": "blocked"})
        with self.assertRaisesRegex(TradingError, "旧版本配对开仓"):
            self.engine.pairs.delete("gold")
        self.f.store.put("pair_runtime:gold", {"pending": None})
        self.f.store.put("pair_margin:gold", {"status": "unknown", "pending": {"id": "transfer"}})
        with self.assertRaisesRegex(TradingError, "划转"):
            self.engine.pairs.delete("gold")
        self.f.store.put("pair_margin:gold", {"status": "complete", "pending": None})
        self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair_for_account("test"))
        with self.assertRaisesRegex(TradingError, "历史记录"):
            self.create()

    def test_paused_legacy_pending_ticks_slowly_and_serializes_both_accounts(self):
        self.create()
        self.f.store.put("pair_runtime:gold", {"pending": {"id": "old"}})
        entered, release = threading.Event(), threading.Event()
        concurrent, maximum, calls = 0, 0, []
        guard = threading.Lock()

        class Trader:
            def margin_tick(inner, pair):
                return {}

            def tick(inner, pair, *, margin_result=None):
                nonlocal concurrent, maximum
                with guard:
                    concurrent += 1
                    maximum = max(maximum, concurrent)
                    calls.append(pair["enabled"])
                entered.set()
                release.wait(timeout=3)
                with guard:
                    concurrent -= 1
                return {"pending": {"id": "old"}}

        self.engine.pairs.trader = Trader()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.engine.pairs.tick, "gold")
            self.assertTrue(entered.wait(timeout=2))
            second = pool.submit(self.engine.pairs.tick, "gold")
            time.sleep(.02)
            release.set()
            # Legacy batches wait for a rollback; fast polling cannot resolve them.
            self.assertEqual(first.result(), 30)
            self.assertEqual(second.result(), 30)
        self.assertEqual(maximum, 1)
        self.assertEqual(calls, [False, False])

    def test_group_monitoring_includes_xau_with_paused_members(self):
        pair = self.create()
        pair["enabled"] = True
        self.f.store.save_pair(pair)
        self.assertIn("XAUUSD1", self.engine.required_monitoring_symbols())
        self.assertIsNotNone(self.engine.pairs.active_for_account("test"))

    def test_group_polling_keeps_transfers_fast_and_idle_work_bounded(self):
        pair = self.create()
        manager = self.engine.pairs
        self.assertEqual(manager.poll_interval(pair, {}), 30)
        self.assertEqual(manager.poll_interval(pair, {"pending": {"id": "old"}}), 30)
        self.assertEqual(manager.poll_interval(pair, {"progress": {"quantities": {"LONG": "1"}}}), 30)
        self.f.store.put("pair_margin:gold", {"pending": {"id": "transfer"}})
        self.assertEqual(manager.poll_interval(pair, {}), 1)
        self.f.store.put("pair_margin:gold", {})
        pair = {**pair, "enabled": True}
        self.assertEqual(manager.poll_interval(pair, {}), 5)
        pair["margin"] = {**pair["margin"], "check_interval_seconds": 2}
        self.assertEqual(manager.poll_interval(pair, {}), 2)
        # A rolled-back ordinary flag is ignored by the funds-only scheduler.
        pair["ordinary"] = {**pair["ordinary"], "enabled": True}
        self.assertEqual(manager.poll_interval(pair, {}), 2)

    def test_manager_respects_current_worker_retry_after(self):
        from unittest.mock import Mock
        self.create()
        self.engine.pairs.trader = Mock()
        self.engine.pairs.trader.tick.return_value = {"pending": {"id": "old"}, "retry_after": 60}
        self.assertEqual(self.engine.pairs.tick("gold"), 60)
        self.engine.pairs.trader.tick.return_value = {"pending": {"id": "old"}}
        self.assertEqual(self.engine.pairs.tick("gold"), 30)

    def test_states_preserves_margin_reason_and_newer_durable_pending(self):
        pair = self.create(margin={"enabled": True})
        self.f.store.save_pair({**pair, "enabled": True})
        self.f.store.put("pair_runtime:gold", {"margin": {"enabled": True, "checked_at": 100,
            "status": "waiting", "reason": "余额差未达到阈值", "pending": None, "last_transfer": None}})
        self.f.store.put("pair_margin:gold", {"checked_at": 100, "next_check_at": 105})
        state = self.engine.pairs.states()[0]["state"]["margin"]
        self.assertEqual(state["status"], "waiting")
        self.assertEqual(state["reason"], "余额差未达到阈值")
        self.f.store.put("pair_margin:gold", {"checked_at": 100, "pending": {
            "status": "unknown", "request_id": "new", "identity": "internal", "before_receipts": {}}})
        state = self.engine.state()["pairs"][0]["state"]["margin"]
        self.assertEqual(state["status"], "unknown")
        self.assertTrue(state["blocks_trading"])
        self.assertEqual(state["pending"]["request_id"], "new")
        self.assertNotIn("identity", state["pending"])
        self.f.store.put("pair_margin:gold", [])
        self.assertEqual(self.engine.pairs.states()[0]["state"]["margin"]["status"], "blocked")

    def test_raw_legacy_intent_cannot_bypass_pair_ownership(self):
        self.create()
        with self.assertRaisesRegex(TradingError, "配对组"):
            self.f.store.save_account({**self.f.store.account("test"), "enabled": True})
        with self.assertRaisesRegex(TradingError, "配对组"):
            self.f.store.save_intent({"id": "bad", "account_id": "test", "status": "pending", "kind": "pair"})
        self.assertIsNone(self.f.store.intent("test"))


class PairSnapshotLifecycleTests(unittest.TestCase):
    """Real broker generation checks with offline GET fixtures, never credentials."""
    create = PairIntegrationTests.create

    def setUp(self):
        PairIntegrationTests.setUp(self)
        self.live = {}
        for aid in ("test", "second"):
            self.f.store.save_account({**self.f.store.account(aid), "mode": "live"})
            responses = join_margin_responses()
            responses["/fapi/v3/positionSide/dual"] = {"dualSidePosition": True}
            responses[RISK] = [risk_row(row) for row in responses[ACCOUNT]["positions"]]
            responses[BRACKET] = {"symbol": SYMBOL, "brackets": PAPER_BRACKETS}
            responses[ORDERS] = []
            broker = LiveBroker({}, LocalQuoteMarket(), api=FixtureAPI(responses))
            digit = "1" if aid == "test" else "2"
            broker.api.credentials = {"user": "0x" + digit * 40, "signer": "0x" + digit * 39 + "f"}
            self.live[aid] = self.engine.brokers[aid] = broker
        patcher = patch.object(self.engine, "live_allowed", return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch("trading.margin_balance.MarginBalancer.verify_members", return_value={"verified": True})
        self.verify = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.assertTrue(all(call[0] == "GET" for broker in self.live.values() for call in broker.api.calls))

    def test_enable_rechecks_identity_after_master_verification_without_clearing_attention(self):
        self.create(margin={"enabled": True})
        runtime = {"attention": "仍需核对", "owned": {"LONG": "0", "SHORT": "0"}}
        self.f.store.put("pair_runtime:gold", runtime)
        # Funds-only start reads no positions; it rechecks member identity instead.
        self.verify.side_effect = lambda pair: setattr(self.live["second"].api, "credentials",
            {"user": "0x" + "3" * 40, "signer": "0x" + "3" * 39 + "f"})
        with self.assertRaisesRegex(TradingError, "身份已变化"):
            self.engine.pairs.enable("gold", True)
        self.assertFalse(self.f.store.pair("gold")["enabled"])
        self.assertEqual(self.f.store.get("pair_runtime:gold"), runtime)

    def test_delete_rechecks_identity_before_releasing_members(self):
        self.create()
        from trading.pair_execution import PairTrader
        original = PairTrader._members

        def members(trader, *args, **kwargs):
            result = original(trader, *args, **kwargs)
            self.live["test"].api.credentials = {"user": "0x" + "3" * 40, "signer": "0x" + "3" * 39 + "f"}
            return result

        with patch.object(PairTrader, "_members", members), self.assertRaisesRegex(TradingError, "身份已变化"):
            self.engine.pairs.delete("gold")
        self.assertIsNotNone(self.f.store.pair("gold"))
        self.assertEqual(self.f.store.pair_for_account("test")["id"], "gold")
        self.assertIsNone(self.f.store.get("pair_deleted:gold"))

    def test_current_reads_allow_enable_pause_and_release(self):
        self.create()
        with self.assertRaisesRegex(TradingError, "请先开启保证金平衡"):
            self.engine.pairs.enable("gold", True)
        self.engine.pairs.configure("gold", {"margin": {"enabled": True}})
        self.engine.pairs.enable("gold", True)
        self.assertTrue(self.f.store.pair("gold")["enabled"])
        self.engine.pairs.enable("gold", False)
        self.engine.pairs.delete("gold")
        self.assertIsNone(self.f.store.pair("gold"))

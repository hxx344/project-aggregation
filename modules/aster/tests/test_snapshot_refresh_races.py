"""Account snapshot read conflicts retry without new orders; genuine account changes revoke reads."""
from copy import deepcopy
import time
from unittest import TestCase
from unittest.mock import patch

from tests.helpers import Fixture
from tests.account_fixtures import ACCOUNT, BRACKET, RISK, SYMBOL, LocalQuoteMarket, join_margin_responses, risk_row
from tests.test_exchange_hardening import FixtureAPI
from trading.engine import Engine
from trading.exchange import LiveBroker, SnapshotSuperseded
from trading.execution import Executor
from trading.models import SYMBOLS
from trading.paper import PAPER_BRACKETS


class AccountEventSnapshotTests(TestCase):
    def setUp(self):
        responses = join_margin_responses()
        responses["/fapi/v3/positionSide/dual"] = {"dualSidePosition": True}
        responses[RISK] = [risk_row(row) for row in responses[ACCOUNT]["positions"]]
        responses[BRACKET] = {"symbol": SYMBOL, "brackets": PAPER_BRACKETS}
        self.api = FixtureAPI(responses)
        self.broker = LiveBroker({}, LocalQuoteMarket(), api=self.api)

    def test_real_account_events_interrupt_snapshot_reads(self):
        original = self.api.call
        for event in ("ACCOUNT_UPDATE", "ORDER_TRADE_UPDATE", "ACCOUNT_CONFIG_UPDATE"):
            def changed(method, path, *args, **kwargs):
                value = original(method, path, *args, **kwargs)
                if path == ACCOUNT:
                    self.broker._private_account_event(event)
                return value
            with self.subTest(event=event), \
                 patch.object(self.api, "call", side_effect=changed), self.assertRaises(SnapshotSuperseded):
                self.broker.snapshot([SYMBOL])


class SnapshotRetryTests(TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        owner = self.f.store.account("test")
        owner["policy"]["symbols"] = list(SYMBOLS)
        self.f.store.save_account(owner)
        self.engine = Engine(self.f.store, market=self.f.market)
        self.engine.brokers["test"] = self.f.broker
        now = time.time()
        for symbol in SYMBOLS:
            self.engine.markets[symbol] = {
                "status": "ok", "checked_at": now,
                "capacity_checked_at": {str(tier): now for tier in (5, 10, 20)},
                "capacities": {"5": "500000", "10": "0", "20": "0"},
            }

    def pending_batch(self):
        with patch.object(Executor, "reconcile", return_value="simulated interruption"):
            self.engine.tick_account("test")
        pending = self.f.store.intent("test")
        self.assertEqual(pending["kind"], "pair")
        return pending

    def test_reconciliation_conflict_waits_briefly_and_resumes_without_resubmission(self):
        pending = self.pending_batch()
        orders = deepcopy(self.f.broker.state["orders"])
        before = time.monotonic()
        with patch.object(self.f.broker, "snapshot", side_effect=SnapshotSuperseded("账户在查询期间发生变化，等待新快照")):
            self.assertEqual(self.engine.tick_account("test"), 1)
        self.assertEqual(self.engine.views["test"]["status"], "waiting")
        self.assertTrue(self.f.store.account("test")["enabled"])
        self.assertEqual(self.f.store.intent("test")["id"], pending["id"])
        self.assertLess(self.engine.work("test").backoff - before, 2)
        self.assertFalse(any(row["kind"] == "error" for row in self.f.store.events()))
        with patch.object(self.f.broker, "submit", side_effect=AssertionError("must only reconcile")):
            self.engine.tick_account("test")
        self.assertIsNone(self.f.store.intent("test"))
        self.assertEqual(self.f.broker.state["orders"], orders)

    def test_post_fill_conflict_keeps_risk_marker_and_existing_longer_backoff(self):
        marker = {"symbol": "CLUSD1", "leverage": 5}
        self.f.store.put("post_fill_check:test", marker)
        until = self.engine.work("test").backoff = time.monotonic() + 180
        with patch.object(self.f.broker, "snapshot", side_effect=SnapshotSuperseded("read changed")):
            self.assertEqual(self.engine.tick_account("test"), 1)
        self.assertEqual(self.engine.views["test"]["status"], "waiting")
        self.assertEqual(self.engine.work("test").backoff, until)
        self.assertEqual(self.f.store.get("post_fill_check:test"), marker)
        self.assertEqual(self.f.broker.state["orders"], {})

    def test_existing_attention_is_not_cleared_by_a_transient_read_conflict(self):
        pending = self.pending_batch()
        pending.update(status="attention", last_error="核对外部持仓")
        self.f.store.save_intent(pending)
        self.f.store.pause_account(self.f.store.account("test"), "核对外部持仓")
        with patch.object(self.f.broker, "snapshot", side_effect=SnapshotSuperseded("read changed")):
            self.assertEqual(self.engine.tick_account("test"), 1)
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.assertEqual(self.engine.views["test"]["status"], "attention")
        self.assertEqual(self.engine.views["test"]["reason"], "核对外部持仓")
        self.assertEqual(self.f.store.intent("test")["status"], "attention")

    def test_manual_pause_is_preserved_while_an_existing_batch_waits_for_a_new_read(self):
        pending = self.pending_batch()
        self.engine.enable("test", False)
        orders = deepcopy(self.f.broker.state["orders"])
        with patch.object(self.f.broker, "snapshot", side_effect=SnapshotSuperseded("read changed")):
            self.assertEqual(self.engine.tick_account("test"), 1)
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.assertEqual(self.engine.views["test"]["status"], "paused")
        self.assertEqual(self.f.store.intent("test")["id"], pending["id"])
        self.assertEqual(self.f.broker.state["orders"], orders)

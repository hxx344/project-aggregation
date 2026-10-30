"""Real ADL pauses retain funds intent through managed, offline HTTP dispatch."""
from copy import deepcopy
import os
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.test_managed_margin_transfer import ManagedMarginTransferTests as Fixture
from trading import adl
from trading.adl_exchange import ReductionPosition, ReductionSnapshot
from trading.exchange import BudgetWait, RateBudget, RequestNotSent
from trading.margin_control import margin_running
from trading.models import TradingError, dec
from trading.server import create_app
from trading.store import Store


SYMBOL = "BTCUSDT"


class AdlMarginPriorityTests(unittest.TestCase):
    fixture_setup = Fixture.setUp
    api = Fixture.api
    transfer_api = Fixture.transfer_api
    snapshots = Fixture.snapshots
    state = Fixture.state
    posts = Fixture.posts
    unresolved = Fixture.unresolved
    shared_operations = Fixture.shared_operations
    pair_manager = Fixture.pair_manager
    restart_writer = Fixture.restart_writer

    def setUp(self):
        self.fixture_setup()
        self.manager = self.pair_manager()
        self.engine.adl = adl.AdlController(self.engine)
        self.private_wakes = []
        self.engine.wake_private_stream = self.private_wakes.append
        self.now = time.time()
        clock = patch("time.time", side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.balances.update(long="2000", short="2000")
        self.scene_error = BudgetWait("ADL scene budget wait", retry_after=120)
        self.scene_reads = []
        snapshots = patch("trading.adl.adl_exchange.reduction_snapshot", side_effect=self.adl_snapshot)
        snapshots.start()
        self.addCleanup(snapshots.stop)

    def adl_snapshot(self, broker, **kwargs):
        self.scene_reads.append({"broker": broker, "posts": len(self.posts())})
        if self.scene_error is not None:
            raise self.scene_error
        aid = next(aid for aid, current in self.engine.brokers.items() if current is broker)
        direction = "LONG" if aid == "long" else "SHORT"
        quantity = dec("2")
        position = ReductionPosition(SYMBOL, direction, quantity, dec("1000"), dec("1000"), 17,
                                     quantity if direction == "LONG" else -quantity)
        return ReductionSnapshot((position,), True, True, [], self.now, broker._snapshot_generation,
            position_updates={(SYMBOL, direction): self.now}, _broker=broker, _api=broker.api,
            _account_identity=tuple(broker.api.credentials[key] for key in ("user", "signer")))

    def observe(self, order_id=42):
        self.engine.adl.observe("long", self.engine.brokers["long"], {
            "e": "ORDER_TRADE_UPDATE", "E": int(self.now * 1000), "o": {
                "c": "adl_autoclose", "s": SYMBOL, "i": order_id, "ps": "LONG", "S": "SELL",
                "q": "3", "z": "1", "X": "PARTIALLY_FILLED", "ap": "1000", "T": int(self.now * 1000)}})

    def incident(self):
        return self.store.get("adl_pair:gold")

    def control(self):
        return self.store.get("pair_margin_control:gold")

    def running(self):
        return margin_running(self.store.pair("gold"), self.control())

    def tick(self, advance=0):
        self.now += advance
        return self.manager.tick("gold")

    def due(self):
        state = self.state()
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)

    def imbalance(self):
        self.balances.update(long="3000", short="1000")
        self.due()

    def begin_blocked(self):
        self.observe()
        self.tick()
        self.assertEqual(self.incident()["status"], "blocked")
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.assertTrue(self.running())
        self.assertEqual(self.posts(), [])

    def forget_control(self):
        with self.store.connect() as db:
            db.execute("DELETE FROM kv WHERE key=?", ("pair_margin_control:gold",))

    def test_real_active_incident_runs_funds_before_its_first_scene(self):
        self.observe()
        controller = self.engine.adl
        pair = self.store.pair("gold")
        accounts, brokers, identities = controller._context(pair)
        controller._flush(accounts["long"], brokers["long"], pair)
        with self.store.connect() as db:
            records = adl._unhandled(db, "gold")
        # Stop at the real durable boundary before any ADL scene has been read.
        # No replacement tick or hand-written incident authorizes the transfer.
        with self.writer.accounts(["long", "short"]), self.manager.locked(pair):
            controller._begin(pair, records, accounts, identities)
        self.assertEqual(self.incident()["status"], "active")
        self.assertTrue(self.running())
        self.imbalance()
        self.tick()
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.scene_reads[0]["posts"], 1)
        self.assertEqual(self.incident()["status"], "blocked")
        self.assertFalse(self.store.pair("gold")["enabled"])

    def test_real_blocked_incident_keeps_new_funds_transfers_and_its_retry_deadline(self):
        self.begin_blocked()
        incident = deepcopy(self.incident())
        self.imbalance()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.state()["last_transfer"]["status"], "acknowledged")
        self.assertEqual(self.incident(), incident)
        self.assertTrue(self.running())
        with self.assertRaises(TradingError):
            self.engine.adl.require_clear("gold")

    def test_completed_hold_keeps_funds_running_without_resuming_strategy(self):
        self.scene_error = None
        self.observe()
        self.tick()
        incident = deepcopy(self.incident())
        self.assertEqual(incident["status"], "completed")
        self.assertTrue(incident["hold"])
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.imbalance()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.incident(), incident)
        self.assertTrue(self.running())
        self.assertEqual(self.store.get("pair_runtime:gold")["phase"], "paused")
        with self.assertRaises(TradingError):
            self.engine.adl.require_clear("gold")

    def test_durable_continuation_survives_store_writer_and_controller_restart(self):
        self.begin_blocked()
        control, incident = deepcopy(self.control()), deepcopy(self.incident())
        self.store = Store(self.store.path)
        self.engine.store = self.store
        self.restart_writer()
        self.manager = self.pair_manager()
        self.engine.adl = adl.AdlController(self.engine)
        self.assertTrue(self.running())
        self.assertEqual(self.control(), control)
        self.imbalance()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.incident(), incident)
        self.assertFalse(self.store.pair("gold")["enabled"])

    def test_user_pause_stops_new_transfers_without_freezing_adl_completion(self):
        self.begin_blocked()
        before = deepcopy(self.incident())
        pair = self.manager.enable("gold", False)
        self.assertFalse(self.running())
        self.assertEqual(pair["revision"], before["revision"])
        self.assertEqual(self.incident(), before)
        self.imbalance()
        self.scene_error = None
        self.now = before["retry_at"] + 1
        self.tick()
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.incident()["status"], "completed")
        self.assertTrue(self.incident()["hold"])
        self.assertEqual(self.incident()["revision"], before["revision"])
        self.assertFalse(self.running())

    def test_adl_after_an_existing_user_pause_never_grants_funds_intent(self):
        self.manager.enable("gold", False)
        self.observe()
        self.imbalance()
        self.tick()
        self.assertEqual(self.incident()["status"], "blocked")
        self.assertFalse(self.running())
        self.assertEqual(self.posts(), [])
        self.tick(1)
        self.assertEqual(self.posts(), [])
        self.assertIsNone(self.state().get("pending"))

    def test_explicit_funds_start_after_user_pause_preserves_active_adl_hold(self):
        self.begin_blocked()
        self.manager.enable("gold", False)
        incident = deepcopy(self.incident())
        pair = deepcopy(self.store.pair("gold"))
        self.assertFalse(self.running())
        with self.assertRaises(TradingError):
            self.manager.enable("gold", True)
        self.manager.enable_adl_margin("gold")
        self.assertTrue(self.running())
        self.assertEqual(self.store.pair("gold"), pair)
        self.assertEqual(self.incident(), incident)
        with self.assertRaises(TradingError):
            self.engine.adl.require_clear("gold")
        self.imbalance()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertFalse(self.store.pair("gold")["enabled"])

    def test_old_incident_without_control_requires_explicit_funds_start(self):
        self.begin_blocked()
        self.forget_control()
        pair, incident = deepcopy(self.store.pair("gold")), deepcopy(self.incident())
        self.imbalance()
        self.tick(1)
        self.assertEqual(self.posts(), [])
        self.assertFalse(self.running())
        saved = self.manager.enable_adl_margin("gold")
        self.assertEqual(saved, pair)
        self.assertEqual(self.incident(), incident)
        self.assertTrue(self.running())
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertFalse(self.store.pair("gold")["enabled"])

    def test_unknown_funds_transfer_is_not_replaced_during_adl(self):
        self.begin_blocked()
        self.imbalance()
        self.fail_dispatch = True
        self.tick(1)
        original = deepcopy(self.state()["pending"])
        unresolved = deepcopy(self.unresolved())
        self.assertEqual(original["status"], "unknown")
        self.assertEqual(len(self.posts()), 1)
        self.fail_dispatch = False
        self.balances.update(long="4000", short="0")
        self.tick(1)
        self.assertEqual(self.state()["pending"]["request_id"], original["request_id"])
        self.tick(6)
        self.assertIsNone(self.state()["pending"])
        archive = self.store.get("pair_margin_skipped:gold:" + original["request_id"])
        self.assertEqual(archive["original"]["status"], "unknown")
        self.assertEqual(archive["original"]["request_id"], original["request_id"])
        # Fresh balances may archive the uncertain local journal. The shared
        # unknown remains unresolved and must still veto a replacement POST.
        self.due()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.unresolved(), unresolved)
        self.assertFalse(self.store.pair("gold")["enabled"])
        self.assertTrue(self.running())

    def test_user_revocation_in_final_http_hook_prevents_transport(self):
        self.begin_blocked()
        self.imbalance()
        original = self.transfer_api
        revoked = []

        def transfer(*args, before_submit, **kwargs):
            def revoke():
                revoked.append(self.manager.enable("gold", False))
                before_submit()
            return original(*args, before_submit=revoke, **kwargs)

        with patch("trading.margin_balance.TransferAPI", side_effect=transfer):
            self.tick(1)
        self.assertEqual(len(revoked), 1)
        self.assertEqual(self.posts(), [])
        self.assertFalse(self.running())
        self.assertIsNone(self.state().get("pending"))
        self.assertEqual(self.state()["last_transfer"]["status"], "rejected")
        self.assertEqual(self.unresolved(), [])

    def test_long_adl_retry_does_not_postpone_funds_deadline(self):
        self.begin_blocked()
        initial_reads = len(self.scene_reads)
        deadline = self.state()["next_check_at"]
        self.assertGreater(self.incident()["retry_at"], deadline)
        self.balances.update(long="3000", short="1000")
        delay = self.tick(1)
        self.assertLessEqual(delay, deadline - self.now)
        self.assertEqual(self.posts(), [])
        self.now = deadline
        self.tick()
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(len(self.scene_reads), initial_reads)

    def test_real_adl_hold_funds_can_spend_the_reserved_budget(self):
        self.begin_blocked()
        budget = RateBudget(margin_reserve=120)
        for broker in self.engine.brokers.values():
            broker.api.budget = budget
        with budget.reconciliation():
            budget.reserve(1680)
        self.imbalance()
        self.tick(1)
        self.assertEqual(len(self.posts()), 1)
        self.assertLessEqual(budget.snapshot()["used"], 1800)
        self.assertTrue(self.running())

    def test_explicit_funds_api_requires_authentication_origin_and_empty_strict_body(self):
        self.begin_blocked()
        self.forget_control()
        password = "adl-margin-public-api-test-password"
        with patch.dict(os.environ, {"ASTER_DASHBOARD_PASSWORD": password}):
            app = create_app(self.engine, start_engine=False)
        path = "/api/pairs/gold/adl-margin-enable"
        with TestClient(app, headers={"Origin": "http://testserver"}) as client:
            self.assertEqual(client.post(path, json={}).status_code, 401)
            login = client.post("/api/login", json={"password": password})
            self.assertEqual(login.status_code, 200, login.text)
            self.assertEqual(client.post(path, json={}, headers={"Origin": "https://other.invalid"}).status_code, 403)
            self.assertEqual(client.post(path).status_code, 422)
            for body in ({"enabled": True}, {"force": True}, {"pair_id": "other"}):
                with self.subTest(body=body):
                    self.assertEqual(client.post(path, json=body).status_code, 422)
            self.assertFalse(self.running())
            before = deepcopy(self.incident())
            response = client.post(path, json={})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertFalse(response.json()["pair"]["enabled"])
            self.assertEqual(self.incident(), before)
            self.assertTrue(self.running())
            self.imbalance()
            self.tick(1)
            self.assertEqual(len(self.posts()), 1)

    def test_explicit_funds_start_uses_reserved_budget_and_respects_exchange_backoff(self):
        self.begin_blocked()
        self.forget_control()
        budget = RateBudget(margin_reserve=120)
        for broker in self.engine.brokers.values():
            broker.api.budget = budget
        with budget.reconciliation():
            budget.reserve(1680)
        self.manager.enable_adl_margin("gold")
        self.assertTrue(self.running())
        self.assertGreater(budget.snapshot()["used"], 1680)
        self.assertEqual(self.posts(), [])
        self.manager.enable("gold", False)
        budget.until = time.monotonic() + 60
        with self.assertRaises(RequestNotSent):
            self.manager.enable_adl_margin("gold")
        self.assertFalse(self.running())
        self.assertEqual(self.posts(), [])

    def test_explicit_funds_start_cannot_overwrite_a_pause_during_verification(self):
        from trading.margin_balance import MarginBalancer
        self.begin_blocked()
        self.forget_control()
        original = MarginBalancer.verify_members
        incident, pair = deepcopy(self.incident()), deepcopy(self.store.pair("gold"))

        def verify(balancer, current):
            result = original(balancer, current)
            self.manager.enable("gold", False)
            return result

        with patch.object(MarginBalancer, "verify_members", verify):
            with self.assertRaisesRegex(TradingError, "状态已变化"):
                self.manager.enable_adl_margin("gold")
        self.assertFalse(self.running())
        self.assertEqual(self.incident(), incident)
        self.assertEqual(self.store.pair("gold"), pair)
        self.assertEqual(self.posts(), [])

    def test_explicit_funds_start_rejects_unrelated_or_changed_incidents(self):
        self.manager.enable("gold", False)
        self.assertFalse(self.running())
        with self.assertRaises(TradingError):
            self.manager.enable_adl_margin("gold")
        self.observe()
        self.tick()
        self.assertFalse(self.running())
        incident = deepcopy(self.incident())
        for changes in ({"pair_id": "other"}, {"revision": incident["revision"] + 1},
                        {"hold": False}, {"status": "unexpected"}):
            with self.subTest(changes=changes):
                self.store.put("adl_pair:gold", {**incident, **changes})
                with self.assertRaises(TradingError):
                    self.manager.enable_adl_margin("gold")
                self.assertFalse(self.running())
        self.assertEqual(self.posts(), [])


del Fixture  # Reused helpers are not a second discovered test suite.

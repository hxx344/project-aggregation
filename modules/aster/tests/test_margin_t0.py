"""Funds priority through real SQLite admission and final HTTPX hooks; offline."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import json
import os
import sqlite3
import threading
import time
import unittest
from unittest.mock import patch

from eth_utils import to_checksum_address

from tests.test_managed_margin_transfer import ManagedMarginTransferTests as Fixture
from tests.scheduler_fixtures import _Future, _Pool
from trading.engine import Engine
from trading.exchange import BudgetWait, RateBudget, RequestNotSent
from trading.execution import Executor
from trading.models import TradingError


class MarginT0Tests(unittest.TestCase):
    setUp = Fixture.setUp
    api = Fixture.api
    transfer_api = Fixture.transfer_api
    snapshots = Fixture.snapshots
    state = Fixture.state
    posts = Fixture.posts
    unresolved = Fixture.unresolved
    shared_operations = Fixture.shared_operations
    pair_manager = Fixture.pair_manager

    def old_orders(self):
        with self.writer.accounts(["long", "short"]) as ticket:
            for index in range(6):
                self.writer.registry.import_unknown(ticket, "aster:legacy:order:old-" + str(index),
                    {"order": Executor.order("XAUUSD1", "LONG", "BUY", 1, "old-" + str(index))})
        return deepcopy(self.shared_operations())

    def params(self):
        return {"fromAccountAddress": self.credentials["long"]["user"],
            "toAccountAddress": self.credentials["short"]["user"], "asset": "USD1",
            "amount": "1000.00000000", "kindType": "FUTURE_FUTURE"}

    def funding(self):
        return {"source": "long", "destination": "short", "master": "master:ASTER_MASTER"}

    def test_six_legacy_unknown_orders_do_not_gate_funds_or_require_order_or_market_reads(self):
        old = self.old_orders()
        with patch.object(self.engine.market, "book", side_effect=AssertionError("no market read")):
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual([row for row in self.shared_operations() if row["operation_id"].startswith("aster:legacy:")], old)
        self.assertEqual(len(self.unresolved()), 6)
        self.assertFalse(any("order" in path.lower() for _, _, path in self.requests))

    def test_every_real_single_account_intent_producer_imports_without_gating_t0(self):
        from tests import test_execution

        # Execute the real producers, then load their SQLite-serialized records.
        # The fixtures supply paper transports; intent construction is production code.
        producers = (
            (test_execution.ExecutionTests(), "pair", lambda case: case.open()),
            (test_execution.ExecutionTests(), "leverage", lambda case:
                case.executor.leverage(case.f.account, "XAUUSD1", 5, 10)),
        )
        records = []
        for case, kind, invoke in producers:
            with self.subTest(producer=kind):
                case.setUp()
                captured = []
                save = case.f.store.save_intent
                def persisted(intent):
                    with case.f.store.connect() as db:
                        row = db.execute("SELECT data FROM intents WHERE id=?", (intent["id"],)).fetchone()
                    if row:
                        value = json.loads(row[0])
                        if value["status"] not in ("complete", "aborted"):
                            captured.append(value)
                def capture_save(intent):
                    result = save(intent)
                    persisted(intent)
                    return result
                try:
                    with patch.object(case.f.store, "save_intent", side_effect=capture_save):
                        invoke(case)
                    self.assertTrue(captured, kind)
                    record = max(captured, key=lambda value: len(value.get("orders", [])))
                    self.assertEqual(record["kind"], kind)
                    # Map the paper fixture account to this managed fixture's live owner.
                    records.append({**record, "account_id": "long"})
                finally:
                    case.doCleanups()
        # Retired producers can still leave unresolved records in old ledgers.
        pair = next(record for record in records if record["kind"] == "pair")
        for kind in ("cycle", "migration"):
            legacy = deepcopy(pair)
            legacy.update(id=pair["id"] + "-" + kind, kind=kind)
            for order in legacy["orders"]:
                order["newClientOrderId"] = order["newClientOrderId"][:20] + kind[:3]
            if kind == "migration":
                legacy["order_roles"] = {order["newClientOrderId"]: role for order, role
                                         in zip(legacy["orders"], ("open_target", "close_source"))}
            records.append(legacy)
        self.assertEqual({record["kind"] for record in records}, {"pair", "leverage", "cycle", "migration"})
        def import_records():
            for record in records:
                with self.store.connect() as db:
                    db.execute("INSERT INTO intents VALUES (?,?,?,?)", (record["id"], "long", record["status"], json.dumps(record)))
                try:
                    self.writer.import_legacy()
                finally:
                    with self.store.connect() as db:
                        db.execute("DELETE FROM intents WHERE id=?", (record["id"],))
        def operations():
            with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
                db.row_factory = sqlite3.Row
                return [dict(row) for row in db.execute("SELECT * FROM aw_operations ORDER BY operation_id")]
        self.requests.clear()
        import_records()
        old = operations()
        self.assertEqual(len(old), 4)
        self.assertTrue(all(row["state"] == "unknown" and row["intent_action"] in ("order", "leverage") for row in old))
        with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
            db.execute("UPDATE aw_operations SET intent_action=NULL,intent_target_hash=NULL")
            db.commit()
        import_records()
        self.assertEqual(operations(), old)  # Includes original body hashes, tickets and creation times.
        with self.writer.accounts(["long"]) as ticket:
            with self.assertRaises(Exception) as rejected:
                self.writer.registry.prepare(ticket, "ordinary-after-real-import",
                    {"order": Executor.order("XAUUSD1", "LONG", "BUY", 1, "ordinary-after-real-import")})
            self.assertEqual(rejected.exception.code, "ACCOUNT_UNRESOLVED")
        result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual([row for row in operations() if row["operation_id"].startswith("aster:legacy:")], old)
        self.assertFalse(any("order" in path.lower() for _, _, path in self.requests))

    def test_scheduler_transfers_before_adl_hold_with_stale_strategy_identity_and_pending(self):
        old = self.old_orders()
        self.store.put("pair_runtime:gold", {"identities": {"long": {"user": "old"}},
            "pending": {"id": "old-strategy", "identities": {}}, "recovery_watch": {"batches": []}})
        manager = self.pair_manager()
        def adl(pair):
            self.assertEqual(len(self.posts()), 1)
            return {"hold": True, "retry_after": 30}
        self.engine.adl.tick = adl
        self.engine.adl.require_clear = lambda *args: (_ for _ in ()).throw(TradingError("ADL hold"))
        with patch.object(self.engine.market, "book", side_effect=AssertionError("no market read")):
            manager.tick(self.pair["id"])
        self.assertEqual(len(self.posts()), 1)
        runtime = self.store.get("pair_runtime:gold")
        self.assertEqual(runtime["pending"]["id"], "old-strategy")
        self.assertEqual(runtime["margin"]["status"], "acknowledged")
        self.assertEqual([row for row in self.shared_operations() if row["operation_id"].startswith("aster:legacy:")], old)

    def test_scheduler_does_not_wait_for_old_single_account_intent(self):
        manager = self.pair_manager()
        intent = {"id": "old-intent", "account_id": "long", "status": "pending", "kind": "leverage"}
        with self.store.connect() as db:
            db.execute("INSERT INTO intents VALUES (?,?,?,?)", (intent["id"], "long", "pending", json.dumps(intent)))
        self.engine.adl.tick = lambda pair: None
        manager.tick(self.pair["id"])
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.store.intent("long")["id"], "old-intent")
        self.assertEqual(self.store.get("pair_runtime:gold")["margin"]["status"], "acknowledged")

    def test_ordinary_or_legacy_cycle_adl_wait_cannot_delay_the_next_funds_check(self):
        manager = self.pair_manager()
        self.engine.adl.tick = lambda pair: {"hold": True, "retry_after": 120}
        old = self.old_orders()
        self.store.put("pair_runtime:gold", {"identities": {"long": {"user": "old"}}, "pending": {"id": "strategy-old"}})
        wall = time.time()
        for index, mode in enumerate(("ordinary", "cycle")):
            with self.subTest(mode=mode):
                pair = deepcopy(self.store.pair("gold"))
                pair["ordinary"]["enabled"] = mode == "ordinary"
                runtime = self.store.get("pair_runtime:gold")
                runtime["pending"]["kind"] = mode
                self.store.put("pair_runtime:gold", runtime)
                pair["margin"]["cooldown_seconds"] = 1
                self.pair = self.store.save_pair(pair)
                self.balances.update(long="3000", short="1000")
                with patch("time.time", return_value=wall + index * 6), \
                        patch.object(self.engine.market, "book", side_effect=AssertionError("no market prerequisite")):
                    delay = manager.tick("gold")
                self.assertGreater(delay, 0)
                self.assertLessEqual(delay, 5)
                self.assertEqual(len(self.posts()), index + 1)
        self.assertEqual([row for row in self.shared_operations() if row["operation_id"].startswith("aster:legacy:")], old)

    def test_strategy_exception_keeps_the_completed_funds_result(self):
        pair = deepcopy(self.pair)
        pair["ordinary"]["enabled"] = True
        self.pair = self.store.save_pair(pair)
        manager = self.pair_manager()
        self.engine.adl.tick = lambda pair: None
        self.engine.adl.require_clear = lambda *args: (_ for _ in ()).throw(TradingError("strategy ADL hold"))
        manager.tick("gold")
        self.assertEqual(len(self.posts()), 1)
        runtime = self.store.get("pair_runtime:gold")
        self.assertEqual(runtime["margin"]["status"], "acknowledged")
        self.assertEqual({side: row["available"] for side, row in runtime["margin_balances"].items()},
            {"long": "2000", "short": "2000"})
        self.assertTrue(all(row["timestamp"] >= runtime["margin"]["checked_at"]
            for row in runtime["margin_balances"].values()))

    def test_scheduler_paused_pair_never_posts(self):
        manager = self.pair_manager()
        self.pair = self.store.save_pair({**self.pair, "enabled": False})
        self.engine.adl.tick = lambda pair: {"hold": True, "retry_after": 5}
        manager.tick(self.pair["id"])
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.store.get("pair_runtime:gold")["margin"]["status"], "paused")

    def test_unknown_transfer_never_sends_a_replacement_after_new_imbalance(self):
        self.fail_dispatch = True
        self.balancer.tick(self.pair, self.snapshots())
        original = deepcopy(self.unresolved())
        self.fail_dispatch = False
        self.balances.update(long="4000", short="1000")
        state = self.state()
        state.update(next_check_at=0, cooldown_until=0)
        self.store.put("pair_margin:gold", state)
        self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.unresolved(), original)

    def test_funding_batch_cannot_dispatch_an_order_or_wrong_master(self):
        for wrong_master in (False, True):
            with self.subTest(wrong_master=wrong_master):
                api = self.transfer_api(self.credentials["long" if wrong_master else "master"])
                self.writer.bind_api(api, "long" if wrong_master else "master:ASTER_MASTER")
                with self.writer.accounts(list(self.funding().values())):
                    with self.assertRaises(RequestNotSent):
                        with self.writer.batch("aster:transfer:wrong-" + str(wrong_master), self.params(), margin_transfer=self.funding()):
                            api.call("POST", "/fapi/v3/subAccountTransfer" if wrong_master else "/fapi/v3/order",
                                self.params(), signed=True, weight=5)
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.unresolved(), [])

    def test_final_transport_path_or_signed_parameter_tampering_is_proven_not_sent(self):
        for change in ("path", "amount", "user"):
            with self.subTest(change=change):
                api = self.transfer_api(self.credentials["master"])
                self.writer.bind_api(api, "master:ASTER_MASTER")
                if change == "path":
                    def mutate(request):
                        request.url = request.url.copy_with(path="/fapi/v3/order")
                    api.http.event_hooks["request"].insert(0, mutate)
                else:
                    sign = api.signed_parameters
                    def tamper(params, change=change, sign=sign):
                        return {**sign(params), **({"amount": "999"} if change == "amount" else {"user": self.credentials["master"]["user"]})}
                    api.signed_parameters = tamper
                with self.writer.accounts(list(self.funding().values())):
                    with self.assertRaises(RequestNotSent):
                        with self.writer.batch("aster:transfer:tamper-" + change, self.params(), margin_transfer=self.funding()):
                            api.call("POST", "/fapi/v3/subAccountTransfer", self.params(), signed=True, weight=5)
        self.assertEqual(self.posts(), [])
        self.assertEqual(self.unresolved(), [])

    def test_final_binding_fence_change_prevents_http(self):
        api = self.transfer_api(self.credentials["master"])
        self.writer.bind_api(api, "master:ASTER_MASTER")
        api.http.event_hooks["request"].insert(0, lambda request:
            self.writer.registry.bind("long", self.writer.connections["long"]["identity"], "rotated"))
        with self.assertRaises(Exception):
            with self.writer.accounts(list(self.funding().values())):
                with self.writer.batch("aster:transfer:fenced", self.params(), margin_transfer=self.funding()):
                    api.call("POST", "/fapi/v3/subAccountTransfer", self.params(), signed=True, weight=5)
        self.assertEqual(self.posts(), [])

    def test_checksum_user_binds_and_sends_the_same_normalized_transfer(self):
        self.credentials["long"]["user"] = to_checksum_address("0x" + "ab" * 20)
        with patch.dict(os.environ, {"ASTER_LONG_USER": self.credentials["long"]["user"]}):
            self.writer.refresh_bindings()
            self.writer.verify_connection("long")
            result = self.balancer.tick(self.pair, self.snapshots())
        self.assertEqual(result["status"], "acknowledged", result)
        self.assertEqual(len(self.posts()), 1)

    def test_one_funding_ticket_has_one_atomic_transport_slot_across_threads(self):
        api = self.transfer_api(self.credentials["master"])
        self.writer.bind_api(api, "master:ASTER_MASTER")
        barrier = threading.Barrier(2)
        api.http.event_hooks["request"].insert(0, lambda request: barrier.wait(timeout=5))
        outcomes = []
        with self.writer.accounts(list(self.funding().values())):
            with self.writer.batch("aster:transfer:concurrent", self.params(), margin_transfer=self.funding()):
                def send():
                    return api.call("POST", "/fapi/v3/subAccountTransfer", self.params(), signed=True, weight=5)
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(self.writer.wrap(send)) for _ in range(2)]
                    for future in futures:
                        try:
                            outcomes.append(future.result())
                        except RequestNotSent:
                            outcomes.append("not-sent")
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(outcomes.count("not-sent"), 1)
        self.assertEqual(self.shared_operations()[0]["state"], "confirmed")
        self.assertEqual(self.unresolved(), [])

    def test_initial_binding_verification_can_use_funds_reserve_without_lending_to_strategy(self):
        budget = RateBudget(margin_reserve=120)
        for broker in self.engine.brokers.values():
            broker.api.budget = budget
        row = self.writer.connections["long"]
        row["identity"] = None
        row.pop("retry_at", None)
        self.writer.registry.bind("long", None, row["revision"], self.writer.scope)
        with budget.reconciliation():
            budget.reserve(1680)
        manager = self.pair_manager()
        def adl(pair):
            self.assertEqual(budget._priority_flags(), (False, False, False, False))
            return {"hold": True, "retry_after": 120}
        self.engine.adl.tick = adl
        manager.tick("gold")
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(budget._priority_flags(), (False, False, False, False))

    def test_initialize_imports_old_inventory_then_scheduler_uses_reserved_funds_quota(self):
        budget = RateBudget(margin_reserve=120)
        for broker in self.engine.brokers.values():
            broker.api.budget = budget
        row = self.writer.connections["long"]
        row["identity"] = None
        row.pop("retry_at", None)
        self.writer.registry.bind("long", None, row["revision"], self.writer.scope)
        self.writer.ready = False  # Model an actual startup, never force ready.
        intent = {"id": "old-intent", "account_id": "long", "status": "pending", "kind": "pair",
            "symbol": "XAUUSD1", "orders": [Executor.order("XAUUSD1", "LONG", "BUY", 1, "old-startup")], "target": None}
        with self.store.connect() as db:
            db.execute("INSERT INTO intents VALUES (?,?,?,?)", (intent["id"], "long", "pending", json.dumps(intent)))
        with budget.reconciliation():
            budget.reserve(1680)
        self.requests.clear()
        self.writer.initialize()
        self.assertTrue(self.writer.ready, self.writer.error)
        self.assertEqual([(row["operation_id"], row["state"]) for row in self.shared_operations()],
            [("aster:legacy:intent:old-intent", "unknown")])
        old = deepcopy(self.shared_operations())
        manager = self.pair_manager()
        self.engine.adl.tick = lambda pair: None
        manager.tick("gold")
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual([row for row in self.shared_operations() if row["operation_id"].startswith("aster:legacy:")], old)
        self.assertFalse(any("order" in path.lower() for _, _, path in self.requests))
        self.assertEqual(budget._priority_flags(), (False, False, False, False))

    def run_market_down_engine(self, *, ordinary_blocked=False):
        pair = deepcopy(self.pair)
        pair["margin"].update(check_interval_seconds=1, cooldown_seconds=1)
        self.pair = self.store.save_pair(pair)
        previous = self.engine
        with patch("trading.engine.ManagedWriter", return_value=self.writer):
            engine = Engine(self.store, market=previous.market)
        engine.brokers = previous.brokers
        self.writer.engine = self.engine = engine
        engine.ready = False
        clock = {"tick": 100.0, "wall": time.time(), "turn": 0}
        owner = self
        class Event:
            def clear(self):
                pass
            def set(self):
                pass
            def wait(self, timeout):
                clock["turn"] += 1
                if clock["turn"] >= 5:
                    engine.shutdown.set()
                else:
                    clock["tick"] += 6
                    owner.balances.update(long="3000", short="1000")
        class OrdinaryPool(_Pool):
            def submit(self, function, *args, **kwargs):
                return _Future(done=False) if ordinary_blocked else super().submit(function, *args, **kwargs)
        engine.scheduler_event = Event()
        pools = []
        def pool(*args, **kwargs):
            pools.append(kwargs["thread_name_prefix"])
            return _Pool() if kwargs["thread_name_prefix"] == "aster-pair" else OrdinaryPool()
        with patch("trading.engine.ThreadPoolExecutor", side_effect=pool), \
                patch("time.monotonic", side_effect=lambda: clock["tick"]), \
                patch("time.time", side_effect=lambda: clock["wall"] + clock["tick"] - 100), \
                patch.object(engine.market, "load_rules", side_effect=TradingError("market unavailable")) as rules, \
                patch.object(engine.market, "book", side_effect=AssertionError("no market prerequisite")), \
                patch.object(engine, "notify", return_value=60), \
                patch.object(engine.pairs, "tick", side_effect=AssertionError("strategy blocked while market not ready")):
            engine.run()
        self.assertEqual(len(self.posts()), 3)
        self.assertIn("aster-pair", pools)
        self.assertIn("aster", pools)
        if ordinary_blocked:
            self.assertEqual(rules.call_count, 0)
        else:
            self.assertGreaterEqual(rules.call_count, 2)
        self.assertIsNone(self.state().get("pending"))
        self.assertEqual(self.store.get("pair_runtime:gold")["margin"]["status"], "acknowledged")

    def test_actual_engine_keeps_funds_due_while_public_rules_repeatedly_fail(self):
        self.run_market_down_engine()

    def test_actual_engine_pair_pool_runs_when_ordinary_pool_is_occupied(self):
        self.run_market_down_engine(ordinary_blocked=True)

    def test_quarantine_or_retired_authority_cannot_begin_funds(self):
        with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
            original = json.loads(db.execute("SELECT value FROM aw_meta WHERE key='recovery_state'").fetchone()[0])
        for state in ("quarantine", "retired"):
            with self.subTest(state=state):
                with closing(sqlite3.connect(os.environ["WORKSPACE_WRITER_DB"])) as db:
                    db.execute("UPDATE aw_meta SET value=? WHERE key='recovery_state'", (json.dumps({**original, "state": state}),))
                    db.commit()
                with self.assertRaises(Exception):
                    self.balancer.tick(self.pair, {})
                self.assertEqual(self.posts(), [])

    def test_real_funds_reads_and_post_use_reserved_budget_after_ordinary_exhaustion(self):
        budget = RateBudget(margin_reserve=120)
        for broker in self.engine.brokers.values():
            broker.api.budget = budget
        with budget.reconciliation():
            budget.reserve(1680)
        manager = self.pair_manager()
        self.engine.adl.tick = lambda pair: {"hold": True, "retry_after": 5}
        manager.tick(self.pair["id"])
        self.assertEqual(len(self.posts()), 1)
        self.assertLessEqual(budget.snapshot()["used"], 1800)
        self.assertIsNone(self.state().get("pending"))


del Fixture  # Imported fixture methods above are not an additional test suite.


class MarginBudgetTests(unittest.TestCase):
    def test_reserved_quota_is_isolated_from_other_threads_and_reconciliation(self):
        budget = RateBudget(margin_reserve=120)
        with budget.reconciliation():
            budget.reserve(1680)
        with budget.margin():
            budget.require_available(120)
            flags = budget._priority_flags()
            with ThreadPoolExecutor(max_workers=1) as pool:
                with self.assertRaises(BudgetWait):
                    pool.submit(budget.reserve, 1).result()
                def read():
                    with budget._inherit_priority(flags):
                        budget.reserve(5)
                pool.submit(read).result()
        with budget.reconciliation(), self.assertRaises(BudgetWait):
            budget.reserve(1)
        self.assertEqual(budget.snapshot()["used"], 1685)

    def test_margin_respects_hard_limit_and_server_cooldown(self):
        budget = RateBudget(margin_reserve=120)
        with budget.margin():
            budget.reserve(1800)
            with self.assertRaises(BudgetWait):
                budget.reserve(1)
        budget = RateBudget(margin_reserve=120)
        budget.block(30, reason="HTTP 429")
        with budget.margin(), self.assertRaises(RequestNotSent):
            budget.reserve(5)
        self.assertEqual(budget.snapshot()["used"], 0)

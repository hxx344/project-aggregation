"""Unknown requests stop being queried; only fresh balanced reality retires them."""
from dataclasses import replace
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from tests.helpers import Fixture
from trading.exchange import ExchangeError, LiveBroker, RequestNotSent
from trading.execution import Executor
from trading.models import TradingError, dec
from trading import recovery
from trading import store as store_module
from trading.store import Store

GOLD, TARGET = "XAUUSD1", "SPCXUSD1"


class LiveReadBroker(LiveBroker):
    def __init__(self, paper):
        self.paper = paper
        self.api = SimpleNamespace(credentials={"user": "child", "signer": "signer"},
                                   budget=None, call=Mock(return_value=[]))
        self._snapshot_lock = threading.RLock()
        self.generation = 0

    def snapshot(self, symbols, fresh_modes=False):
        result = self.paper.snapshot(symbols, fresh_modes=fresh_modes)
        result.open_orders = None
        result.account_read_generation = self.generation
        return result

    def require_snapshot_current(self, snapshot):
        snapshot.require_fresh()
        if snapshot.account_read_generation != self.generation:
            raise TradingError("generation changed")

    def query(self, symbol, client_id):
        raise ExchangeError("not found", code=-2013)

    def reconciliation_budget(self):
        from contextlib import nullcontext
        return nullcontext()


class BoundedRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        self.account = self.f.store.account("test")
        self.now = time.time()
        self.clock = patch("time.time", side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.executor = Executor(self.f.store, self.f.broker, self.f.market)

    def intent(self, *, kind="pair", symbol=GOLD, **changes):
        orders = [Executor.order(symbol, side, "BUY" if side == "LONG" else "SELL", "1", "old-" + side)
                  for side in ("LONG", "SHORT")]
        intent = {"id": "old", "account_id": "test", "kind": kind, "symbol": symbol,
                  "status": "pending", "created_at": self.now - 1000, "leverage": 5,
                  "baseline": {"LONG": "0", "SHORT": "0"}, "orders": orders,
                  "receipts": {}, "repairs": [], "repair_attempts": 0, **changes}
        self.f.store.save_intent(intent)
        return intent

    def reconcile(self, executor=None):
        return (executor or self.executor).reconcile(self.f.store.account("test"))

    def exhaust(self, executor=None):
        executor = executor or self.executor
        with patch.object(executor.broker, "query", side_effect=ExchangeError("not found", code=-2013)) as query:
            for _ in range(7):
                self.reconcile(executor)
            self.assertEqual(query.call_count, 6)
        return self.f.store.intent("test")

    def persisted(self):
        with self.f.store.connect() as db:
            import json
            return json.loads(db.execute("SELECT data FROM intents WHERE id='old'").fetchone()[0])

    def safe_exit(self, executor=None):
        executor = executor or self.executor
        self.now += 121
        with patch.object(executor.broker, "query", side_effect=AssertionError("old query")), \
                patch.object(executor.broker, "submit", side_effect=AssertionError("submit")), \
                patch.object(executor.broker, "set_leverage", side_effect=AssertionError("leverage")):
            return self.reconcile(executor)

    @staticmethod
    def fill_receipts(intent, *, price="4412", quantity="1", status="FILLED"):
        for order in intent["orders"]:
            cid = order["newClientOrderId"]
            intent["receipts"][cid] = {**order, "clientOrderId": cid, "status": status,
                                        "executedQty": quantity, "avgPrice": price}

    def test_known_receipts_with_changed_balanced_positions_retire_without_inventing_results(self):
        intent = self.intent()
        self.fill_receipts(intent)
        self.f.store.save_intent(intent)
        for side in ("LONG", "SHORT"):
            self.f.broker.state["positions"][GOLD + ":" + side].update(qty="2", entry="4412")
        self.f.broker.save()
        with patch.object(self.f.broker, "query", side_effect=AssertionError("known receipts")), \
                patch.object(self.f.broker, "submit", side_effect=AssertionError("external holdings")):
            for _ in range(5):
                self.reconcile()
        self.assertEqual(self.f.store.intent("test")["bounded_recovery"]["checks"]["current_state"], 3)
        self.safe_exit()
        saved = self.persisted()
        self.assertEqual(saved["resolution"]["kind"], "current_state_adopted")
        self.assertFalse(saved["resolution"]["execution_result_unknown"])
        self.assertEqual(saved["receipts"], intent["receipts"])
        batches = self.f.store.get("campaign:test")["batches"]
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["quantities"], {"long_qty": "1", "short_qty": "1", "notional": "8824"})

    def test_invalid_terminal_receipts_never_authorize_current_state_adoption(self):
        intent = self.intent()
        self.fill_receipts(intent)
        intent["receipts"]["old-LONG"]["symbol"] = TARGET
        self.f.store.save_intent(intent)
        for _ in range(4):
            self.reconcile()
            self.now += 121
        pending = self.f.store.intent("test")
        self.assertFalse(pending["bounded_recovery"].get("current_state", False))
        self.assertNotIn("resolution", pending)

    def test_real_account_worker_continues_after_safe_unknown_retirement(self):
        from trading.engine import Engine
        self.intent()
        self.exhaust()
        self.now += 121
        engine = Engine(self.f.store, demo=True, market=self.f.market)
        engine.brokers["test"] = self.f.broker
        engine.poll_market(GOLD)
        with patch.object(self.f.broker, "query", side_effect=AssertionError("retired old request")):
            engine.tick_account("test")
            self.assertIsNone(self.f.store.intent("test"))
            self.assertTrue(self.f.store.account("test")["enabled"])
            with patch.object(self.f.broker, "submit", wraps=self.f.broker.submit) as submit:
                for _ in range(4):
                    engine.tick_account("test")
                    if submit.called:
                        break
            self.assertGreater(submit.call_count, 0, engine.state())
            self.assertTrue(all(order["newClientOrderId"] not in {"old-LONG", "old-SHORT"}
                                for call in submit.call_args_list for order in call.args[0]))

    def test_unknown_sibling_cannot_bypass_an_invalid_saved_terminal_receipt(self):
        self.intent()
        intent = self.exhaust()
        self.fill_receipts(intent)
        intent["receipts"].pop("old-SHORT")
        intent["receipts"]["old-LONG"]["symbol"] = TARGET
        self.f.store.save_intent(intent)
        self.now += 121
        with patch.object(self.f.broker, "query", side_effect=AssertionError("old query")):
            with self.assertRaisesRegex(TradingError, "不匹配"):
                self.reconcile()
        self.assertIsNotNone(self.f.store.intent("test"))

    def test_legacy_window_starts_on_first_read_and_three_checks_survive_restart(self):
        self.intent()
        self.exhaust()
        state = self.f.store.intent("test")
        self.assertEqual(state["bounded_recovery"]["first_observed_at"], self.now)
        self.assertFalse(self.f.store.account("test")["enabled"])
        reopened = Store(self.f.store.path)
        restarted = Executor(reopened, self.f.broker, self.f.market)
        self.safe_exit(restarted)
        self.assertIsNone(reopened.intent("test"))
        saved = self.persisted()
        self.assertEqual(saved["status"], "aborted")
        self.assertEqual(saved["receipts"], {})
        self.assertEqual(saved["resolution"]["kind"], "unknown_current_state")
        self.assertTrue(reopened.account("test")["enabled"])
        self.assertTrue(reopened.get("intent_recovery:test:old")["resumed"])

    def test_local_admission_denial_does_not_consume_queries(self):
        self.intent()
        with patch.object(self.f.broker, "query", side_effect=RequestNotSent("local cooldown")):
            for _ in range(5):
                self.reconcile()
        self.now += 200
        self.assertEqual(self.f.store.intent("test")["bounded_recovery"]["checks"], {})
        with patch.object(self.f.broker, "query", side_effect=ExchangeError("network timeout", retry_after=2)):
            self.reconcile()
        self.assertEqual(set(self.f.store.intent("test")["bounded_recovery"]["checks"].values()), {1})

    def test_repair_refreshes_wait_and_has_its_own_query_limit(self):
        self.intent()
        intent = self.exhaust()
        self.now += 200
        repair = Executor.order(GOLD, "LONG", "SELL", "1", "new-repair")
        intent["repairs"].append(repair)
        with patch.object(self.f.broker, "submit", side_effect=ExchangeError("ambiguous")):
            self.executor.send(intent, [repair], repair=True)
        with patch.object(self.f.broker, "query", side_effect=ExchangeError("not found", code=-2013)) as query:
            for _ in range(5):
                self.reconcile()
            self.assertEqual(query.call_count, 3)
            self.assertTrue(all(call.args[1] == "new-repair" for call in query.call_args_list))
        self.assertIsNotNone(self.f.store.intent("test"))
        self.safe_exit()
        self.assertIsNone(self.f.store.intent("test"))

    def test_user_pause_same_values_atomically_revokes_auto_resume(self):
        self.intent()
        self.exhaust()
        account = self.f.store.account("test")
        self.f.store.save_account(account, user_control=True)
        self.safe_exit()
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.assertFalse(self.f.store.get("intent_recovery:test:old")["resumed"])

    def test_all_normal_completion_paths_release_only_their_own_automatic_pause(self):
        for method in ("complete_pair", "abort_pair", "complete_leverage"):
            for manual in (False, True):
                with self.subTest(method=method, manual=manual):
                    account = self.f.store.account("test")
                    account.update(enabled=True)
                    account.pop("pause_reason", None)
                    self.f.store.save_account(account, user_control=True)
                    kind = "leverage" if method == "complete_leverage" else "pair"
                    intent = self.intent(id=f"{method}-{manual}", kind=kind, run_id="run", target_symbol=TARGET, target_leverage=5)
                    self.executor.attention(account, intent, "old request uncertain")
                    if manual:
                        self.f.store.save_account(self.f.store.account("test"), user_control=True)
                    if method == "complete_pair":
                        self.f.store.complete_pair(intent, {"long_qty": "1", "short_qty": "1", "notional": "8824"})
                    elif method == "abort_pair":
                        self.f.store.abort_pair(intent)
                    else:
                        self.f.store.complete_leverage(intent, 10)
                    self.assertEqual(self.f.store.account("test")["enabled"], not manual)
                    self.assertIsNone(self.f.store.get("recovery_auto_pause:test"))
                    self.assertIsNone(self.f.store.intent("test"))

    def test_late_valid_receipts_normally_complete_and_resume_the_account(self):
        intent = self.intent()
        with patch.object(self.f.broker, "query", side_effect=ExchangeError("unknown", code=-2013)):
            self.reconcile()
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.fill_receipts(intent)
        for side in ("LONG", "SHORT"):
            self.f.broker.state["positions"][GOLD + ":" + side].update(qty="1", entry="4412")
        self.f.broker.save()
        with patch.object(self.f.broker, "query", side_effect=lambda symbol, cid: intent["receipts"][cid]):
            self.reconcile()
        self.assertIsNone(self.f.store.intent("test"))
        self.assertTrue(self.f.store.account("test")["enabled"])
        self.assertEqual(self.persisted()["status"], "complete")
        self.assertNotIn("resolution", self.persisted())

    def test_normal_completion_and_auto_resume_roll_back_together(self):
        intent = self.intent()
        self.executor.attention(self.f.store.account("test"), intent, "waiting")
        original = self.f.store._resume_intent_pause
        def fail(db, row):
            self.assertTrue(original(db, row))
            raise TradingError("injected resume failure")
        with self.f.store.connection_scope(), patch.object(self.f.store, "_resume_intent_pause", side_effect=fail):
            with self.assertRaisesRegex(TradingError, "injected"):
                self.f.store.abort_pair(intent)
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.assertIsNotNone(self.f.store.intent("test"))
        self.assertIsNotNone(self.f.store.get("recovery_auto_pause:test"))

    def test_preexisting_pause_without_source_is_never_resumed(self):
        account = self.f.store.account("test")
        account["enabled"] = False
        self.f.store.save_account(account)
        self.intent()
        self.exhaust()
        self.safe_exit()
        self.assertFalse(self.f.store.account("test")["enabled"])

    def test_other_risk_pause_revokes_resume_marker(self):
        self.intent()
        self.exhaust()
        self.f.store.pause_account(self.f.store.account("test"), "separate risk")
        self.assertIsNone(self.f.store.get("recovery_auto_pause:test"))
        self.safe_exit()
        self.assertFalse(self.f.store.account("test")["enabled"])

    def test_unsafe_reality_keeps_old_record_without_more_queries(self):
        self.intent()
        self.exhaust()
        self.now += 121
        original = self.f.broker.snapshot
        bad = [lambda s: replace(s, open_orders=None), lambda s: replace(s, open_orders=[{"id": "active"}]),
               lambda s: replace(s, timestamp=self.now - 1), lambda s: replace(s, equity=dec(0)),
               lambda s: replace(s, can_trade=False)]
        for change in bad:
            with self.subTest(change=change), patch.object(self.f.broker, "snapshot", side_effect=lambda *a, **k: change(original(*a, **k))), \
                    patch.object(self.f.broker, "query", side_effect=AssertionError("old query")):
                with self.assertRaises(TradingError):
                    self.reconcile()
            self.assertIsNotNone(self.f.store.intent("test"))
        self.f.broker.state["positions"][GOLD + ":LONG"].update(qty="1", entry="4412")
        self.f.broker.save()
        with self.assertRaisesRegex(TradingError, "不平衡"):
            self.reconcile()
        self.f.broker.state["positions"][GOLD + ":LONG"].update(qty="0")
        self.f.broker.state["positions"][TARGET + ":LONG"].update(qty="1", entry="724")
        self.f.broker.save()
        with self.assertRaisesRegex(TradingError, "其他标的"):
            self.reconcile()

    def test_actual_balanced_positions_are_adopted_without_guessing_fills(self):
        self.intent()
        self.exhaust()
        for side in ("LONG", "SHORT"):
            self.f.broker.state["positions"][GOLD + ":" + side].update(qty="2", entry="4412")
        self.f.broker.save()
        self.safe_exit()
        self.assertEqual(self.persisted()["resolution"]["actual"][GOLD]["LONG"], "2")
        self.assertIsNone(self.f.store.get("campaign:test"))
        self.assertEqual(self.persisted()["receipts"], {})

    def test_unsupported_ordinary_leverage_and_excess_margin_stay_blocked(self):
        self.intent()
        self.exhaust()
        self.now += 121
        self.f.broker.state["leverages"][GOLD] = 7
        self.f.broker.save()
        with self.assertRaisesRegex(TradingError, "5x、10x、20x"):
            self.reconcile()
        self.f.broker.state["leverages"][GOLD] = 5
        self.f.broker.save()
        original = self.f.broker.snapshot
        with patch.object(self.f.broker, "snapshot", side_effect=lambda *a, **k: replace(original(*a, **k), equity=dec(".01"),
                positions=[replace(p, qty=dec("1"), entry=dec("4412"), mark=dec("4412")) if p.symbol == GOLD else p
                           for p in original(*a, **k).positions])):
            with self.assertRaisesRegex(TradingError, "保证金占用"):
                self.reconcile()
        self.assertIsNotNone(self.f.store.intent("test"))
        self.assertFalse(self.f.store.account("test")["enabled"])

    def test_live_full_orders_required_even_when_snapshot_omits_orders(self):
        live = LiveReadBroker(self.f.broker)
        executor = Executor(self.f.store, live, self.f.market)
        self.intent()
        self.exhaust(executor)
        self.now += 121
        for orders in (None, [{"orderId": 1}]):
            live.api.call.return_value = orders
            with self.assertRaises(TradingError):
                self.reconcile(executor)
        live.api.call.return_value = []
        self.reconcile(executor)
        live.api.call.assert_called_with("GET", "/fapi/v3/openOrders", signed=True, weight=40)
        self.assertIsNone(self.f.store.intent("test"))

    def test_identity_generation_and_account_cas_reject_change_during_read(self):
        live = LiveReadBroker(self.f.broker)
        executor = Executor(self.f.store, live, self.f.market)
        self.intent()
        self.exhaust(executor)
        self.now += 121
        for mutate in (lambda: live.api.credentials.update(user="other"),
                       lambda: setattr(live, "generation", live.generation + 1),
                       lambda: self.f.store.save_account({**self.f.store.account("test"), "name": "edited"}, user_control=True)):
            def orders(*args, **kwargs):
                mutate()
                return []
            live.api.call.side_effect = orders
            with self.assertRaises(TradingError):
                self.reconcile(executor)
            self.assertIsNotNone(self.f.store.intent("test"))
            live.api.credentials["user"] = "child"

    def test_leverage_below_target_archives_actual_and_cools_same_request(self):
        live = LiveReadBroker(self.f.broker)
        executor = Executor(self.f.store, live, self.f.market)
        self.intent(kind="leverage", previous=5, target=10)
        with patch.object(live, "snapshot", wraps=live.snapshot) as read:
            for _ in range(5):
                self.reconcile(executor)
            self.assertEqual(read.call_count, 3)
        self.now += 121
        self.reconcile(executor)
        self.assertIsNone(self.f.store.intent("test"))
        account = self.f.store.account("test")
        self.assertTrue(recovery.leverage_cooldown_active(self.f.store, account, live, GOLD, 10))
        self.assertFalse(recovery.leverage_cooldown_active(self.f.store, account, live, GOLD, 20))
        self.now += 301
        self.assertFalse(recovery.leverage_cooldown_active(self.f.store, account, live, GOLD, 10))

    def test_legacy_downgrade_is_observed_then_retired_without_writing(self):
        live = LiveReadBroker(self.f.broker)
        executor = Executor(self.f.store, live, self.f.market)
        self.intent(kind="leverage", previous=10, target=5)
        for _ in range(3):
            self.reconcile(executor)
        self.assertEqual(self.f.store.intent("test")["bounded_recovery"]["checks"]["leverage"], 3)
        self.now += 121
        with patch.object(live, "set_leverage", side_effect=AssertionError("downgrade")):
            self.reconcile(executor)
        self.assertIsNone(self.f.store.intent("test"))

    def test_leverage_counts_network_reads_but_not_local_admission_denials(self):
        self.intent(kind="leverage", previous=5, target=10)
        with patch.object(self.f.broker, "snapshot", side_effect=RequestNotSent("local budget")):
            for _ in range(4):
                with self.assertRaises(RequestNotSent):
                    self.reconcile()
        self.assertEqual(self.f.store.intent("test")["bounded_recovery"]["checks"], {})
        with patch.object(self.f.broker, "snapshot", side_effect=ExchangeError("network timeout")) as read:
            for _ in range(3):
                with self.assertRaises(ExchangeError):
                    self.reconcile()
            self.reconcile()
            self.assertEqual(read.call_count, 3)
        self.now += 121
        self.reconcile()
        self.assertIsNone(self.f.store.intent("test"))

    def test_archive_cas_and_failure_roll_back_with_shared_connection(self):
        self.intent()
        self.exhaust()
        self.now += 121
        original = store_module.dumps
        def fail(value):
            if isinstance(value, dict) and value.get("resolution"):
                raise TradingError("injected commit failure")
            return original(value)
        with self.f.store.connection_scope(), patch.object(store_module, "dumps", side_effect=fail):
            with self.assertRaisesRegex(TradingError, "injected"):
                self.reconcile()
        self.assertIsNotNone(self.f.store.intent("test"))
        self.assertFalse(self.f.store.account("test")["enabled"])
        self.assertIsNone(self.f.store.get("intent_recovery:test:old"))


if __name__ == "__main__":
    unittest.main()

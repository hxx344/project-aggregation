"""Final-send freshness of single-account market orders; mock transport only.

The real shared SQLite writer, ManagedWriter, LiveBroker and API are used.
Only the final network is an httpx.MockTransport, and account reads come from
a paper ledger fixture stamped with the live broker's read generation.
"""
import json
import sqlite3
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qsl

import httpx

from tests import test_account_writer as writer_tests
from tests.helpers import seed_market_capacity
from trading.exchange import API, ExchangeError, LiveBroker, RateBudget
from trading.execution import MAX_REPAIR_BASIS_EXPIRED
from trading.paper import PaperBroker

SYMBOL = "XAUUSD1"


class OpenFinalFreshnessTests(unittest.TestCase):
    # Reuse the shared-writer fixture without collecting its tests here.
    _writer_setup = writer_tests.AccountWriterTests.setUp
    receipt = writer_tests.AccountWriterTests.receipt

    def setUp(self):
        self._writer_setup()
        self.offset = 0.0
        real = time.time
        clock = patch("time.time", lambda: real() + self.offset)
        clock.start()
        self.addCleanup(clock.stop)
        seed_market_capacity(self.engine)
        self.paper = PaperBroker("long-ledger", self.engine.market, self.store)
        self.paper.set_leverage(SYMBOL, 20)  # Already at the top tier: the tick goes straight to the open.
        self.sent = []
        self.short_rejected = False
        api = API(self.credentials["long"], transport=httpx.MockTransport(self.respond), budget=RateBudget())
        api.signed_parameters = lambda params: params
        self.addCleanup(api.close)
        self.broker = LiveBroker(self.credentials["long"], self.engine.market, api=api)
        self.engine.brokers["long"] = self.broker
        snapshot = patch.object(self.broker, "snapshot", side_effect=self.snapshot)
        snapshot.start()
        self.addCleanup(snapshot.stop)

    def snapshot(self, symbols, fresh_modes=False, **_):
        with self.broker._snapshot_lock:
            generation = self.broker._snapshot_generation
        snapshot = self.paper.snapshot(symbols)
        snapshot.account_read_generation = generation
        return snapshot

    def respond(self, request):
        if request.method == "GET":
            return httpx.Response(200, json={"assets": [], "positions": []})
        params = dict(parse_qsl(request.content.decode()))
        orders = json.loads(params["batchOrders"]) if request.url.path == "/fapi/v3/batchOrders" else [params]
        self.sent.append((request.url.path, [order["newClientOrderId"] for order in orders]))
        rows = []
        for order in orders:
            if self.short_rejected and order["positionSide"] == "SHORT":
                rows.append({"code": -5018, "msg": "rejected"})
            else:
                rows.extend({**row, "orderId": "remote-" + row["clientOrderId"]} for row in self.paper.submit([order]))
        return httpx.Response(200, json=rows if request.url.path == "/fapi/v3/batchOrders" else rows[0])

    def advance_once(self, target, condition=lambda *args, **kwargs: True, *, seconds=9.0, action=None):
        done = []
        def run(*args, **kwargs):
            if not done and condition(*args, **kwargs):
                done.append(True)
                if action is None:
                    self.offset += seconds
                else:
                    action()
            return target(*args, **kwargs)
        return run, done

    def last_intent(self):
        with self.store.connect() as db:
            return json.loads(db.execute("SELECT data FROM intents ORDER BY rowid DESC LIMIT 1").fetchone()[0])

    def operation_states(self):
        with sqlite3.connect(self.environment["WORKSPACE_WRITER_DB"]) as db:
            return [row[0] for row in db.execute("SELECT state FROM aw_operations ORDER BY rowid")]

    def assert_not_sent(self, reason):
        self.assertEqual(self.sent, [])
        intent = self.last_intent()
        self.assertEqual(intent["status"], "aborted")
        cids = [order["newClientOrderId"] for order in intent["orders"]]
        # The original client IDs are kept as known-absent, never unknown.
        self.assertEqual(sorted(intent["receipts"]), sorted(cids))
        self.assertTrue(all(row["status"] == "REJECTED" and row["local_not_sent"] and row["executedQty"] == "0"
                            for row in intent["receipts"].values()))
        self.assertEqual(intent["send_basis"]["client_order_ids"], cids)
        self.assertIn(reason, intent["last_error"])
        self.assertIn("本批未发送", intent["last_error"])
        self.assertIsNone(self.store.intent("long"))
        self.assertNotIn("unknown", self.operation_states())
        self.assertNotIn("sending", self.operation_states())
        return intent

    def test_fresh_basis_sends_the_batch_once(self):
        self.engine.tick_account("long")
        self.assertEqual(len(self.sent), 1)
        path, cids = self.sent[0]
        self.assertEqual((path, len(cids)), ("/fapi/v3/batchOrders", 2))
        intent = self.last_intent()
        self.assertEqual(intent["status"], "complete")
        self.assertEqual(intent["send_basis"]["client_order_ids"], cids)
        self.assertIsNotNone(intent["send_basis"]["account_generation"])
        self.assertEqual(self.operation_states(), ["confirmed"])

    def test_intent_persistence_delay_blocks_the_send(self):
        save, _ = self.advance_once(self.store.save_intent)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assert_not_sent("账户快照已过期")
        message = "\n".join(event["message"] for event in self.store.events())
        self.assertIn("本批未发送", message)
        self.assertIn("本地未发送", message)

    def test_event_log_delay_blocks_the_send(self):
        event, done = self.advance_once(self.store.event, lambda aid, kind, message: "提交双向市价批次" in message)
        with patch.object(self.store, "event", side_effect=event):
            self.engine.tick_account("long")
        self.assertTrue(done)
        self.assert_not_sent("账户快照已过期")

    def test_quote_expiry_alone_blocks_the_send(self):
        # 4 seconds: the 8-second account snapshot is still valid, the BBO is not.
        save, _ = self.advance_once(self.store.save_intent, seconds=4.0)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assert_not_sent("BBO 已过期")

    def test_shared_admission_waits_block_the_send(self):
        writer = self.engine.account_writer
        for stage in ("prepare", "before_send"):
            with self.subTest(stage=stage):
                self.sent.clear()
                self.store.put(f"order_cooldown:long:{SYMBOL}", None)
                seed_market_capacity(self.engine)  # The previous pass aged the public cache.
                wait, done = self.advance_once(getattr(writer, stage), lambda prepared_or_api, *args: True)
                with patch.object(writer, stage, side_effect=wait):
                    self.engine.tick_account("long")
                self.assertTrue(done)
                self.assert_not_sent("账户快照已过期")
                self.assertEqual(self.operation_states()[-1], "rejected")

    def test_account_generation_change_blocks_the_send(self):
        writer = self.engine.account_writer
        event = lambda: self.broker._private_account_event("ACCOUNT_UPDATE")
        cases = (("persist", self.store, "save_intent", "已被账户事件或写入撤销"),
                 ("admission", writer, "before_send", "发送前账户发生变化"))
        for stage, owner, name, reason in cases:
            with self.subTest(stage=stage):
                self.sent.clear()
                self.store.put(f"order_cooldown:long:{SYMBOL}", None)
                change, done = self.advance_once(getattr(owner, name), action=event)
                with patch.object(owner, name, side_effect=change):
                    self.engine.tick_account("long")
                self.assertTrue(done)
                self.assert_not_sent(reason)

    def test_shutdown_or_maintenance_during_persistence_blocks_the_send(self):
        def maintenance():
            self.engine.workspace.active = True
        for stage, action in (("maintenance", maintenance), ("shutdown", self.engine.shutdown.set)):
            with self.subTest(stage=stage):
                self.sent.clear()
                self.store.put(f"order_cooldown:long:{SYMBOL}", None)
                save, done = self.advance_once(self.store.save_intent, action=action)
                with patch.object(self.store, "save_intent", side_effect=save):
                    self.engine.tick_account("long")
                self.assertTrue(done)
                self.assertEqual(self.sent, [])
                intent = self.last_intent()
                self.assertTrue(all(row["local_not_sent"] for row in intent["receipts"].values()))
                self.assertNotIn("unknown", self.operation_states())
                self.engine.workspace.active = False
                self.engine.shutdown.clear()

    def test_single_leg_repair_rechecks_its_own_basis(self):
        self.short_rejected = True
        repairing = lambda intent: intent.get("status") == "repair"
        save, done = self.advance_once(self.store.save_intent, repairing)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assertTrue(done)
        # Only the original batch reached the network; the repair did not.
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders"])
        intent = self.store.intent("long")
        self.assertEqual(intent["status"], "repair")
        repair = intent["repairs"][0]["newClientOrderId"]
        self.assertTrue(intent["receipts"][repair]["local_not_sent"])
        self.assertEqual(intent["repair_attempts"], 0)
        self.assertEqual(intent["send_basis"]["client_order_ids"], [repair])
        self.assertIn("账户快照已过期", intent["last_error"])
        self.assertNotIn("unknown", self.operation_states())

        # A later pass plans from fresh evidence and sends a new repair once.
        self.offset += 1
        with self.engine.lock:
            self.engine.work("long").backoff = 0
        self.engine.tick_account("long")
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders", "/fapi/v3/order"])
        self.assertNotEqual(self.sent[1][1], [repair])

    def test_stale_quote_does_not_hold_back_a_repair(self):
        self.short_rejected = True
        # Past the 3-second BBO limit, inside the 8-second account limit.
        save, done = self.advance_once(self.store.save_intent, lambda intent: intent.get("status") == "repair", seconds=4.0)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assertTrue(done)
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders", "/fapi/v3/order"])

    def test_expired_repair_retries_soon_and_pauses_after_the_limit(self):
        self.short_rejected = True
        delays = self.expire_repairs(MAX_REPAIR_BASIS_EXPIRED + 3)
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders"])
        intent = self.store.intent("long")
        self.assertEqual(intent["status"], "attention")
        self.assertEqual(intent["repair_basis_expired"], MAX_REPAIR_BASIS_EXPIRED)
        self.assertEqual(len(intent["repairs"]), MAX_REPAIR_BASIS_EXPIRED, "暂停后不再新增补单")
        self.assertEqual(intent["repair_attempts"], 0)
        self.assertEqual(delays[0], 1, "依据失效的补单约 1 秒后重试，不等 10 秒")
        self.assertIn("均未发出", intent["last_error"])

        # An operator retry starts a new count and the repair goes out.
        self.engine.retry("long")
        self.engine.work("long").backoff = 0
        self.offset += 1
        self.engine.tick_account("long")
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders", "/fapi/v3/order"])
        self.assertNotIn("repair_basis_expired", self.last_intent())

    def expire_repairs(self, passes):
        """Run passes in which every planned repair loses its 8-second account basis."""
        delays = []
        def expire(intent, save=self.store.save_intent):
            pending = [o["newClientOrderId"] for o in intent.get("repairs", []) if o["newClientOrderId"] not in intent["receipts"]]
            if pending and intent.get("send_basis", {}).get("client_order_ids") == pending:
                self.offset += 9.0
            return save(intent)
        with patch.object(self.store, "save_intent", side_effect=expire):
            for _ in range(passes):
                delays.append(self.engine.tick_account("long"))
                self.engine.work("long").backoff = 0
                self.offset += 1
        return delays

    def test_a_sent_repair_restarts_the_count(self):
        self.short_rejected = True
        self.expire_repairs(2)
        self.assertEqual(self.store.intent("long")["repair_basis_expired"], 2)
        self.engine.tick_account("long")
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders", "/fapi/v3/order"])
        self.assertNotIn("repair_basis_expired", self.last_intent())

    def test_a_repair_rejected_by_the_exchange_restarts_the_count(self):
        self.short_rejected = True
        self.expire_repairs(2)
        with patch.object(self.broker, "submit", side_effect=ExchangeError("rejected", -2022)):
            self.engine.tick_account("long")
        self.assertNotIn("repair_basis_expired", self.store.intent("long"))

    def test_account_event_holds_back_a_repair_without_refunding_twice(self):
        self.short_rejected = True
        event = lambda: self.broker._private_account_event("ACCOUNT_UPDATE")
        save, done = self.advance_once(self.store.save_intent, lambda intent: intent.get("status") == "repair", action=event)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assertTrue(done)
        self.assertEqual([path for path, _ in self.sent], ["/fapi/v3/batchOrders"])
        intent = self.store.intent("long")
        self.assertEqual((intent["repair_attempts"], intent["repair_basis_expired"]), (0, 1))

    def test_basis_expiry_does_not_grow_the_open_backoff(self):
        key = f"order_cooldown:long:{SYMBOL}"
        self.store.put(key, {"failures": 2, "until": 0})
        save, _ = self.advance_once(self.store.save_intent)
        with patch.object(self.store, "save_intent", side_effect=save):
            self.engine.tick_account("long")
        self.assert_not_sent("账户快照已过期")
        cooldown = self.store.get(key)
        self.assertEqual(cooldown["failures"], 2)
        self.assertGreater(cooldown["until"], time.time())
        self.assertLessEqual(cooldown["until"] - time.time(), 10)

    def test_live_basis_without_a_read_generation_blocks_the_send(self):
        def unstamped(symbols, fresh_modes=False, **_):
            return self.paper.snapshot(symbols)
        with patch.object(self.broker, "snapshot", side_effect=unstamped):
            self.engine.tick_account("long")
        self.assert_not_sent("缺少账户读取代次")


if __name__ == "__main__":
    unittest.main()

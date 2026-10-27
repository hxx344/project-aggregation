"""Managed account tests use a temporary shared database and mock HTTP only."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from datetime import datetime, timezone

import httpx

from app.account_writer import _digest
from app.config import Settings
from app.engine import TradingEngine
from app.models import TradePlanRequest, TradeTaskRequest
from app.orders import OrderExecutor
from app.strategy import demo_chain


CORE = Path(__file__).resolve().parents[3] / "server" / "execution" / "account_writer.py"


class AccountWriterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.environment = patch.dict(os.environ, {"WORKSPACE_MANAGED": "1", "WORKSPACE_WRITER_MODULE": str(CORE),
            "WORKSPACE_WRITER_DB": str(Path(self.directory.name) / "writer.sqlite"), "WORKSPACE_RUNTIME_ID": "greeks-test",
            "WORKSPACE_MAINTENANCE": "0"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.requests = []
        self.uid = 123
        self.after_send = lambda: None
        self.fail_write = False

    async def engine(self, **settings):
        engine = TradingEngine(Settings(_env_file=None, state_file=str(Path(self.directory.name) / "state.json"),
            bybit_api_key="public-fixture-key", bybit_api_secret="fixture-secret", trading_mode="testnet", **settings))
        def respond(request):
            self.requests.append(request)
            if request.url.path == "/v5/user/query-api":
                result = {"userID": self.uid, "isMaster": False, "parentUid": "111", "readOnly": 0}
            elif request.method == "GET":
                result = {}
            else:
                self.after_send()
                if self.fail_write:
                    raise httpx.ReadTimeout("injected response loss", request=request)
                result = {"orderId": "remote-order", "orderLinkId": "original-link"}
            return httpx.Response(200, json={"retCode": 0, "result": result})
        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        self.addAsyncCleanup(engine.client.close)
        self.addCleanup(engine.account_writer.close)
        await engine.account_writer.initialize()
        return engine

    def other_writer(self, identity):
        spec = importlib.util.spec_from_file_location("test_account_core", CORE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        writer = module.AccountWriter(os.environ["WORKSPACE_WRITER_DB"], "native", "native-test")
        self.addCleanup(writer.close)
        writer.bind("bybit", identity, "credential-one")
        return writer

    def register_order(self, engine, link="original-link", symbol="BTC-OPTION"):
        engine.order_journal[link] = {"symbol": symbol, "side": "Buy", "qty": 1.0,
            "reduce_only": False, "status": "unknown", "terminal": False, "filledQty": 0.0}
        engine._save_state()

    async def test_exchange_uid_and_private_environment_are_used(self):
        engine = await self.engine()
        self.assertEqual(engine.account_writer.identity,
            {"authority": "bybit", "environment": "testnet", "accountId": "123", "parentAccountId": "111"})
        await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link")
        self.assertEqual([request.method for request in self.requests], ["GET", "POST"])

    async def test_unknown_uid_keeps_reads_available_and_every_write_closed(self):
        self.uid = None
        engine = await self.engine()
        self.assertFalse(engine.account_writer.ready)
        await engine.client.account_info()
        for action in (
                lambda: engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link"),
                lambda: engine.client.amend_order("BTC-OPTION", "original-link", 3),
                lambda: engine.client.cancel_order("BTC-OPTION", "original-link"),
                lambda: engine.client.create_rfq([], [], "rfq-link"),
                lambda: engine.client.execute_quote("rfq-id", "quote-id", "Sell"),
                lambda: engine.client.cancel_rfq("rfq-id")):
            with self.assertRaises(Exception):
                await action()
        self.assertTrue(all(request.method == "GET" for request in self.requests))

    async def test_cross_module_same_uid_conflict_has_no_transport(self):
        engine = await self.engine()
        other = self.other_writer(engine.account_writer.identity)
        other.claim([engine.account_writer.identity])
        with self.assertRaises(Exception):
            await engine.client.cancel_order("BTC-OPTION", "original-link")
        self.assertEqual(len(self.requests), 1)

    async def test_timeout_is_durable_and_restart_preserves_original_operation(self):
        engine = await self.engine()
        self.fail_write = True
        with self.assertRaises(httpx.ReadTimeout):
            await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link")
        self.fail_write = False
        with self.assertRaises(Exception):
            await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "replacement-link")
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 1)
        engine.account_writer.close()
        restarted = await self.engine()
        with self.assertRaises(Exception):
            await restarted.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link")
        self.assertEqual(sum(request.method == "POST" for request in self.requests), 1)

    async def test_late_response_and_state_save_are_rejected_after_binding_changes(self):
        engine = await self.engine()
        engine._save_state()
        before = Path(engine.settings.state_file).read_bytes()
        self.after_send = lambda: engine.account_writer.registry.bind("bybit", engine.account_writer.identity, "rotated")
        with self.assertRaises(Exception):
            await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link")
        with self.assertRaises(Exception):
            engine._save_state()
        self.assertEqual(Path(engine.settings.state_file).read_bytes(), before)

    async def test_legacy_unknown_freezes_an_already_claimed_other_module(self):
        engine = await self.engine()
        identity = dict(engine.account_writer.identity)
        engine.order_journal["legacy-link"] = {"symbol": "BTC-OPTION", "side": "Buy", "qty": 1.0,
            "reduce_only": False, "status": "unknown", "terminal": False, "filledQty": 0.0}
        engine._save_state()
        engine.account_writer.close()
        other = self.other_writer(identity)
        ticket = other.claim([identity])
        restarted = await self.engine()
        self.assertFalse(restarted.account_writer.ready)
        with self.assertRaises(Exception):
            other.assert_owned(ticket)
        self.assertTrue(all(request.method == "GET" for request in self.requests))

    async def test_rotation_keeps_uid_and_ownership_identity(self):
        engine = await self.engine()
        identity = dict(engine.account_writer.identity)
        ticket = engine.account_writer.claim()
        engine.account_writer.close()
        # A fresh client verifies the same remote UID using a new credential revision.
        engine.settings.bybit_api_key = "rotated-fixture-key"
        engine.settings.bybit_api_secret = "rotated-fixture-secret"
        from app.account_writer import ManagedWriter
        writer = ManagedWriter(engine)
        self.addCleanup(writer.close)
        engine.account_writer = writer
        engine.client.account_writer = writer
        engine.client.api_key = engine.settings.bybit_api_key
        engine.client.api_secret = engine.settings.bybit_api_secret
        await writer.initialize()
        rotated = writer.claim()
        self.assertEqual(writer.identity, identity)
        self.assertEqual(rotated["claims"][0]["accountKey"], ticket["claims"][0]["accountKey"])

    async def test_real_four_leg_task_all_children_pass_the_same_persisted_group(self):
        engine = await self.engine(leg_qty=.03)
        engine.settings.bbo_poll_seconds = .001
        engine.settings.bbo_order_timeout_seconds = 2
        engine.settings.failed_leg_position_checks = 1
        engine.chain = demo_chain(datetime.now(timezone.utc))
        engine.chain_source = "bybit"
        engine.chain_updated_at = datetime.now(timezone.utc)
        engine.btc_price = 100000.
        engine.refresh_chain = AsyncMock(return_value=engine.chain)
        engine._validate_open_calendar = Mock()
        engine._capture_pm_baseline = AsyncMock()
        engine.load_recent_executions = AsyncMock(return_value=[])
        await engine.client.close()
        posted, in_flight, maximum = [], 0, 0
        async def respond(request):
            nonlocal in_flight, maximum
            if request.method == "POST":
                body = json.loads(request.content)
                posted.append(body["orderLinkId"])
                in_flight += 1
                maximum = max(maximum, in_flight)
                await asyncio.sleep(.03)
                in_flight -= 1
                result = {"orderId": "remote-" + body["orderLinkId"], "orderLinkId": body["orderLinkId"]}
            elif request.url.path == "/v5/market/tickers":
                item = next(item for item in engine.chain if item.symbol == request.url.params["symbol"])
                result = {"list": [{"bid1Price": str(item.bid), "ask1Price": str(item.ask)}]}
            else:
                link = request.url.params["orderLinkId"]
                entry = engine.order_journal[link]
                result = {"list": [{"symbol": entry["symbol"], "orderLinkId": link, "orderId": "remote-" + link,
                    "side": entry["side"], "qty": str(entry["qty"]), "cumExecQty": str(entry["qty"]), "orderStatus": "Filled"}]}
            return httpx.Response(200, json={"retCode": 0, "result": result})
        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        plan = await engine.prepare_trade_plan(TradePlanRequest(operation="open", quantity=.03))
        accepted = await engine.start_trade_task(TradeTaskRequest(plan_id=plan["plan_id"], request_id="four-original", confirm_live=True))
        await asyncio.wait_for(engine.trade_workers[accepted["execution_id"]], timeout=3)
        self.assertEqual(len(posted), 4)
        self.assertEqual(maximum, 4)
        self.assertTrue(all(entry["terminal"] and entry["status"] == "filled" for entry in engine.order_journal.values()))

    async def test_missing_credentials_keep_unknown_binding_for_legacy_or_bad_state(self):
        for kind in ("order", "rfq", "corrupt"):
            with self.subTest(kind=kind), patch.dict(os.environ, {"WORKSPACE_WRITER_DB": str(Path(self.directory.name) / (kind + ".sqlite"))}):
                path = Path(self.directory.name) / (kind + ".json")
                settings = Settings(_env_file=None, state_file=str(path), trading_mode="testnet")
                old = TradingEngine(settings)
                if kind == "order":
                    old.order_journal["old-original"] = {"symbol": "BTC-OPTION", "side": "Buy", "qty": 1.0,
                        "reduce_only": False, "status": "unknown", "terminal": False, "filledQty": 0.0}
                elif kind == "rfq":
                    old.rfq_state = {"rfq_link_id": "old-rfq", "status": "CreationUnknown"}
                old._save_state()
                old.account_writer.close()
                if kind == "corrupt":
                    path.write_text("{unreadable", encoding="utf-8")
                restarted = TradingEngine(settings)
                self.addCleanup(restarted.account_writer.close)
                await restarted.account_writer.initialize()
                self.assertFalse(restarted.account_writer.ready)
                other = self.other_writer({"authority": "bybit", "environment": "testnet", "accountId": "123"})
                with self.assertRaises(Exception) as caught:
                    other.claim([{"authority": "bybit", "environment": "testnet", "accountId": "123"}])
                self.assertEqual(caught.exception.code, "UNVERIFIED_BINDING")

    async def test_bbo_price_round_trip_uses_distinct_persisted_amendments(self):
        engine = await self.engine()
        engine.settings.bbo_poll_seconds = .001
        engine.settings.bbo_order_timeout_seconds = 3
        engine.chain = demo_chain(datetime.now(timezone.utc))
        symbol = engine.chain[0].symbol
        await engine.client.close()
        prices = iter((1, 2, 3, 2))
        posted = []

        def respond(request):
            if request.method == "POST":
                body = json.loads(request.content)
                posted.append((request.url.path, body))
                if request.url.path.endswith("/amend"):
                    saved = json.loads(Path(engine.settings.state_file).read_text())
                    count = sum(path.endswith("/amend") for path, _ in posted)
                    self.assertEqual(saved["order_journal"]["original-link"]["amendment_sequence"], count)
                result = {"orderId": "remote-original", "orderLinkId": "original-link"}
            elif request.url.path == "/v5/market/tickers":
                result = {"list": [{"bid1Price": str(next(prices))}]}
            else:
                filled = sum(path.endswith("/amend") for path, _ in posted) == 3
                result = {"list": [{"symbol": symbol, "orderLinkId": "original-link", "orderId": "remote-original",
                    "side": "Buy", "qty": "1", "cumExecQty": "1" if filled else "0", "orderStatus": "Filled" if filled else "New"}]}
            return httpx.Response(200, json={"retCode": 0, "result": result})

        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        registry = engine.account_writer.registry
        with patch.object(registry, "prepare", wraps=registry.prepare) as prepare:
            outcome = await engine.follow_bbo_order(SimpleNamespace(symbol=symbol, side="Buy"), 1, "original-link")
        self.assertEqual(outcome["status"], "filled")
        self.assertEqual([body["price"] for path, body in posted if path.endswith("/amend")], ["2.0", "3.0", "2.0"])
        self.assertFalse(any(path.endswith("/cancel") for path, _ in posted))
        self.assertEqual([call.args[1] for call in prepare.call_args_list], ["greeks:create:original-link",
            "greeks:amend:original-link:1", "greeks:amend:original-link:2", "greeks:amend:original-link:3"])

    async def test_amendment_sequence_continues_after_restart_and_original_observation(self):
        engine = await self.engine()
        self.register_order(engine)
        await engine.client.amend_order("BTC-OPTION", "original-link", 2)
        engine.account_writer.close()
        restarted = await self.engine()
        self.assertEqual(restarted.order_journal["original-link"]["amendment_sequence"], 1)
        await restarted.client.close()

        def respond(request):
            if request.method == "GET":
                result = {"list": [{"symbol": "BTC-OPTION", "orderLinkId": "original-link", "orderId": "remote-original",
                    "side": "Buy", "qty": "1", "cumExecQty": "0", "orderStatus": "New"}]}
            else:
                result = {"orderId": "remote-original", "orderLinkId": "original-link"}
            return httpx.Response(200, json={"retCode": 0, "result": result})

        restarted.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        await restarted.client.order("BTC-OPTION", "original-link")
        registry = restarted.account_writer.registry
        with patch.object(registry, "prepare", wraps=registry.prepare) as prepare:
            await restarted.client.amend_order("BTC-OPTION", "original-link", 2)
        self.assertEqual(prepare.call_args.args[1], "greeks:amend:original-link:2")
        saved = json.loads(Path(restarted.settings.state_file).read_text())
        self.assertEqual(saved["order_journal"]["original-link"]["amendment_sequence"], 2)

    async def test_legacy_hash_amendments_still_block_resend_until_original_terminal(self):
        engine = await self.engine()
        self.register_order(engine)
        writer = engine.account_writer
        for index, state in enumerate(("sending", "unknown")):
            with self.subTest(state=state):
                body = {"category": "option", "symbol": "BTC-OPTION", "orderLinkId": "original-link", "price": str(index + 2)}
                old_id = "greeks:amend:original-link:" + _digest(body)
                operation = writer.registry.prepare(writer.claim(), old_id,
                    {"method": "POST", "path": "/v5/order/amend", "body": body, "groupId": "greeks:order:original-link",
                     "intentAction": "amend", "intentTarget": {"symbol": "BTC-OPTION", "clientOrderId": "original-link"}})
                if state == "unknown":
                    writer.finish(operation, "unknown")
                writer.close()
                engine = await self.engine()
                writer = engine.account_writer
                with self.assertRaisesRegex(ValueError, "尚未核实"):
                    await engine.client.amend_order("BTC-OPTION", "original-link", index + 2)
                pending = writer.registry.unresolved(writer.current.get())
                self.assertEqual([(row["operationId"], row["state"]) for row in pending
                    if row["operationId"].startswith("greeks:amend:")], [(old_id, state)])
                writer.observe_order("BTC-OPTION", "original-link", {"symbol": "BTC-OPTION", "orderLinkId": "original-link",
                    "orderId": "remote-original", "side": "Buy", "qty": "1", "cumExecQty": "0", "orderStatus": "Cancelled"})
                self.assertEqual(writer.registry.unresolved(writer.current.get()), [])
        self.assertEqual(engine.order_journal["original-link"].get("amendment_sequence", 0), 0)
        self.assertTrue(all(request.method == "GET" for request in self.requests))

    async def test_same_original_amendment_cannot_be_sent_again_while_sending(self):
        engine = await self.engine()
        self.register_order(engine)
        await engine.client.close()
        entered, release = asyncio.Event(), asyncio.Event()
        posted = []

        async def respond(request):
            posted.append(json.loads(request.content))
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"retCode": 0, "result": {"orderId": "remote-original", "orderLinkId": "original-link"}})

        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        first = asyncio.create_task(engine.client.amend_order("BTC-OPTION", "original-link", 2))
        await asyncio.wait_for(entered.wait(), timeout=1)
        try:
            with self.assertRaisesRegex(ValueError, "尚未核实"):
                await engine.client.amend_order("BTC-OPTION", "original-link", 2)
        finally:
            release.set()
        await first
        self.assertEqual(len(posted), 1)
        self.assertEqual(engine.order_journal["original-link"]["amendment_sequence"], 1)

    async def test_amendment_save_failure_never_prepares_or_sends(self):
        engine = await self.engine()
        self.register_order(engine)
        path = Path(engine.settings.state_file)
        previous = path.read_bytes()
        registry = engine.account_writer.registry
        with patch("app.engine.os.fsync", side_effect=OSError("disk unavailable")), patch.object(registry, "prepare", wraps=registry.prepare) as prepare:
            with self.assertRaisesRegex(ValueError, "could not be saved"):
                await engine.client.amend_order("BTC-OPTION", "original-link", 2)
        prepare.assert_not_called()
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(registry.unresolved(engine.account_writer.current.get()), [])
        self.assertTrue(all(request.method == "GET" for request in self.requests))
        self.assertIsNotNone(engine.state_error)

    async def test_managed_amend_requires_matching_registered_original_and_valid_sequence(self):
        engine = await self.engine()
        registry = engine.account_writer.registry
        with patch.object(registry, "prepare", wraps=registry.prepare) as prepare:
            with self.assertRaisesRegex(ValueError, "缺少匹配"):
                await engine.client.amend_order("BTC-OPTION", "original-link", 2)
            self.register_order(engine)
            with self.assertRaisesRegex(ValueError, "缺少匹配"):
                await engine.client.amend_order("OTHER-OPTION", "original-link", 2)
            for invalid in (None, -1, True, False, 1.5, "1", {}, []):
                with self.subTest(sequence=invalid):
                    engine.order_journal["original-link"]["amendment_sequence"] = invalid
                    with self.assertRaisesRegex(ValueError, "序号无效"):
                        await engine.client.amend_order("BTC-OPTION", "original-link", 2)
        prepare.assert_not_called()
        self.assertTrue(all(request.method == "GET" for request in self.requests))

    async def test_corrupt_persisted_amendment_sequence_blocks_state_recovery(self):
        engine = await self.engine()
        self.register_order(engine)
        path = Path(engine.settings.state_file)
        saved = json.loads(path.read_text())
        with patch.dict(os.environ, {"WORKSPACE_MANAGED": "0"}):
            legacy = TradingEngine(engine.settings)
            self.assertIsNone(legacy.state_error)
            self.assertEqual(legacy.order_journal["original-link"]["amendment_sequence"], 0)
            for invalid in (None, -1, True, False, 1.5, "1", {}, []):
                with self.subTest(sequence=invalid):
                    saved["order_journal"]["original-link"]["amendment_sequence"] = invalid
                    path.write_text(json.dumps(saved))
                    restored = TradingEngine(engine.settings)
                    self.assertIsNotNone(restored.state_error)
                    self.assertEqual(restored.order_journal, {})

    async def test_amend_unknown_allows_only_verified_original_cancel_until_terminal(self):
        engine = await self.engine()
        engine.settings.failed_leg_position_checks = 1
        engine.order_journal["original-link"] = {"symbol": "BTC-OPTION", "side": "Buy", "qty": 1.0,
            "reduce_only": False, "status": "unknown", "terminal": False, "filledQty": 0.0}
        engine._save_state()
        await engine.client.close()
        cancels = []
        async def respond(request):
            if request.method == "POST":
                body = json.loads(request.content)
                if request.url.path.endswith("/amend"):
                    raise httpx.ReadTimeout("lost amendment", request=request)
                if request.url.path.endswith("/cancel"):
                    pending = engine.account_writer.registry.unresolved(engine.account_writer.current.get())
                    self.assertTrue(any(row["operationId"].startswith("greeks:amend:") and row["state"] == "unknown" for row in pending))
                    cancels.append(body)
                result = {"orderId": "remote-original", "orderLinkId": "original-link"}
            else:
                result = {"list": [{"symbol": "BTC-OPTION", "orderLinkId": "original-link", "orderId": "remote-original",
                    "side": "Buy", "qty": "1", "cumExecQty": "0", "orderStatus": "Cancelled" if cancels else "New"}]}
            return httpx.Response(200, json={"retCode": 0, "result": result})
        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "original-link")
        with self.assertRaises(httpx.ReadTimeout):
            await engine.client.amend_order("BTC-OPTION", "original-link", 3)
        executor = OrderExecutor(engine.client, engine.settings, engine.log)
        previous = {"orderId": "remote-original", "orderLinkId": "original-link", "status": "unknown", "terminal": False, "filledQty": 0.0}
        record = lambda outcome: engine._record_order("original-link", outcome)
        first = await executor.reconcile("BTC-OPTION", "Buy", 1, "original-link", previous, record=record)
        self.assertFalse(first["terminal"])
        self.assertEqual(cancels, [])
        pending = engine.account_writer.registry.unresolved(engine.account_writer.current.get())
        self.assertEqual(len(pending), 1)
        self.assertTrue(pending[0]["operationId"].startswith("greeks:amend:"))
        final = await executor.reconcile("BTC-OPTION", "Buy", 1, "original-link", first, record=record)
        self.assertTrue(final["terminal"])
        self.assertEqual(len(cancels), 1)
        self.assertEqual(engine.account_writer.registry.unresolved(engine.account_writer.current.get()), [])

    async def test_parallel_amends_and_cancels_keep_real_child_semantics(self):
        engine = await self.engine()
        engine.execution_groups["persisted-parent"] = {"type": "open", "legs": {}}
        for index in range(4):
            link = "leg-" + str(index)
            engine.execution_group_links[link] = "persisted-parent"
            self.register_order(engine, link, "BTC-" + str(index))
        engine._save_state()
        await engine.client.close()
        requests, current, maximum = [], 0, 0
        async def respond(request):
            nonlocal current, maximum
            body = json.loads(request.content)
            requests.append((request.url.path, body))
            current += 1
            maximum = max(maximum, current)
            await asyncio.sleep(.03)
            current -= 1
            return httpx.Response(200, json={"retCode": 0, "result": {"orderId": "remote-" + body["orderLinkId"], "orderLinkId": body["orderLinkId"]}})
        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        await asyncio.gather(*(engine.client.amend_order("BTC-" + str(index), "leg-" + str(index), index + 1) for index in range(4)))
        await asyncio.gather(*(engine.client.cancel_order("BTC-" + str(index), "leg-" + str(index)) for index in range(4)))
        self.assertEqual(maximum, 4)
        self.assertEqual(len(requests), 8)
        self.assertEqual([body["price"] for path, body in requests if path.endswith("/amend")], ["1", "2", "3", "4"])
        saved = json.loads(Path(engine.settings.state_file).read_text())
        self.assertEqual({link: entry["amendment_sequence"] for link, entry in saved["order_journal"].items()},
            {"leg-" + str(index): 1 for index in range(4)})

    async def test_unrelated_rfq_and_order_cannot_share_parallel_write_admission(self):
        engine = await self.engine()
        engine.rfq_state = {"rfq_link_id": "rfq-original", "status": "CreationUnknown"}
        engine._save_state()
        await engine.client.close()
        entered, release = asyncio.Event(), asyncio.Event()
        requests = []
        async def respond(request):
            requests.append(request.url.path)
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"retCode": 0, "result": {"rfqId": "remote-rfq", "rfqLinkId": "rfq-original"}})
        engine.client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        first = asyncio.create_task(engine.client.create_rfq(["DESK"], [], "rfq-original"))
        await asyncio.wait_for(entered.wait(), timeout=1)
        try:
            with self.assertRaises(Exception):
                await engine.client.place_limit_order("BTC-OPTION", "Buy", 1, 2, "unrelated-original")
        finally:
            release.set()
        await first
        self.assertEqual(requests, ["/v5/rfq/create-rfq"])


if __name__ == "__main__":
    unittest.main()

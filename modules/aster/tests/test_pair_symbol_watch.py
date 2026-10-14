"""Target-position adoption retains archived orders in their original market."""
from contextlib import ExitStack
from copy import deepcopy
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests import test_pair_integration as integration
from tests.test_cycle_account_snapshot import (
    ACCOUNT, BRACKET, ORDERS, RISK, LocalQuoteMarket, cycle_account_responses, risk_row)
from tests.test_exchange_hardening import FixtureAPI
from tests.test_pair_order_recovery import BATCH_ID, receipt_for, seed_pending
from trading.engine import Engine
from trading.exchange import ExchangeError, LiveBroker
from trading.models import TradingError, dec, wire
from trading.pair_execution import PairTrader
from trading.pair_recovery import require_archived_orders_clear
from trading.paper import PAPER_BRACKETS
from trading.server import create_app
from trading.store import Store


GOLD, SILVER = "XAUUSD1", "XAGUSD1"
TARGET = {"LONG": "12", "SHORT": "17"}


class WatchFixture(unittest.TestCase):
    def setUp(self):
        integration.PairIntegrationTests.setUp(self)
        self.addCleanup(self.engine.dashboard_reports.close)
        self.pair = self.engine.pairs.create(integration.pair_config(
            ordinary={"enabled": True}, cycle={"enabled": False}))
        self.checks = ExitStack()
        self.addCleanup(self.checks.close)
        self.prepare_brokers()
        self.checks.enter_context(self.no_writes())
        self.submitted = seed_pending(self.engine)
        preview = self.engine.pairs.preview_recovery("gold")
        self.engine.pairs.confirm_recovery("gold", preview["token"], acknowledge_unknown=True)
        self.pair = self.f.store.pair("gold")
        self.original = self.state()
        self.audit = self.f.store.get("pair_order_recovery:gold:" + BATCH_ID)
        self.move_positions(SILVER, TARGET)

    def prepare_brokers(self):
        pass

    def state(self):
        return self.f.store.get("pair_runtime:gold")

    def broker(self, side="long", engine=None):
        engine = engine or self.engine
        return engine.broker(engine.store.account(self.pair[side + "_account_id"]))

    def no_writes(self, engine=None):
        stack = ExitStack()
        for side in ("long", "short"):
            for method in ("submit", "cancel", "set_leverage", "set_cycle_leverage"):
                stack.enter_context(patch.object(self.broker(side, engine), method,
                    side_effect=AssertionError("symbol adoption must not " + method)))
        stack.enter_context(patch("trading.margin_balance.MarginBalancer.tick",
            side_effect=AssertionError("symbol adoption must not transfer")))
        return stack

    def move_positions(self, symbol, quantities):
        for key, side in (("long", "LONG"), ("short", "SHORT")):
            broker = self.broker(key)
            for row in broker.state["positions"].values():
                row.update(qty="0", entry="0")
            broker.state["positions"][symbol + ":" + side].update(
                qty=quantities[side], entry=wire(self.f.market.book(symbol).mark))
            broker.save()

    def switch(self, symbol=SILVER):
        return self.engine.pairs.configure("gold", {"symbol": symbol})

    def assert_unchanged(self, runtime=None):
        self.assertEqual(self.f.store.pair("gold"), self.pair)
        self.assertEqual(self.state(), self.original if runtime is None else runtime)
        self.assertEqual(self.f.store.get("pair_order_recovery:gold:" + BATCH_ID), self.audit)
        with self.f.store.connect() as db:
            self.assertEqual(db.execute(
                "SELECT count(*) FROM kv WHERE key LIKE 'pair_symbol_change:%'").fetchone()[0], 0)

    def assert_adopted(self, pair):
        state = self.state()
        self.assertEqual(pair["symbol"], SILVER)
        self.assertFalse(pair["enabled"])
        for key in ("id", "name", "long_account_id", "short_account_id", "ordinary", "margin"):
            self.assertEqual(pair[key], self.pair[key])
        self.assertEqual(pair["cycle"], {**self.pair["cycle"], "symbol": SILVER})
        self.assertEqual(state["symbol"], SILVER)
        self.assertEqual(state["phase"], "paused")
        self.assertEqual(state["owned"], TARGET)
        self.assertEqual(state["progress"]["baseline"], TARGET)
        self.assertEqual(state["progress"]["quantities"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(state["progress"]["completed_cycles"], 4)
        self.assertIsNone(state["pending"])
        self.assertEqual(state["recovery_watch"], self.original["recovery_watch"])
        for key in ("daily_volume", "volume_unknown", "volume_unknown_until_utc"):
            self.assertEqual(state.get(key), self.original.get(key))
        archive = self.f.store.get(f"pair_symbol_change:gold:{pair['revision']}")
        self.assertEqual(archive["runtime"], self.original)
        self.assertEqual(archive["pair"], self.pair)
        self.assertEqual(self.f.store.get("pair_order_recovery:gold:" + BATCH_ID), self.audit)


class PairSymbolWatchTests(WatchFixture):
    def test_api_adopts_manual_silver_then_starts_and_restarts_with_gold_watch(self):
        with patch.dict(os.environ, {"ASTER_DASHBOARD_PASSWORD": "symbol-watch-test-password"}):
            app = create_app(self.engine, start_engine=False)
        with TestClient(app) as client:
            client.headers["origin"] = str(client.base_url).rstrip("/")
            self.assertEqual(client.post("/api/login", json={
                "password": "symbol-watch-test-password"}).status_code, 200)
            response = client.patch("/api/pairs/gold", json={"symbol": SILVER})
            self.assertEqual(response.status_code, 200, response.text)
            self.assert_adopted(response.json()["pair"])
            response = client.post("/api/pairs/gold/enable")
            self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.f.store.pair("gold")["enabled"])
        self.assertEqual(self.state()["owned"], TARGET)
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.addCleanup(restarted.dashboard_reports.close)
        with self.no_writes(restarted), ExitStack() as spies:
            queries = {key: spies.enter_context(patch.object(self.broker(key, restarted), "query",
                wraps=self.broker(key, restarted).query)) for key in ("long", "short")}
            require_archived_orders_clear(restarted, restarted.store.pair("gold"))
        for leg in self.submitted["pending"]["legs"]:
            queries[leg["key"]].assert_called_once_with(GOLD, leg["order"]["newClientOrderId"])
        self.assertEqual(restarted.store.get("pair_runtime:gold")["recovery_watch"],
                         self.original["recovery_watch"])

    def test_terminal_zero_fill_receipts_allow_switch_without_rewriting_original_orders(self):
        with ExitStack() as stack:
            queries = {}
            for leg in self.submitted["pending"]["legs"]:
                queries[leg["key"]] = stack.enter_context(patch.object(self.broker(leg["key"]), "query",
                    return_value=receipt_for(leg)))
            self.assert_adopted(self.switch())
        for leg in self.submitted["pending"]["legs"]:
            queries[leg["key"]].assert_called_once_with(GOLD, leg["order"]["newClientOrderId"])

    def test_active_late_fill_query_failure_and_wrong_receipt_preserve_original_state(self):
        leg = self.submitted["pending"]["legs"][0]
        outcomes = (
            receipt_for(leg, status="NEW"),
            receipt_for(leg, status="FILLED", qty="0.2"),
            ExchangeError("offline query failure"),
            receipt_for(leg, client_id="unrelated-order"),
        )
        for outcome in outcomes:
            self.move_positions(SILVER, TARGET)
            if isinstance(outcome, dict) and outcome.get("status") == "FILLED":
                broker = self.broker()
                broker.state["positions"][GOLD + ":LONG"].update(qty="0.2", entry="4412")
                broker.save()
            options = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
            with self.subTest(outcome=str(outcome)), patch.object(self.broker(), "query", **options):
                with self.assertRaises(TradingError):
                    self.switch()
                self.assert_unchanged()

    def test_corrupt_watch_identity_shape_and_symbol_mismatch_never_commit(self):
        changes = {
            "identity": lambda watch: watch["batches"][0]["identities"]["long"].update(env_prefix="ASTER_OTHER"),
            "batches": lambda watch: watch.update(batches=None),
            "legs": lambda watch: watch["batches"][0].update(legs=[None, None]),
            "batch_symbol": lambda watch: watch["batches"][0].update(symbol=SILVER),
            "order_symbol": lambda watch: watch["batches"][0]["legs"][0]["order"].update(symbol=SILVER),
        }
        for name, change in changes.items():
            state = deepcopy(self.original)
            change(state["recovery_watch"])
            self.f.store.put("pair_runtime:gold", state)
            with self.subTest(boundary=name), self.assertRaises(TradingError):
                self.switch()
            self.assert_unchanged(state)

    def test_legacy_batch_is_frozen_once_and_round_trip_never_relabels_its_watch(self):
        legacy = deepcopy(self.original)
        legacy["recovery_watch"]["batches"][0].pop("symbol")
        self.f.store.put("pair_runtime:gold", legacy)
        silver = self.switch()
        watch = self.state()["recovery_watch"]
        self.assertEqual(watch["batches"][0]["symbol"], GOLD)
        self.assertEqual(watch["batches"][0]["legs"], legacy["recovery_watch"]["batches"][0]["legs"])
        self.assertEqual(self.f.store.get(f"pair_symbol_change:gold:{silver['revision']}")["runtime"], legacy)
        self.move_positions(GOLD, {"LONG": "0.2", "SHORT": "0.3"})
        self.switch(GOLD)
        self.assertEqual(self.state()["recovery_watch"], watch)
        self.move_positions(SILVER, TARGET)
        self.switch()
        self.assertEqual(self.state()["recovery_watch"], watch)
        self.assertEqual(self.state()["owned"], TARGET)
        self.assertEqual(self.f.store.get("pair_order_recovery:gold:" + BATCH_ID), self.audit)

    def test_late_gold_fill_after_switch_blocks_start_and_new_opening(self):
        self.switch()
        before = self.state()
        row = receipt_for(self.submitted["pending"]["legs"][0], status="FILLED", qty="0.2")
        broker = self.broker()
        broker.state["positions"][GOLD + ":LONG"].update(qty="0.2", entry="4412")
        broker.save()
        with patch.object(self.broker(), "query", return_value=row), self.assertRaises(TradingError):
            self.engine.pairs.enable("gold", True)
        self.assertEqual(self.state(), before)
        self.assertFalse(self.f.store.pair("gold")["enabled"])
        self.move_positions(SILVER, TARGET)
        pair = self.engine.pairs.enable("gold", True)
        trader = PairTrader(self.engine)
        broker.state["positions"][GOLD + ":LONG"].update(qty="0.2", entry="4412")
        broker.save()
        with patch.object(self.broker(), "query", return_value=row) as query:
            with self.assertRaises(TradingError):
                require_archived_orders_clear(self.engine, pair)
            with self.assertRaises(TradingError):
                trader._config_guard(pair, self.state()["identities"], opening=True)
            query.reset_mock()
            trader._config_guard(pair, self.state()["identities"], opening=False)
            query.assert_not_called()
        self.assertEqual(self.state()["recovery_watch"], before["recovery_watch"])

    def test_watch_query_cannot_extend_the_target_snapshot_freshness(self):
        read_members, query = self.engine.pairs._read_members, self.broker().query
        snapshots = []

        def read(*args, **kwargs):
            result = read_members(*args, **kwargs)
            snapshots.extend(result[0].values())
            return result

        def expire(*args, **kwargs):
            self.assertTrue(snapshots, "watch queries follow fresh target snapshots")
            for snapshot in snapshots:
                snapshot.timestamp -= 20
            return query(*args, **kwargs)

        with patch.object(self.engine.pairs, "_read_members", side_effect=read), \
                patch.object(self.broker(), "query", side_effect=expire), self.assertRaisesRegex(TradingError, "过期"):
            self.switch()
        self.assert_unchanged()

    def test_concurrent_watch_change_during_query_is_not_overwritten(self):
        other = Store(self.f.store.path)
        changed = deepcopy(self.original)
        changed["recovery_watch"]["batches"][0]["created_at"] += 1
        query = self.broker().query

        def change(*args, **kwargs):
            other.put("pair_runtime:gold", changed)
            return query(*args, **kwargs)

        with patch.object(self.broker(), "query", side_effect=change), self.assertRaises(TradingError):
            self.switch()
        self.assert_unchanged(changed)


class PairSymbolLiveWatchTests(WatchFixture):
    def prepare_brokers(self):
        self.checks.enter_context(patch.object(self.engine, "live_allowed", return_value=True))
        self.checks.enter_context(patch("trading.margin_balance.MarginBalancer.verify_members",
            return_value={"verified": True, "mode": "live"}))
        for aid, digit in (("test", "1"), ("second", "2")):
            self.f.store.save_account({**self.f.store.account(aid), "mode": "live"})
            responses = cycle_account_responses((GOLD, SILVER))
            responses["/fapi/v3/positionSide/dual"] = {"dualSidePosition": True}
            responses[RISK] = [risk_row(row) for row in responses[ACCOUNT]["positions"]]
            responses[BRACKET] = [{"symbol": symbol, "brackets": PAPER_BRACKETS} for symbol in (GOLD, SILVER)]
            responses[ORDERS] = []
            market = LocalQuoteMarket()
            market.marks[SILVER] = dec(30)
            market.connected.add(SILVER)
            broker = LiveBroker({}, market, api=FixtureAPI(responses))
            broker.api.credentials = {"user": "0x" + digit * 40, "signer": "0x" + digit * 39 + "f"}
            self.engine.brokers[aid] = broker

    def move_positions(self, symbol, quantities):
        for key, side in (("long", "LONG"), ("short", "SHORT")):
            api = self.broker(key).api
            rows = api.responses[ACCOUNT]["positions"]
            for row in rows:
                row.update(positionAmt="0", entryPrice="0")
                if row["symbol"] == symbol and row["positionSide"] == side:
                    row.update(positionAmt=quantities[side] if side == "LONG" else "-" + quantities[side],
                               entryPrice="30" if symbol == SILVER else "100")
            api.responses[RISK] = [risk_row(row, mark="30" if row["symbol"] == SILVER else "100") for row in rows]
            api.calls.clear()

    def tearDown(self):
        self.assertTrue(all(call[0] == "GET" for key in ("long", "short") for call in self.broker(key).api.calls))

    def test_offline_live_switch_reads_silver_positions_and_queries_original_gold_ids(self):
        with ExitStack() as spies, patch.object(self.engine, "live_allowed", return_value=False):
            snapshots = {key: spies.enter_context(patch.object(self.broker(key), "snapshot",
                wraps=self.broker(key).snapshot)) for key in ("long", "short")}
            self.assert_adopted(self.switch())
        for leg in self.submitted["pending"]["legs"]:
            key = leg["key"]
            snapshots[key].assert_called_once_with([SILVER], fresh_modes=True)
            calls = [call for call in self.broker(key).api.calls if call[1] == "/fapi/v3/order"]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][2][0]["symbol"], GOLD)
            self.assertEqual(calls[0][2][0]["origClientOrderId"], leg["order"]["newClientOrderId"])

    def test_live_watch_query_revocation_and_identity_change_cannot_commit(self):
        broker = self.broker()
        original_credentials = deepcopy(broker.api.credentials)
        query = broker.query
        changes = {
            "account_event": lambda: broker._cycle_account_event("ACCOUNT_UPDATE"),
            "identity": lambda: broker.api.credentials.update(user="0x" + "3" * 40),
        }
        for name, change in changes.items():
            def mutate(*args, **kwargs):
                change()
                return query(*args, **kwargs)

            with self.subTest(boundary=name), patch.object(broker, "query", side_effect=mutate):
                with self.assertRaises(TradingError):
                    self.switch()
                self.assert_unchanged()
            broker.api.credentials = deepcopy(original_credentials)

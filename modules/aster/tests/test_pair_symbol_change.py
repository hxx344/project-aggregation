"""Paused symbol edits rewrite configuration and a fresh runtime, without reads or adoption."""
from contextlib import ExitStack, nullcontext
from copy import deepcopy
import time
import unittest
from unittest.mock import patch

from tests import test_pair_integration as integration
from tests.account_fixtures import (
    ACCOUNT, BRACKET, ORDERS, RISK, LocalQuoteMarket, account_row, join_margin_responses, risk_row)
from tests.test_exchange_hardening import FixtureAPI
from trading.engine import Engine
from trading.exchange import ExchangeError, LiveBroker
from trading.models import TradingError, dec
from trading.pair_execution import PairTrader
from tests.pair_legacy_fixtures import empty_progress, runtime_default
from trading.paper import PAPER_BRACKETS
from trading.store import Store


GOLD, SILVER = "XAUUSD1", "XAGUSD1"


class PairSymbolChangeTests(unittest.TestCase):
    create = integration.PairIntegrationTests.create

    def setUp(self):
        integration.PairIntegrationTests.setUp(self)
        self.pair = self.create()
        self.original = {**runtime_default(), "symbol": GOLD,
                         "identities": PairTrader(self.engine)._members(self.pair, read_only=True)[2]}
        self.f.store.put("pair_runtime:gold", self.original)
        self.no_writes = ExitStack()
        self.addCleanup(self.no_writes.close)
        for aid in ("test", "second"):
            self.guard_broker(self.engine.broker(self.f.store.account(aid)))
        self.no_writes.enter_context(patch("trading.margin_balance.MarginBalancer.tick",
            side_effect=AssertionError("unexpected transfer")))

    def guard_broker(self, broker):
        for method in ("submit", "cancel", "set_leverage"):
            self.no_writes.enter_context(patch.object(broker, method,
                side_effect=AssertionError("unexpected " + method)))

    def switch(self, symbol=SILVER, **changes):
        return self.engine.pairs.configure("gold", {"symbol": symbol, **changes})

    def after_reads(self, action):
        """Run ``action`` after the switch captured member identities, before its commit."""
        original = PairTrader._members

        def members(trader, *args, **kwargs):
            result = original(trader, *args, **kwargs)
            action(result)
            return result

        return patch.object(PairTrader, "_members", members)

    def no_member_reads(self):
        return patch.object(PairTrader, "_members", side_effect=AssertionError("unexpected read"))

    def assert_no_change(self, pair=None, runtime=None):
        self.assertEqual(self.f.store.pair("gold"), self.pair if pair is None else pair)
        self.assertEqual(self.f.store.get("pair_runtime:gold"), self.original if runtime is None else runtime)
        with self.f.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM kv WHERE key LIKE 'pair_symbol_change:%'").fetchone()[0], 0)

    def test_round_trip_preserves_settings_and_resets_runtime(self):
        self.original.update(last_batch={"symbol": GOLD, "id": "old"}, attention="old error",
                             retry_after=60, snapshots={"long": {"symbol": GOLD}})
        self.original["progress"].update(config={"symbol": GOLD}, completed_cycles=7)
        self.f.store.put("pair_runtime:gold", self.original)
        margin = {"status": "complete", "pending": None, "cooldown_until": time.time() + 100,
                  "ledger": [{"id": "historical-transfer"}]}
        self.f.store.put("pair_margin:gold", margin)
        for symbol in (SILVER, GOLD):
            pair = self.switch(symbol)
            self.assertFalse(pair["enabled"])
            for key in ("id", "long_account_id", "short_account_id", "ordinary", "margin"):
                self.assertEqual(pair[key], self.pair[key])
            state = self.f.store.get("pair_runtime:gold")
            self.assertEqual(state["symbol"], symbol)
            self.assertEqual(state["phase"], "paused")
            self.assertEqual(state["snapshots"], {})
            self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
            for key in ("last_batch", "attention", "retry_after", "progress"):
                self.assertNotIn(key, state)
            self.assertEqual(self.f.store.get("pair_margin:gold"), margin)

    def test_same_symbol_keeps_original_no_network_configuration_path(self):
        self.original["owned"]["LONG"] = "2"
        self.f.store.put("pair_runtime:gold", self.original)
        with self.no_member_reads():
            pair = self.switch(GOLD, name="新的名称")
        self.assertEqual(pair["name"], "新的名称")
        self.assertEqual(self.f.store.get("pair_runtime:gold"), self.original)

    def test_restart_retains_new_symbol_and_both_member_bindings(self):
        pair = self.switch()
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.assertEqual(restarted.store.pair("gold"), pair)
        self.assertEqual(restarted.store.get("pair_runtime:gold")["symbol"], SILVER)
        self.assertEqual(restarted.store.get("pair_runtime:gold")["phase"], "paused")
        for aid in ("test", "second"):
            self.assertEqual(restarted.store.pair_for_account(aid), pair)

    def set_target_positions(self, long="2", short="3"):
        for aid, side, qty in (("test", "LONG", long), ("second", "SHORT", short)):
            broker = self.engine.broker(self.f.store.account(aid))
            broker.state["positions"][SILVER + ":" + side].update(qty=qty, entry="30")
            broker.save()

    def test_switch_drops_old_symbol_quantity_without_adopting_target_holdings(self):
        self.original.update(owned={"LONG": "99", "SHORT": "88"})
        self.original["progress"] = empty_progress(self.original["owned"], completed=5)
        self.f.store.put("pair_runtime:gold", self.original)
        self.set_target_positions()
        pair = self.switch()
        state = self.f.store.get("pair_runtime:gold")
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(state["phase"], "paused")
        self.assertFalse(pair["enabled"])
        restarted = Engine(Store(self.f.store.path), market=self.f.market)
        self.assertEqual(restarted.store.get("pair_runtime:gold")["owned"], state["owned"])
        self.assertEqual(restarted.store.pair("gold")["symbol"], SILVER)

    def test_cycle_pending_and_malformed_state_block_before_remote_reads(self):
        variants = [{"progress": {"quantities": {"LONG": "0", "SHORT": "1"}}},
                    {"pending": {}}, {"recovery_watch": {"batches": "invalid"}},
                    {"symbol": SILVER}, {"progress": {"config": {"symbol": SILVER}}}]
        for change in variants:
            with self.subTest(change=change):
                state = {**deepcopy(self.original), **change}
                self.f.store.put("pair_runtime:gold", state)
                with self.no_member_reads(), self.assertRaises(TradingError):
                    self.switch()
                self.assert_no_change(runtime=state)

    def test_unresolved_margin_states_block_and_keep_the_original_ledger(self):
        for state in ({"pending": {}}, *({"status": status} for status in
                      ("submitting", "acknowledged", "accepted", "unknown"))):
            with self.subTest(state=state):
                self.f.store.put("pair_margin:gold", state)
                with self.assertRaisesRegex(TradingError, "划转"):
                    self.switch()
                self.assert_no_change()
                self.assertEqual(self.f.store.get("pair_margin:gold"), state)

    def test_transfer_appearing_after_idle_check_is_not_accepted_as_the_expected_margin(self):
        original = self.engine.pairs._idle
        calls = 0

        def idle(*args, **kwargs):
            nonlocal calls
            result = original(*args, **kwargs)
            calls += 1
            if calls == 2:
                self.f.store.put("pair_margin:gold", {"status": "unknown", "pending": {"id": "race"}})
            return result

        with patch.object(self.engine.pairs, "_idle", side_effect=idle), self.assertRaisesRegex(TradingError, "划转"):
            self.switch()
        self.assert_no_change()

    def test_switch_preserves_all_holdings_without_adopting_any(self):
        self.set_target_positions()
        broker = self.engine.broker(self.f.store.account("test"))
        for symbol, side in ((GOLD, "LONG"), (SILVER, "SHORT"), ("CLUSD1", "SHORT")):
            broker.state["positions"][symbol + ":" + side].update(
                qty="1", entry=str(self.f.market.book(symbol).mark))
        broker.save()
        holdings = deepcopy(broker.state["positions"])
        pair = self.switch()
        state = self.f.store.get("pair_runtime:gold")
        self.assertEqual(pair["symbol"], SILVER)
        self.assertFalse(pair["enabled"])
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(broker.state["positions"], holdings)

    def test_switch_never_reads_account_snapshots(self):
        with ExitStack() as stack:
            for aid in ("test", "second"):
                broker = self.engine.broker(self.f.store.account(aid))
                stack.enter_context(patch.object(broker, "snapshot", side_effect=ExchangeError("unexpected read")))
            pair = self.switch()
        self.assertEqual(pair["symbol"], SILVER)
        self.assertEqual(self.f.store.get("pair_runtime:gold")["symbol"], SILVER)

    def test_store_compare_and_swap_retains_concurrent_changes(self):
        other = Store(self.f.store.path)
        actions = {
            "pair": lambda: other.save_pair({**self.pair, "name": "concurrent"}),
            "runtime": lambda: other.put("pair_runtime:gold", {**self.original, "attention": "concurrent"}),
            "margin": lambda: other.put("pair_margin:gold", {"status": "unknown"}),
            "account": lambda: other.save_account({**other.account("test"), "name": "concurrent"}),
            "binding": lambda: self.remove_binding(other),
            "intent": lambda: other.save_intent({"id": "race", "account_id": "test", "status": "pending", "kind": "leverage"}),
        }
        for name, action in actions.items():
            with self.subTest(name=name):
                # Each race uses a savepoint-shaped restoration of only its own rows.
                with other.connect() as db:
                    original = {table: [tuple(row) for row in db.execute("SELECT * FROM " + table)]
                                for table in ("pairs", "kv", "accounts", "pair_members", "intents")}
                with self.after_reads(lambda _: action()), self.assertRaises(TradingError):
                    self.switch()
                current = other.pair("gold")
                self.assertEqual(current["symbol"], GOLD)
                self.assertFalse(current["enabled"])
                self.assertEqual(other.get("pair_runtime:gold")["symbol"], GOLD)
                with other.connect() as db:
                    for table, rows in original.items():
                        db.execute("DELETE FROM " + table)
                        if rows:
                            db.executemany("INSERT INTO " + table + " VALUES(" + ",".join("?" for _ in rows[0]) + ")", rows)

    @staticmethod
    def remove_binding(store):
        with store.connect() as db:
            db.execute("DELETE FROM pair_members WHERE account_id='test'")

    def test_failure_after_config_write_rolls_back_configuration_and_archive(self):
        original = self.f.store._save_pair

        def save(*args, **kwargs):
            self.assertTrue(args[0].in_transaction, "CAS writer lock must survive the final identity guard")
            original(*args, **kwargs)
            raise RuntimeError("offline disk failure")

        for scoped in (False, True):
            with self.subTest(scoped=scoped):
                with self.f.store.connection_scope() if scoped else nullcontext():
                    with patch.object(self.f.store, "_save_pair", side_effect=save), self.assertRaises(RuntimeError):
                        self.switch()
                self.assert_no_change()

    def test_generic_store_save_cannot_bypass_symbol_check(self):
        with self.assertRaises(TradingError):
            self.f.store.save_pair({**self.pair, "symbol": SILVER})
        self.assert_no_change()


class PairSymbolLiveChangeTests(PairSymbolChangeTests):
    """The real LiveBroker parses offline exchange payloads and revokes reads."""

    def setUp(self):
        super().setUp()
        self.live = {}
        for aid in ("test", "second"):
            self.f.store.save_account({**self.f.store.account(aid), "mode": "live"})
            responses = join_margin_responses((GOLD, SILVER))
            responses["/fapi/v3/positionSide/dual"] = {"dualSidePosition": True}
            responses[RISK] = [risk_row(row) for row in responses[ACCOUNT]["positions"]]
            responses[BRACKET] = [{"symbol": symbol, "brackets": PAPER_BRACKETS} for symbol in (GOLD, SILVER)]
            responses[ORDERS] = []
            market = LocalQuoteMarket()
            market.marks[SILVER] = dec(30)
            market.connected.add(SILVER)
            broker = LiveBroker({}, market, api=FixtureAPI(responses))
            digit = "1" if aid == "test" else "2"
            broker.api.credentials = {"user": "0x" + digit * 40, "signer": "0x" + digit * 39 + "f"}
            self.engine.brokers[aid] = self.live[aid] = broker
            self.guard_broker(broker)
        self.original["identities"] = PairTrader(self.engine)._members(self.pair, read_only=True)[2]
        self.f.store.put("pair_runtime:gold", self.original)

    def tearDown(self):
        self.assertTrue(all(call[0] == "GET" for broker in self.live.values() for call in broker.api.calls))

    def set_target_positions(self, long="2", short="3"):
        for aid, side, qty in (("test", "LONG", long), ("second", "SHORT", "-" + short)):
            api = self.live[aid].api
            for row in api.responses[ACCOUNT]["positions"]:
                if row["symbol"] == SILVER and row["positionSide"] == side:
                    row.update(positionAmt=qty, entryPrice="30")
            api.responses[RISK] = [risk_row(row, mark="30" if row["symbol"] == SILVER else "100")
                                   for row in api.responses[ACCOUNT]["positions"]]

    # The account payload test below covers holdings for live adapters.
    def test_switch_preserves_all_holdings_without_adopting_any(self):
        self.set_target_positions()
        api = self.live["test"].api
        rows = deepcopy(api.responses[ACCOUNT]["positions"])
        for symbol, side in ((GOLD, "LONG"), (SILVER, "SHORT"), ("CLUSD1", "SHORT")):
            rows = [row for row in rows if (row["symbol"], row["positionSide"]) != (symbol, side)]
            rows.append(account_row(symbol, side, amount="1" if side == "LONG" else "-1",
                                    entry=str(self.live["test"].market.book(symbol).mark)))
        api.responses[ACCOUNT]["positions"] = rows
        api.responses[RISK] = [risk_row(row, mark="30" if row["symbol"] == SILVER else "100") for row in rows]
        holdings = deepcopy(rows)
        pair = self.switch()
        state = self.f.store.get("pair_runtime:gold")
        self.assertEqual(pair["symbol"], SILVER)
        self.assertFalse(pair["enabled"])
        self.assertEqual(state["owned"], {"LONG": "0", "SHORT": "0"})
        self.assertEqual(api.responses[ACCOUNT]["positions"], holdings)

    def test_symbol_change_makes_no_exchange_calls_while_execution_is_disabled(self):
        with patch.object(self.engine, "live_allowed", return_value=False):
            pair = self.switch()
        self.assertEqual(pair["symbol"], SILVER)
        for broker in self.live.values():
            self.assertEqual(broker.api.calls, [])

    def test_identity_change_or_same_real_account_blocks(self):
        for change in (lambda: self.live["test"].api.credentials.update(user="0x" + "3" * 40),
                       lambda: self.live["test"].api.credentials.update(user=self.live["second"].api.credentials["user"])):
            original = deepcopy(self.live["test"].api.credentials)
            with self.after_reads(lambda _: change()), self.assertRaises(TradingError):
                self.switch()
            self.assert_no_change()
            self.live["test"].api.credentials = original

    def test_broker_replacement_cannot_reuse_old_connection(self):
        with self.after_reads(lambda _: self.engine.brokers.pop("test")), self.assertRaises(TradingError):
            self.switch()
        self.assert_no_change()

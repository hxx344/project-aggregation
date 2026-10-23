"""Symbol edits adopt verified target holdings and preserve an atomic journal."""
from contextlib import ExitStack, contextmanager, nullcontext
from copy import deepcopy
from dataclasses import replace
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
        original = self.engine.pairs._read_members

        def read(*args, **kwargs):
            result = original(*args, **kwargs)
            action(result)
            return result

        return patch.object(self.engine.pairs, "_read_members", side_effect=read)

    def assert_no_change(self, pair=None, runtime=None):
        self.assertEqual(self.f.store.pair("gold"), self.pair if pair is None else pair)
        self.assertEqual(self.f.store.get("pair_runtime:gold"), self.original if runtime is None else runtime)
        with self.f.store.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM kv WHERE key LIKE 'pair_symbol_change:%'").fetchone()[0], 0)

    def test_round_trip_preserves_settings_and_archives_original_journal(self):
        self.original.update(last_batch={"symbol": GOLD, "id": "old"}, attention="old error",
                             retry_after=60, snapshots={"long": {"symbol": GOLD}})
        self.original["progress"].update(config={"symbol": GOLD}, completed_cycles=7)
        self.f.store.put("pair_runtime:gold", self.original)
        margin = {"status": "complete", "pending": None, "cooldown_until": time.time() + 100,
                  "ledger": [{"id": "historical-transfer"}]}
        self.f.store.put("pair_margin:gold", margin)
        self.engine.pairs.recovery.previews["gold"] = {"token": "old"}
        self.engine.pairs.recovery.baseline_previews["gold"] = {"token": "old"}
        for symbol in (SILVER, GOLD):
            before = self.f.store.get("pair_runtime:gold")
            pair = self.switch(symbol)
            self.assertFalse(pair["enabled"])
            for key in ("id", "long_account_id", "short_account_id", "ordinary", "margin"):
                self.assertEqual(pair[key], self.pair[key])
            state = self.f.store.get("pair_runtime:gold")
            self.assertEqual(state["symbol"], symbol)
            self.assertEqual(state["phase"], "paused")
            self.assertEqual(state["snapshots"], {})
            for key in ("last_batch", "attention", "retry_after"):
                self.assertNotIn(key, state)
            archive = self.f.store.get(f"pair_symbol_change:gold:{pair['revision']}")
            self.assertEqual(archive["runtime"], before)
            self.assertEqual(self.f.store.get("pair_margin:gold"), margin)
        self.assertNotIn("gold", self.engine.pairs.recovery.previews)
        self.assertNotIn("gold", self.engine.pairs.recovery.baseline_previews)

    def test_same_symbol_keeps_original_no_network_configuration_path(self):
        self.original["owned"]["LONG"] = "2"
        self.f.store.put("pair_runtime:gold", self.original)
        with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("unexpected read")):
            self.switch(GOLD, ordinary={"threshold": "12000"})
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

    def test_manual_target_holdings_replace_old_symbol_quantity_without_trading(self):
        self.original.update(owned={"LONG": "99", "SHORT": "88"})
        self.original["progress"] = empty_progress(self.original["owned"], completed=5)
        self.f.store.put("pair_runtime:gold", self.original)
        self.set_target_positions()
        pair = self.switch()
        state = self.f.store.get("pair_runtime:gold")
        self.assertEqual(state["owned"], {"LONG": "2", "SHORT": "3"})
        self.assertEqual(state["phase"], "paused")
        self.assertFalse(pair["enabled"])
        self.assertEqual(self.f.store.get(f"pair_symbol_change:gold:{pair['revision']}")["runtime"], self.original)
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
                with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("unexpected read")), \
                        self.assertRaises(TradingError):
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

    def test_other_holdings_are_preserved_while_only_target_direction_is_adopted(self):
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
        self.assertEqual(state["owned"], {"LONG": "2", "SHORT": "3"})
        self.assertEqual(broker.state["positions"], holdings)
        self.assertEqual(self.f.store.get(f"pair_symbol_change:gold:{pair['revision']}")["runtime"], self.original)

    def test_failed_or_stale_snapshot_keeps_old_configuration_and_runtime(self):
        broker = self.engine.broker(self.f.store.account("test"))
        snapshot = broker.snapshot([SILVER])
        for value in (ExchangeError("offline failure"), replace(snapshot, timestamp=time.time() - 20)):
            with self.subTest(value=type(value).__name__):
                options = {"side_effect": value} if isinstance(value, Exception) else {"return_value": value}
                with patch.object(broker, "snapshot", **options), self.assertRaises(TradingError):
                    self.switch()
                self.assert_no_change()

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
    def test_other_holdings_are_preserved_while_only_target_direction_is_adopted(self):
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
        self.assertEqual(state["owned"], {"LONG": "2", "SHORT": "3"})
        self.assertEqual(api.responses[ACCOUNT]["positions"], holdings)
        self.assertEqual(self.f.store.get(f"pair_symbol_change:gold:{pair['revision']}")["runtime"], self.original)

    def test_full_account_orders_and_unreadable_orders_block(self):
        for orders in ([{"symbol": "CLUSD1"}], {}, None, ExchangeError("orders unavailable")):
            with self.subTest(orders=orders):
                self.live["second"].api.responses[ORDERS] = orders
                with self.assertRaises(TradingError):
                    self.switch()
                self.assert_no_change()

    def test_symbol_change_checks_live_accounts_while_execution_is_disabled(self):
        with patch.object(self.engine, "live_allowed", return_value=False):
            pair = self.switch()
        self.assertEqual(pair["symbol"], SILVER)
        for broker in self.live.values():
            reads = [call for call in broker.api.calls if call[1] == ORDERS]
            self.assertEqual(len(reads), 1)
            self.assertFalse(reads[0][2])  # No symbol filter: inspect all orders.

    def test_identity_change_or_same_real_account_blocks(self):
        for change in (lambda: self.live["test"].api.credentials.update(user="0x" + "3" * 40),
                       lambda: self.live["test"].api.credentials.update(user=self.live["second"].api.credentials["user"])):
            original = deepcopy(self.live["test"].api.credentials)
            with self.after_reads(lambda _: change()), self.assertRaises(TradingError):
                self.switch()
            self.assert_no_change()
            self.live["test"].api.credentials = original

    def test_broker_replacement_cannot_reuse_old_snapshot_authority(self):
        with self.after_reads(lambda _: self.engine.brokers.pop("test")), self.assertRaises(TradingError):
            self.switch()
        self.assert_no_change()

    def test_snapshot_event_after_reads_cannot_authorize_commit(self):
        with self.after_reads(lambda _: self.live["test"]._private_account_event("ACCOUNT_UPDATE")), \
                self.assertRaises(TradingError):
            self.switch()
        self.assert_no_change()

    def test_stale_snapshot_after_wait_for_database_writer_blocks(self):
        original = self.f.store.connect
        captured = []

        @contextmanager
        def connect():
            with original() as db:
                class Connection:
                    def execute(inner, sql, *args):
                        result = db.execute(sql, *args)
                        if sql == "BEGIN IMMEDIATE":
                            for snapshot in captured:
                                snapshot.timestamp -= 20
                        return result
                yield Connection()

        def capture(result):
            captured.extend(result[0].values())

        with self.after_reads(capture), patch.object(self.f.store, "connect", side_effect=connect), \
                self.assertRaisesRegex(TradingError, "过期"):
            self.switch()
        self.assert_no_change()

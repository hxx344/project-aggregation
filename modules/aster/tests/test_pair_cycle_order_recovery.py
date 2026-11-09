"""Removed cycles remain immutable and blocked while funds and ADL stay independent."""
from contextlib import ExitStack
from copy import deepcopy
import json
from unittest import TestCase
from unittest.mock import patch

from tests import pair_fixtures
from tests.pair_fixtures import BATCH_ID, seed_legacy_pending
from trading.models import TradingError
from trading.pair_execution import PairTrader
from trading.pair_legacy import LEGACY_CYCLE_REASON, ROLLBACK_CYCLE
from trading.pairing import validate_pair
from trading.store import Store, dumps


class PairCycleOrderRecoveryTests(TestCase):
    def setUp(self):
        pair_fixtures.PairTradingTests.setUp(self)
        with self.store.connect() as db:
            db.execute("DELETE FROM pairs WHERE id=?", ("gold",))

    def test_old_config_loads_without_strategy_activation_or_database_rewrite(self):
        pair = self.engine.pairs.create({
            "id": "gold", "name": "旧配对组", "long_account_id": "long",
            "short_account_id": "short", "margin": {"enabled": True}})
        for enabled in (False, True):
            with self.subTest(cycle_enabled=enabled):
                old = {**pair, "cycle": {"enabled": enabled, "unexpected_old_key": "retained"}}
                with self.store.connect() as db:
                    db.execute("UPDATE pairs SET data=? WHERE id=?", (dumps(old), pair["id"]))
                reopened = Store(self.store.path)
                self.assertNotIn("cycle", reopened.pair("gold"))
                self.assertNotIn("cycle", reopened.pairs()[0])
                self.assertNotIn("cycle", reopened.pair_for_account("long"))
                normalized = validate_pair(old)
                self.assertNotIn("cycle", normalized)
                self.assertFalse(normalized["ordinary"]["enabled"])
                self.assertTrue(normalized["margin"]["enabled"])
                with self.store.connect() as db:
                    self.assertEqual(db.execute("SELECT data FROM pairs WHERE id='gold'").fetchone()[0], dumps(old))
        # Existing funds-only groups must still pass activation CAS against old JSON.
        saved = self.engine.pairs.enable("gold", True)
        self.assertTrue(saved["enabled"])
        self.assertFalse(saved["ordinary"]["enabled"])

    def test_start_and_pause_write_old_ordinary_opening_as_disabled(self):
        def raw():
            with self.store.connect() as db:
                return json.loads(db.execute("SELECT data FROM pairs WHERE id='gold'").fetchone()[0])

        pair = self.engine.pairs.create({
            "id": "gold", "name": "旧普通开仓组", "long_account_id": "long",
            "short_account_id": "short", "margin": {"enabled": True}})
        for enabled in (True, False):
            with self.subTest(start=enabled):
                current = raw()
                with self.store.connect() as db:
                    db.execute("UPDATE pairs SET data=? WHERE id='gold'", (dumps(
                        {**current, "ordinary": {**current["ordinary"], "enabled": True}}),))
                self.engine.pairs.enable("gold", enabled)
                # A rollback must not resume pair opening for a group saved by this version.
                self.assertFalse(raw()["ordinary"]["enabled"])
                self.assertEqual(raw()["ordinary"]["threshold"], pair["ordinary"]["threshold"])

    def test_enabled_old_cycle_without_other_strategy_never_opens(self):
        pair = self.engine.pairs.create({
            "id": "gold", "name": "无策略旧组", "long_account_id": "long", "short_account_id": "short"})
        old = {**pair, "enabled": True, "cycle": {"enabled": True}}
        with self.store.connect() as db:
            db.execute("UPDATE pairs SET data=? WHERE id=?", (dumps(old), "gold"))
        self.engine.pairs.tick("gold")
        self.assertTrue(self.store.pair("gold")["enabled"])
        self.assertFalse(self.store.pair("gold")["ordinary"]["enabled"])
        self.assertFalse(self.store.pair("gold")["margin"]["enabled"])
        # A running group without funds management must say that it does nothing.
        runtime = self.store.get("pair_runtime:gold")
        self.assertEqual(runtime["phase"], "attention")
        self.assertIn("保证金平衡未开启", runtime["attention"])

    def test_new_pair_writes_keep_rollback_readable_cycle_settings(self):
        def raw():
            with self.store.connect() as db:
                return json.loads(db.execute("SELECT data FROM pairs WHERE id='gold'").fetchone()[0])

        def write_raw(cycle):
            with self.store.connect() as db:
                db.execute("UPDATE pairs SET data=? WHERE id='gold'", (dumps({**raw(), "cycle": cycle}),))

        pair = self.engine.pairs.create({
            "id": "gold", "name": "回滚组", "long_account_id": "long",
            "short_account_id": "short", "margin": {"enabled": True}})
        self.assertNotIn("cycle", pair)
        self.assertEqual(raw()["cycle"], {**ROLLBACK_CYCLE, "symbol": pair["symbol"]})
        old = {"enabled": True, "symbol": pair["symbol"], "hold_seconds": 5, "unexpected_old_key": "retained"}
        write_raw(old)
        renamed = self.engine.pairs.configure("gold", {"name": "改名"})
        self.assertNotIn("cycle", renamed)
        self.assertEqual(raw()["cycle"], old)
        self.assertFalse(raw()["ordinary"]["enabled"])
        started = self.engine.pairs.enable("gold", True)
        self.assertNotIn("cycle", started)
        self.assertEqual(raw()["cycle"], {**old, "enabled": False})
        self.engine.pairs.enable("gold", False)
        write_raw(old)
        switched = self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
        self.assertEqual(switched["symbol"], "XAGUSD1")
        self.assertEqual(raw()["cycle"], {**old, "enabled": False, "symbol": "XAGUSD1"})

    def test_legacy_increment_pending_and_persisted_cycle_batch_block_without_mutation(self):
        self.engine.pairs.create({
            "id": "gold", "name": "旧组", "long_account_id": "long", "short_account_id": "short",
            "margin": {"enabled": True}})
        baseline = seed_legacy_pending(self.store)
        variants = {}
        pending = deepcopy(baseline)
        pending["pending"]["kind"] = "cycle"
        variants["pending"] = pending
        increment = deepcopy(baseline)
        increment["pending"] = None
        increment["progress"]["quantities"]["LONG"] = "0.00000000000000000001"
        variants["increment"] = increment
        variants["batch"] = deepcopy(baseline)
        for name, original in variants.items():
            with self.subTest(legacy=name):
                original.update(cycle_costs={"old": True}, execution_quality={"old": True},
                                execution_quality_history={"old": True})
                self.store.put("pair_runtime:gold", original)
                batch = {**baseline["pending"], "kind": "cycle"} if name == "batch" else None
                self.store.put("pair_batch:" + BATCH_ID, batch)
                with ExitStack() as stack:
                    for side in ("long", "short"):
                        pair = self.store.pair("gold")
                        broker = self.engine.broker(self.store.account(pair[side + "_account_id"]))
                        for method in ("submit", "query", "set_leverage"):
                            stack.enter_context(patch.object(broker, method, side_effect=AssertionError("no cycle work")))
                    adl = stack.enter_context(patch.object(self.engine.adl, "tick", return_value=None))
                    for _ in range(2):
                        self.engine.pairs.tick("gold")
                    adl.assert_called()
                    saved = self.store.get("pair_runtime:gold")
                    self.assertEqual(saved["phase"], "attention")
                    self.assertEqual(saved["reason"], LEGACY_CYCLE_REASON)
                    for field in ("pending", "progress", "owned", "daily_volume", "last_batch",
                                  "cycle_costs", "execution_quality", "execution_quality_history"):
                        self.assertEqual(saved[field], original[field])
                    self.assertEqual(self.store.get("pair_batch:" + BATCH_ID), batch)
                    with self.assertRaisesRegex(TradingError, LEGACY_CYCLE_REASON):
                        self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
                shown = self.engine.pairs.states()[0]
                self.assertNotIn("cycle", shown)
                self.assertNotIn("progress", shown["state"])
                for field in ("cycle_costs", "execution_quality", "execution_quality_history"):
                    self.assertNotIn(field, shown["state"])

    def test_funds_checks_remain_independent_when_legacy_cycle_blocks_orders(self):
        pair = self.engine.pairs.create({
            "id": "gold", "name": "旧组", "long_account_id": "long", "short_account_id": "short"})
        state = seed_legacy_pending(self.store, kind="cycle")
        pair["margin"]["enabled"] = True
        pair["enabled"] = True
        pair = self.store.save_pair(pair)
        with patch.object(PairTrader, "margin_tick", return_value={"blocks_trading": False}) as funds:
            result = PairTrader(self.engine).tick(pair)
        funds.assert_called_once()
        self.assertEqual(result["phase"], "attention")
        self.assertEqual(result["pending"], state["pending"])

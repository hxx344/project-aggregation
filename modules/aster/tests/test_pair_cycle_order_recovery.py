"""Removed cycles remain immutable and blocked while funds and ADL stay independent."""
from contextlib import ExitStack
from copy import deepcopy
import json
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_order_recovery as recovery
from tests.test_pair_order_recovery import BATCH_ID, seed_pending
from trading.models import TradingError
from trading.pair_execution import PairTrader
from trading.pair_legacy import LEGACY_CYCLE_REASON, ROLLBACK_CYCLE
from trading.pairing import validate_pair
from trading.store import Store, dumps


class PairCycleOrderRecoveryTests(TestCase):
    setUp = recovery.PairOrderRecoveryTests.setUp

    def test_old_config_loads_without_strategy_activation_or_database_rewrite(self):
        pair = self.engine.pairs.create({
            "id": "gold", "name": "旧配对组", "long_account_id": "test",
            "short_account_id": "second", "margin": {"enabled": True}})
        for enabled in (False, True):
            with self.subTest(cycle_enabled=enabled):
                old = {**pair, "cycle": {"enabled": enabled, "unexpected_old_key": "retained"}}
                with self.f.store.connect() as db:
                    db.execute("UPDATE pairs SET data=? WHERE id=?", (dumps(old), pair["id"]))
                reopened = Store(self.f.store.path)
                self.assertNotIn("cycle", reopened.pair("gold"))
                self.assertNotIn("cycle", reopened.pairs()[0])
                self.assertNotIn("cycle", reopened.pair_for_account("test"))
                normalized = validate_pair(old)
                self.assertNotIn("cycle", normalized)
                self.assertFalse(normalized["ordinary"]["enabled"])
                self.assertTrue(normalized["margin"]["enabled"])
                with self.f.store.connect() as db:
                    self.assertEqual(db.execute("SELECT data FROM pairs WHERE id='gold'").fetchone()[0], dumps(old))
        # Existing funds-only groups must still pass activation CAS against old JSON.
        saved = self.engine.pairs.enable("gold", True)
        self.assertTrue(saved["enabled"])
        self.assertFalse(saved["ordinary"]["enabled"])

    def test_enabled_old_cycle_without_other_strategy_never_opens(self):
        pair = self.engine.pairs.create({
            "id": "gold", "name": "无策略旧组", "long_account_id": "test", "short_account_id": "second"})
        old = {**pair, "enabled": True, "cycle": {"enabled": True}}
        with self.f.store.connect() as db:
            db.execute("UPDATE pairs SET data=? WHERE id=?", (dumps(old), "gold"))
        with patch.object(PairTrader, "_start", side_effect=AssertionError("no orders")), \
             patch.object(PairTrader, "_leverage", side_effect=AssertionError("no leverage")):
            self.engine.pairs.tick("gold")
        self.assertTrue(self.f.store.pair("gold")["enabled"])
        self.assertFalse(self.f.store.pair("gold")["ordinary"]["enabled"])
        self.assertFalse(self.f.store.pair("gold")["margin"]["enabled"])

    def test_new_pair_writes_keep_rollback_readable_cycle_settings(self):
        def raw():
            with self.f.store.connect() as db:
                return json.loads(db.execute("SELECT data FROM pairs WHERE id='gold'").fetchone()[0])

        def write_raw(cycle):
            with self.f.store.connect() as db:
                db.execute("UPDATE pairs SET data=? WHERE id='gold'", (dumps({**raw(), "cycle": cycle}),))

        pair = self.engine.pairs.create({
            "id": "gold", "name": "回滚组", "long_account_id": "test",
            "short_account_id": "second", "margin": {"enabled": True}})
        self.assertNotIn("cycle", pair)
        self.assertEqual(raw()["cycle"], {**ROLLBACK_CYCLE, "symbol": pair["symbol"]})
        old = {"enabled": True, "symbol": pair["symbol"], "hold_seconds": 5, "unexpected_old_key": "retained"}
        write_raw(old)
        renamed = self.engine.pairs.configure("gold", {"name": "改名"})
        self.assertNotIn("cycle", renamed)
        self.assertEqual(raw()["cycle"], old)
        # Saving ordinary without starting must not leave both strategies on for a rollback.
        self.engine.pairs.configure("gold", {"ordinary": {"enabled": True}})
        self.assertEqual(raw()["cycle"], {**old, "enabled": False})
        self.engine.pairs.configure("gold", {"ordinary": {"enabled": False}})
        write_raw(old)
        started = self.engine.pairs.enable("gold", True)
        self.assertNotIn("cycle", started)
        self.assertEqual(raw()["cycle"], {**old, "enabled": False})
        self.engine.pairs.enable("gold", False)
        write_raw(old)
        switched = self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
        self.assertEqual(switched["symbol"], "XAGUSD1")
        self.assertEqual(raw()["cycle"], {**old, "enabled": False, "symbol": "XAGUSD1"})

    def test_legacy_increment_pending_and_persisted_cycle_batch_block_without_mutation(self):
        baseline = seed_pending(self.engine)
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
                self.f.store.put("pair_runtime:gold", original)
                batch = {**baseline["pending"], "kind": "cycle"} if name == "batch" else None
                self.f.store.put("pair_batch:" + BATCH_ID, batch)
                with ExitStack() as stack:
                    for side in ("long", "short"):
                        pair = self.f.store.pair("gold")
                        broker = self.engine.broker(self.f.store.account(pair[side + "_account_id"]))
                        for method in ("submit", "query", "set_leverage"):
                            stack.enter_context(patch.object(broker, method, side_effect=AssertionError("no cycle work")))
                    adl = stack.enter_context(patch.object(self.engine.adl, "tick", return_value=None))
                    for _ in range(2):
                        self.engine.pairs.tick("gold")
                    adl.assert_called()
                    saved = self.f.store.get("pair_runtime:gold")
                    self.assertEqual(saved["phase"], "attention")
                    self.assertEqual(saved["reason"], LEGACY_CYCLE_REASON)
                    for field in ("pending", "progress", "owned", "daily_volume", "last_batch",
                                  "cycle_costs", "execution_quality", "execution_quality_history"):
                        self.assertEqual(saved[field], original[field])
                    self.assertEqual(self.f.store.get("pair_batch:" + BATCH_ID), batch)
                    for action in (lambda: self.engine.pairs.check_recovery("gold"),
                                   lambda: self.engine.pairs.preview_recovery("gold"),
                                   lambda: self.engine.pairs.reconcile_flat("gold"),
                                   lambda: self.engine.pairs.skip_recovery("gold", BATCH_ID, True)):
                        with self.assertRaisesRegex(TradingError, LEGACY_CYCLE_REASON):
                            action()
                shown = self.engine.pairs.states()[0]
                self.assertNotIn("cycle", shown)
                self.assertNotIn("progress", shown["state"])
                for field in ("cycle_costs", "execution_quality", "execution_quality_history"):
                    self.assertNotIn(field, shown["state"])

    def test_funds_checks_remain_independent_when_legacy_cycle_blocks_orders(self):
        state = seed_pending(self.engine)
        state["pending"]["kind"] = "cycle"
        self.f.store.put("pair_runtime:gold", state)
        pair = self.f.store.pair("gold")
        pair["ordinary"]["enabled"] = False
        pair["margin"]["enabled"] = True
        pair["enabled"] = True
        pair = self.f.store.save_pair(pair)
        with patch.object(PairTrader, "margin_tick", return_value={"blocks_trading": False}) as funds, \
             patch.object(PairTrader, "_recover", side_effect=AssertionError("no cycle recovery")):
            result = PairTrader(self.engine).tick(pair)
        funds.assert_called_once()
        self.assertEqual(result["phase"], "attention")
        self.assertEqual(result["pending"], state["pending"])

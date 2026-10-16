"""Pair ADL settings retain legacy compatibility and existing execution locks."""
from copy import deepcopy
import unittest

from tests.helpers import Fixture, account
from tests.test_pair_integration import pair_config
from trading.engine import Engine
from trading.models import TradingError
from trading.pairing import validate_pair


class AdlPairConfigTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.addCleanup(self.f.close)
        for aid in ("test", "second"):
            self.f.store.save_account({**account(aid), "enabled": False})
        self.engine = Engine(self.f.store, market=self.f.market)
        self.addCleanup(self.engine.dashboard_reports.close)

    def test_defaults_are_detached_and_explicit_null_or_extra_fields_fail(self):
        source = pair_config()
        pair = validate_pair(source)
        self.assertEqual(pair["adl"], {"enabled": True, "batch_notional": "1000"})
        self.assertNotIn("adl", source)
        pair["adl"]["enabled"] = False
        self.assertTrue(validate_pair(source)["adl"]["enabled"])
        for value in (None, [], {"enabled": "false"}, {"batch_notional": 1000}, {"force": True}):
            with self.subTest(value=value), self.assertRaises(TradingError):
                validate_pair(pair_config(adl=value))

    def test_partial_changes_and_old_clients_preserve_other_settings(self):
        original = self.engine.pairs.create(pair_config(adl={"enabled": False, "batch_notional": "000250.500"}))
        self.assertEqual(original["adl"], {"enabled": False, "batch_notional": "250.5"})
        changed = self.engine.pairs.configure("gold", {"adl": {"enabled": True}})
        self.assertEqual(changed["adl"], {"enabled": True, "batch_notional": "250.5"})
        changed = self.engine.pairs.configure("gold", {"name": "新名称"})
        self.assertEqual(changed["adl"], {"enabled": True, "batch_notional": "250.5"})
        self.assertEqual(changed["cycle"], original["cycle"])

    def test_legacy_saved_pair_projection_and_edit_do_not_require_migration(self):
        pair = self.engine.pairs.create(pair_config())
        pair.pop("adl")
        self.f.store.save_pair(pair)
        before = deepcopy(self.f.store.pair("gold"))
        projected = self.engine.pairs.states()[0]
        self.assertEqual(projected["adl"], {"enabled": True, "batch_notional": "1000"})
        self.assertEqual(self.f.store.pair("gold"), before)
        changed = self.engine.pairs.configure("gold", {"adl": {"batch_notional": "10"}})
        self.assertEqual(changed["adl"], {"enabled": True, "batch_notional": "10"})

    def test_active_blocked_and_completed_hold_cannot_mutate_frozen_config(self):
        original = self.engine.pairs.create(pair_config())
        for status, hold in (("active", True), ("blocked", True), ("completed", True)):
            with self.subTest(status=status):
                incident = {"id": "one", "pair_id": "gold", "status": status, "hold": hold,
                            "config": {"enabled": True, "batch_notional": "1000"}}
                self.f.store.put("adl_pair:gold", incident)
                with self.assertRaises(TradingError):
                    self.engine.pairs.configure("gold", {"adl": {"enabled": False}})
                self.assertEqual(self.f.store.pair("gold"), original)
                self.assertEqual(self.f.store.get("adl_pair:gold"), incident)
        self.f.store.put("adl_pair:gold", {**incident, "hold": False})
        self.assertFalse(self.engine.pairs.configure("gold", {"adl": {"enabled": False}})["adl"]["enabled"])

    def test_pending_cycle_margin_and_running_locks_apply_to_adl_settings(self):
        pair = self.engine.pairs.create(pair_config())
        for runtime, margin in (({"pending": {}}, {}),
                                ({"progress": {"quantities": {"LONG": "1"}}}, {}),
                                ({}, {"status": "unknown"}), ({}, {"pending": {}})):
            with self.subTest(runtime=runtime, margin=margin):
                self.f.store.put("pair_runtime:gold", runtime)
                self.f.store.put("pair_margin:gold", margin)
                with self.assertRaises(TradingError):
                    self.engine.pairs.configure("gold", {"adl": {"batch_notional": "50"}})
        self.f.store.put("pair_runtime:gold", {})
        self.f.store.put("pair_margin:gold", {})
        self.f.store.save_pair({**pair, "enabled": True})
        with self.assertRaises(TradingError):
            self.engine.pairs.configure("gold", {"adl": {"batch_notional": "50"}})


if __name__ == "__main__":
    unittest.main()

"""Legacy pair-opening batches are discarded at start without reconciliation."""
import unittest

from tests.pair_fixtures import BATCH_ID, PairTradingTests, seed_legacy_pending
from trading.pair_planning import LEGACY_ORDERS_REASON


class LegacyDiscardTests(PairTradingTests, unittest.TestCase):
    def seed(self):
        runtime = seed_legacy_pending(self.store)
        runtime["recovery_watch"] = {"batches": [{"id": "archived", "symbol": "XAUUSD1", "legs": []}]}
        runtime.update(phase="attention", reason=LEGACY_ORDERS_REASON, attention=LEGACY_ORDERS_REASON)
        self.store.put("pair_runtime:gold", runtime)
        return runtime

    def test_discard_keeps_positions_archives_records_and_unblocks_tick(self):
        original = self.seed()
        self.engine.pairs.discard_legacy_orders()
        runtime = self.store.get("pair_runtime:gold")
        self.assertIsNone(runtime["pending"])
        self.assertNotIn("recovery_watch", runtime)
        self.assertNotIn("attention", runtime)
        for field in ("owned", "daily_volume", "last_batch", "progress"):
            self.assertEqual(runtime[field], original[field])
        archive = self.store.get("pair_discarded_orders:gold")
        self.assertEqual(len(archive), 1)
        self.assertEqual(archive[0]["pending"]["id"], BATCH_ID)
        self.assertEqual(archive[0]["recovery_watch"], original["recovery_watch"])
        self.assertFalse(archive[0]["writer_settled"])
        self.assertTrue(any("已丢弃旧版本配对开仓遗留" in row["message"] for row in self.store.events(account_id="gold")))
        self.assertNotEqual(self.tick()["reason"], LEGACY_ORDERS_REASON)
        state = next(row["state"] for row in self.engine.pairs.states() if row["id"] == "gold")
        self.assertIsNone(state["pending"])

    def test_discard_releases_old_in_flight_phase_and_wraps_malformed_archive(self):
        seed_legacy_pending(self.store)
        self.store.put("pair_discarded_orders:gold", {"unexpected": True})
        self.engine.pairs.discard_legacy_orders()
        self.assertEqual(self.store.get("pair_runtime:gold")["phase"], "waiting")
        archive = self.store.get("pair_discarded_orders:gold")
        self.assertEqual(archive[0], {"unexpected": True})
        self.assertEqual(archive[1]["pending"]["id"], BATCH_ID)

    def test_discard_is_idempotent_and_ignores_clean_runtimes(self):
        self.store.put("pair_runtime:clean", {"phase": "paused", "pending": None})
        self.seed()
        self.engine.pairs.discard_legacy_orders()
        self.engine.pairs.discard_legacy_orders()
        self.assertEqual(len(self.store.get("pair_discarded_orders:gold")), 1)
        self.assertIsNone(self.store.get("pair_discarded_orders:clean"))
        self.assertEqual(self.store.get("pair_runtime:clean"), {"phase": "paused", "pending": None})


if __name__ == "__main__":
    unittest.main()

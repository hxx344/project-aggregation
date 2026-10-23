"""Symbol edits retain group limits and immutable, symbol-scoped history."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import tempfile
from unittest import TestCase

from tests.helpers import account
from trading.engine import Engine
from tests.pair_legacy_fixtures import empty_progress
from trading.paper import DemoMarket
from trading.store import Store


class PairSymbolHistoryTests(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.engine = Engine(self.store, market=DemoMarket())
        for side in ("long", "short"):
            self.store.save_account({**account(side), "enabled": False})
        self.pair = self.engine.pairs.create({
            "id": "gold", "name": "保留原配对组", "symbol": "XAUUSD1",
            "long_account_id": "long", "short_account_id": "short",
            "ordinary": {"enabled": True},
        })

    def test_symbol_edits_cannot_reset_group_daily_volume_or_unknown_volume(self):
        day = datetime.now(timezone.utc).date().isoformat()
        volume = {day: {"long": "3500", "short": "4500"}}
        original = {"symbol": "XAUUSD1", "pending": None, "owned": {"LONG": "0", "SHORT": "0"},
                    "progress": empty_progress(completed=7), "daily_volume": volume}
        self.store.put("pair_runtime:gold", original)
        for symbol in ("XAGUSD1", "XAUUSD1"):
            self.engine.pairs.configure("gold", {"symbol": symbol})
            state = self.store.get("pair_runtime:gold")
            self.assertEqual(state["daily_volume"], volume)

        unknown = deepcopy(state)
        unknown.update(volume_unknown=True, volume_unknown_until_utc=day)
        self.store.put("pair_runtime:gold", unknown)
        self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
        state = self.store.get("pair_runtime:gold")
        self.assertTrue(state["volume_unknown"])
        self.assertEqual(state["volume_unknown_until_utc"], day)
        self.assertEqual(state["daily_volume"], volume)


if __name__ == "__main__":
    import unittest
    unittest.main()

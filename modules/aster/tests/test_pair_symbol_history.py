"""Symbol edits retain group limits and immutable, symbol-scoped history."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import time
from unittest import TestCase

from tests.helpers import account
from tests.test_pair_cost import batch
from trading import pair_cost
from trading.engine import Engine
from trading.models import TradingError
from trading.pair_execution import PairTrader, empty_progress
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
            "cycle": {"enabled": True, "daily_volume_limit": "10000"},
        })

    def report(self, pair, now):
        with self.store.read_snapshot() as reader:
            return pair_cost.read(reader, pair, self.store.get("pair_runtime:gold", {}), now=now)

    def test_gold_silver_gold_edits_keep_receipts_and_isolate_costs(self):
        now = time.time()
        gold = batch("gold-before-edit", created=now - 60)
        silver = batch("silver-before-edit", created=now - 60, quantity="4", buy="31", sell="30")
        silver["symbol"] = silver["execution_quality"]["symbol"] = "XAGUSD1"
        for leg in silver["legs"]:
            leg["order"]["symbol"] = leg["receipt"]["symbol"] = "XAGUSD1"
        for record in (gold, silver):
            self.store.put("pair_batch:" + record["id"], record)
        original = self.report(self.pair, now)
        self.assertEqual(original["daily"]["fill_count"], 2)
        self.assertEqual(original["daily"]["spread_cost"], "2")

        switched = self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
        current = self.report(switched, now)
        self.assertEqual(current["daily"]["fill_count"], 2)
        self.assertEqual(current["daily"]["spread_cost"], "4")
        self.assertEqual(switched["id"], self.pair["id"])
        self.assertEqual(self.store.pair_for_account("long")["id"], "gold")

        returned = self.engine.pairs.configure("gold", {"symbol": "XAUUSD1"})
        self.assertEqual(self.report(returned, now), original)
        for record in (gold, silver):
            self.assertEqual(self.store.get("pair_batch:" + record["id"]), record)

    def test_symbol_edits_cannot_reset_group_daily_volume_or_unknown_volume(self):
        day = datetime.now(timezone.utc).date().isoformat()
        volume = {day: {"long": "3500", "short": "4500"}}
        original = {"symbol": "XAUUSD1", "pending": None, "owned": {"LONG": "0", "SHORT": "0"},
                    "progress": empty_progress(completed=7), "daily_volume": volume}
        self.store.put("pair_runtime:gold", original)
        for symbol in ("XAGUSD1", "XAUUSD1"):
            pair = self.engine.pairs.configure("gold", {"symbol": symbol})
            state = self.store.get("pair_runtime:gold")
            self.assertEqual(state["daily_volume"], volume)
            self.assertEqual(PairTrader._daily_remaining(pair, state), {"long": "6500", "short": "5500"})
            self.assertEqual(state["progress"]["completed_cycles"], 7)

        unknown = deepcopy(state)
        unknown.update(volume_unknown=True, volume_unknown_until_utc=day)
        self.store.put("pair_runtime:gold", unknown)
        pair = self.engine.pairs.configure("gold", {"symbol": "XAGUSD1"})
        state = self.store.get("pair_runtime:gold")
        self.assertTrue(state["volume_unknown"])
        self.assertEqual(state["volume_unknown_until_utc"], day)
        self.assertEqual(state["daily_volume"], volume)
        with self.assertRaisesRegex(TradingError, "当日剩余成交额度无法确认"):
            PairTrader._daily_remaining(pair, state)


if __name__ == "__main__":
    import unittest
    unittest.main()

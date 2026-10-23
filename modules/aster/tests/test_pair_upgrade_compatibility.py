"""HEAD-format compressed watches remain usable without new position metadata."""
from contextlib import ExitStack
from copy import deepcopy
import time
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_integration as fixtures
from tests.test_pair_order_recovery import seed_pending, receipt_for
from trading.exchange import LiveBroker
from trading.pair_execution import PairTrader
from trading.pair_recovery import _watch_evidence_key, require_archived_orders_clear


class PairUpgradeCompatibilityTests(TestCase):
    def test_head_compacted_watch_preserves_guard_start_preview_and_delete(self):
        for mode in ("paper", "live"):
            with self.subTest(mode=mode):
                fixture = (fixtures.PairSnapshotLifecycleTests() if mode == "live"
                           else fixtures.PairIntegrationTests())
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                if mode == "live":
                    self.addCleanup(fixture.tearDown)
                engine, store = fixture.engine, fixture.f.store
                state = seed_pending(engine, {"LONG": "0", "SHORT": "0"})
                pending = state["pending"]
                pair = store.pair("gold")
                _, brokers, _ = PairTrader(engine)._members(pair)
                batches = []
                for index in range(9):
                    batch = {"id": "head-legacy-" + str(index), "symbol": pair["symbol"],
                        "created_at": time.time() - 3600, "bounded_queries_complete": True,
                        "identities": deepcopy(state["identities"]),
                        "legs": [{"key": leg["key"], "order": {**leg["order"],
                            "newClientOrderId": "legacy-" + str(index) + "-" + leg["key"]}}
                            for leg in pending["legs"]]}
                    # The retired archive contains known fills, just as HEAD
                    # allows; this test does not add historical time authority.
                    journal = {**deepcopy(pending), **deepcopy(batch)}
                    for leg in journal["legs"]:
                        leg["receipt"] = receipt_for(leg, status="FILLED", qty="0.2")
                    store.put("pair_batch:" + batch["id"], journal)
                    batches.append(batch)
                watch = {"batches": batches[1:], "retired_identities": deepcopy(state["identities"]),
                         "retired_symbols": [pair["symbol"]]}
                key = _watch_evidence_key("gold", batches[0])
                archived = {"retired_batch": batches[0], "retired": True, "first_observed_at": time.time() - 121}
                store.put(key, archived)
                state.update(pending=None, phase="paused", recovery_watch=watch)
                store.put("pair_runtime:gold", state)
                ledgers = {}
                for broker in brokers.values():
                    if isinstance(broker, LiveBroker):
                        for path in ("/fapi/v3/positionRisk", "/fapi/v3/accountWithJoinMargin"):
                            rows = broker.api.responses[path]
                            for row in rows["positions"] if isinstance(rows, dict) else rows:
                                row.update(positionAmt="0", entryPrice="0")
                                row.pop("updateTime", None)
                    else:
                        for position in broker.state["positions"].values():
                            position.pop("updateTime", None)
                        broker.save()
                        ledgers[broker.account_id] = deepcopy(broker.state)
                    self.assertTrue(all(p.update_time is None for p in broker.snapshot([pair["symbol"]]).positions))
                with ExitStack() as stack:
                    for broker in brokers.values():
                        for name in ("query", "submit", "set_leverage", "set_cycle_leverage"):
                            stack.enter_context(patch.object(broker, name,
                                side_effect=AssertionError("legacy bounded watch must not resend or requery")))
                    self.assertEqual(require_archived_orders_clear(engine, pair), [])
                    engine.pairs.enable("gold", True)
                    self.assertTrue(store.pair("gold")["enabled"])
                    engine.pairs.enable("gold", False)
                    preview = engine.pairs.preview_baseline("gold")
                    self.assertEqual(preview["actual"], {"LONG": "0", "SHORT": "0"})
                    self.assertEqual(store.get("pair_runtime:gold")["recovery_watch"], watch)
                    engine.pairs.delete("gold")
                self.assertIsNone(store.pair("gold"))
                self.assertEqual(store.get("pair_deleted_watch:gold")["watch"], watch)
                self.assertEqual(store.get(key), archived)
                self.assertIsNotNone(store.get("pair_batch:head-legacy-0"))
                self.assertIsNone(store.get("pair_watch_summary:gold"))
                for aid, ledger in ledgers.items():
                    self.assertEqual(store.get("paper:" + aid), ledger)

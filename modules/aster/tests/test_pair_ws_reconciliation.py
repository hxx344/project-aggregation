"""Private order events replace only CID queries, never post-fill risk reads."""
import json
import time
from contextlib import ExitStack
from unittest import TestCase
from unittest.mock import patch

from tests import test_pair_warm_mode_recovery as warm_fixtures
from tests import test_account_stream_engine as engine_fixtures
from trading.exchange import AmbiguousOrder, ExchangeError
from trading.models import dec
from trading.user_stream import PrivateAccountStream

SYMBOL = "XAUUSD1"


class PairWsReconciliationTests(TestCase):
    live_brokers = warm_fixtures.PairWarmModeRecoveryTests.live_brokers
    setUp = warm_fixtures.PairWarmModeRecoveryTests.setUp
    warm = warm_fixtures.PairWarmModeRecoveryTests.warm
    clear_calls = warm_fixtures.PairWarmModeRecoveryTests.clear_calls
    paths = warm_fixtures.PairWarmModeRecoveryTests.paths
    ordinary_plan = warm_fixtures.PairWarmModeRecoveryTests.ordinary_plan

    def connect(self):
        with patch.object(PrivateAccountStream, "start"):
            for broker in self.brokers.values():
                broker.start_private_stream()
                broker.private_stream._set_connected(True)
                self.addCleanup(broker.stop_private_stream)

    def run_with_events(self, missing=None, partial=False, disconnect=False):
        self.connect()
        state, snapshots, guards, plan = self.ordinary_plan()
        for key, broker in self.brokers.items():
            original = broker.submit

            def submit(orders, *, timeout=None, key=key, broker=broker, original=original):
                receipt = original(orders, timeout=timeout)[0]
                order = orders[0]
                if key != missing:
                    stamp = int(time.time() * 1000)
                    event = {"e": "ORDER_TRADE_UPDATE", "E": stamp, "T": stamp,
                        "o": {"s": SYMBOL, "c": order["newClientOrderId"], "S": order["side"],
                            "ps": order["positionSide"], "o": "MARKET", "ot": "MARKET",
                            "q": order["quantity"], "i": 123 if key == "long" else 456,
                            "X": "PARTIALLY_FILLED" if partial else "FILLED", "x": "TRADE",
                            "z": str(dec(receipt["executedQty"]) / 2) if partial else receipt["executedQty"],
                            "ap": receipt["avgPrice"], "T": stamp}}
                    broker.private_stream._handle_message(json.dumps(event))
                    if disconnect:
                        broker.private_stream._set_connected(False)
                raise AmbiguousOrder("Offline POST response lost")

            patcher = patch.object(broker, "submit", side_effect=submit)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.trader._start(self.pair, state, self.brokers, snapshots, guards, plan, kind="ordinary")
        self.assertIsNone(state["pending"], state)
        self.assertTrue(state["last_batch"]["completed"])
        self.assertTrue(all(dec(qty) == plan.qty for qty in state["owned"].values()))
        for key in self.brokers:
            paths = self.paths(key)
            self.assertIn("/fapi/v3/accountWithJoinMargin", paths)
            self.assertIn("/fapi/v3/positionRisk", paths)
            self.assertEqual(sum(method == "POST" for method, _, _ in self.brokers[key].api.calls), 1)
        return state

    def order_gets(self, key):
        return sum(method == "GET" and path == "/fapi/v3/order"
                   for method, path, _ in self.brokers[key].api.calls)

    def test_terminal_events_finish_lost_http_responses_without_order_gets(self):
        self.run_with_events()
        self.assertEqual([self.order_gets(key) for key in self.brokers], [0, 0])

    def test_only_missing_side_uses_original_cid_rest(self):
        self.run_with_events(missing="short")
        self.assertEqual(self.order_gets("long"), 0)
        self.assertEqual(self.order_gets("short"), 1)

    def test_partial_events_do_not_hide_later_rest_terminal_receipts(self):
        self.run_with_events(partial=True)
        self.assertEqual([self.order_gets(key) for key in self.brokers], [1, 1])

    def test_disconnected_session_cannot_supply_old_terminal_evidence(self):
        self.run_with_events(disconnect=True)
        self.assertEqual([self.order_gets(key) for key in self.brokers], [1, 1])

    def active_event_blocks_reality(self, status):
        self.connect()
        state, snapshots, guards, plan = self.ordinary_plan()
        receipts = {}
        with ExitStack() as stack:
            stack.enter_context(patch.object(self.trader, "_recover", return_value=None))
            for key, broker in self.brokers.items():
                original = broker.submit
                def submit(orders, *, timeout=None, key=key, original=original):
                    receipts[key] = original(orders, timeout=timeout)[0]
                    raise AmbiguousOrder("offline acknowledgement lost")
                stack.enter_context(patch.object(broker, "submit", side_effect=submit))
            self.trader._start(self.pair, state, self.brokers, snapshots, guards, plan, kind="ordinary")
        pending = state["pending"]
        pending["bounded_recovery"] = {"observed_at": time.time() - 121, "stage": "positions"}
        pending["last_possible_send_at"] = time.time() - 121
        for leg in pending["legs"]:
            leg["recovery_query_attempts"] = 3
        self.trader._save(self.pair, state)
        wall = time.time()
        def publish(current_status):
            for index, leg in enumerate(pending["legs"]):
                key, order = leg["key"], leg["order"]
                qty = ("0" if current_status == "NEW" else
                       str(dec(order["quantity"]) / 2) if current_status == "PARTIALLY_FILLED" else order["quantity"])
                stamp = int(wall * 1000)
                event = {"e": "ORDER_TRADE_UPDATE", "E": stamp, "T": stamp,
                    "o": {"s": SYMBOL, "c": order["newClientOrderId"], "S": order["side"],
                        "ps": order["positionSide"], "o": "MARKET", "ot": "MARKET",
                        "q": order["quantity"], "i": 123 + index, "X": current_status, "x": "TRADE",
                        "z": qty, "ap": "0" if current_status == "NEW" else receipts[key]["avgPrice"], "T": stamp}}
                self.brokers[key].private_stream._handle_message(json.dumps(event))
        with patch("time.time", side_effect=lambda: wall), ExitStack() as stack:
            queries = [stack.enter_context(patch.object(broker, "query", side_effect=ExchangeError("not found", code=-2013)))
                       for broker in self.brokers.values()]
            publish(status)
            with patch.object(self.engine.pairs, "_read_members", side_effect=AssertionError("active event blocks adoption")), \
                    patch.object(self.trader, "_read", side_effect=AssertionError("active event blocks position completion")):
                self.trader._recover(self.pair, state, self.brokers)
            self.assertTrue(all(leg["receipt"]["status"] == status for leg in state["pending"]["legs"]))
            self.assertEqual([query.call_count for query in queries], [1, 1])
            wall += 1
            publish("FILLED")
            self.trader._recover(self.pair, state, self.brokers)
            self.assertEqual([query.call_count for query in queries], [1, 1])
        self.assertIsNone(state["pending"], state)
        self.assertTrue(state["last_batch"]["completed"])

    def test_cached_new_event_blocks_expired_unknown_adoption_until_terminal(self):
        self.active_event_blocks_reality("NEW")

    def test_cached_partial_event_blocks_expired_unknown_adoption_until_terminal(self):
        self.active_event_blocks_reality("PARTIALLY_FILLED")


class PausedTransferStreamTests(TestCase):
    setUp = engine_fixtures.AccountStreamEngineTests.setUp

    def test_paused_group_keeps_adl_stream_after_transfer_finishes_without_rest(self):
        row = self.f.store.account("test")
        row.update(enabled=False)
        self.f.store.save_account(row)
        pair = {"id": "gold", "enabled": False}
        self.f.store.put("pair_margin:gold", {"pending": {"status": "acknowledged"}})
        with patch.object(self.engine.pairs, "active_for_account", return_value=None), \
             patch.object(self.f.store, "pair_for_account", return_value=pair), \
             patch.object(self.broker, "stop_private_stream") as stop:
            self.assertEqual(self.engine.poll_private_stream("test"), 30)
            self.broker.start_private_stream.assert_called_once()
            stop.assert_not_called()
            self.assertFalse(self.f.store.account("test")["enabled"])
            self.f.store.put("pair_margin:gold", {})
            self.engine.poll_private_stream("test")
            stop.assert_not_called()
            # Paused groups still monitor ADL; only removing the binding and
            # leaving the independent account paused releases its stream.
            with patch.object(self.f.store, "pair_for_account", return_value=None):
                self.engine.poll_private_stream("test")
            stop.assert_called_once()
        self.api.call.assert_not_called()

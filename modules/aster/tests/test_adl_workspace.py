"""Restart admission preserves ADL recovery and checks the complete accounts."""
from copy import deepcopy
import unittest

from . import test_workspace


class AdlWorkspaceTests(unittest.TestCase):
    setUp = test_workspace.WorkspaceTests.setUp
    archived_pair = test_workspace.WorkspaceTests.archived_pair
    connect_archived_member = test_workspace.WorkspaceTests.connect_archived_member
    durable_state = test_workspace.WorkspaceTests.durable_state
    restart_engine = test_workspace.WorkspaceTests.restart_engine

    def incident(self):
        pair, runtime = self.archived_pair()
        runtime.pop("recovery_watch")
        self.store.put("pair_runtime:gold", runtime)
        incident = {"id": "adl-incident", "pair_id": pair["id"], "status": "active", "hold": True,
            "identities": deepcopy(runtime["identities"]),
            "accounts": {side: self.store.account(side) for side in ("long", "short")},
            "events": [{"account_id": "long", "symbol": "BTCUSDT", "order_id": "original-adl"}],
            "batches": [{"account_id": "short", "state": "sending", "sent_at": 123.0,
                "order": {"symbol": "BTCUSDT", "positionSide": "BOTH", "side": "BUY", "type": "MARKET",
                    "quantity": "0.1", "reduceOnly": "true", "newClientOrderId": "original-close"}, "receipt": None}]}
        self.store.put("adl_pair:gold", incident)
        self.store.put("adl_incident:adl-incident", incident)
        return incident

    def test_active_blocked_and_held_completed_records_allow_restart_without_querying_orders(self):
        original = self.incident()
        for status in ("active", "blocked", "completed"):
            with self.subTest(status=status):
                incident = {**original, "status": status}
                self.store.put("adl_pair:gold", incident)
                self.requests.clear()
                before = self.durable_state()
                result = self.engine.workspace.update_status()
                self.assertFalse(result["busy"], result)
                self.assertEqual(result["checkedAccounts"], 2)
                self.assertEqual(self.durable_state(), before)
                self.assertCountEqual([(side, request.method, request.url.path, request.url.params.get("symbol"))
                    for side, request in self.requests],
                    [(side, "GET", "/fapi/v3/openOrders", None) for side in ("long", "short")])

    def test_restored_sending_record_survives_update_admission_unchanged(self):
        original = self.incident()
        reopened, restarted = self.restart_engine()
        for side in ("long", "short"):
            self.connect_archived_member(restarted, side)
        self.requests.clear()
        result = restarted.workspace.update_status()
        self.assertFalse(result["busy"], result)
        self.assertEqual(reopened.get("adl_pair:gold"), original)
        self.assertEqual(reopened.get("adl_incident:adl-incident"), original)
        self.assertTrue(all(request.url.path == "/fapi/v3/openOrders" for _, request in self.requests))

    def test_identity_binding_and_recoverable_order_keys_are_required_before_http(self):
        original = self.incident()
        mutations = (
            lambda state: state.update(pair_id="different-pair"),
            lambda state: state["identities"]["long"].update(user="different-user"),
            lambda state: state["accounts"]["long"].update(env_prefix="DIFFERENT_PREFIX"),
            lambda state: state["accounts"].pop("short"),
            lambda state: state.update(hold="true"),
            lambda state: state.update(status="unknown"),
            lambda state: state["events"][0].update(account_id="other-account"),
            lambda state: state["batches"][0].update(account_id="other-account"),
            lambda state: state["batches"][0].update(state="missing"),
            lambda state: state["batches"][0]["order"].pop("newClientOrderId"),
            lambda state: state["batches"][0]["order"].update(quantity="0"),
            lambda state: state["batches"][0].pop("sent_at"),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                state = deepcopy(original)
                mutate(state)
                self.store.put("adl_pair:gold", state)
                self.requests.clear()
                result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"], result)
                self.assertEqual(self.requests, [])
                self.assertEqual(self.store.get("adl_pair:gold"), state)

    def test_only_released_completed_history_can_outlive_its_pair_or_credentials(self):
        original = self.incident()
        self.store.put("adl_pair:gold", {**original, "status": "completed", "hold": False})
        self.store.put("adl_pair:retired-pair", {"status": "completed", "hold": False})
        self.credentials["ASTER_LONG"]["user"] = "replacement-user"
        self.engine.brokers["long"].api.credentials = deepcopy(self.credentials["ASTER_LONG"])
        self.assertFalse(self.engine.workspace.update_status()["busy"])
        self.store.put("adl_pair:retired-pair", {"status": "completed", "hold": True})
        self.requests.clear()
        result = self.engine.workspace.update_status()
        self.assertTrue(result["busy"])
        self.assertIn("不存在", result["reason"])
        self.assertEqual(self.requests, [])

    def test_prior_order_keys_are_required_and_unknown_resolution_remains_recoverable(self):
        original = self.incident()
        prior = deepcopy(original["batches"][0])
        prior.update(account_id="long", resolution="positions_verified_unknown", resolved_at=300.0, queries=3)
        prior["order"]["newClientOrderId"] = "prior-original-order"
        original.update(status="completed", prior_orders=[prior])
        self.assertIsNone(self.store.get("pair_runtime:gold").get("pending"))
        mutations = (
            lambda state: state["prior_orders"][0].update(account_id="other-account"),
            lambda state: state["prior_orders"][0]["order"].pop("newClientOrderId"),
            lambda state: state["prior_orders"][0].update(state="unknown"),
            lambda state: state["prior_orders"][0].pop("sent_at"),
            lambda state: state.update(prior_orders=None),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                state = deepcopy(original)
                mutate(state)
                self.store.put("adl_pair:gold", state)
                self.requests.clear()
                result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"], result)
                self.assertEqual(self.requests, [])
                self.assertEqual(self.store.get("adl_pair:gold"), state)
        self.store.put("adl_pair:gold", original)
        self.requests.clear()
        before = self.durable_state()
        result = self.engine.workspace.update_status()
        self.assertFalse(result["busy"], result)
        self.assertEqual(self.durable_state(), before)
        self.assertEqual(self.store.get("adl_pair:gold")["prior_orders"][0]["state"], "sending")
        self.assertCountEqual([(side, request.method, request.url.path)
            for side, request in self.requests],
            [(side, "GET", "/fapi/v3/openOrders") for side in ("long", "short")])

    def test_fresh_complete_open_orders_still_required_for_both_accounts(self):
        self.incident()
        for inventory in ([{"symbol": "ETHUSDT"}], {"orders": []}):
            with self.subTest(inventory=inventory):
                self.inventories["long"] = inventory
                result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"])
        self.inventories.clear()
        self.assertFalse(self.engine.workspace.update_status()["busy"])

    def test_adl_record_created_or_changed_during_inventory_read_invalidates_admission(self):
        original = self.incident()
        for initial in (None, original):
            with self.subTest(initial=initial):
                if initial is None:
                    with self.store.connect() as db:
                        db.execute("DELETE FROM kv WHERE key='adl_pair:gold'")
                else:
                    self.store.put("adl_pair:gold", original)
                def change(side, request):
                    if side == "short":
                        self.store.put("adl_pair:gold", {**original, "status": "blocked"})
                self.before_response = change
                result = self.engine.workspace.update_status()
                self.assertTrue(result["busy"], result)
                self.assertIn("发生变化", result["reason"])
        self.before_response = lambda side, request: None


if __name__ == "__main__":
    unittest.main()

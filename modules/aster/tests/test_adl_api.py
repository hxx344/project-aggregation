"""ADL settings and report HTTP contract at the existing authentication boundary."""
from copy import deepcopy
import unittest
from unittest.mock import patch

from tests.test_adl_notifications import incident
from tests import test_pair_api as pair_api_cases
from tests.test_pair_integration import pair_config


class AdlApiTests(unittest.TestCase):
    setUp = pair_api_cases.PairApiTests.setUp
    login = pair_api_cases.PairApiTests.login

    def test_report_requires_login_and_returns_friendly_missing_states(self):
        self.addCleanup(self.engine.dashboard_reports.close)
        self.assertEqual(self.client.get("/api/pairs/gold/adl-report").status_code, 401)
        self.login()
        self.assertEqual(self.client.get("/api/pairs/gold/adl-report").status_code, 404)
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 200)
        response = self.client.get("/api/pairs/gold/adl-report")
        self.assertEqual(response.status_code, 404)
        self.assertIn("暂无 ADL", response.text)

    def test_create_edit_strict_nested_values_and_origin(self):
        self.addCleanup(self.engine.dashboard_reports.close)
        self.login()
        for adl in (None, {}, [], {"enabled": "false"}, {"enabled": 0}, {"enabled": None},
                    {"batch_notional": 25}, {"batch_notional": None}, {"extra": 1}):
            with self.subTest(adl=adl):
                response = self.client.post("/api/pairs", json=pair_config(adl=adl))
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 200)
        response = self.client.patch("/api/pairs/gold", json={"adl": {"enabled": False, "batch_notional": "25.5"}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["pair"]["adl"], {"enabled": False, "batch_notional": "25.5"})
        self.assertEqual(self.client.get("/api/pairs").json()["pairs"][0]["adl"], response.json()["pair"]["adl"])
        self.assertEqual(self.client.patch("/api/pairs/gold", json={"adl": {"enabled": True}},
                                          headers={"origin": "https://other.invalid"}).status_code, 403)
        for amount in ("0", "1000001", "1e3", "１２", "-1", "NaN"):
            with self.subTest(amount=amount):
                self.assertEqual(self.client.patch("/api/pairs/gold", json={"adl": {"batch_notional": amount}}).status_code, 409)

    def test_report_get_is_read_only_and_does_not_publish_internal_state(self):
        self.addCleanup(self.engine.dashboard_reports.close)
        self.login()
        self.assertEqual(self.client.post("/api/pairs", json=pair_config()).status_code, 200)
        item = {**incident(), "pair_id": "gold", "hold": True, "accounts": {"private": "hidden-account"},
                "identities": {"private": "hidden-identity"}, "frozen_runtime": {"private": "hidden-runtime"}}
        self.f.store.put("adl_pair:gold", item)
        original = deepcopy(item)
        with patch.object(self.engine, "broker", side_effect=AssertionError("report must not read exchange")), \
             patch.object(self.engine.adl, "tick", side_effect=AssertionError("report must not advance incident")):
            response = self.client.get("/api/pairs/gold/adl-report")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(set(response.json()), {"pair_id", "incident_id", "status", "generated_at", "messages"})
        self.assertEqual(response.json()["incident_id"], item["id"])
        self.assertIn("最终残差：0", "\n".join(response.json()["messages"]))
        for private in ("hidden-account", "hidden-identity", "hidden-runtime"):
            self.assertNotIn(private, response.text)
        self.assertEqual(self.f.store.get("adl_pair:gold"), original)
        self.assertEqual(self.client.get("/api/pairs/other/adl-report").status_code, 404)


if __name__ == "__main__":
    unittest.main()

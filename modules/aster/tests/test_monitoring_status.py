import math
import unittest

from trading.monitoring_status import compute_freshness, compute_symbol_view


class MonitoringStatusTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.25
        self.symbol = {"monitor_enabled": True}
        self.row = {"status": "TRADING", "checked_at": 999, "brackets_checked_at": 998}
        self.catalog = {"initialized": True, "checked_at": 997, "stale_seconds": 180}

    def view(self, **options):
        return compute_symbol_view(self.symbol, self.row, self.catalog, self.now, **options)

    def test_source_clocks_and_boundaries(self):
        self.assertEqual(self.view()["monitor_status"], "active")
        self.assertEqual(self.view()["freshness"]["timestamp"], 997)
        for age, expected in ((89.99, "fresh"), (90, "aging"), (179.99, "aging"), (180, "stale")):
            with self.subTest(age=age):
                self.assertEqual(compute_freshness(self.now - age, self.now)["status"], expected)
        for key in ("checked_at", "brackets_checked_at"):
            old = self.row[key]
            self.row[key] = self.now - 180
            self.assertEqual(self.view()["monitor_status"], "stale")
            self.assertFalse(self.view()["data_available"])
            self.row[key] = old

    def test_invalid_and_future_clocks_do_not_become_fresh(self):
        for stamp in (None, True, "999", 0, -1, math.nan, math.inf, self.now + 1.01):
            with self.subTest(stamp=stamp):
                self.assertEqual(compute_freshness(stamp, self.now)["status"], "stale")
        self.assertEqual(compute_freshness(self.now + 1, self.now)["age_seconds"], 0)
        self.assertEqual(compute_freshness(999, math.nan)["status"], "stale")

    def test_catalog_requirement_and_missing_data(self):
        self.catalog["checked_at"] = 1
        self.assertEqual(self.view()["monitor_status"], "stale")
        self.catalog.update(discovery_enabled=False, error="catalog offline")
        self.assertEqual(self.view()["monitor_status"], "active")
        self.row.pop("brackets_checked_at")
        self.assertEqual(self.view()["monitor_status"], "stale")
        self.assertEqual(compute_symbol_view(self.symbol, None, self.catalog, self.now)["monitor_status"], "stale")

    def test_status_priority_and_sampling_pause(self):
        self.row.update(error="sample failed", status="CLOSE", checked_at=1)
        self.assertEqual(self.view()["monitor_status"], "error")
        self.assertEqual(self.view(monitoring_enabled=False)["monitor_status"], "paused")
        self.assertEqual(self.view(demo=True)["monitor_status"], "paused")
        self.symbol["monitor_enabled"] = False
        self.assertEqual(self.view()["monitor_status"], "paused")
        self.symbol["monitor_enabled"] = True
        self.row["error"] = None
        self.assertEqual(self.view()["monitor_status"], "unavailable")


if __name__ == "__main__":
    unittest.main()

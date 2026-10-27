import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

import httpx

from app.greeks_live import GreeksLiveClient, GreeksLiveError, SabrCache, main, parse_utc, utc_iso

HEADER = "query_time,source_time,asset,expiry,t,forward,alpha,rho,nu,c0,cd,cw,kp,kc,model_mode,rmse,n_strikes,surface_confidence"
START = parse_utc("2026-05-01T00:00:00Z")
KEY = "test-key-not-real"


def csv_body(points, expiries=("2MAY26", "29MAY26")):
    lines = [HEADER]
    for point in points:
        for index, expiry in enumerate(expiries):
            lines.append(f"{utc_iso(point)},{utc_iso(point - 600)},BTC,{expiry},{0.01 * (index + 1)},95000,0.5,-0.1,1.2,0.01,0.02,0.03,0.4,0.6,wv4_7p,0.002,18,high")
    return "\n".join(lines) + "\n"


def grid_points(request):
    params = parse_qs(request.url.query.decode())
    first, last = parse_utc(params["start_time"][0]), parse_utc(params["end_time"][0])
    step = {"1m": 60, "1h": 3600, "1d": 86400}[params["interval"][0]]
    return list(range(first, last + 1, step))


class Upstream:
    def __init__(self, responder=None):
        self.requests = []
        self.responder = responder or (lambda request: httpx.Response(200, text=csv_body(grid_points(request))))

    def __call__(self, request):
        self.requests.append(request)
        return self.responder(request)


class Clock:
    def __init__(self, now):
        self.now = now
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class SabrCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "cache.sqlite3"
        self.clock = Clock(START + 30 * 86400)
        self.upstream = Upstream()
        self.caches = []

    def tearDown(self):
        for cache in self.caches:
            cache.close()
        self.directory.cleanup()

    def cache(self, **options):
        client = GreeksLiveClient(KEY, "https://example.test", transport=httpx.MockTransport(self.upstream), sleep=self.clock.sleep)
        cache = SabrCache(self.path, client, clock=self.clock, sleep=self.clock.sleep, **options)
        self.caches.append(cache)
        return cache

    def test_fetches_each_grid_bucket_once_and_reads_aligned_rows(self):
        cache = self.cache()
        result = cache.sync(START + 1, START + 5 * 3600, "1h")
        self.assertEqual((result.buckets, result.cached, result.fetched, result.requests), (5, 0, 5, 1))
        params = parse_qs(self.upstream.requests[0].url.query.decode())
        self.assertEqual(params, {"asset": ["BTC"], "start_time": [utc_iso(START + 3600)], "end_time": [utc_iso(START + 5 * 3600)], "interval": ["1h"]})
        self.assertEqual(self.upstream.requests[0].headers["x-api-key"], KEY)
        self.assertNotIn(KEY, str(self.upstream.requests[0].url))

        rows = cache.surfaces(START, START + 6 * 3600, "1h")
        self.assertEqual([grid_points(request) for request in self.upstream.requests[1:]], [[START], [START + 6 * 3600]])
        self.assertEqual([(row["query_time"], row["expiry"]) for row in rows[:2]], [(START, "2MAY26"), (START, "29MAY26")])
        self.assertEqual(len(rows), 14)
        self.assertEqual(rows[0]["n_strikes"], 18)
        self.assertEqual(rows[0]["source_time"], START - 600)

        self.assertEqual(self.cache().sync(START, START + 6 * 3600, "1h").requests, 0)
        self.assertEqual(len(cache.surfaces(START, START + 6 * 3600, "4h")), 4)

    def test_recent_buckets_stay_provisional_and_are_replaced(self):
        self.clock.now = START + 2 * 3600
        cache = self.cache(settle_seconds=6 * 3600, refresh_seconds=900)
        cache.sync(START, START + 2 * 3600, "1h")
        self.upstream.responder = lambda request: httpx.Response(200, text=csv_body(grid_points(request), expiries=("3MAY26",)))
        self.clock.now += 600
        self.assertEqual(cache.sync(START, START + 2 * 3600, "1h").requests, 0)
        self.clock.now += 600
        self.assertEqual(cache.sync(START, START + 2 * 3600, "1h").fetched, 3)
        self.assertEqual({row["expiry"] for row in cache.surfaces(START, START + 2 * 3600, "1h", refresh=False)}, {"3MAY26"})
        self.clock.now = START + 8 * 3600
        cache.sync(START, START + 2 * 3600, "1h")
        self.clock.now += 3600
        self.assertEqual(cache.sync(START, START + 2 * 3600, "1h").requests, 0)
        self.assertEqual(cache.status()["provisional"], 0)

    def test_future_buckets_are_never_requested(self):
        self.clock.now = START + 3600 + 59
        result = self.cache().sync(START, START + 10 * 3600, "1h")
        self.assertEqual(result.buckets, 2)
        self.assertEqual(parse_qs(self.upstream.requests[0].url.query.decode())["end_time"], [utc_iso(START + 3600)])

    def test_splits_requests_at_ten_thousand_buckets(self):
        result = self.cache().sync(START, START + 10_000 * 60, "1m")
        self.assertEqual((result.buckets, result.requests), (10_001, 2))
        self.assertEqual(len(grid_points(self.upstream.requests[0])), 10_000)
        self.assertEqual(grid_points(self.upstream.requests[1]), [START + 10_000 * 60])

    def test_only_missing_runs_are_requested(self):
        cache = self.cache()
        cache.sync(START + 2 * 3600, START + 3 * 3600, "1h")
        cache.sync(START, START + 5 * 3600, "1h")
        self.assertEqual([grid_points(request) for request in self.upstream.requests[1:]],
                         [[START, START + 3600], [START + 4 * 3600, START + 5 * 3600]])

    def test_empty_upstream_buckets_are_covered(self):
        self.upstream.responder = lambda request: httpx.Response(404, json={"detail": "No SABR surface data found"})
        cache = self.cache()
        cache.sync(START, START + 3600, "1h")
        self.assertEqual(cache.sync(START, START + 3600, "1h").requests, 0)
        self.assertEqual(cache.surfaces(START, START + 3600, "1h", refresh=False), [])
        self.assertEqual(cache.status()["empty"], 2)

    def test_local_hourly_budget_survives_restart_and_keeps_progress(self):
        self.clock.now = START + 30 * 86400 + 10
        cache = self.cache(hourly_budget=2)
        with self.assertRaises(GreeksLiveError) as raised:
            cache.sync(START, START + 20_000 * 60, "1m")
        self.assertEqual(raised.exception.kind, "quota")
        self.assertEqual(len(self.upstream.requests), 2)
        restarted = self.cache(hourly_budget=2)
        self.assertEqual(restarted.status()["buckets"], 20_000)
        with self.assertRaises(GreeksLiveError):
            restarted.sync(START, START + 20_000 * 60, "1m")
        self.assertEqual(len(self.upstream.requests), 2)
        self.clock.now += 3600
        self.assertEqual(restarted.sync(START, START + 20_000 * 60, "1m").fetched, 1)

    def test_upstream_429_pause_is_shared_and_wait_resumes(self):
        calls = []

        def responder(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(429, headers={"Retry-After": "120"}, json={"detail": "API hourly quota exceeded"})
            return httpx.Response(200, text=csv_body(grid_points(request)))

        self.upstream.responder = responder
        with self.assertRaises(GreeksLiveError) as raised:
            self.cache().sync(START, START + 3600, "1h")
        self.assertEqual((raised.exception.kind, raised.exception.status), ("quota", 429))
        self.assertIn("API hourly quota exceeded", str(raised.exception))
        with self.assertRaises(GreeksLiveError):
            self.cache().sync(START, START + 3600, "1h")
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.cache().sync(START, START + 3600, "1h", wait=True).fetched, 2)
        self.assertEqual(self.clock.sleeps, [121.0])

    def test_failures_are_classified_without_storing_rows(self):
        cases = [
            (lambda request: httpx.Response(401, json={"detail": "Invalid API key"}), "auth", "Invalid API key", 1),
            (lambda request: httpx.Response(400, json={"detail": "too many buckets"}), "request", "too many buckets", 1),
            (lambda request: httpx.Response(503, text="<html>secret page</html>"), "upstream", "non-JSON error body", 3),
            (lambda request: httpx.Response(200, text=csv_body([START + 7200])), "format", "outside the requested grid", 1),
            (lambda request: httpx.Response(200, text=HEADER.replace(",alpha", "") + "\n"), "format", "lacks columns: alpha", 1),
        ]
        for responder, kind, message, attempts in cases:
            with self.subTest(kind=kind, message=message):
                self.upstream = Upstream(responder)
                with self.assertRaises(GreeksLiveError) as raised:
                    self.cache().sync(START, START + 3600, "1h")
                self.assertEqual(raised.exception.kind, kind)
                self.assertIn(message, str(raised.exception))
                self.assertNotIn("secret page", str(raised.exception))
                self.assertEqual(len(self.upstream.requests), attempts)
                self.assertEqual(self.caches[-1].status()["buckets"], 0)

    def test_transient_failures_retry_with_bounded_backoff(self):
        attempts = []

        def flaky(request):
            attempts.append(request)
            if len(attempts) == 1:
                raise httpx.ConnectError("refused", request=request)
            if len(attempts) == 2:
                return httpx.Response(503, json={"detail": "busy"})
            return httpx.Response(200, text=csv_body(grid_points(request)))

        self.upstream.responder = flaky
        self.assertEqual(self.cache().sync(START, START + 3600, "1h").requests, 3)
        self.assertEqual(self.clock.sleeps, [2.0, 6.0])

        def down(request):
            raise httpx.ReadTimeout("slow", request=request)

        self.upstream = Upstream(down)
        with self.assertRaises(GreeksLiveError) as raised:
            self.cache().sync(START + 2 * 3600, START + 2 * 3600, "1h")
        self.assertEqual((raised.exception.kind, len(self.upstream.requests)), ("network", 3))

    def test_missing_key_only_fails_when_a_fetch_is_needed(self):
        with self.assertRaises(GreeksLiveError) as raised:
            GreeksLiveClient("")
        self.assertEqual(raised.exception.kind, "config")
        self.cache().sync(START, START + 3600, "1h")
        offline = SabrCache(self.path, None, clock=self.clock)
        self.caches.append(offline)
        self.assertEqual(len(offline.surfaces(START, START + 3600, "1h")), 4)
        with self.assertRaises(GreeksLiveError) as raised:
            offline.sync(START, START + 2 * 3600, "1h")
        self.assertEqual(raised.exception.kind, "config")

    def test_cli_reports_missing_key_without_traceback(self):
        from unittest.mock import patch
        from app.config import Settings

        settings = Settings(_env_file=None, greeks_live_api_key="", state_file=str(Path(self.directory.name) / "engine_state.json"))
        with patch("app.config.get_settings", return_value=settings), patch("sys.stderr") as stderr:
            self.assertEqual(main(["sync", "--start", "2026-05-01", "--end", "2026-05-01T01:00:00Z"]), 2)
        self.assertIn("GREEKS_LIVE_API_KEY", "".join(call.args[0] for call in stderr.write.call_args_list))
        self.assertTrue((Path(self.directory.name) / "greeks_live_cache.sqlite3").exists())


if __name__ == "__main__":
    unittest.main()

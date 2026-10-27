"""Greeks.live BTC SABR/WV4 surfaces with a local SQLite cache for backtests.

Buckets live on an epoch-aligned interval grid and are fetched once. A bucket
younger than settle_seconds at fetch time stays provisional, because the
upstream as-of lookup may still gain late source rows, and is refetched after
refresh_seconds. Requests are counted per UTC hour in the database so that
separate processes and restarts share the same budget and 429 pause.
"""
import argparse
import csv
import io
import json
import math
import sqlite3
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx

DEFAULT_BASE_URL = "https://backtest.glvs.ai"
SABR_PATH = "/api/v1/sabr.csv"
INTERVALS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400}
MAX_BUCKETS = 10_000
FLOAT_FIELDS = ("t", "forward", "alpha", "rho", "nu", "c0", "cd", "cw", "kp", "kc", "rmse")
COLUMNS = ("query_time", "expiry", "source_time", *FLOAT_FIELDS, "model_mode", "n_strikes", "surface_confidence")
RETRY_DELAYS = (2.0, 6.0)
ERROR_BODY_LIMIT = 4096
SCHEMA = """
CREATE TABLE IF NOT EXISTS sabr (
  query_time INTEGER NOT NULL, expiry TEXT NOT NULL, source_time INTEGER NOT NULL,
  t REAL, forward REAL, alpha REAL, rho REAL, nu REAL, c0 REAL, cd REAL, cw REAL, kp REAL, kc REAL, rmse REAL,
  model_mode TEXT, n_strikes INTEGER, surface_confidence TEXT,
  PRIMARY KEY (query_time, expiry)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sabr_coverage (query_time INTEGER PRIMARY KEY, fetched_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS api_requests (requested_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS api_state (key TEXT PRIMARY KEY, value REAL NOT NULL);
"""


class GreeksLiveError(RuntimeError):
    def __init__(self, kind: str, message: str, status: int | None = None, retry_after: float | None = None, retry_at: float | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after
        self.retry_at = retry_at


@dataclass(frozen=True)
class SyncResult:
    buckets: int
    cached: int
    fetched: int
    requests: int


def utc_iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: str) -> int:
    text = value.strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def _number(value):
    if value is None or not value.strip():
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _json_detail(response: httpx.Response):
    try:
        return json.loads(response.content[:ERROR_BODY_LIMIT].decode("utf-8", "replace")).get("detail")
    except (ValueError, AttributeError):
        raise ValueError("non-JSON error body") from None


def _error_detail(response: httpx.Response) -> str:
    try:
        detail = _json_detail(response)
    except ValueError:
        return "non-JSON error body"
    if detail is None:
        return "no detail"
    return (detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=False))[:200]


def _response_error(response: httpx.Response) -> GreeksLiveError:
    status = response.status_code
    kind = "auth" if status in (401, 403) else "quota" if status == 429 else "request" if status == 400 else "upstream"
    retry_after = None
    if status == 429:
        try:
            retry_after = float(response.headers.get("retry-after", ""))
            retry_after = min(max(0.0, retry_after), 3600.0) if math.isfinite(retry_after) else None
        except ValueError:
            retry_after = None
    return GreeksLiveError(kind, f"Greeks.live HTTP {status}: {_error_detail(response)}", status, retry_after)


def _upstream_has_no_data(response: httpx.Response) -> bool:
    # Only the API's own JSON 404 means "no surface in the grid"; a gateway page or
    # the framework's unknown-route "Not Found" (wrong base URL) must not cache empty buckets.
    try:
        detail = _json_detail(response)
    except ValueError:
        return False
    return isinstance(detail, str) and detail.strip() not in ("", "Not Found")


def _sabr_rows(response: httpx.Response) -> list[dict]:
    if response.status_code == 404 and _upstream_has_no_data(response):
        return []
    if response.status_code != 200:
        raise _response_error(response)
    reader = csv.DictReader(io.StringIO(response.text))
    if reader.fieldnames is None:
        raise GreeksLiveError("format", "Greeks.live returned an empty SABR response")
    missing = {"query_time", "source_time", "expiry", *FLOAT_FIELDS} - set(reader.fieldnames)
    if missing:
        raise GreeksLiveError("format", f"Greeks.live SABR CSV lacks columns: {', '.join(sorted(missing))}")
    rows = []
    for record in reader:
        try:
            if None in record or None in record.values() or record.get("asset", "BTC") not in ("", "BTC") or not record["expiry"]:
                raise ValueError
            row = {"query_time": parse_utc(record["query_time"]), "source_time": parse_utc(record["source_time"]), "expiry": record["expiry"],
                   **{field: _number(record[field]) for field in FLOAT_FIELDS},
                   "model_mode": record.get("model_mode") or None, "surface_confidence": record.get("surface_confidence") or None,
                   "n_strikes": int(float(record["n_strikes"])) if (record.get("n_strikes") or "").strip() else None}
        except (ValueError, TypeError):
            raise GreeksLiveError("format", f"Greeks.live SABR CSV has an unreadable row at line {reader.line_num}") from None
        rows.append(row)
    return rows


class GreeksLiveClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL, *, timeout: float = 60.0,
                 transport: httpx.BaseTransport | None = None, sleep: Callable[[float], None] = time.sleep):
        if not api_key:
            raise GreeksLiveError("config", "GREEKS_LIVE_API_KEY is not configured")
        self._http = httpx.Client(base_url=base_url, headers={"X-API-Key": api_key}, timeout=httpx.Timeout(timeout, connect=10.0),
                                  transport=transport, follow_redirects=False)
        self._sleep = sleep

    def close(self):
        self._http.close()

    def fetch_sabr(self, start: int, end: int, interval: str, on_attempt: Callable[[], None] = lambda: None) -> list[dict]:
        """Network failures and HTTP 503 are retried twice; every attempt is counted by on_attempt first."""
        params = {"asset": "BTC", "start_time": utc_iso(start), "end_time": utc_iso(end), "interval": interval}
        for attempt in range(len(RETRY_DELAYS) + 1):
            on_attempt()
            retry = attempt < len(RETRY_DELAYS)
            try:
                response = self._http.get(SABR_PATH, params=params)
            except httpx.RequestError as exc:
                if retry:
                    self._sleep(RETRY_DELAYS[attempt])
                    continue
                raise GreeksLiveError("network", f"Greeks.live request failed: {type(exc).__name__}") from exc
            if response.status_code == 503 and retry:
                self._sleep(RETRY_DELAYS[attempt])
                continue
            return _sabr_rows(response)
        raise AssertionError("unreachable")


def _runs(pending: list[int], step: int) -> list[list[int]]:
    runs, current = [], []
    for point in pending:
        if current and (point - current[-1] != step or len(current) == MAX_BUCKETS):
            runs.append(current)
            current = []
        current.append(point)
    if current:
        runs.append(current)
    return runs


class SabrCache:
    def __init__(self, path: str | Path, client: GreeksLiveClient | None = None, *, settle_seconds: int = 6 * 3600,
                 refresh_seconds: int = 900, hourly_budget: int = 55, clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, timeout=30)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._client = client
        self.settle_seconds = settle_seconds
        self.refresh_seconds = refresh_seconds
        self.hourly_budget = hourly_budget
        self._clock = clock
        self._sleep = sleep

    def close(self):
        if self._client is not None:
            self._client.close()
        self._db.close()

    def grid(self, start: int, end: int, interval: str) -> range:
        if interval not in INTERVALS:
            raise ValueError(f"Unsupported interval {interval!r}; use one of {', '.join(INTERVALS)}")
        step = INTERVALS[interval]
        end = min(end, int(self._clock()))
        return range(-(-start // step) * step, end - end % step + 1, step)

    def _pending(self, points: range) -> list[int]:
        if not points:
            return []
        now = self._clock()
        fetched = dict(self._db.execute("SELECT query_time, fetched_at FROM sabr_coverage WHERE query_time BETWEEN ? AND ?", (points[0], points[-1])))
        return [point for point in points if point not in fetched
                or (fetched[point] < point + self.settle_seconds and now >= fetched[point] + self.refresh_seconds)]

    def _reserve(self):
        now = self._clock()
        hour = now - now % 3600
        with self._db:
            self._db.execute("BEGIN IMMEDIATE")
            paused = self._db.execute("SELECT value FROM api_state WHERE key = 'retry_not_before'").fetchone()
            if paused and paused[0] > now:
                raise GreeksLiveError("quota", f"Greeks.live quota paused until {utc_iso(paused[0])}", 429, retry_at=paused[0])
            self._db.execute("DELETE FROM api_requests WHERE requested_at < ?", (hour - 3600,))
            used = self._db.execute("SELECT COUNT(*) FROM api_requests WHERE requested_at >= ?", (hour,)).fetchone()[0]
            if used >= self.hourly_budget:
                raise GreeksLiveError("quota", f"Local budget of {self.hourly_budget} requests this UTC hour is used; resumes {utc_iso(hour + 3600)}",
                                      retry_at=hour + 3600)
            self._db.execute("INSERT INTO api_requests (requested_at) VALUES (?)", (now,))

    def _pause(self, error: GreeksLiveError) -> GreeksLiveError:
        if error.retry_at is not None:
            return error
        now = self._clock()
        until = now + error.retry_after if error.retry_after is not None else now - now % 3600 + 3600
        with self._db:
            self._db.execute("INSERT OR REPLACE INTO api_state (key, value) VALUES ('retry_not_before', ?)", (until,))
        return GreeksLiveError("quota", f"{error} (paused until {utc_iso(until)})", error.status, retry_at=until)

    def _store(self, run: list[int], rows: list[dict]):
        wanted = set(run)
        stray = next((row for row in rows if row["query_time"] not in wanted), None)
        if stray is not None:
            raise GreeksLiveError("format", f"Greeks.live returned query_time {utc_iso(stray['query_time'])} outside the requested grid")
        fetched_at = int(self._clock())
        returned = {row["query_time"] for row in rows}
        # A bucket that once had a surface cannot lose it under as-of lookup; keep the old
        # rows and leave the bucket provisional instead of finalizing a degraded empty answer.
        kept = {point for (point,) in self._db.execute("SELECT DISTINCT query_time FROM sabr WHERE query_time BETWEEN ? AND ?", (run[0], run[-1]))
                if point in wanted and point not in returned}
        with self._db:
            self._db.executemany("DELETE FROM sabr WHERE query_time = ?", ((point,) for point in run if point not in kept))
            self._db.executemany(f"INSERT OR REPLACE INTO sabr ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
                                 (tuple(row[column] for column in COLUMNS) for row in rows))
            self._db.executemany("INSERT OR REPLACE INTO sabr_coverage (query_time, fetched_at) VALUES (?, ?)",
                                 ((point, fetched_at) for point in run if point not in kept))

    def sync(self, start: int, end: int, interval: str = "1h", *, wait: bool = False) -> SyncResult:
        """Fetch missing buckets; each request's rows are committed before the next, so a stopped sync resumes."""
        points = self.grid(start, end, interval)
        pending = self._pending(points)
        if not pending:
            return SyncResult(len(points), len(points), 0, 0)
        client = self._client
        if client is None:
            raise GreeksLiveError("config", "GREEKS_LIVE_API_KEY is not configured")
        requests = 0

        def attempt():
            nonlocal requests
            self._reserve()
            requests += 1

        for run in _runs(pending, INTERVALS[interval]):
            while True:
                try:
                    rows = client.fetch_sabr(run[0], run[-1], interval, on_attempt=attempt)
                    break
                except GreeksLiveError as error:
                    if error.kind != "quota":
                        raise
                    error = self._pause(error)
                    if not wait:
                        raise error from None
                    self._sleep(max(0.0, (error.retry_at or 0.0) - self._clock()) + 1)
            self._store(run, rows)
        return SyncResult(len(points), len(points) - len(pending), len(pending), requests)

    def surfaces(self, start: int, end: int, interval: str = "1h", *, refresh: bool = True, wait: bool = False) -> list[dict]:
        """Rows ordered by query_time then tenor. Grid buckets with no surface in the upstream 7-day as-of window have no rows."""
        if refresh:
            self.sync(start, end, interval, wait=wait)
        points = self.grid(start, end, interval)
        if not points:
            return []
        cursor = self._db.execute(f"SELECT {', '.join(COLUMNS)} FROM sabr WHERE query_time BETWEEN ? AND ? AND query_time % ? = 0 ORDER BY query_time, t, expiry",
                                  (points[0], points[-1], INTERVALS[interval]))
        return [dict(zip(COLUMNS, row)) for row in cursor]

    def status(self) -> dict:
        now = self._clock()
        buckets, first, last = self._db.execute("SELECT COUNT(*), MIN(query_time), MAX(query_time) FROM sabr_coverage").fetchone()
        provisional = self._db.execute("SELECT COUNT(*) FROM sabr_coverage WHERE fetched_at < query_time + ?", (self.settle_seconds,)).fetchone()[0]
        empty = self._db.execute("SELECT COUNT(*) FROM sabr_coverage WHERE query_time NOT IN (SELECT query_time FROM sabr)").fetchone()[0]
        rows = self._db.execute("SELECT COUNT(*) FROM sabr").fetchone()[0]
        used = self._db.execute("SELECT COUNT(*) FROM api_requests WHERE requested_at >= ?", (now - now % 3600,)).fetchone()[0]
        paused = self._db.execute("SELECT value FROM api_state WHERE key = 'retry_not_before'").fetchone()
        return {"buckets": buckets, "first": utc_iso(first) if first is not None else None, "last": utc_iso(last) if last is not None else None,
                "provisional": provisional, "empty": empty, "rows": rows, "requests_this_hour": used, "hourly_budget": self.hourly_budget,
                "paused_until": utc_iso(paused[0]) if paused and paused[0] > now else None}


def open_cache(settings=None, path: str | None = None) -> SabrCache:
    if settings is None:
        from .config import get_settings
        settings = get_settings()
    key = settings.greeks_live_api_key.get_secret_value()
    client = GreeksLiveClient(key, settings.greeks_live_base_url) if key else None
    path = path or settings.greeks_live_cache_file or str(Path(settings.state_file).parent / "greeks_live_cache.sqlite3")
    return SabrCache(path, client, hourly_budget=settings.greeks_live_hourly_budget)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.greeks_live", description="Greeks.live BTC SABR cache")
    parser.add_argument("--cache", help="SQLite cache file (default: next to STATE_FILE)")
    commands = parser.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("sync", help="fetch missing BTC SABR buckets")
    sync.add_argument("--start", required=True, help="UTC date or time, e.g. 2024-01-01")
    sync.add_argument("--end", help="UTC date or time (default: now)")
    sync.add_argument("--interval", default="1h", choices=list(INTERVALS))
    sync.add_argument("--wait", action="store_true", help="sleep through quota pauses instead of stopping")
    commands.add_parser("status", help="show cache coverage and request budget")
    args = parser.parse_args(argv)
    cache = open_cache(path=args.cache)
    try:
        if args.command == "status":
            result = cache.status()
        else:
            result = asdict(cache.sync(parse_utc(args.start), parse_utc(args.end) if args.end else int(time.time()), args.interval, wait=args.wait))
    except GreeksLiveError as error:
        print(f"{error.kind}: {error}", file=sys.stderr)
        return 2
    finally:
        cache.close()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

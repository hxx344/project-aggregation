"""Binance USD-M perpetual hourly prices and funding rates from the data.binance.vision monthly archives.

Each month is downloaded once and kept as two-column CSVs under <directory>/<SYMBOL>/; a published
month never changes, so a month is fetched again only when its CSV is missing. Downloads time out
after 30 s and are tried 3 times; a month that still fails, or is not published yet (404), raises
PerpDataError naming the URL. Standard library only.
"""
import csv
import io
import os
import sys
import time
import urllib.error
import urllib.request
import zipfile
from bisect import bisect_right
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um/monthly"
DEFAULT_DIR = os.environ.get("OPTBT_PERP_DATA", "~/data/binance")
TIMEOUT, ATTEMPTS = 30, 3
HOUR_MS = 3_600_000


class PerpDataError(RuntimeError):
    pass


def month_name(month):
    return f"{month // 12:04d}-{month % 12 + 1:02d}"


def fetch(url):
    error = None
    for attempt in range(ATTEMPTS):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
                return response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise PerpDataError(f"{url} is not published (404)") from exc
            error = exc
        except (urllib.error.URLError, OSError) as exc:
            error = exc
        if attempt + 1 < ATTEMPTS:
            time.sleep(2 * (attempt + 1))
    raise PerpDataError(f"download failed after {ATTEMPTS} attempts: {url}: {error}")


def parse(body, kind):
    """(hour, value) rows: a 1h candle's close labelled with the hour it ends at, or a funding rate at its hour."""
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        text = archive.read(archive.namelist()[0]).decode()
    rows = []
    for row in csv.reader(text.splitlines()):
        if not row or not row[0].strip().isdigit():
            continue  # header line (newer archives have one)
        if kind == "klines":
            rows.append((int(row[0]) // HOUR_MS + 1, float(row[4])))
        else:
            rows.append((round(int(row[0]) / HOUR_MS), float(row[2])))
    return rows


class BinancePerp:
    def __init__(self, months, symbol="BTCUSDT", directory=DEFAULT_DIR):
        self.folder = Path(directory).expanduser() / symbol
        self.symbol = symbol
        self.prices = {}
        for month in sorted(months):
            self.prices.update(self._month(month, "klines"))
        # Funding paid by a long per 1 BTC at each funding time: rate x price then; prefix sums for range queries.
        events = sorted((hour, rate * self.prices[hour]) for month in sorted(months)
                        for hour, rate in self._month(month, "funding") if hour in self.prices)
        self.funding_hours = [hour for hour, _ in events]
        self.cumulative = [0.0]
        for _, amount in events:
            self.cumulative.append(self.cumulative[-1] + amount)

    def _month(self, month, kind):
        path = self.folder / f"{kind}-{month_name(month)}.csv"
        if not path.exists():
            name = f"{self.symbol}-1h-{month_name(month)}.zip" if kind == "klines" else f"{self.symbol}-fundingRate-{month_name(month)}.zip"
            url = f"{BASE}/klines/{self.symbol}/1h/{name}" if kind == "klines" else f"{BASE}/fundingRate/{self.symbol}/{name}"
            print(f"downloading {url}", file=sys.stderr)
            rows = parse(fetch(url), kind)
            self.folder.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
            with open(temporary, "w", newline="") as handle:
                csv.writer(handle).writerows(rows)
            os.replace(temporary, path)
        with open(path, newline="") as handle:
            return [(int(hour), float(value)) for hour, value in csv.reader(handle)]

    def price(self, hour):
        return self.prices.get(hour)

    def funding(self, after, upto):
        """Funding a 1 BTC long pays for funding times in (after, upto]; negative when it receives."""
        return self.cumulative[bisect_right(self.funding_hours, upto)] - self.cumulative[bisect_right(self.funding_hours, after)]

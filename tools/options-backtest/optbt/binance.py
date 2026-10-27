"""Binance USD-M perpetual hourly prices and funding rates from the data.binance.vision monthly archives.

Months are loaded on demand, so a backtest only needs the months its positions touch. Each month is
downloaded once and kept as two-column CSVs under <directory>/<SYMBOL>/; a published month never
changes, so a month is fetched again only when its CSV is missing. Downloads time out after 30 s
and are tried 3 times (a corrupt archive counts as a failed try); a month that still fails, or is
not published yet (404), raises PerpDataError naming the URL. Standard library only.
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
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um/monthly"
DEFAULT_DIR = os.environ.get("OPTBT_PERP_DATA", "~/data/binance")
TIMEOUT, ATTEMPTS = 30, 3
HOUR_MS = 3_600_000


class PerpDataError(RuntimeError):
    pass


def month_name(month):
    return f"{month // 12:04d}-{month % 12 + 1:02d}"


def month_of_hour(hour):
    moment = datetime.fromtimestamp(hour * 3600, timezone.utc)
    return moment.year * 12 + moment.month - 1


def fetch(url):
    """The archive's CSV text."""
    error = None
    for attempt in range(ATTEMPTS):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
                body = response.read()
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                return archive.read(archive.namelist()[0]).decode()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise PerpDataError(f"{url} is not published (404); limit the backtest with start/end") from exc
            error = exc
        except (urllib.error.URLError, OSError, zipfile.BadZipFile, IndexError, UnicodeDecodeError) as exc:
            error = exc
        if attempt + 1 < ATTEMPTS:
            time.sleep(2 * (attempt + 1))
    raise PerpDataError(f"download failed after {ATTEMPTS} attempts: {url}: {error}")


def parse(text, kind):
    """(hour, value) rows: a 1h candle's close labelled with the hour it ends at, or a funding rate at its hour."""
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
    def __init__(self, symbol="BTCUSDT", directory=DEFAULT_DIR):
        self.folder = Path(directory).expanduser() / symbol
        self.symbol = symbol
        self._prices = {}   # month -> {hour: price}, by the month of the candle's open
        self._funding = {}  # month -> (hours, prefix sums of what a 1 BTC long pays)

    def _rows(self, month, kind):
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
        """Close of the candle ending at `hour`, i.e. the last price in (hour-1h, hour]; None if missing."""
        month = month_of_hour(hour - 1)
        if month not in self._prices:
            self._prices[month] = dict(self._rows(month, "klines"))
        return self._prices[month].get(hour)

    def _month_funding(self, month):
        if month not in self._funding:
            hours, cumulative = [], [0.0]
            for hour, rate in sorted(self._rows(month, "funding")):
                price = self.price(hour)
                if price is None:
                    raise PerpDataError(f"{self.symbol} has no price at funding time {datetime.fromtimestamp(hour * 3600, timezone.utc):%Y-%m-%d %H:%M} UTC")
                hours.append(hour)
                cumulative.append(cumulative[-1] + rate * price)
            self._funding[month] = (hours, cumulative)
        return self._funding[month]

    def funding(self, after, upto):
        """Funding a 1 BTC long pays for funding times in (after, upto]; negative when it receives."""
        total = 0.0
        if upto <= after:
            return total
        for month in range(month_of_hour(after + 1), month_of_hour(upto) + 1):
            hours, cumulative = self._month_funding(month)
            total += cumulative[bisect_right(hours, upto)] - cumulative[bisect_right(hours, after)]
        return total

"""Raw-quote market over monthly YYYY-MM.parquet files (output of `bt slim`), loaded lazily."""
import hashlib
import os
import re
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

import numpy as np
import pyarrow.parquet as pq

from . import parquet
from .engine import Quote

DEFAULT_DATA = os.environ.get("OPTBT_DATA", "~/data/options_hourly/BTC")
# Parsed months are kept as .npy files next to the data and memory-mapped. A month's cache is
# rebuilt when its parquet file's size or mtime changes, when market.py or parquet.py changes
# (CODE), or when CACHE_VERSION is bumped (bump it when the cache layout changes).
CACHE_VERSION = 1
CODE = hashlib.sha256(b"".join(Path(__file__).with_name(name).read_bytes() for name in ("market.py", "parquet.py"))).hexdigest()[:16]
FLOAT32 = ("iv", "mark", "bid", "ask", "strike")
STRIKE_BITS, OFFSET_BITS = 21, 14  # strike < 2.1M USD, expiry < 682 days after the quote hour
COLUMNS = ("time", "forward", "iv", "mark", "bid", "ask")


def month_of(seconds):
    moment = datetime.fromtimestamp(seconds, timezone.utc)
    return moment.year * 12 + moment.month - 1


def encode(hour, expiry, strike, is_call):
    """Sortable int64 key in (hour, expiry, strike, call) order."""
    return (((hour << OFFSET_BITS) | (expiry - hour)) << STRIKE_BITS | strike) << 1 | is_call


class ParquetMarket:
    def __init__(self, directory=DEFAULT_DATA, cache_months=64):
        self.directory = Path(directory).expanduser()
        self.files = {}
        for path in sorted(self.directory.glob("*.parquet")):
            match = re.fullmatch(r"(\d{4})-(\d{2})", path.stem)
            if match:
                self.files[int(match[1]) * 12 + int(match[2]) - 1] = path
        if not self.files:
            raise FileNotFoundError(f"no YYYY-MM.parquet files in {self.directory} (set OPTBT_DATA or --data)")
        self.cache_months = cache_months
        self._months = OrderedDict()
        self._span = None

    def _month(self, month):
        if month in self._months:
            self._months.move_to_end(month)
            return self._months[month]
        path = self.files.get(month)
        arrays = self._cached(path) if path else None
        self._months[month] = arrays
        while len(self._months) > self.cache_months:
            self._months.popitem(last=False)
        return arrays

    def _cached(self, path):
        folder = path.parent / ".optbt-cache" / f"v{CACHE_VERSION}" / path.stem
        stat = path.stat()
        stamp = f"{stat.st_size}:{stat.st_mtime_ns}:{CODE}"
        try:
            if (folder / "source.txt").read_text() == stamp:
                return {file.stem: np.load(file, mmap_mode="r") for file in folder.glob("*.npy")}
        except (OSError, ValueError):
            pass
        arrays = self._load(path)
        arrays = {name: values.astype("float32") if name in FLOAT32 else values for name, values in arrays.items()}
        try:
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "source.txt").unlink(missing_ok=True)
            for name, values in arrays.items():
                # Replace instead of overwrite: another bt process may have the old file memory-mapped.
                temporary = folder / f".{name}.{os.getpid()}.tmp"
                with open(temporary, "wb") as handle:
                    np.save(handle, values)
                os.replace(temporary, folder / f"{name}.npy")
            temporary = folder / f".source.{os.getpid()}.tmp"
            temporary.write_text(stamp)
            os.replace(temporary, folder / "source.txt")  # written last: marks the month complete
        except OSError:
            return arrays  # read-only data folder: keep working uncached
        return {name: np.load(folder / f"{name}.npy", mmap_mode="r") for name in arrays}

    @staticmethod
    def _load(path):
        columns = parquet.detect(pq.read_schema(path).names, {})
        parquet.require(columns)
        _, data = parquet.load(path, columns)
        prices = parquet.load_prices(path, data)
        if "mark_price" not in prices:
            raise ValueError(f"{path.name} has no mark_price column; the backtest needs raw option prices")
        data = parquet.latest_per_hour(data)
        hour = data["hour"].astype("int64")
        expiry = np.round(data["expiry"] / 3600).astype("int64")
        strike = np.round(data["strike"]).astype("int64")
        mark = parquet.usd(data, "mark_price")
        keep = (expiry >= hour) & (expiry - hour < 1 << OFFSET_BITS) & (strike > 0) & (strike < 1 << STRIKE_BITS) & (data["forward"] > 0) & np.isfinite(mark)
        arrays = {
            "key": encode(hour, expiry, strike, data["is_call"].astype("int64"))[keep],
            "time": data["time"][keep], "forward": data["forward"][keep], "iv": data["iv"][keep],
            "mark": mark[keep],
            "bid": parquet.usd(data, "bid_price")[keep] if "bid_price" in data else np.full(int(keep.sum()), np.nan),
            "ask": parquet.usd(data, "ask_price")[keep] if "ask_price" in data else np.full(int(keep.sum()), np.nan),
            "strike": data["strike"][keep],
        }
        order = np.lexsort((arrays["time"], arrays["key"]))
        arrays = {name: values[order] for name, values in arrays.items()}
        last = np.r_[arrays["key"][1:] != arrays["key"][:-1], True]
        return {name: values[last] for name, values in arrays.items()}

    def _sources(self, hour):
        # A label hour holds snapshots from (H-1h, H]; at a month boundary they span two files.
        months = dict.fromkeys((month_of(hour * 3600 - 1), month_of(hour * 3600)))
        return [arrays for arrays in (self._month(month) for month in months) if arrays is not None]

    def span(self):
        if self._span is None:
            first, last = self._month(min(self.files)), self._month(max(self.files))
            if first is None or last is None or not first["key"].size or not last["key"].size:
                raise ValueError("first or last data file is empty")
            self._span = (int(first["key"][0] >> (OFFSET_BITS + STRIKE_BITS + 1)), int(last["key"][-1] >> (OFFSET_BITS + STRIKE_BITS + 1)))
        return self._span

    def chain(self, hour):
        low, high = encode(hour, hour, 0, 0), encode(hour + 1, hour + 1, 0, 0)
        quotes = {}
        for arrays in self._sources(hour):
            start, stop = np.searchsorted(arrays["key"], [low, high])
            rows = zip(*(arrays[name][start:stop].tolist() for name in ("key", "strike") + COLUMNS))
            for key, strike, *values in rows:
                if key not in quotes or values[0] > quotes[key].time:
                    expiry = hour + ((key >> (STRIKE_BITS + 1)) & ((1 << OFFSET_BITS) - 1))
                    quotes[key] = Quote(expiry, float(strike), bool(key & 1), *values)
        return list(quotes.values())

    def quote(self, hour, expiry, strike, is_call):
        key = encode(hour, expiry, int(round(strike)), int(is_call))
        best = None
        for arrays in self._sources(hour):
            index = int(np.searchsorted(arrays["key"], key))
            if index < arrays["key"].size and arrays["key"][index] == key:
                values = [arrays[name][index].item() for name in COLUMNS]
                if best is None or values[0] > best.time:
                    best = Quote(expiry, float(arrays["strike"][index]), bool(is_call), *values)
        return best

    def settlement(self, expiry):
        """Delivery price estimate: the expiring contracts' underlying in the snapshot just before expiry.

        Deribit settles on a 30-minute index TWAP before 08:00 UTC; the last hourly snapshot's
        underlying for that expiry is the closest available stand-in."""
        for hour in (expiry, expiry - 1, expiry - 2):
            chain = self.chain(hour)
            expiring = [q.forward for q in chain if q.expiry == expiry]
            if expiring:
                return median(expiring)
            later = [q for q in chain if q.expiry > expiry]
            if later:
                nearest = min(q.expiry for q in later)
                return median(q.forward for q in later if q.expiry == nearest)
        return None

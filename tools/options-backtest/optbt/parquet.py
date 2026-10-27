"""Inspect hourly BTC option parquet files and compress them into a small SQLite smile cache.

Standalone usage (needs Python 3.9+ with `pip install pyarrow numpy`; on the server use `bt` instead):
  python parquet.py inspect  options_hourly/BTC
  python parquet.py convert  options_hourly/BTC -o btc_smiles.sqlite3
  python parquet.py slim     options_hourly/BTC -o options_hourly_slim
  python parquet.py verify   options_hourly/BTC --db btc_smiles.sqlite3

`slim` rewrites the parquet files with only each hour's latest snapshot and the
columns a backtest needs (time, expiry, strike, type, IVs, prices, forward), for
uploading the raw quotes; its output still works with `inspect` and `convert`.

Raw quotes (every strike, every hour) do not fit in 20 MB, so `convert` keeps one
row per (UTC hour, expiry): the forward, ATM IV, the median bid/ask IV spread near
ATM and the OTM implied-vol smile sampled at fixed standardized moneyness nodes
z = ln(K/F) / (atm_iv * sqrt(T)). Nodes outside the quoted strike range are stored
as 0 (no extrapolation). IVs are uint16 in units of 0.0001 (0.01 vol point);
prices are USD cents.

Hour H holds the latest snapshot taken in (H-1h, H], so a backtest acting at H
never sees later quotes; with open/close snapshots per hour this keeps "close".
Column names are detected automatically; override with --map role=column.
"""
import argparse
import math
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

ROLES = {
    "time": ["timestamp", "time", "ts", "datetime", "date_time", "hour", "snapshot_time", "local_timestamp", "created_at"],
    "instrument": ["instrument_name", "instrument", "symbol", "contract"],
    "expiry": ["expiry", "expiration", "expiration_timestamp", "expiry_time", "expiry_date", "expiration_date", "maturity"],
    "strike": ["strike", "strike_price", "k"],
    "type": ["option_type", "type", "cp", "call_put", "put_call", "right", "side_type"],
    "iv": ["mark_iv", "iv", "implied_volatility", "mark_implied_volatility", "markiv", "impliedvol", "mid_iv", "mark_vol", "vol"],
    "forward": ["forward", "forward_price", "underlying_price", "futures_price", "underlying"],
    "index": ["index_price", "spot", "spot_price", "underlying_index_price", "index"],
    "bid_iv": ["bid_iv"],
    "ask_iv": ["ask_iv"],
}
PRICES = {"mark_price": ["mark_price"], "bid_price": ["best_bid_price", "bid_price"], "ask_price": ["best_ask_price", "ask_price"]}
NODES = np.arange(-3.0, 3.01, 0.5)
SNAPSHOT_WINDOW = 15 * 60
INSTRUMENT = re.compile(r"^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:[.d]\d+)?)-([CP])$")
MONTHS = {name: index for index, name in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE smiles (
  hour INTEGER NOT NULL,      -- UTC hours since epoch
  expiry INTEGER NOT NULL,    -- UTC hours since epoch
  forward INTEGER NOT NULL,   -- USD cents
  atm_iv INTEGER NOT NULL,    -- 0.0001 units
  iv_spread INTEGER NOT NULL, -- median ask_iv - bid_iv of OTM quotes within 1 sd of ATM, 0.0001 units, 0 = unknown
  n_strikes INTEGER NOT NULL,
  nodes BLOB NOT NULL,        -- little-endian uint16 IV per z node, 0 = not quoted
  PRIMARY KEY (hour, expiry)) WITHOUT ROWID;
CREATE TABLE spot (hour INTEGER PRIMARY KEY, price INTEGER NOT NULL) WITHOUT ROWID;  -- USD cents, see meta.spot_source
"""


def files_in(directory):
    files = sorted(Path(directory).glob("*.parquet"))
    if not files:
        sys.exit(f"No .parquet files found in {directory}")
    return files


def detect(names, overrides):
    lowered = {name.lower(): name for name in names}
    found = {role: next((lowered[c] for c in candidates if c in lowered), None) for role, candidates in ROLES.items()}
    for role, column in overrides.items():
        if column not in names:
            sys.exit(f"--map {role}={column}: column not found; available: {', '.join(names)}")
        found[role] = column
    return found


def epoch_seconds(array):
    """Any timestamp/date/string/int column -> float64 epoch seconds (NaN for nulls)."""
    if isinstance(array, pa.ChunkedArray):
        array = array.combine_chunks()
    kind = array.type
    if pa.types.is_dictionary(kind):
        array = array.dictionary_decode()
        kind = array.type
    if pa.types.is_string(kind) or pa.types.is_large_string(kind):
        try:
            array = pc.cast(array, pa.timestamp("us", "UTC"))
        except pa.ArrowInvalid:
            array = pc.cast(array, pa.timestamp("us"))  # no zone offset in the text: read as UTC
        kind = array.type
    if pa.types.is_date(kind):
        array = pc.cast(pc.cast(array, pa.date32()), pa.int32())
        return array.to_numpy(zero_copy_only=False).astype("float64") * 86400
    if pa.types.is_timestamp(kind):
        scale = {"s": 1, "ms": 1e3, "us": 1e6, "ns": 1e9}[kind.unit]
        return pc.cast(array, pa.int64()).to_numpy(zero_copy_only=False).astype("float64") / scale
    values = pc.cast(array, pa.float64()).to_numpy(zero_copy_only=False)
    sample = np.nanmedian(np.abs(values)) if values.size else 0
    for scale in (1e9, 1e6, 1e3):
        if sample > 1e11 * scale / 1e3:
            return values / scale
    return values


def numbers(array):
    if isinstance(array, pa.ChunkedArray):
        array = array.combine_chunks()
    if pa.types.is_dictionary(array.type):
        array = array.dictionary_decode()
    return pc.cast(array, pa.float64()).to_numpy(zero_copy_only=False)


def parse_instruments(array):
    """Deribit names like BTC-29MAR24-60000-C -> (expiry seconds at 08:00 UTC, strike, is_call)."""
    encoded = pc.dictionary_encode(array.combine_chunks() if isinstance(array, pa.ChunkedArray) else array)
    parsed = []
    for name in encoded.dictionary.to_pylist():
        match = INSTRUMENT.match(str(name or ""))
        if not match:
            parsed.append((math.nan, math.nan, False))
            continue
        day, month, year, strike, side = match.groups()
        expiry = datetime(2000 + int(year), MONTHS[month], int(day), 8, tzinfo=timezone.utc).timestamp()
        parsed.append((expiry, float(strike.replace("d", ".")), side == "C"))
    table = np.array(parsed, dtype=object)
    indices = encoded.indices.to_numpy(zero_copy_only=False)
    return table[indices, 0].astype("float64"), table[indices, 1].astype("float64"), table[indices, 2].astype(bool)


def load(path, columns):
    needed = [c for c in columns.values() if c]
    table = pq.read_table(path, columns=sorted(set(needed)))
    data = {"time": epoch_seconds(table[columns["time"]])}
    if columns["expiry"] and columns["strike"] and columns["type"]:
        data["expiry"] = epoch_seconds(table[columns["expiry"]])
        if np.all(np.nan_to_num(data["expiry"]) % 86400 == 0):
            data["expiry"] = data["expiry"] + 8 * 3600  # date-only expiries: Deribit settles 08:00 UTC
        data["strike"] = numbers(table[columns["strike"]])
        kinds = pc.utf8_lower(pc.cast(table[columns["type"]], pa.string()))
        data["is_call"] = pc.fill_null(pc.starts_with(kinds, "c"), False).to_numpy(zero_copy_only=False).astype(bool)
    else:
        data["expiry"], data["strike"], data["is_call"] = parse_instruments(table[columns["instrument"]])
    iv = numbers(table[columns["iv"]])
    scale = 100 if np.nanmedian(iv) > 3 else 1
    data["iv"] = iv / scale
    for side in ("bid_iv", "ask_iv"):
        data[side] = numbers(table[columns[side]]) / scale if columns[side] else np.full(iv.size, np.nan)
    data["forward"] = numbers(table[columns["forward"] or columns["index"]])
    if columns["index"]:
        data["index"] = numbers(table[columns["index"]])
    return len(table), data


def load_prices(path, data):
    """Add the raw mark/bid/ask option prices (as stored, BTC or USD) under their canonical names."""
    names = {name.lower(): name for name in pq.read_schema(path).names}
    found = {role: names[next(c for c in candidates if c in names)] for role, candidates in PRICES.items() if any(c in names for c in candidates)}
    if found:
        table = pq.read_table(path, columns=sorted(set(found.values())))
        data.update({role: numbers(table[column]) for role, column in found.items()})
    return list(found)


def usd(data, role):
    """A price column in USD: Deribit quotes option prices in BTC, converted at the contract's own forward."""
    values = data[role]
    finite = values[np.isfinite(values)]
    return values * data["forward"] if finite.size and np.median(finite) < 5 else values


def require(columns):
    missing = [role for role in ("time", "iv") if not columns[role]]
    if not columns["forward"] and not columns["index"]:
        missing.append("forward or index")
    if not columns["instrument"] and not (columns["expiry"] and columns["strike"] and columns["type"]):
        missing.append("instrument (or expiry+strike+type)")
    if missing:
        sys.exit(f"Cannot detect columns for: {', '.join(missing)}. Pass --map role=column (roles: {', '.join(ROLES)}).")


def latest_per_hour(data):
    """Label each quote with the hour that closes its snapshot and keep the latest quote per (hour, contract).

    Quotes more than SNAPSHOT_WINDOW older than the hour's newest quote are dropped, so a contract
    missing from the close snapshot does not put a stale open-snapshot IV into the smile."""
    hour = np.ceil(data["time"] / 3600)
    ok = np.isfinite(hour) & np.isfinite(data["expiry"]) & (data["strike"] > 0)
    if ok.any():
        labels, inverse = np.unique(hour[ok], return_inverse=True)
        newest = np.full(labels.size, -np.inf)
        np.maximum.at(newest, inverse, data["time"][ok])
        ok[np.flatnonzero(ok)] = data["time"][ok] >= newest[inverse] - SNAPSHOT_WINDOW
    picked = {key: value[ok] for key, value in data.items()}
    picked["hour"] = hour[ok]
    order = np.lexsort((picked["time"], picked["is_call"], picked["strike"], picked["expiry"], picked["hour"]))
    picked = {key: value[order] for key, value in picked.items()}
    keys = (picked["hour"], picked["expiry"], picked["strike"], picked["is_call"])
    last = np.r_[np.any([np.diff(key.astype("float64")) != 0 for key in keys], axis=0), True] if order.size else np.zeros(0, bool)
    return {key: value[last] for key, value in picked.items()}


def smiles(data):
    """Yield (hour, expiry_hour, forward, atm_iv, iv_spread, n_strikes, node_ivs) per (hour, expiry)."""
    data = latest_per_hour(data)
    hour = data["hour"]
    years = (data["expiry"] - hour * 3600) / (365 * 86400)
    ok = (years > 0.5 / 8760) & np.isfinite(data["iv"]) & (data["iv"] > 0.01) & (data["iv"] < 5) & (data["forward"] > 0)
    hour, expiry, years = hour[ok], data["expiry"][ok], years[ok]
    strike, is_call, iv, forward = data["strike"][ok], data["is_call"][ok], data["iv"][ok], data["forward"][ok]
    spread = data["ask_iv"][ok] - data["bid_iv"][ok]
    edges = np.flatnonzero((np.diff(hour) != 0) | (np.diff(expiry) != 0)) + 1
    for start, stop in zip(np.r_[0, edges], np.r_[edges, hour.size]):
        f = float(np.median(forward[start:stop]))
        k, c, v, w = strike[start:stop], is_call[start:stop], iv[start:stop], spread[start:stop]
        otm = (c & (k >= f)) | (~c & (k <= f))
        if otm.sum() < 3:
            continue
        x_all = np.log(k[otm] / f)
        x, inverse = np.unique(x_all, return_inverse=True)
        smile = np.bincount(inverse, weights=v[otm]) / np.bincount(inverse)
        if x.size < 3 or not (x[0] <= 0 <= x[-1]):
            continue
        atm = float(np.interp(0.0, x, smile))
        width = atm * math.sqrt(float(years[start]))
        near = (np.abs(x_all) <= width) & np.isfinite(w[otm]) & (w[otm] >= 0)
        targets = NODES * width
        nodes = np.where((targets >= x[0]) & (targets <= x[-1]), np.interp(targets, x, smile), 0.0)
        yield int(hour[start]), int(round(expiry[start] / 3600)), f, atm, float(np.median(w[otm][near])) if near.any() else 0.0, int(x.size), nodes


def encode_iv(values):
    return np.clip(np.round(np.asarray(values) * 10000), 0, 65535).astype("<u2")


def utc(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%d %H:%M")


def inspect(args):
    files = files_in(args.directory)
    schema = pq.read_schema(files[0])
    print(f"{len(files)} files: {files[0].name} .. {files[-1].name}, {sum(f.stat().st_size for f in files) / 1e6:.1f} MB on disk")
    print("schema of", files[0].name)
    for field in schema:
        print(f"  {field.name}: {field.type}")
    columns = detect(schema.names, dict(args.map))
    print("detected:", ", ".join(f"{role}={column}" for role, column in columns.items() if column) or "nothing")
    print("sample rows:")
    for row in pq.read_table(files[0]).slice(0, 3).to_pylist():
        print("  ", row)
    require(columns)
    if not columns["forward"]:
        print("note: no forward/underlying column, smiles are centred on the index price instead of each expiry's forward")
    total_rows = total_groups = kept = 0
    hours = set()
    for path in files:
        if pq.read_schema(path).names != schema.names:
            print(f"  ! {path.name} has different columns: {pq.read_schema(path).names}")
            continue
        rows, data = load(path, columns)
        kept += int(latest_per_hour(data)["hour"].size)
        groups = list(smiles(data))
        file_hours = {g[0] for g in groups}
        hours |= file_hours
        total_rows += rows
        total_groups += len(groups)
        bad = int(np.isnan(data["expiry"]).sum())
        print(f"  {path.name}: {rows:>9,} rows, {len(file_hours):>4} hours, {len(groups):>6} hour x expiry smiles"
              + (f", {bad} unparsed instruments" if bad else "")
              + (f", {utc(min(file_hours) * 3600)} .. {utc(max(file_hours) * 3600)}" if file_hours else ""))
    print(f"total: {total_rows:,} rows, {len(hours):,} hours, {total_groups:,} smiles; "
          f"{kept / max(len(hours), 1):.0f} contracts per hour after keeping the latest snapshot ({total_rows / max(len(hours), 1):.0f} quotes before)")
    print(f"raw rows in SQLite would be roughly {kept * 60 / 1e6:,.0f} MB; compact smile cache roughly {total_groups * (25 + 2 * NODES.size) / 1e6:.1f} MB")


def convert(args):
    files = files_in(args.directory)
    output = Path(args.output)
    if output.exists():
        sys.exit(f"{output} already exists; choose another --output or delete it")
    columns = detect(pq.read_schema(files[0]).names, dict(args.map))
    require(columns)
    partial = output.with_name(output.name + ".partial")
    partial.unlink(missing_ok=True)
    db = sqlite3.connect(partial)
    db.executescript(SCHEMA)
    db.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("asset", "BTC"), ("nodes_z", ",".join(f"{z:g}" for z in NODES)), ("iv_scale", "10000"), ("price_scale", "100"),
        ("node_definition", "z = ln(K/F) / (atm_iv * sqrt(T)), T = (expiry - hour) / 365 days, OTM quotes, linear in ln(K/F)"),
        ("max_dte", str(args.max_dte or "")), ("hour_label", "latest snapshot in (hour-1h, hour]"),
        ("spot_source", "index column" if columns["index"] else "forward of the nearest expiry (no index column)"), ("source_files", f"{files[0].name}..{files[-1].name}"), ("columns", repr(columns))])
    written = 0
    for path in files:
        _, data = load(path, columns)
        rows = [(h, e, int(round(f * 100)), int(encode_iv([a])[0]), int(encode_iv([w])[0]), n, encode_iv(nodes).tobytes())
                for h, e, f, a, w, n, nodes in smiles(data) if not args.max_dte or e - h <= args.max_dte * 24]
        db.executemany("INSERT OR REPLACE INTO smiles VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        if columns["index"]:
            quotes = latest_per_hour(data)
            spot = {}
            for h, value in zip(quotes["hour"].astype(int).tolist(), quotes["index"].tolist()):
                if value > 0:
                    spot[h] = value
        else:
            spot = {}
            for h, e, f, *_ in sorted(rows, key=lambda row: (row[0], -row[1])):
                spot[h] = f / 100
        db.executemany("INSERT OR REPLACE INTO spot VALUES (?, ?)", [(h, int(round(v * 100))) for h, v in spot.items()])
        db.commit()
        written += len(rows)
        print(f"  {path.name}: {len(rows):,} smiles")
    db.execute("VACUUM")
    db.close()
    partial.replace(output)
    size = output.stat().st_size / 1e6
    print(f"wrote {written:,} smiles to {output} ({size:.1f} MB)")
    if size > args.limit_mb:
        print(f"! larger than {args.limit_mb} MB; rerun with a smaller --max-dte (e.g. 120)")
        return 1
    return 0


def slim(args):
    """Copy the parquet files keeping each hour's latest quote per contract and only the columns a backtest needs."""
    files = files_in(args.directory)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    columns = detect(pq.read_schema(files[0]).names, dict(args.map))
    require(columns)
    before = after = 0
    for path in files:
        target = output / path.name
        before += path.stat().st_size
        if target.exists():
            after += target.stat().st_size
            print(f"  {path.name}: already in {output}, skipped")
            continue
        rows, data = load(path, columns)
        prices = load_prices(path, data)
        data = latest_per_hour(data)
        if args.max_dte:
            keep = data["expiry"] - data["hour"] * 3600 <= args.max_dte * 86400
            data = {key: value[keep] for key, value in data.items()}
        real = lambda values: pa.array(values.astype("float32"), from_pandas=True)
        fields = {
            "timestamp": pa.array(np.round(data["time"] * 1000).astype("int64"), pa.timestamp("ms", "UTC")),
            "expiration": pa.array(np.round(data["expiry"]).astype("int64"), pa.timestamp("s", "UTC")),
            "strike_price": real(data["strike"]),
            "type": pa.array(np.where(data["is_call"], "call", "put")).dictionary_encode(),
            "mark_iv": real(data["iv"]), "bid_iv": real(data["bid_iv"]), "ask_iv": real(data["ask_iv"]),
        }
        if columns["forward"]:
            fields["underlying_price"] = pa.array(data["forward"], from_pandas=True)
        if columns["index"]:
            fields["index_price"] = pa.array(data["index"], from_pandas=True)
        fields.update({name: real(data[name]) for name in prices})
        partial = target.with_name(target.name + ".partial")
        pq.write_table(pa.table(fields), partial, compression="zstd", compression_level=9)
        partial.replace(target)
        after += target.stat().st_size
        print(f"  {path.name}: {rows:,} -> {data['time'].size:,} rows, {path.stat().st_size / 1e6:.1f} -> {target.stat().st_size / 1e6:.1f} MB")
    print(f"total {before / 1e6:,.1f} -> {after / 1e6:,.1f} MB in {output}")
    return 0


ERF = np.frompyfunc(math.erf, 1, 1)
DTE_EDGES = [0, 1, 3, 7, 30, 90, math.inf]
DELTA_EDGES = [0, 0.1, 0.25, 0.4, 0.6, 1.01]


def black(forward, strike, years, iv, is_call):
    """Undiscounted Black-76 USD price and delta."""
    sd = iv * np.sqrt(years)
    d1 = np.log(forward / strike) / sd + sd / 2
    n1 = 0.5 + 0.5 * ERF(d1 / math.sqrt(2)).astype("float64")
    n2 = 0.5 + 0.5 * ERF((d1 - sd) / math.sqrt(2)).astype("float64")
    call = forward * n1 - strike * n2
    return np.where(is_call, call, call - forward + strike), np.where(is_call, n1, n1 - 1)


def stats(values):
    values = np.abs(values[np.isfinite(values)])
    return (float(np.median(values)), float(np.percentile(values, 95))) if values.size else (math.nan, math.nan)


def verify(args):
    """Rebuild every raw quote from the smile cache and compare with the raw mark/bid/ask."""
    files = files_in(args.directory)
    columns = detect(pq.read_schema(files[0]).names, dict(args.map))
    require(columns)
    db = sqlite3.connect(f"file:{Path(args.db).resolve().as_posix()}?mode=ro", uri=True)
    rows = db.execute("SELECT hour, expiry, forward, atm_iv, nodes FROM smiles ORDER BY hour, expiry").fetchall()
    keys = np.array([h * 1_000_000 + e for h, e, *_ in rows], dtype="int64")
    smile_forward = np.array([row[2] for row in rows], dtype="float64") / 100
    smile_atm = np.array([row[3] for row in rows], dtype="float64") / 10000
    smile_nodes = np.frombuffer(b"".join(row[4] for row in rows), "<u2").reshape(len(rows), NODES.size).astype("float64") / 10000
    rng = np.random.default_rng(0)
    coverage = np.zeros((len(DTE_EDGES) - 1, 3), dtype="int64")  # no smile, outside stored nodes, rebuilt
    samples = []
    for path in files:
        _, data = load(path, columns)
        load_prices(path, data)
        data = latest_per_hour(data)
        expiry_hour = np.round(data["expiry"] / 3600)
        label_years = (expiry_hour - data["hour"]) / 8760
        ok = (label_years > 0.5 / 8760) & np.isfinite(data["iv"]) & (data["iv"] > 0.01) & (data["iv"] < 5) & (data["forward"] > 0)
        data = {key: value[ok] for key, value in data.items()}
        expiry_hour, label_years = expiry_hour[ok], label_years[ok]
        dte = np.digitize(label_years * 365, DTE_EDGES) - 1
        wanted = data["hour"].astype("int64") * 1_000_000 + expiry_hour.astype("int64")
        position = np.clip(np.searchsorted(keys, wanted), 0, max(keys.size - 1, 0))
        found = (keys[position] == wanted) if keys.size else np.zeros(wanted.size, bool)
        forward, atm = smile_forward[position], smile_atm[position]
        z = np.log(data["strike"] / forward) / (atm * np.sqrt(label_years))
        node = (z - NODES[0]) / (NODES[1] - NODES[0])
        low = np.clip(np.floor(node).astype("int64"), 0, NODES.size - 2)
        weight = node - low
        iv_low, iv_high = smile_nodes[position, low], smile_nodes[position, low + 1]
        rebuilt = found & (node >= 0) & (node <= NODES.size - 1) & (iv_low > 0) & (iv_high > 0)
        np.add.at(coverage, (dte, np.where(~found, 0, np.where(rebuilt, 2, 1))), 1)
        picked = np.flatnonzero(rebuilt)
        if picked.size > args.sample:
            picked = np.sort(rng.choice(picked, args.sample, replace=False))
        pick = lambda values: values[picked]
        k, call, mark_iv, own_forward = pick(data["strike"]), pick(data["is_call"]), pick(data["iv"]), pick(data["forward"])
        actual_years = (pick(data["expiry"]) - pick(data["time"])) / (365 * 86400)
        smile_iv = pick(iv_low) * (1 - pick(weight)) + pick(iv_high) * pick(weight)
        formula, delta = black(own_forward, k, actual_years, mark_iv, call)
        steps = [formula,
                 black(own_forward, k, pick(label_years), mark_iv, call)[0],
                 black(pick(forward), k, pick(label_years), mark_iv, call)[0],
                 black(pick(forward), k, pick(label_years), smile_iv, call)[0]]
        to_usd = lambda name: pick(usd(data, name)) if name in data else np.full(picked.size, math.nan)
        mark, bid, ask = to_usd("mark_price"), to_usd("bid_price"), to_usd("ask_price")
        quoted = (bid > 0) & (ask >= bid)
        samples.append({"dte": pick(dte), "delta": np.abs(delta), "iv_error": smile_iv - mark_iv,
                        "reference": np.where(np.isfinite(mark), mark, formula), "rebuilt": steps[-1], "steps": steps,
                        "mark": mark, "spread": np.where(quoted, ask - bid, math.nan),
                        "inside": np.where(quoted, (steps[-1] >= bid) & (steps[-1] <= ask), math.nan)})
        print(f"  {path.name}: {int(ok.sum()):,} quotes, {int(rebuilt.sum()):,} rebuilt, {picked.size:,} sampled")
    joined = {key: np.concatenate([sample[key] for sample in samples]) for key in samples[0] if key != "steps"}
    steps = [np.concatenate([sample["steps"][i] for sample in samples]) for i in range(4)]
    labels = [f"{DTE_EDGES[i]:g}-{DTE_EDGES[i + 1]:g}d" for i in range(len(DTE_EDGES) - 1)]
    print("\ncoverage by DTE (share of raw quotes the cache can rebuild; the rest are beyond +-3 sd or have no smile):")
    for label, (missing, outside, ok_count) in zip(labels, coverage):
        total = missing + outside + ok_count
        if total:
            print(f"  {label:>8}: {total:>10,} quotes, {ok_count / total:6.1%} rebuilt, {outside / total:6.1%} beyond stored nodes, {missing / total:6.1%} no smile")
    has_mark = np.isfinite(joined["mark"]).any()
    print("\nerror sources, |USD| median / p95 per step:")
    sources = ([("Black-76(mark_iv) vs raw mark_price", steps[0] - joined["mark"])] if has_mark else []) + [
        ("snapshot time -> hour label T", steps[1] - steps[0]), ("own forward -> cached forward", steps[2] - steps[1]),
        ("mark_iv -> smile IV", steps[3] - steps[2]), ("total vs " + ("raw mark_price" if has_mark else "Black-76(mark_iv)"), joined["rebuilt"] - joined["reference"])]
    for name, values in sources:
        print(f"  {name:<38} {stats(values)[0]:>9.2f} / {stats(values)[1]:>9.2f}")
    print("\nrebuilt vs reference by DTE x |delta|: IV error (vol pts) median|abs| / p95|abs| / bias, USD median|abs| / p95|abs|, "
          "error / bid-ask spread median / p95, rebuilt price inside bid-ask")
    error = joined["rebuilt"] - joined["reference"]
    delta_bucket = np.digitize(joined["delta"], DELTA_EDGES) - 1
    for d in range(len(DTE_EDGES) - 1):
        for b in range(len(DELTA_EDGES) - 1):
            mask = (joined["dte"] == d) & (delta_bucket == b)
            if mask.sum() < 20:
                continue
            iv_error = joined["iv_error"][mask] * 100
            usd, ratio = stats(error[mask]), stats(error[mask] / joined["spread"][mask])
            inside = joined["inside"][mask]
            inside = f"{np.nanmean(inside):6.1%}" if np.isfinite(inside).any() else "     -"
            print(f"  {labels[d]:>8} delta {DELTA_EDGES[b]:.2f}-{min(DELTA_EDGES[b + 1], 1):.2f} n={int(mask.sum()):>7,}  "
                  f"iv {stats(iv_error)[0]:5.2f} / {stats(iv_error)[1]:5.2f} / {np.mean(iv_error):+5.2f}  "
                  f"usd {usd[0]:8.2f} / {usd[1]:8.2f}  spread {ratio[0]:5.2f} / {ratio[1]:5.2f}  inside {inside}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect", "convert", "slim", "verify"):
        command = commands.add_parser(name)
        command.add_argument("directory", help="folder with YYYY-MM.parquet files")
        command.add_argument("--map", action="append", default=[], type=lambda text: tuple(text.split("=", 1)),
                             help="role=column override, e.g. --map iv=mark_iv")
    convert_parser = commands.choices["convert"]
    convert_parser.add_argument("-o", "--output", default="btc_smiles.sqlite3")
    convert_parser.add_argument("--max-dte", type=int, default=0, help="drop expiries further than this many days (0 = keep all)")
    convert_parser.add_argument("--limit-mb", type=float, default=20)
    slim_parser = commands.choices["slim"]
    slim_parser.add_argument("-o", "--output", default="options_hourly_slim", help="folder for the slimmed parquet files")
    slim_parser.add_argument("--max-dte", type=int, default=0, help="drop expiries further than this many days (0 = keep all)")
    verify_parser = commands.choices["verify"]
    verify_parser.add_argument("--db", default="btc_smiles.sqlite3", help="smile cache written by convert")
    verify_parser.add_argument("--sample", type=int, default=20000, help="rebuilt quotes sampled per file for the error tables")
    args = parser.parse_args(argv)
    return {"inspect": inspect, "convert": convert, "slim": slim, "verify": verify}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())

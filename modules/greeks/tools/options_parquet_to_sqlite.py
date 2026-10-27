"""Inspect hourly BTC option parquet files and compress them into a small SQLite smile cache.

Usage (needs Python 3.9+ with `pip install pyarrow numpy`):
  python options_parquet_to_sqlite.py inspect  options_hourly/BTC
  python options_parquet_to_sqlite.py convert  options_hourly/BTC -o btc_smiles.sqlite3

Raw quotes (every strike, every hour) do not fit in 20 MB, so `convert` keeps one
row per (UTC hour, expiry): the forward, ATM IV and the OTM implied-vol smile
sampled at fixed standardized moneyness nodes z = ln(K/F) / (atm_iv * sqrt(T)).
Nodes outside the quoted strike range are stored as 0 (no extrapolation).
IVs are stored as uint16 in units of 0.0001 (0.01 vol point); forwards in USD cents.
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
}
NODES = np.arange(-3.0, 3.01, 0.5)
INSTRUMENT = re.compile(r"^[A-Z]+-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:[.d]\d+)?)-([CP])$")
MONTHS = {name: index for index, name in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE smiles (
  hour INTEGER NOT NULL,      -- UTC hours since epoch
  expiry INTEGER NOT NULL,    -- UTC hours since epoch
  forward INTEGER NOT NULL,   -- USD cents
  atm_iv INTEGER NOT NULL,    -- 0.0001 units
  n_strikes INTEGER NOT NULL,
  nodes BLOB NOT NULL,        -- little-endian uint16 IV per z node, 0 = not quoted
  PRIMARY KEY (hour, expiry)) WITHOUT ROWID;
CREATE TABLE spot (hour INTEGER PRIMARY KEY, index_price INTEGER NOT NULL) WITHOUT ROWID;  -- USD cents
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
        kinds = pc.utf8_lower(pc.cast(table[columns["type"]], pa.string())).to_numpy(zero_copy_only=False)
        data["is_call"] = np.array([str(value).startswith("c") for value in kinds])
    else:
        data["expiry"], data["strike"], data["is_call"] = parse_instruments(table[columns["instrument"]])
    iv = numbers(table[columns["iv"]])
    data["iv"] = iv / 100 if np.nanmedian(iv) > 3 else iv
    data["forward"] = numbers(table[columns["forward"] or columns["index"]])
    data["index"] = numbers(table[columns["index"]]) if columns["index"] else None
    return len(table), data


def require(columns):
    missing = [role for role in ("time", "iv") if not columns[role]]
    if not columns["forward"] and not columns["index"]:
        missing.append("forward or index")
    if not columns["instrument"] and not (columns["expiry"] and columns["strike"] and columns["type"]):
        missing.append("instrument (or expiry+strike+type)")
    if missing:
        sys.exit(f"Cannot detect columns for: {', '.join(missing)}. Pass --map role=column (roles: {', '.join(ROLES)}).")


def smiles(data):
    """Yield (hour, expiry_hour, forward, atm_iv, n_strikes, node_ivs) per (hour, expiry)."""
    hour = np.floor(data["time"] / 3600)
    years = (data["expiry"] - hour * 3600) / (365 * 86400)
    ok = np.isfinite(hour) & np.isfinite(data["expiry"]) & (years > 0.5 / 8760) & (data["strike"] > 0) \
        & np.isfinite(data["iv"]) & (data["iv"] > 0.01) & (data["iv"] < 5) & (data["forward"] > 0)
    hour, expiry, years = hour[ok], data["expiry"][ok], years[ok]
    strike, is_call, iv, forward = data["strike"][ok], data["is_call"][ok], data["iv"][ok], data["forward"][ok]
    order = np.lexsort((strike, expiry, hour))
    hour, expiry, years, strike, is_call, iv, forward = (a[order] for a in (hour, expiry, years, strike, is_call, iv, forward))
    edges = np.flatnonzero((np.diff(hour) != 0) | (np.diff(expiry) != 0)) + 1
    for start, stop in zip(np.r_[0, edges], np.r_[edges, hour.size]):
        f = float(np.median(forward[start:stop]))
        k, c, v = strike[start:stop], is_call[start:stop], iv[start:stop]
        otm = (c & (k >= f)) | (~c & (k <= f))
        if otm.sum() < 3:
            continue
        x_all = np.log(k[otm] / f)
        x, inverse = np.unique(x_all, return_inverse=True)
        smile = np.bincount(inverse, weights=v[otm]) / np.bincount(inverse)
        if x.size < 3 or not (x[0] <= 0 <= x[-1]):
            continue
        atm = float(np.interp(0.0, x, smile))
        targets = NODES * atm * math.sqrt(float(years[start]))
        nodes = np.where((targets >= x[0]) & (targets <= x[-1]), np.interp(targets, x, smile), 0.0)
        yield int(hour[start]), int(round(expiry[start] / 3600)), f, atm, int(x.size), nodes


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
    total_rows = total_groups = 0
    hours = set()
    for path in files:
        if pq.read_schema(path).names != schema.names:
            print(f"  ! {path.name} has different columns: {pq.read_schema(path).names}")
            continue
        rows, data = load(path, columns)
        groups = list(smiles(data))
        file_hours = {g[0] for g in groups}
        hours |= file_hours
        total_rows += rows
        total_groups += len(groups)
        bad = int(np.isnan(data["expiry"]).sum())
        print(f"  {path.name}: {rows:>9,} rows, {len(file_hours):>4} hours, {len(groups):>6} hour x expiry smiles"
              + (f", {bad} unparsed instruments" if bad else "")
              + (f", {utc(min(file_hours) * 3600)} .. {utc(max(file_hours) * 3600)}" if file_hours else ""))
    print(f"total: {total_rows:,} rows, {len(hours):,} hours, {total_groups:,} smiles, {total_rows / max(len(hours), 1):.0f} quotes per hour")
    print(f"raw rows in SQLite would be roughly {total_rows * 60 / 1e6:,.0f} MB; compact smile cache roughly {total_groups * (60 + 2 * NODES.size) / 1e6:.1f} MB")


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
        ("max_dte", str(args.max_dte or "")), ("source_files", f"{files[0].name}..{files[-1].name}"), ("columns", repr(columns))])
    written = 0
    for path in files:
        _, data = load(path, columns)
        rows = [(h, e, int(round(f * 100)), int(encode_iv([a])[0]), n, encode_iv(nodes).tobytes())
                for h, e, f, a, n, nodes in smiles(data) if not args.max_dte or e - h <= args.max_dte * 24]
        db.executemany("INSERT OR REPLACE INTO smiles VALUES (?, ?, ?, ?, ?, ?)", rows)
        if data["index"] is not None:
            hour = np.floor(data["time"] / 3600)
            ok = np.isfinite(hour) & (data["index"] > 0)
            spot = {}
            for h, value in zip(hour[ok].astype(int).tolist(), data["index"][ok].tolist()):
                spot.setdefault(h, value)
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inspect", "convert"):
        command = commands.add_parser(name)
        command.add_argument("directory", help="folder with YYYY-MM.parquet files")
        command.add_argument("--map", action="append", default=[], type=lambda text: tuple(text.split("=", 1)),
                             help="role=column override, e.g. --map iv=mark_iv")
    convert_parser = commands.choices["convert"]
    convert_parser.add_argument("-o", "--output", default="btc_smiles.sqlite3")
    convert_parser.add_argument("--max-dte", type=int, default=0, help="drop expiries further than this many days (0 = keep all)")
    convert_parser.add_argument("--limit-mb", type=float, default=20)
    args = parser.parse_args(argv)
    return inspect(args) if args.command == "inspect" else convert(args)


if __name__ == "__main__":
    sys.exit(main())

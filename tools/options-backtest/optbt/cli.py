"""bt: BTC option backtests on raw hourly quotes.

  bt run SPEC [--set PATH=VALUE ...]          one backtest; SPEC = file, inline JSON or example name
  bt sweep SPEC --set PATH[+PATH]=V1,V2 ...   grid over every combination of the --set choices
  bt chain 2025-01-03T21 [--dte 2]            the option chain one hour sees (debugging leg choice)
  bt examples                                 list bundled example specs
  bt inspect|convert|slim|verify ...          parquet tools (see parquet.py)
"""
import argparse
import copy
import csv
import itertools
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import engine, report, spec as specs

RESULTS = Path("~/data/greeks/backtests").expanduser()


def build(raw, sets):
    raw = copy.deepcopy(raw)
    for path, value in sets:
        for part in path.split("+"):
            specs.set_path(raw, part, value)
    return specs.validate(raw)


def market_for(args):
    from .market import ParquetMarket
    return ParquetMarket(args.data) if args.data else ParquetMarket()


def out_dir(args, name):
    if args.out:
        return Path(args.out).expanduser()
    return RESULTS / name / datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def run_command(args):
    raw = specs.load(args.spec)
    spec = build(raw, [(path, specs.parse_value(value)) for path, value in args.set])
    market = market_for(args)
    started = time.monotonic()
    trades, skipped, window = engine.run(spec, market)
    summary = report.summarize(trades, skipped, window)
    summary["seconds"] = round(time.monotonic() - started, 1)
    directory = out_dir(args, spec["name"])
    report.write(directory, spec, trades, summary)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        print("\n".join(report.text(spec, summary)))
        print(f"files {directory}/{{trades.csv,summary.json,spec.json}}  ({summary['seconds']}s)")
    return 0


COLUMNS = [("trades", "trades", "{}"), ("win", "win_rate", "{:.1%}"), ("total", "total_pnl", "{:,.0f}"), ("mean", "mean_pnl", "{:,.1f}"),
           ("worst", "worst", "{:,.0f}"), ("maxDD", "max_drawdown", "{:,.0f}"), ("sharpe", "sharpe", "{}"), ("ret/margin", "mean_return_on_margin", "{:.2%}")]


def sweep_command(args):
    raw = specs.load(args.spec)
    grid = [(path, specs.parse_choices(values)) for path, values in args.set]
    if not grid:
        sys.exit("sweep needs at least one --set PATH=V1,V2")
    combos = list(itertools.product(*(values for _, values in grid)))
    market = market_for(args)
    rows = []
    for number, combo in enumerate(combos, 1):
        sets = list(zip((path for path, _ in grid), combo))
        spec = build(raw, sets)
        trades, skipped, window = engine.run(spec, market)
        summary = report.summarize(trades, skipped, window)
        rows.append({**{path: value for path, value in sets}, **{key: summary.get(key) for _, key, _ in COLUMNS}})
        print(f"\r  {number}/{len(combos)}", end="", file=sys.stderr, flush=True)
    print(file=sys.stderr)
    key = dict((label, field) for label, field, _ in COLUMNS).get(args.sort, args.sort)
    rows.sort(key=lambda row: (row.get(key) is None, -(row.get(key) or 0)))
    directory = out_dir(args, f"{raw.get('name', 'backtest')}-sweep")
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / "sweep.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    paths = [path for path, _ in grid]
    header = paths + [label for label, _, _ in COLUMNS]
    table = [[json.dumps(row[path]) for path in paths] + [("-" if row[field] is None else fmt.format(row[field])) for _, field, fmt in COLUMNS]
             for row in rows[:args.top]]
    widths = [max(len(str(cell)) for cell in column) for column in zip(header, *table)]
    for line in [header] + table:
        print("  ".join(str(cell).rjust(width) for cell, width in zip(line, widths)))
    print(f"{len(rows)} runs, sorted by {key}{f', top {args.top} shown' if len(rows) > args.top else ''}; all rows in {directory}/sweep.csv")
    return 0


def chain_command(args):
    moment = datetime.fromisoformat(args.hour.replace("Z", "+00:00"))
    moment = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    hour = int(moment.timestamp() // 3600)
    market = market_for(args)
    chain = market.chain(hour)
    if not chain:
        sys.exit(f"no quotes for hour {engine.utc(hour):%Y-%m-%d %H:%M}")
    expiries = sorted({q.expiry for q in chain})
    expiry = min(expiries, key=lambda e: abs(e - hour - args.dte * 24))
    print(f"{engine.utc(hour):%Y-%m-%d %H:%M} UTC  expiries: " + ", ".join(f"{engine.utc(e):%d%b}({(e - hour) / 24:.1f}d)" for e in expiries[:10]))
    rows = sorted((q for q in chain if q.expiry == expiry and 0.02 <= abs(q.delta) <= 0.6), key=lambda q: (q.strike, not q.is_call))
    print(f"expiry {engine.utc(expiry):%Y-%m-%d %H:%M}, forward {rows[0].forward if rows else chain[0].forward:,.0f}; |delta| 0.02-0.60:")
    print("   strike  type  delta    iv     bid    mark     ask")
    for q in rows:
        price = lambda value: f"{value:7,.0f}" if value == value and value > 0 else "      -"
        print(f"  {q.strike:7,.0f}  {'call' if q.is_call else 'put ':4}  {q.delta:+.2f}  {q.iv:5.1%} {price(q.bid)} {price(q.mark)} {price(q.ask)}")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] in ("inspect", "convert", "slim", "verify"):
        from . import parquet
        return parquet.main(argv)
    parser = argparse.ArgumentParser(prog="bt", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    pair = lambda text: tuple(text.split("=", 1)) if "=" in text else parser.error(f"--set expects PATH=VALUE, got {text!r}")
    for name in ("run", "sweep"):
        command = commands.add_parser(name)
        command.add_argument("spec")
        command.add_argument("--set", action="append", default=[], type=pair, metavar="PATH=VALUE")
        command.add_argument("--data", help="folder of YYYY-MM.parquet files (default $OPTBT_DATA or ~/data/options_hourly/BTC)")
        command.add_argument("--out", help=f"result folder (default {RESULTS}/<name>/<utc time>)")
    commands.choices["run"].add_argument("--json", action="store_true", help="print the summary as one JSON line")
    commands.choices["sweep"].add_argument("--sort", default="total", help="column to sort by (default total)")
    commands.choices["sweep"].add_argument("--top", type=int, default=20)
    chain = commands.add_parser("chain")
    chain.add_argument("hour", help="UTC hour label, e.g. 2025-01-03T21")
    chain.add_argument("--dte", type=float, default=2)
    chain.add_argument("--data")
    commands.add_parser("examples")
    args = parser.parse_args(argv)
    try:
        if args.command == "examples":
            for path in sorted(specs.EXAMPLES.glob("*.json")):
                print(f"{path.stem}: {json.loads(path.read_text(encoding='utf-8')).get('description', '')}")
            return 0
        return {"run": run_command, "sweep": sweep_command, "chain": chain_command}[args.command](args)
    except specs.SpecError as exc:
        sys.exit(f"spec error: {exc}")

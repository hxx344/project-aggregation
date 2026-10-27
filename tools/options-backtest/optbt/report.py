"""Summary statistics, compact text output and result files."""
import csv
import json
import math
from collections import Counter
from statistics import mean, median, pstdev

from .engine import utc


def drawdown(pnls):
    peak = equity = worst = 0.0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return worst


def summarize(trades, skipped, window):
    trades = sorted(trades, key=lambda trade: (trade["exit_hour"], trade["entry_hour"]))
    summary = {"window": [utc(window[0]).strftime("%Y-%m-%d %H:%M"), utc(window[1]).strftime("%Y-%m-%d %H:%M")],
               "trades": len(trades), "skipped": dict(sorted(skipped.items()))}
    if not trades:
        return summary
    pnls = [trade["pnl"] for trade in trades]
    years = max((trades[-1]["exit_hour"] - trades[0]["entry_hour"]) / 8760, 1 / 52)
    deviation = pstdev(pnls) if len(pnls) > 1 else 0.0
    margins = [trade["margin"] for trade in trades if trade["margin"] > 0]
    by_year = {}
    for trade in trades:
        row = by_year.setdefault(trade["entry"][:4], {"trades": 0, "pnl": 0.0, "wins": 0})
        row["trades"] += 1
        row["pnl"] = round(row["pnl"] + trade["pnl"], 2)
        row["wins"] += trade["pnl"] > 0
    fills = sum(trade["fills"] for trade in trades)
    summary.update({
        "total_pnl": round(sum(pnls), 2), "mean_pnl": round(mean(pnls), 2), "median_pnl": round(median(pnls), 2),
        "win_rate": round(sum(p > 0 for p in pnls) / len(pnls), 4), "best": max(pnls), "worst": min(pnls),
        "max_drawdown": round(drawdown(pnls), 2),
        "sharpe": round(mean(pnls) / deviation * math.sqrt(len(pnls) / years), 2) if deviation > 0 else None,
        "mean_credit": round(mean(trade["credit"] for trade in trades), 2), "total_fees": round(sum(trade["fees"] for trade in trades), 2),
        "mean_margin": round(mean(margins), 2) if margins else None,
        "mean_return_on_margin": round(mean(trade["pnl"] / trade["margin"] for trade in trades if trade["margin"] > 0), 4) if margins else None,
        "worst_open_pnl": min(trade["worst_open_pnl"] for trade in trades),
        "exits": dict(Counter(trade["reason"] for trade in trades).most_common()),
        "fallback_fill_rate": round(sum(trade["fallback_fills"] for trade in trades) / fills, 4) if fills else 0.0,
        "by_year": by_year,
    })
    if any(trade.get("trend") for trade in trades):
        by_trend = summary["by_trend"] = {}
        for trade in trades:
            row = by_trend.setdefault(trade["trend"], {"trades": 0, "pnl": 0.0, "wins": 0})
            row["trades"] += 1
            row["pnl"] = round(row["pnl"] + trade["pnl"], 2)
            row["wins"] += trade["pnl"] > 0
    if any(trade.get("perp_pnl") or trade.get("funding") for trade in trades):
        summary["perp_pnl"] = round(sum(trade.get("perp_pnl", 0.0) for trade in trades), 2)
        summary["funding"] = round(sum(trade.get("funding", 0.0) for trade in trades), 2)
        summary["options_pnl"] = round(summary["total_pnl"] - summary["perp_pnl"] + summary["funding"], 2)  # incl. all fees
    return summary


def money(value):
    return "-" if value is None else f"{'-' if value < 0 else '+'}${abs(value):,.0f}"


def text(spec, summary):
    lines = [f"{spec['name']}  {summary['window'][0]} .. {summary['window'][1]} UTC  fill={spec['fill']}  qty={spec['qty']:g}"]
    if not summary["trades"]:
        return lines + [f"no trades; skipped entries: {summary['skipped'] or 'none'}"]
    s = summary
    roi = "-" if s["mean_return_on_margin"] is None else f"{s['mean_return_on_margin']:.2%}"
    lines += [
        f"trades {s['trades']}  win {s['win_rate']:.1%}  total {money(s['total_pnl'])}  mean {money(s['mean_pnl'])}  median {money(s['median_pnl'])}",
        f"best {money(s['best'])}  worst {money(s['worst'])}  max drawdown {money(s['max_drawdown'])}  worst open {money(s['worst_open_pnl'])}  sharpe {s['sharpe'] if s['sharpe'] is not None else '-'}",
        f"mean credit {money(s['mean_credit'])}  fees {money(s['total_fees'])}  mean margin {money(s['mean_margin'])}  mean return/margin {roi}",
        "exits " + ", ".join(f"{reason} {count}" for reason, count in s["exits"].items())
        + f"  mark-fallback fills {s['fallback_fill_rate']:.1%}" + (f"  skipped {s['skipped']}" if s["skipped"] else ""),
        *([f"perp leg price {money(s['perp_pnl'])}  funding paid {money(s['funding'])}  options and all fees {money(s['options_pnl'])}"]
          if "perp_pnl" in s else []),
        "by year " + " | ".join(f"{year} {money(row['pnl'])} ({row['trades']}, win {row['wins'] / row['trades']:.0%})" for year, row in s["by_year"].items()),
        *([f"by trend ({spec['trend']['ma_days']}-day mean) " + " | ".join(
            f"{state} {money(row['pnl'])} ({row['trades']}, win {row['wins'] / row['trades']:.0%})" for state, row in sorted(s["by_trend"].items()))]
          if "by_trend" in s else []),
    ]
    return lines


TRADE_FIELDS = ["entry", "exit", "reason", "legs", "deltas", "forward", "settlement", "credit", "fees", "pnl", "margin", "max_loss",
                "worst_open_pnl", "fallback_fills", "missing_hours", "perp_pnl", "funding", "trend"]


def write(directory, spec, trades, summary):
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / "trades.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, TRADE_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted(trades, key=lambda trade: trade["entry_hour"]))
    public = {key: value for key, value in spec.items() if key not in ("start_hour", "end_hour")}
    (directory / "spec.json").write_text(json.dumps(public, indent=2, ensure_ascii=False), encoding="utf-8")
    (directory / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

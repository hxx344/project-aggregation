"""Portfolio-level option Greeks for the current BTC option positions.

Bybit V5 option tickers report per-contract greeks for one unit of the
underlying (BTC options trade in BTC quantity): delta in BTC, gamma as delta
change per 1 USD move, vega in USD per 1% IV and theta in USD per day.
Totals are signed quantity sums: Buy (long) adds, Sell (short) subtracts.
"""
from datetime import datetime, timezone
from math import isfinite
from typing import Iterable

GREEKS = ("delta", "gamma", "vega", "theta")
UNITS = {"delta": "BTC", "gamma": "BTC / USD", "vega": "USD / 1% IV", "theta": "USD / 天"}


def ticker_greeks(ticker: dict) -> dict[str, float | None]:
    """Parse one ticker; absent, blank or non-finite fields stay unknown instead of zero."""
    result: dict[str, float | None] = {}
    for name in GREEKS:
        raw = ticker.get(name) if isinstance(ticker, dict) else None
        try:
            value = float(raw) if raw is not None and str(raw).strip() != "" else None
        except (TypeError, ValueError):
            value = None
        result[name] = value if value is not None and isfinite(value) else None
    return result


def summarize_position_greeks(positions: Iterable, greeks_by_symbol: dict[str, dict], *, market_updated_at: datetime | None,
                              positions_available: bool, stale_seconds: float, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    counted = []
    for position in positions or []:
        size = getattr(position, "size", None)
        if not isinstance(size, (int, float)) or not isfinite(size) or size == 0:
            continue
        counted.append(position)
    age = (now - market_updated_at).total_seconds() if market_updated_at else None
    stale = (not positions_available) or age is None or age < 0 or age > stale_seconds
    base = {"position_count": len(counted), "positions_available": bool(positions_available),
            "market_updated_at": market_updated_at.isoformat() if market_updated_at else None,
            "stale": stale, "units": dict(UNITS)}
    empty_totals = {name: None for name in GREEKS}
    if not counted:
        return {**base, "status": "empty", "totals": empty_totals, "missing": {name: [] for name in GREEKS}}
    if market_updated_at is None:
        return {**base, "status": "unavailable", "totals": empty_totals,
                "missing": {name: sorted({p.symbol for p in counted}) for name in GREEKS}}
    totals: dict[str, float | None] = {name: 0.0 for name in GREEKS}
    missing: dict[str, set[str]] = {name: set() for name in GREEKS}
    for position in counted:
        sign = 1.0 if position.side == "Buy" else -1.0 if position.side == "Sell" else None
        greeks = greeks_by_symbol.get(position.symbol) or {}
        for name in GREEKS:
            value = greeks.get(name)
            if sign is None or not isinstance(value, (int, float)) or not isfinite(value):
                missing[name].add(position.symbol)
                continue
            totals[name] += sign * abs(position.size) * value
    for name in GREEKS:
        if missing[name]:
            totals[name] = None
    complete = all(totals[name] is not None for name in GREEKS)
    none_known = all(totals[name] is None for name in GREEKS)
    status = "ok" if complete else "unavailable" if none_known else "partial"
    return {**base, "status": status, "totals": totals, "missing": {name: sorted(values) for name, values in missing.items()}}

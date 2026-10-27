"""Hour-by-hour option strategy simulation on raw quotes (standard library only).

Hour H means the latest snapshot taken in (H-1h, H], so acting at H never uses later
quotes. Prices are USD per 1 BTC contract; Deribit data stands in for Bybit, and the
fee and margin formulas follow the live strategy (modules/greeks/app/strategy.py).
"""
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from statistics import median
from typing import Optional, Protocol

from .pricing import YEAR_SECONDS, black, payoff


@dataclass(frozen=True)
class Quote:
    expiry: int        # UTC hours since epoch
    strike: float
    is_call: bool
    time: float        # snapshot time, epoch seconds
    forward: float     # the contract's own underlying (forward) price
    iv: float          # mark IV as a fraction
    mark: float        # USD
    bid: float         # USD, nan when there is no bid
    ask: float         # USD, nan when there is no ask

    @property
    def years(self):
        return max(0.0, (self.expiry * 3600 - self.time) / YEAR_SECONDS)

    @property
    def delta(self):
        return black(self.forward, self.strike, self.years, self.iv, self.is_call)[1]


class Market(Protocol):
    def span(self) -> tuple[int, int]: ...
    def chain(self, hour: int) -> list[Quote]: ...
    def quote(self, hour: int, expiry: int, strike: float, is_call: bool) -> Optional[Quote]: ...
    def settlement(self, expiry: int) -> Optional[float]: ...


@dataclass
class Leg:
    index: int
    sign: int          # +1 long, -1 short
    expiry: int
    strike: float
    is_call: bool
    qty: float
    price: float       # entry fill, USD
    delta: float
    iv: float

    @property
    def label(self):
        day = datetime.fromtimestamp(self.expiry * 3600, timezone.utc).strftime("%d%b%y").upper().lstrip("0")
        return f"{'+' if self.sign > 0 else '-'}{self.qty:g} {day}-{self.strike:g}-{'C' if self.is_call else 'P'}"


@dataclass
class Position:
    entry_hour: int
    legs: list
    credit: float      # premium received minus premium paid
    fees: float
    margin: float
    max_loss: Optional[float]
    forward: float
    fallback_fills: int
    worst: float = math.inf  # worst marked P&L while open (fees included)
    marked_hours: int = 0
    missing_hours: int = 0
    extra: dict = field(default_factory=dict)

    @property
    def expiry(self):
        return min(leg.expiry for leg in self.legs)


def utc(hour):
    return datetime.fromtimestamp(hour * 3600, timezone.utc)


def fill_price(quote, buy, model):
    """(price, used_mark_fallback) for one fill under the spec's fill model."""
    bid = quote.bid if quote.bid > 0 else math.nan
    ask = quote.ask if quote.ask > 0 else math.nan
    if model == "mark":
        return quote.mark, False
    if model == "mid":
        return ((bid + ask) / 2, False) if ask >= bid else (quote.mark, True)
    wanted = ask if (model == "cross") == buy else bid  # cross: buy at ask, sell at bid; passive: the reverse
    return (wanted, False) if wanted > 0 else (quote.mark, True)


def trade_fee(fees, forward, price, qty):
    return min(fees["rate"] * forward, fees["cap_pct"] * price) * qty


def choose_expiry(expiries, hour, rule):
    candidates = sorted(e for e in expiries if e - hour >= rule["min_hours"])
    if rule["weekday"] is not None:
        return next((e for e in candidates if utc(e).weekday() == rule["weekday"]), None)
    target = hour + rule["dte"] * 24
    return min(candidates, key=lambda e: (abs(e - target), e), default=None)


def max_loss(legs, credit):
    """Worst expiry loss for single-expiry structures; None when unbounded or calendar."""
    if len({leg.expiry for leg in legs}) != 1:
        return None
    if sum(leg.sign * leg.qty for leg in legs if leg.is_call) < 0:
        return None
    value = lambda s: sum(leg.sign * leg.qty * payoff(s, leg.strike, leg.is_call) for leg in legs)
    worst = min(value(s) for s in [0.0] + [leg.strike for leg in legs])
    return max(0.0, -(worst + credit))


def regular_margin(legs, quotes, spec, forward):
    """Bybit regular option Order IM (same formula as app/risk.py short_order_margin), longs pay premium + fee."""
    m, total = spec["margin"], 0.0
    for leg, quote in zip(legs, quotes):
        qty, price = leg.qty, leg.price
        fee = trade_fee(spec["fees"], forward, price, qty)
        if leg.sign > 0:
            total += price * qty + fee
            continue
        otm = max(0.0, leg.strike - forward) if leg.is_call else max(0.0, forward - leg.strike)
        position_mm = (max(m["mm_factor"] * forward, m["mm_factor"] * quote.mark) + quote.mark + m["liquidation_fee_rate"] * forward) * qty
        order_im = (max(m["max_im_factor"] * forward - otm, m["min_im_factor"] * forward) + max(price, quote.mark)) * qty
        total += max(order_im, position_mm) + fee - price * qty
    return total


def open_position(chain, hour, spec):
    """Select legs by delta and fill them; returns (Position, None) or (None, skip reason)."""
    if not chain:
        return None, "no_data"
    by_expiry = {}
    for quote in chain:
        if quote.mark > 0 and quote.iv > 0 and quote.forward > 0 and quote.years > 0:
            by_expiry.setdefault(quote.expiry, []).append(quote)
    legs, quotes, fallbacks = [], [], 0
    for index, leg_spec in enumerate(spec["legs"]):
        expiry = choose_expiry(by_expiry, hour, leg_spec["expiry"] or spec["expiry"])
        if expiry is None:
            return None, "no_expiry"
        is_call = leg_spec["type"] == "call"
        options = [q for q in sorted(by_expiry[expiry], key=lambda q: q.strike) if q.is_call == is_call]
        if leg_spec["beyond"] is not None:
            inner = legs[leg_spec["beyond"]].strike
            options = [q for q in options if (q.strike > inner if is_call else q.strike < inner)]
        if not options:
            return None, "no_strike"
        quote = min(options, key=lambda q: abs(abs(q.delta) - leg_spec["delta"]))
        sign = 1 if leg_spec["side"] == "buy" else -1
        price, fallback = fill_price(quote, sign > 0, spec["fill"])
        fallbacks += fallback
        legs.append(Leg(index, sign, quote.expiry, quote.strike, quote.is_call, leg_spec["qty"] * spec["qty"], price, quote.delta, quote.iv))
        quotes.append(quote)
    forward = median(q.forward for q in quotes)
    credit = sum(-leg.sign * leg.price * leg.qty for leg in legs)
    fees = sum(trade_fee(spec["fees"], q.forward, leg.price, leg.qty) for leg, q in zip(legs, quotes))
    loss = max_loss(legs, credit - fees)
    margin = regular_margin(legs, quotes, spec, forward) if spec["margin"]["mode"] == "regular" or loss is None else loss
    return Position(hour, legs, credit, fees, margin, loss, forward, fallbacks), None


def close_value(position, quotes, spec):
    """(cash from closing every leg now, close fees, fallback fills) at the spec's fill model."""
    cash = fees = 0.0
    fallbacks = 0
    for leg, quote in zip(position.legs, quotes):
        price, fallback = fill_price(quote, leg.sign < 0, spec["fill"])
        fallbacks += fallback
        cash += leg.sign * price * leg.qty
        fees += trade_fee(spec["fees"], quote.forward, price, leg.qty)
    return cash, fees, fallbacks


def finish(position, hour, reason, cash, fees, settlement=None, fallbacks=0):
    pnl = position.credit - position.fees + cash - fees
    return {
        "entry": utc(position.entry_hour).strftime("%Y-%m-%d %H:%M"), "exit": utc(hour).strftime("%Y-%m-%d %H:%M"),
        "entry_hour": position.entry_hour, "exit_hour": hour, "reason": reason,
        "legs": " ".join(leg.label for leg in position.legs),
        "deltas": " ".join(f"{leg.delta:+.2f}" for leg in position.legs),
        "forward": round(position.forward, 2), "settlement": None if settlement is None else round(settlement, 2),
        "credit": round(position.credit, 2), "fees": round(position.fees + fees, 2), "pnl": round(pnl, 2),
        "margin": round(position.margin, 2), "max_loss": None if position.max_loss is None else round(position.max_loss, 2),
        "worst_open_pnl": round(min(position.worst, pnl), 2), "fallback_fills": position.fallback_fills + fallbacks,
        "fills": len(position.legs) + sum(reason != "expiry" or leg.expiry != position.expiry for leg in position.legs),
        "missing_hours": position.missing_hours,
    }


def settle(position, market, hour, spec, price):
    """Settle legs expiring now at `price`; close any later legs at market."""
    cash = fees = 0.0
    fallbacks = 0
    for leg in position.legs:
        if leg.expiry == position.expiry:
            value = payoff(price, leg.strike, leg.is_call)
            cash += leg.sign * value * leg.qty
            fees += min(spec["fees"]["settle_rate"] * price, spec["fees"]["settle_cap_pct"] * value) * leg.qty
            continue
        quote = market.quote(hour, leg.expiry, leg.strike, leg.is_call)
        if quote is None:
            return None
        fill, fallback = fill_price(quote, leg.sign < 0, spec["fill"])
        fallbacks += fallback
        cash += leg.sign * fill * leg.qty
        fees += trade_fee(spec["fees"], quote.forward, fill, leg.qty)
    return finish(position, hour, "expiry", cash, fees, settlement=price, fallbacks=fallbacks)


def step(position, market, hour, spec):
    """Mark an open position at `hour`; returns a finished trade when an exit fires."""
    if hour >= position.expiry:
        price = market.settlement(position.expiry)
        if price is not None:
            return settle(position, market, hour, spec, price)
        if hour - position.expiry >= 6 and "last_forward" in position.extra:
            trade = settle(position, market, hour, spec, position.extra["last_forward"])
            return trade and {**trade, "reason": "expiry_last_forward"}
        return None
    quotes = [market.quote(hour, leg.expiry, leg.strike, leg.is_call) for leg in position.legs]
    if any(quote is None for quote in quotes):
        position.missing_hours += 1
        return None
    position.marked_hours += 1
    position.extra["last_forward"] = median(q.forward for q, leg in zip(quotes, position.legs) if leg.expiry == position.expiry)
    marked = position.credit - position.fees + sum(leg.sign * q.mark * leg.qty for leg, q in zip(position.legs, quotes))
    position.worst = min(position.worst, marked)
    exits = spec["exit"]
    cash, fees, fallbacks = close_value(position, quotes, spec)
    pnl = position.credit - position.fees + cash - fees
    basis = abs(position.credit)
    reason = None
    if exits["take_profit_pct"] is not None and pnl >= exits["take_profit_pct"] * basis:
        reason = "take_profit"
    elif exits["stop_loss_pct"] is not None and pnl <= -exits["stop_loss_pct"] * basis:
        reason = "stop_loss"
    elif exits["close_hours_before_expiry"] is not None and hour >= position.expiry - exits["close_hours_before_expiry"]:
        reason = "time_exit"
    return finish(position, hour, reason, cash, fees, fallbacks=fallbacks) if reason else None


def is_entry_hour(hour, spec):
    moment = utc(hour)
    weekdays = spec["entry"]["weekdays"]
    return moment.hour in spec["entry"]["hours"] and (weekdays is None or moment.weekday() in weekdays)


def run(spec, market, progress=None):
    """Simulate a validated spec; returns (trades, skipped entries by reason, (first, last) hour)."""
    first, last = market.span()
    start = max(first, spec["start_hour"] if spec["start_hour"] is not None else first)
    end = min(last, spec["end_hour"] if spec["end_hour"] is not None else last)
    trades, skipped, open_positions = [], {}, []
    hour = start
    while hour <= last and (hour <= end or open_positions):
        still_open = []
        for position in open_positions:
            trade = step(position, market, hour, spec)
            if trade:
                trades.append(trade)
            else:
                still_open.append(position)
        open_positions = still_open
        if hour <= end and is_entry_hour(hour, spec):
            if len(open_positions) >= spec["max_open"]:
                skipped["max_open"] = skipped.get("max_open", 0) + 1
            else:
                position, reason = open_position(market.chain(hour), hour, spec)
                if position:
                    open_positions.append(position)
                else:
                    skipped[reason] = skipped.get(reason, 0) + 1
            if progress:
                progress(hour, len(trades))
        hour += 1
    for position in open_positions:
        skipped["open_at_data_end"] = skipped.get("open_at_data_end", 0) + 1
    return trades, skipped, (start, end)

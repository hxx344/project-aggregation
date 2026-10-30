"""Hour-by-hour option strategy simulation on raw quotes (standard library only).

Hour H means the latest snapshot taken in (H-1h, H], so acting at H never uses later
quotes. Prices are USD per 1 BTC contract; Deribit data stands in for Bybit, and the
fee and margin formulas follow the live strategy (modules/greeks/app/strategy.py).
"""
import math
from collections import deque
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
    def perp(self, hour: int) -> Optional[float]: ...
    def funding(self, after: int, upto: int) -> float: ...


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
    is_perp: bool = False  # Binance perpetual: price = entry price, expiry = the position's option expiry

    @property
    def label(self):
        day = datetime.fromtimestamp(self.expiry * 3600, timezone.utc).strftime("%d%b%y").upper().lstrip("0")
        kind = "PERP" if self.is_perp else f"{self.strike:g}-{'C' if self.is_call else 'P'}"
        return f"{'+' if self.sign > 0 else '-'}{self.qty:g} {day}-{kind}"

    def value(self, price):
        """Cash value of one contract at `price`: an option's premium, a perp's gain since entry."""
        return price - self.price if self.is_perp else price


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


def leg_fee(fees, leg, forward, price):
    return fees["perp_rate"] * price * leg.qty if leg.is_perp else trade_fee(fees, forward, price, leg.qty)


def perp_quote(price, expiry, hour):
    """The perpetual at `price` as a spread-free quote (every fill model fills at that price)."""
    return None if price is None else Quote(expiry, 0.0, False, hour * 3600, price, 0.0, price, price, price)


def funding(position, market, upto):
    """Funding the position's perp legs paid from entry through `upto` (negative when received)."""
    return sum(leg.sign * leg.qty * market.funding(position.entry_hour, upto) for leg in position.legs if leg.is_perp)


def choose_expiry(expiries, hour, rule):
    """An expiry still alive at decision hour `hour` (strictly later, whatever min_hours allows)."""
    candidates = sorted(e for e in expiries if e > hour and e - hour >= rule["min_hours"])
    if rule["weekday"] is not None:
        return next((e for e in candidates if utc(e).weekday() == rule["weekday"]), None)
    target = hour + rule["dte"] * 24
    return min(candidates, key=lambda e: (abs(e - target), e), default=None)


def max_loss(legs, credit):
    """Worst expiry loss for single-expiry structures; None when unbounded or calendar."""
    if len({leg.expiry for leg in legs}) != 1:
        return None
    if sum(leg.sign * leg.qty for leg in legs if leg.is_call or leg.is_perp) < -1e-9:  # tolerate float qty sums like 0.1+0.2-0.3
        return None
    value = lambda s: sum(leg.sign * leg.qty * (s - leg.price if leg.is_perp else payoff(s, leg.strike, leg.is_call)) for leg in legs)
    worst = min(value(s) for s in [0.0] + [leg.strike for leg in legs])
    return max(0.0, -(worst + credit))


def regular_margin(legs, quotes, spec, forward):
    """Bybit regular option Order IM (same formula as app/risk.py short_order_margin), longs pay premium + fee."""
    m, total = spec["margin"], 0.0
    for leg, quote in zip(legs, quotes):
        qty, price = leg.qty, leg.price
        fee = leg_fee(spec["fees"], leg, forward, price)
        if leg.is_perp:
            total += m["perp_im"] * price * qty + fee
            continue
        if leg.sign > 0:
            total += price * qty + fee
            continue
        otm = max(0.0, leg.strike - forward) if leg.is_call else max(0.0, forward - leg.strike)
        position_mm = (max(m["mm_factor"] * forward, m["mm_factor"] * quote.mark) + quote.mark + m["liquidation_fee_rate"] * forward) * qty
        order_im = (max(m["max_im_factor"] * forward - otm, m["min_im_factor"] * forward) + max(price, quote.mark)) * qty
        total += max(order_im, position_mm) + fee - price * qty
    return total


def trend_state(market, hour, days):
    """"above"/"below": the perp price at `hour` against the mean of the `days` x 24 hourly closes up to
    and including it; None when that price or more than 10% of the window is missing. Reference for
    TrendWindow, which run() uses."""
    window = [market.perp(h) for h in range(hour - days * 24 + 1, hour + 1)]
    known = [price for price in window if price is not None]
    if window[-1] is None or len(known) < 0.9 * len(window):
        return None
    return "above" if window[-1] > sum(known) / len(known) else "below"


class TrendWindow:
    """trend_state() for hours that only move forward, as in run(): each close is read once and the
    window keeps a running sum, so long means and hourly entries stay cheap."""

    def __init__(self, market, days):
        self.market, self.size = market, days * 24
        self.window, self.total, self.known, self.last = deque(), 0.0, 0, None

    def state(self, hour):
        first = hour - self.size + 1
        if self.last is None or self.last < first - 1 or hour < self.last:
            self.window, self.total, self.known, self.last = deque(), 0.0, 0, first - 1
        for h in range(self.last + 1, hour + 1):
            price = self.market.perp(h)
            self.window.append((h, price))
            if price is not None:
                self.total += price
                self.known += 1
        self.last = max(self.last, hour)
        while self.window[0][0] < first:
            _, price = self.window.popleft()
            if price is not None:
                self.total -= price
                self.known -= 1
        price = self.window[-1][1]
        if price is None or self.known < 0.9 * self.size:
            return None
        return "above" if price > self.total / self.known else "below"


def active_legs(spec, state):
    """(index, leg spec) pairs traded in trend `state`; legs without `when` always trade."""
    return [(index, leg) for index, leg in enumerate(spec["legs"]) if leg["when"] in (None, state)]


def perp_signature(spec, state):
    """What a perp leg opened in `state` holds, comparable with a closed trade's `_carry` signature."""
    return tuple((leg["side"], leg["qty"] * spec["qty"]) for _, leg in active_legs(spec, state) if leg["type"] == "perp")


def open_position(chain, hour, spec, perp=None, carry=False, state=None):
    """Select legs by delta and fill them; returns (Position, None) or (None, skip reason).

    `state` is the trend state ("above"/"below") that picks the legs with a matching `when`.

    `perp` is the perpetual price at `hour`; perp legs close with the position's first option expiry.
    `carry` means the previous position's perp closed this same hour, so the perp is simply held on and
    pays no entry fee; run() also refunds that previous close fee, leaving one open and one close fee."""
    chosen = active_legs(spec, state)
    if not chosen:
        return None, f"flat_{state}"
    if not chain:
        return None, "no_data"
    by_expiry = {}
    for quote in chain:
        # The contract must be alive at the decision hour; `years` (time left at the quote's own
        # snapshot) only says the quote can be priced: a 07:59 snapshot labelled 08:00 is not tradable at 08:00.
        if quote.expiry > hour and quote.mark > 0 and quote.iv > 0 and quote.forward > 0 and quote.years > 0:
            by_expiry.setdefault(quote.expiry, []).append(quote)
    legs, quotes, fallbacks = [], [], 0
    for index, leg_spec in chosen:
        sign = 1 if leg_spec["side"] == "buy" else -1
        if leg_spec["type"] == "perp":
            continue
        expiry = choose_expiry(by_expiry, hour, leg_spec["expiry"] or spec["expiry"])
        if expiry is None:
            return None, "no_expiry"
        is_call = leg_spec["type"] == "call"
        options = [q for q in sorted(by_expiry[expiry], key=lambda q: q.strike) if q.is_call == is_call]
        if leg_spec["beyond"] is not None:
            inner = next(leg.strike for leg in legs if leg.index == leg_spec["beyond"])
            options = [q for q in options if (q.strike > inner if is_call else q.strike < inner)]
        if not options:
            return None, "no_strike"
        quote = min(options, key=lambda q: abs(abs(q.delta) - leg_spec["delta"]))
        price, fallback = fill_price(quote, sign > 0, spec["fill"])
        fallbacks += fallback
        legs.append(Leg(index, sign, quote.expiry, quote.strike, quote.is_call, leg_spec["qty"] * spec["qty"], price, quote.delta, quote.iv))
        quotes.append(quote)
    for index, leg_spec in chosen:
        if leg_spec["type"] == "perp":
            if perp is None:
                return None, "no_perp"
            expiry = min(leg.expiry for leg in legs)
            legs.append(Leg(index, 1 if leg_spec["side"] == "buy" else -1, expiry, 0.0, False, leg_spec["qty"] * spec["qty"], perp, 1.0, 0.0, is_perp=True))
            quotes.append(perp_quote(perp, expiry, hour))
    order = sorted(range(len(legs)), key=lambda i: legs[i].index)
    legs, quotes = [legs[i] for i in order], [quotes[i] for i in order]
    forward = median(q.forward for q, leg in zip(quotes, legs) if not leg.is_perp)
    credit = sum(-leg.sign * leg.price * leg.qty for leg in legs if not leg.is_perp)
    fees = sum(leg_fee(spec["fees"], leg, q.forward, leg.price) for leg, q in zip(legs, quotes) if not (carry and leg.is_perp))
    loss = max_loss(legs, credit - fees)
    margin = regular_margin(legs, quotes, spec, forward) if spec["margin"]["mode"] == "regular" or loss is None else loss
    return Position(hour, legs, credit, fees, margin, loss, forward, fallbacks, extra={"trend": state}), None


def close_value(position, quotes, spec):
    """(cash from closing every leg now, close fees, fallback fills) at the spec's fill model."""
    cash = fees = 0.0
    fallbacks = 0
    for leg, quote in zip(position.legs, quotes):
        price, fallback = fill_price(quote, leg.sign < 0, spec["fill"])
        fallbacks += fallback
        cash += leg.sign * leg.value(price) * leg.qty
        fees += leg_fee(spec["fees"], leg, quote.forward, price)
    return cash, fees, fallbacks


def finish(position, hour, reason, cash, fees, settlement=None, fallbacks=0, paid_funding=0.0, perp_pnl=0.0, perp_fee=0.0, carried=True, fills=None):
    """`fills` counts the closing fills (default: every leg); legs settled at a delivery price have none."""
    pnl = position.credit - position.fees + cash - fees - paid_funding
    return {
        "entry": utc(position.entry_hour).strftime("%Y-%m-%d %H:%M"), "exit": utc(hour).strftime("%Y-%m-%d %H:%M"),
        "entry_hour": position.entry_hour, "exit_hour": hour, "reason": reason,
        "legs": " ".join(leg.label for leg in position.legs),
        "deltas": " ".join(f"{leg.delta:+.2f}" for leg in position.legs),
        "forward": round(position.forward, 2), "settlement": None if settlement is None else round(settlement, 2),
        "credit": round(position.credit, 2), "fees": round(position.fees + fees, 2), "pnl": round(pnl, 2),
        "margin": round(position.margin, 2), "max_loss": None if position.max_loss is None else round(position.max_loss, 2),
        "worst_open_pnl": round(min(position.worst, pnl), 2), "fallback_fills": position.fallback_fills + fallbacks,
        "fills": len(position.legs) + (len(position.legs) if fills is None else fills),
        "missing_hours": position.missing_hours, "perp_pnl": round(perp_pnl, 2), "funding": round(paid_funding, 2),
        "trend": position.extra.get("trend"),
        # run() refunds the perp close fee when the next position holds the perp on from this same hour and price
        "_carry": (perp_fee, position.worst, tuple(("buy" if leg.sign > 0 else "sell", leg.qty) for leg in position.legs if leg.is_perp))
        if carried and any(leg.is_perp for leg in position.legs) else None,
    }


def delivery(position, market, hour, expiry):
    """(delivery price, taken from the last marked forward) for one expiry the position holds, or None
    while unknown. Six hours after that expiry without an estimate, the forward its legs had at the
    last marked hour stands in."""
    price = market.settlement(expiry)
    if price is not None:
        return price, False
    last = position.extra.get("last_forward", {}).get(expiry)
    if hour - expiry >= 6 and last is not None:
        return last, True
    return None


def settle(position, market, hour, spec):
    """From the first expiry on: settle every option leg already expired at `hour` at its own expiry's
    delivery price (never at a pre-expiry quote) and close the live legs at market. Returns None while
    an expired leg has no delivery price or a live leg has no quote, noting which in extra["pending"]."""
    prices = {}
    for expiry in sorted({leg.expiry for leg in position.legs if not leg.is_perp and leg.expiry <= hour}):
        prices[expiry] = delivery(position, market, hour, expiry)
        if prices[expiry] is None:
            position.extra["pending"] = "settlement"
            return None
    price = prices[position.expiry][0]
    cash = fees = perp_pnl = perp_fee = 0.0
    fallbacks = fills = 0
    carried = False
    for leg in position.legs:
        if leg.is_perp:  # closed at the option expiry hour's perp price (delivery estimate if missing)
            close = market.perp(position.expiry)
            carried = close is not None and hour == position.expiry
            close = close or price
            perp_pnl += leg.sign * leg.value(close) * leg.qty
            perp_fee += leg_fee(spec["fees"], leg, close, close)
            fills += 1
            continue
        if leg.expiry in prices:
            delivered = prices[leg.expiry][0]
            value = payoff(delivered, leg.strike, leg.is_call)
            cash += leg.sign * value * leg.qty
            fees += min(spec["fees"]["settle_rate"] * delivered, spec["fees"]["settle_cap_pct"] * value) * leg.qty
            continue
        quote = market.quote(hour, leg.expiry, leg.strike, leg.is_call)
        if quote is None:
            position.extra["pending"] = "quote"
            return None
        fill, fallback = fill_price(quote, leg.sign < 0, spec["fill"])
        fallbacks += fallback
        fills += 1
        cash += leg.sign * leg.value(fill) * leg.qty
        fees += leg_fee(spec["fees"], leg, quote.forward, fill)
    reason = "expiry_last_forward" if any(stand_in for _, stand_in in prices.values()) else "expiry"
    return finish(position, hour, reason, cash + perp_pnl, fees + perp_fee, settlement=price, fallbacks=fallbacks,
                  paid_funding=funding(position, market, position.expiry), perp_pnl=perp_pnl, perp_fee=perp_fee, carried=carried, fills=fills)


def step(position, market, hour, spec):
    """Mark an open position at `hour`; returns a finished trade when an exit fires."""
    if hour >= position.expiry:
        return settle(position, market, hour, spec)
    quotes = [perp_quote(market.perp(hour), leg.expiry, hour) if leg.is_perp else market.quote(hour, leg.expiry, leg.strike, leg.is_call)
              for leg in position.legs]
    if any(quote is None for quote in quotes):
        position.missing_hours += 1
        return None
    position.marked_hours += 1
    options = [(leg.expiry, q.forward) for leg, q in zip(position.legs, quotes) if not leg.is_perp]
    position.extra["last_forward"] = {expiry: median(f for e, f in options if e == expiry) for expiry, _ in options}
    paid = funding(position, market, hour)
    marked = position.credit - position.fees - paid + sum(leg.sign * leg.value(q.mark) * leg.qty for leg, q in zip(position.legs, quotes))
    position.worst = min(position.worst, marked)
    exits = spec["exit"]
    cash, fees, fallbacks = close_value(position, quotes, spec)
    pnl = position.credit - position.fees + cash - fees - paid
    basis = abs(position.credit)
    reason = None
    if exits["take_profit_pct"] is not None and pnl >= exits["take_profit_pct"] * basis:
        reason = "take_profit"
    elif exits["stop_loss_pct"] is not None and pnl <= -exits["stop_loss_pct"] * basis:
        reason = "stop_loss"
    elif exits["close_hours_before_expiry"] is not None and hour >= position.expiry - exits["close_hours_before_expiry"]:
        reason = "time_exit"
    if not reason:
        return None
    perp_pnl = sum(leg.sign * leg.value(q.mark) * leg.qty for leg, q in zip(position.legs, quotes) if leg.is_perp)
    perp_fee = sum(leg_fee(spec["fees"], leg, q.mark, q.mark) for leg, q in zip(position.legs, quotes) if leg.is_perp)
    return finish(position, hour, reason, cash, fees, fallbacks=fallbacks, paid_funding=paid, perp_pnl=perp_pnl, perp_fee=perp_fee)


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
    days = spec["trend"]["ma_days"]
    trend = TrendWindow(market, days) if days else None
    hour = start
    while hour <= last and (hour <= end or open_positions):
        still_open, closed_perps = [], []
        for position in open_positions:
            trade = step(position, market, hour, spec)
            if trade:
                trades.append(trade)
                if trade["_carry"]:
                    closed_perps.append(trade)
            else:
                still_open.append(position)
        open_positions = still_open
        if hour <= end and is_entry_hour(hour, spec):
            state = None
            if len(open_positions) >= spec["max_open"]:
                skipped["max_open"] = skipped.get("max_open", 0) + 1
            elif trend and (state := trend.state(hour)) is None:
                skipped["no_trend_data"] = skipped.get("no_trend_data", 0) + 1
            else:
                signature = perp_signature(spec, state)
                carry = bool(signature) and any(trade["_carry"][2] == signature for trade in closed_perps)
                perp = market.perp(hour) if signature else None
                position, reason = open_position(market.chain(hour), hour, spec, perp, carry=carry, state=state)
                if position:
                    open_positions.append(position)
                    if carry:  # the same perp was held on, never closed: refund that close fee
                        held = closed_perps.pop(max(i for i, trade in enumerate(closed_perps) if trade["_carry"][2] == signature))
                        fee, worst, _ = held["_carry"]
                        held["fees"] = round(held["fees"] - fee, 2)
                        held["pnl"] = round(held["pnl"] + fee, 2)
                        held["worst_open_pnl"] = round(min(worst, held["pnl"]), 2)
                        held["_carry"] = None
                else:
                    skipped[reason] = skipped.get(reason, 0) + 1
            if progress:
                progress(hour, len(trades))
        hour += 1
    for position in open_positions:  # an expired leg without a delivery price stays unresolved, never guessed
        key = "unsettled_at_data_end" if position.extra.get("pending") == "settlement" else "open_at_data_end"
        skipped[key] = skipped.get(key, 0) + 1
    for trade in trades:
        del trade["_carry"]
    return trades, skipped, (start, end)

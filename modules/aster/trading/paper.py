"""Deterministic paper broker with persistent balances and order receipts."""
from fractions import Fraction
from contextlib import nullcontext
import time

from .exchange import ExchangeError
from .depth import DepthSnapshot
from .models import AccountSnapshot, Book, MarkPrice, MARKET_SYMBOLS, MIN_OPEN_LEVERAGE, Position, Rules, SYMBOLS, TAKER_FEE_ESTIMATE, TIERS, TradingError, dec, floor_step, maintenance_for, positive, require_non_decreasing_leverage, require_supported_leverage, wire


PAPER_BRACKETS = [{"notionalFloor": "0", "notionalCap": "1000000", "maintMarginRatio": "0.025", "cum": "0", "initialLeverage": 20}]


class PaperOrderAbsent(ExchangeError):
    """A successful ledger read confirms no simulated fill was committed."""


class DemoMarket:
    """Explicitly simulated quotes; never used by a live account."""
    demo = True

    def __init__(self):
        self.assets = dict.fromkeys(MARKET_SYMBOLS, "USD1")
        self.rules = {s: Rules(s, dec("0.001"), dec("0.01"), dec("0.001"), dec("10000"), dec("5")) for s in MARKET_SYMBOLS}

    def load_rules(self):
        pass

    def book(self, symbol):
        bid = {"XAUUSD1": dec("4412.01"), "SPCXUSD1": dec("724.18"), "CLUSD1": dec("79.32"),
               "XAGUSD1": dec("52.31")}[symbol]
        return Book(bid, bid + dec("0.01"), dec(50), dec(50), bid + dec("0.005"), time.time())

    def mark_price(self, symbol):
        book = self.book(symbol)
        book.require_fresh()
        return MarkPrice(symbol, book.mark, book.timestamp, time.monotonic() + 3 - (time.time() - book.timestamp))

    def capacities(self, symbol, leverages):
        values = {5: "156800", 10: "85000", 20: "32000"}
        return {v: dec(values[next(t for t in TIERS if t >= v)]) for v in leverages if 1 <= v <= 20}

    def depth(self, symbol):
        book = self.book(symbol)
        # Explicit demo liquidity, separate from the paper broker's fill model.
        return DepthSnapshot.from_response({
            "E": int(book.timestamp * 1000),
            "bids": [[wire(book.bid - book.bid * dec(i) / 10000), "100"] for i in range(10)],
            "asks": [[wire(book.ask + book.ask * dec(i) / 10000), "100"] for i in range(10)],
        }, requested_at=book.timestamp)

    def depth_weight(self, symbols):
        return 0


class PaperBroker:
    mode = "paper"

    def _commit(self, state):
        control = getattr(self, "workspace_control", None)
        with control.mutation() if control is not None else nullcontext():
            self.store.put("paper:" + self.account_id, state)
            self.state = state

    def __init__(self, account_id, market, store, seed=False):
        self.account_id, self.market, self.store = account_id, market, store
        state = store.get("paper:" + account_id)
        created = state is None
        if state is None:
            state = {"wallet": "25000", "positions": {}, "leverages": dict.fromkeys(SYMBOLS, MIN_OPEN_LEVERAGE), "orders": {}}
            for symbol in SYMBOLS:
                for side in ("LONG", "SHORT"):
                    qty = {"XAUUSD1": "5", "SPCXUSD1": "10", "CLUSD1": "30"}[symbol] if seed else "0"
                    state["positions"][symbol + ":" + side] = {"qty": qty, "entry": wire(market.book(symbol).mark) if seed else "0"}
        self._load_state(state, created=created)

    def _load_state(self, state, *, created=False):
        # Extend historical ledgers without reseeding positions, resetting
        # balances or losing durable order receipts. Subsequent loads are free.
        positions, leverages = dict(state["positions"]), dict(state["leverages"])
        for symbol in MARKET_SYMBOLS:
            if symbol in SYMBOLS:
                # Missing historical positions remain an invalid ledger; the
                # migration only initializes markets added for pair trading.
                continue
            leverages.setdefault(symbol, MIN_OPEN_LEVERAGE)
            for side in ("LONG", "SHORT"):
                positions.setdefault(symbol + ":" + side, {"qty": "0", "entry": "0"})
        upgraded = {**state, "positions": positions, "leverages": leverages}
        if upgraded != state or created:
            self._commit(upgraded)
        else:
            self.state = state

    def snapshot(self, symbols, fresh_modes=False):
        started = time.time()
        positions, maintenance, initial, pnl = [], dec(0), dec(0), dec(0)
        for symbol in MARKET_SYMBOLS:
            # An unselected, empty pair-only market needs no live price. Its
            # outage must not disable historical single-account paper ledgers.
            selected = symbol in SYMBOLS or symbol in symbols or any(
                dec(self.state["positions"][symbol + ":" + side]["qty"]) for side in ("LONG", "SHORT"))
            mark = self.market.book(symbol).mark if selected else dec(0)
            for side in ("LONG", "SHORT"):
                row = self.state["positions"][symbol + ":" + side]
                qty, entry = dec(row["qty"]), dec(row["entry"])
                profit = qty * (mark - entry) * (1 if side == "LONG" else -1)
                leverage = self.state["leverages"][symbol]
                mm = maintenance_for(qty * mark, PAPER_BRACKETS)
                maintenance += mm
                initial += qty * mark / leverage
                pnl += profit
                positions.append(Position(symbol, side, qty, entry, mark, leverage, profit, maintenance=mm,
                                          update_time=row.get("updateTime")))
        wallet = dec(self.state["wallet"])
        return AccountSnapshot(wallet + pnl, maintenance, wallet + pnl - initial, wallet, pnl, positions, [], True, False, True,
            started, dict.fromkeys(symbols, TAKER_FEE_ESTIMATE), {s: PAPER_BRACKETS for s in symbols})

    def set_leverage(self, symbol, leverage):
        require_supported_leverage(leverage)
        require_non_decreasing_leverage(self.state["leverages"][symbol], leverage)
        state = {**self.state, "leverages": {**self.state["leverages"], symbol: leverage}}
        self._commit(state)
        return {"symbol": symbol, "leverage": leverage}

    def submit(self, orders):
        responses = []
        for order in orders:
            cid, symbol, side = order["newClientOrderId"], order["symbol"], order["positionSide"]
            if cid in self.state["orders"]:
                responses.append(self.state["orders"][cid])
                continue
            book = self.market.book(symbol)
            qty = positive(order["quantity"])
            buy = order["side"] == "BUY"
            price = book.ask if buy else book.bid
            depth = max(dec(0), book.ask_qty if buy else book.bid_qty)
            if order.get("type") == "MARKET":
                # Only the current BBO depth is known. Model a partial market fill
                # and terminate the remainder instead of inventing deeper liquidity.
                executed = floor_step(min(qty, depth), self.market.rules[symbol].step)
            else:
                limit = dec(order["price"])
                fills = (price <= limit if buy else price >= limit) and qty <= depth
                executed = qty if fills else dec(0)
            position = self.state["positions"][symbol + ":" + side].copy()
            old_qty, old_entry = dec(position["qty"]), dec(position["entry"])
            wallet = self.state["wallet"]
            opening = (side == "LONG" and buy) or (side == "SHORT" and not buy)
            if not opening and qty > old_qty:
                executed = dec(0)
            if executed:
                fee = executed * price * TAKER_FEE_ESTIMATE
                pnl = dec(0) if opening else executed * (price - old_entry) * (1 if side == "LONG" else -1)
                wallet = wire(dec(wallet) + pnl - fee)
                next_qty = old_qty + executed if opening else old_qty - executed
                entry = (old_entry * old_qty + price * executed) / next_qty if opening else old_entry
                position.update(qty=wire(next_qty), entry=wire(entry if next_qty else 0))
            receipt = {"symbol": symbol, "clientOrderId": cid, "positionSide": side, "side": order["side"],
                       "status": "FILLED" if executed == qty else "EXPIRED", "executedQty": wire(executed),
                       "origQty": wire(qty), "avgPrice": wire(price if executed else 0)}
            # Fill time and identity are committed with both balance and receipt;
            # restart recovery must not move a fill into a different UTC day.
            executed_at = time.time()
            if executed:
                position["updateTime"] = int(executed_at * 1000)
            receipt.update(orderId="paper:" + cid, time=int(executed_at * 1000), updateTime=int(executed_at * 1000),
                           paperTrades=[{"trade_id": "paper:" + cid + ":0", "order_id": "paper:" + cid,
                                         "client_id": cid, "symbol": symbol, "position_side": side, "side": order["side"],
                                         "quantity": wire(executed), "price": wire(price),
                                         "notional": wire(Fraction(executed) * Fraction(price)),
                                         "executed_at": executed_at, "time_source": "paper"}] if executed else [])
            state = {**self.state, "wallet": wallet,
                     "positions": {**self.state["positions"], symbol + ":" + side: position},
                     "orders": {**self.state["orders"], cid: receipt}}
            # A simulated fill exists only once balances and its receipt commit.
            # Keep earlier successful legs while a failed leg remains absent.
            self._commit(state)
            responses.append(receipt)
        return responses

    def query(self, symbol, client_id):
        if client_id not in self.state["orders"]:
            # A commit may have succeeded before its acknowledgement failed.
            # Only the durable ledger can prove a simulated order was absent.
            self.reload()
        if client_id not in self.state["orders"]:
            raise PaperOrderAbsent("模拟订单未写入账本", code=-2013)
        return self.state["orders"][client_id]

    def reload(self):
        state = self.store.get("paper:" + self.account_id)
        if state is None:
            raise TradingError("模拟账户账本不存在，无法确认执行结果")
        self._load_state(state)

    def cancel(self, symbol, client_id):
        return self.query(symbol, client_id)

    def save(self):
        self.store.put("paper:" + self.account_id, self.state)

    def close(self):
        pass

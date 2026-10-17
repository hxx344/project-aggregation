"""Authoritative all-symbol REST evidence for ADL reductions only.

These readers do not publish ordinary strategy snapshots, expand the strategy
universe, or authorize opening orders. One-way positions retain BOTH so callers
can send reduceOnly=true; hedge reductions must retain LONG/SHORT and omit it.
V3 contract: https://asterdex.github.io/aster-api-website/futures-v3/account&trades/
"""
from contextlib import nullcontext
from copy import deepcopy
from dataclasses import dataclass, field
from decimal import Decimal
import math
import threading
import time

from .models import TradingError, dec, positive


_RULE_MAX_AGE = 60
_RULE_CACHE_GUARD = threading.Lock()
# A scoped open-order query is weight 1 per symbol; falling back to the
# all-symbol request above this count keeps one scene's sequential request
# latency inside the snapshot freshness window and its admission bounded.
ORDER_QUERY_SYMBOL_LIMIT = 5


def _name(value, field_name):
    if (not isinstance(value, str) or not value or len(value) > 128
            or any(character.isspace() for character in value)):
        raise TradingError(f"ADL {field_name}缺失或无效")
    return value


def _identity(api):
    credentials = getattr(api, "credentials", None)
    if isinstance(credentials, dict):
        return tuple(credentials.get(key) for key in ("user", "signer"))
    return None


def _budget(api):
    budget = getattr(api, "budget", None)
    return budget.reconciliation() if budget is not None else nullcontext()


def order_query_symbols(order_symbols):
    """Return the scoped symbols to query, or None for the all-symbol request.

    A caller that knows the incident/order symbols can avoid the weight-40
    all-symbol open-order read. Too many scoped symbols are cheaper and more
    latency-safe as the existing all-symbol request.
    """
    if order_symbols is None:
        return None
    if isinstance(order_symbols, (str, bytes)):
        raise TradingError("ADL 挂单查询标的格式无效")
    try:
        symbols = list(dict.fromkeys(order_symbols))
    except TypeError:
        raise TradingError("ADL 挂单查询标的格式无效") from None
    if not symbols:
        raise TradingError("ADL 挂单查询标的为空")
    for symbol in symbols:
        _name(symbol, "挂单查询交易代码")
    if len(symbols) > ORDER_QUERY_SYMBOL_LIMIT:
        return None
    return tuple(symbols)


def _scene_weight(*, market_only=False, hedge_mode=None, order_symbols=None):
    if market_only is True:
        order_weight = 0
    else:
        symbols = order_query_symbols(order_symbols)
        order_weight = 40 if symbols is None else len(symbols)
    dual_weight = 0 if hedge_mode is not None else 30
    return 10 + dual_weight + order_weight


def require_snapshot_budget(brokers, *, market_only=False, hedge_mode=None, hedge_modes=None, order_symbols=None):
    """Admit the whole scene before either member starts its account reads.

    This is a non-spending preflight, not a reservation across workers. Every
    actual request must still reserve atomically against concurrent consumers.
    A cached hedge-mode hint and scoped order symbols intentionally lower the
    admission weight because the matching requests are not sent.
    """
    if hedge_mode is not None and type(hedge_mode) is not bool:
        raise TradingError("ADL 持仓模式提示无效")
    if hedge_modes is not None and (not isinstance(hedge_modes, dict)
            or set(hedge_modes) != set(brokers)
            or any(type(mode) is not bool for mode in hedge_modes.values())):
        raise TradingError("ADL 账户持仓模式提示无效")
    budgets = {}
    for aid, broker in brokers.items():
        mode = hedge_modes[aid] if hedge_modes is not None else hedge_mode
        weight = _scene_weight(market_only=market_only, hedge_mode=mode,
                               order_symbols=order_symbols)
        budget = getattr(broker.api, "budget", None)
        if budget is not None:
            budgets[budget] = budgets.get(budget, 0) + weight
    for budget, total in budgets.items():
        with budget.reconciliation():
            budget.require_available(total)


@dataclass(frozen=True)
class ReductionPosition:
    symbol: str
    position_side: str
    quantity: Decimal
    mark: Decimal
    entry: Decimal
    leverage: int
    signed_quantity: Decimal

    @property
    def side(self):
        """Economic direction; position_side remains the order's raw mode key."""
        if self.position_side == "BOTH":
            return "LONG" if self.signed_quantity > 0 else "SHORT"
        return self.position_side


@dataclass(frozen=True)
class ReductionSnapshot:
    positions: tuple[ReductionPosition, ...]
    hedge_mode: bool
    can_trade: bool
    open_orders: list
    timestamp: float
    generation: int
    position_updates: dict = field(default_factory=dict)
    _broker: object = field(default=None, repr=False, compare=False)
    _api: object = field(default=None, repr=False, compare=False)
    _account_identity: object = field(default=None, repr=False, compare=False)

    def require_current(self, broker, max_age=8):
        with broker._snapshot_lock:
            now = time.time()
            if (not math.isfinite(self.timestamp) or not math.isfinite(now)
                    or not math.isfinite(max_age) or max_age < 0
                    or not 0 <= now - self.timestamp <= max_age):
                raise TradingError("ADL 持仓现场已过期，等待重新读取")
            if (broker is not self._broker or broker.api is not self._api
                    or _identity(broker.api) != self._account_identity
                    or self.generation != broker._snapshot_generation):
                raise TradingError("ADL 账户在读取后发生变化，等待新现场")


@dataclass(frozen=True)
class ReductionRule:
    symbol: str
    step: Decimal
    tick: Decimal
    min_qty: Decimal
    max_qty: Decimal
    min_notional: Decimal
    margin_asset: str
    quote_asset: str


def _position_rows(rows, hedge_mode):
    if not isinstance(rows, list):
        raise TradingError("ADL 全账户持仓响应不完整")
    parsed = {}
    for row in rows:
        if not isinstance(row, dict):
            raise TradingError("ADL 持仓记录无效")
        symbol = _name(row.get("symbol"), "持仓交易代码")
        side = row.get("positionSide")
        if side not in (("LONG", "SHORT") if hedge_mode else ("BOTH",)):
            raise TradingError("ADL 账户模式与持仓方向不一致")
        amount = dec(row.get("positionAmt"))
        if (side == "LONG" and amount < 0) or (side == "SHORT" and amount > 0):
            raise TradingError("ADL 持仓方向与数量符号不一致")
        key = symbol, side
        if key in parsed:
            raise TradingError("ADL 全账户持仓包含重复记录")
        parsed[key] = row, amount
    return parsed


def _leverage(value):
    number = positive(value)
    if number != number.to_integral_value():
        raise TradingError("ADL 实际杠杆无效")
    return int(number)


def _position_updates(rows):
    """Preserve exchange positionRisk clocks, including explicitly flat legs.

    Missing rows or timestamps are unknown. A fresh local request does not prove
    an ADL fill has reached the exchange's position projection.
    """
    result = {}
    now = time.time()
    for key, (row, _) in rows.items():
        if "updateTime" not in row:
            continue
        stamp = positive(row["updateTime"], True)
        if stamp != stamp.to_integral_value() or stamp > dec(str(now + 1)) * 1000:
            raise TradingError("ADL 持仓更新时间无效或超前")
        result[key] = float(stamp / 1000)
    return result


def _open_orders(rows, hedge_mode, symbols=None):
    if not isinstance(rows, list):
        raise TradingError("ADL 全账户挂单响应不完整")
    expected = None if symbols is None else set(symbols)
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise TradingError("ADL 挂单记录无效")
        symbol = _name(row.get("symbol"), "挂单交易代码")
        if expected is not None and symbol not in expected:
            raise TradingError("ADL 挂单查询返回了未请求的标的")
        _name(row.get("clientOrderId"), "挂单客户端编号")
        order_id = positive(row.get("orderId"))
        if order_id != order_id.to_integral_value() or (symbol, order_id) in seen:
            raise TradingError("ADL 挂单编号无效或重复")
        seen.add((symbol, order_id))
        if (row.get("side") not in ("BUY", "SELL")
                or row.get("positionSide") not in (("LONG", "SHORT") if hedge_mode else ("BOTH",))
                or row.get("status") not in ("NEW", "PARTIALLY_FILLED", "PENDING_NEW")):
            raise TradingError("ADL 挂单状态或方向尚未同步")
        original = positive(row.get("origQty"), True)
        executed = positive(row.get("executedQty"), True)
        if executed > original:
            raise TradingError("ADL 挂单成交数量无效")
    return deepcopy(rows)


def reduction_snapshot(broker, *, market_only=False, hedge_mode=None, order_symbols=None):
    """Read complete positions and orders without ordinary opening risk gates.

    A caller that has verified MARKET-only recovery can omit openOrders; that
    result does not prove the whole account has no open orders. Position, mode,
    identity and generation checks remain mandatory in either mode. All reads
    use reconciliation quota and the oldest request time owns freshness.

    ``hedge_mode`` is a bounded-age hint supplied by the incident that owns this
    scene. When present, the weight-30 mode request is skipped; position rows
    are still validated against the hint, so an actual mode change blocks the
    scene instead of authorizing a wrong reduction. ``order_symbols`` scopes the
    open-order inventory to the incident/order symbols, using the weight-1
    single-symbol endpoint; None keeps the weight-40 all-symbol request.
    """
    if hedge_mode is not None and type(hedge_mode) is not bool:
        raise TradingError("ADL 持仓模式提示无效")
    symbols = None if market_only is True else order_query_symbols(order_symbols)
    with broker._snapshot_lock:
        started, generation = time.time(), broker._snapshot_generation
        api, account_identity = broker.api, _identity(broker.api)
    with _budget(api):
        account = api.call("GET", "/fapi/v3/accountWithJoinMargin", signed=True, weight=5)
        risk = api.call("GET", "/fapi/v3/positionRisk", signed=True, weight=5)
        if hedge_mode is None:
            dual = api.call("GET", "/fapi/v3/positionSide/dual", signed=True, weight=30)
            if not isinstance(dual, dict) or type(dual.get("dualSidePosition")) is not bool:
                raise TradingError("ADL 账户持仓模式响应无效")
            hedge_mode = dual["dualSidePosition"]
        if market_only is True:
            orders = []
        elif symbols is None:
            orders = api.call("GET", "/fapi/v3/openOrders", signed=True, weight=40)
        else:
            orders = []
            for symbol in symbols:
                rows = api.call("GET", "/fapi/v3/openOrders", {"symbol": symbol}, signed=True, weight=1)
                orders.extend(_open_orders(rows, hedge_mode, (symbol,)))
    if not isinstance(account, dict) or type(account.get("canTrade")) is not bool:
        raise TradingError("ADL 账户交易权限响应无效")
    account_rows = _position_rows(account.get("positions"), hedge_mode)
    risk_rows = _position_rows(risk, hedge_mode)
    account_nonzero = {key: item for key, item in account_rows.items() if item[1]}
    risk_nonzero = {key: item for key, item in risk_rows.items() if item[1]}
    if set(account_nonzero) != set(risk_nonzero):
        raise TradingError("ADL 账户与持仓接口的全部非零仓位尚未同步")
    positions = []
    for key in sorted(risk_nonzero):
        row, amount = risk_nonzero[key]
        other, account_amount = account_nonzero[key]
        leverage = _leverage(row.get("leverage"))
        entry = positive(row.get("entryPrice"))
        margin_type = row.get("marginType")
        if (amount != account_amount or _leverage(other.get("leverage")) != leverage
                or positive(other.get("entryPrice")) != entry
                or type(other.get("isolated")) is not bool
                or margin_type not in ("isolated", "cross", "crossed")
                or other["isolated"] != (margin_type == "isolated")):
            raise TradingError("ADL 账户与持仓现场尚未同步")
        positions.append(ReductionPosition(key[0], key[1], amount.copy_abs(),
            positive(row.get("markPrice")), entry, leverage, amount))
    snapshot = ReductionSnapshot(tuple(positions), hedge_mode, account["canTrade"],
        _open_orders(orders, hedge_mode, symbols), started, generation, _position_updates(risk_rows),
        broker, api, account_identity)
    snapshot.require_current(broker)
    return snapshot


def reduction_rule(market, symbol):
    """Load an independent, bounded-age MARKET rule for a native symbol."""
    from .exchange import MarketData

    symbol = _name(symbol, "交易代码")
    with _RULE_CACHE_GUARD:
        if not hasattr(market, "_adl_rule_lock"):
            market._adl_rule_lock = threading.Lock()
            market._adl_rule_cache = {}
    with market._adl_rule_lock:
        started = time.monotonic()
        cached = market._adl_rule_cache.get(symbol)
        api = market.api
        if cached and cached[2] is api and 0 <= started - cached[0] < _RULE_MAX_AGE:
            return cached[1]
        with _budget(api):
            data = api.call("GET", "/fapi/v3/exchangeInfo")
        # Check the whole native symbol list before selecting a rule; malformed
        # envelopes, duplicate symbols and missing assets never imply absence.
        MarketData._margin_assets(data)
        matches = [row for row in data["symbols"] if row["symbol"] == symbol]
        if len(matches) != 1 or matches[0].get("status") != "TRADING":
            raise TradingError(f"ADL {symbol} 暂无可交易的市价规则")
        row = matches[0]
        quote_asset = _name(row.get("quoteAsset"), "计价资产")
        _name(row.get("marginAsset"), "保证金资产")
        order_types = row.get("orderTypes", row.get("OrderType"))
        if not isinstance(order_types, list) or "MARKET" not in order_types:
            raise TradingError(f"ADL {symbol} 缺少已确认的市价委托支持")
        try:
            parsed = MarketData._market_rule(row)
        except (KeyError, ValueError, TypeError) as exc:
            raise TradingError(f"ADL {symbol} 市价规则响应不完整") from exc
        if parsed is None:
            raise TradingError(f"ADL {symbol} 市价规则响应不完整")
        if market.api is not api or not 0 <= time.monotonic() - started < _RULE_MAX_AGE:
            raise TradingError("ADL 交易规则在读取期间已失效")
        result = ReductionRule(parsed.symbol, parsed.step, parsed.tick, parsed.min_qty,
            parsed.max_qty, parsed.min_notional, parsed.margin_asset, quote_asset)
        market._adl_rule_cache[symbol] = started, result, api
        return result

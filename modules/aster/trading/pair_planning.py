"""Shared pair errors and runtime-symbol guards; pair opening was removed."""
from .pair_legacy import require_no_legacy_cycle
from .models import TradingError, positive

from .pair_symbols import DEFAULT_PAIR_SYMBOL, SUPPORTED_SYMBOLS, validate_symbol
SIDES = (("long", "LONG"), ("short", "SHORT"))
LEGACY_ORDERS_REASON = ("配对组仍有旧版本配对开仓留下的未完成批次或订单观察记录；当前版本已移除配对开仓，"
                        "不再自动核对这些订单，请回退到旧版本完成核对后再操作")


class PairPositionError(TradingError):
    """Invalid or externally changed managed positions cannot authorize orders."""


class PairRecoveryConflict(TradingError):
    """A newer durable state must never be overwritten by a stale recovery."""


def require_runtime_symbols(pair, state, *, allow_legacy=False):
    """Bind every executable journal to the pair before querying or writing.

    Historical gold runtimes have no top-level symbol. Their orders and frozen
    batch configurations still carry their own symbols and must agree. Archived
    watches keep each batch's original symbol across active-symbol edits.
    """
    if not allow_legacy:
        require_no_legacy_cycle(state)
    symbol = validate_symbol(pair["symbol"])

    def record(value, label, *, required=False, explicit=False):
        if not isinstance(value, dict):
            raise PairPositionError(f"{label}记录无效，停止配对交易并等待核对")
        actual = value.get("symbol") if explicit else value.get("symbol", DEFAULT_PAIR_SYMBOL if required else symbol)
        if actual != symbol:
            raise PairPositionError(f"{label}标的 {actual} 与配对组 {symbol} 不一致，停止交易并等待核对")

    record(state, "配对运行状态")
    if symbol != DEFAULT_PAIR_SYMBOL and "symbol" not in state:
        owned = state.get("owned") or {}
        if not isinstance(owned, dict) or any(positive(qty, True) for qty in owned.values()):
            raise PairPositionError(f"配对底仓缺少 {symbol} 标的记录，停止交易并等待核对")
    pending = state.get("pending")
    if pending is not None:
        record(pending, "未完成批次", required=True)
        if pending.get("config") is not None:
            record(pending["config"], "未完成批次配置", required=True)
        for field in ("legs", "repairs"):
            legs = pending.get(field, [])
            if not isinstance(legs, list):
                raise PairPositionError("未完成批次订单记录无效，停止交易并等待核对")
            for leg in legs:
                if not isinstance(leg, dict):
                    raise PairPositionError("未完成批次订单记录无效，停止交易并等待核对")
                record(leg.get("order"), "未完成订单", explicit=True)
                if leg.get("receipt") is not None:
                    record(leg["receipt"], "未完成订单回执", explicit=True)
    watch = state.get("recovery_watch")
    if watch is not None:
        if not isinstance(watch, dict):
            raise PairPositionError("归档订单观察记录无效，停止交易并等待核对")
        if "symbol" in watch and (not isinstance(watch["symbol"], str) or watch["symbol"] not in SUPPORTED_SYMBOLS):
            raise PairPositionError("归档订单观察标的无效，停止交易并等待核对")
        batches = watch.get("batches")
        if not isinstance(batches, list):
            raise PairPositionError("归档订单观察记录无效，停止交易并等待核对")
        if "retired_identities" in watch:
            retired_symbols = watch.get("retired_symbols")
            if (not isinstance(watch["retired_identities"], dict) or not isinstance(retired_symbols, list)
                    or not retired_symbols or any(value not in SUPPORTED_SYMBOLS for value in retired_symbols)):
                raise PairPositionError("已退役观察的账户或标的记录无效，停止交易并等待核对")
        for batch in batches:
            if not isinstance(batch, dict):
                raise PairPositionError("归档批次记录无效，停止交易并等待核对")
            # Historical watches remain bound to their own market after an
            # active-symbol edit. Unmarked legacy batches still use this pair's
            # current symbol until the edit explicitly freezes that old symbol.
            watched_symbol = batch.get("symbol", symbol)
            if not isinstance(watched_symbol, str) or watched_symbol not in SUPPORTED_SYMBOLS:
                raise PairPositionError("归档批次标的无效，停止交易并等待核对")
            legs = batch.get("legs")
            if not isinstance(legs, list):
                raise PairPositionError("归档批次订单记录无效，停止交易并等待核对")
            for leg in legs:
                if not isinstance(leg, dict):
                    raise PairPositionError("归档批次订单记录无效，停止交易并等待核对")
                order = leg.get("order")
                if not isinstance(order, dict) or order.get("symbol") != watched_symbol:
                    raise PairPositionError(f"归档订单标的与归档批次 {watched_symbol} 不一致，停止交易并等待核对")
    return symbol


def require_no_legacy_orders(runtime):
    """Old ordinary batches need the removed recovery path; never adopt them."""
    if isinstance(runtime, dict) and (runtime.get("pending") is not None
                                      or runtime.get("recovery_watch") is not None):
        raise PairPositionError(LEGACY_ORDERS_REASON)

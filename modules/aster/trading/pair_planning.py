"""Exact pair plans with separate collateral budgets for the two subaccounts."""
from fractions import Fraction
import time

from .cycle import CyclePlan, plan_cycle
from .models import (AccountSnapshot, TradingError, TIERS, dec,
                     decimal_value, leverage_cap, opening_margin_limit, cycle_margin_limit,
                     positive, wire)

from .pair_symbols import DEFAULT_PAIR_SYMBOL, SUPPORTED_SYMBOLS, get_symbol_config, validate_symbol
SIDES = (("long", "LONG"), ("short", "SHORT"))


class PairPositionError(TradingError):
    """An unowned or externally changed position cannot authorize a new order."""


class PairRecoveryConflict(TradingError):
    """A newer durable state must never be overwritten by a stale recovery."""


def require_runtime_symbols(pair, state):
    """Bind every executable journal to the pair before querying or writing.

    Historical gold runtimes have no top-level symbol. Their orders and frozen
    cycle configuration still carry their own symbols and must agree. Archived
    watches keep each batch's original symbol across active-symbol edits.
    """
    symbol = validate_symbol(pair["symbol"])

    def record(value, label, *, required=False, explicit=False):
        if not isinstance(value, dict):
            raise PairPositionError(f"{label}记录无效，停止配对交易并等待核对")
        actual = value.get("symbol") if explicit else value.get("symbol", DEFAULT_PAIR_SYMBOL if required else symbol)
        if actual != symbol:
            raise PairPositionError(f"{label}标的 {actual} 与配对组 {symbol} 不一致，停止交易并等待核对")

    record(pair.get("cycle", {}), "配对循环配置", required=True)
    record(state, "配对运行状态")
    if symbol != DEFAULT_PAIR_SYMBOL and "symbol" not in state:
        owned = state.get("owned") or {}
        if not isinstance(owned, dict) or any(positive(qty, True) for qty in owned.values()):
            raise PairPositionError(f"配对底仓缺少 {symbol} 标的记录，停止交易并等待核对")
    progress = state.get("progress")
    if progress is not None:
        record(progress, "循环进度")
        if progress.get("config") is not None:
            record(progress["config"], "循环冻结配置", required=True)
        elif progress.get("phase") in ("holding", "waiting_close"):
            raise PairPositionError("循环持仓缺少冻结标的配置，停止交易并等待核对")
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


def positions(snapshots, symbol, *, equal_leverage=True):
    validate_symbol(symbol)
    result = {}
    for key, side in SIDES:
        snapshot = snapshots[key]
        snapshot.require_fresh()
        snapshot.require_modes([symbol])
        if not snapshot.can_trade or snapshot.open_orders:
            raise PairPositionError("子账户没有交易权限或仍有外部挂单")
        long, short = snapshot.pair(symbol)
        selected, opposite = (long, short) if side == "LONG" else (short, long)
        if opposite.qty or any(p.qty and p.symbol != symbol for p in snapshot.positions):
            raise PairPositionError(f"{key} 子账户存在非本组方向或非 {symbol} 仓位，请先核对")
        result[side] = selected
    if equal_leverage and result["LONG"].leverage != result["SHORT"].leverage:
        raise PairPositionError(f"两个子账户的 {symbol} 实际杠杆不一致（做多账户 {result['LONG'].leverage}x、做空账户 {result['SHORT'].leverage}x），停止新交易，请核对")
    return result


def require_quantities(snapshots, symbol, quantities, *, equal_leverage=True):
    pair = positions(snapshots, symbol, equal_leverage=equal_leverage)
    if any(pair[side].qty != positive(quantities[side], True) for _, side in SIDES):
        raise PairPositionError("实际仓位与配对组账本不一致，停止新交易并等待核对")
    return pair


def current_cap(snapshot, symbol, leverage):
    row = snapshot.current_leverage_caps.get(symbol)
    if row is not None:
        if len(row) != 2 or type(row[0]) is not int or row[0] != leverage:
            raise TradingError("子账户可开额度与实际杠杆不匹配")
        return Fraction(positive(row[1], True))
    return Fraction(leverage_cap(snapshot.brackets.get(symbol, []), leverage))


def combine(snapshots, symbol, *, opening=True):
    held = positions(snapshots, symbol)
    long, short = (snapshots[key] for key, _ in SIDES)
    return AccountSnapshot(
        long.equity + short.equity, long.maintenance + short.maintenance,
        long.available + short.available, long.wallet + short.wallet,
        long.unrealized + short.unrealized, [held["LONG"], held["SHORT"]], [],
        True, False, True, min(long.timestamp, short.timestamp),
        fees={symbol: max(positive(s.fees.get(symbol), True) for s in snapshots.values())} if opening else {},
        current_leverage_caps={symbol: (held["LONG"].leverage, decimal_value(
            sum((current_cap(s, symbol, held["LONG"].leverage) for s in snapshots.values()), Fraction(0)), exact=True))} if opening else {},
    )


def resource_gate(pair, snapshots, book, *, cycling=False, daily_remaining=None):
    symbol = pair["symbol"]
    held = positions(snapshots, symbol)
    leverage = held["LONG"].leverage
    policy = pair["ordinary"]
    limit = Fraction(cycle_margin_limit(policy) if cycling else opening_margin_limit(policy, leverage))
    mark = Fraction(positive(book.mark))
    # Capture validated exact values once, rather than parsing them in each search step.
    budgets = []
    for key, side in SIDES:
        snap, pos = snapshots[key], held[side]
        fee = Fraction(positive(snap.fees.get(symbol), True))
        if fee > 1:
            raise TradingError("子账户手续费率无效")
        old_qty, old_mark = Fraction(pos.qty), Fraction(pos.mark)
        pnl_change = old_qty * (mark - old_mark) * (1 if side == "LONG" else -1)
        loss = max(Fraction(0), -pnl_change)
        budget = None if daily_remaining is None else daily_remaining.get(key)
        budgets.append((side, snap, pos, fee, loss, current_cap(snap, symbol, leverage),
                        None if budget is None else Fraction(positive(budget, True))))

    def allowed(qty, buy, sell, high_price):
        for side, snap, pos, fee, loss, cap, daily in budgets:
            amount = buy if side == "LONG" else sell
            if daily is not None and 2 * amount > daily:
                return False
            high = max(high_price, Fraction(pos.mark))
            occupied_delta = max(Fraction(0), Fraction(pos.qty) * high / leverage - pos.occupied_margin_exact)
            if (Fraction(pos.qty) + qty) * high > cap:
                return False
            fill_loss = max(Fraction(0), buy - qty * mark) if side == "LONG" else max(Fraction(0), qty * mark - sell)
            cost = amount * fee + fill_loss
            equity = Fraction(snap.equity) - loss - cost
            additional = qty * high / leverage
            if (equity <= 0 or Fraction(snap.available) - loss < occupied_delta + additional + cost
                    or snap.occupied_margin_exact + occupied_delta + additional > limit * equity):
                return False
        return True
    return allowed


def ordinary_upgrade_blocker(pair, snapshots, book, capacities, held, target):
    """Use shared public capacity and each member's own holding limit."""
    threshold = Fraction(dec(pair["ordinary"]["threshold"]))
    if target not in capacities:
        return "缺少公开额度数据"
    capacity = Fraction(positive(capacities[target], True))
    if capacity <= threshold:
        return f"公开额度未严格超过 {wire(threshold)} USD1"
    notionals = {side: Fraction(held[side].qty) * max(Fraction(held[side].mark), Fraction(book.mark))
                 for _, side in SIDES}
    # Both sides consume the same public quota; opposite positions never net.
    gross = sum(notionals.values(), Fraction(0))
    if capacity <= gross:
        return f"公开额度 {wire(capacity)} USD1 未超过两账户现有持仓总价值 {wire(gross)} USD1，跳过升档"
    blocked = ["做多账户" if key == "long" else "做空账户" for key, side in SIDES
               if notionals[side] > Fraction(leverage_cap(snapshots[key].brackets.get(pair["symbol"], []), target))]
    if blocked:
        return "公开额度已满足，但" + "、".join(blocked) + "的现有持仓超过该档账户持仓上限"
    return None


def ordinary_leverage_reason(pair, snapshots, book, capacities, held):
    """Describe upgrade blockers from the same inputs, without another API read."""
    old, policy = held["LONG"].leverage, pair["ordinary"]
    minimum = policy["min_open_leverage"]
    state = (f"两账户当前均为 {old}x，低于普通开仓最低 {minimum}x" if old < minimum else
             f"两账户当前均为 {old}x，不在普通开仓支持档位（5x、10x、20x）")
    targets = [tier for tier in TIERS if tier > old and tier >= minimum]
    if not targets:
        return state + "；停止新增，程序不会自动降杠杆，请暂停配对组后核对实际杠杆设置"
    details = []
    for target in targets:
        detail = (ordinary_upgrade_blocker(pair, snapshots, book, capacities, held, target)
                  or "公开额度及账户持仓上限已满足，可申请自动升档")
        details.append(f"{target}x：{detail}")
    return state + "；" + "；".join(details) + "。程序会自动选择满足条件的更高档位，两账户升档确认后再检查开仓条件"


def plan_ordinary(pair, snapshots, book, rule, capacities):
    symbol = pair["symbol"]
    if rule.symbol != symbol or rule.margin_asset != "USD1":
        raise PairPositionError("普通开仓交易规则与配对组标的不一致")
    held = positions(snapshots, symbol)
    leverage, policy = held["LONG"].leverage, pair["ordinary"]
    book.require_fresh()
    if leverage not in TIERS or leverage < policy["min_open_leverage"]:
        raise TradingError(ordinary_leverage_reason(pair, snapshots, book, capacities, held))
    if held["LONG"].qty != held["SHORT"].qty:
        raise PairPositionError("配对组已有数量不等，停止新增")
    if book.spread_exact > Fraction(dec(policy["spread_limit"])):
        raise TradingError(f"{symbol} 买一卖一价差超过普通开仓设置上限 {wire(Fraction(dec(policy['spread_limit'])) * 10000)} bp，等待价差回落")
    capacity = Fraction(positive(capacities.get(leverage), True))
    if capacity <= Fraction(dec(policy["threshold"])):
        raise TradingError(f"当前 {leverage}x 公开可用额度未严格超过普通开仓门槛 {wire(policy['threshold'])} USD1，等待公开额度恢复")
    bid, ask, mark = map(Fraction, (book.bid, book.ask, book.mark))
    high = max(ask, mark)
    upper = min(Fraction(rule.max_qty), Fraction(book.bid_qty), Fraction(book.ask_qty),
                Fraction(dec(policy["order_notional"])) / high, capacity / (2 * high))
    step = Fraction(positive(rule.step))
    gate = resource_gate(pair, snapshots, book)
    low, maximum = 0, int(upper // step)
    while low < maximum:
        mid = (low + maximum + 1) // 2
        qty = mid * step
        if gate(qty, qty * ask, qty * bid, high):
            low = mid
        else:
            maximum = mid - 1
    qty = low * step
    minimum = max(rule.min_notional, dec(get_symbol_config(symbol)["min_notional"]))
    if qty < Fraction(rule.min_qty) or qty * mark < minimum or not qty:
        raise TradingError(f"按两账户各自余额、持仓上限、保证金占用、公开额度、盘口及配置的单批金额上限计算后，共同可开数量不足以满足最小下单量及按标记价计算的每边名义金额至少 {wire(minimum)} USD1，暂不新增")
    return CyclePlan("open", symbol, decimal_value(qty, exact=True), leverage,
                     decimal_value(qty * ask, exact=True), decimal_value(qty * bid, exact=True),
                     decimal_value(book.spread_exact * 10000), capacity_notional=decimal_value(2 * qty * high, exact=True))


def plan_paired_cycle(pair, snapshots, book, depth, rule, progress, *, capacity=None, daily_remaining=None, paused=False):
    symbol = pair["symbol"]
    require_runtime_symbols(pair, {"symbol": symbol, "progress": progress})
    config = {**pair["cycle"], "enabled": True}
    progress = dict(progress)
    if paused and progress.get("phase") in ("holding", "waiting_close"):
        # Pausing still reduces the recorded cycle increment, without waiting its timer.
        progress["config"] = {**progress["config"], "hold_seconds": 1}
        progress["opened_at"] = min(progress["opened_at"], time.time() - 2)
    account = {"id": pair["id"], "policy": pair["ordinary"], "cycle": config}
    opening = progress.get("phase", "waiting_open") == "waiting_open"
    snapshot = combine(snapshots, symbol, opening=opening)
    gate = resource_gate(pair, snapshots, book, cycling=True, daily_remaining=daily_remaining) if opening else None
    return plan_cycle(account, snapshot, book, depth, rule, progress,
                      market_capacity=capacity, opening_gate=gate, symbols=SUPPORTED_SYMBOLS)


def ordinary_upgrade(pair, snapshots, book, capacities):
    symbol = pair["symbol"]
    held = positions(snapshots, symbol)
    book.require_fresh()
    old = held["LONG"].leverage
    for target in TIERS:
        if target <= old or target < pair["ordinary"]["min_open_leverage"]:
            continue
        if ordinary_upgrade_blocker(pair, snapshots, book, capacities, held, target) is None:
            return target
    return None

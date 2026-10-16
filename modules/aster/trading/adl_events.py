"""ADL evidence parsing and resumable, read-only force-order history scans.

Evidence is keyed by the caller's stable account identity, symbol and order ID.
The shared ``adl_autoclose`` client ID is a marker, never a deduplication key.
This module neither infers a position from BOTH nor schedules compensation.
"""
from __future__ import annotations

import math
import re
import time

from .models import TradingError, positive, wire


ADL_CLIENT_ID = "adl_autoclose"
PAGE_LIMIT = 100
_STATUSES = frozenset({"NEW", "NEW_ADL", "PARTIALLY_FILLED", "FILLED", "CANCELED",
                       "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"})
_SYMBOL = re.compile(r"[A-Z0-9_]{1,64}\Z")
_INTEGER = re.compile(r"[0-9]{1,20}\Z")


def _integer(value, field, *, allow_zero=False):
    if type(value) is int:
        result = value
    elif isinstance(value, str) and _INTEGER.fullmatch(value):
        result = int(value)
    else:
        raise TradingError(f"ADL {field}格式无效")
    if result < (0 if allow_zero else 1) or result > 2 ** 63 - 1:
        raise TradingError(f"ADL {field}超出范围")
    return result


def _now(value):
    current = time.time() if value is None else float(positive(value))
    if not math.isfinite(current) or current <= 0:
        raise TradingError("ADL 当前时间无效")
    return current


def _timestamp(value, field, now):
    stamp = _integer(value, field)
    if stamp > (now + 1) * 1000:
        raise TradingError(f"ADL {field}超前")
    return stamp / 1000


def _fields(symbol, order_id, position_side, side, original, executed, status, avg_price):
    if not isinstance(symbol, str) or not _SYMBOL.fullmatch(symbol):
        raise TradingError("ADL 合约标识无效")
    if position_side not in ("LONG", "SHORT", "BOTH") or side not in ("BUY", "SELL"):
        raise TradingError("ADL 持仓或买卖方向无效")
    if (position_side == "LONG" and side != "SELL") or (position_side == "SHORT" and side != "BUY"):
        raise TradingError("ADL 减仓方向不一致")
    if not isinstance(status, str) or status not in _STATUSES:
        raise TradingError("ADL 订单状态无效")
    original_qty = positive(original, True, field="ADL 原始数量")
    executed_qty = positive(executed, True, field="ADL 累计成交量")
    if executed_qty > original_qty:
        raise TradingError("ADL 累计成交量超过原始数量")
    if status == "FILLED" and not (0 < executed_qty == original_qty):
        raise TradingError("ADL 完全成交状态与数量不一致")
    if status == "PARTIALLY_FILLED" and not (0 < executed_qty < original_qty):
        raise TradingError("ADL 部分成交状态与数量不一致")
    if status in ("NEW", "REJECTED") and executed_qty:
        raise TradingError("ADL 未成交状态与数量不一致")
    # Some notifications do not report an average price. It is not needed to
    # establish the filled quantity; malformed prices still invalidate a row.
    price = None if avg_price is None else positive(avg_price, True, field="ADL 成交均价")
    return {"symbol": symbol, "order_id": str(_integer(order_id, "订单号")),
            "position_side": position_side, "side": side,
            "executed_qty": wire(executed_qty), "original_qty": wire(original_qty),
            "avg_price": wire(price) if price else None, "status": status,
            "confirmed": executed_qty > 0}


def parse_ws(event, now=None):
    """Return detached ADL evidence, or None for unrelated/malformed WS data.

    Exchange timestamps are milliseconds; normalized times are epoch seconds.
    Historical events remain useful evidence and have no arbitrary age cutoff.
    A zero-filled NEW_ADL notification is a candidate, not a confirmed ADL fill.
    """
    if not isinstance(event, dict) or event.get("e") != "ORDER_TRADE_UPDATE":
        return None
    order = event.get("o")
    if not isinstance(order, dict) or order.get("c") != ADL_CLIENT_ID:
        return None
    try:
        current = _now(now)
        _timestamp(event.get("E"), "事件时间", current)
        if "T" in event:
            _timestamp(event["T"], "交易时间", current)
        event_at = _timestamp(order.get("T"), "订单时间", current)
        result = _fields(order.get("s"), order.get("i"), order.get("ps"), order.get("S"),
                         order.get("q"), order.get("z"), order.get("X"), order.get("ap"))
        if "l" in order:
            last_qty = positive(order["l"], True, field="ADL 本次成交量")
            if last_qty > positive(result["executed_qty"], True):
                raise TradingError("ADL 本次成交量超过累计成交量")
        return {**result, "event_at": event_at, "source": "websocket"}
    except (TradingError, TypeError, ValueError, OverflowError):
        return None


def parse_rest(row, now=None):
    """Parse one forceOrders ADL row; invalid data raises TradingError.

    Unlike WS parsing, a malformed REST response must not look like an empty
    completed history window. Order type and reduceOnly are not ADL predicates.
    """
    if not isinstance(row, dict) or row.get("clientOrderId") != ADL_CLIENT_ID:
        raise TradingError("ADL 历史订单标识无效")
    current = _now(now)
    order_at = _timestamp(row.get("time"), "创建时间", current)
    event_at = _timestamp(row.get("updateTime"), "更新时间", current)
    if event_at < order_at:
        raise TradingError("ADL 更新时间早于创建时间")
    result = _fields(row.get("symbol"), row.get("orderId"), row.get("positionSide"), row.get("side"),
                     row.get("origQty"), row.get("executedQty"), row.get("status"), row.get("avgPrice"))
    return {**result, "event_at": event_at, "order_at": order_at, "source": "rest"}


def _windows(windows):
    if not isinstance(windows, (list, tuple)):
        raise TradingError("ADL 待查时间窗格式无效")
    result = []
    for window in windows:
        if not isinstance(window, (list, tuple)) or len(window) != 2:
            raise TradingError("ADL 待查时间窗格式无效")
        start = _integer(window[0], "起始时间", allow_zero=True)
        end = _integer(window[1], "结束时间", allow_zero=True)
        if start > end:
            raise TradingError("ADL 待查时间窗顺序无效")
        result.append([start, end])
    return result


def _retry_after(error):
    try:
        raw = getattr(error, "retry_after", 0)
        delay = 0 if isinstance(raw, bool) else float(raw)
        return delay if math.isfinite(delay) and delay > 0 else 0.0
    except (TypeError, ValueError, OverflowError):
        return 0.0


def scan_force_orders(api, windows, request_limit=2):
    """Read at most request_limit pages without mutating the supplied windows.

    Return events, remaining windows, blocked/error (strings or None) and a
    nonnegative retry_after in seconds. The caller must persist events and the
    remaining queue together. No order deduplication or coverage watermark is
    applied here: repeated rows and increasing cumulative fills must reach the
    durable ledger. API or response failures retain the current window and all
    previously parsed evidence; exception messages are not exposed.

    A full page cannot prove coverage. It is retained as evidence and the window
    splits at an overlapping midpoint. A window spanning at most 1 ms cannot
    shrink with overlap: it stays pending and returns blocked for reconciliation.
    """
    if type(request_limit) is not int or request_limit < 0:
        raise TradingError("ADL 查询次数必须为非负整数")
    result = {"events": [], "remaining": _windows(windows), "blocked": None,
              "error": None, "retry_after": 0.0}
    pending = result["remaining"]
    for _ in range(request_limit):
        if not pending:
            break
        start, end = pending[0]
        try:
            rows = api.call("GET", "/fapi/v3/forceOrders",
                            {"autoCloseType": "ADL", "startTime": start, "endTime": end,
                             "limit": PAGE_LIMIT}, signed=True, weight=50)
        except Exception as exc:
            result.update(error="ADL 历史查询失败，保留时间窗等待重试", retry_after=_retry_after(exc))
            break
        if not isinstance(rows, list) or len(rows) > PAGE_LIMIT:
            result["error"] = "ADL 历史响应格式无效，保留时间窗等待重试"
            break
        current = time.time()
        for row in rows:
            try:
                result["events"].append(parse_rest(row, now=current))
            except TradingError:
                result["error"] = "ADL 历史订单字段无效，保留时间窗等待核对"
        if result["error"]:
            break
        if len(rows) < PAGE_LIMIT:
            pending.pop(0)
        elif end - start <= 1:
            result["blocked"] = "ADL 最小时间窗仍返回满页，历史覆盖尚未完成"
            break
        else:
            middle = start + (end - start) // 2
            pending[0:1] = [[start, middle], [middle, end]]
    return result

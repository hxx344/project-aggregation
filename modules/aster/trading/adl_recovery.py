"""Bounded original-ID recovery; current-account proof belongs to the caller."""
from copy import deepcopy
import math
import time

from .exchange import RequestNotSent
from .execution import Executor, TERMINAL
from .models import TradingError, dec


MAX_QUERIES = 3
OBSERVATION_SECONDS = 120
CANCEL_SECONDS = 10
ACTIVE_QUERY_SECONDS = 30
UNKNOWN = "原订单结果尚未确认，仅按原客户端订单号核对，不重复下单"


def _timestamp(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise TradingError("ADL 订单恢复时间记录无效")
    return value


def _attempts(item, key):
    value = item.get(key, 0)
    if type(value) is not int or value < 0:
        raise TradingError("ADL 订单恢复次数记录无效")
    return value


def _not_sent(error):
    return isinstance(error, RequestNotSent) or bool(getattr(error, "local_cooldown", False))


def _delay(error=None):
    value = getattr(error, "retry_after", 0)
    return max(2, value) if type(value) in (int, float) and math.isfinite(value) else 2


def _accept(item, receipt):
    order, previous = item["order"], item.get("receipt")
    Executor.validate_receipt(order, receipt)
    if receipt.get("origQty") is not None and dec(receipt["origQty"]) != dec(order["quantity"]):
        raise TradingError("ADL 订单原始数量不一致")
    if previous:
        Executor.validate_receipt(order, previous)
        old_qty, new_qty = dec(previous["executedQty"]), dec(receipt["executedQty"])
        if new_qty < old_qty:
            raise TradingError("ADL 订单累计成交数量倒退")
        if (previous.get("orderId") is not None and receipt.get("orderId") is not None
                and str(previous["orderId"]) != str(receipt["orderId"])):
            raise TradingError("ADL 订单编号发生变化")
        if previous["status"] in TERMINAL and receipt["status"] != previous["status"]:
            raise TradingError("ADL 订单终态发生变化")
        ranks = {"NEW": 0, "PARTIALLY_FILLED": 1, "PENDING_CANCEL": 2}
        if new_qty == old_qty and ranks.get(receipt["status"], 3) < ranks.get(previous["status"], 3):
            raise TradingError("ADL 订单回执状态倒退")
        old_time, new_time = previous.get("updateTime"), receipt.get("updateTime")
        if (type(old_time) in (int, float) and type(new_time) in (int, float)
                and old_time > 0 and new_time > 0 and new_time < old_time):
            raise TradingError("ADL 订单回执时间倒退")
    item["receipt"] = deepcopy(receipt)
    item["error"] = None
    if receipt["status"] in TERMINAL:
        item["state"] = "terminal"


def capture_receipt(item, broker, persist):
    """Persist fresh local evidence only; never query or authorize reality.

    Callers may hold their snapshot locks while capturing a late event. A
    positive active receipt also revokes an older unknown-position resolution.
    Invalid cache evidence leaves the last valid item untouched and blocks the
    caller instead of falling through to a reality decision.
    """
    updated = deepcopy(item)
    previous = updated.get("receipt")
    if previous:
        Executor.validate_receipt(updated["order"], previous)
        if updated.get("state") == "terminal" and previous["status"] not in TERMINAL:
            raise TradingError("ADL 订单终态与回执不一致")
    # Durable terminal evidence is final, including a proven local no-send.
    if not (previous and previous["status"] in TERMINAL) and updated.get("state") != "terminal":
        read = getattr(broker, "order_event_receipt", None)
        if callable(read):
            try:
                receipt = read(updated["order"], include_active=True)
                if receipt is not None:
                    _accept(updated, receipt)
            except Exception:
                raise TradingError("ADL 原订单流回执核对失败，保留原有效记录") from None
    receipt = updated.get("receipt")
    if receipt:
        terminal = receipt["status"] in TERMINAL
        if terminal:
            updated["state"] = "terminal"
        resolved_unknown = updated.get("resolution") == "positions_verified_unknown"
        if resolved_unknown:
            updated.pop("resolution", None)
            updated.pop("resolved_at", None)
        if resolved_unknown or updated.get("reconciliation_phase") == "reality":
            updated["reconciliation_phase"] = "terminal" if terminal else "waiting"
    if updated == item:
        return False
    item.clear()
    item.update(updated)
    persist()
    return True


def _cancel(item, broker, persist, clock):
    """Commit intent before HTTP; only a proven local denial can undo it."""
    fields = ("cancel_requested", "cancel_requested_at", "last_possible_send_at", "post_cancel_queries")
    previous = {key: item[key] for key in fields if key in item}
    now = _timestamp(clock())
    item.update(cancel_requested=True, cancel_requested_at=now,
                last_possible_send_at=max(now, item.get("last_possible_send_at", 0)),
                post_cancel_queries=0, query_after=now + 2)
    persist()
    try:
        receipt = broker.cancel(item["order"]["symbol"], item["order"]["newClientOrderId"])
        _accept(item, receipt)
    except Exception as error:
        if _not_sent(error):
            for key in fields:
                item.pop(key, None)
            item.update(previous)
        item["error"] = UNKNOWN
        item["query_after"] = _timestamp(clock()) + _delay(error)
    persist()
    return "terminal" if item["state"] == "terminal" else "waiting"


def reconcile_order(item, broker, persist, *, now=None, allow_cancel=True):
    """Return terminal, waiting or reality without resending the original order.

    ``reality`` is only permission to obtain new complete account positions.
    It never asserts that an unknown order was absent or filled, and leaves the
    caller responsible for persisting its independent reality resolution.
    With allow_cancel=False, recovery only queries the existing order.
    """
    clock = time.time if now is None else lambda: now
    current = _timestamp(clock())
    if item.get("state") not in {"sending", "terminal"}:
        raise TradingError("ADL 订单恢复状态无效")
    capture_receipt(item, broker, persist)
    receipt = item.get("receipt")
    if receipt:
        Executor.validate_receipt(item["order"], receipt)
        if receipt["status"] in TERMINAL:
            if item["state"] != "terminal":
                item["state"] = "terminal"
                persist()
            return "terminal"
    if item["state"] == "terminal":
        if receipt:
            raise TradingError("ADL 订单终态与回执不一致")
        return "terminal"
    if item.get("resolution") == "positions_verified_unknown":
        return "reality"

    if "first_observed_at" not in item:
        item["first_observed_at"] = current
        persist()
    observed = _timestamp(item["first_observed_at"])
    sent_at = _timestamp(item.get("sent_at", observed))
    anchor = max(sent_at, _timestamp(item.get("last_possible_send_at", sent_at)))
    if item.get("cancel_requested"):
        # Legacy cancellation journals did not capture their possible send time.
        anchor = max(anchor, _timestamp(item.get("cancel_requested_at", observed)))
    query_after = _timestamp(item.get("query_after", 0))
    active_query_after = _timestamp(item.get("active_query_after", 0))
    key = "post_cancel_queries" if item.get("cancel_requested") else "queries"
    count = _attempts(item, key)
    if current < anchor:
        # A backwards wall clock must not shorten the observation window.
        return "waiting"
    if current < query_after:
        return "waiting"
    if allow_cancel and receipt and not item.get("cancel_requested") and current - sent_at >= CANCEL_SECONDS:
        return _cancel(item, broker, persist, clock)
    if count >= MAX_QUERIES and not receipt:
        return "reality" if current - anchor >= OBSERVATION_SECONDS else "waiting"
    if count >= MAX_QUERIES and current < active_query_after:
        return "waiting"

    item[key] = min(MAX_QUERIES, count + 1)
    item["query_after"] = current + 2
    if receipt and item[key] >= MAX_QUERIES:
        item["active_query_after"] = current + ACTIVE_QUERY_SECONDS
    persist()
    try:
        receipt = broker.query(item["order"]["symbol"], item["order"]["newClientOrderId"], timeout=3)
        _accept(item, receipt)
    except Exception as error:
        if _not_sent(error):
            item[key] = count
        item["error"] = UNKNOWN
        item["query_after"] = _timestamp(clock()) + _delay(error)
        if item.get("receipt") and item[key] >= MAX_QUERIES:
            item["active_query_after"] = max(item.get("active_query_after", 0), item["query_after"])
        persist()
        return ("reality" if not item.get("receipt") and not _not_sent(error) and item[key] >= MAX_QUERIES
                and _timestamp(clock()) - anchor >= OBSERVATION_SECONDS else "waiting")
    if item["state"] != "terminal" and item[key] >= MAX_QUERIES:
        item["active_query_after"] = _timestamp(clock()) + ACTIVE_QUERY_SECONDS
    persist()
    if item["state"] == "terminal":
        return "terminal"
    current = _timestamp(clock())
    if allow_cancel and not item.get("cancel_requested") and current - sent_at >= CANCEL_SECONDS:
        return _cancel(item, broker, persist, clock)
    return "waiting"

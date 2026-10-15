"""Per-symbol public capacity alerts, updated inside Store transactions."""
from datetime import datetime, timezone
import json
import math
import re
import time
import uuid

import monitor
from . import monitoring
from .listings import STALE_SECONDS, STATE_KEY
from .models import TradingError

WATCH_PREFIX = "usd1_watch:"
MESSAGE_PREFIX = "usd1-capacity:"


def read(db, key, default=None):
    row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def write(db, key, value):
    db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
               (key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))))


def rule(config, symbol):
    options = monitoring.symbol_options(config, symbol)
    return {"leverage": options["listing_capacity_leverage"], "threshold": options["listing_capacity_threshold"]}


def same_rule(previous, current):
    # Missing fingerprints are the original maximum-leverage, >0 policy.
    previous = previous or {"leverage": None, "threshold": "0"}
    return (previous.get("leverage") == current["leverage"]
            and monitor.number(previous.get("threshold", "0")) == monitor.number(current["threshold"]))


def sample(state, row, now, *, require_catalog_fresh=True, requested_leverage=None):
    """Unknown never means zero, including when only the leverage read succeeded."""
    if not state.get("initialized") or (require_catalog_fresh and state.get("error")) or not row or row.get("status") != "TRADING":
        return None
    if "capacity_alert_sample" in row:
        source = row["capacity_alert_sample"]
        if not isinstance(source, dict) or "requested_leverage" not in source:
            return None
        requested = source["requested_leverage"]
        if requested is not None and type(requested) is not int:
            return None
        if requested != requested_leverage:
            return None
        leverage = source.get("leverage")
    elif requested_leverage is None:
        source, leverage = row, row.get("max_leverage")
    else:
        return None
    if source.get("error"):
        return None
    stamps = [source.get("checked_at"), source.get("brackets_checked_at")]
    if require_catalog_fresh:
        stamps.append(state.get("checked_at"))
    if any(type(stamp) not in (int, float) or not math.isfinite(stamp) or not -1 <= now - stamp < STALE_SECONDS for stamp in stamps):
        return None
    if (type(leverage) is not int or not 1 <= leverage <= 10000
            or requested_leverage is not None and leverage != requested_leverage):
        return None
    try:
        amount, remaining, cap = (monitor.number(source.get(key)) for key in ("capacity", "remaining", "bracket_cap"))
    except monitor.MonitorError:
        return None
    if amount != min(remaining, cap):
        return None
    return leverage, amount, source["checked_at"], min(stamps) + STALE_SECONDS


def cancel(db, gate, *, forget=False):
    if gate.get("pending_id"):
        db.execute("UPDATE outbox SET expires_at=0 WHERE id=? AND delivered_at IS NULL", (gate["pending_id"],))
    if forget:
        gate["pending_id"] = None


def observe(db, symbol, gate, state, now):
    config = monitoring.read(db)
    current_rule = rule(config, symbol)
    if not same_rule(gate.get("rule"), current_rule):
        cancel(db, gate, forget=True)
        gate.update(rule=current_rule, notified=False)
        gate.pop("leverage", None)
        gate.pop("checked_at", None)
        # Persist the new episode even while its requested sample is absent.
        write(db, WATCH_PREFIX + symbol, gate)
    if not monitoring.allowed(config, "listing_capacity", [symbol]):
        cancel(db, gate, forget=True)
        gate.update(notified=False, resume_after=time.time())
        write(db, WATCH_PREFIX + symbol, gate)
        return
    row = state.get("rows", {}).get(symbol)
    current = sample(state, row, now, require_catalog_fresh=config["discovery_enabled"],
                     requested_leverage=current_rule["leverage"])
    if not current or current[2] < gate.get("checked_at", 0) or current[2] <= gate.get("resume_after", 0):
        cancel(db, gate)
        return
    leverage, amount, checked_at, expires_at = current
    if gate.get("leverage") != leverage:
        cancel(db, gate, forget=True)
        gate["notified"] = False
    gate.update(leverage=leverage, checked_at=checked_at)
    threshold = monitor.number(current_rule["threshold"])
    if amount <= threshold:
        cancel(db, gate, forget=True)
        gate["notified"] = False
    elif not gate.get("notified"):
        stamp = datetime.fromtimestamp(checked_at, timezone.utc).isoformat()
        source = row.get("capacity_alert_sample", row)
        mode = "最大杠杆" if current_rule["leverage"] is None else "指定杠杆"
        message = (f"ASTER USD1 {mode}额度提醒\n交易对：{symbol}\n{mode}：{leverage}x\n"
                   f"该杠杆公开可用额度：{amount} USD1\n触发条件：> {current_rule['threshold']} USD1\n"
                   f"公开剩余额度：{source['remaining']} USD1\n该杠杆档位上限：{source['bracket_cap']} USD1\n"
                   f"额度采样时间：{stamp}\n"
                   f"档位采样时间：{datetime.fromtimestamp(source['brackets_checked_at'], timezone.utc).isoformat()}\n"
                   "公开可用额度取公开剩余额度与档位上限的较小值，非账户可开额度。")
        if gate.get("pending_id"):
            # A recovered sample revives this episode without erasing retry backoff.
            db.execute("UPDATE outbox SET message=?,expires_at=? WHERE id=? AND delivered_at IS NULL",
                       (message, expires_at, gate["pending_id"]))
        else:
            gate["pending_id"] = f"{MESSAGE_PREFIX}{symbol}:{uuid.uuid4().hex}"
            db.execute("INSERT INTO outbox(id,message,due_at,expires_at) VALUES (?,?,?,?)",
                       (gate["pending_id"], message, now, expires_at))
    write(db, WATCH_PREFIX + symbol, gate)


def refresh_rule(db, symbol, now):
    """A config transaction invalidates old work before publishing its new rule."""
    gate = read(db, WATCH_PREFIX + symbol, {})
    if gate.get("enabled"):
        observe(db, symbol, gate, read(db, STATE_KEY, {}), now)


def observe_all(db, state, now):
    for row in db.execute("SELECT key,data FROM kv WHERE key GLOB 'usd1_watch:*'").fetchall():
        gate = json.loads(row["data"])
        if gate.get("enabled"):
            observe(db, row["key"][len(WATCH_PREFIX):], gate, state, now)


def set_watch(db, symbol, enabled, now):
    if not isinstance(symbol, str) or not re.fullmatch(r"[\w.-]{1,80}", symbol) or type(enabled) is not bool:
        raise TradingError("交易对或额度提醒开关无效")
    state = read(db, STATE_KEY, {})
    key = WATCH_PREFIX + symbol
    previous = read(db, key, {})
    if symbol not in state.get("rows", {}) and (enabled or not previous):
        raise TradingError("请先等待该 USD1 交易对出现在上新列表中")
    if previous.get("enabled", False) == enabled:
        return  # Repeated saves are idempotent, including after a lost HTTP response.
    cancel(db, previous, forget=True)
    gate = {"enabled": enabled, "notified": False, "pending_id": None}
    write(db, key, gate)
    if enabled:
        observe(db, symbol, gate, state, now)


def selected_symbols(db):
    return [row["key"][len(WATCH_PREFIX):] for row in db.execute(
        "SELECT key,data FROM kv WHERE key GLOB 'usd1_watch:*' ORDER BY key").fetchall()
        if json.loads(row["data"]).get("enabled")]


def message_symbol(item):
    parts = item["id"].split(":")
    return parts[1] if len(parts) == 3 and parts[0] == "usd1-capacity" else None


def deliverable(db, item, now):
    symbol = message_symbol(item)
    gate = read(db, WATCH_PREFIX + symbol, {}) if symbol else {}
    if not gate.get("enabled") or gate.get("notified") or gate.get("pending_id") != item["id"]:
        return False
    config = monitoring.read(db)
    current_rule = rule(config, symbol)
    if not same_rule(gate.get("rule"), current_rule):
        return False
    state = read(db, STATE_KEY, {})
    current = sample(state, state.get("rows", {}).get(symbol), now,
                     require_catalog_fresh=config["discovery_enabled"], requested_leverage=current_rule["leverage"])
    return bool(current and current[1] > monitor.number(current_rule["threshold"])
                and current[0] == gate.get("leverage") and current[2] == gate.get("checked_at"))


def delivered(db, item):
    symbol = message_symbol(item)
    if not symbol:
        return
    key = WATCH_PREFIX + symbol
    gate = read(db, key, {})
    # Every threshold fall, rule change, or re-selection uses a new message id. A late
    # success from an old in-flight request cannot consume a new episode.
    if gate.get("enabled") and gate.get("pending_id") == item["id"]:
        gate.update(notified=True, pending_id=None)
        write(db, key, gate)

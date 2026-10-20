"""Feishu incidents for pair margin that stays unbalanced or cannot be balanced.

Evidence is the margin view and the balances already published by the margin
check; observing never reads an exchange or changes transfer permissions.
"""
import json
import math
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from . import monitoring

KEY = "margin_imbalance_notifications"
CATEGORY = "margin_imbalance"
FAULT_SECONDS = 60
REPEAT_SECONDS = 120
MIN_GAP_SECONDS = 60
STUCK_STATUSES = frozenset({"blocked", "unknown", "submitting", "accepted", "acknowledged"})
PROGRESS_STATUSES = frozenset({"acknowledged", "confirmed", "paper_confirmed"})
INACTIVE_STATUSES = frozenset({"disabled", "paused"})
STATUS_LABELS = {"waiting": "等待检查", "cooldown": "划转冷却中", "blocked": "划转受阻", "unknown": "划转结果未知",
    "submitting": "划转提交中", "accepted": "划转已受理待核对", "acknowledged": "划转已确认待刷新余额",
    "confirmed": "划转已核实", "paper_confirmed": "模拟划转已入账", "rejected": "划转被拒绝", "skipped": "旧划转已归档"}


def read(db):
    row = db.execute("SELECT data FROM kv WHERE key=?", (KEY,)).fetchone()
    return json.loads(row[0]) if row else {}


def write(db, state):
    db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
               (KEY, json.dumps(state, ensure_ascii=False, separators=(",", ":"))))


def cancel(db, identity):
    if identity:
        db.execute("UPDATE outbox SET expires_at=0 WHERE id=? AND delivered_at IS NULL", (identity,))


def cancel_target(db, target):
    incident = target.get("incident") or {}
    cancel(db, incident.get("pending_id"))


def reset(db):
    """Forget every window; re-enabling starts a fresh confirmation."""
    db.execute("UPDATE outbox SET expires_at=0 WHERE category=? AND delivered_at IS NULL", (CATEGORY,))
    write(db, {})


def finite_time(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _decimal(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None
    return result if result.is_finite() else None


def _amount(value):
    number = _decimal(value)
    if number is None:
        return "未知"
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _utc(value):
    if not finite_time(value):
        return "未知"
    try:
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return "未知"


def balance_reading(balances):
    """Return a complete two-sided reading, or None when any field is unusable."""
    if not isinstance(balances, dict):
        return None
    sides = {}
    for side in ("long", "short"):
        row = balances.get(side)
        if not isinstance(row, dict) or not finite_time(row.get("timestamp")):
            return None
        available = _decimal(row.get("available"))
        if available is None:
            return None
        sides[side] = (available, row["timestamp"])
    return {"long": str(sides["long"][0]), "short": str(sides["short"][0]),
            "difference": str(abs(sides["long"][0] - sides["short"][0])),
            "times": [sides["long"][1], sides["short"][1]]}


def _queue(db, identity, message, symbol, now):
    # Refreshing an unsent alert keeps its retry backoff.
    db.execute("""INSERT INTO outbox(id,message,due_at,category,symbols) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET message=excluded.message,expires_at=NULL
        WHERE outbox.delivered_at IS NULL""",
        (identity, message, now, CATEGORY, json.dumps([symbol], ensure_ascii=False, separators=(",", ":"))))


def message(target, kind, now):
    incident = target["incident"]
    if kind == "recovery":
        title = "ASTER 保证金已恢复平衡"
    elif kind == "repeat":
        title = f"ASTER 保证金仍未恢复平衡（第 {incident['repeats'] + 1} 次重复提醒）"
    else:
        title = "ASTER 保证金长时间不平衡"
    lines = [title, f"配对组：{target['name']}（{target['pair_id']}）",
             f"品种：{target['symbol']}；账户模式：{'模拟' if target.get('mode') == 'paper' else '实盘'}"]
    if kind != "recovery":
        causes = []
        if target.get("imbalanced"):
            causes.append("两侧可用余额差持续超过划转门槛")
        if target.get("stuck"):
            causes.append("自动划转持续受阻或结果未确认")
        lines.append("判定：" + ("；".join(causes) or "保证金持续不平衡"))
    balance = target.get("balance")
    if balance:
        lines += [f"A 多侧可用余额：{_amount(balance['long'])} USD1；B 空侧可用余额：{_amount(balance['short'])} USD1",
                  f"差额：{_amount(balance['difference'])} USD1；划转门槛：{_amount(target['threshold'])} USD1",
                  "余额读取时间（UTC）：" + " / ".join(_utc(value) for value in balance["times"])]
    else:
        lines.append(f"两侧可用余额：尚无新读取；划转门槛：{_amount(target['threshold'])} USD1")
    status = target.get("status")
    lines.append(f"保证金状态：{STATUS_LABELS.get(status, status or '未知')}")
    if target.get("reason"):
        lines.append("说明：" + " ".join(str(target["reason"]).split()))
    if kind != "recovery" and target.get("error") and target["error"] != target.get("reason"):
        lines.append("异常：" + " ".join(str(target["error"]).split()))
    started = incident.get("started_at")
    duration = max(0, now - started) if finite_time(started) else None
    label = "不平衡总时长" if kind == "recovery" else "已持续"
    lines.append(f"{label}：{duration:.0f} 秒（自 {_utc(started)} UTC）" if duration is not None
                 else f"{label}：未知")
    if kind != "recovery":
        lines.append(f"告警规则：持续 {FAULT_SECONDS} 秒告警，未恢复每 {REPEAT_SECONDS} 秒重复提醒，恢复后通知一次。")
    return "\n".join(lines)


def _gap_limit(observation):
    interval = observation.get("check_interval_seconds")
    cooldown = observation.get("cooldown_seconds")
    interval = interval if finite_time(interval) else 5
    cooldown = cooldown if finite_time(cooldown) else 30
    # Checks wait for the interval, plus a cooldown after each transfer.
    return max(MIN_GAP_SECONDS, 3 * (interval + cooldown))


def observe(db, observation, *, now):
    if not finite_time(now):
        raise ValueError("Invalid margin observation clock")
    pair_id = observation.get("pair_id")
    if not isinstance(pair_id, str) or not pair_id:
        raise ValueError("Invalid margin observation pair")
    config = monitoring.read(db)
    if not monitoring.allowed(config, CATEGORY, []):
        if read(db):
            reset(db)
        return False
    state = read(db)
    previous = deepcopy(state)
    targets = state.setdefault("targets", {})
    existing = {row[0] for row in db.execute("SELECT id FROM pairs")}
    for key in list(targets):
        if key not in existing:
            cancel_target(db, targets.pop(key))
    view = observation.get("view") if isinstance(observation.get("view"), dict) else {}
    status = view.get("status")
    if not observation.get("active") or status in INACTIVE_STATUSES or pair_id not in existing:
        # A paused, disabled or non-live pair is an operator choice, not a fault.
        if pair_id in targets:
            cancel_target(db, targets.pop(pair_id))
        if state != previous:
            write(db, state)
        return False

    target = targets.setdefault(pair_id, {"fault_since": None, "incident": None, "balance": None})
    last_seen = target.get("last_seen")
    gap_limit = _gap_limit(observation)
    if not finite_time(last_seen) or now < last_seen or now - last_seen > gap_limit:
        # Silence is neither recovery nor continued imbalance.
        target["fault_since"] = None
    error = view.get("error") if isinstance(view.get("error"), str) and view["error"].strip() else None
    target.update(pair_id=pair_id, name=observation.get("name") or pair_id, symbol=observation.get("symbol") or "",
                  mode=observation.get("mode"), threshold=str(observation.get("threshold", "")), status=status,
                  reason=view.get("reason") if isinstance(view.get("reason"), str) else None, error=error,
                  last_seen=now, gap_limit=gap_limit)

    progressed = status in PROGRESS_STATUSES and view.get("pending") is None
    reading = balance_reading(observation.get("balances"))
    if progressed:
        # Balances read before a completed transfer no longer describe the pair.
        target["balance"] = None
        target["balance_floor"] = now
    floor = target.get("balance_floor", 0)
    stored = target.get("balance")
    if (reading is not None and min(reading["times"]) >= floor
            and (stored is None or max(reading["times"]) > max(stored["times"]))):
        target["balance"] = stored = reading
    threshold = _decimal(observation.get("threshold"))
    imbalanced = bool(stored and threshold is not None and Decimal(stored["difference"]) > threshold)
    stuck = status in STUCK_STATUSES or error is not None
    target.update(imbalanced=imbalanced, stuck=stuck)
    faulty = imbalanced or stuck
    balanced = not faulty and stored is not None
    if progressed:
        target["fault_since"] = None
    if faulty:
        target["fault_since"] = target["fault_since"] if finite_time(target["fault_since"]) else now
    elif balanced:
        target["fault_since"] = None

    incident = target.get("incident")
    symbol = target["symbol"]
    if balanced and incident:
        if not incident["fault_sent"]:
            cancel(db, incident.get("pending_id"))
            target["incident"] = None
        elif not incident.get("recovering"):
            cancel(db, incident.get("pending_id"))
            incident.update(recovering=True, pending_id=incident["recovery_id"])
            _queue(db, incident["recovery_id"], message(target, "recovery", now), symbol, now)
    elif faulty and now - target["fault_since"] >= FAULT_SECONDS:
        if incident and incident.get("recovering"):
            # Relapse before the recovery was delivered: the open incident continues.
            cancel(db, incident["recovery_id"])
            incident.update(recovering=False, pending_id=None)
        if incident is None:
            token = uuid.uuid4().hex
            incident = target["incident"] = {
                "fault_id": f"margin-imbalance:{token}:fault", "recovery_id": f"margin-imbalance:{token}:recovery",
                "fault_sent": False, "recovering": False, "repeats": 0, "last_sent_at": None,
                "started_at": target["fault_since"], "pending_id": None}
        if not incident["fault_sent"]:
            incident["pending_id"] = incident["fault_id"]
            _queue(db, incident["fault_id"], message(target, "fault", now), symbol, now)
        else:
            if incident.get("pending_id") is None and now - incident["last_sent_at"] >= REPEAT_SECONDS:
                incident["pending_id"] = f"{incident['fault_id'].removesuffix(':fault')}:repeat:{incident['repeats'] + 1}"
            if incident.get("pending_id"):
                _queue(db, incident["pending_id"], message(target, "repeat", now), symbol, now)

    if state != previous:
        write(db, state)
    return True


def deliverable(db, item, now):
    """Only the current incident step of a recently observed pair may be sent."""
    for pair_id, target in read(db).get("targets", {}).items():
        incident = target.get("incident")
        if not incident or incident.get("pending_id") != item["id"]:
            continue
        last_seen = target.get("last_seen")
        gap_limit = target.get("gap_limit")
        gap_limit = gap_limit if finite_time(gap_limit) else MIN_GAP_SECONDS
        recent = finite_time(last_seen) and 0 <= now - last_seen <= gap_limit
        exists = db.execute("SELECT 1 FROM pairs WHERE id=?", (pair_id,)).fetchone() is not None
        return bool(recent and exists)
    return False


def delivered(db, item, now):
    state = read(db)
    for target in state.get("targets", {}).values():
        incident = target.get("incident")
        if not incident or incident.get("pending_id") != item["id"]:
            continue
        if item["id"] == incident["recovery_id"]:
            target["incident"] = None
        else:
            if item["id"] != incident["fault_id"]:
                incident["repeats"] += 1
            incident.update(fault_sent=True, last_sent_at=now, pending_id=None)
        write(db, state)
        return

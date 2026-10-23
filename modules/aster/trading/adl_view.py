"""Read-only ADL projections; durable evidence never grants execution permission."""
import hashlib
import math
import time

from .adl_config import validate_adl
from .adl_notifications import format_messages
from .exchange import LiveBroker
from .exchange_messages import exchange_reason
from .models import TradingError

MONITOR_MAX_AGE = 120
_PHASES = {"active": "detected", "blocked": "blocked", "completed": "completed"}


def _timestamp(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value > 0 else None


def _dict(value):
    return value if isinstance(value, dict) else {}


def _rows(value):
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _secrets(incident):
    values = []
    for source in (incident.get("identities"), incident.get("accounts")):
        for member in _dict(source).values():
            for key in ("user", "signer", "env_prefix", "private_key", "api_key", "secret", "token"):
                value = _dict(member).get(key)
                if isinstance(value, str) and value:
                    values.append(value)
    return values


def _incident(reader, pair_id):
    value = reader.get("adl_pair:" + pair_id)
    if (isinstance(value, dict) and value.get("pair_id") == pair_id
            and isinstance(value.get("id"), str) and value["id"]
            and value.get("status") in _PHASES):
        return value
    return None


def _monitoring(engine, reader, pair, now):
    accounts = [reader.account(pair[key]) for key in ("long_account_id", "short_account_id")]
    if any(not account or account.get("mode") != "live" for account in accounts):
        return {"status": "inactive", "reason": "ADL 监测仅适用于两个实盘账户", "checked_at": None}
    if any(not engine.live_allowed(account) for account in accounts):
        return {"status": "inactive", "reason": "服务器未开放实盘执行，ADL 监测未生效", "checked_at": None}
    # Only the currently registered broker can identify a scan owner. Do not
    # initialize a broker or select a newer scan belonging to old credentials.
    with engine.lock:
        brokers = [engine.brokers.get(account["id"]) for account in accounts]
        owners = []
        for broker in brokers:
            credentials = getattr(getattr(broker, "api", None), "credentials", None)
            user = _dict(credentials).get("user")
            owners.append(hashlib.sha256(user.lower().encode()).hexdigest()[:32]
                          if isinstance(broker, LiveBroker) and isinstance(user, str) and user else None)
    scans = [reader.get(f"adl_scan:{pair['id']}:{account['id']}:{owner}") if owner else None
             for account, owner in zip(accounts, owners)]
    times = [_timestamp(_dict(scan).get("checked_at")) for scan in scans]
    checked = min(times) if all(value is not None for value in times) else None
    if any(_dict(scan).get("error") for scan in scans):
        return {"status": "degraded", "reason": "ADL 历史补查受阻，等待后续核对", "checked_at": checked}
    if any(value is not None and value > now + 1 for value in times):
        return {"status": "degraded", "reason": "ADL 补查时间异常，等待重新检查", "checked_at": None}
    if checked is None:
        return {"status": "waiting", "reason": "等待两侧账户首次完成 ADL 历史补查", "checked_at": None}
    if any(_dict(scan).get("windows") for scan in scans):
        return {"status": "degraded", "reason": "ADL 历史补查尚有待核对区间", "checked_at": checked}
    if now - checked > MONITOR_MAX_AGE:
        return {"status": "degraded", "reason": "ADL 历史补查结果已过期，等待重新检查", "checked_at": checked}
    return {"status": "monitoring", "reason": "两侧 ADL 历史补查已完成", "checked_at": checked}


def _pending_event(engine, reader, pair, raw_incident, incident):
    if raw_incident is not None and incident is None:
        return True
    from .adl import _unhandled
    if engine.adl._memory_pending({pair["long_account_id"], pair["short_account_id"]}):
        return True
    with reader.connect() as db:
        return bool(_unhandled(db, pair["id"]))


def _lock_reason(reader, pair, runtime, raw_incident, pending_event):
    if raw_incident is not None:
        if not isinstance(raw_incident, dict) or raw_incident.get("status") != "completed" or raw_incident.get("hold"):
            return "ADL 处理中或完成后保持暂停观察，暂不能修改设置"
    if pending_event:
        return "已收到 ADL 成交事件，等待确认现场"
    if pair.get("enabled"):
        return "请先暂停配对组，再修改设置"
    margin = reader.get("pair_margin:" + pair["id"], {})
    if not isinstance(runtime, dict) or not isinstance(margin, dict):
        return "配对组或保证金日志无效，请先核对"
    from .pair_legacy import has_legacy_cycle, LEGACY_CYCLE_REASON
    try:
        if has_legacy_cycle(runtime, reader):
            return LEGACY_CYCLE_REASON
        pending = runtime.get("pending") is not None
    except (TradingError, ValueError, TypeError):
        pending = True
    if pending:
        return "配对组仍在核对订单，暂不能修改设置"
    if margin.get("pending") is not None or margin.get("status") in ("submitting", "acknowledged", "accepted", "unknown"):
        return "保证金划转结果尚未核实，暂不能修改设置"
    return ""


def status_view(engine, reader, pair, runtime, *, now=None):
    now = time.time() if now is None else now
    raw = reader.get("adl_pair:" + pair["id"])
    incident = _incident(reader, pair["id"])
    projection = None
    if incident is not None:
        projection = {"id": incident["id"], "status": incident["status"], "hold": bool(incident.get("hold")),
                      "halted": bool(incident.get("halted")),
                      "reason": exchange_reason(incident.get("reason"), secrets=_secrets(incident)),
                      "symbols": [symbol for symbol in incident.get("symbols", []) if isinstance(symbol, str)]
                      if isinstance(incident.get("symbols"), list) else [],
                      "created_at": _timestamp(incident.get("created_at")),
                      "completed_at": _timestamp(incident.get("completed_at")),
                      "batch_count": len(_rows(incident.get("batches"))), "config": validate_adl(incident.get("config"))}
    pending_event = _pending_event(engine, reader, pair, raw, incident)
    reason = _lock_reason(reader, pair, runtime, raw, pending_event)
    from .pairing import margin_only
    switch_allowed = (not pair.get("enabled") and not margin_only(pair) and not pending_event
                      and (raw is None or isinstance(raw, dict)
                           and raw.get("status") == "completed" and not raw.get("hold"))
                      and isinstance(runtime, dict)
                      and isinstance(reader.get("pair_margin:" + pair["id"], {}), dict))
    return {"monitoring": _monitoring(engine, reader, pair, now), "incident": projection,
            "report_available": incident is not None, "pending_event": pending_event,
            "configuration_locked": bool(reason), "lock_reason": reason,
            "margin_only_switch_allowed": switch_allowed}


def _report_evidence(incident):
    """Allow only formatter inputs; redact diagnostics before publishing them."""
    secrets = _secrets(incident)
    def pick(value, keys, *, text_keys=()):
        result = {key: value[key] for key in keys if key in value}
        for key in text_keys:
            if key in result:
                result[key] = exchange_reason(result[key], secrets=secrets)
        return result

    result = pick(incident, ("id", "pair_id", "pair_name", "parent_id", "created_at", "completed_at", "updated_at",
                             "symbols", "strategy_status", "reason"), text_keys=("pair_name", "strategy_status", "reason"))
    result["config"] = validate_adl(incident.get("config"))
    event_keys = ("account_id", "account_name", "symbol", "order_id", "position_side", "side", "executed_qty",
                  "original_qty", "avg_price", "status", "source", "event_at", "order_at")
    result["events"] = [pick(row, event_keys, text_keys=("account_name", "source")) for row in _rows(incident.get("events"))]
    for field in ("before", "after"):
        if field not in incident:
            continue
        result[field] = {}
        for aid, member in _dict(incident[field]).items():
            member = _dict(member)
            projected = pick(member, ("name", "error"), text_keys=("name", "error"))
            if isinstance(member.get("positions"), list):
                # Preserve malformed rows as unknown rather than dropping them
                # and turning missing evidence into an apparent zero balance.
                projected["positions"] = [pick(row, ("symbol", "position_side", "direction", "quantity"))
                                          if isinstance(row, dict) else {} for row in member["positions"]]
            result[field][aid] = projected
    for field in ("prior_orders", "batches"):
        result[field] = []
        for row in _rows(incident.get(field)):
            projected = pick(row, ("account_id", "account_name", "sent_at", "resolution", "resolved_at", "error"),
                             text_keys=("account_name", "error"))
            projected["order"] = pick(_dict(row.get("order")), ("symbol", "positionSide", "side", "quantity", "newClientOrderId"))
            projected["receipt"] = pick(_dict(row.get("receipt")), ("status", "executedQty", "avgPrice", "orderId"))
            result[field].append(projected)
    return result


def report_view(reader, pair_id, *, now=None):
    incident = _incident(reader, pair_id)
    if incident is None:
        return None
    now = time.time() if now is None else now
    evidence = _report_evidence(incident)
    evidence["reported_at"] = now
    return {"pair_id": pair_id, "incident_id": incident["id"], "status": incident["status"],
            "generated_at": now, "messages": format_messages(evidence, _PHASES[incident["status"]])}

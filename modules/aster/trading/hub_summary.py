"""Bounded, read-only portal summary from already published dashboard data."""
from datetime import date, datetime, timezone
import math
import time


STALE_AFTER_SECONDS = 120
DIAGNOSTIC_LIMIT = 64
DIAGNOSTIC_PRIORITY = {"notice": 0, "fault": 1, "action": 2}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _sum(values):
    if not values or any(value is None for value in values):
        return None
    return _number(sum(values))


def _text(value, fallback):
    return value.strip()[:120] if isinstance(value, str) and value.strip() else fallback


def _message(base, reasons):
    message = base
    for index, reason in enumerate(reasons):
        candidate = f"{message}；{reason}"
        # The portal validates JavaScript string length (UTF-16 code units).
        if len(candidate.encode("utf-16-le")) // 2 + 40 > 500:
            return f"{message}；另有 {len(reasons) - index} 项异常，请进入项目查看"
        message = candidate
    return message


class _Diagnostics:
    def __init__(self, enabled):
        self.enabled, self.rows = enabled, {}

    def add(self, identifier, kind, message):
        if not self.enabled:
            return
        message = message.encode("utf-16-le")[:920].decode("utf-16-le", errors="ignore")
        row = self.rows.setdefault(identifier, {"id": identifier, "kind": kind, "messages": []})
        if DIAGNOSTIC_PRIORITY[kind] > DIAGNOSTIC_PRIORITY[row["kind"]]:
            row["kind"] = kind
        if message not in row["messages"]:
            row["messages"].append(message)

    def result(self):
        rows = sorted(self.rows.values(), key=lambda row: (-DIAGNOSTIC_PRIORITY[row["kind"]], row["id"]))
        extra = rows[DIAGNOSTIC_LIMIT - 1:] if len(rows) > DIAGNOSTIC_LIMIT else []
        if extra:
            rows = rows[:DIAGNOSTIC_LIMIT - 1]
        result = [{"id": row["id"], "kind": row["kind"],
                   "message": _message(row["messages"][0], row["messages"][1:])} for row in rows]
        if extra:
            result.append({"id": "summary:more", "kind": extra[0]["kind"],
                           "message": f"另有 {len(extra)} 项诊断，请进入项目查看"})
        return result


def _pair_diagnostics(pair, runtime, observation, accounts):
    result = []
    if not pair.get("enabled") and pair.get("pause_reason"):
        result.append(("action", _text(pair["pause_reason"], "配对组已自动暂停，需要人工核对")))
    if not isinstance(runtime, dict) or not runtime:
        return result or ([("fault", "配对运行记录缺失或无效")] if pair.get("enabled") else [])
    if runtime.get("attention") or runtime.get("phase") == "attention":
        result.append(("action", _text(runtime.get("attention") or runtime.get("reason"), "配对组需要人工核对")))
    elif _pair_orders_unresolved(runtime):
        result.append(("fault", "配对订单正在自动核对，等待原流程完成"))
    watch = runtime.get("recovery_watch")
    if watch is not None:
        members = [pair["long_account_id"], pair["short_account_id"], pair["symbol"]]
        configs = {side: {key: accounts.get(pair[side + "_account_id"], {}).get(key)
                          for key in ("id", "env_prefix", "mode")} for side in ("long", "short")}
        match = (isinstance(observation, dict) and observation.get("watch") == watch
                 and observation.get("members") == members)
        if match and observation.get("status") == "action":
            result.append(("action", _text(observation.get("message"), "历史订单出现新异常，需要人工核对")))
        elif (match and pair.get("enabled") and observation.get("accounts") == configs
              and observation.get("status") == "failed"):
            result.append(("fault", "历史订单自动检查失败，等待原流程重试"))
        # A retained archive or an absent display cache is not a current fault.
        # The existing execution guards still perform their own fresh checks.
    return result


def _snapshot(now, *candidates):
    candidates = [value for value in candidates if isinstance(value, dict) and value]
    valid = [(stamp, value) for value in candidates
             if (stamp := _number(value.get("timestamp"))) is not None and 0 < stamp <= now + 60]
    if valid:
        stamp, snapshot = max(valid, key=lambda item: item[0])
        return snapshot, stamp
    return (candidates[0] if candidates else {}), None


def _funds_only(pair, runtime):
    """Only an idle funds manager has no current position evidence to report."""
    if (not pair.get("enabled") or pair.get("margin", {}).get("enabled") is not True
            or pair.get("ordinary", {}).get("enabled") is not False
            or not isinstance(runtime, dict) or runtime.get("pending") is not None):
        return False
    from .pair_legacy import has_legacy_cycle
    return not has_legacy_cycle(runtime)


def _funds_errors(runtime, journal):
    """A recent successful read must not hide a later failed funds check."""
    if not isinstance(journal, dict):
        return ["保证金划转日志无效，等待核对"]
    reasons = []
    if any(field in journal and (type(journal[field]) not in (int, float) or not math.isfinite(journal[field]))
           for field in ("checked_at", "next_check_at", "cooldown_until")):
        reasons.append("保证金划转日志时间无效，等待核对")
    if journal.get("blocked_reason"):
        reasons.append(_text(journal["blocked_reason"], "保证金检查失败，等待重试"))
    margin = runtime.get("margin")
    margin = margin if isinstance(margin, dict) else {}
    if margin.get("status") in ("blocked", "error"):
        reasons.append(_text(margin.get("reason"), "保证金检查尚未完成，等待核对"))
    for source in (runtime, margin, journal):
        notice = source.get("api_notice")
        if isinstance(notice, dict) and notice.get("text"):
            reasons.append(_text(notice["text"], "保证金 API 暂不可用，等待重试"))
    pending = journal.get("pending")
    if (pending is not None and (not isinstance(pending, dict)
            or pending.get("status") not in ("submitting", "acknowledged"))):
        reasons.append("保证金划转尚待核对，保留原请求等待处理")
    return list(dict.fromkeys(reasons))


def _pair_orders_unresolved(runtime):
    if runtime.get("attention") or runtime.get("phase") in ("attention", "reconciling", "repairing"):
        return True
    pending = runtime.get("pending")
    if pending is None:
        return False
    if not isinstance(pending, dict):
        return True
    if pending.get("kind") == "leverage":
        results = pending.get("results")
        return (runtime.get("phase") != "leverage" or not isinstance(results, dict)
                or any(not isinstance(row, dict) or row.get("unknown") for row in results.values()))
    if (runtime.get("phase") != "submitting" or pending.get("kind") != "ordinary"
            or pending.get("phase") not in ("open", "close")):
        return True
    legs, repairs = pending.get("legs"), pending.get("repairs")
    if not isinstance(legs, list) or len(legs) != 2 or not isinstance(repairs, list) or repairs:
        return True
    for leg in legs:
        if not isinstance(leg, dict):
            return True
        receipt = leg.get("receipt")
        if receipt is None:
            # Sending is normal; a returned error/evidence without a receipt
            # proves uncertainty, even before phase becomes reconciling.
            if leg.get("error") or leg.get("submit_error") or leg.get("submit_evidence"):
                return True
        elif not isinstance(receipt, dict) or receipt.get("status") not in (
                "NEW", "PARTIALLY_FILLED", "PENDING_CANCEL", "FILLED", "CANCELED",
                "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"):
            return True
    return False


def _pair_volume(runtime, side, now, utc_date):
    if not isinstance(runtime, dict) or not runtime:
        return None, "配对运行记录缺失或无效"
    stamp = _number(runtime.get("updated_at"))
    if stamp is None or not 0 < stamp <= now:
        return None, "配对成交统计缺少有效更新时间"
    if now - stamp >= STALE_AFTER_SECONDS:
        return None, f"配对成交统计已过期（超过 {STALE_AFTER_SECONDS} 秒）"
    if _pair_orders_unresolved(runtime):
        return None, "配对订单尚待核对，今日成交量暂不可用"
    unknown = bool(runtime.get("volume_unknown"))
    until = runtime.get("volume_unknown_until_utc")
    if until is not None:
        try:
            if not isinstance(until, str) or date.fromisoformat(until).isoformat() != until:
                raise ValueError
            unknown = utc_date <= until
        except ValueError:
            return None, "配对成交统计未知日期无效"
    if unknown:
        return None, "配对今日成交量存在未知成交"
    daily = runtime.get("daily_volume")
    if not isinstance(daily, dict):
        return None, "配对今日成交量缺失或无效"
    # The ledger creates a day only after a batch is reconciled. In-flight
    # normal batches do not invalidate the already confirmed daily total.
    if utc_date not in daily:
        return 0.0, None
    row = daily[utc_date]
    value = _number(row.get(side)) if isinstance(row, dict) else None
    if value is None or value < 0:
        return None, "配对今日成交量缺失或无效"
    return value, None


def hub_summary(engine, *, now=None, diagnostics=False):
    """Never start account reads, history calculations or report refresh workers."""
    now = time.time() if now is None else now
    diagnostic = _Diagnostics(diagnostics)
    with engine.store.read_snapshot() as reader:
        saved_accounts = reader.accounts()
        account_lookup = {account["id"]: account for account in saved_accounts}
        all_pairs = reader.pairs()
        pairs = [pair for pair in all_pairs if pair.get("enabled")]
        paired, pair_for_account, runtimes = {}, {}, {}
        for pair in pairs:
            runtime = runtimes[pair["id"]] = reader.get("pair_runtime:" + pair["id"])
            for side in ("long", "short"):
                paired[pair[side + "_account_id"]] = (runtime, side)
                pair_for_account[pair[side + "_account_id"]] = pair
        funds_pairs = {pair["id"] for pair in pairs if _funds_only(pair, runtimes[pair["id"]])}
        funds_journals = {identifier: reader.get("pair_margin:" + identifier, {}) for identifier in funds_pairs}
        if diagnostics:
            for pair in all_pairs:
                if not pair.get("enabled"):
                    runtimes[pair["id"]] = reader.get("pair_runtime:" + pair["id"])
            members = {pair[side + "_account_id"] for pair in all_pairs for side in ("long", "short")}
            independent = [account for account in saved_accounts
                           if account.get("mode") == "live" and account["id"] not in members]
            intents = {account["id"]: reader.intent(account["id"]) for account in independent}
        accounts = {account["id"]: account for account in saved_accounts
                    if account.get("enabled") or account["id"] in paired}
    accounts = list(accounts.values())
    observations = {}
    if diagnostics:
        with engine.pair_watch_diagnostic_lock:
            observations = dict(engine.pair_watch_diagnostics)
    live = [account for account in accounts if account.get("mode") == "live"]
    stamps, margins, volumes, reasons = [], [], [], []
    required_margins, funds_errors, funds_accounts = [], [], []

    def account_diagnostic(account, area, kind, message):
        pair = pair_for_account.get(account["id"])
        identifier = f"pair:{pair['id']}" if pair else f"account:{account['id']}:{area}"
        diagnostic.add(identifier, kind, message)

    with engine.lock:
        ready, error = engine.ready, engine.error
        if error:
            reasons.append(f"交易服务异常：{_text(error, '上游未提供具体原因')}")
            diagnostic.add("service:engine", "fault", reasons[-1])
        if not ready:
            reasons.append("交易服务尚未就绪")
            diagnostic.add("service:engine", "fault", reasons[-1])
        if diagnostics:
            for account in independent:
                label = f"{_text(account.get('name'), '实盘账户')}（{_text(account['id'], '未知账户')}）"
                intent = intents[account["id"]]
                view = engine.views.get(account["id"], {})
                state_reasons = []
                if not account.get("enabled") and account.get("pause_reason"):
                    state_reasons.append(_text(account["pause_reason"], "账户已自动暂停，需要人工核对"))
                if isinstance(intent, dict) and intent.get("status") == "attention":
                    state_reasons.append(_text(intent.get("last_error"), "未完成批次需要人工核对"))
                if view.get("status") == "attention":
                    state_reasons.append(_text(view.get("reason"), "账户需要人工核对"))
                for reason in state_reasons:
                    diagnostic.add(f"account:{account['id']}:state", "action", f"{label}：{reason}")
                if not state_reasons and view.get("status") == "reconciling":
                    diagnostic.add(f"account:{account['id']}:state", "fault", f"{label}：未完成批次正在自动核对")
            live_pairs = {pair_for_account[account["id"]]["id"] for account in live if account["id"] in paired}
            for pair in all_pairs:
                if pair.get("enabled") and pair["id"] not in live_pairs:
                    continue
                observation = observations.get(pair["id"])
                for kind, reason in _pair_diagnostics(pair, runtimes[pair["id"]], observation, account_lookup):
                    diagnostic.add(f"pair:{pair['id']}", kind, f"{_text(pair.get('name'), '配对组')}：{reason}")
        for account in live:
            aid = account["id"]
            label = f"{_text(account.get('name'), '实盘账户')}（{_text(aid, '未知账户')}）"
            runtime, side = paired.get(aid, (None, None))
            pair = pair_for_account.get(aid)
            if pair and pair["id"] in funds_pairs:
                # A funds-only tick intentionally publishes no positions. Use
                # its real balance read time without renewing historical holdings
                # or pretending their occupied margin is zero.
                funds_accounts.append(aid)
                balances = runtime.get("margin_balances")
                snapshot, stamp = _snapshot(now, balances.get(side) if isinstance(balances, dict) else None)
                stamps.append(stamp)
                margins.append(None)
                current = []
                if not snapshot:
                    current.append(f"{label}：缺少资金快照")
                else:
                    if stamp is None:
                        current.append(f"{label}：资金快照缺少有效更新时间")
                    elif now - stamp >= STALE_AFTER_SECONDS:
                        current.append(f"{label}：资金快照已过期（超过 {STALE_AFTER_SECONDS} 秒）")
                    if any(_number(snapshot.get(field)) is None for field in ("equity", "available", "wallet")):
                        current.append(f"{label}：资金数据缺失或无效")
                funds_errors.extend(current)
                reasons.extend(current)
                for reason in current:
                    account_diagnostic(account, "snapshot", "fault", reason)
                continue
            snapshots = runtime.get("snapshots") if isinstance(runtime, dict) else None
            snapshot, stamp = _snapshot(now,
                snapshots.get(side) if isinstance(snapshots, dict) else None,
                engine.views.get(aid, {}).get("snapshot"), engine.display_snapshots.get(aid))
            stamps.append(stamp)
            margins.append(_number(snapshot.get("occupied_margin")))
            required_margins.append(margins[-1])
            first_reason = len(reasons)
            if not snapshot:
                reasons.append(f"{label}：缺少账户快照")
            else:
                if stamps[-1] is None:
                    reasons.append(f"{label}：快照缺少有效更新时间")
                elif now - stamp >= STALE_AFTER_SECONDS:
                    reasons.append(f"{label}：账户快照已过期（超过 {STALE_AFTER_SECONDS} 秒）")
                if margins[-1] is None:
                    reasons.append(f"{label}：保证金数据缺失或无效")
            for reason in reasons[first_reason:]:
                account_diagnostic(account, "snapshot", "fault", reason)
        for pair in pairs:
            if pair["id"] not in funds_pairs or not any(
                    pair[side + "_account_id"] in funds_accounts for side in ("long", "short")):
                continue
            for reason in _funds_errors(runtimes[pair["id"]], funds_journals[pair["id"]]):
                message = f"{_text(pair.get('name'), '配对组')}：保证金平衡：{reason}"
                reasons.append(message)
                funds_errors.append(message)
                diagnostic.add(f"pair:{pair['id']}", "fault", message)
    utc_date = datetime.fromtimestamp(now, timezone.utc).date().isoformat()
    for account in live:
        if account["id"] not in paired:
            continue
        runtime, side = paired[account["id"]]
        volume, reason = _pair_volume(runtime, side, now, utc_date)
        volumes.append(volume)
        if reason:
            label = f"{_text(account.get('name'), '实盘账户')}（{_text(account['id'], '未知账户')}）"
            reasons.append(f"{label}：{reason}")
            pair = pair_for_account[account["id"]]
            account_diagnostic(account, "report", "notice", f"{_text(pair.get('name'), '配对组')}：{reason}")
    oldest = min(stamps) if stamps and all(stamp is not None for stamp in stamps) else None
    updated_at = (datetime.fromtimestamp(oldest, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                  if oldest is not None else None)
    partial = bool(error or not ready or funds_errors
                   or any(value is None for value in [*stamps, *required_margins, *volumes]))
    offline = engine.shutdown.is_set() or (engine.thread is not None and not engine.thread.is_alive())
    health = "offline" if offline else "stale" if oldest is not None and now - oldest >= STALE_AFTER_SECONDS else "partial" if partial else "online"
    if offline:
        reasons.insert(0, "交易服务已停止")
        diagnostic.add("service:engine", "fault", reasons[0])
    message = _message("上游为演示模式；交易数据不计入资产汇总" if engine.demo
                       else "交易服务已连接；保证金与成交量使用 USD1 口径" if health == "online"
                       else "保证金与成交量使用 USD1 口径", reasons)
    metrics = [
        {"key": "accounts", "label": "启用账户", "value": len(accounts), "unit": "个"},
        {"key": "live_accounts", "label": "实盘账户", "value": len(live), "unit": "个"},
        {"key": "occupied_margin", "label": "实盘占用保证金", "value": _sum(margins), "unit": "USD1",
         **({"detail": "仅保证金模式不采集完整持仓；当前占用保证金汇总暂不可用，不按零计入"} if funds_accounts else {})},
        {"key": "daily_volume", "label": "实盘今日成交量", "value": _sum(volumes), "unit": "USD1",
         "detail": "上游 UTC 日口径；仅统计配对组已核对成交，单账户不统计；不计入资产汇总"
                   if any(account["id"] not in paired for account in live)
                   else "上游 UTC 日口径；配对仅统计已核对成交；不计入资产汇总"},
    ]
    data = {"updatedAt": updated_at,
            "health": {"state": health, "message": message, "staleAfterSeconds": STALE_AFTER_SECONDS}, "metrics": metrics}
    if diagnostics:
        data["diagnostics"] = diagnostic.result()
    return {"schemaVersion": 2, "data": data}

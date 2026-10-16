"""Explicit review of unresolved opens; never infer fills from positions."""
from contextlib import ExitStack
from copy import deepcopy
from fractions import Fraction
import math
import json
import hashlib
import re
import time
import uuid

from .exchange import AmbiguousOrder, ExchangeError, LiveBroker, RequestNotSent, api_wait_notice
from .exchange_messages import exchange_reason
from .execution import Executor, TERMINAL
from .models import TradingError, dec, positive, require_supported_leverage, opening_margin_limit, wire
from .paper import PaperBroker, PaperOrderAbsent

from .pair_planning import require_runtime_symbols
SIDES = (("long", "LONG"), ("short", "SHORT"))
MIN_AGE = 120
PREVIEW_TTL = 300
MAX_WATCH_BATCHES = 8  # Active index size, not an admission cap on durable archives.
MIN_QUERY_ATTEMPTS = 3
REALITY_RETRY_SECONDS = 30
REALITY_RETRY_MAX_SECONDS = 60


def record_query_attempt(record, error=None):
    """Only an actually attempted exchange read consumes the durable budget."""
    if isinstance(error, RequestNotSent) or getattr(error, "local_cooldown", False):
        return
    record["recovery_query_attempts"] = min(MIN_QUERY_ATTEMPTS,
        max(0, record.get("recovery_query_attempts", 0)) + 1)


def recovery_ready(pending):
    if any(isinstance(leg.get("receipt"), dict) and leg["receipt"].get("status") not in TERMINAL
           for leg in pending.get("legs", []) + pending.get("repairs", [])):
        # A positive active receipt remains unresolved even after three reads
        # or a previously persisted positions stage. Query that original ID.
        return False
    if pending.get("kind") == "leverage" or pending.get("terminal_position_recovery"):
        records = [pending]
    else:
        records = [leg for leg in pending.get("legs", []) + pending.get("repairs", [])
                   if not leg.get("receipt") or leg["receipt"].get("status") not in TERMINAL]
    if not records:
        return False
    gate = pending.setdefault("bounded_recovery", {"observed_at": time.time()})
    if not isinstance(gate, dict):
        raise TradingError("恢复等待记录无效")
    if gate.get("stage") == "positions":
        return True
    now = time.time()
    # New records timestamp every possible write. Legacy records start a fresh
    # conservative window when first observed, regardless of old created_at.
    anchors = [gate.get("observed_at"), pending.get("last_possible_send_at", gate.get("observed_at"))]
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in anchors):
        raise TradingError("恢复等待时间无效")
    anchor = max(anchors)
    if not 0 <= now - anchor:
        gate["observed_at"] = now
        return False
    if (records and all(record.get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS for record in records)
            and now - anchor >= MIN_AGE):
        gate["stage"] = "positions"
        return True
    return False


def active_watch_batches(watch):
    """Bound original-ID work; retired archives require full current-account reads."""
    batches = watch.get("batches", []) if isinstance(watch, dict) else []
    return [batch for batch in batches[-MAX_WATCH_BATCHES:]
            if isinstance(batch, dict) and not batch.get("bounded_queries_complete")] if isinstance(batches, list) else []


def _watch_evidence_key(pair_id, batch):
    fingerprint = hashlib.sha256(json.dumps({"identities": batch["identities"], "legs": batch["legs"]},
        sort_keys=True, ensure_ascii=True).encode()).hexdigest()
    return "pair_watch_evidence:" + pair_id + ":" + fingerprint


def _append_watch(store, pair_id, watch, batch):
    result = deepcopy(watch or {"batches": []})
    batches = result["batches"] + [batch]
    dropped = batches[:-MAX_WATCH_BATCHES]
    if dropped:
        identities = batch["identities"]
        if (any(row.get("identities") != identities for row in dropped)
                or result.get("retired_identities", identities) != identities):
            raise TradingError("历史归档账户身份不一致，不能更新观察索引")
        for row in dropped:
            created = row.get("created_at")
            now = time.time()
            if (type(created) not in (int, float) or not math.isfinite(created) or not 0 < created <= now):
                # Older/imported indexes may omit their creation time. Start a
                # durable conservative window instead of making the ninth batch
                # permanently inadmissible; the current full-account check is
                # still mandatory before the runtime/archive transaction.
                key = _watch_evidence_key(pair_id, row)
                observed = store.get(key, {}) or {}
                created = observed.get("first_observed_at")
                if type(created) not in (int, float) or not math.isfinite(created) or not 0 < created <= now:
                    created = now
                    observed["first_observed_at"] = created
                    store.put(key, observed)
            if now - created < MIN_AGE:
                raise TradingError("历史归档尚未满足等待窗口，不能压缩观察索引")
            key = _watch_evidence_key(pair_id, row)
            observed = store.get(key, {}) or {}
            if observed.get("retired_batch") != row:
                observed["retired_batch"] = deepcopy(row)
                store.put(key, observed)
        result["retired_identities"] = deepcopy(identities)
        result["retired_symbols"] = sorted(set(result.get("retired_symbols", [])) |
            {row.get("symbol", row["legs"][0]["order"]["symbol"]) for row in dropped})
    result["batches"] = batches[-MAX_WATCH_BATCHES:]
    return result


def _commit_runtime(engine, pair, runtime, *, expected, margin, accounts, identities, guards,
                    batch=None, audit=None):
    """CAS and all recovery outputs commit together, without nesting store calls."""
    from .pair_planning import PairRecoveryConflict
    from .store import dumps
    with engine.pairs._current_members(guards), engine.store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        for table, column, key, value in (
                ("pairs", "id", pair["id"], pair),
                ("kv", "key", "pair_runtime:" + pair["id"], expected),
                ("kv", "key", "pair_margin:" + pair["id"], margin),
                *(("accounts", "id", account["id"], account) for account in accounts)):
            row = db.execute(f"SELECT data FROM {table} WHERE {column}=?", (key,)).fetchone()
            if (json.loads(row[0]) if row else {}) != value:
                raise PairRecoveryConflict("现实核对期间账户、配置或运行记录变化，已保留最新状态")
        for key, side in SIDES:
            aid = pair[key + "_account_id"]
            binding = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (aid,)).fetchone()
            if not binding or tuple(binding) != (pair["id"], side):
                raise PairRecoveryConflict("现实核对期间账户归属变化，已保留最新状态")
            with engine.lock:
                broker = engine.brokers.get(aid)
            if (broker is None or identities[key].get("mode") == "live" and
                    (not isinstance(broker, LiveBroker) or broker._snapshot_lock is not guards[aid][0])):
                raise PairRecoveryConflict("现实核对期间账户连接变化，已保留最新状态")
            if isinstance(broker, LiveBroker) and any(
                    broker.api.credentials[field].lower() != identities[key].get(field)
                    for field in ("user", "signer")):
                raise PairRecoveryConflict("现实核对期间账户身份变化，已保留最新状态")
        for _, check in guards.values():
            check()
        entries = [("pair_runtime:" + pair["id"], runtime)]
        if batch is not None:
            entries.append(("pair_batch:" + batch["id"], batch))
        if audit is not None:
            entries.append(("pair_order_recovery:" + pair["id"] + ":" + audit["pending"]["id"], audit))
        for key, value in entries:
            db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(value)))


def _safe_reality(engine, pair, state, *, reconciliation=True, market_recovery=False):
    from .pair_planning import positions, PairPositionError
    from .pair_execution import PairTrader
    snapshots, guards = engine.pairs._read_members(pair, adopt=True, reconciliation=reconciliation, runtime=state,
                                                 market_recovery=market_recovery)
    held = positions(snapshots, pair["symbol"])
    leverage = held["LONG"].leverage
    require_supported_leverage(leverage)
    risk = PairTrader(engine)._risk_snapshots(pair, snapshots, recovery=True)
    if any(snapshot.equity <= 0 or snapshot.margin_exceeds(opening_margin_limit(pair["ordinary"], leverage))
           for snapshot in risk.values()):
        raise PairPositionError("实际仓位保证金风险仍超限，保留恢复记录并停止新增")
    return snapshots, guards, {side: wire(held[side].qty) for _, side in SIDES}, leverage


def _query(broker, order, *, timeout=None):
    try:
        options = {"timeout": timeout} if timeout is not None and isinstance(broker, LiveBroker) else {}
        row = broker.query(order["symbol"], order["newClientOrderId"], **options)
    except PaperOrderAbsent:
        if isinstance(broker, PaperBroker):
            return None
        raise
    except ExchangeError as exc:
        if (not isinstance(exc, AmbiguousOrder) and exc.code == -2013 and not exc.retry_after
                and exc.http_status in (None, 400, 404)):
            return None
        raise
    Executor.validate_receipt(order, row)
    if positive(row.get("origQty")) != positive(order["quantity"]):
        raise TradingError("原订单回执的委托数量不匹配，不能采纳")
    return row


def _publish_archived_diagnostic(engine, pair, watch, accounts, status, message):
    """Observe an existing guard only; this cache never authorizes execution."""
    try:
        record = {"watch": deepcopy(watch), "members": [pair["long_account_id"], pair["short_account_id"], pair["symbol"]],
                  "accounts": {side: {key: account[key] for key in ("id", "env_prefix", "mode")}
                               for side, account in accounts.items()} if accounts is not None else None,
                  "status": status, "message": message, "checked_at": time.time()}
        with engine.pair_watch_diagnostic_lock:
            cache = engine.pair_watch_diagnostics
            previous = cache.get(pair["id"], {})
            if (status == "failed" and previous.get("status") == "action"
                    and previous.get("watch") == watch and previous.get("members") == record["members"]):
                record.update(status="action", message=previous["message"])
            cache.pop(pair["id"], None)
            cache[pair["id"]] = record
            while len(cache) > 64:
                cache.pop(next(iter(cache)))
    except Exception:
        # A display-only observation must not change the guard's result,
        # exception type, request count or durable transaction.
        pass


def require_archived_orders_clear(engine, pair, *, state=None, brokers=None, read_only=False, deadline=None,
                                 adopt_positions=True, expected_quantities=None, retire_for_deletion=False):
    """Check durable watches for new writes or a fresh read-only maintenance check."""
    from .pair_execution import PairTrader
    state = engine.store.get("pair_runtime:" + pair["id"], {}) if state is None else state
    require_runtime_symbols(pair, state)
    watch = state.get("recovery_watch")
    if watch is None:
        return
    status, message, accounts = "failed", "历史订单观察检查未完成，等待原流程重试", None

    def action(reason):
        nonlocal status, message
        status, message = "action", reason
        return TradingError(reason)

    try:
        batches = watch.get("batches") if isinstance(watch, dict) else None
        if not isinstance(batches, list) or not batches:
            raise action("人工归档订单跟踪记录无效，禁止新开仓与划转")
        # Maintenance can inspect configured live accounts with execution disabled.
        # Default callers still require live execution permission before new work.
        member_options = {"read_only": True} if read_only else {}
        accounts, current_brokers, identities = PairTrader(engine)._members(pair, **member_options)
        brokers = current_brokers if brokers is None else brokers
        evidence = []
        retired = watch.get("retired_identities")
        if retired is not None and retired != identities:
            raise action("已退役观察的账户身份已变化，禁止新开仓与划转")
        if retire_for_deletion:
            # Deletion also covers archives removed from the bounded hot index.
            # Their original records remain durable even after index compaction.
            prefix = "pair_watch_evidence:" + pair["id"] + ":"
            with engine.store.connect() as db:
                preserved = [json.loads(row[0]) for row in db.execute(
                    "SELECT data FROM kv WHERE substr(key,1,?)=?", (len(prefix), prefix))]
            archived = [row["retired_batch"] for row in preserved if row.get("retired_batch")]
            if retired is not None and not archived:
                raise action("压缩观察的原始记录不完整，不能解除绑定")
            batches = list(batches)
            for batch in archived:
                if batch not in batches:
                    batches.append(batch)
        active = ([batch for batch in batches if isinstance(batch, dict) and not batch.get("bounded_queries_complete")]
                  if retire_for_deletion else active_watch_batches(watch))
        all_retired = True
        needs_reality = retired is not None or len(batches) > MAX_WATCH_BATCHES or expected_quantities is not None
        for batch in batches:
            if not isinstance(batch, dict) or batch.get("identities") != identities:
                raise action("人工归档订单的账户身份已变化，禁止新开仓与划转")
            legs = batch.get("legs")
            if (not isinstance(legs, list) or len(legs) < 2 or any(not isinstance(leg, dict) for leg in legs)
                    or {leg.get("key") for leg in legs} != {"long", "short"}
                    or any(not isinstance(leg.get("order"), dict) for leg in legs)):
                raise action("人工归档订单明细无效，禁止新开仓与划转")
            # Supplementary observations do not rewrite the archived journal or
            # invalidate configuration/start previews. Every archive stays in DB.
            observation_key = _watch_evidence_key(pair["id"], batch)
            observed = engine.store.get(observation_key, {}) or {}
            if observed.get("retired") or batch not in active:
                needs_reality = True
                evidence.extend(observed.get("orders", []))
                continue
            observed.setdefault("first_observed_at", time.time())
            observations = observed.setdefault("legs", {})
            batch_evidence, failure = [], None
            for leg in legs:
                timeout = None if deadline is None else min(8, deadline - time.monotonic())
                if timeout is not None and timeout <= 0:
                    raise TradingError("历史订单核查超过本次更新检查时限，请稍后重试")
                cid = leg["order"]["newClientOrderId"]
                record = observations.setdefault(cid, {})
                row = record.get("receipt")
                try:
                    if record.get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS:
                        if record.get("error"):
                            failure = TradingError(record["error"])
                    else:
                        row = _query(brokers[leg["key"]], leg["order"], timeout=timeout)
                        record_query_attempt(record)
                        record.pop("error", None)
                except RequestNotSent:
                    # Local admission failures cannot exhaust recovery.
                    engine.store.put(observation_key, observed)
                    raise
                except ExchangeError as exc:
                    record_query_attempt(record, exc)
                    record["error"] = str(exc)
                    failure = exc
                else:
                    if row is not None:
                        record["receipt"] = deepcopy(row)
                        if row["status"] not in TERMINAL or dec(row["executedQty"]) != 0:
                            needs_reality = True
                            if row["status"] not in TERMINAL:
                                failure = action("归档原订单仍有活动回执，等待完整挂单及实际仓位核对")
                                record["error"] = str(failure)
                batch_evidence.append({"batch_id": batch.get("id"), "side": leg["key"].upper(),
                    "client_order_id": cid,
                    "status": row["status"] if row is not None else "UNKNOWN",
                    "executed_qty": wire(dec(row["executedQty"])) if row is not None else None})
            elapsed = time.time() - observed["first_observed_at"]
            exhausted = (elapsed >= MIN_AGE and all(
                observations[leg["order"]["newClientOrderId"]].get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS
                for leg in legs))
            observed.update(orders=batch_evidence, checked_at=time.time(), retired=exhausted)
            engine.store.put(observation_key, observed)
            all_retired = all_retired and exhausted
            if failure is not None and not exhausted:
                raise failure
            needs_reality = needs_reality or exhausted
            evidence.extend(batch_evidence)
        if retire_for_deletion:
            if not all_retired:
                raise action("历史订单尚未完成三次实际核查及 120 秒等待，暂不能解除绑定")
            # This is only the historical gate. PairManager must independently
            # prove fresh full-account flatness, then CAS these rows and clear
            # the watch together with deletion in one transaction.
            with engine.store.connect() as db:
                return {row[0]: json.loads(row[1]) for row in db.execute(
                    "SELECT key,data FROM kv WHERE substr(key,1,?)=?", (len(prefix), prefix))}
        if needs_reality:
            from .pair_planning import PairPositionError, PairRecoveryConflict
            snapshots, guards, actual, _ = _safe_reality(engine, pair, state, reconciliation=False)
            expected = expected_quantities if expected_quantities is not None else PairTrader._expected(state)
            if any(dec(actual[side]) != dec(expected[side]) for _, side in SIDES):
                if (state.get("pending") or any(dec(qty) for qty in state["progress"]["quantities"].values())
                        or dec(actual["LONG"]) != dec(actual["SHORT"])):
                    raise action("历史订单补证后实际仓位仍不平衡或与活动批次不符，停止新增及划转")
                if adopt_positions:
                    persisted = engine.store.get("pair_runtime:" + pair["id"], {})
                    if persisted != state:
                        raise PairRecoveryConflict("历史观察核对期间运行状态变化，请按最新记录重新核验")
                    margin = engine.store.get("pair_margin:" + pair["id"], {}) or {}
                    if margin.get("pending") is not None:
                        raise PairPositionError("仍有未决划转，不能采纳历史订单后的实际底仓")
                    from .pair_execution import empty_progress
                    adopted = deepcopy(state)
                    adopted.update(owned=actual, progress=empty_progress(actual, state["progress"].get("completed_cycles", 0)),
                        updated_at=time.time(), reason="历史订单补证后已采纳两侧平衡的实际底仓，重新检查交易条件")
                    adopted.pop("attention", None)
                    PairTrader(engine)._publish_snapshots(adopted, snapshots, pair["symbol"])
                    _commit_runtime(engine, pair, adopted, expected=persisted, margin=margin,
                        accounts=list(accounts.values()), identities=identities, guards=guards)
                    # Every caller must discard its pre-adoption snapshots/state.
                    raise PairRecoveryConflict("已采纳历史订单后的实际底仓，下一轮使用新记录继续")
            with engine.pairs._current_members(guards):
                _, current, actual_identities = PairTrader(engine)._members(pair, **member_options)
                if actual_identities != identities or any(
                        isinstance(current[key], LiveBroker) and current[key]._snapshot_lock is not guards[pair[key + "_account_id"]][0]
                        for key, _ in SIDES):
                    raise action("历史观察现实核对期间账户身份变化，停止新增及划转")
        status, message = "clear", "历史订单已有限补证，当前检查未发现活动挂单或未处理仓位变化"
        return evidence
    finally:
        _publish_archived_diagnostic(engine, pair, watch, accounts, status, message)


class PairOrderRecovery:
    def __init__(self, manager):
        self.manager, self.engine, self.store = manager, manager.engine, manager.store
        self.previews = {}
        self.baseline_previews = {}

    def adopt_unknown(self, trader, pair, state):
        """Throttle full reality checks across automatic/manual calls and restarts."""
        from .pair_planning import PairRecoveryConflict, PairPositionError
        pending = state["pending"]
        if not recovery_ready(pending):
            return False
        gate = pending["bounded_recovery"]
        now = time.time()
        deadline, attempted = gate.get("next_check_at", 0), gate.get("attempted_at", 0)
        if any(type(value) not in (int, float) or not math.isfinite(value) or value < 0
               for value in (deadline, attempted)):
            raise TradingError("现实核验重试时间无效，保留原批次")
        # A backwards clock must not freeze a durable deadline indefinitely.
        # Restart the whole saved delay so quota/cooldown waits are not shortened.
        if now < attempted:
            gate["attempted_at"] = now
            deadline = gate["next_check_at"] = now + max(REALITY_RETRY_SECONDS, deadline - attempted)
        if now < deadline:
            state.update(phase=gate.get("phase", "reconciling"),
                         reason=gate.get("reason", "等待下一次完整账户现实核验，保留原批次与上次持仓时间"),
                         api_notice=deepcopy(gate.get("api_notice")))
            state["retry_after"] = max(state.get("retry_after", 0), deadline - now)
            return False
        try:
            return self._adopt_unknown(trader, pair, state)
        except PairRecoveryConflict:
            raise
        except TradingError as exc:
            failures = min(2, max(0, gate.get("failure_count", 0)) + 1)
            delay = min(REALITY_RETRY_MAX_SECONDS, REALITY_RETRY_SECONDS * failures)
            requested = getattr(exc, "retry_after", 0)
            if type(requested) in (int, float) and math.isfinite(requested):
                delay = max(delay, requested)
            gate.update(attempted_at=time.time(), next_check_at=time.time() + delay,
                        failure_count=failures, reason=exchange_reason(str(exc)),
                        phase="attention" if isinstance(exc, PairPositionError) else "reconciling",
                        api_notice=api_wait_notice(exc))
            state["retry_after"] = max(state.get("retry_after", 0), delay)
            raise

    def _adopt_unknown(self, trader, pair, state):
        """End exhausted recovery from fresh reality, keeping every unknown fill."""
        from .pair_execution import empty_progress
        from .pair_planning import PairRecoveryConflict, PairPositionError
        pending = state["pending"]
        if not recovery_ready(pending):
            return False
        require_runtime_symbols(pair, state)
        if pending.get("kind") not in {"ordinary", "cycle", "leverage"}:
            raise PairPositionError("未完成批次类型无效，不能自动接管仓位")
        created = pending.get("created_at")
        if (not isinstance(pending.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pending["id"])
                or type(created) not in (int, float) or not math.isfinite(created) or not 0 < created <= time.time()):
            raise PairPositionError("原批次编号或时间无效，不能自动接管")
        margin = self.store.get("pair_margin:" + pair["id"], {}) or {}
        if margin.get("pending") is not None or margin.get("status") in {"submitting", "acknowledged", "accepted", "unknown"}:
            raise TradingError("仍有未决划转，暂不结束订单恢复")
        if not isinstance(pending.get("before"), dict) or set(pending["before"]) != {"LONG", "SHORT"}:
            raise PairPositionError("原批次底仓记录不完整，不能自动接管")
        before = {side: wire(positive(pending["before"][side], True)) for _, side in SIDES}
        if pending["kind"] != "leverage":
            if pending.get("phase") not in {"open", "close"}:
                raise PairPositionError("原订单阶段无效，不能自动接管")
            legs, repairs = pending.get("legs"), pending.get("repairs")
            if (not isinstance(legs, list) or len(legs) != 2 or not isinstance(repairs, list)
                    or {leg.get("key") for leg in legs if isinstance(leg, dict)} != {"long", "short"}):
                raise PairPositionError("原订单或补偿记录不完整，不能自动接管")
            cids = set()
            for leg in legs + repairs:
                order = leg.get("order") if isinstance(leg, dict) else None
                if not isinstance(order, dict) or leg.get("key") not in {"long", "short"}:
                    raise PairPositionError("原订单方向记录无效，不能自动接管")
                side = leg["key"].upper()
                adding = leg in legs and pending["phase"] == "open"
                if (order.get("positionSide") != side or order.get("type") != "MARKET"
                        or order.get("side") != ("BUY" if (side == "LONG") == adding else "SELL")
                        or leg.get("dispatch") not in {"prepared", "sending"}):
                    raise PairPositionError("原委托字段无效，不能自动接管")
                positive(order.get("quantity"))
                cid = order.get("newClientOrderId")
                if not isinstance(cid, str) or not re.fullmatch(r"[.A-Za-z0-9_:/-]{1,36}", cid) or cid in cids:
                    raise PairPositionError("原客户端订单编号无效，不能自动接管")
                cids.add(cid)
                if leg.get("receipt") is not None:
                    Executor.validate_receipt(order, leg["receipt"])
        persisted = self.store.get("pair_runtime:" + pair["id"], {})
        # The stage is set immediately after the last query's durable save.
        # Compare the actual journal without treating that local marker as a race.
        original_pending, current_pending = deepcopy(persisted.get("pending")), deepcopy(pending)
        for value in (original_pending, current_pending):
            if isinstance(value, dict):
                value.pop("bounded_recovery", None)
        if original_pending != current_pending or any(persisted.get(key) != state.get(key)
                for key in ("owned", "progress", "recovery_watch", "daily_volume")):
            raise PairRecoveryConflict("现实核对期间批次变化，已保留最新记录")
        accounts = self.manager._members(pair)
        _, brokers, identities = trader._members(pair)
        if identities != pending.get("identities") or identities != state.get("identities"):
            raise PairPositionError("原批次与当前账户身份不一致，不能自动接管")
        snapshots, guards, actual, leverage = _safe_reality(self.engine, pair, state,
            market_recovery=pending["kind"] != "leverage")
        balanced = dec(actual["LONG"]) == dec(actual["SHORT"])
        baseline = all(dec(actual[side]) == dec(before[side]) for _, side in SIDES)
        if not balanced and not (pending["kind"] != "cycle" and baseline):
            raise PairPositionError("实际仓位仍单边或不等量，保留原批次；需两侧平衡或分别回到原底仓")
        now = time.time()
        reconciled = deepcopy(state)
        resolution = ("leverage_positions_verified" if pending["kind"] == "leverage" else
                      "terminal_positions_adopted" if pending.get("terminal_position_recovery") else
                      "positions_adopted_unknown")
        if pending["kind"] == "leverage":
            if leverage != pending["target_leverage"]:
                reconciled["leverage_recovery_cooldown"] = {
                    "symbol": pair["symbol"], "target": pending["target_leverage"],
                    "identities": deepcopy(identities), "ordinary": deepcopy(pair["ordinary"]),
                    "until": now + 300, "actual_leverage": leverage}
        else:
            trader._account_volume(reconciled, pending)
            watch = {"id": pending["id"], "symbol": pair["symbol"],
                "created_at": pending["created_at"], "identities": deepcopy(identities),
                "positions_verified_at": now, "bounded_queries_complete": True,
                "legs": [{"key": leg["key"], "order": deepcopy(leg["order"])}
                         for leg in pending["legs"] + pending["repairs"]]}
            reconciled["recovery_watch"] = _append_watch(self.store, pair["id"], reconciled.get("recovery_watch"), watch)
        message = (f"原记录有限核对后已验证实际仓位与 {leverage}x 杠杆安全，采纳底仓：多 {actual['LONG']}、空 {actual['SHORT']}；"
                   "旧批次已结束，原成交记录保留，下一轮重新检查交易条件")
        reconciled.update(pending=None, owned=actual,
            progress=empty_progress(actual, state.get("progress", {}).get("completed_cycles", 0)),
            phase="waiting" if pair["enabled"] else "paused", reason=message, updated_at=now,
            last_batch={"id": pending["id"], "kind": pending["kind"], "phase": pending.get("phase"),
                        "completed": False, "status": "aborted", "at": now, "resolution": resolution, "positions_verified": True})
        for key in ("attention", "retry_after", "retry_at", "failure_count", "api_notice", "trade_retry"):
            reconciled.pop(key, None)
        trader._publish_snapshots(reconciled, snapshots, pair["symbol"])
        audit = {"status": resolution, "pending": deepcopy(pending), "confirmed_at": now,
                 "actual": actual, "leverage": leverage, "identities": deepcopy(identities)}
        batch = {**deepcopy(pending), "completed": False, "status": "aborted", "finished_at": now,
                 "resolution": resolution, "positions_verified": True, "actual": actual}
        _commit_runtime(self.engine, pair, trader._durable(reconciled), expected=persisted, margin=margin,
            accounts=accounts, identities=identities, guards=guards, batch=batch, audit=audit)
        state.clear()
        state.update(reconciled)
        trader._wake_hot_data(pair)
        return True

    @staticmethod
    def _baseline_fingerprint(pair, state, margin, accounts):
        value = deepcopy(state)
        for key in ("updated_at", "reason", "phase", "attention", "retry_after", "api_notice", "snapshots", "margin"):
            value.pop(key, None)
        return {"pair": pair, "state": value, "margin": margin, "accounts": accounts}

    def _read_baseline(self, pair_id):
        from .engine import snapshot_json
        from .margin_balance import MarginBalancer
        from .pair_execution import PairTrader
        pair = self.store.pair(pair_id)
        if pair is None:
            raise TradingError("配对组不存在")
        symbol = pair["symbol"]
        state = self.manager._idle(pair)
        require_runtime_symbols(pair, state)
        if state.get("recovery_watch") is None:
            raise TradingError("当前没有人工归档订单，无需重新确认底仓")
        progress = state.get("progress")
        if (not isinstance(state.get("owned"), dict) or set(state["owned"]) != {"LONG", "SHORT"}
                or not isinstance(progress, dict) or not isinstance(progress.get("quantities"), dict)
                or set(progress["quantities"]) != {"LONG", "SHORT"}):
            raise TradingError("底仓或循环记录不完整，不能采纳")
        margin = self.store.get("pair_margin:" + pair_id, {})
        accounts = self.manager._members(pair)
        _, brokers, identities = PairTrader(self.engine)._members(pair)
        if state.get("identities") != identities:
            raise TradingError("归档后的账户身份已变化，不能采纳底仓")
        snapshots, guards = self.manager._read_members(pair, adopt=True, reconciliation=True, startup=True)
        orders = require_archived_orders_clear(self.engine, pair, state=state, brokers=brokers, adopt_positions=False)
        with ExitStack() as budget:
            for broker in brokers.values():
                if isinstance(broker, LiveBroker):
                    budget.enter_context(broker.reconciliation_budget())
            MarginBalancer(self.engine).verify_members(pair)
        actual = {side: wire(snapshots[key].pair(symbol)[0 if side == "LONG" else 1].qty) for key, side in SIDES}
        leverage = snapshots["long"].pair(symbol)[0].leverage
        with self.manager._current_members(guards):
            if PairTrader(self.engine)._members(pair)[2] != identities:
                raise TradingError("核对期间账户身份变化，请重新核对")
        return {"pair": pair, "state": state, "margin": margin, "accounts": accounts,
            "identities": identities, "guards": guards, "snapshots": snapshots,
            "view_snapshots": {key: snapshot_json(snapshot, [symbol]) for key, snapshot in snapshots.items()},
            "actual": actual, "leverage": leverage, "orders": orders,
            "fingerprint": self._baseline_fingerprint(pair, state, margin, accounts)}

    def preview_baseline(self, pair_id):
        read = self._read_baseline(pair_id)
        token = uuid.uuid4().hex
        review = {"status": "baseline_review", "token": token, "pair_id": pair_id,
            "checked_at": time.time(), "before": deepcopy(read["state"]["owned"]),
            "actual": read["actual"], "leverage": read["leverage"], "orders": read["orders"]}
        self.baseline_previews[pair_id] = {"token": token, "expires": time.monotonic() + PREVIEW_TTL,
            "fingerprint": read["fingerprint"], "review": deepcopy(review)}
        return review

    def confirm_baseline(self, pair_id, token, acknowledge_unknown=False):
        preview = self.baseline_previews.get(pair_id)
        if acknowledge_unknown is not True:
            raise TradingError("请明确确认采纳当前底仓，并保留未知旧订单跟踪")
        if not preview or preview["token"] != token or time.monotonic() >= preview["expires"]:
            raise TradingError("底仓预览已失效，请重新核对")
        read = self._read_baseline(pair_id)
        if (read["fingerprint"] != preview["fingerprint"] or read["actual"] != preview["review"]["actual"]
                or read["leverage"] != preview["review"]["leverage"]):
            self.baseline_previews.pop(pair_id, None)
            raise TradingError("持仓、杠杆、订单或配置已变化，请重新核对底仓")
        from .pair_execution import empty_progress
        runtime = deepcopy(read["state"])
        message = "已按确认采纳当前实际底仓，未知旧订单继续跟踪；配对组仍暂停，可重新启动"
        runtime.update(owned=read["actual"], pending=None, phase="paused", reason=message,
            progress=empty_progress(read["actual"], (runtime.get("progress") or {}).get("completed_cycles", 0)),
            snapshots=read["view_snapshots"], updated_at=time.time(), api_notice=None)
        runtime.pop("attention", None)
        runtime.pop("retry_after", None)
        # A distinct audit key preserves every original unknown-order archive.
        audit = {"status": "manual_archived_baseline_adopted", "pending": {"id": "baseline-" + token},
            "confirmed_at": time.time(), "preview": deepcopy(preview["review"]),
            "confirmation": read["orders"], "actual": read["actual"],
            "recovery_watch": deepcopy(runtime["recovery_watch"])}
        self._commit(read, runtime, message, audit=audit, expires=preview["expires"])
        self.baseline_previews.pop(pair_id, None)
        return {"ok": True, "message": message}

    @staticmethod
    def _fingerprint(pair, state, margin, accounts):
        value = deepcopy(state)
        for key in ("updated_at", "reason", "phase", "attention", "retry_after", "snapshots", "margin"):
            value.pop(key, None)
        # A display-only observation does not change order or position authority.
        value["pending"].pop("observation_attempt_at", None)
        value["pending"].pop("bounded_recovery", None)
        for leg in value["pending"]["legs"]:
            leg.pop("error", None)
            leg.pop("recovery_query_attempts", None)
        return {"pair": pair, "state": value, "margin": margin, "accounts": accounts}

    @staticmethod
    def _eligible(pair, state, margin, *, archive=True, background=False, allow_cycle_unknown=False):
        symbol = pair["symbol"]
        from .pairing import has_cycle_quantity
        if pair.get("enabled") is not False and not background:
            raise TradingError("请先暂停配对组，再核对遗留订单与持仓")
        if not isinstance(state, dict) or not isinstance(margin, dict):
            raise TradingError("配对或划转记录无效，不能人工归档")
        require_runtime_symbols(pair, state)
        pending = state.get("pending")
        kinds = {"ordinary", "cycle"} if allow_cycle_unknown else {"ordinary"}
        if (not isinstance(pending, dict) or pending.get("kind") not in kinds or pending.get("phase") != "open"
                or pending.get("symbol") != symbol):
            raise TradingError("此恢复入口仅支持符合条件的开仓未决批次；减仓和杠杆调整须继续原恢复流程")
        cycle_unknown = pending["kind"] == "cycle"
        progress = state.get("progress")
        if (not isinstance(progress, dict) or not isinstance(progress.get("quantities"), dict)
                or set(progress["quantities"]) != {"LONG", "SHORT"}):
            raise TradingError("循环新增仓位记录不完整，不能人工归档")
        if (not isinstance(pending.get("repairs"), list)
                or type(pending.get("repair_attempts")) is not int or not 0 <= pending["repair_attempts"] <= 3):
            raise TradingError("原批次补偿记录无效，无法核对")
        if ((archive and (pending["repairs"] or pending["repair_attempts"])) or has_cycle_quantity(state)
                or margin.get("pending") is not None
                or margin.get("status") in ("submitting", "acknowledged", "accepted", "unknown")):
            raise TradingError("仍有补偿减仓、循环新增仓位或未决划转，不能人工归档")
        # Only explicit missing-order review may archive an unstarted cycle.
        # Keep ordinary position adoption, skip and start recovery unchanged.
        if cycle_unknown and (progress.get("phase") != "waiting_open"
                or pending["repairs"] or pending["repair_attempts"]
                or not isinstance(progress.get("baseline"), dict)
                or set(progress["baseline"]) != {"LONG", "SHORT"}):
            raise TradingError("循环批次仅支持尚无新增仓位和补偿记录的未知开仓；其余须继续原恢复流程")
        created = pending.get("created_at")
        if type(created) not in (int, float) or not math.isfinite(created) or created <= 0:
            raise TradingError("原批次缺少有效创建时间，不能核对历史订单")
        age = time.time() - created
        if age < 0:
            raise TradingError("原批次创建时间晚于当前时间，无法核对")
        if archive and age < MIN_AGE:
            raise TradingError("原批次创建未满 120 秒，请等待自动查询后再核对")
        if archive and age + 60 >= 7 * 86400:
            raise TradingError("原批次超出完整历史核对窗口，不能使用此恢复入口")
        if not isinstance(pending.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", pending["id"]):
            raise TradingError("原批次编号无效")
        require_supported_leverage(pending.get("leverage"))
        qty = positive(pending.get("quantity"))
        if any(not isinstance(value, dict) or set(value) != {"LONG", "SHORT"}
               for value in (pending.get("before"), pending.get("target"), state.get("owned"))):
            raise TradingError("原批次基线、目标或底仓字段不完整，不能人工归档")
        legs = pending.get("legs")
        if (not isinstance(legs, list) or len(legs) != 2 or any(not isinstance(leg, dict) for leg in legs)
                or {leg.get("key") for leg in legs} != {"long", "short"}):
            raise TradingError("原批次需包含两个有效的指定方向订单")
        cids = set()
        for leg in legs:
            side = leg["key"].upper()
            label = "A · 只多" if side == "LONG" else "B · 只空"
            if cycle_unknown and ("receipt" not in leg or leg["receipt"] is not None
                    or leg.get("dispatch") != "sending"):
                raise TradingError("循环开仓仅支持两笔原订单均未知的人工核对；已知回执须继续原恢复流程")
            order = leg.get("order")
            if not isinstance(order, dict):
                raise TradingError(f"{label}：原委托记录缺失，无法核对")
            expected = {"symbol": symbol, "positionSide": side,
                        "side": "BUY" if side == "LONG" else "SELL", "type": "MARKET"}
            for field, value in expected.items():
                if order.get(field) != value:
                    raise TradingError(f"{label}：原委托 {field} 字段不符合本批开仓记录，无法核对")
            if positive(order.get("quantity")) != qty:
                raise TradingError(f"{label}：原委托数量与批次数量不符，无法核对")
            if leg.get("dispatch") not in {"prepared", "sending"}:
                raise TradingError(f"{label}：原订单发送状态无效，无法核对")
            if leg.get("receipt") is not None:
                try:
                    Executor.validate_receipt(order, leg["receipt"])
                except TradingError as exc:
                    raise TradingError(f"{label}：已保存回执无效；{exchange_reason(str(exc))}") from None
                if archive:
                    raise TradingError(f"{label}已有有效回执，不适用未知订单人工归档；可继续重新核对")
            if archive and leg["dispatch"] != "sending":
                raise TradingError(f"{label}记录为尚未发送，不适用未知订单人工归档；可继续重新核对")
            cid = order.get("newClientOrderId")
            if not isinstance(cid, str) or not re.fullmatch(r"[.A-Za-z0-9_:/-]{1,36}", cid) or cid in cids:
                raise TradingError("原客户端订单编号缺失或重复")
            cids.add(cid)
            before = positive((pending.get("before") or {}).get(side), True)
            owned = positive((state.get("owned") or {}).get(side), True)
            target = positive((pending.get("target") or {}).get(side), True)
            if before != owned or Fraction(target) != Fraction(before) + Fraction(qty):
                raise TradingError("原批次基线或目标与底仓记录不一致，不能人工归档")
            if cycle_unknown and positive(progress["baseline"][side], True) != before:
                raise TradingError("循环基线与本批前底仓不一致，不能人工归档")
        # Budget-rejected repair records do not consume an attempt; legitimate
        # journals may therefore contain more than two legs per attempt.
        for leg in pending["repairs"]:
            if not isinstance(leg, dict) or leg.get("key") not in {"long", "short"}:
                raise TradingError("补偿订单账户方向无效，无法核对")
            order, side = leg.get("order"), leg["key"].upper()
            if (not isinstance(order, dict) or order.get("symbol") != symbol
                    or order.get("positionSide") != side or order.get("side") != ("SELL" if side == "LONG" else "BUY")
                    or order.get("type") != "MARKET" or leg.get("dispatch") not in {"prepared", "sending"}
                    or not 0 < positive(order.get("quantity")) <= qty):
                raise TradingError("补偿委托字段与本批减仓记录不符，无法核对")
            cid = order.get("newClientOrderId")
            if not isinstance(cid, str) or not re.fullmatch(r"[.A-Za-z0-9_:/-]{1,36}", cid) or cid in cids:
                raise TradingError("补偿客户端订单编号缺失或重复")
            cids.add(cid)
            if leg.get("receipt") is not None:
                Executor.validate_receipt(order, leg["receipt"])
        return pending

    def check(self, pair_id, *, source="paused_manual_check"):
        """Review eligible opens without sending repair orders or assuming fills."""
        from .pair_execution import PairTrader, PairPositionError
        from .pair_planning import PairRecoveryConflict
        if source not in {"paused_manual_check", "paused_start"}:
            raise TradingError("核对来源无效")
        self.previews.pop(pair_id, None)
        pair = self.store.pair(pair_id)
        if pair is None:
            raise TradingError("配对组不存在")
        state = self.store.get("pair_runtime:" + pair_id, {})
        margin = self.store.get("pair_margin:" + pair_id, {})
        if isinstance(state, dict) and state.get("pending") is None:
            raise TradingError("当前没有待核对批次，可能已由后台完成；请刷新配对组查看结果")
        pending = self._eligible(pair, state, margin, archive=False, allow_cycle_unknown=source == "paused_manual_check")
        # Keep the queried batch even if _finish removes it from runtime.
        original = pending
        self.manager._members(pair)
        trader = self.manager.trader or PairTrader(self.engine)
        _, brokers, identities = trader._members(pair)
        if pending.get("identities") != identities or state.get("identities") != identities:
            raise TradingError("原批次与当前真实账户身份不一致，无法核对")
        state.pop("retry_after", None)
        state["api_notice"] = None
        save_state = True
        try:
            trader._recover(pair, state, brokers, read_only=True, recovery_source=source)
        except PairRecoveryConflict:
            save_state = False
            raise
        except TradingError as exc:
            trader._retry_delay(state, exc)
            state.update(reason=exchange_reason(str(exc)), api_notice=api_wait_notice(exc))
            if isinstance(exc, PairPositionError):
                state.update(phase="attention", attention=state["reason"])
        finally:
            if save_state:
                trader._save(pair, state)
        self.manager._changed(pair)
        current = state.get("pending")
        archive_available, archive_reason = False, "本批已完成核对，无需人工归档"
        if current:
            try:
                self._eligible(pair, state, self.store.get("pair_margin:" + pair_id, {}),
                               allow_cycle_unknown=source == "paused_manual_check")
                archive_available, archive_reason = True, "两笔原订单仍无回执；可继续检查历史订单与实际底仓是否满足人工归档条件"
            except TradingError as exc:
                archive_reason = str(exc)
        rows = []
        for leg in (current or original)["legs"] + (current or original)["repairs"]:
            receipt = leg.get("receipt") or {}
            rows.append({"side": leg["key"].upper(), "client_order_id": leg["order"]["newClientOrderId"],
                         "status": receipt.get("status", "UNKNOWN"), "executed_qty": receipt.get("executedQty"),
                         "error": exchange_reason(receipt.get("reject_reason") or
                                                  (leg.get("error") if receipt.get("status") not in TERMINAL else None))})
        return {"status": "checked", "pair_id": pair_id, "batch_id": original["id"], "checked_at": time.time(),
                "completed": current is None, "message": state.get("reason", "本次核对结束"), "orders": rows,
                "archive_available": archive_available, "archive_reason": archive_reason}

    def skip_positions(self, pair_id, batch_id, acknowledge_skip):
        """End a terminal batch locally; activation must still read the real baseline."""
        from .pair_execution import PairTrader
        if acknowledge_skip is not True:
            raise TradingError("请明确确认跳过本批持仓核对")
        pair = self.store.pair(pair_id)
        if pair is None:
            raise TradingError("配对组不存在")
        original = self.store.get("pair_runtime:" + pair_id, {})
        margin = self.store.get("pair_margin:" + pair_id, {})
        pending = self._eligible(pair, original, margin, archive=False)
        if pending["id"] != batch_id:
            raise TradingError("待核对批次已变化，请刷新后重试")
        for leg in pending["legs"] + pending["repairs"]:
            receipt = leg.get("receipt")
            if receipt is None or receipt["status"] not in TERMINAL:
                raise TradingError("仍有未知或活动订单，不能跳过订单结果；请继续按原订单编号核对")
        accounts = self.manager._members(pair)
        trader = self.manager.trader or PairTrader(self.engine)
        _, _, identities = trader._members(pair)
        if pending.get("identities") != identities or original.get("identities") != identities:
            raise TradingError("原批次与当前真实账户身份不一致，不能跳过")
        now = time.time()
        audit = {"status": "manual_position_check_skipped", "positions_verified": False,
                 "at": now, "pending": deepcopy(pending), "identities": identities}
        batch = {**deepcopy(pending), "completed": False, "finished_at": now,
                 "resolution": "manual_skip", "positions_verified": False}
        state = deepcopy(original)
        trader._account_volume(state, pending)
        reason = "已手动跳过本批持仓核对，实际仓位未改动；下次启动重新读取并采纳实际底仓"
        state.update(pending=None, phase="paused", reason=reason, updated_at=now,
                     last_batch={"id": batch_id, "kind": pending["kind"], "phase": pending["phase"],
                                 "quantity": pending["quantity"], "completed": False, "at": now,
                                 "resolution": "manual_skip", "positions_verified": False})
        for key in ("attention", "retry_after", "retry_at", "failure_count", "api_notice"):
            state.pop(key, None)
        def check_current():
            if trader._members(pair)[2] != identities:
                raise TradingError("跳过核对期间账户身份已变化，请重试")
        self.store.commit_pair_recovery(pair, state, expected_runtime=original, expected_margin=margin,
            accounts=accounts, check_current=check_current, message=reason, audit=audit, batch=batch)
        self.previews.pop(pair_id, None)
        self.manager._changed(pair)
        return {"ok": True, "status": "skipped", "pair_id": pair_id, "batch_id": batch_id,
                "positions_verified": False, "message": reason}

    def reconcile_positions(self, trader, pair, state, *, source, member_read=None):
        """Preserve verified balanced ordinary positions without inventing receipts."""
        symbol = pair["symbol"]
        from .pair_execution import empty_progress
        from .pair_planning import PairRecoveryConflict, PairPositionError, positions
        background = source == "automatic_positions"
        if source not in {"paused_manual_check", "paused_start", "automatic_positions"}:
            raise TradingError("核对来源无效")
        pending = state.get("pending")
        if not isinstance(pending, dict) or pending.get("kind") != "ordinary" or pending.get("phase") != "open":
            return False
        margin = self.store.get("pair_margin:" + pair["id"], {})
        pending = self._eligible(pair, state, margin, archive=False, background=background)
        before = {side: Fraction(positive(pending["before"][side], True)) for _, side in SIDES}
        expected = dict(before)
        for leg in pending["legs"] + pending["repairs"]:
            receipt = leg.get("receipt")
            if receipt is None or receipt["status"] not in TERMINAL:
                return False
            # _eligible validates every original and repair receipt. Never treat
            # a missing/active repair as a completed manual rollback.
            order = leg["order"]
            adding = (order["positionSide"] == "LONG") == (order["side"] == "BUY")
            expected[order["positionSide"]] += Fraction(dec(receipt["executedQty"])) * (1 if adding else -1)
        def acceptable(actual):
            return ((actual["LONG"] == actual["SHORT"])
                    or actual == before and expected != before
                    and all(expected[side] >= before[side] for _, side in SIDES))
        # Use the just-published position quantities only as a cheap rejection
        # filter. They cannot authorize completion; the fresh checks below do.
        observed_quantities = {}
        for key, side in SIDES:
            observed = [row for row in state.get("snapshots", {}).get(key, {}).get("positions", [])
                        if row.get("symbol") == symbol and row.get("side") == side]
            if len(observed) != 1:
                return False
            observed_quantities[side] = Fraction(dec(observed[0].get("qty")))
        if not acceptable(observed_quantities):
            return False
        persisted = self.store.get("pair_runtime:" + pair["id"], {})
        if any(persisted.get(key) != state.get(key) for key in
               ("pending", "owned", "progress", "recovery_watch", "daily_volume", "last_batch")):
            raise PairRecoveryConflict("核对期间批次或底仓记录已变化，已保留最新记录；请重试启动")
        if not pending.get("position_review"):
            # The outer recovery save persists this stage on a budget wait.
            # Keep it in memory during a successful read so a concurrent CAS
            # conflict leaves the original durable business state untouched.
            pending["position_review"] = True
        accounts = self.manager._members(pair)
        snapshots, guards = member_read if member_read is not None else self.manager._read_members(
            pair, adopt=True, reconciliation=True, market_recovery=True)
        held = positions(snapshots, symbol)
        actual = {side: Fraction(held[side].qty) for _, side in SIDES}
        if not acceptable(actual) or any(pos.leverage != pending["leverage"] for pos in held.values()):
            raise PairPositionError("仓位核对未通过：需两侧数量相等或分别回到原底仓，且杠杆不变；"
                + "；".join(f"{'A 多侧' if key == 'long' else 'B 空侧'}实际 {wire(actual[side])}，底仓 {wire(before[side])}"
                            for key, side in SIDES))
        reconciled = deepcopy(state)
        owned = {side: wire(value) for side, value in actual.items()}
        if state.get("recovery_watch") is not None:
            # This batch's terminal receipts and balanced quantities have been
            # checked above. The historical guard must compare against that
            # verified result, not the old pre-batch owned baseline.
            require_archived_orders_clear(self.engine, pair, state=state, expected_quantities=owned)
        reconciled["pending"]["manual_position_reconciliation"] = {
            "source": source, "checked_at": time.time(),
            "identities": deepcopy(pending["identities"]),
            "before": {side: wire(value) for side, value in before.items()},
            "known_expected": {side: wire(value) for side, value in expected.items()},
            "actual": owned, "adopted_baseline": owned,
            "external_delta": {side: wire(actual[side] - expected[side]) for _, side in SIDES},
            "external_reduction": {side: wire(max(Fraction(0), expected[side] - actual[side])) for _, side in SIDES},
        }
        reconciled.update(owned=owned, progress=empty_progress(owned, state["progress"].get("completed_cycles", 0)))
        trader._publish_snapshots(reconciled, snapshots, symbol)
        def check_current(db):
            # The database writer lock can wait beyond the snapshot lifetime.
            # Check CAS inside the transaction, not just before BEGIN IMMEDIATE.
            for table, column, key, expected_value in (
                    ("pairs", "id", pair["id"], pair),
                    ("kv", "key", "pair_runtime:" + pair["id"], persisted),
                    ("kv", "key", "pair_margin:" + pair["id"], margin),
                    *(("accounts", "id", account["id"], account) for account in accounts)):
                row = db.execute(f"SELECT data FROM {table} WHERE {column}=?", (key,)).fetchone()
                if (json.loads(row[0]) if row else {}) != expected_value:
                    raise PairRecoveryConflict("核对期间账户或运行记录已变化，已保留最新记录；请重试启动")
            for account in accounts:
                row = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (account["id"],)).fetchone()
                direction = "LONG" if account["id"] == pair["long_account_id"] else "SHORT"
                if not row or tuple(row) != (pair["id"], direction):
                    raise PairRecoveryConflict("核对期间账户归属已变化，已保留最新记录")
            for _, current in guards.values():
                current()
        with self.manager._current_members(guards):
            trader._config_guard(pair, pending["identities"], opening=False)
            self._eligible(self.store.pair(pair["id"]), state,
                           self.store.get("pair_margin:" + pair["id"], {}), archive=False, background=background)
            # _finish commits batch history, original fill accounting and pending
            # clearance together. Failed checks/commits leave the original state.
            trader._finish(pair, reconciled, reconciled["pending"], completed=False, check_current=check_current)
        state.clear()
        state.update(reconciled)
        return True

    def _history(self, broker, pending):
        symbol = pending["symbol"]
        start, end = int((pending["created_at"] - 60) * 1000), int(time.time() * 1000)
        if isinstance(broker, LiveBroker):
            with broker.reconciliation_budget():
                rows = broker.api.call("GET", "/fapi/v3/allOrders", {
                    "symbol": symbol, "startTime": start, "endTime": end, "limit": 1000}, signed=True, weight=5)
        elif isinstance(broker, PaperBroker):
            broker.reload()
            # Match the live endpoint's symbol scope. Closed orders from a
            # previously used pair must not contaminate this recovery window.
            rows = [row for row in broker.state["orders"].values()
                    if not isinstance(row, dict) or row.get("symbol") in (None, symbol)]
        else:
            raise TradingError("当前账户不支持完整历史订单核对")
        if not isinstance(rows, list) or len(rows) >= 1000:
            raise TradingError("历史订单响应不完整或达到 1000 条上限，不能将未找到视为核对依据")
        for row in rows:
            if (not isinstance(row, dict) or row.get("symbol") != symbol
                    or not isinstance(row.get("clientOrderId"), str) or not row["clientOrderId"]):
                raise TradingError("历史订单响应字段无效，不能人工归档")
        return rows, {"start_time": start, "end_time": end, "rows": len(rows)}

    def _read(self, pair_id):
        from .pair_execution import PairTrader
        from .margin_balance import MarginBalancer
        pair = self.store.pair(pair_id)
        if pair is None:
            raise TradingError("配对组不存在")
        symbol = pair["symbol"]
        state, margin = self.store.get("pair_runtime:" + pair_id, {}), self.store.get("pair_margin:" + pair_id, {})
        pending = self._eligible(pair, state, margin, allow_cycle_unknown=True)
        accounts = self.manager._members(pair)
        _, brokers, identities = PairTrader(self.engine)._members(pair)
        if pending.get("identities") != identities or state.get("identities") != identities:
            raise TradingError("原批次与当前真实账户身份不一致，不能人工归档")
        found, evidence = {}, []
        for leg in pending["legs"]:
            broker, order = brokers[leg["key"]], leg["order"]
            row = _query(broker, order)
            source = "original_client_id"
            window = None
            if row is None:
                rows, window = self._history(broker, pending)
                matches = [item for item in rows if item["clientOrderId"] == order["newClientOrderId"]]
                if len(matches) > 1:
                    raise TradingError("历史订单包含重复的原客户端编号，不能人工归档")
                if matches:
                    row = matches[0]
                    Executor.validate_receipt(order, row)
                    timestamp = row.get("time")
                    if (positive(row.get("origQty")) != positive(order["quantity"])
                            or isinstance(broker, LiveBroker) and row.get("type") != "MARKET"
                            or type(timestamp) not in (int, float) or not math.isfinite(timestamp)
                            or not window["start_time"] <= timestamp <= window["end_time"]):
                        raise TradingError("历史原订单的数量、类型或时间不匹配，不能采纳回执")
                    source = "order_history"
            if row is not None:
                found[leg["key"]] = deepcopy(row)
            evidence.append({"side": leg["key"].upper(), "client_order_id": order["newClientOrderId"],
                             "result": "found" if row is not None else "not_found", "source": source,
                             "history": window, "checked_at": time.time()})
        with ExitStack() as budget:
            for broker in brokers.values():
                if isinstance(broker, LiveBroker):
                    budget.enter_context(broker.reconciliation_budget())
            MarginBalancer(self.engine).verify_members(pair)
        snapshots, guards = self.manager._read_members(pair, adopt=True, reconciliation=True, market_recovery=True)
        actual = {side: wire(snapshots[key].pair(symbol)[0 if side == "LONG" else 1].qty) for key, side in SIDES}
        if not found:
            if any(dec(actual[side]) != dec(pending["before"][side]) for _, side in SIDES):
                raise TradingError("实际持仓未回到本批开仓前底仓；即使两侧数量相等，也不能归档此未决批次")
            if any(snapshot.pair(symbol)[0].leverage != pending["leverage"] for snapshot in snapshots.values()):
                raise TradingError("实际杠杆与原批次不一致，不能人工归档")
            require_archived_orders_clear(self.engine, pair, state=state, brokers=brokers)
        if PairTrader(self.engine)._members(pair)[2] != identities:
            raise TradingError("核对期间账户身份变化，请重新核对")
        return {"pair": pair, "state": state, "margin": margin, "accounts": accounts, "identities": identities,
                "snapshots": snapshots, "guards": guards, "found": found, "evidence": evidence,
                "actual": actual, "fingerprint": self._fingerprint(pair, state, margin, accounts)}

    def _commit(self, read, runtime, message, *, audit=None, expires=None):
        from .pair_execution import PairTrader
        def check_current():
            for _, current in read["guards"].values():
                current()
            if expires is not None and time.monotonic() >= expires:
                raise TradingError("核对预览已过期，请重新核对")
            if PairTrader(self.engine)._members(read["pair"])[2] != read["identities"]:
                raise TradingError("核对期间账户身份发生变化")
        with self.manager._current_members(read["guards"]):
            self.store.commit_pair_recovery(read["pair"], runtime, expected_runtime=read["state"],
                expected_margin=read["margin"], accounts=read["accounts"], check_current=check_current,
                message=message, audit=audit)
        self.manager._changed(read["pair"])

    def _restore_receipts(self, read):
        if not read["found"]:
            return None
        runtime = deepcopy(read["state"])
        for leg in runtime["pending"]["legs"]:
            if leg["key"] in read["found"]:
                leg.update(receipt=read["found"][leg["key"]], error=None)
        message = "已找回原订单真实回执；系统继续核对该批成交与持仓，尚未解除执行限制"
        runtime.update(phase="reconciling", reason=message, updated_at=time.time())
        self._commit(read, runtime, message)
        self.previews.pop(read["pair"]["id"], None)
        return {"status": "receipts_found", "message": message}

    def preview(self, pair_id):
        read = self._read(pair_id)
        restored = self._restore_receipts(read)
        if restored:
            return restored
        pending = read["state"]["pending"]
        token = uuid.uuid4().hex
        review = {"status": "review", "token": token, "pair_id": pair_id, "batch_id": pending["id"],
            "created_at": pending["created_at"], "checked_at": time.time(), "before": pending["before"],
            "actual": read["actual"], "leverage": pending["leverage"], "orders": read["evidence"],
            "message": "原编号和完整时间窗历史均未找到两笔订单，实际持仓等于本批前底仓；可人工归档未知记录，保持暂停"}
        self.previews[pair_id] = {"token": token, "expires": time.monotonic() + PREVIEW_TTL,
            "fingerprint": read["fingerprint"], "review": deepcopy(review)}
        return review

    def confirm(self, pair_id, token, acknowledge_unknown=False):
        preview = self.previews.get(pair_id)
        if acknowledge_unknown is not True:
            raise TradingError("请明确确认已在交易所核对订单与持仓，并接受归档记录仍未取得订单终态")
        if not preview or preview["token"] != token or time.monotonic() >= preview["expires"]:
            raise TradingError("核对预览已失效，请重新核对订单与持仓")
        read = self._read(pair_id)
        if read["fingerprint"] != preview["fingerprint"]:
            self.previews.pop(pair_id, None)
            raise TradingError("订单、底仓或账户配置已变化，请重新核对")
        restored = self._restore_receipts(read)
        if restored:
            raise TradingError(restored["message"])
        from .engine import snapshot_json
        from .pair_execution import empty_progress
        runtime, pending = deepcopy(read["state"]), read["state"]["pending"]
        watch = {"id": pending["id"], "symbol": read["pair"]["symbol"],
                        "created_at": pending["created_at"], "identities": read["identities"],
                        "legs": [{"key": leg["key"], "order": deepcopy(leg["order"])} for leg in pending["legs"]]}
        kind = "循环" if pending["kind"] == "cycle" else "普通"
        message = f"已人工归档未取得回执的{kind}开仓批次，底仓保留；配对组仍暂停，可点击启动重新核验"
        audit = {"status": "manual_archived_unresolved", "pending": deepcopy(pending), "confirmed_at": time.time(),
                 "preview": deepcopy(preview["review"]), "confirmation": read["evidence"], "actual": read["actual"]}
        runtime.update(pending=None, phase="paused", reason=message,
            recovery_watch=_append_watch(self.store, read["pair"]["id"], runtime.get("recovery_watch"), watch),
            progress=empty_progress(runtime["owned"], (runtime.get("progress") or {}).get("completed_cycles", 0)),
            snapshots={key: snapshot_json(snapshot, [read["pair"]["symbol"]]) for key, snapshot in read["snapshots"].items()},
            updated_at=time.time())
        runtime.pop("attention", None)
        runtime.pop("retry_after", None)
        self._commit(read, runtime, message, audit=audit, expires=preview["expires"])
        self.previews.pop(pair_id, None)
        return {"ok": True, "message": message}

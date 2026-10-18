"""Process-local maintenance admission and fresh, fail-closed update evidence."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import json
import math
import os
import threading
import time

from .exchange import RequestNotSent, LiveBroker, credentials_for
from .margin_balance import MarginBalancer
from .models import dec, positive
from .pair_planning import require_runtime_symbols


class UpdateEvidenceError(ValueError):
    """A local, non-sensitive reason why restart evidence is incomplete."""


class WorkspaceControl:
    def __init__(self, engine):
        self.engine = engine
        self.lock = threading.RLock()
        self.check_lock = threading.Lock()
        self.active = os.environ.get("WORKSPACE_MAINTENANCE") == "1"
        self.generation = 0
        self.inflight = 0

    def set_maintenance(self, active):
        if type(active) is not bool:
            raise ValueError("maintenance must be boolean")
        writer = getattr(self.engine, "account_writer", None)
        if not active and writer is not None and not writer.ready:
            writer.initialize()
        with self.lock:
            if self.active != active:
                self.active = active
                self.generation += 1
        self.engine.scheduler_event.set()
        return {"active": active, "maintenance": active}

    @contextmanager
    def mutation(self):
        # Admission and maintenance use the same short lock. Already admitted
        # transports remain in-flight until their response/exception is handled.
        with self.lock:
            if self.active or self.engine.shutdown.is_set():
                raise RequestNotSent("工作台维护中，未发送新的交易请求")
            self.inflight += 1
            self.generation += 1
        try:
            yield
        finally:
            with self.lock:
                self.inflight -= 1
                self.generation += 1

    def bind(self, broker):
        if isinstance(broker, LiveBroker):
            broker.api.workspace_control = self
        else:
            broker.workspace_control = self
        return broker

    def _owned(self):
        engine = self.engine
        handle = engine.process_lock.file
        if handle is None or handle.closed or engine.shutdown.is_set():
            return False
        if engine.thread is None or not engine.thread.is_alive():
            return False
        try:
            return os.path.samestat(os.fstat(handle.fileno()), os.stat(engine.process_lock.path))
        except OSError:
            return False

    def _durable_inventory(self, accounts, pairs):
        # Read one SQLite snapshot, including records whose owner no longer
        # appears in the configuration. Never repair or clear recovery state.
        try:
            with self.engine.store.read_snapshot() as reader:
                if reader.accounts() != accounts or reader.pairs() != pairs:
                    raise UpdateEvidenceError("读取恢复记录期间账户或配对配置发生变化，请重试")
                with reader.connect() as db:
                    intents = tuple(tuple(row) for row in db.execute(
                        "SELECT id,account_id,status,data FROM intents WHERE status NOT IN ('complete','aborted') ORDER BY id"))
                    records = tuple(tuple(row) for row in db.execute(
                        "SELECT key,data FROM kv WHERE key GLOB 'post_fill_check:*' OR key GLOB 'pair_runtime:*' "
                        "OR key GLOB 'pair_margin:*' OR key GLOB 'pair_deleted:*' "
                        "OR key GLOB 'adl_pair:*' ORDER BY key"))
                    deleted_accounts = tuple(tuple(row) for row in db.execute(
                        "SELECT id,data,deleted_at FROM deleted_accounts ORDER BY id"))
            return intents, records, deleted_accounts
        except UpdateEvidenceError:
            raise
        except Exception:
            raise UpdateEvidenceError("持久化恢复记录读取失败，无法确认更新后可继续恢复") from None

    @staticmethod
    def _adl_recovery(state, owner, members, identities):
        """Check recoverable local order keys; restarting never queries/resends them."""
        if (not isinstance(state.get("id"), str) or not state["id"]
                or state.get("pair_id") != owner or state.get("identities") != identities):
            raise UpdateEvidenceError("ADL 恢复记录的配对标识或账户身份不一致")
        frozen = state.get("accounts")
        member_ids = {member["id"] for member in members.values()}
        if not isinstance(frozen, dict) or set(frozen) != member_ids:
            raise UpdateEvidenceError("ADL 恢复记录缺少完整的账户配置")
        for member in members.values():
            saved = frozen[member["id"]]
            if not isinstance(saved, dict) or any(saved.get(key) != member[key] for key in ("id", "env_prefix", "mode")):
                raise UpdateEvidenceError("ADL 恢复记录的冻结账户身份不一致")
        events, batches, prior_orders = state.get("events"), state.get("batches"), state.get("prior_orders", [])
        if (not isinstance(events, list) or any(not isinstance(event, dict)
                or event.get("account_id") not in member_ids for event in events)
                or not isinstance(batches, list) or not isinstance(prior_orders, list)):
            raise UpdateEvidenceError("ADL 恢复事件或批次记录不完整")
        for batch in batches + prior_orders:
            if (not isinstance(batch, dict) or batch.get("account_id") not in member_ids
                    or batch.get("state") not in {"sending", "terminal"}):
                raise UpdateEvidenceError("ADL 恢复批次的账户或状态无效")
            order, sent_at = batch.get("order"), batch.get("sent_at")
            if (not isinstance(order, dict) or not isinstance(order.get("symbol"), str) or not order["symbol"]
                    or not isinstance(order.get("newClientOrderId"), str) or not order["newClientOrderId"]
                    or order.get("positionSide") not in {"LONG", "SHORT", "BOTH"}
                    or order.get("side") not in {"BUY", "SELL"} or order.get("type") != "MARKET"
                    or type(sent_at) not in (int, float) or not math.isfinite(sent_at) or sent_at < 0):
                raise UpdateEvidenceError("ADL 恢复订单缺少原始查询标识或发送时间")
            positive(order.get("quantity"))

    def _recovery_identities(self, inventory, accounts, pairs, brokers):
        """Validate local journal ownership, without querying historical orders."""
        account_map = {account["id"]: account for account in accounts}
        pair_map = {pair["id"]: pair for pair in pairs}
        extra_credentials = {}
        try:
            intents, records, deleted_accounts = inventory
            deleted_accounts = {row[0] for row in deleted_accounts}
            deleted_pairs = {key.split(":", 1)[1] for key, raw in records if key.startswith("pair_deleted:")
                             and isinstance(json.loads(raw), dict) and json.loads(raw).get("deleted_at")}
            for intent_id, account_id, status, raw in intents:
                if account_id not in account_map:
                    raise UpdateEvidenceError("未完成批次属于已不存在的账户，无法覆盖完整挂单检查")
                intent = json.loads(raw)
                if not isinstance(intent, dict) or any(intent.get(key) != value for key, value in
                        (("id", intent_id), ("account_id", account_id), ("status", status))):
                    raise UpdateEvidenceError("未完成批次的持久化账户标识或状态不一致")
            for record_key, raw in records:
                kind, owner = record_key.split(":", 1)
                state = json.loads(raw)
                if kind == "pair_deleted":
                    continue
                if kind == "post_fill_check":
                    # Normal deletion retains empty recovery keys and history.
                    if (state is False or state in (None, {})) and (owner in account_map or owner in deleted_accounts):
                        continue
                    if owner not in account_map:
                        raise UpdateEvidenceError("成交后检查属于已不存在的账户，无法覆盖完整挂单检查")
                    # The occupancy reconciler still supports old boolean
                    # markers; preserve them without inventing missing fields.
                    if type(state) is bool:
                        continue
                    if state is not None and (not isinstance(state, dict) or not isinstance(state.get("symbol"), str)
                            or state.get("account_id", owner) != owner):
                        raise UpdateEvidenceError("成交后检查记录格式或账户标识无效")
                    continue
                if not isinstance(state, dict):
                    raise UpdateEvidenceError("配对恢复记录格式无效，无法确认更新后可继续恢复")
                if kind == "adl_pair":
                    if state.get("status") not in {"active", "blocked", "completed"} or type(state.get("hold")) is not bool:
                        raise UpdateEvidenceError("ADL 恢复记录状态无效")
                    if state["status"] == "completed" and not state["hold"]:
                        # Released history cannot authorize a future write and
                        # must not bind updates to retired accounts/credentials.
                        continue
                pending, watch = state.get("pending"), state.get("recovery_watch")
                if owner not in pair_map:
                    if owner in deleted_pairs and pending is None and watch is None:
                        if kind == "pair_runtime" and not any(dec(qty) for qty in
                                list((state.get("owned") or {}).values()) +
                                list((state.get("progress") or {}).get("quantities", {}).values())):
                            continue
                        if kind == "pair_margin" and state.get("status") not in {
                                "submitting", "accepted", "acknowledged", "unknown"}:
                            continue
                    raise UpdateEvidenceError("恢复记录属于已不存在的配对组，无法覆盖完整挂单检查")
                if pending is None and watch is None and kind != "adl_pair":
                    if kind == "pair_margin" and state.get("status") in {"submitting", "accepted", "acknowledged", "unknown"}:
                        raise UpdateEvidenceError("待核对划转缺少持久化请求记录")
                    # Inactive history is not an account authorization. New
                    # trading retains its own identity/configuration guards.
                    continue
                pair = pair_map[owner]
                members = {side: account_map[pair[side + "_account_id"]] for side in ("long", "short")}
                if (members["long"]["id"] == members["short"]["id"]
                        or members["long"]["mode"] != members["short"]["mode"]):
                    raise UpdateEvidenceError("配对恢复记录的账户身份无效")
                identities, children = {}, {}
                for side, member in members.items():
                    identity = {"account_id": member["id"], "env_prefix": member["env_prefix"],
                                "mode": member["mode"], "side": side.upper()}
                    if member["mode"] == "live":
                        child = brokers[member["id"]].api.credentials
                        children[side] = child
                        identity.update(user=child["user"].lower(), signer=child["signer"].lower())
                    identities[side] = identity
                if children and children["long"]["user"].lower() == children["short"]["user"].lower():
                    raise UpdateEvidenceError("配对恢复记录的两个方向指向同一个真实账户")
                if kind == "adl_pair":
                    self._adl_recovery(state, owner, members, identities)
                elif kind == "pair_runtime":
                    require_runtime_symbols(pair, state)
                    if "identities" in state and state["identities"] != identities:
                        raise UpdateEvidenceError("配对恢复记录与当前账户身份不一致")
                    if pending is not None and (not isinstance(pending, dict) or not pending.get("id")
                            or pending.get("identities") != identities or pending.get("pair_id", owner) != owner):
                        raise UpdateEvidenceError("未完成配对批次格式或账户身份不一致")
                    if watch is not None:
                        batches = watch.get("batches") if isinstance(watch, dict) else None
                        if not isinstance(batches, list) or not batches:
                            raise UpdateEvidenceError("历史订单观察记录格式无效")
                        if watch.get("retired_identities", identities) != identities:
                            raise UpdateEvidenceError("已退役历史观察记录与当前账户身份不一致")
                        for batch in batches:
                            if not isinstance(batch, dict) or batch.get("identities") != identities:
                                raise UpdateEvidenceError("历史订单观察记录与当前账户身份不一致")
                            legs = batch.get("legs")
                            if (not isinstance(legs, list) or len(legs) < 2
                                    or any(not isinstance(leg, dict) for leg in legs)
                                    or {leg.get("key") for leg in legs} != {"long", "short"}
                                    or any(not isinstance(leg.get("order"), dict)
                                           or not leg["order"].get("newClientOrderId") for leg in legs)):
                                raise UpdateEvidenceError("历史订单观察明细无效")
                elif pending is not None:
                    if not MarginBalancer._valid_pending(pending) or not children:
                        raise UpdateEvidenceError("待核对划转记录格式或账户身份无效")
                    prefix = pair["margin"]["master_env_prefix"]
                    if not prefix or prefix in {member["env_prefix"] for member in members.values()}:
                        raise UpdateEvidenceError("待核对划转的主账户凭据配置无效")
                    master = deepcopy(credentials_for(prefix))
                    if (master["user"].lower() in {child["user"].lower() for child in children.values()}
                            or pending["identity"] != MarginBalancer._fingerprint(pair, members, children, master)):
                        raise UpdateEvidenceError("待核对划转记录与当前账户身份不一致")
                    extra_credentials[prefix] = master
            return extra_credentials
        except UpdateEvidenceError:
            raise
        except Exception:
            raise UpdateEvidenceError("持久化恢复记录格式、账户身份或凭据无法核实") from None

    def update_status(self):
        result = {"busy": True, "maintenance": self.active}
        if not self.check_lock.acquire(blocking=False):
            return {**result, "reason": "账户委托核查仍在进行，请稍后重试"}
        try:
            with self.lock:
                generation = self.generation
                if not self.active or self.inflight or not self._owned():
                    return {**result, "reason": "维护门、在途请求或执行进程锁尚未核实"}
            accounts, pairs = self.engine.store.accounts(), self.engine.store.pairs()
            with ExitStack() as stack:
                # Running execution workers must finish local journal updates.
                # Never queue behind a worker that is waiting on exchange I/O.
                for account in sorted(accounts, key=lambda row: row["id"]):
                    lock = self.engine.account_lock(account["id"])
                    if not lock.acquire(blocking=False):
                        return {**result, "reason": "账户执行仍在进行，请等待本轮核对完成"}
                    stack.callback(lock.release)
                inventory = self._durable_inventory(accounts, pairs)
                live = [account for account in accounts if account["mode"] == "live"]
                with self.engine.lock:
                    # A configured live account must also be checked after a
                    # restart; lack of a cached connection is never empty proof.
                    try:
                        brokers = {account["id"]: self.engine.broker(account) for account in live}
                    except Exception:
                        return {**result, "reason": "实盘账户缺少有效凭据，无法核查完整挂单；请配置凭据后重试"}
                evidence = []
                for account in live:
                    broker = brokers[account["id"]]
                    if not isinstance(broker, LiveBroker):
                        raise ValueError("live broker unavailable")
                    credentials = deepcopy(credentials_for(account["env_prefix"]))
                    if credentials != broker.api.credentials:
                        raise ValueError("account identity changed")
                    with broker._snapshot_lock:
                        version = broker._snapshot_generation
                    evidence.append((account, broker, version, credentials))
                extra_credentials = self._recovery_identities(inventory, accounts, pairs, brokers)
                # Restart preserves pending recovery. Admission needs quiescent
                # workers and fresh complete open orders, not historical finality.
                started = time.monotonic()
                deadline = started + 30
                def read(account):
                    broker = brokers[account["id"]]
                    timeout = min(8, deadline - time.monotonic())
                    if timeout <= 0:
                        raise ValueError("update evidence deadline exceeded")
                    # No symbol filter: this is the account's complete current
                    # exchange inventory. Ordinary/cycle snapshots omit orders.
                    orders = broker.api.call("GET", "/fapi/v3/openOrders", signed=True, weight=40, timeout=timeout)
                    if not isinstance(orders, list) or orders:
                        raise ValueError("open orders unknown or nonempty")
                with ThreadPoolExecutor(max_workers=4, thread_name_prefix="aster-update") as pool:
                    list(pool.map(read, live))
                for _, broker, _, _ in evidence:
                    stack.enter_context(broker._snapshot_lock)
                for account, broker, version, credentials in evidence:
                    if broker._snapshot_generation != version:
                        return {**result, "reason": "核查期间账户版本发生变化，请等待新快照后重试"}
                    if credentials_for(account["env_prefix"]) != credentials or broker.api.credentials != credentials:
                        return {**result, "reason": "账户凭据发生变化，请重新核对"}
                    if self.engine.brokers.get(account["id"]) is not broker:
                        return {**result, "reason": "账户执行所有权发生变化，请重新核对"}
                if any(credentials_for(prefix) != credentials for prefix, credentials in extra_credentials.items()):
                    return {**result, "reason": "划转主账户凭据发生变化，请重新核对"}
                with self.lock:
                    if (not self.active or self.generation != generation or self.inflight or not self._owned()
                            or self.engine.store.accounts() != accounts or self.engine.store.pairs() != pairs
                            or self._durable_inventory(accounts, pairs) != inventory):
                        return {**result, "reason": "核查期间维护状态、账户配置或执行状态发生变化"}
                    if not 0 <= time.monotonic() - started <= 30:
                        return {**result, "reason": "订单核查结果已过期，请重新核对"}
                return {"busy": False, "maintenance": True, "checkedAccounts": len(live)}
        except UpdateEvidenceError as exc:
            return {**result, "reason": str(exc)}
        except Exception:
            return {**result, "reason": "实盘账户委托读取失败、凭据变更或存在活动订单，暂不能更新"}
        finally:
            self.check_lock.release()

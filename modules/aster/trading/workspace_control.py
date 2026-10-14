"""Process-local maintenance admission and fresh, fail-closed update evidence."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, ExitStack
import os
import threading
import time

from .exchange import RequestNotSent, LiveBroker, credentials_for


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

    def _local_pending(self, accounts, pairs):
        store = self.engine.store
        # Inspect the complete intent inventory, including any orphaned account.
        with store.connect() as db:
            if db.execute("SELECT 1 FROM intents WHERE status NOT IN ('complete','aborted') LIMIT 1").fetchone():
                return True
        for account in accounts:
            if store.get("post_fill_check:" + account["id"]):
                return True
        for pair in pairs:
            runtime = store.get("pair_runtime:" + pair["id"], {})
            margin = store.get("pair_margin:" + pair["id"], {})
            if not isinstance(runtime, dict) or not isinstance(margin, dict):
                return True
            if runtime.get("pending") is not None or runtime.get("recovery_watch") is not None:
                return True
            if margin.get("pending") is not None or margin.get("status") in {"submitting", "accepted", "acknowledged", "unknown"}:
                return True
        return False

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
                if self._local_pending(accounts, pairs):
                    return {**result, "reason": "仍有未完成订单、历史订单观察或待核实划转，请完成核对后再更新"}
                live = [account for account in accounts if account["mode"] == "live"]
                with self.engine.lock:
                    # A configured live account must also be checked after a
                    # restart; lack of a cached connection is never empty proof.
                    try:
                        brokers = {account["id"]: self.engine.broker(account) for account in live}
                    except Exception:
                        return {**result, "reason": "实盘账户缺少有效凭据，无法核查完整挂单；请配置凭据后重试"}
                def read(account):
                    broker = brokers[account["id"]]
                    if not isinstance(broker, LiveBroker):
                        raise ValueError("live broker unavailable")
                    credentials = credentials_for(account["env_prefix"])
                    if credentials != broker.api.credentials:
                        raise ValueError("account identity changed")
                    with broker._snapshot_lock:
                        version = broker._snapshot_generation
                    started = time.monotonic()
                    # No symbol filter: this is the account's complete current
                    # exchange inventory. Ordinary/cycle snapshots omit orders.
                    orders = broker.api.call("GET", "/fapi/v3/openOrders", signed=True, weight=40, timeout=8)
                    if not isinstance(orders, list) or orders:
                        raise ValueError("open orders unknown or nonempty")
                    return account, broker, version, started, credentials
                with ThreadPoolExecutor(max_workers=4, thread_name_prefix="aster-update") as pool:
                    evidence = list(pool.map(read, live))
                now = time.monotonic()
                for _, broker, _, _, _ in evidence:
                    stack.enter_context(broker._snapshot_lock)
                for account, broker, version, started, credentials in evidence:
                    if broker._snapshot_generation != version:
                        return {**result, "reason": "核查期间账户版本发生变化，请等待新快照后重试"}
                    if not 0 <= now - started <= 30 or credentials_for(account["env_prefix"]) != credentials:
                        return {**result, "reason": "挂单核查结果已过期或账户凭据发生变化，请重新核对"}
                    if self.engine.brokers.get(account["id"]) is not broker:
                        return {**result, "reason": "账户执行所有权发生变化，请重新核对"}
                with self.lock:
                    if (not self.active or self.generation != generation or self.inflight or not self._owned()
                            or self.engine.store.accounts() != accounts or self.engine.store.pairs() != pairs
                            or self._local_pending(accounts, pairs)):
                        return {**result, "reason": "核查期间维护状态、账户配置或执行状态发生变化"}
                return {"busy": False, "maintenance": True, "checkedAccounts": len(live)}
        except Exception:
            return {**result, "reason": "实盘账户委托读取失败、凭据变更或存在活动订单，暂不能更新"}
        finally:
            self.check_lock.release()

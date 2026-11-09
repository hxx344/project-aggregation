"""Exclusive two-account ownership, configuration and scheduler coordination."""
from contextlib import ExitStack, contextmanager
from copy import deepcopy
import json
import math
import re
import threading
import time

from .account_legacy import legacy_position, LEGACY_PENDING_REASON
from .pair_legacy import without_cycle, has_legacy_cycle, require_no_legacy_cycle, LEGACY_CYCLE_REASON
from .adl_config import validate_adl
from .exchange import LiveBroker
from .margin_balance import DEFAULT_MARGIN, validate_margin
from .margin_control import adl_margin_start_allowed, margin_running, read_control, save_control
from .models import AccountModeError, TradingError, positive, wire

from .pair_planning import require_no_legacy_orders, require_runtime_symbols
from .pair_symbols import DEFAULT_PAIR_SYMBOL, get_symbol_config, validate_symbol
from .account_writer import protected_pair_id
# Pair ordinary opening was removed. Stored pairs keep this disabled object
# so a rollback can still validate them; no code path reads or enables it.
LEGACY_ORDINARY = {"enabled": False, "threshold": "10000", "order_notional": "1000",
                   "min_open_leverage": 5, "margin_limit": "0.5", "spread_limit": "0.0005"}
PAIR_FIELDS = {"id", "name", "long_account_id", "short_account_id", "symbol", "enabled",
               "ordinary", "margin", "adl", "revision", "pause_reason"}
INPUT_FIELDS = {"id", "name", "long_account_id", "short_account_id", "symbol", "enabled", "margin", "adl"}


def legacy_ordinary(symbol_config):
    ordinary = {**LEGACY_ORDINARY,
                "threshold": symbol_config["default_threshold"],
                "order_notional": symbol_config["default_order_notional"],
                "spread_limit": symbol_config["default_spread_limit"]}
    for key in ("threshold", "order_notional", "margin_limit", "spread_limit"):
        ordinary[key] = wire(positive(ordinary[key], True))
    return ordinary


def validate_pair(value):
    if isinstance(value, dict):
        value = without_cycle(value)
    if not isinstance(value, dict) or set(value) - PAIR_FIELDS:
        raise TradingError("配对组配置字段无效")
    pair = deepcopy(value)
    for key in ("id", "long_account_id", "short_account_id"):
        if not isinstance(pair.get(key), str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", pair[key]):
            raise TradingError("配对组及账户标识仅支持小写字母、数字、下划线和短横线")
    if pair["long_account_id"] == pair["short_account_id"]:
        raise TradingError("配对组需要两个不同子账户")
    if not isinstance(pair.get("name"), str) or not 1 <= len(pair["name"].strip()) <= 50:
        raise TradingError("配对组名称需为 1 至 50 个字符")
    pair.setdefault("symbol", DEFAULT_PAIR_SYMBOL)
    symbol = validate_symbol(pair["symbol"])
    pair.setdefault("enabled", False)
    if type(pair["enabled"]) is not bool:
        raise TradingError("配对组运行开关必须为布尔值")
    margin = pair.get("margin", {})
    if not isinstance(margin, dict) or set(margin) - set(DEFAULT_MARGIN):
        raise TradingError("保证金均衡配置字段无效")
    margin = {**DEFAULT_MARGIN, **margin}
    if type(margin["enabled"]) is not bool:
        raise TradingError("策略开关必须为布尔值")
    margin = validate_margin(margin)
    if "adl" in pair and not isinstance(pair["adl"], dict):
        raise TradingError("ADL 配置必须为对象")
    pair.update(ordinary=legacy_ordinary(get_symbol_config(symbol)), margin=margin,
                adl=validate_adl(pair.get("adl", {})))
    return pair


def pair_active(pair, runtime=None):
    return bool(pair.get("enabled") or (runtime or {}).get("pending") or has_legacy_cycle(runtime))


class PairManager:
    def __init__(self, engine):
        self.engine, self.store = engine, engine.store
        self.locks = {}
        self.trader = None

    def group_lock(self, pair_id):
        with self.engine.lock:
            return self.locks.setdefault(pair_id, threading.RLock())

    @contextmanager
    def locked(self, pair):
        with self.group_lock(pair["id"]), ExitStack() as stack:
            for aid in sorted((pair["long_account_id"], pair["short_account_id"])):
                stack.enter_context(self.engine.account_lock(aid))
            yield

    def require_unbound(self, account_id):
        if self.store.pair_for_account(account_id):
            raise TradingError("该账户由配对组管理，请在配对组配置或暂停策略")

    def _members(self, pair):
        accounts = [self.store.account(pair[key]) for key in ("long_account_id", "short_account_id")]
        if any(account is None for account in accounts):
            raise TradingError("配对组成员账户不存在")
        if accounts[0]["mode"] != accounts[1]["mode"]:
            raise TradingError("配对组不能混用模拟和实盘账户")
        for account in accounts:
            if account["enabled"]:
                raise TradingError("请先暂停两个子账户原有单账户策略")
            existing = self.store.pair_for_account(account["id"])
            if existing and existing["id"] != pair["id"]:
                raise TradingError("账户已属于其他配对组")
            if self.store.intent(account["id"]) or self.store.get("post_fill_check:" + account["id"]):
                raise TradingError("原账户仍有未完成批次，请先恢复核对")
            if legacy_position(self.store.get("cycle:" + account["id"])):
                raise TradingError(LEGACY_PENDING_REASON)
        return accounts

    def _changed(self, pair):
        with self.engine.lock:
            self.engine.accounts_generation += 1
        for key in ("long_account_id", "short_account_id"):
            self.engine.revoke_account_reads(pair[key], "配对组状态或配置已更新")
        self.engine.scheduler_event.set()

    def create(self, data):
        if not isinstance(data, dict) or set(data) - INPUT_FIELDS:
            raise TradingError("配对组创建字段无效")
        if data.get("enabled") not in (None, False):
            raise TradingError("新配对组必须先保存，再单独启动")
        pair = validate_pair({**data, "enabled": False})
        with self.locked(pair), self.engine.registration_lock:
            if (self.store.get("pair_runtime:" + pair["id"]) or self.store.get("pair_margin:" + pair["id"])
                    or self.store.get("pair_margin_control:" + pair["id"]) is not None
                    or self.store.get("pair_deleted:" + pair["id"])):
                raise TradingError("配对组标识存在历史记录，请使用新标识")
            # Funds ownership does not adopt or constrain positions.
            self._members(pair)
            pair = self.store.save_pair(pair, create=True)
            self.store.event(pair["id"], "pair", "双子账户配对组已建立，默认暂停")
            self._changed(pair)
        return pair

    def _idle(self, pair):
        self.engine.adl.require_clear(pair["id"])
        if pair["enabled"]:
            raise TradingError("请先暂停配对组")
        runtime = self.store.get("pair_runtime:" + pair["id"], {})
        margin = self.store.get("pair_margin:" + pair["id"], {})
        if not isinstance(runtime, dict) or not isinstance(margin, dict):
            raise TradingError("配对组或保证金日志无效，请先核对")
        require_no_legacy_cycle(runtime, self.store)
        require_no_legacy_orders(runtime)
        self._require_margin_settled(margin)
        return runtime

    @staticmethod
    def _require_margin_settled(margin):
        from .margin_balance import MarginBalancer
        if not isinstance(margin, dict):
            raise TradingError("配对组或保证金日志无效，请先核对")
        if MarginBalancer.unsettled_rejection(margin):
            raise TradingError("划转拒绝回执尚未完成共享结算，暂不能修改原配置或删除配对；请等待只读恢复")
        if margin.get("pending") is not None or margin.get("status") in ("submitting", "acknowledged", "accepted", "unknown"):
            raise TradingError("保证金划转结果尚未核实，暂不能修改设置或删除；请查看保证金平衡中的核对状态")

    def configure(self, pair_id, changes):
        previous = self.store.pair(pair_id)
        if not previous:
            raise TradingError("配对组不存在")
        if not isinstance(changes, dict) or not changes or set(changes) - {"name", "symbol", "margin", "adl"}:
            raise TradingError("仅可修改组名称、交易标的、保证金平衡及 ADL 配置，账户方向固定")
        with self.locked(previous):
            pair = self.store.pair(pair_id)
            if pair is None:
                raise TradingError("配对组不存在")
            self._idle(pair)
            updated = deepcopy(pair)
            for key, value in changes.items():
                if key in ("name", "symbol"):
                    updated[key] = value
                elif not isinstance(value, dict) or not value:
                    raise TradingError("请提供有效的配对策略配置")
                else:
                    updated[key] = {**updated.get(key, {}), **value}
            switching = updated["symbol"] != pair["symbol"]
            updated = validate_pair(updated)
            if switching:
                return self._switch_symbol(pair, updated)
            self._members(updated)
            saved = self.store.save_pair(updated)
            self._changed(saved)
            return saved

    def _identity_check(self, accounts, brokers, identities, action):
        def check_current():
            # Account configuration and bindings are compared inside the writer
            # transaction. Do not nest Store reads here: a scoped connection's
            # nested context could commit that transaction before its writes.
            for key, account in zip(("long", "short"), accounts):
                with self.engine.lock:
                    broker = self.engine.brokers.get(account["id"])
                if broker is not brokers[key]:
                    raise TradingError(f"{action}核验期间账户连接已变化，请重新核对")
                if isinstance(broker, LiveBroker) and any(
                        broker.api.credentials[field].lower() != identities[key][field]
                        for field in ("user", "signer")):
                    raise TradingError(f"{action}核验期间账户身份已变化，请重新核对")
        return check_current

    def _switch_symbol(self, pair, updated):
        """Change a paused funds pair's symbol without reads, orders or transfers."""
        from .pair_execution import PairTrader, runtime_default
        original = self._idle(pair)
        require_runtime_symbols(pair, original)
        # This exact journal becomes the store's compare-and-swap expectation,
        # so a transfer written after the idle check must be rejected here.
        margin = self.store.get("pair_margin:" + pair["id"], {})
        self._require_margin_settled(margin)
        accounts = self._members(pair)
        _, brokers, identities = PairTrader(self.engine)._members(pair, read_only=True)
        if original.get("identities") and original["identities"] != identities:
            raise TradingError("配对组凭据指向的真实账户发生变化，不能修改交易标的，请先核对账户身份")
        runtime = runtime_default()
        runtime.update(symbol=updated["symbol"], identities=identities,
            reason=f"交易标的已从 {pair['symbol']} 切换为 {updated['symbol']}；配对组保持暂停，请核对设置后启动",
            updated_at=time.time())
        updated.pop("pause_reason", None)
        saved = self.store.switch_pair_symbol(updated, runtime, expected_pair=pair,
            expected_runtime=original, expected_margin=margin, accounts=accounts,
            check_current=self._identity_check(accounts, brokers, identities, "切换标的"))
        self._changed(saved)
        return saved

    def enable(self, pair_id, enabled):
        original = self.store.pair(pair_id)
        if not original:
            raise TradingError("配对组不存在")
        with self.locked(original):
            pair = self.store.pair(pair_id)
            if enabled:
                if pair["enabled"]:
                    raise TradingError("配对组已启动，无需重复启动")
                if not pair["margin"]["enabled"]:
                    raise TradingError("请先开启保证金平衡，再启动配对组")
                self.engine.adl.before_enable(pair)
                saved = self._enable_margin(pair)
                self.engine.adl.after_enable(saved)
            else:
                # Revoke funds intent even if ADL already paused the pair.
                # Keep its frozen revision and emergency processing unchanged.
                with self.store.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    save_control(db, pair, enabled=False)
                if not pair["enabled"]:
                    try:
                        self.engine.adl.require_clear(pair_id)
                    except TradingError:
                        # ADL already paused this pair. A repeated user pause
                        # must not change the incident's frozen config revision.
                        self._changed(pair)
                        return pair
                pair["enabled"] = False
                saved = self.store.save_pair(pair)
                self.store.event(pair_id, "pair", "配对组已暂停，停止新划转；已提交划转继续核对，两侧持仓保留")
            self._changed(saved)
            return saved

    @protected_pair_id
    def enable_adl_margin(self, pair_id):
        """Explicitly resume funds for an old/user-paused ADL hold, not trading."""
        from .account_writer import funds_budget
        from .margin_balance import MarginBalancer
        from .pair_execution import PairTrader
        pair = self.store.pair(pair_id)
        if pair is None:
            raise TradingError("配对组不存在")
        with self.locked(pair), self.store.connection_scope():
            pair = self.store.pair(pair_id)
            if pair is None:
                raise TradingError("配对组不存在")
            incident = self.store.get("adl_pair:" + pair_id)
            control = self.store.get("pair_margin_control:" + pair_id)
            if not adl_margin_start_allowed(pair, incident):
                raise TradingError("仅 ADL 暂停期间可单独启动已配置的保证金平衡")
            if margin_running(pair, control):
                return pair
            trader = PairTrader(self.engine)
            accounts, brokers, identities = trader._members(pair)

            def check_current():
                if self.engine.workspace.active or self.engine.shutdown.is_set():
                    raise TradingError("工作台维护或停止中，不能启动保证金平衡")
                for side, account in accounts.items():
                    broker = brokers[side]
                    if (not self.engine.live_allowed(account)
                            or self.engine.brokers.get(account["id"]) is not broker):
                        raise TradingError("保证金启动期间账户连接或实盘授权已变化")
                    if isinstance(broker, LiveBroker) and any(
                            broker.api.credentials[field].lower() != identities[side][field]
                            for field in ("user", "signer")):
                        raise TradingError("保证金启动期间账户身份已变化")
                trader._margin_credentials(accounts, brokers)

            check_current()
            with funds_budget(self.engine, pair):
                MarginBalancer(self.engine).verify_members(pair)
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT data FROM pairs WHERE id=?", (pair_id,)).fetchone()
                current_incident = db.execute("SELECT data FROM kv WHERE key=?", ("adl_pair:" + pair_id,)).fetchone()
                if (not row or without_cycle(json.loads(row[0])) != pair
                        or not current_incident or json.loads(current_incident[0]) != incident
                        or read_control(db, pair_id) != control):
                    raise TradingError("保证金启动期间配对、ADL 或暂停状态已变化，请重新操作")
                for side, account in accounts.items():
                    row = db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
                    binding = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (account["id"],)).fetchone()
                    if (not row or self.store.account_defaults(json.loads(row[0])) != account
                            or not binding or tuple(binding) != (pair_id, "LONG" if side == "long" else "SHORT")):
                        raise TradingError("保证金启动期间子账户配置或归属已变化")
                check_current()
                save_control(db, pair)
                db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                    (pair_id, "pair", "ADL 暂停期间已单独启动保证金平衡；交易策略和原事件保持不变", time.time()))
            self._changed(pair)
            return pair

    def _enable_margin(self, pair):
        """Start funds management without adopting or clearing positions."""
        from .margin_balance import MarginBalancer
        from .pair_execution import PairTrader, runtime_default
        original = self.store.get("pair_runtime:" + pair["id"], {})
        margin = self.store.get("pair_margin:" + pair["id"], {})
        if not isinstance(original, dict) or not isinstance(margin, dict):
            raise TradingError("配对组或保证金日志无效，请先核对")
        accounts = self._members(pair)
        trader = PairTrader(self.engine)
        _, brokers, identities = trader._members(pair)
        if original.get("identities") and original["identities"] != identities:
            raise TradingError("配对组凭据指向的真实账户发生变化，请先核对账户身份")
        require_no_legacy_orders(original)
        MarginBalancer(self.engine).verify_members(pair)
        if trader._members(pair)[2] != identities:
            raise TradingError("启动核验期间账户身份已变化，请重新核对")
        runtime = {**runtime_default(), **deepcopy(original)}
        reason = "保证金平衡已启动，按两侧 USD1 可用余额检查划转"
        runtime.update(identities=identities, phase="monitoring", reason=reason, updated_at=time.time())
        if has_legacy_cycle(runtime, self.store):
            runtime.update(phase="attention", reason=LEGACY_CYCLE_REASON, attention=LEGACY_CYCLE_REASON)
        pair = {**pair, "enabled": True}
        pair.pop("pause_reason", None)

        def check_current():
            # No Store reads inside activate_pair's database transaction.
            for key, broker in brokers.items():
                account = next(row for row in accounts if row["id"] == pair[key + "_account_id"])
                if not self.engine.live_allowed(account):
                    raise TradingError("服务器尚未启用实盘执行（ASTER_ALLOW_LIVE=1）")
                if self.engine.brokers.get(account["id"]) is not broker:
                    raise TradingError("启动核验期间账户连接已变化，请重新核对")
                if isinstance(broker, LiveBroker):
                    credentials = broker.api.credentials
                    if any(credentials[field].lower() != identities[key][field] for field in ("user", "signer")):
                        raise TradingError("启动核验期间账户身份已变化，请重新核对")

        self.engine.adl.require_clear(pair["id"], allow_completed=True)
        return self.store.activate_pair(pair, runtime, expected_runtime=original,
            expected_margin=margin, accounts=accounts, check_current=check_current, message=reason)

    def delete(self, pair_id):
        """Unbind a paused funds pair; both accounts keep their positions."""
        pair = self.store.pair(pair_id)
        if not pair:
            raise TradingError("配对组不存在")
        with self.locked(pair), self.engine.registration_lock:
            pair = self.store.pair(pair_id)
            runtime = self._idle(pair)
            margin = self.store.get("pair_margin:" + pair_id, {})
            accounts = self._members(pair)
            from .pair_execution import PairTrader
            _, brokers, identities = PairTrader(self.engine)._members(pair, read_only=True)
            if runtime.get("identities") and runtime["identities"] != identities:
                raise TradingError("配对组账户身份已变化，不能解除绑定")
            self.store.delete_pair(pair_id, expected_pair=pair, expected_runtime=runtime,
                expected_margin=margin, accounts=accounts,
                check_current=self._identity_check(accounts, brokers, identities, "解除绑定"))
            self.store.event(pair_id, "pair", "配对组已解除绑定；两个子账户的持仓及历史执行记录保留")
            self._changed(pair)

    def states(self, reader=None):
        from .adl_view import status_view as adl_status_view
        from .margin_balance import MarginBalancer
        reader = reader or self.store
        rows = []
        for pair in reader.pairs():
            control = reader.get("pair_margin_control:" + pair["id"])
            runtime = reader.get("pair_runtime:" + pair["id"]) or {}
            state = {"phase": "waiting" if pair["enabled"] else "paused",
                     "reason": pair.get("pause_reason") or ("等待系统首次检查两侧账户与策略条件" if pair["enabled"] else "配对组已暂停；核对设置后需点击启动"),
                     "updated_at": None, "snapshots": {}, "pending": None, **runtime}
            state["margin"] = MarginBalancer.status_view(pair,
                reader.get("pair_margin:" + pair["id"], {}), state.get("margin"), control=control)
            state["margin"]["running"] = margin_running(pair, control)
            for field in ("progress", "cycle_costs", "execution_quality", "execution_quality_history"):
                state.pop(field, None)
            if has_legacy_cycle(runtime, reader):
                state.update(phase="attention", reason=LEGACY_CYCLE_REASON, attention=LEGACY_CYCLE_REASON)
            state["adl"] = adl_status_view(self.engine, reader, pair, runtime)
            rows.append({**pair, "adl": validate_adl(pair.get("adl")), "state": state})
        return rows

    def active_for_account(self, account_id):
        pair = self.store.pair_for_account(account_id)
        return pair if pair and pair_active(pair, self.store.get("pair_runtime:" + pair["id"])) else None

    @protected_pair_id
    def tick_margin(self, pair_id):
        """Cold-start funds jobs do not enter ADL, positions or market paths."""
        pair = self.store.pair(pair_id)
        if not pair or self.engine.shutdown.is_set():
            return 5
        with self.locked(pair), self.store.connection_scope():
            pair = self.store.pair(pair_id)
            if not pair:
                return 5
            if self.trader is None:
                from .pair_execution import PairTrader
                self.trader = PairTrader(self.engine)
            result = self.trader.margin_tick(pair)
            return self._funds_poll_delay(pair, max(1, result.get("retry_after", 5)))

    @protected_pair_id
    def tick(self, pair_id):
        pair = self.store.pair(pair_id)
        if not pair or self.engine.shutdown.is_set():
            return 5
        with self.locked(pair), self.store.connection_scope():
            pair = self.store.pair(pair_id)
            if not pair:
                return 5
            try:
                accounts = [self.store.account(pair[side + "_account_id"]) for side in ("long", "short")]
                if any(account is None for account in accounts):
                    raise TradingError("配对组成员账户不存在")
                if any(not self.engine.live_allowed(account) for account in accounts):
                    raise TradingError("服务器未开放实盘执行，配对组仅保留现有记录")
                if self.trader is None:
                    from .pair_execution import PairTrader
                    self.trader = PairTrader(self.engine)
                margin_result = self.trader.margin_tick(pair)
                self._members(pair)
                adl_state = self.engine.adl.tick(pair)
                if adl_state is not None:
                    return self._funds_poll_delay(pair, max(1, adl_state.get("retry_after", 0)))
                state = self.trader.tick(pair, margin_result=margin_result)
                delay = self.poll_interval(pair, state)
                delay = max(delay, state.get("retry_after", 0))
                return self._funds_poll_delay(pair, delay)
            except (TradingError, KeyError, ValueError, TypeError) as exc:
                runtime = self.store.get("pair_runtime:" + pair_id) or {}
                runtime.update(phase="attention" if isinstance(exc, AccountModeError) else "waiting",
                               reason=str(exc) if isinstance(exc, TradingError) else "配对数据暂不可用，系统将重新读取；若持续出现，请检查服务器日志", updated_at=time.time())
                self.store.put("pair_runtime:" + pair_id, runtime)
                if isinstance(exc, AccountModeError) and pair["enabled"]:
                    self.store.save_pair({**pair, "enabled": False, "pause_reason": str(exc)})
                    self._changed(pair)
                return self._funds_poll_delay(pair, max(1, getattr(exc, "retry_after", 0)))

    def _funds_poll_delay(self, pair, delay):
        """An ADL/strategy wait cannot move the independent funds deadline."""
        margin = self.store.get("pair_margin:" + pair["id"]) or {}
        if isinstance(margin, dict) and (margin.get("pending") or margin_running(
                pair, self.store.get("pair_margin_control:" + pair["id"]))):
            deadlines = [margin.get("next_check_at", 0)]
            if not margin.get("pending"):
                deadlines.append(margin.get("cooldown_until", 0))
            deadline = max((value for value in deadlines
                if type(value) in (int, float) and math.isfinite(value)), default=0)
            remaining = deadline - time.time()
            return min(delay, max(1, remaining if remaining > 0 else pair["margin"]["check_interval_seconds"]))
        return delay

    def poll_interval(self, pair, state):
        margin = self.store.get("pair_margin:" + pair["id"]) or {}
        # Legacy order batches only wait for a rollback now; fast polling cannot resolve them.
        if margin.get("pending"):
            return 1
        if not pair["enabled"]:
            return 30
        return min(5, pair["margin"]["check_interval_seconds"])

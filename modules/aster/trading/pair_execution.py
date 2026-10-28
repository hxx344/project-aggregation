"""Durable two-subaccount execution. Recovery never repeats an uncertain write."""
from concurrent.futures import ThreadPoolExecutor
from .account_writer import protected_pair, writer_for
from contextlib import ExitStack, contextmanager, nullcontext
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
from fractions import Fraction
import logging
import math
import time
import uuid

from .exchange import (AmbiguousOrder, ExchangeError, LiveBroker, RequestNotSent,
                       LeverageRejected, ORDER_REJECTION_CODES, api_wait_notice, definitive_order_error,
                       order_absent)
from .exchange_messages import exchange_reason, MISSING_REJECT_REASON
from .execution import Executor, TERMINAL
from .models import TradingError, dec, positive, wire, floor_step, opening_margin_limit
from .paper import PaperOrderAbsent
from .pair_planning import (SIDES, PairPositionError, PairRecoveryConflict, positions, require_quantities,
                            plan_ordinary, ordinary_upgrade, ordinary_upgrade_blocker,
                            require_runtime_symbols)
from .store import dumps
from .pair_legacy import require_no_legacy_cycle

LOG = logging.getLogger("aster.trading")


def runtime_default():
    return {"phase": "paused", "reason": "配对组尚未启动；核对两侧账户及策略设置后，点击启动才开始执行", "owned": {"LONG": "0", "SHORT": "0"},
            "pending": None, "snapshots": {}, "daily_volume": {}}


class PairTrader:
    def __init__(self, engine):
        self.engine, self.store, self.market = engine, engine.store, engine.market
        self._ordinary_observations = {}
        self._margin_identity = ContextVar("aster_margin_identity", default=None)

    def _ordinary_wait(self, pair, state, identities, margin_state):
        """Reuse recent reads only to reject work, never to authorize a write."""
        symbol = pair["symbol"]
        if not pair["enabled"] or not pair["ordinary"]["enabled"] or state.get("attention"):
            return None
        if pair["margin"]["enabled"] and time.time() >= max(
                margin_state.get("next_check_at", 0), margin_state.get("cooldown_until", 0)):
            return None
        observed = self._ordinary_observations.get(pair["id"])
        if not observed or observed[0] != (pair["revision"], identities):
            return None
        snapshots, guards, started = observed[1:]
        interval = min(5, pair["margin"]["check_interval_seconds"]) if pair["margin"]["enabled"] else 5
        if not 0 <= time.monotonic() - started < interval:
            return None
        # A slow read has already consumed part of the eight-second freshness
        # window. Start the observation interval at the source read, not its end.
        if any(not 0 <= time.time() - snapshot.timestamp < interval for snapshot in snapshots.values()):
            return None
        try:
            for guard in guards.values():
                guard()
            require_quantities(snapshots, symbol, self._expected(state))
        except TradingError:
            return None
        try:
            capacities = self.engine.capacities(symbol)
            book = self.market.book(symbol)
            book.require_fresh()
            if ordinary_upgrade(pair, snapshots, book, capacities, runtime=state) is not None:
                return None
            plan_ordinary(pair, snapshots, book, self.market.rules[symbol], capacities)
        except PairPositionError:
            return None
        except TradingError as exc:
            return str(exc)
        return None

    def _save(self, pair, state):
        state["updated_at"] = time.time()
        self.store.put("pair_runtime:" + pair["id"], self._durable(state))

    @staticmethod
    def _durable(state):
        # This relative delay belongs to this scheduler turn, not a restarted one.
        return {key: value for key, value in state.items() if key not in {"retry_after", "_trading_write_started"}}

    @staticmethod
    def _retry_delay(state, exc):
        delay = getattr(exc, "retry_after", 0)
        if type(delay) in (int, float) and math.isfinite(delay) and delay > 0:
            state["retry_after"] = max(state.get("retry_after", 0), delay)

    def _members(self, pair, *, read_only=False):
        accounts, brokers, identities = {}, {}, {}
        for key, side in SIDES:
            account = self.store.account(pair[key + "_account_id"])
            if not account or (not read_only and not self.engine.live_allowed(account)):
                raise PairPositionError("配对组子账户不存在或实盘执行未启用")
            broker = self.engine.broker(account)
            accounts[key], brokers[key] = account, broker
            identity = {"account_id": account["id"], "env_prefix": account["env_prefix"], "mode": account["mode"], "side": side}
            if isinstance(broker, LiveBroker):
                credentials = broker.api.credentials
                identity.update(user=credentials["user"].lower(), signer=credentials["signer"].lower())
            identities[key] = identity
        if accounts["long"]["mode"] != accounts["short"]["mode"]:
            raise PairPositionError("配对组两个子账户必须使用同一运行模式")
        if identities["long"].get("user") and identities["long"]["user"] == identities["short"].get("user"):
            raise PairPositionError("两个方向不能使用同一个真实账户")
        return accounts, brokers, identities

    def _read(self, brokers, symbol, *, reconciliation=False, fresh_modes=False, margin=False):
        # Recovery priority does not require reloading unchanged account modes.
        # Recovery uses their normal TTL; configuration confirmation can force GETs.
        reuse_account_mode = not reconciliation and not fresh_modes
        budgets = {}
        for broker in brokers.values():
            if isinstance(broker, LiveBroker) and getattr(broker.api, "budget", None) is not None:
                budget = broker.api.budget
                weight = (broker.transfer_snapshot_weight()
                          if margin else broker.snapshot_weight([symbol], fresh_modes=fresh_modes,
                                                               reuse_account_mode=reuse_account_mode))
                budgets[budget] = budgets.get(budget, 0) + weight
        # Check the complete shared-budget read before either worker starts;
        # actual requests still perform their own atomic admission checks.
        for budget, weight in budgets.items():
            with budget.reconciliation() if reconciliation else budget.pair_accounting():
                budget.require_available(weight)
        def read(key):
            broker = brokers[key]
            # Budget priority is thread-local: establish it inside each worker.
            budget = (getattr(getattr(broker, "api", None), "budget", None))
            budget = (getattr(budget, "margin", nullcontext)() if margin else
                getattr(broker, "reconciliation_budget", nullcontext)() if reconciliation else nullcontext())
            with budget:
                # Ordinary polling retains the broker's mode TTL; account events
                # still revoke these reads and mode changes clear its cache.
                options = {"reuse_account_mode": reuse_account_mode} if isinstance(broker, LiveBroker) else {}
                snapshot = (broker.transfer_snapshot() if margin and isinstance(broker, LiveBroker)
                            else broker.snapshot([symbol], fresh_modes=fresh_modes, **options))
                guard = (lambda: broker.require_snapshot_current(snapshot)) if isinstance(broker, LiveBroker) else snapshot.require_fresh
                return snapshot, guard
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="pair-read") as pool:
            futures = {key: pool.submit(read, key) for key, _ in SIDES}
            rows = {key: future.result() for key, future in futures.items()}
        for _, guard in rows.values():
            guard()
        return {key: row[0] for key, row in rows.items()}, {key: row[1] for key, row in rows.items()}

    def _balance(self, pair, state, brokers, identities, snapshots=None, guards=None, *, pending_orders=False):
        symbol = pair["symbol"]
        from .margin_balance import MarginBalancer

        def load():
            current, checks = snapshots, guards
            try:
                if any(isinstance(broker, LiveBroker) for broker in brokers.values()) or not current or not checks:
                    raise TradingError("保证金检查需要新账户快照")
                for check in checks.values():
                    check()
            except TradingError:
                # One ordinary-budget REST attempt, only when the balancer's
                # own check is due. These reads never enter the order planner.
                current, checks = self._read(brokers, symbol, margin=True)
            self._publish_balances(state, current)

            def check(side):
                self._margin_guard(pair, identities)
                checks[side]()

            return current, {side: lambda side=side: check(side) for side in checks}

        balancer = MarginBalancer(self.engine)
        result = balancer.tick(pair, snapshots or {}, pending_orders=pending_orders,
            snapshot_guards=guards, snapshot_loader=load)
        if balancer.refreshed_snapshots is not None:
            self._publish_balances(state, balancer.refreshed_snapshots)
        state["margin"] = result
        return result

    def _margin_guard(self, pair, identities):
        current = self.store.pair(pair["id"])
        if (not current or current.get("revision") != pair.get("revision") or not current["enabled"]
                or not current["margin"]["enabled"] or self.engine.workspace.active or self.engine.shutdown.is_set()):
            raise RequestNotSent("保证金配置已变化、配对组暂停或工作台正在停止，未发送请求")
        accounts, brokers, actual = self._members(current)
        if actual != identities:
            raise RequestNotSent("保证金成员真实身份已变化，未发送请求")
        self._margin_credentials(accounts, brokers)

    @staticmethod
    def _margin_credentials(accounts, brokers):
        from .margin_balance import credentials_for
        for side, broker in brokers.items():
            if isinstance(broker, LiveBroker):
                configured = credentials_for(accounts[side]["env_prefix"])
                if any(broker.api.credentials.get(field) != configured.get(field) for field in ("user", "signer", "private_key")):
                    raise PairPositionError("保证金成员实际凭据与当前配置不一致，未发送请求")

    def margin_tick(self, pair):
        """Run before ADL/strategy recovery without reading their runtime state."""
        self._margin_identity.set(None)
        state = self.store.get("pair_runtime:" + pair["id"]) or {}
        state = dict(state) if isinstance(state, dict) else {}
        margin = self.store.get("pair_margin:" + pair["id"], {})
        from .margin_balance import MarginBalancer
        if (not pair["margin"]["enabled"] and isinstance(margin, dict)
                and margin.get("pending") is None and not MarginBalancer.unsettled_rejection(margin)):
            result = MarginBalancer.status_view(pair, margin, state.get("margin"))
            self._observe_margin_alert(pair, result, None)
            return result
        _, brokers, identities = self._members(pair)
        self._margin_identity.set((pair["id"], pair.get("revision"), deepcopy(identities)))
        transfer_pending = isinstance(margin, dict) and margin.get("pending") is not None
        result = self._balance(pair, state, brokers, identities, pending_orders=bool(state.get("pending")))
        if transfer_pending or result.get("status") in {"acknowledged", "confirmed", "skipped", "paper_confirmed"}:
            self._ordinary_observations.pop(pair["id"], None)
        state["updated_at"] = time.time()
        self.store.put("pair_runtime:" + pair["id"], self._durable(state))
        # The strategy tick that follows no longer sees this transfer as
        # pending, so its completion wake-up has to come from here.
        if transfer_pending and not (self.store.get("pair_margin:" + pair["id"]) or {}).get("pending"):
            self._wake_hot_data(pair)
        self._observe_margin_alert(pair, result, state.get("margin_balances"))
        return result

    def _observe_margin_alert(self, pair, view, balances):
        """Record margin alert evidence; a failure here never affects transfers."""
        try:
            from .margin_balance import validate_margin
            margin = validate_margin(pair.get("margin", {}))
            accounts = [self.store.account(pair[side + "_account_id"]) for side in ("long", "short")]
            active = all(account is not None and self.engine.live_allowed(account) for account in accounts)
            self.store.observe_margin_imbalance({
                "pair_id": pair["id"], "name": pair.get("name"), "symbol": pair.get("symbol"),
                "mode": accounts[0]["mode"] if accounts[0] else None, "active": active, "view": view,
                "balances": balances, "threshold": margin["threshold"],
                "check_interval_seconds": margin["check_interval_seconds"], "cooldown_seconds": margin["cooldown_seconds"]})
            error = None
        except Exception:
            error = "保证金不平衡提醒检查失败，等待重试"
            LOG.error("Margin imbalance notification observation failed")
        # Engine.state() reports this beside the other notification errors.
        self.engine.margin_imbalance_error = error

    def _risk_snapshots(self, pair, snapshots, *, recovery=False):
        from .margin_balance import MarginBalancer
        return MarginBalancer(self.engine).risk_snapshots(pair, snapshots, recovery=recovery)

    @contextmanager
    def _confirmed(self, pair, brokers, guards):
        """Keep known account events outside the local recovery commit."""
        with ExitStack() as stack:
            for key in sorted(brokers, key=lambda key: pair[key + "_account_id"]):
                if isinstance(brokers[key], LiveBroker):
                    stack.enter_context(brokers[key]._snapshot_lock)
            for guard in guards.values():
                guard()
            yield

    def _publish_snapshots(self, state, snapshots, symbol):
        from .engine import snapshot_json
        state["snapshots"] = {key: snapshot_json(value, [symbol]) for key, value in snapshots.items()}

    @staticmethod
    def _publish_balances(state, snapshots):
        # Transfer reads intentionally have no positions. Keep them separate
        # from position evidence so neither the planner nor UI can infer flatness.
        state["margin_balances"] = {side: {"timestamp": snapshot.timestamp,
            **{field: wire(getattr(snapshot, field)) for field in ("equity", "available", "wallet", "unrealized")}}
            for side, snapshot in snapshots.items()}
        for side, snapshot in snapshots.items():
            # Keep optional display data separate from the snapshot's trading
            # margin calculation; a missing new value must clear the old one.
            occupied = getattr(snapshot, "display_occupied_margin", None)
            state["margin_balances"][side]["occupied_margin"] = wire(occupied) if occupied is not None else None
            display = getattr(snapshot, "display_positions", None)
            if not isinstance(display, dict):
                continue
            displays = state.setdefault("display_positions", {})
            previous = displays.get(side, {})
            if display["checked_at"] < previous.get("checked_at", 0):
                continue
            # A malformed inventory cannot erase the last complete reading or
            # advance its timestamp. Neither result is execution evidence.
            displays[side] = {**previous, **deepcopy(display)}

    @staticmethod
    def _expected(state):
        require_no_legacy_cycle(state)
        return dict(state["owned"])

    def _config_guard(self, pair, identities, *, opening):
        require_no_legacy_cycle(self.store.get("pair_runtime:" + pair["id"]), self.store)
        try:
            self.engine.adl.require_clear(pair["id"])
        except TradingError as exc:
            raise RequestNotSent(str(exc)) from None
        current = self.store.pair(pair["id"])
        if not current or current.get("revision") != pair.get("revision"):
            raise RequestNotSent("配对组配置已变化，取消本次提交")
        if opening and not current["enabled"]:
            raise RequestNotSent("配对组已暂停，禁止新开仓")
        _, _, actual = self._members(current)
        if actual != identities:
            raise PairPositionError("配对组账户身份发生变化，禁止写入")
        if opening:
            from .pair_recovery import require_archived_orders_clear
            require_archived_orders_clear(self.engine, current)

    @protected_pair
    def tick(self, pair, *, margin_result=None):
        if margin_result is None:
            margin_result = self.margin_tick(pair)
        symbol = pair["symbol"]
        state = {**runtime_default(), **(self.store.get("pair_runtime:" + pair["id"]) or {})}
        pending_at_entry = state.get("pending")
        margin_waiting = False
        trade_work = False
        margin_delay = 0
        state.pop("retry_after", None)
        state.pop("_trading_write_started", None)
        state["api_notice"] = None
        save_state = True
        try:
            state["margin"] = margin_result
            require_no_legacy_cycle(state, self.store)
            self.engine.adl.require_clear(pair["id"])
            accounts, brokers, identities = self._members(pair)
            margin_identity = self._margin_identity.get()
            if (margin_identity is not None and margin_identity[:2] == (pair["id"], pair.get("revision"))
                    and margin_identity[2] != identities):
                raise PairPositionError("保证金检查期间配对组账户身份发生变化，禁止后续交易")
            if state.get("identities") and state["identities"] != identities:
                raise PairPositionError("配对组凭据指向的真实账户发生变化，等待人工核对")
            state["identities"] = identities
            pending = state.get("pending")
            if pending and pending["identities"] != identities:
                raise PairPositionError("未完成批次的账户身份与当前凭据不一致")
            if state.get("volume_unknown") and not state.get("volume_unknown_until_utc"):
                state["volume_unknown_until_utc"] = datetime.now(timezone.utc).date().isoformat()
            if state.get("volume_unknown_until_utc"):
                state["volume_unknown"] = datetime.now(timezone.utc).date().isoformat() <= state["volume_unknown_until_utc"]
            margin_state = self.store.get("pair_margin:" + pair["id"], {})
            if margin_state is None:
                margin_state = {}
            margin_invalid = not isinstance(margin_state, dict) or any(
                field in margin_state and (type(margin_state[field]) not in (int, float)
                    or not math.isfinite(margin_state[field]))
                for field in ("checked_at", "next_check_at", "cooldown_until"))
            margin_pending = margin_state.get("pending") if isinstance(margin_state, dict) else None
            from .margin_balance import MarginBalancer
            margin_rejection = MarginBalancer.unsettled_rejection(margin_state)
            margin_waiting = bool(margin_pending)
            from .pairing import margin_only
            if margin_only(pair) and not pending:
                # Funds management has no strategy-symbol, order-history or
                # market-data prerequisite. Ordinary pending batches retain
                # the existing recovery/reduction path below.
                margin = margin_result
                if self.engine.workspace.active:
                    state.update(phase="maintenance", reason="工作台维护中，保留策略配置并暂停新交易")
                elif not pair["enabled"]:
                    state.update(phase="paused", reason=pair.get("pause_reason") or "配对组已暂停，不发起新划转")
                else:
                    state.update(phase="margin_wait" if margin.get("blocks_trading") else "monitoring",
                                 reason=margin.get("reason", "仅管理两侧 USD1 保证金余额"))
                margin_delay = max(0, margin.get("retry_after", 0))
                return state
            require_runtime_symbols(pair, state)
            state["symbol"] = symbol
            retry = state.get("trade_retry") or {}
            if (not pair["margin"]["enabled"] or retry.get("revision") != pair["revision"]
                    or retry.get("identities") != identities):
                state.pop("trade_retry", None)
                retry = {}
            if margin_pending is not None or margin_invalid or margin_rejection:
                # Confirm existing transfers first, then recover outstanding
                # orders or a due reduction using fresh reconciliation reads.
                self._ordinary_observations.pop(pair["id"], None)
                margin = margin_result
                state.update(phase="margin_wait", reason=margin.get("reason", "划转核对中"))
                if margin.get("blocks_trading") and not pending:
                    margin_delay = max(0, margin.get("retry_after", 0))
                    return state
            if time.time() < retry.get("until", 0):
                state.update(phase=retry["phase"], reason=retry["reason"], api_notice=retry.get("api_notice"),
                             retry_after=retry["until"] - time.time())
                return state
            state.pop("trade_retry", None)
            if pending:
                trade_work = True
                self._recover(pair, state, brokers)
                return state
            if self.engine.workspace.active:
                state.update(phase="maintenance", reason="工作台维护中，保留策略配置并暂停新交易")
                return state
            if margin_result.get("blocks_trading"):
                state.update(phase="margin_wait", reason=margin_result.get("reason", "保证金划转等待核对"))
                margin_delay = max(0, margin_result.get("retry_after", 0))
                return state
            if (margin_pending is None and not margin_invalid
                    and margin_state.get("api_notice")
                    and time.time() < margin_state.get("next_check_at", 0)):
                # A failed balance preparation blocks new work. Re-reading both
                # accounts during its quota backoff cannot authorize anything.
                margin = MarginBalancer.status_view(pair, margin_state, state.get("margin"))
                if margin.get("blocks_trading"):
                    state.update(margin=margin, phase="margin_wait", reason=margin["reason"])
                    margin_delay = max(0, margin_state["next_check_at"] - time.time())
                    return state
            if not pair["enabled"]:
                state.update(phase="paused", reason=pair.get("pause_reason") or "配对组已暂停，不开始新开仓或新划转；已有普通策略底仓保留，需点击启动后重新检查执行条件")
                return state
            if not margin_pending:
                reason = self._ordinary_wait(pair, state, identities, margin_state)
                if reason:
                    margin = state.get("margin") or {}
                    state.update(phase="margin_wait" if margin.get("blocks_trading") else "waiting",
                                 reason=margin.get("reason", reason) if margin.get("blocks_trading") else reason)
                    return state
            trade_work = True
            snapshots, guards = self._read(brokers, symbol)
            self._publish_snapshots(state, snapshots, symbol)
            if (pair["ordinary"]["enabled"]
                    and all(isinstance(broker, LiveBroker) for broker in brokers.values())):
                if len(self._ordinary_observations) >= 16:
                    self._ordinary_observations.clear()
                self._ordinary_observations[pair["id"]] = (
                    (pair["revision"], deepcopy(identities)), snapshots, guards, time.monotonic())
            # The independent balancer uses the same ordered account locks. A
            # transfer invalidates both read leases before any following order.
            if pair["margin"]["enabled"]:
                # Publish the completed read before potentially slow transfer
                # preparation; this never changes the original snapshot time.
                self._save(pair, state)
            try:
                require_quantities(snapshots, symbol, self._expected(state))
            except PairPositionError:
                if state.get("recovery_watch") is not None:
                    # A late fill can precede the normal opening guard. Let the
                    # archive's full fresh check adopt a balanced new baseline;
                    # its CAS conflict makes this tick discard old snapshots.
                    from .pair_recovery import require_archived_orders_clear
                    require_archived_orders_clear(self.engine, pair)
                raise
            if state.get("attention") and state.get("recovery_watch") is not None:
                from .pair_recovery import require_archived_orders_clear
                require_archived_orders_clear(self.engine, pair)
                state.pop("attention", None)
            if not pair["enabled"]:
                state.update(phase="paused", reason=pair.get("pause_reason") or "配对组已暂停，不开始新开仓或新划转；已有普通策略底仓保留，需点击启动后重新检查执行条件")
                return state
            if state.get("attention"):
                state.update(phase="attention", reason=state["attention"])
                return state
            if time.time() < state.get("retry_at", 0):
                state.update(phase="waiting", reason="上批已核对结束，当前底仓保留；开仓冷却结束后系统重新检查开仓条件")
                return state
            risk_snapshots = self._risk_snapshots(pair, snapshots)
            book = self.market.book(symbol)
            rule = self.market.rules[symbol]
            if pair["ordinary"]["enabled"]:
                capacities = self.engine.capacities(symbol)
                target = ordinary_upgrade(pair, risk_snapshots, book, capacities, runtime=state)
                if target is not None:
                    self._leverage(pair, state, brokers, snapshots, guards, target)
                else:
                    plan = plan_ordinary(pair, risk_snapshots, book, rule, capacities)
                    self._start(pair, state, brokers, snapshots, guards, plan, kind="ordinary")
            else:
                state.update(phase="monitoring", reason="未启用开仓模式，仅管理保证金；"
                             + ("自动平衡已开启，满足余额差额及安全可划条件时会划转"
                                if pair["margin"]["enabled"] else "自动平衡未开启，不发起新划转"))
        except PairRecoveryConflict:
            save_state = False
            return self.store.get("pair_runtime:" + pair["id"], state)
        except PairPositionError as exc:
            state.update(phase="attention", reason=str(exc), attention=str(exc))
        except TradingError as exc:
            self._retry_delay(state, exc)
            state["api_notice"] = api_wait_notice(exc)
            state.update(phase="reconciling" if state.get("pending") else
                         "waiting",
                         reason=str(exc))
        finally:
            state.pop("_trading_write_started", None)
            if save_state:
                # Only an earlier guarantee of the same pair and identities may
                # survive the scheduler's independent margin wake-up.
                if trade_work and pair["margin"]["enabled"] and state.get("retry_after", 0) > 0:
                    state["trade_retry"] = {"until": time.time() + state["retry_after"],
                        "revision": pair["revision"], "identities": deepcopy(identities),
                        "phase": state["phase"], "reason": state["reason"], "api_notice": state.get("api_notice")}
                if margin_delay:
                    state["retry_after"] = max(state.get("retry_after", 0), margin_delay)
                self._save(pair, state)
                if ((pending_at_entry and pending_at_entry.get("kind") == "leverage" and not state.get("pending"))
                        or (margin_waiting and not (self.store.get("pair_margin:" + pair["id"]) or {}).get("pending"))):
                    self._wake_hot_data(pair)
        return state

    def _wake_hot_data(self, pair):
        # Queue local maintenance after the durable completion. Existing API
        # cooldowns remain intact; a pending batch itself adds no API backoff.
        for key, _ in SIDES:
            self.engine.wake_private_stream(pair[key + "_account_id"])

    def _start(self, pair, state, brokers, snapshots, guards, plan, *, kind):
        require_no_legacy_cycle(state, self.store)
        if kind != "ordinary":
            raise PairPositionError("配对组仅支持普通开仓批次")
        symbol = pair["symbol"]
        require_runtime_symbols(pair, state)
        if plan.symbol != symbol:
            raise PairPositionError("下单计划标的与配对组不一致，停止交易并等待核对")
        state["symbol"] = symbol
        opening = plan.phase == "open"
        identities = state["identities"]
        self._config_guard(pair, identities, opening=opening)
        for guard in guards.values():
            guard()
        before = self._expected(state)
        require_quantities(snapshots, symbol, before)
        token = uuid.uuid4().hex
        legs = []
        for key, side in SIDES:
            buy = (side == "LONG") == opening
            order = Executor.order(symbol, side, "BUY" if buy else "SELL", plan.qty, side[0] + token[:28])
            legs.append({"key": key, "order": order, "receipt": None, "dispatch": "prepared"})
        target = {side: wire(dec(before[side]) + (plan.qty if opening else -plan.qty)) for _, side in SIDES}
        if any(dec(q) < dec(state["owned"][side]) for side, q in target.items()):
            raise PairPositionError("平仓数量会侵占配对组原始底仓")
        pending = {"id": token, "pair_id": pair["id"], "kind": kind, "phase": plan.phase, "symbol": symbol,
                   "identities": deepcopy(identities), "created_at": time.time(), "quantity": wire(plan.qty),
                   "before": before, "target": target, "leverage": plan.leverage, "legs": legs,
                   "repairs": [], "repair_attempts": 0, "config": {"symbol": symbol, "leverage": plan.leverage},
                   "position_time_evidence": True}
        state.update(pending=pending, phase="submitting", reason="并行提交两个子账户的市价单")
        self._save(pair, state)
        try:
            # Persist the original IDs before the final authorization checks.
            self._config_guard(pair, identities, opening=opening)
            for guard in guards.values():
                guard()
            require_quantities(snapshots, symbol, before)
            risk_snapshots = self._risk_snapshots(pair, snapshots) if opening else snapshots
            book = self.market.book(symbol)
            latest = plan_ordinary(pair, risk_snapshots, book, self.market.rules[symbol], self.engine.capacities(symbol))
            if (latest.symbol != symbol or latest.phase != plan.phase
                    or latest.qty < plan.qty or latest.leverage != plan.leverage):
                raise RequestNotSent("发单前两账户风险、盘口或额度已变化")
            for guard in guards.values():
                guard()
        except TradingError as exc:
            self._retry_delay(state, exc)
            for leg in legs:
                leg["receipt"] = self._absent(leg["order"], str(exc))
            pending["last_error"] = str(exc)
            self._save(pair, state)
            self._recover(pair, state, brokers)
            return
        self._dispatch(pair, state, brokers, legs, guards=guards, reconciliation=not opening)
        self._recover(pair, state, brokers)

    @staticmethod
    def _absent(order, reason, *, local=True):
        return {**order, "clientOrderId": order["newClientOrderId"], "status": "REJECTED", "executedQty": "0",
                "avgPrice": "0", "reject_reason": reason, "local_not_sent": local}

    @staticmethod
    def _submit_evidence(kind, *, error=None, code=None):
        # Persist classification inputs, never exception reprs, response bodies
        # or signed request data. Message text cannot prove a request's outcome.
        evidence = {"kind": kind}
        code = error.code if error is not None else code
        if type(code) is int:
            evidence["code"] = code
        if error is not None:
            status, delay = error.http_status, error.retry_after
            if type(status) is int and 100 <= status <= 599:
                evidence["http_status"] = status
            if type(delay) in (int, float) and math.isfinite(delay) and delay >= 0:
                evidence["retry_after"] = delay
        return evidence

    def _dispatch(self, pair, state, brokers, legs, *, guards=None, reconciliation=False, paired_guards=False):
        require_runtime_symbols(pair, state)
        if any(leg.get("order", {}).get("symbol") != pair["symbol"] for leg in legs):
            raise PairPositionError("待发送订单标的与配对组不一致，停止交易并等待核对")
        state["_trading_write_started"] = True
        pending = state.get("pending") or {}
        writer = writer_for(self.engine)
        operation = None
        new_dispatch = None
        if writer.enabled:
            if not isinstance(pending.get("id"), str) or not pending["id"]:
                raise PairPositionError("受管理配对发送缺少持久原批次标识，未发送请求")
            client_ids = [leg["order"]["newClientOrderId"] for leg in legs]
            operation = "aster:pair-orders:" + pending["id"] + ":" + ":".join(client_ids)
            dispatch = {"operationId": operation, "clientOrderIds": client_ids}
            dispatches = pending.setdefault("writer_dispatches", [])
            if not isinstance(dispatches, list) or len(dispatches) > 32:
                raise PairPositionError("持久配对发送分组无效，停止发送并保留原订单")
            if dispatch not in dispatches:
                if len(dispatches) == 32:
                    raise PairPositionError("配对发送分组达到恢复上限，停止发送并保留原订单")
                dispatches.append(dispatch)
                new_dispatch = (dispatches, dispatch)
        # A crash between this commit and HTTP leaves an uncertain request, not
        # permission to repeat it. Each leg retains its own durable client ID.
        for leg in legs:
            leg["dispatch"] = "sending"
            # Persist before HTTP: only older records may use the narrow legacy
            # rejection recovery below, never a new ambiguous submission.
            leg["submit_evidence_version"] = 2
        # Persist a new safety window before every possible HTTP write, including
        # repairs. A batch's old creation time cannot age a new repair request.
        state["pending"]["last_possible_send_at"] = time.time()
        state["pending"].pop("bounded_recovery", None)
        self._save(pair, state)
        def send(leg):
            order, broker = leg["order"], brokers[leg["key"]]
            evidence = {"kind": "unknown"}
            try:
                try:
                    self._config_guard(pair, state["identities"],
                                       opening=pending.get("phase") == "open" and not reconciliation)
                    if paired_error is not None:
                        raise paired_error
                    if guards:
                        guards[leg["key"]]()
                except RequestNotSent:
                    raise
                except TradingError as exc:
                    # No submission has started: configuration/history guards
                    # can fail too, not only the prepared snapshot lease.
                    raise RequestNotSent(str(exc), retry_after=getattr(exc, "retry_after", 0)) from None
                budget = getattr(broker, "reconciliation_budget", nullcontext)() if reconciliation else nullcontext()
                with budget:
                    result = (broker.submit([order], timeout=3) if isinstance(broker, LiveBroker)
                              else broker.submit([order]))
                evidence = {"kind": "invalid"}
                if not isinstance(result, list) or len(result) != 1:
                    raise TradingError("单腿订单回执无效，等待查询")
                row = result[0]
                if isinstance(row, dict) and type(row.get("code")) is int and row["code"] < 0:
                    code = row["code"]
                    evidence = self._submit_evidence("error_response", code=code)
                    if code in ORDER_REJECTION_CODES:
                        reason = exchange_reason(row.get("msg")) or MISSING_REJECT_REASON
                        row = {**self._absent(order, f"Aster 拒绝订单（代码 {code}）：{reason}", local=False), "reject_code": code}
                Executor.validate_receipt(order, row)
                return row, None, evidence if evidence["kind"] == "error_response" else {"kind": "receipt"}
            except RequestNotSent as exc:
                evidence = self._submit_evidence("request_not_sent", error=exc)
                return {**self._absent(order, str(exc)), "retry_after": max(1, evidence.get("retry_after", 0))}, None, evidence
            except ExchangeError as exc:
                evidence = self._submit_evidence("ambiguous" if isinstance(exc, AmbiguousOrder) else "exchange_error", error=exc)
                status = evidence.get("http_status")
                if (evidence["kind"] == "exchange_error" and evidence.get("code") in ORDER_REJECTION_CODES
                        and status != 408 and not (status is not None and status >= 500)):
                    return {**self._absent(order, str(exc), local=False), "reject_code": exc.code}, None, evidence
                return None, str(exc), evidence
            except Exception as exc:
                return None, str(exc) if isinstance(exc, TradingError) else "订单结果未知，继续按客户端订单号核对", evidence
        paired_error = None
        if paired_guards and guards:
            # Repairs are sized from both sides' positions, so check every
            # lease once before any send; a repair's own fill may later revoke
            # its account's lease without invalidating the other repair.
            try:
                for guard in guards.values():
                    guard()
            except TradingError as exc:
                paired_error = exc if isinstance(exc, RequestNotSent) else RequestNotSent(
                    str(exc), retry_after=getattr(exc, "retry_after", 0))
        batch = writer.batch(operation, {"orders": [leg["order"] for leg in legs]}) if writer.enabled else nullcontext()
        with ExitStack() as stack:
            try:
                stack.enter_context(batch)
            except RequestNotSent as exc:
                # Shared admission refused before any HTTP: record the same
                # durable no-send receipt a refused leg gets, not "sending".
                evidence = self._submit_evidence("request_not_sent", error=exc)
                for leg in legs:
                    leg["receipt"] = {**self._absent(leg["order"], str(exc)),
                                      "retry_after": max(1, evidence.get("retry_after", 0))}
                    leg["error"], leg["submit_evidence"], leg["submit_error"] = None, evidence, str(exc)
                if new_dispatch is not None:
                    # Nothing was prepared, so this group has no shared operation;
                    # a lasting refusal must not use up the bounded group list.
                    new_dispatch[0].remove(new_dispatch[1])
                self._save(pair, state)
                return
            pool = stack.enter_context(ThreadPoolExecutor(max_workers=2, thread_name_prefix="pair-order"))
            futures = [(leg, pool.submit(writer.wrap(send), leg)) for leg in legs]
            for index, (leg, future) in enumerate(futures):
                receipt, error, evidence = future.result()
                leg["receipt"], leg["error"] = receipt, error
                leg["submit_evidence"] = evidence
                leg["submit_error"] = error or (receipt or {}).get("reject_reason")
                self._save(pair, state)

    def _legacy_notional_rejection(self, pending, leg, exc):
        """Recover the old -2029 classification bug, not arbitrary missing orders."""
        if (pending.get("kind") != "ordinary" or pending.get("phase") != "open"
                or not any(leg is original for original in pending["legs"])
                or leg.get("receipt") is not None or leg.get("dispatch") != "sending"
                or "submit_evidence_version" in leg
                or not isinstance(exc, ExchangeError) or isinstance(exc, (AmbiguousOrder, RequestNotSent))
                or exc.code != -2013 or exc.retry_after or exc.http_status not in (None, 400, 404)):
            return None
        # Old releases retained only the locally formatted original POST error.
        # Match the whole known response; never search the latest query error or
        # accept an embedded code, timeout, gateway error, or unknown message.
        reason = ("Aster 拒绝请求（代码 -2029）：You've reached the maximum notional value limit for this symbol. "
                  "You can still reduce or close your position to manage your risk.")
        # Aster has returned both straight and curly apostrophes in this message.
        original_reason = leg.get("submit_error")
        if original_reason not in (reason, reason.replace("You've", "You’ve")):
            return None
        order = leg["order"]
        if (order.get("symbol") != pending["symbol"] or order.get("type") != "MARKET"
                or (order.get("positionSide"), order.get("side")) not in {("LONG", "BUY"), ("SHORT", "SELL")}):
            return None
        return {**self._absent(order, original_reason, local=False), "reject_code": -2029,
                "recovered_from_submit_error": True}

    def _queried_rejection(self, leg, exc):
        """An explicit non-whitelisted submit code plus a clean -2013 for that ID."""
        evidence = leg.get("submit_evidence")
        if (leg.get("receipt") is not None or leg.get("dispatch") != "sending"
                or leg.get("submit_evidence_version") != 2 or not isinstance(evidence, dict)
                or evidence.get("kind") != "exchange_error"
                or not definitive_order_error(evidence.get("code"), evidence.get("http_status"))
                or not order_absent(exc)):
            return None
        reason = leg.get("submit_error") or f"Aster 拒绝订单（代码 {evidence['code']}）"
        return {**self._absent(leg["order"], reason + "；按原客户端编号查询确认订单不存在", local=False),
                "reject_code": evidence["code"], "query_absent": True}

    def _query(self, pair, state, brokers):
        symbol = pair["symbol"]
        require_runtime_symbols(pair, state)
        pending = state["pending"]
        writer_for(self.engine).settle_pair(pair, state)
        queried_absent = False
        for leg in pending["legs"] + pending["repairs"]:
            receipt, order = leg.get("receipt"), leg["order"]
            if receipt is not None:
                Executor.validate_receipt(order, receipt)
                if receipt["status"] in TERMINAL:
                    continue
            if leg.get("dispatch") == "prepared":
                leg["receipt"] = self._absent(order, "重启确认该订单尚未进入发送阶段")
                self._save(pair, state)
                continue
            from .pair_recovery import MIN_QUERY_ATTEMPTS
            active = receipt is not None
            try:
                broker = brokers[leg["key"]]
                row = broker.order_event_receipt(order, include_active=True) if isinstance(broker, LiveBroker) else None
                if isinstance(row, dict) and row.get("status") not in TERMINAL:
                    Executor.validate_receipt(order, row)
                    if receipt and dec(row["executedQty"]) < dec(receipt["executedQty"]):
                        raise PairPositionError("订单查询累计成交数量倒退")
                    # Keep positive activity even if REST now says -2013. It
                    # prevents reality adoption but does not hide a later REST
                    # terminal receipt when the original-ID check is due.
                    leg["receipt"], receipt, active, row = row, row, True, None
                if not isinstance(row, dict):
                    if not active and (leg.get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS
                                       or pending.get("bounded_recovery", {}).get("stage") == "positions"):
                        continue
                    if active and leg.get("last_query_at", 0) <= time.time() < leg.get("next_query_at", 0):
                        continue
                    if active:
                        leg.update(last_query_at=time.time(), next_query_at=time.time() + 30)
                    from .pair_recovery import record_query_attempt
                    try:
                        row = broker.query(symbol, order["newClientOrderId"])
                    except RequestNotSent:
                        raise
                    except Exception as exc:
                        record_query_attempt(leg, exc)
                        raise
                    else:
                        record_query_attempt(leg)
                Executor.validate_receipt(order, row)
                if receipt and dec(row["executedQty"]) < dec(receipt["executedQty"]):
                    raise PairPositionError("订单查询累计成交数量倒退")
                leg["receipt"], leg["error"] = row, None
            except PaperOrderAbsent:
                if active:
                    leg["error"] = "模拟订单账本暂未找到已有活动回执，继续核对原编号"
                else:
                    leg["receipt"] = self._absent(order, "模拟订单未写入持久账本")
            except TradingError as exc:
                self._retry_delay(state, exc)
                if active and state.get("retry_after", 0) > 0:
                    leg["next_query_at"] = max(leg.get("next_query_at", 0), time.time() + state["retry_after"])
                leg["error"] = str(exc)
                notice = api_wait_notice(exc)
                if notice is not None:
                    state["api_notice"] = notice
                restored = self._legacy_notional_rejection(pending, leg, exc)
                if restored is None and not active:
                    restored = self._queried_rejection(leg, exc)
                if restored is not None:
                    leg["receipt"] = restored
                    queried_absent = queried_absent or restored.get("query_absent") is True
            self._save(pair, state)
        if queried_absent:
            # The private journal now proves non-submission; settle the shared
            # operation in this round so a repair is not refused as unresolved.
            writer_for(self.engine).settle_pair(pair, state)
        return all(leg.get("receipt") and leg["receipt"]["status"] in TERMINAL
                   for leg in pending["legs"] + pending["repairs"])

    def _recover(self, pair, state, brokers, *, read_only=False, recovery_source=None):
        require_no_legacy_cycle(state, self.store)
        self.engine.adl.require_clear(pair["id"])
        symbol = pair["symbol"]
        require_runtime_symbols(pair, state)
        pending = state["pending"]
        if pending["kind"] == "leverage":
            return self._recover_leverage(pair, state, brokers)
        from .pair_recovery import recovery_ready
        # Free terminal stream evidence can arrive after the last REST query.
        # Exhausted unknowns still skip REST; known active receipts keep their
        # own query cadence and must never enter current-position adoption.
        terminal = self._query(pair, state, brokers)
        from .pair_recovery import MIN_QUERY_ATTEMPTS, record_query_attempt
        if pending.get("position_review"):
            deadline = pending.get("position_review_retry_at", 0)
            attempted = pending.get("position_review_attempted_at", 0)
            if any(type(value) not in (int, float) or not math.isfinite(value) or value < 0
                   for value in (deadline, attempted)):
                raise TradingError("持仓核验重试时间无效，保留原批次")
            now = time.time()
            if now < attempted:
                pending["position_review_attempted_at"] = now
                deadline = pending["position_review_retry_at"] = now + max(30, deadline - attempted)
            if now < deadline:
                state.update(phase="reconciling", reason=pending.get("position_review_error", "等待下一次持仓核验"),
                             api_notice=pending.get("position_review_api_notice"))
                state["retry_after"] = max(state.get("retry_after", 0), deadline - now)
                return
        # Full checks own their read, durable deadline and failure backoff.
        # Honor position_review first, without consuming a full-check slot.
        if recovery_ready(pending):
            return self.engine.pairs.recovery.adopt_unknown(
                self, pair, state, read_only=read_only, recovery_source=recovery_source)
        active_receipts = any(leg.get("receipt") and leg["receipt"]["status"] not in TERMINAL
                              for leg in pending["legs"] + pending["repairs"])
        if (not active_receipts and pending.get("terminal_position_recovery")
                and pending.get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS):
            self._wait_terminal_positions(state)
            return
        if not terminal:
            reason = ("原市价单仍有活动回执，每 30 秒继续按原编号核对终态，不采纳现实仓位结束该批次"
                      if active_receipts else "至少一条市价单结果未确定；原编号最多核对三次，等待最后请求满 120 秒后按完整账户现实核验")
            state.update(phase="reconciling", reason=reason + "；不重发原请求或新开仓，持仓展示保留上次读取时间")
            return
        member_read = None
        margin_pending = (self.store.get("pair_margin:" + pair["id"], {}) or {}).get("pending") is not None
        try:
            if (not margin_pending and pending["kind"] == "ordinary" and pending["phase"] == "open"
                    and pending.get("position_review")):
                self.engine.pairs.recovery._eligible(pair, state,
                    self.store.get("pair_margin:" + pair["id"], {}) or {},
                    archive=False, background=not read_only)
                member_read = self.engine.pairs._read_members(pair, adopt=True, reconciliation=True,
                    market_recovery=True, runtime=state,
                    reduction_recovery=bool(pending.get("terminal_position_recovery")))
                snapshots, member_guards = member_read
                guards = {key: member_guards[pair[key + "_account_id"]][1] for key, _ in SIDES}
            else:
                snapshots, guards = self._read(brokers, symbol, reconciliation=True,
                    fresh_modes=bool(pending.get("terminal_position_recovery")))
        except TradingError as exc:
            if pending.get("position_review"):
                requested = getattr(exc, "retry_after", 0)
                delay = max(30, requested) if type(requested) in (int, float) and math.isfinite(requested) else 30
                pending.update(position_review_attempted_at=time.time(), position_review_retry_at=time.time() + delay,
                               position_review_error=exchange_reason(str(exc)), position_review_api_notice=api_wait_notice(exc))
                state["retry_after"] = max(state.get("retry_after", 0), delay)
            if pending.get("terminal_position_recovery"):
                record_query_attempt(pending, exc)
            raise
        if pending.get("terminal_position_recovery"):
            record_query_attempt(pending)
            # One lagging read (L054) starts the bounded exit, but a later read
            # that reflects every terminal receipt still completes the batch;
            # do not prematurely adopt a position that still lags known fills.
            if not self._receipts_reflected(pending, snapshots, symbol):
                self._wait_terminal_positions(state)
                return
            # reconcile_positions compares the saved batch with this one.
            self._save(pair, state)
        return self._recover_terminal(pair, state, brokers, snapshots, guards,
            member_read=member_read, read_only=read_only, recovery_source=recovery_source)

    @staticmethod
    def _wait_terminal_positions(state):
        state.update(phase="reconciling",
            reason="终态回执与仓位恢复进入有限核对；等待三次实际读取及 120 秒窗口后按完整账户现实核验，"
                   "数量和杠杆反映回执即可完成；采纳其他仓位需方向时间覆盖本批已知成交")

    def _recover_terminal(self, pair, state, brokers, snapshots, guards, *,
                          member_read=None, read_only=False, recovery_source=None):
        """Continue known fills using the caller's single verified position read."""
        symbol, pending = pair["symbol"], state["pending"]
        terminal_recheck = bool(pending.get("terminal_position_recovery"))
        margin_pending = (self.store.get("pair_margin:" + pair["id"], {}) or {}).get("pending") is not None
        self._publish_snapshots(state, snapshots, symbol)
        try:
            held = positions(snapshots, symbol)
        except PairPositionError:
            self._begin_terminal_position_recovery(pending)
            raise
        actual = {side: held[side].qty for _, side in SIDES}
        expected = self._receipt_quantities(pending)
        if (pending["kind"] == "ordinary" and pending["phase"] == "open"
                and (actual["LONG"] == actual["SHORT"]
                     or actual == {side: dec(pending["before"][side]) for _, side in SIDES})
                and not self._receipts_reflected(pending, snapshots, symbol)):
            # Only a candidate manual baseline needs this extra evidence.
            # Unequal mismatches retain their existing rejection and diagnosis.
            try:
                self._require_position_times(pending, snapshots, symbol)
            except TradingError:
                self._begin_terminal_position_recovery(pending)
                raise
        original_full = all(leg["receipt"]["status"] == "FILLED" for leg in pending["legs"])
        if (terminal_recheck and pending["phase"] == "open" and actual == expected
                and all(pos.leverage == pending["leverage"] for pos in held.values())):
            limit = opening_margin_limit(pair["ordinary"], pending["leverage"])
            risk = self._risk_snapshots(pair, snapshots, recovery=True)
            if any(s.equity <= 0 or s.margin_exceeds(limit) for s in risk.values()):
                # Persist the rollback intent with the repair journal. A partial
                # reduction lowering the ratio cannot cancel the remaining work.
                pending["terminal_margin_rollback"] = True
                pending["last_error"] = "成交后子账户保证金超限，撤回本批新增量"
        # Balanced terminal ordinary batches are a normal completion path.
        # Preserve manual additions; do not enter a repair path merely because
        # the old local baseline differs.
        if (not pending.get("terminal_margin_rollback") and not margin_pending
                and pending["kind"] == "ordinary" and pending["phase"] == "open"
                and (actual != expected or (actual["LONG"] == actual["SHORT"]
                     and actual != {side: dec(pending["before"][side]) for _, side in SIDES}
                     and (not original_full or pending["repairs"])))
                and self.engine.pairs.recovery.reconcile_positions(
                    self, pair, state, source=recovery_source or "automatic_positions", member_read=member_read)):
            return
        if actual != expected or any(pos.leverage != pending["leverage"] for pos in held.values()):
            self._begin_terminal_position_recovery(pending)
            if (actual == {side: dec(pending["before"][side]) for _, side in SIDES}
                    and actual != expected and not self._position_times_reflect(pending, snapshots, symbol)):
                self._wait_terminal_positions(state)
                return
            detail = "；".join(
                f"{'A 多侧' if key == 'long' else 'B 空侧'}实际 {wire(actual[side])} / {held[side].leverage}x，"
                f"按回执应为 {wire(expected[side])} / {pending['leverage']}x，本批前底仓 {pending['before'][side]}"
                for key, side in SIDES)
            raise PairPositionError("成交回执与两子账户实际仓位或杠杆不一致，保留批次并停止新增；" + detail)
        if not terminal_recheck and pending["phase"] == "open" and original_full and not pending["repairs"]:
            limit = opening_margin_limit(pair["ordinary"], pending["leverage"])
            risk_snapshots = self._risk_snapshots(pair, snapshots, recovery=True)
            if any(s.equity <= 0 or s.margin_exceeds(limit) for s in risk_snapshots.values()):
                if (risk_snapshots is snapshots and pending["kind"] == "ordinary" and actual["LONG"] == actual["SHORT"]
                        and self.engine.pairs.recovery.reconcile_positions(
                            self, pair, state, source=recovery_source or "automatic_positions", member_read=member_read)):
                    return
                original_full = False
                pending["last_error"] = "成交后子账户保证金超限，撤回本批新增量"
        desired = pending["target"] if pending["phase"] == "close" or original_full and not pending["repairs"] else pending["before"]
        if pending.get("terminal_margin_rollback"):
            desired = pending["before"]
            original_full = False
        desired = {side: Fraction(dec(desired[side])) for _, side in SIDES}
        if (terminal_recheck and pending["phase"] != "close" and not pending.get("terminal_margin_rollback")
                and any(actual[side] != desired[side] for _, side in SIDES)):
            # Other terminal opening failures still have no repair authority.
            self._wait_terminal_positions(state)
            return False
        if any(actual[side] < desired[side] for _, side in SIDES):
            self._begin_terminal_position_recovery(pending)
            raise PairPositionError("实际仓位低于恢复目标，禁止通过反向加仓修复；请人工核对两侧实际仓位与本批成交")
        if all(actual[side] == desired[side] for _, side in SIDES):
            with self._confirmed(pair, brokers, guards):
                self._finish(pair, state, pending,
                    completed=original_full and not pending["repairs"])
            return
        if pending["repair_attempts"] >= 3:
            self._begin_terminal_position_recovery(pending)
            raise PairPositionError("减仓恢复已尝试三次，仍有本批残余仓位；系统停止继续自动减仓，请人工核对两侧持仓与成交")
        if read_only:
            state.update(phase="repairing", reason="原订单与持仓已核对，本批仍需减仓回到恢复目标；本次手动核对未发单，后台继续原减仓恢复流程")
            return
        if time.time() < pending.get("repair_retry_at", 0):
            state.update(phase="repairing", reason="本地请求预算不足，系统等待预算恢复后重试尚未发送的减仓；已发送订单只查询原编号")
            return
        repairs = []
        rule = self.market.rules[symbol]
        for key, side in SIDES:
            residual = Fraction(actual[side]) - desired[side]
            if not residual:
                continue
            qty = floor_step(min(residual, Fraction(rule.max_qty)), rule.step)
            if qty < rule.min_qty:
                self._begin_terminal_position_recovery(pending)
                raise PairPositionError("本批残余数量不符合市价减仓步长或限额，等待人工核对")
            order = Executor.order(symbol, side, "SELL" if side == "LONG" else "BUY", qty, "R" + uuid.uuid4().hex[:28])
            repairs.append({"key": key, "order": order, "receipt": None, "dispatch": "prepared"})
        pending["repair_attempts"] += 1
        pending["repairs"].extend(repairs)
        if terminal_recheck:
            pending["recovery_query_attempts"] = 0
        state.update(phase="repairing", reason="系统正在按本批记录的恢复目标继续减仓；不追加另一腿")
        self._save(pair, state)
        self._config_guard(pair, pending["identities"], opening=False)
        self._dispatch(pair, state, brokers, repairs, guards=guards, reconciliation=True, paired_guards=True)
        if all(leg.get("receipt", {}).get("local_not_sent") for leg in repairs if leg.get("receipt")) \
                and all(leg.get("receipt") for leg in repairs):
            pending["repair_attempts"] -= 1
            pending["repair_retry_at"] = time.time() + max(leg["receipt"].get("retry_after", 1) for leg in repairs)
            self._save(pair, state)

    @staticmethod
    def _receipt_quantities(pending):
        expected = {side: Fraction(dec(pending["before"][side])) for _, side in SIDES}
        for leg in pending["legs"] + pending["repairs"]:
            order, row = leg["order"], leg["receipt"]
            adding = (order["positionSide"] == "LONG") == (order["side"] == "BUY")
            expected[order["positionSide"]] += Fraction(dec(row["executedQty"])) * (1 if adding else -1)
        return expected

    @staticmethod
    def _position_times_reflect(pending, snapshots, symbol):
        """Known fills need exchange direction times, never request freshness."""
        if pending.get("position_time_evidence") is not True:
            # Batches created before direction times were retained (notably old
            # Paper ledgers) cannot acquire them; keep their prior completion.
            return True
        held = positions(snapshots, symbol)
        for leg in pending["legs"] + pending["repairs"]:
            receipt = leg.get("receipt")
            if receipt is None or not dec(receipt["executedQty"]):
                continue
            try:
                filled_at = positive(receipt.get("updateTime"))
                updated_at = positive(held[leg["order"]["positionSide"]].update_time)
            except TradingError:
                return False
            if (filled_at != filled_at.to_integral_value() or updated_at != updated_at.to_integral_value()
                    or not filled_at <= updated_at <= dec(str(time.time() + 1)) * 1000):
                return False
        return True

    @classmethod
    def _require_position_times(cls, pending, snapshots, symbol):
        if not cls._position_times_reflect(pending, snapshots, symbol):
            raise TradingError("方向持仓更新时间缺失或早于已知成交，等待覆盖全部成交的持仓证据；保留原批次")

    @classmethod
    def _receipts_reflected(cls, pending, snapshots, symbol):
        records = pending["legs"] + pending["repairs"]
        if not records or any(not leg.get("receipt") or leg["receipt"]["status"] not in TERMINAL for leg in records):
            return False
        try:
            held = positions(snapshots, symbol)
        except PairPositionError:
            return False
        expected = cls._receipt_quantities(pending)
        return all(held[side].qty == expected[side] and held[side].leverage == pending["leverage"] for _, side in SIDES)

    @staticmethod
    def _begin_terminal_position_recovery(pending):
        """Terminal receipts stay authoritative; bound failed position recovery."""
        if not pending.get("terminal_position_recovery"):
            from .pair_recovery import record_query_attempt, recovery_ready
            pending["terminal_position_recovery"] = True
            record_query_attempt(pending)
            recovery_ready(pending)

    def _finish(self, pair, state, pending, *, completed, check_current=None):
        require_no_legacy_cycle(state, self.store)
        writer_for(self.engine).settle_pair(pair, state)
        symbol = pair["symbol"]
        published = state
        state = deepcopy(state)
        state.pop("attention", None)
        if completed:
            state.update(failure_count=0, retry_at=0)
        else:
            count = min(5, state.get("failure_count", 0) + 1)
            state.update(failure_count=count, retry_at=time.time() + min(300, 30 * 2 ** (count - 1)))
        if pending["kind"] == "ordinary" and completed:
            state["owned"] = deepcopy(pending["target"])
        self._account_volume(state, pending)
        state["pending"] = None
        state["last_batch"] = {"id": pending["id"], "kind": pending["kind"], "phase": pending["phase"],
                               "quantity": pending["quantity"], "completed": completed, "at": time.time()}
        any_fill = any(dec(leg["receipt"]["executedQty"]) for leg in pending["legs"] + pending["repairs"])
        state.update(phase="waiting",
                     reason="两个子账户本批成交与持仓核对完成" if completed else
                            "本批未完整成交，已减回原始基线" if any_fill else "本批未成交，底仓保持不变")
        audit = pending.get("manual_position_reconciliation")
        if audit:
            automatic = audit["source"] == "automatic_positions"
            reason = (f"自动核对完成，保留实际底仓：多 {state['owned']['LONG']}、空 {state['owned']['SHORT']} {symbol}；本批已结束" if automatic else
                      f"已核验并保留实际底仓：多 {state['owned']['LONG']}、空 {state['owned']['SHORT']} {symbol}；遗留批次已结束，本次未下单或划转")
            state.update(phase="waiting" if pair["enabled"] else "paused",
                         reason=reason + "；原成交记录保留，外部增减仓未计入程序成交量")
        rejection_notes = [f"{'A 多侧' if leg['key'] == 'long' else 'B 空侧'}：{exchange_reason(leg['receipt']['reject_reason'])}"
                           for leg in pending["legs"] + pending["repairs"] if leg["receipt"].get("reject_reason")]
        rejection_text = "；拒单反馈：" + "；".join(rejection_notes) if rejection_notes else ""
        state["updated_at"] = time.time()
        # History and lifecycle advancement share one commit. A restart cannot
        # count the batch twice or forget its confirmed position.
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if check_current is not None:
                check_current(db)
            for key, value in (("pair_runtime:" + pair["id"], self._durable(state)),
                               ("pair_batch:" + pending["id"], {**pending, "completed": completed, "finished_at": time.time()})):
                db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(value)))
            for key, _ in SIDES:
                db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                           (pair[key + "_account_id"], "order", f"配对组 {pair['name']}：{state['reason']}；{symbol} 本批每边委托 {pending['quantity']}{rejection_text}", time.time()))
        # The outer tick always persists its state, even after an exception.
        # Publish only after the history and lifecycle transaction commits.
        published.clear()
        published.update(state)
        self._wake_hot_data(pair)

    @staticmethod
    def _account_volume(state, pending):
        daily = state.setdefault("daily_volume", {})
        def unknown():
            # A receipt cannot prove each fill's date across midnight. Bound
            # the uncertainty to affected days, never freeze all future days.
            state["volume_unknown"] = True
            state["volume_unknown_until_utc"] = datetime.now(timezone.utc).date().isoformat()
        for leg in pending["legs"] + pending["repairs"]:
            row = leg.get("receipt")
            if row is None:
                unknown()
                continue
            if row.get("status") not in TERMINAL:
                unknown()
            qty = dec(row["executedQty"])
            if not qty:
                continue
            stamp = row.get("updateTime", row.get("time"))
            if type(stamp) not in (int, float) or not pending["created_at"] - 1 <= stamp / 1000 <= time.time() + 1:
                unknown()
                continue
            # Unknown cross-midnight executions cannot be assigned to one day
            # from the last update timestamp alone. Preserve the uncertainty.
            start_day = datetime.fromtimestamp(pending["created_at"], timezone.utc).date().isoformat()
            date = datetime.fromtimestamp(stamp / 1000, timezone.utc).date().isoformat()
            if start_day != date:
                unknown()
                continue
            quote = row.get("cumQuote", row.get("cumQuoteQty"))
            try:
                amount = positive(quote) if quote is not None else qty * positive(row["avgPrice"])
            except TradingError:
                unknown()
                continue
            used = daily.setdefault(date, {"long": "0", "short": "0"})
            used[leg["key"]] = wire(dec(used[leg["key"]]) + amount)
        # Keep a week in the hot row; every original receipt remains in pair_batch.
        state["daily_volume"] = {day: daily[day] for day in sorted(daily)[-8:]}

    def _leverage(self, pair, state, brokers, snapshots, guards, target):
        symbol = pair["symbol"]
        require_runtime_symbols(pair, state)
        self._config_guard(pair, state["identities"], opening=True)
        for guard in guards.values():
            guard()
        before = self._expected(state)
        def check_capacity(current, *, equal_leverage):
            held = require_quantities(current, symbol, before, equal_leverage=equal_leverage)
            book = self.market.book(symbol)
            book.require_fresh()
            reason = ordinary_upgrade_blocker(pair, current, book, self.engine.capacities(symbol), held, target)
            if reason:
                raise RequestNotSent(f"{target}x：{reason}")
        # Recheck cached market inputs after the configuration/account guards,
        # before recording an intent that might otherwise wait for confirmation.
        check_capacity(snapshots, equal_leverage=True)
        pending = {"id": uuid.uuid4().hex, "kind": "leverage", "symbol": symbol, "identities": deepcopy(state["identities"]),
                   "created_at": time.time(), "before": before, "target_leverage": target,
                   "previous_leverage": positions(snapshots, symbol)["LONG"].leverage, "results": {}}
        pending["last_possible_send_at"] = time.time()
        state.update(pending=pending, phase="leverage",
                     reason=f"系统正在将两个子账户从 {pending['previous_leverage']}x 共同升至 {target}x；两侧实际杠杆确认前不下单")
        self._save(pair, state)
        def send(key):
            broker = brokers[key]
            try:
                self._config_guard(pair, pending["identities"], opening=True)
                def check(snapshot):
                    try:
                        # The broker may have refreshed its account snapshot.
                        # Revalue both holdings against the latest public quota.
                        check_capacity({**snapshots, key: snapshot}, equal_leverage=False)
                    except TradingError as exc:
                        raise RequestNotSent(str(exc), retry_after=getattr(exc, "retry_after", 0)) from None
                if isinstance(broker, LiveBroker):
                    return {"response": broker.set_leverage(symbol, target, checked_snapshot=snapshots[key], before_submit=check)}
                check(broker.snapshot([symbol]))
                return {"response": broker.set_leverage(symbol, target)}
            except (RequestNotSent, LeverageRejected) as exc:
                return {"rejected": True, "reason": str(exc)}
            except Exception:
                return {"unknown": True, "reason": "杠杆请求结果未知，系统继续读取两侧实际杠杆；不重发原请求"}
        state["_trading_write_started"] = True
        writer = writer_for(self.engine)
        with writer.batch("aster:pair-leverage:" + pending["id"], {"symbol": symbol, "target": target}), ThreadPoolExecutor(max_workers=2, thread_name_prefix="pair-leverage") as pool:
            futures = {key: pool.submit(writer.wrap(send), key) for key, _ in SIDES}
            for key, future in futures.items():
                pending["results"][key] = future.result()
                self._save(pair, state)
        self._recover_leverage(pair, state, brokers)

    def _recover_leverage(self, pair, state, brokers):
        symbol = pair["symbol"]
        require_runtime_symbols(pair, state)
        pending = state["pending"]
        from .pair_recovery import recovery_ready, record_query_attempt
        if recovery_ready(pending):
            return self.engine.pairs.recovery.adopt_unknown(self, pair, state)
        from .pair_recovery import MIN_QUERY_ATTEMPTS
        if pending.get("recovery_query_attempts", 0) >= MIN_QUERY_ATTEMPTS:
            state.update(phase="reconciling", reason="杠杆已完成三次核对，等待最后请求满 120 秒后核验实际仓位与设置")
            return
        try:
            snapshots, guards = self._read(brokers, symbol, reconciliation=True, fresh_modes=True)
        except RequestNotSent:
            raise
        except TradingError as exc:
            record_query_attempt(pending, exc)
            raise
        record_query_attempt(pending)
        if recovery_ready(pending):
            self._save(pair, state)
            return self.engine.pairs.recovery.adopt_unknown(self, pair, state)
        self._publish_snapshots(state, snapshots, symbol)
        held = require_quantities(snapshots, symbol, pending["before"], equal_leverage=False)
        with self._confirmed(pair, brokers, guards):
            if all(p.leverage == pending["target_leverage"] for p in held.values()):
                writer_for(self.engine).resolve_prefix("aster:pair-leverage:" + pending["id"])
                writer_for(self.engine).resolve_prefix("aster:legacy:pair_runtime:" + pair["id"] + ":" + pending["id"])
                state.update(pending=None, phase="waiting", reason=f"两子账户实际杠杆均已确认 {pending['target_leverage']}x；系统下一轮重新检查额度、余额、价差及风险条件后才开仓")
            elif (all(p.leverage == pending["previous_leverage"] for p in held.values())
                  and all(pending["results"].get(key, {}).get("rejected") for key, _ in SIDES)):
                state.update(pending=None, phase="waiting", reason=f"两个升杠杆请求均被明确拒绝，实际仍为 {pending['previous_leverage']}x；系统稍后重新评估升档条件")
            else:
                state.update(phase="reconciling",
                    reason=f"两子账户升杠杆尚未共同确认至 {pending['target_leverage']}x：做多账户 {held['LONG'].leverage}x、做空账户 {held['SHORT'].leverage}x；系统继续读取实际设置，不重发原请求，禁止新订单或划转")
            self._save(pair, state)

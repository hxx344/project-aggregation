"""Two-subaccount funds management. Pair ordinary opening was removed."""
from concurrent.futures import ThreadPoolExecutor
from .account_writer import protected_pair
from contextlib import nullcontext
from contextvars import ContextVar
from copy import deepcopy
import logging
import math
import time

from .exchange import LiveBroker, RequestNotSent, api_wait_notice
from .models import TradingError, wire
from .pair_planning import SIDES, PairPositionError, PairRecoveryConflict, require_no_legacy_orders
from .pair_legacy import require_no_legacy_cycle
from .margin_control import margin_running

LOG = logging.getLogger("aster.trading")


def runtime_default():
    return {"phase": "paused", "reason": "配对组尚未启动；核对两侧账户及保证金平衡设置后，点击启动才开始执行",
            "owned": {"LONG": "0", "SHORT": "0"}, "pending": None, "snapshots": {}}


class PairTrader:
    def __init__(self, engine):
        self.engine, self.store, self.market = engine, engine.store, engine.market
        self._margin_identity = ContextVar("aster_margin_identity", default=None)

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

    def _read(self, brokers, symbol):
        """Read both members for a margin check, admitting the whole shared-budget cost first."""
        budgets = {}
        for broker in brokers.values():
            if isinstance(broker, LiveBroker) and getattr(broker.api, "budget", None) is not None:
                budget = broker.api.budget
                budgets[budget] = budgets.get(budget, 0) + broker.transfer_snapshot_weight()
        # Actual requests still perform their own atomic admission checks.
        for budget, weight in budgets.items():
            with budget.pair_accounting():
                budget.require_available(weight)
        def read(key):
            broker = brokers[key]
            # Budget priority is thread-local: establish it inside each worker.
            budget = getattr(getattr(broker, "api", None), "budget", None)
            with getattr(budget, "margin", nullcontext)():
                if isinstance(broker, LiveBroker):
                    snapshot = broker.transfer_snapshot()
                    return snapshot, lambda: broker.require_snapshot_current(snapshot)
                snapshot = broker.snapshot([symbol])
                return snapshot, snapshot.require_fresh
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="pair-read") as pool:
            futures = {key: pool.submit(read, key) for key, _ in SIDES}
            rows = {key: future.result() for key, future in futures.items()}
        for _, guard in rows.values():
            guard()
        return {key: row[0] for key, row in rows.items()}, {key: row[1] for key, row in rows.items()}

    def _balance(self, pair, state, brokers, identities, *, pending_orders=False):
        symbol = pair["symbol"]
        from .margin_balance import MarginBalancer

        def load():
            # One REST attempt, only when the balancer's own check is due.
            current, checks = self._read(brokers, symbol)
            self._publish_balances(state, current)

            def check(side):
                self._margin_guard(pair, identities)
                checks[side]()

            return current, {side: lambda side=side: check(side) for side in checks}

        balancer = MarginBalancer(self.engine)
        result = balancer.tick(pair, {}, pending_orders=pending_orders, snapshot_loader=load)
        if balancer.refreshed_snapshots is not None:
            self._publish_balances(state, balancer.refreshed_snapshots)
        state["margin"] = result
        return result

    def _margin_guard(self, pair, identities):
        current = self.store.pair(pair["id"])
        if (not current or current.get("revision") != pair.get("revision")
                or not margin_running(current, self.store.get("pair_margin_control:" + pair["id"]))
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
                and margin.get("pending") is None and not MarginBalancer.unsettled_shared(margin)):
            result = MarginBalancer.status_view(pair, margin, state.get("margin"))
            self._observe_margin_alert(pair, result, None)
            return result
        _, brokers, identities = self._members(pair)
        self._margin_identity.set((pair["id"], pair.get("revision"), deepcopy(identities)))
        transfer_pending = isinstance(margin, dict) and margin.get("pending") is not None
        result = self._balance(pair, state, brokers, identities, pending_orders=bool(state.get("pending")))
        result["running"] = margin_running(pair, self.store.get("pair_margin_control:" + pair["id"]))
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

    @protected_pair
    def tick(self, pair, *, margin_result=None):
        """Publish the funds-management phase; this never reads positions or trades."""
        if margin_result is None:
            margin_result = self.margin_tick(pair)
        state = {**runtime_default(), **(self.store.get("pair_runtime:" + pair["id"]) or {})}
        margin_waiting = bool((self.store.get("pair_margin:" + pair["id"]) or {}).get("pending"))
        margin_delay = 0
        state.pop("retry_after", None)
        state["api_notice"] = None
        save_state = True
        try:
            state["margin"] = margin_result
            require_no_legacy_cycle(state, self.store)
            self.engine.adl.require_clear(pair["id"])
            _, _, identities = self._members(pair)
            margin_identity = self._margin_identity.get()
            if (margin_identity is not None and margin_identity[:2] == (pair["id"], pair.get("revision"))
                    and margin_identity[2] != identities):
                raise PairPositionError("保证金检查期间配对组账户身份发生变化，等待人工核对")
            if state.get("identities") and state["identities"] != identities:
                raise PairPositionError("配对组凭据指向的真实账户发生变化，等待人工核对")
            state["identities"] = identities
            require_no_legacy_orders(state)
            if self.engine.workspace.active:
                state.update(phase="maintenance", reason="工作台维护中，保留配置并暂停新划转")
            elif not pair["enabled"]:
                state.update(phase="paused", reason=pair.get("pause_reason") or "配对组已暂停，不发起新划转")
            elif not pair["margin"]["enabled"]:
                # Pair opening was removed; an old opening-only group does nothing now.
                raise PairPositionError("配对组已启动但保证金平衡未开启，当前不执行任何操作；请开启保证金平衡或暂停配对组")
            else:
                state.update(phase="margin_wait" if margin_result.get("blocks_trading") else "monitoring",
                             reason=margin_result.get("reason", "仅管理两侧 USD1 保证金余额"))
            margin_delay = max(0, margin_result.get("retry_after", 0))
            # Every blocking condition is re-raised on each tick, so a clean
            # tick retires attention left by earlier checks or removed paths.
            state.pop("attention", None)
        except PairRecoveryConflict:
            save_state = False
            return self.store.get("pair_runtime:" + pair["id"], state)
        except PairPositionError as exc:
            state.update(phase="attention", reason=str(exc), attention=str(exc))
        except TradingError as exc:
            self._retry_delay(state, exc)
            state["api_notice"] = api_wait_notice(exc)
            state.update(phase="waiting", reason=str(exc))
        finally:
            if save_state:
                if margin_delay:
                    state["retry_after"] = max(state.get("retry_after", 0), margin_delay)
                self._save(pair, state)
                if margin_waiting and not (self.store.get("pair_margin:" + pair["id"]) or {}).get("pending"):
                    self._wake_hot_data(pair)
        return state

    def _wake_hot_data(self, pair):
        # Queue local maintenance after the durable completion. Existing API
        # cooldowns remain intact; a pending batch itself adds no API backoff.
        for key, _ in SIDES:
            self.engine.wake_private_stream(pair[key + "_account_id"])

"""Bounded original-request reads and fresh, read-only recovery evidence."""
from copy import deepcopy
from contextlib import nullcontext
import math
import time

from .exchange import LiveBroker, RequestNotSent
from .models import TradingError, hedge_balanced, wire
from .account_legacy import REMOVED_CONFIG_KEYS
from .paper import PaperBroker

MIN_CHECKS = 3
SETTLE_SECONDS = 120
LEVERAGE_COOLDOWN_SECONDS = 300


class CurrentStateMismatch(TradingError):
    """Valid original receipts no longer describe the actual account."""


def broker_identity(account, broker):
    identity = {key: account[key] for key in ("id", "mode", "env_prefix")}
    api = getattr(broker, "api", None)
    if api is not None:
        credentials = api.credentials
        if (isinstance(credentials, dict) and isinstance(credentials.get("user"), str)
                and isinstance(credentials.get("signer"), str)):
            identity.update(user=credentials["user"].lower(), signer=credentials["signer"].lower())
        else:
            identity["credentials_unavailable"] = True
    return identity


def recovery_config(account):
    return {key: deepcopy(value) for key, value in account.items()
            if key not in {"enabled", "pause_reason"} | REMOVED_CONFIG_KEYS}


def observe(intent, account, broker):
    """Legacy journals begin their conservative window when first observed."""
    state = intent.setdefault("bounded_recovery", {
        "first_observed_at": time.time(), "checks": {},
        "identity": broker_identity(account, broker), "config": recovery_config(account)})
    if not isinstance(state, dict) or not isinstance(state.get("checks"), dict):
        raise TradingError("批次恢复观察记录无效")
    if state.get("identity") != broker_identity(account, broker):
        raise TradingError("批次恢复期间账户身份已变化，不能采纳当前仓位")
    return state


def mark_send(intent, account, broker, orders=None):
    state = observe(intent, account, broker)
    state["last_send_at"] = time.time()
    state.pop("reality_check", None)
    state.pop("current_state", None)
    state["checks"].pop("current_state", None)
    for cid in ([order["newClientOrderId"] for order in orders] if orders is not None else ["leverage"]):
        state["checks"][cid] = 0


def checked(intent, key, error=None):
    # Local admission and cached cooldowns did not inspect the original request.
    if isinstance(error, RequestNotSent) or getattr(error, "local_cooldown", False):
        return
    checks = intent["bounded_recovery"]["checks"]
    checks[key] = min(MIN_CHECKS, checks.get(key, 0) + 1)


def can_query(intent, key):
    return intent["bounded_recovery"]["checks"].get(key, 0) < MIN_CHECKS


def due(intent, keys):
    state = intent["bounded_recovery"]
    if state.get("reality_check"):
        return True
    if not keys or any(state["checks"].get(key, 0) < MIN_CHECKS for key in keys):
        return False
    stamp = state.get("last_send_at", state.get("first_observed_at"))
    if type(stamp) not in (int, float) or not math.isfinite(stamp):
        raise TradingError("恢复等待时间无效")
    if time.time() - stamp < SETTLE_SECONDS:
        return False
    state["reality_check"] = True
    return True


def query(broker, intent, order):
    cid = order["newClientOrderId"]
    try:
        result = broker.query(order["symbol"], cid)
    except TradingError as exc:
        checked(intent, cid, exc)
        raise
    checked(intent, cid)
    return result


def safe_snapshot(account, broker, symbols):
    """No cached empty orders can authorize adopting the actual position."""
    symbols = list(dict.fromkeys(symbols))
    identity = broker_identity(account, broker)
    started = time.time()
    if isinstance(broker, PaperBroker):
        broker.reload()
    if isinstance(broker, LiveBroker):
        if not identity.get("user") or not identity.get("signer"):
            raise TradingError("当前真实账户身份不可验证，不能自动恢复")
        budget = getattr(broker.api, "budget", None)
        if budget is not None:
            budget.require_available(broker.snapshot_weight(symbols, fresh_modes=True) + 40)
    snapshot = broker.snapshot(symbols, fresh_modes=True)
    orders = (broker.api.call("GET", "/fapi/v3/openOrders", signed=True, weight=40)
              if isinstance(broker, LiveBroker) else snapshot.open_orders)
    if not isinstance(orders, list) or orders:
        raise TradingError("当前账户仍有活动挂单或完整挂单读取失败，暂不结束旧批次核对")
    if type(snapshot.timestamp) not in (int, float) or snapshot.timestamp < started:
        raise TradingError("账户快照早于本轮恢复检查，等待新快照")
    snapshot.require_fresh()
    snapshot.require_modes(symbols)
    if snapshot.can_trade is not True or snapshot.equity <= 0:
        raise TradingError("当前账户交易权限或 USD1 权益不满足恢复条件")
    actual = {}
    for position in snapshot.positions:
        if position.qty and position.symbol not in symbols:
            raise TradingError("账户存在未纳入核对的其他标的持仓，暂不采纳")
    for symbol in symbols:
        long, short = snapshot.pair(symbol)
        if not hedge_balanced(long.qty, short.qty):
            raise TradingError("当前账户多空数量不平衡，暂不结束旧批次核对")
        actual[symbol] = {"LONG": wire(long.qty), "SHORT": wire(short.qty), "leverage": long.leverage}

    def current():
        snapshot.require_fresh()
        if isinstance(broker, LiveBroker):
            broker.require_snapshot_current(snapshot)
        if broker_identity(account, broker) != identity:
            raise TradingError("恢复检查期间真实账户身份已变化")

    current()
    return snapshot, actual, current, (broker._snapshot_lock if isinstance(broker, LiveBroker) else nullcontext())


def leverage_cooldown_active(store, account, broker, symbol, target, now=None):
    state = store.get(f"recovery_leverage_cooldown:{account['id']}:{symbol}")
    if not isinstance(state, dict):
        return False
    stamp = state.get("until")
    return (type(stamp) in (int, float) and math.isfinite(stamp)
            and (time.time() if now is None else now) < stamp
            and state.get("identity") == broker_identity(account, broker)
            and recovery_config(state.get("config") or {}) == recovery_config(account)
            and state.get("target") == target)

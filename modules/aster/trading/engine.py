"""Independent account workers and shared market polling for the Linux service."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import asdict, dataclass
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import uuid

import monitor
from . import monitoring, notification_channels, position_observations
from .monitoring_status import compute_symbol_view
from .hourly_summary import format_hourly_summary
from .capacity_relay_client import CAPACITY_RELAY_SYMBOLS
from .depth import DEPTH_POLL_INTERVAL, DEPTH_RESYNC_INTERVAL, DEPTH_WEIGHT
from .exchange import BudgetWait, ExchangeError, LiveBroker, MarketData, PublicBracketsUnavailable, RateBudget, RequestNotSent, SnapshotSuperseded, credentials_for, PUBLIC_BRACKETS_REFRESH_INTERVAL
from .account_deletion import deletion_block
from .execution import Executor
from .ordinary_selection import ordinary_add_blocks, ordinary_add_symbols, ordinary_selection
from .account_legacy import legacy_block_reason, legacy_intent, legacy_position, LEGACY_PENDING_REASON, without_removed_config
from .lock import ProcessLock
from .listings import ListingMonitor, POLL_SECONDS as LISTING_POLL_SECONDS, STALE_SECONDS as LISTING_STALE_SECONDS
from .models import AccountModeError, Book, MARKET_SYMBOLS, MIN_BATCH_NOTIONAL, MIN_OPEN_LEVERAGE, SYMBOLS, TIERS, TradingError, dec, decimal_text, leverage_cap, leverage_candidates, minimum_open_leverage, next_leverage, opening_margin_limit, ordinary_leverage_wait, plan_pair, positive, wire
from .recovery import leverage_cooldown_active
from .paper import DemoMarket, PaperBroker
from .scheduling import AccountWork, PollBackoff
from .store import dumps
from .pairing import PairManager, pair_active
from .account_writer import ManagedWriter, protected_account

LOG = logging.getLogger("aster.trading")
MAX_ACCOUNTS = 8
ACCOUNT_LIST_INTERVAL = 1
CAPACITY_POLL_INTERVAL = 2
FAST_CAPACITY_POLL_INTERVAL = .2
CAPACITY_MONITOR_RESERVE = 60 // CAPACITY_POLL_INTERVAL + 1
PUBLIC_POLL_ALLOWANCE = CAPACITY_MONITOR_RESERVE + 120 + len(MARKET_SYMBOLS) * DEPTH_WEIGHT * 60 // DEPTH_RESYNC_INTERVAL
PRIORITY_TIERS = (10, 20)
DEFAULT_POLICY = {"symbols": list(SYMBOLS), "threshold": "10000", "order_notional": "1000", "margin_limit": "0.5",
                  "spread_limit": "0.0005", "min_open_leverage": MIN_OPEN_LEVERAGE, "ordinary_symbol": "all"}
EDITABLE_POLICY_FIELDS = {"threshold", "order_notional", "margin_limit", "min_open_leverage", "ordinary_symbol"}


@dataclass
class MarketCandidate:
    symbol: str
    leverage: int
    book: Book
    target: int | None = None

    @property
    def opening_leverage(self):
        return self.leverage if self.target is None else self.target


def validate_account(account):
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", account.get("id", "")):
        raise TradingError("账户标识仅支持小写字母、数字、下划线和短横线")
    if not isinstance(account.get("name"), str) or not 1 <= len(account["name"].strip()) <= 50:
        raise TradingError("账户名称需为 1 至 50 个字符")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,40}", account.get("env_prefix", "")):
        raise TradingError("环境变量前缀格式无效")
    if account.get("mode") not in ("paper", "live") or not isinstance(account.get("enabled"), bool):
        raise TradingError("账户运行模式无效")
    policy = account.get("policy", {})
    if not isinstance(policy, dict):
        raise TradingError("策略配置字段不完整")
    policy = {"min_open_leverage": MIN_OPEN_LEVERAGE, "ordinary_symbol": "all", **policy}
    if set(policy) != set(DEFAULT_POLICY):
        raise TradingError("策略配置字段不完整")
    if not isinstance(policy["symbols"], list) or not policy["symbols"] or any(s not in SYMBOLS for s in policy["symbols"]) or len(set(policy["symbols"])) != len(policy["symbols"]):
        raise TradingError("交易市场配置无效")
    if positive(policy["threshold"], True) > 1000000000:
        raise TradingError("额度阈值超出配置范围")
    if not MIN_BATCH_NOTIONAL <= positive(policy["order_notional"]) <= 1000000:
        raise TradingError("单批每边上限必须为 500 至 1000000 USD1")
    if not 0 < positive(policy["margin_limit"]) <= 1:
        raise TradingError("风险上限必须大于 0 且不超过 100%")
    if not 0 < positive(policy["spread_limit"]) <= dec("0.0005"):
        raise TradingError("价差上限不得超过万 5")
    minimum_open_leverage(policy)
    account["policy"] = policy
    ordinary_selection(account)
    account = without_removed_config(account)
    return account


def snapshot_json(snapshot, symbols):
    result = asdict(snapshot)
    result.pop("brackets", None)
    result.pop("fees", None)
    result.pop("current_leverage_caps", None)
    result["ratio"] = snapshot.ratio if snapshot.equity > 0 else None
    result["margin_ratio"] = snapshot.margin_ratio if snapshot.equity > 0 else None
    result["total_notional"] = snapshot.total_notional
    result["occupied_margin"] = snapshot.occupied_margin
    result["positions"] = [{**row, "notional": p.notional, "occupied_margin": p.occupied_margin}
                           for row, p in zip(result["positions"], snapshot.positions)]
    result["mode_checks"] = snapshot.mode_checks(symbols)
    result["account_capacity"] = {}
    for symbol in symbols:
        try:
            long, short = snapshot.pair(symbol)
            leverage = long.leverage
            current = snapshot.current_leverage_caps.get(symbol)
            if current is not None and current[0] == leverage:
                cap = positive(current[1], True)
            else:
                cap = leverage_cap(snapshot.brackets.get(symbol, []), leverage)
            gross = long.notional + short.notional
            result["account_capacity"][symbol] = {"leverage": leverage, "cap": cap,
                "occupied": gross, "remaining": max(dec(0), cap - gross),
                "checked_at": snapshot.timestamp,
                "expires_at": snapshot.timestamp + 8}
        except (TradingError, KeyError, ValueError, TypeError):
            continue
    return json.loads(dumps(result))


class Engine:
    def __init__(self, store, demo=False, market=None):
        self.store, self.demo = store, demo
        self.market = market or (DemoMarket() if demo else MarketData())
        self.shutdown = threading.Event()
        self.scheduler_event = threading.Event()
        self.thread = None
        self.process_lock = ProcessLock(store.path.with_suffix(".lock"))
        self.lock = threading.RLock()
        self.lifecycle_lock = threading.Lock()
        self.registration_lock = threading.Lock()
        self.accounts_generation = 0
        self.account_locks = {}
        from .workspace_control import WorkspaceControl
        self.workspace = WorkspaceControl(self)
        self.pairs = PairManager(self)
        self.budget_wait_events = {}
        self.brokers, self.signers, self.users = {}, {}, {}
        self.deleted_accounts = set()
        self.markets, self.views, self.rotation = {}, {}, {}
        self.display_snapshots = {}
        self.pair_watch_diagnostics = {}
        self.pair_watch_diagnostic_lock = threading.Lock()
        self.account_work = {}
        self._adl_wakes = set()
        from .adl import AdlController
        self.adl = AdlController(self)
        self.ready = False
        self.error = "正在连接行情服务"
        self.notification_error = None
        self.notification_channel_errors = dict.fromkeys(notification_channels.CHANNELS)
        self.hourly_summary_error = None
        self.relay_health_error = None
        self.position_imbalance_error = None
        self.margin_imbalance_error = None
        self.position_observation_instance = uuid.uuid4().hex
        self.capacity_notification_errors = {}
        self.capacity_targets, self.capacity_accounts = {}, []
        self.capacity_intervals = {}
        self.capacity_brackets_interval = PUBLIC_BRACKETS_REFRESH_INTERVAL
        self.capacity_poll_enabled = True
        self.local_capacity_poll_enabled = True
        self.capacity_full_checked = {}
        self.capacity_sample_started = {}
        self.listing_monitor = ListingMonitor(store, self.market, self.shutdown) if not demo and isinstance(self.market, MarketData) else None
        if demo and not store.accounts() and not store.account_id_used("demo"):
            account = {"id": "demo", "name": "示例子账户", "mode": "paper", "env_prefix": "ASTER_DEMO", "enabled": False, "policy": {**DEFAULT_POLICY}}
            store.save_account(account)
            self.brokers["demo"] = PaperBroker("demo", self.market, store, seed=True)
        self.account_writer = ManagedWriter(self)
        self.store.account_writer = self.account_writer

    def account_lock(self, account_id):
        with self.lock:
            return self.account_locks.setdefault(account_id, threading.RLock())

    def work(self, account_id):
        with self.lock:
            state = self.account_work.get(account_id)
            if state is None:
                state = self.account_work[account_id] = AccountWork()
            return state

    def view(self, account_id, **updates):
        if hasattr(self, "account_writer"):
            self.account_writer.assert_current()
        with self.lock:
            current = self.views.setdefault(account_id, {"strategies": {}})
            current.update(updates)

    def strategy(self, account_id, symbol, reason, phase="waiting", **fields):
        if hasattr(self, "account_writer"):
            self.account_writer.assert_current()
        with self.lock:
            current = self.views.setdefault(account_id, {"strategies": {}})
            current["strategies"][symbol] = {"reason": reason, "phase": phase, **fields}

    def broker(self, account):
        aid = account["id"]
        # Background refresh and trading may first reach an account together.
        # Construction is local; serialize registration, never an HTTP read.
        with self.lock:
            if aid in self.deleted_accounts:
                raise TradingError("账户已删除")
            if aid in self.brokers:
                broker = self.workspace.bind(self.brokers[aid])
                if getattr(broker, "mode", None) == "live":
                    self.account_writer.bind_api(broker.api, aid)
                return broker
            if account["mode"] == "paper":
                self.brokers[aid] = PaperBroker(aid, self.market, self.store)
            else:
                if self.demo:
                    raise TradingError("模拟环境不能添加或连接实盘账户")
                creds = credentials_for(account["env_prefix"])
                signer = creds["signer"].lower()
                user = creds["user"].lower()
                if signer in self.signers and self.signers[signer] != aid:
                    raise TradingError("同一 API signer 不能由多个账户执行器共用")
                if user in self.users and self.users[user] != aid:
                    raise TradingError("同一真实账户不能通过不同 API signer 重复接入")
                broker = LiveBroker(creds, self.market)
                broker.set_adl_listener(
                    on_event=lambda event: self.adl.observe(aid, broker, event),
                    on_reconnected=lambda: self.adl.reconnected(aid, broker))
                self.signers[signer] = aid
                self.users[user] = aid
                self.brokers[aid] = broker
            broker = self.workspace.bind(self.brokers[aid])
            if getattr(broker, "mode", None) == "live":
                self.account_writer.bind_api(broker.api, aid)
            return broker

    def live_allowed(self, account):
        return account["mode"] == "paper" or (not self.demo and os.environ.get("ASTER_ALLOW_LIVE") == "1")

    def wake_adl(self, account_id):
        """Private callbacks enqueue work without reading storage or trading."""
        if self.shutdown.is_set():
            return
        with self.lock:
            self._adl_wakes.add(account_id)
        self.scheduler_event.set()

    def poll_adl(self, account_id):
        account = self.store.account(account_id)
        if (self.shutdown.is_set() or not account or account["mode"] != "live"
                or not self.live_allowed(account) or not self.store.pair_for_account(account_id)):
            return 30
        delay = self.adl.poll(account)
        return max(1, delay) if type(delay) in (int, float) and math.isfinite(delay) else 1

    def wake_private_stream(self, account_id):
        """Queue a private stream start/stop check; it never takes the trade lock."""
        if self.shutdown.is_set():
            return
        with self.lock:
            self.work(account_id).stream_wake = True
        self.scheduler_event.set()

    def revoke_account_reads(self, account_id, reason):
        with self.lock:
            broker = self.brokers.get(account_id)
        if isinstance(broker, LiveBroker):
            broker.invalidate_account_reads(reason, refresh_modes=True)
        self.wake_private_stream(account_id)

    def poll_private_stream(self, account_id):
        """Start or stop the private account stream; this never reads REST."""
        account = self.store.account(account_id)
        # Pausing a pair cannot pause ADL detection. Ordinary and paused groups
        # keep the private stream without repeatedly refreshing REST snapshots.
        paired = self.store.pair_for_account(account_id)
        with self.lock:
            existing = self.brokers.get(account_id)
        active = (account and account["mode"] == "live" and paired
                  and self.live_allowed(account)
                  and not self.shutdown.is_set())
        if not active:
            if isinstance(existing, LiveBroker):
                existing.stop_private_stream()
            return 30
        broker = self.broker(account)
        broker.set_adl_listener(
            on_event=lambda event: self.adl.observe(account_id, broker, event),
            on_reconnected=lambda: self.adl.reconnected(account_id, broker))
        broker.start_private_stream()
        return 30

    def scheduling(self, accounts):
        """Spread ordinary private reads across the shared IP budget."""
        live = [a for a in accounts if a["mode"] == "live"]
        budget = self.market.api.budget.snapshot() if isinstance(self.market, MarketData) else {"ordinary_limit": 1500}
        # Reserve the capacity feed and ordinary quote fallback. Use cold
        # round costs; no private position or balance cache crosses a mutation.
        capacity_symbols = {symbol for symbol in self.capacity_market_symbols(accounts)
                            if not self.uses_capacity_relay(symbol)}
        public_capacity_cost = (sum(60 / self.capacity_interval(symbol) for symbol in capacity_symbols)
                                + len(capacity_symbols) * 60 / self.capacity_brackets_interval
                                ) if self.capacity_poll_enabled and self.local_capacity_poll_enabled else 0
        extra_capacity = public_capacity_cost - CAPACITY_MONITOR_RESERVE
        capacity = max(1, budget.get("execution_limit", budget["ordinary_limit"]) - PUBLIC_POLL_ALLOWANCE - extra_capacity)
        with self.lock:
            def cost(account):
                if not account["enabled"]:
                    return 90
                markets = ordinary_add_symbols(account)
                if not markets:
                    return 0
                positions = self.views.get(account["id"], {}).get("snapshot", {}).get("positions", [])
                minimum = minimum_open_leverage(account["policy"])
                for symbol in markets:
                    pair = [p for p in positions if p["symbol"] == symbol]
                    if len(pair) != 2:
                        return 300  # Cold start may confirm an upgrade.
                    leverage = pair[0]["leverage"]
                    caps = self.markets.get(symbol, {}).get("capacities", {})
                    threshold = dec(account["policy"]["threshold"])
                    if any(target > leverage and dec(caps.get(str(target), "0")) > threshold for target in leverage_candidates(minimum)):
                        return 300
                return 120
            costs = {a["id"]: cost(a) for a in live}
        period = 60 * sum(costs.values()) / capacity
        return {a["id"]: {
            "interval": max(10 if a["enabled"] else 60, period),
            "gap": 60 * costs[a["id"]] / capacity,
        } for a in live}

    @staticmethod
    def recovery_budget(broker):
        return getattr(broker, "reconciliation_budget", nullcontext)()

    def completed_snapshot(self, executor, broker, symbols):
        snapshot = executor.last_snapshot
        if snapshot is not None:
            try:
                snapshot.require_fresh()
                # Executors can request fewer markets than the combined worker.
                # Live responses omit unrequested flat symbols; freshness alone
                # does not prove this snapshot covers every requested market.
                for symbol in symbols:
                    snapshot.pair(symbol)
                return snapshot
            except TradingError:
                pass
        with self.recovery_budget(broker):
            return broker.snapshot(symbols)

    def record_batch_outcome(self, account_id, executor):
        intent = executor.last_completed_intent
        if not intent or intent["kind"] != "pair":
            return
        key = f"order_cooldown:{account_id}:{intent['symbol']}"
        if intent["status"] == "complete":
            self.store.put(key, None)
            return
        if intent["status"] != "aborted":
            return
        if (intent.get("resolution") or {}).get("kind") in {"unknown_current_state", "current_state_adopted"}:
            # Current balanced holdings ended recovery; missing historical
            # fills do not prove an empty/rejected batch or warrant backoff.
            return
        previous = self.store.get(key) or {}
        count = min(5, previous.get("failures", 0) + 1)
        rejected = any(r.get("status") == "REJECTED" for r in intent["receipts"].values())
        delay = min(120, (30 if rejected else 15) * 2 ** (count - 1))
        self.store.put(key, {"failures": count, "until": time.time() + delay})
        self.store.event(account_id, "waiting", f"{intent['symbol']} 本批无新增仓位，新开单等待 {delay} 秒；继续核对已有订单")

    def rearm_ordinary_capacity(self, account, executor):
        """A confirmed 5x fill may use the next sample, never an immediate loop."""
        intent = executor.last_completed_intent
        if (not intent or intent.get("kind") != "pair" or intent.get("status") != "complete"
                or intent.get("leverage") != 5 or not account["enabled"]
                or minimum_open_leverage(account["policy"]) > 5
                or intent["symbol"] not in ordinary_add_symbols(account)):
            return
        with self.lock:
            work = self.work(account["id"])
            levels = tuple(tier for tier in work.priority_levels.get(intent["symbol"], ()) if tier != 5)
            if levels:
                work.priority_levels[intent["symbol"]] = levels
            else:
                work.priority_levels.pop(intent["symbol"], None)

    def fast_capacity_targets(self, accounts, pairs=None):
        """Share one capacity feed across ordinary accounts and pairs."""
        targets = {}
        for account in accounts:
            if (not account["enabled"] or not self.live_allowed(account)
                    or minimum_open_leverage(account["policy"]) > 5):
                continue
            for symbol in ordinary_add_symbols(account):
                targets.setdefault(symbol, set()).add(5)
        owners = {account["id"]: account for account in accounts}
        for pair in self.store.pairs() if pairs is None else pairs:
            if not pair["enabled"]:
                continue
            symbol = pair.get("symbol", "XAUUSD1")
            runtime = self.store.get("pair_runtime:" + pair["id"]) or {}
            # The durable intent precedes dispatch and survives unknown results,
            # repairs and restarts. Only this consumer yields its fast feed.
            if runtime.get("pending"):
                continue
            members = [owners.get(pair[key]) for key in ("long_account_id", "short_account_id")]
            if any(member is None or not self.live_allowed(member) for member in members):
                continue
            if pair["ordinary"]["enabled"]:
                targets.setdefault(symbol, set()).update(leverage_candidates(pair["ordinary"]["min_open_leverage"]))
        return targets

    def capacity_interval(self, symbol):
        fast = symbol in self.capacity_targets and symbol in CAPACITY_RELAY_SYMBOLS
        return self.capacity_intervals.get(symbol, FAST_CAPACITY_POLL_INTERVAL if fast else CAPACITY_POLL_INTERVAL)

    def uses_capacity_relay(self, symbol):
        return isinstance(self.market, MarketData) and self.market.uses_capacity_relay(symbol)

    def capacity_sampling_enabled(self, symbol):
        return self.capacity_poll_enabled and (self.uses_capacity_relay(symbol) or self.local_capacity_poll_enabled)

    def brackets_interval(self, symbol):
        return PUBLIC_BRACKETS_REFRESH_INTERVAL if self.uses_capacity_relay(symbol) else self.capacity_brackets_interval

    def required_monitoring_symbols(self, reader=None, accounts=None):
        reader = reader or self.store
        accounts = reader.accounts() if accounts is None else accounts
        required = {}
        for account in accounts:
            symbols = set()
            if account["enabled"]:
                symbols.update(ordinary_add_symbols(account))
            pending = reader.intent(account["id"]) or {}
            if pending:
                orders = pending.get("orders")
                named = [pending.get(key) for key in ("symbol", "source_symbol", "target_symbol")]
                named += [order.get("symbol") for order in orders if isinstance(order, dict)] if isinstance(orders, list) else []
                named = [symbol for symbol in named if isinstance(symbol, str)]
                # Malformed legacy journals still keep the account's markets observable.
                symbols.update(named if named or not legacy_intent(pending) else account["policy"]["symbols"])
            check = reader.get("post_fill_check:" + account["id"]) or {}
            if isinstance(check, dict):
                symbol = check.get("symbol")
                if isinstance(symbol, str):
                    symbols.add(symbol)
                elif symbol is not None:
                    symbols.update(account["policy"]["symbols"])
            elif check:
                # Older ledgers stored a boolean obligation for the whole account.
                symbols.update(account["policy"]["symbols"])
            cycle = reader.get("cycle:" + account["id"])
            if legacy_position(cycle):
                config = cycle.get("config") if isinstance(cycle, dict) else None
                symbol = config.get("symbol") if isinstance(config, dict) else None
                symbols.update([symbol] if isinstance(symbol, str) and symbol else account["policy"]["symbols"])
            for symbol in symbols.intersection(SYMBOLS):
                required.setdefault(symbol, []).append(account["name"])
        for pair in reader.pairs():
            if pair_active(pair, reader.get("pair_runtime:" + pair["id"])):
                required.setdefault(pair.get("symbol", "XAUUSD1"), []).append(pair["name"])
        return required

    def monitored_market_symbols(self, accounts=None):
        with self.store.read_snapshot() as reader:
            config = reader.monitoring_settings()
            selected = {symbol for symbol in SYMBOLS if monitoring.monitored(config, symbol)}
            return selected | self.required_monitoring_symbols(reader, accounts).keys()

    def capacity_market_symbols(self, accounts=None):
        """Sample XAU by default, plus markets needed by actual strategy work."""
        with self.store.read_snapshot() as reader:
            config = reader.monitoring_settings()
            required = self.required_monitoring_symbols(reader, accounts)
            return set(required) | ({"XAUUSD1"} if monitoring.monitored(config, "XAUUSD1") else set())

    def edit_monitoring(self, changes, *, symbol=None):
        if self.demo:
            raise TradingError("模拟环境不运行监控或飞书告警")
        self.store.edit_monitoring(changes, symbol=symbol)
        with self.lock:
            self.accounts_generation += 1
        self.scheduler_event.set()

    def monitoring_state(self, reader=None, accounts=None):
        reader = reader or self.store
        config = reader.monitoring_settings()
        listings = reader.get("usd1_listings") or {}
        watched = set(reader.listing_watch_symbols())
        required = self.required_monitoring_symbols(reader, accounts)
        symbols = set(MARKET_SYMBOLS) | set(listings.get("rows", {})) | config["symbols"].keys()
        now = time.time()
        return {"settings": {key: config[key] for key in monitoring.DEFAULTS},
                "revision": config["revision"],
                "strategy_capacity_environment_enabled": os.environ.get("ASTER_CAPACITY_ALERT_ENABLED", "1").strip() == "1",
                "symbols": [{"symbol": symbol, **monitoring.symbol_options(config, symbol),
                    "max_capacity_alert": symbol in watched, "can_watch": symbol in listings.get("rows", {}),
                    "strategy_market": symbol in MARKET_SYMBOLS, "required_by": required.get(symbol, []),
                    "effective_monitor": not self.demo and (monitoring.monitored(config, symbol) or symbol in required),
                    "detail_enabled": not self.demo and monitoring.monitored(config, symbol),
                    **compute_symbol_view(monitoring.symbol_options(config, symbol),
                        listings.get("rows", {}).get(symbol),
                        {**listings, "discovery_enabled": config["auto_discover"]}, now,
                        monitoring_enabled=config["monitoring_enabled"], demo=self.demo),
                    "status": listings.get("rows", {}).get(symbol, {}).get("status", "TRADING")}
                    for symbol in sorted(symbols)]}

    def capacity_poll_schedule(self, targets, symbols=None):
        """Fit all public quota samples, including brackets, into their real reserve."""
        symbols = self.capacity_market_symbols() if symbols is None else set(symbols)
        targets = {symbol: tiers for symbol, tiers in targets.items() if symbol in symbols}
        remote_symbols = {symbol for symbol in symbols if self.uses_capacity_relay(symbol)}
        local_symbols = symbols - remote_symbols
        # Other markets use the main host's slow baseline even with active
        # strategy consumers. Only gold/silver are eligible for fast sampling.
        local_fast = local_symbols.intersection(targets, CAPACITY_RELAY_SYMBOLS)
        count = len(local_fast)
        baseline = len(local_symbols) * CAPACITY_MONITOR_RESERVE
        allowance = baseline + count * (60 / FAST_CAPACITY_POLL_INTERVAL - 60 / CAPACITY_POLL_INTERVAL)
        if isinstance(self.market, MarketData) and isinstance(self.market.api.budget, RateBudget):
            self.market.api.budget.configure_capacity_reserve(math.ceil(allowance))
            allowance = self.market.api.budget.snapshot()["capacity_reserve"]
        self.local_capacity_poll_enabled = bool(local_symbols) and allowance > 0
        scale = max(1, baseline / allowance) if allowance > 0 else 1
        intervals = dict.fromkeys(MARKET_SYMBOLS, CAPACITY_POLL_INTERVAL * scale if allowance > 0 else 60)
        if count and allowance > 0 and scale == 1:
            remaining = allowance - baseline + count * 60 / CAPACITY_POLL_INTERVAL
            interval = max(FAST_CAPACITY_POLL_INTERVAL, 60 / math.floor(remaining / count))
            intervals.update(dict.fromkeys(local_fast, interval))
        # Relay reads spend no local Aster weight and stay independent of a
        # constrained main host, including when its reserve falls to zero.
        intervals.update({symbol: FAST_CAPACITY_POLL_INTERVAL if symbol in targets else CAPACITY_POLL_INTERVAL
                          for symbol in remote_symbols})
        return intervals, PUBLIC_BRACKETS_REFRESH_INTERVAL * scale, bool(remote_symbols) or self.local_capacity_poll_enabled

    def poll_public_brackets(self, symbol):
        if self.shutdown.is_set() or not self.capacity_sampling_enabled(symbol) or symbol not in self.capacity_market_symbols():
            return self.brackets_interval(symbol)
        try:
            self.market.refresh_public_brackets(symbol)
            return self.brackets_interval(symbol)
        except (TradingError, KeyError, ValueError, TypeError) as exc:
            floor = 1 if self.uses_capacity_relay(symbol) else 10
            return max(floor, getattr(exc, "retry_after", 0))

    def poll_market(self, symbol):
        if self.shutdown.is_set() or not self.capacity_sampling_enabled(symbol) or symbol not in self.capacity_market_symbols():
            return self.capacity_interval(symbol)
        try:
            with self.lock:
                targets = self.capacity_targets.get(symbol, set()).copy()
                accounts = self.capacity_accounts.copy() if targets else None
            if accounts is None:
                accounts = self.store.accounts()
            interval = self.capacity_interval(symbol)
            pairs = self.store.pairs()
            if pairs:
                # A worker may have been queued before a pair persisted its
                # intent. Recheck before HTTP; never cancel an in-flight sample.
                accounts = self.store.accounts()
                targets = self.fast_capacity_targets(accounts, pairs).get(symbol, set())
                if not targets:
                    interval = max(interval, CAPACITY_POLL_INTERVAL)
                    if time.monotonic() - self.capacity_sample_started.get(symbol, -math.inf) < interval:
                        return interval
            self.capacity_sample_started[symbol] = time.monotonic()
            full = time.monotonic() - self.capacity_full_checked.get(symbol, -math.inf) >= CAPACITY_POLL_INTERVAL
            tiers = set(TIERS) | targets if full or not targets else targets
            # Network latency is part of the capacity snapshot's age.
            checked_at = time.time()
            sample = self.market.capacities(symbol, tiers)
            checked_at = getattr(sample, "checked_at", checked_at)
            capacities = {tier: value for tier, value in sample.items() if tier in tiers}
            with self.lock:
                previous = self.markets.get(symbol, {})
                values = {k: v for k, v in previous.get("capacities", {}).items() if int(k) not in tiers}
                stamps = {k: v for k, v in previous.get("capacity_checked_at", {}).items() if int(k) not in tiers}
                values.update({str(k): wire(v) for k, v in capacities.items()})
                stamps.update({str(k): checked_at for k in capacities})
                row = {"status": "ok", "capacities": values, "capacity_checked_at": stamps,
                       "checked_at": checked_at, "poll_interval_ms": round(interval * 1000),
                       "fast_leverages": sorted(targets)}
                self.markets[symbol] = {**previous, **json.loads(dumps(row))}
                self.markets[symbol].pop("error", None)
            if targets:
                self.scheduler_event.set()
            # Wake execution before notification storage or quote I/O can delay it.
            if full or not targets or 5 in tiers:
                self.wake_capacity_accounts(symbol, {int(k): dec(v) for k, v in values.items()}, checked_at, accounts,
                                            sampled_tiers=tiers, capacity_checked_at=stamps)
            if full or not targets:
                self.observe_capacity_alerts(symbol, capacities, checked_at)
                self.capacity_full_checked[symbol] = time.monotonic()
            return interval
        except (TradingError, KeyError, ValueError, TypeError) as exc:
            self.invalidate_capacity_alerts(symbol)
            with self.lock:
                previous = self.markets.get(symbol, {})
                self.markets[symbol] = {**previous, "status": "error", "error": str(exc) if isinstance(exc, TradingError) else "行情数据格式异常"}
            self.wake_capacity_accounts(symbol, {}, time.time(), [])
            self.scheduler_event.set()
            if isinstance(exc, PublicBracketsUnavailable):
                return CAPACITY_POLL_INTERVAL
            if self.uses_capacity_relay(symbol):
                return PollBackoff(max(.5, getattr(exc, "retry_after", 0)))
            return PollBackoff(max(10, getattr(exc, "retry_after", 0)))

    def poll_book(self, symbol):
        """Keep the strategy's BBO indicator independent of display depth."""
        if self.shutdown.is_set() or symbol not in self.monitored_market_symbols():
            return 5
        try:
            book = self.market.book(symbol)
            book.require_fresh()
            with self.lock:
                row = self.markets.setdefault(symbol, {})
                row["book"] = json.loads(dumps({**asdict(book), "spread": book.spread}))
                row.pop("book_error", None)
            return 5
        except (TradingError, KeyError, ValueError, TypeError) as exc:
            with self.lock:
                row = self.markets.setdefault(symbol, {})
                row.pop("book", None)
                row["book_error"] = str(exc) if isinstance(exc, TradingError) else "盘口数据格式异常"
            return max(10, getattr(exc, "retry_after", 0))

    def poll_depth(self, symbol):
        """Display depth cannot hold up the shared capacity feed."""
        if self.shutdown.is_set() or symbol not in self.monitored_market_symbols():
            return DEPTH_POLL_INTERVAL
        try:
            depth = self.market.depth(symbol)
            depth.require_fresh()
            display = depth.display()
            depth.require_fresh()
            with self.lock:
                row = self.markets.setdefault(symbol, {})
                row["depth"] = display
                row.pop("depth_error", None)
            return DEPTH_POLL_INTERVAL
        except (TradingError, KeyError, ValueError, TypeError) as exc:
            with self.lock:
                row = self.markets.setdefault(symbol, {})
                # Preserve the last sample as visibly stale context on failures.
                row["depth_error"] = str(exc) if isinstance(exc, TradingError) else "深度数据格式异常"
            return max(DEPTH_POLL_INTERVAL, getattr(exc, "retry_after", 0))

    def wake_capacity_accounts(self, symbol, capacities, checked_at, accounts, *, sampled_tiers=None, capacity_checked_at=None):
        """Merge availability edges without polling private accounts at the feed cadence."""
        now = time.time()
        fresh = -1 <= now - checked_at <= 8
        sampled = set(TIERS) if sampled_tiers is None else set(sampled_tiers)
        stamps = {tier: (capacity_checked_at or {}).get(str(tier)) for tier in capacities}
        capacities = {tier: value for tier, value in capacities.items()
                      if type(stamps[tier]) in (int, float) and math.isfinite(stamps[tier])
                      and -1 <= now - stamps[tier] <= 8}
        by_id = {a["id"]: a for a in accounts}
        with self.lock:
            ids = set(by_id) | {aid for aid, work in self.account_work.items()
                               if symbol in work.priority_levels or symbol in work.capacity_available}
            for aid in ids:
                account = by_id.get(aid)
                self.observe_ordinary_capacity(aid, account, symbol, capacities if fresh else {}, stamps, sampled, now)
                levels = ()
                if fresh and account and account["enabled"] and self.live_allowed(account) and symbol in ordinary_add_symbols(account):
                    positions = [p for p in self.views.get(aid, {}).get("snapshot", {}).get("positions", []) if p["symbol"] == symbol]
                    current = max((p["leverage"] for p in positions), default=0)
                    threshold = dec(account["policy"]["threshold"])
                    required = max(threshold,
                                   sum((dec(p.get("qty", 0)).copy_abs() * dec(p.get("mark", 0)) for p in positions), dec(0)))
                    minimum = minimum_open_leverage(account["policy"])
                    wake_tiers = (5, *PRIORITY_TIERS) if minimum <= 5 else PRIORITY_TIERS
                    levels = tuple(tier for tier in wake_tiers
                                   if (tier > current and capacities.get(tier, dec(0)) > required)
                                   or (tier == current >= minimum and capacities.get(tier, dec(0)) > threshold))
                work = self.work(aid)
                previous = work.priority_levels.get(symbol, ())
                if levels:
                    work.priority_levels[symbol] = levels
                    new_levels = (set(levels) - set(previous)) & sampled
                    sampled_levels = set(levels) & sampled
                    if new_levels:
                        work.priority[symbol] = max(stamps[tier] for tier in new_levels)
                    elif symbol in work.priority and sampled_levels:
                        # Refresh a queued opportunity while this account is busy/backing off.
                        work.priority[symbol] = max(stamps[tier] for tier in sampled_levels)
                    elif symbol in work.priority:
                        # A partial 5x sample cannot renew an old high-tier signal.
                        work.priority[symbol] = min(work.priority[symbol], max(stamps[tier] for tier in levels))
                else:
                    work.priority_levels.pop(symbol, None)
                    self.work(aid).priority.pop(symbol, None)
            if any(work.priority for work in self.account_work.values()):
                self.scheduler_event.set()

    @staticmethod
    def capacity_identity(account):
        policy = account["policy"]
        return (wire(dec(policy["threshold"])), minimum_open_leverage(policy),
                tuple(ordinary_add_symbols(account)), account["mode"])

    def observe_ordinary_capacity(self, aid, account, symbol, capacities, stamps, sampled, now):
        """Keep availability periods separate from consumable priority edges."""
        work = self.work(aid)
        if (not account or not account["enabled"] or not self.live_allowed(account)
                or symbol not in ordinary_add_symbols(account)):
            work.capacity_available.pop(symbol, None)
            return
        identity = self.capacity_identity(account)
        previous = work.capacity_available.get(symbol, {})
        periods = previous.get("tiers", {}) if previous.get("identity") == identity else {}
        threshold, tick = dec(account["policy"]["threshold"]), time.monotonic()
        updated = {}
        for tier, value in capacities.items():
            if tier not in TIERS or value <= threshold:
                continue
            period = periods.get(tier)
            if period and not (-1 <= now - period["checked_at"] <= 8 and 0 <= tick - period["seen_tick"] <= 8):
                period = None
            if tier in sampled:
                if period is None:
                    period = {"detected_at": now, "detected_tick": tick, "threshold": wire(threshold)}
                period = {**period, "checked_at": stamps[tier], "seen_tick": tick}
            if period is not None:
                updated[tier] = period
        work.capacity_available[symbol] = {"identity": identity, "tiers": updated}

    def ordinary_capacity_observation(self, account, symbol, leverage):
        with self.lock:
            state = self.work(account["id"]).capacity_available.get(symbol, {})
            period = state.get("tiers", {}).get(leverage)
            if (state.get("identity") == self.capacity_identity(account) and period
                    and -1 <= time.time() - period["checked_at"] <= 8
                    and 0 <= time.monotonic() - period["seen_tick"] <= 8):
                return period.copy()
        return None

    def priority_continuation(self, account_id, *, leverage=False):
        with self.lock:
            self.work(account_id).followup = True
            self.work(account_id).leverage_followup = leverage
        self.scheduler_event.set()

    @staticmethod
    def select_leverage(snapshot, symbol, capacities, book, policy, priority=False):
        options = {"threshold": policy["threshold"], "min_open_leverage": minimum_open_leverage(policy)}
        if priority:
            target = next_leverage(snapshot, symbol, {tier: value for tier, value in capacities.items() if tier in PRIORITY_TIERS}, book.mark, **options)
            if target is not None:
                return target
        return next_leverage(snapshot, symbol, capacities, book.mark, **options)

    def capacities(self, symbol):
        with self.lock:
            row = self.markets.get(symbol, {}).copy()
        now = time.time()
        if row.get("status") != "ok" or not -1 <= now - row.get("checked_at", 0) <= 8:
            raise TradingError("市场额度快照过期或查询失败")
        capacities = {int(k): dec(v) for k, v in row["capacities"].items()
                      if type(stamp := row.get("capacity_checked_at", {}).get(k)) in (int, float)
                      and math.isfinite(stamp) and -1 <= now - stamp <= 8}
        return capacities

    def check_post_fill_occupancy(self, account, snapshot):
        snapshot.require_modes(account["policy"]["symbols"])
        snapshot.require_fresh()
        limit = dec(account["policy"]["margin_limit"])
        batch = self.store.get("post_fill_check:" + account["id"])
        if not batch:
            # A partially filled pair has not written the completion marker yet.
            pending = self.store.intent(account["id"])
            batch = pending if pending and pending["kind"] == "pair" else None
        # Old boolean markers retain the base limit. An unrelated high-leverage
        # position must never grant a low-leverage batch extra opening room.
        if legacy_block_reason(self.store, account["id"]):
            self.store.pause_account(account, LEGACY_PENDING_REASON)
            self.view(account["id"], status="attention", reason=LEGACY_PENDING_REASON)
            return True
        if isinstance(batch, dict) and batch.get("leverage") in (10, 20):
            actual, _ = snapshot.pair(batch["symbol"])
            limit = opening_margin_limit(account["policy"], actual.leverage)
        ratio = snapshot.ratio if snapshot.equity > 0 else None
        over_limit = ratio is None or snapshot.margin_exceeds(limit)
        if over_limit:
            message = "成交后 USD1 账户总权益不足，已暂停新加仓" if ratio is None else "成交后保证金占用率超过上限，已暂停新加仓"
            self.store.pause_account(account, message)
            self.view(account["id"], status="attention", reason=message)
            self.store.event(account["id"], "error", message)
            self.store.finish_campaign(account, message, ratio)
        # Only clear the durable check after any required pause has been saved.
        self.store.put("post_fill_check:" + account["id"], None)
        return over_limit

    @staticmethod
    def rank_candidates(candidates):
        # Rank the usable opening tier first, including a pending upgrade target.
        # Stable sorting retains rotation only when both tier and spread tie.
        return sorted(candidates, key=lambda c: (-c.opening_leverage, c.book.spread_exact))

    def market_error(self, account_id, symbol, exc):
        reason = str(exc) if isinstance(exc, TradingError) else "交易数据格式异常"
        self.strategy(account_id, symbol, reason, "waiting")
        if isinstance(exc, (AccountModeError, RequestNotSent, SnapshotSuperseded)) or self.store.intent(account_id):
            # No new symbol work until an existing intent is resolved.
            raise exc
        if isinstance(exc, ExchangeError) and exc.retry_after:
            raise exc
        return reason

    def tick_account(self, account_id):
        with self.store.connection_scope():
            return self._tick_account(account_id)

    @protected_account
    def _tick_account(self, account_id):
        with self.account_lock(account_id):
            paired = self.store.pair_for_account(account_id)
            if paired:
                self.view(account_id, status="paired", reason="由配对组「" + paired["name"] + "」统一管理")
                return 30
            with self.lock:
                priority = self.work(account_id).active_priority
                priority_signals = self.work(account_id).take_active_signals()
            progressed, consumed_symbol, retry_priority = False, None, False
            if self.shutdown.is_set():
                return 5
            account = self.store.account(account_id)
            if not account:
                return 5
            # Maintenance still reads snapshots once update evidence is taken;
            # the check after the read yields before any new work.
            if (self.workspace.reads_paused and not self.store.intent(account_id)
                    and not self.store.get("post_fill_check:" + account_id)):
                return 5
            pending = None
            try:
                blocked = legacy_block_reason(self.store, account_id)
                if blocked:
                    if account.get("enabled") or account.get("pause_reason") != blocked:
                        self.store.pause_account(account, blocked)
                    self.view(account_id, status="attention", reason=blocked)
                    return 30
                broker = self.broker(account)
                pending = self.store.intent(account_id)
                symbols = account["policy"]["symbols"]
                recovery = bool(pending or self.store.get("post_fill_check:" + account_id))
                with self.recovery_budget(broker) if recovery else nullcontext():
                    if isinstance(broker, LiveBroker) and not recovery:
                        broker.api.budget.require_available(broker.snapshot_weight(symbols))
                    snapshot = broker.snapshot(symbols)
                self.view(account_id, snapshot=snapshot_json(snapshot, symbols), credential_ready=True)
                snapshot.require_modes(symbols)
                if self.shutdown.is_set():
                    return 5
                if self.store.get("post_fill_check:" + account_id) and self.check_post_fill_occupancy(account, snapshot):
                    return 5
                if self.workspace.active and not pending:
                    # Finish an existing post-fill read during maintenance,
                    # then yield before planning or journaling any new work.
                    return 5
                pause_reason = account.get("pause_reason") if not account["enabled"] else None
                self.view(account_id, status="running" if account["enabled"] else "attention" if pause_reason else "paused",
                          reason="策略运行中" if account["enabled"] else pause_reason or "策略已暂停")
                executor = Executor(self.store, broker, self.market)
                if pending:
                    if self.live_allowed(account):
                        reason = executor.reconcile(account, pending)
                        current = self.store.intent(account_id)
                        status = "attention" if current and current["status"] == "attention" else "reconciling"
                    else:
                        status, reason = "attention", "服务器未启用实盘执行，保留未完成批次等待核对"
                    self.view(account_id, status=status, reason=reason)
                    self.strategy(account_id, pending["symbol"], reason, status)
                    progressed = True
                    if pending["kind"] == "pair" and not self.store.intent(account_id):
                        consumed_symbol = pending["symbol"]
                        self.record_batch_outcome(account_id, executor)
                        after = self.completed_snapshot(executor, broker, account["policy"]["symbols"])
                        self.view(account_id, snapshot=snapshot_json(after, account["policy"]["symbols"]))
                        if not self.check_post_fill_occupancy(account, after):
                            self.rearm_ordinary_capacity(account, executor)
                    elif (pending["kind"] == "leverage" and (pending["target"] in PRIORITY_TIERS
                          or pending["target"] == 5 and minimum_open_leverage(account["policy"]) <= 5)
                          and not self.store.intent(account_id) and account["enabled"] and self.live_allowed(account)
                          and self.store.get(f"open_after_leverage:{account_id}:{pending['symbol']}") is not None):
                        self.priority_continuation(account_id, leverage=True)
                    return 5
                if not account["enabled"] or self.shutdown.is_set():
                    for symbol in account["policy"]["symbols"]:
                        self.strategy(account_id, symbol, "策略已暂停", "paused")
                    if snapshot.equity > 0:
                        self.store.finish_campaign(account, "策略已暂停", snapshot.ratio)
                    return 5
                if not self.live_allowed(account):
                    raise TradingError("服务器尚未设置 ASTER_ALLOW_LIVE=1")
                policy = account["policy"]
                minimum = minimum_open_leverage(policy)
                markets = ordinary_add_symbols(account)
                for symbol, reason in ordinary_add_blocks(account).items():
                    self.strategy(account_id, symbol, reason, "disabled")
                if not markets:
                    return 5
                start = self.rotation.get(account_id, 0) % len(markets)
                ordered = markets[start:] + markets[:start]
                last_reason = "等待交易条件"
                candidates = []
                first_add_symbols = set()
                campaign_limit = dec(policy["margin_limit"])
                for symbol in ordered:
                    try:
                        long, short = snapshot.require_ready(symbol)
                        campaign_limit = max(campaign_limit, opening_margin_limit(policy, long.leverage))
                        if self.market.rules[symbol].margin_asset != "USD1":
                            raise TradingError("仅允许 USD1 保证金市场")
                        capacities = self.capacities(symbol)
                        book = self.market.book(symbol)
                        book.require_fresh()
                        if self.shutdown.is_set():
                            return 5
                        target = None
                        current_available = capacities.get(long.leverage, dec(0)) > dec(policy["threshold"])
                        first_add = long.leverage >= minimum and self.store.get(f"open_after_leverage:{account_id}:{symbol}") == long.leverage and current_available
                        if first_add and priority and long.leverage not in PRIORITY_TIERS:
                            high_target = self.select_leverage(snapshot, symbol, capacities, book, policy, True)
                            if (high_target in PRIORITY_TIERS
                                    and not leverage_cooldown_active(self.store, account, broker, symbol, high_target)):
                                first_add = False
                        if not first_add:
                            target = self.select_leverage(snapshot, symbol, capacities, book, policy, priority)
                            if target is not None and leverage_cooldown_active(self.store, account, broker, symbol, target):
                                target = None
                        if target is not None:
                            candidates.append(MarketCandidate(symbol, long.leverage, book, target))
                            continue
                        if long.leverage < minimum:
                            last_reason = ordinary_leverage_wait(long.leverage, minimum)
                            self.strategy(account_id, symbol, last_reason)
                            continue
                        cooldown = self.store.get(f"order_cooldown:{account_id}:{symbol}") or {}
                        if cooldown.get("until", 0) > time.time():
                            last_reason = f"上批无新增仓位，新开单冷却中（剩余 {max(1, int(cooldown['until'] - time.time()))} 秒）"
                            self.strategy(account_id, symbol, last_reason)
                            continue
                        plan = plan_pair(snapshot, book, self.market.rules[symbol], capacities, policy)
                        if first_add and not plan.qty:
                            # A full current initial margin must not permanently block
                            # a further upgrade that could free balance for the first add.
                            self.store.put(f"open_after_leverage:{account_id}:{symbol}", None)
                        self.strategy(account_id, symbol, plan.reason, projected_ratio=wire(plan.projected_ratio) if plan.projected_ratio is not None else None)
                        last_reason = plan.reason
                        if plan.qty:
                            candidates.append(MarketCandidate(symbol, long.leverage, book))
                            if first_add and long.leverage in PRIORITY_TIERS:
                                first_add_symbols.add(symbol)
                    except (TradingError, KeyError, ValueError, TypeError) as exc:
                        last_reason = self.market_error(account_id, symbol, exc)
                if priority_signals:
                    # Unrelated filled markets must not repeatedly consume another
                    # market's queued opportunity. Keep confirmed first adds eligible.
                    preferred = [c for c in candidates if c.symbol in priority_signals or c.symbol in first_add_symbols]
                    if preferred:
                        candidates = preferred
                    else:
                        priority_signals = {}
                for candidate in self.rank_candidates(candidates):
                    if self.shutdown.is_set():
                        return 5
                    symbol, book, target = candidate.symbol, candidate.book, candidate.target
                    try:
                        # Comparing markets can take time. Reuse the sampled BBO
                        # only while fresh, and recheck the shared capacity cache.
                        snapshot.require_ready(symbol)
                        book.require_fresh()
                        capacities = self.capacities(symbol)
                        if target is not None:
                            if leverage_cooldown_active(self.store, account, broker, symbol, target):
                                continue
                            if self.select_leverage(snapshot, symbol, capacities, book, policy, priority) != target:
                                last_reason = "可用杠杆档位已变化，等待下一轮比较"
                                self.strategy(account_id, symbol, last_reason)
                                continue
                            if isinstance(broker, LiveBroker):
                                broker.api.budget.require_available(broker.snapshot_weight(account["policy"]["symbols"], fresh_modes=True) + 1)
                            def validate_upgrade(current):
                                latest_book = self.market.book(symbol)
                                latest_book.require_fresh()
                                latest = self.capacities(symbol)
                                if next_leverage(current, symbol, {target: latest.get(target, dec(0))}, latest_book.mark,
                                                 threshold=policy["threshold"], min_open_leverage=minimum) != target:
                                    raise TradingError("目标杠杆额度或账户条件已变化，等待新机会")
                            reason = executor.leverage(account, symbol, candidate.leverage, target, snapshot=snapshot,
                                                       before_submit=validate_upgrade)
                            progressed = True
                            self.strategy(account_id, symbol, reason, "leverage")
                            self.rotation[account_id] = (markets.index(symbol) + 1) % len(markets)
                            if target in PRIORITY_TIERS or target == 5 and minimum <= 5:
                                self.priority_continuation(account_id, leverage=True)
                            return 5
                        plan = plan_pair(snapshot, book, self.market.rules[symbol], capacities, policy)
                        if not plan.qty:
                            last_reason = plan.reason
                            self.strategy(account_id, symbol, last_reason)
                            continue
                        if isinstance(broker, LiveBroker):
                            broker.api.budget.require_available(5 + broker.snapshot_weight(symbols))
                        reason = executor.open_pair(account, snapshot, symbol, plan, book,
                            capacity_observation=lambda symbol=symbol, leverage=candidate.leverage:
                                self.ordinary_capacity_observation(account, symbol, leverage))
                        progressed, consumed_symbol = True, symbol
                        # A completed pair is followed by an actual account risk check.
                        self.record_batch_outcome(account_id, executor)
                        after = self.completed_snapshot(executor, broker, symbols)
                        unresolved = self.store.intent(account_id)
                        phase = ("attention" if unresolved["status"] == "attention" else "reconciling") if unresolved else "filled"
                        self.view(account_id, snapshot=snapshot_json(after, symbols), reason=reason, status=phase if unresolved else "running")
                        after.require_modes(symbols)
                        self.strategy(account_id, symbol, reason, phase)
                        if not self.check_post_fill_occupancy(account, after):
                            self.rearm_ordinary_capacity(account, executor)
                        self.rotation[account_id] = (markets.index(symbol) + 1) % len(markets)
                        return 5
                    except (TradingError, KeyError, ValueError, TypeError) as exc:
                        last_reason = self.market_error(account_id, symbol, exc)
                self.view(account_id, reason=last_reason)
                campaign = self.store.get("campaign:" + account_id)
                if campaign and (snapshot.margin_exceeds(campaign_limit, include_equal=True) or time.time() - campaign["last_fill_at"] >= 60):
                    self.store.finish_campaign(account, last_reason, snapshot.ratio)
                return 5
            except SnapshotSuperseded as exc:
                # A revoked GET did not fail an order. Retain the durable batch
                # and retry its read; never turn this into a new submission.
                pending = self.store.intent(account_id)
                attention = account.get("pause_reason") or (pending and pending["status"] == "attention")
                reason = (account.get("pause_reason") or (pending or {}).get("last_error") or str(exc)) if attention else str(exc)
                status = "attention" if attention else "waiting" if account["enabled"] else "paused"
                self.view(account_id, status=status, reason=reason, credential_ready=account_id in self.brokers)
                with self.lock:
                    work = self.work(account_id)
                    work.wake = True
                    work.backoff = max(work.backoff, time.monotonic() + 1)
                self.wake_private_stream(account_id)
                return 1
            except (TradingError, KeyError, ValueError, TypeError) as exc:
                message = str(exc) if isinstance(exc, TradingError) else "账户响应格式异常，已停止本轮操作"
                with self.lock:
                    old_reason = self.views.get(account_id, {}).get("reason")
                    log_wait = not isinstance(exc, BudgetWait) or time.monotonic() - self.budget_wait_events.get(account_id, -1e9) >= 60
                    if isinstance(exc, BudgetWait) and old_reason != message and log_wait:
                        self.budget_wait_events[account_id] = time.monotonic()
                if old_reason != message and log_wait:
                    self.store.event(account_id, "wait" if isinstance(exc, BudgetWait) else "error", message)
                status = "waiting" if isinstance(exc, BudgetWait) else "error"
                if isinstance(exc, AccountModeError):
                    self.store.pause_account(account, message)
                    pending = self.store.intent(account_id)
                    if pending:
                        pending.update(status="attention", last_error=message)
                        self.store.save_intent(pending)
                    for symbol in account["policy"]["symbols"]:
                        self.strategy(account_id, symbol, message, "attention")
                    status = "attention"
                self.view(account_id, status=status, reason=message, credential_ready=account_id in self.brokers)
                delay = max(10, getattr(exc, "retry_after", 0))
                with self.lock:
                    self.work(account_id).backoff = time.monotonic() + delay
                if priority and isinstance(exc, ExchangeError):
                    retry_priority = True
                    self.priority_continuation(account_id, leverage=self.work(account_id).active_leverage_followup)
                return delay
            finally:
                urgent = bool(self.store.intent(account_id) or self.store.get("post_fill_check:" + account_id))
                with self.lock:
                    self.work(account_id).active_priority = False
                    if progressed or retry_priority:
                        # Keep each opportunity through upgrade and confirmation;
                        # consume it after its first batch, retaining the other markets.
                        for symbol in priority_signals:
                            row = self.markets.get(symbol, {})
                            if (symbol != consumed_symbol and self.work(account_id).priority_levels.get(symbol)
                                and row.get("status") == "ok" and -1 <= time.time() - row.get("checked_at", 0) <= 8):
                                self.work(account_id).priority.setdefault(symbol, row["checked_at"])
                    if urgent:
                        self.work(account_id).urgent = True
                    else:
                        self.work(account_id).urgent = False

    def add_account(self, data):
        account = validate_account({**data, "enabled": False, "policy": {**DEFAULT_POLICY}})
        if self.demo and account["mode"] != "paper":
            raise TradingError("模拟环境只接受模拟账户")
        with self.registration_lock:
            accounts = self.store.accounts()
            if len(accounts) >= MAX_ACCOUNTS:
                raise TradingError("单实例最多管理 8 个账户")
            if self.store.account_id_used(account["id"]):
                raise TradingError("账户标识已使用，包含已删除的历史账户；请使用新的账户标识")
            if any(a["env_prefix"] == account["env_prefix"] for a in accounts):
                raise TradingError("账户标识或环境变量前缀已使用")
            self.store.save_account(account)
            with self.lock:
                self.accounts_generation += 1
        self.store.event(account["id"], "config", "账户已添加，默认暂停")
        return account

    def delete_account(self, account_id):
        # Serialize removal with trading, controls and registration. Retain the
        # account lock object so queued workers cannot acquire a different lock.
        with self.account_lock(account_id), self.registration_lock:
            with self.lock:
                self.store.delete_account(account_id)
                self.deleted_accounts.add(account_id)
                broker = self.brokers.pop(account_id, None)
                for registry in (self.signers, self.users):
                    for key in [key for key, aid in registry.items() if aid == account_id]:
                        registry.pop(key)
                self.account_work.pop(account_id, None)
                for cache in (self.views, self.display_snapshots, self.rotation,
                              self.budget_wait_events):
                    cache.pop(account_id, None)
                self.capacity_accounts = [a for a in self.capacity_accounts if a["id"] != account_id]
                self.accounts_generation += 1
            self.scheduler_event.set()
            if isinstance(broker, LiveBroker):
                try:
                    broker.close()
                except Exception:
                    LOG.warning("Deleted account client cleanup failed")

    def configure(self, account_id, changes):
        with self.account_lock(account_id):
            self.pairs.require_unbound(account_id)
            account = self.store.account(account_id)
            if not account:
                raise TradingError("账户不存在")
            pending = self.store.intent(account_id)
            if account["enabled"] or pending:
                raise TradingError("请先暂停策略并等待当前批次完成")
            if legacy_block_reason(self.store, account_id):
                raise TradingError(LEGACY_PENDING_REASON)
            if not isinstance(changes, dict) or not changes or set(changes) - EDITABLE_POLICY_FIELDS:
                raise TradingError("请选择有效的策略配置字段")
            policy_changes = changes
            if any(value is None or (key != "min_open_leverage" and not isinstance(value, str)) for key, value in policy_changes.items()):
                raise TradingError("策略配置字段类型无效")
            for key in ("threshold", "order_notional", "margin_limit", "spread_limit"):
                if key in policy_changes:
                    decimal_text(policy_changes[key], "策略金额与比例必须为普通十进制数")
            account["policy"] = {**account["policy"], **policy_changes}
            validate_account(account)
            if "min_open_leverage" in changes:
                account.pop("leverage_setting_required", None)
            self.store.save_account(account, user_control=True, discard_removed=True)
            self.revoke_account_reads(account_id, "账户配置已更新")
            with self.lock:
                self.work(account_id).capacity_available.clear()
                self.accounts_generation += 1
            self.store.event(account_id, "config", "策略设置已更新")

    def enable(self, account_id, enabled):
        with self.account_lock(account_id):
            self.pairs.require_unbound(account_id)
            account = self.store.account(account_id)
            if not account:
                raise TradingError("账户不存在")
            view_updates = {}
            if enabled:
                ordinary_markets = ordinary_add_symbols(account)
                ordinary_active = bool(ordinary_markets)
                if account.get("leverage_setting_required") and ordinary_active:
                    raise TradingError("请先在 5x、10x、20x 中保存最低开仓杠杆设置")
                if not self.live_allowed(account):
                    raise TradingError("服务器尚未启用实盘执行（ASTER_ALLOW_LIVE=1）")
                if ordinary_active and dec(account["policy"]["order_notional"]) < MIN_BATCH_NOTIONAL:
                    raise TradingError("单批每边上限低于固定最低批次金额 500 USD1，请先修改策略设置")
                if self.store.intent(account_id):
                    raise TradingError("请先核对未完成批次")
                symbols = account["policy"]["symbols"]
                broker = self.broker(account)
                if legacy_block_reason(self.store, account_id):
                    raise TradingError(LEGACY_PENDING_REASON)
                snapshot = broker.snapshot(symbols, fresh_modes=True)
                for symbol in symbols:
                    snapshot.require_ready(symbol)
                view_updates = {"snapshot": snapshot_json(snapshot, symbols), "credential_ready": True,
                                "strategies": {symbol: {"phase": "waiting", "reason": "策略已启动，等待下一轮检查"}
                                               for symbol in account["policy"]["symbols"]}}
                # High existing occupancy blocks additions in plan_pair, while an
                # authorized increase in leverage can release margin before adding.
            account["enabled"] = enabled
            if enabled:
                account.pop("pause_reason", None)
            self.store.save_account(account, user_control=True, discard_removed=enabled)
            self.revoke_account_reads(account_id, "账户运行状态已更新")
            with self.lock:
                self.work(account_id).capacity_available.clear()
                self.work(account_id).wake = True
                self.accounts_generation += 1
            self.view(account_id, status="running" if enabled else "attention" if account.get("pause_reason") else "paused",
                      reason="策略运行中" if enabled else account.get("pause_reason") or "策略已暂停", **view_updates)
            self.store.event(account_id, "control", "策略已启动" if enabled else "策略已暂停；已提交批次继续核对")

    def retry(self, account_id):
        with self.account_lock(account_id):
            self.pairs.require_unbound(account_id)
            intent = self.store.intent(account_id)
            if not intent:
                return
            if legacy_block_reason(self.store, account_id):
                raise TradingError(LEGACY_PENDING_REASON)
            intent["status"] = "pending"
            if intent["kind"] == "pair":
                intent["repair_attempts"] = 0
            self.store.save_intent(intent)
            with self.lock:
                self.work(account_id).urgent = True
                self.work(account_id).wake = True
            self.store.event(account_id, "control", "重新核对未完成批次；不重复提交原开仓订单")

    def notification_config(self, channel="event"):
        if not self.store.monitoring_settings()["feishu_enabled"]:
            return None
        selected = notification_channels.credentials(channel)
        if not selected["webhook"]:
            return None
        base = json.loads((monitor.ROOT / "config.json").read_text(encoding="utf-8"))
        return monitor.validate_config({**base, "feishu_enabled": True, "feishu_webhook": selected["webhook"],
                                       "feishu_sign_secret": selected["secret"]}, environ={})

    def notification_configs(self):
        configs = {}
        for channel in notification_channels.CHANNELS:
            try:
                configs[channel] = self.notification_config(channel)
                if configs[channel] is None or self.notification_channel_errors[channel] == "飞书配置无效":
                    self.notification_channel_errors[channel] = None
            except (monitor.MonitorError, OSError, ValueError, TypeError, KeyError):
                configs[channel] = None
                self.notification_channel_errors[channel] = "飞书配置无效"
        return configs

    def capacity_alert_config(self, notification=None):
        if self.demo:
            return None
        enabled = os.environ.get("ASTER_CAPACITY_ALERT_ENABLED", "1").strip()
        if enabled not in ("0", "1"):
            raise TradingError("额度提醒开关必须为 0 或 1")
        if enabled == "0":
            return None
        config = notification if notification is not None else self.notification_config()
        if config is None:
            return None
        cooldown = positive(os.environ.get("ASTER_CAPACITY_ALERT_COOLDOWN_SECONDS", str(config["cooldown_seconds"])), True)
        if cooldown > 86400:
            raise TradingError("额度提醒冷却时间超出范围")
        accounts = sorted(self.store.accounts(), key=lambda account: account["id"])
        settings = self.store.monitoring_settings()
        markets = {}
        for symbol in SYMBOLS:
            if not monitoring.allowed(settings, "strategy_capacity", [symbol]):
                continue
            sources = []
            for account in accounts:
                if symbol not in account["policy"]["symbols"]:
                    continue
                threshold = positive(account["policy"]["threshold"], True)
                if threshold > 1000000000:
                    raise TradingError("网页额度阈值超出范围")
                sources.append((account["id"], account["name"], threshold))
            if not sources:
                continue
            # Bind queued messages to the saved web settings. Changing a setting
            # invalidates an old candidate, including during delivery retries.
            identity_sources = [(aid, name, threshold.as_integer_ratio()) for aid, name, threshold in sources]
            identity = hashlib.sha256(f"{config['webhook']}|{symbol}|{identity_sources!r}".encode()).hexdigest()
            markets[symbol] = {"threshold": min(source[2] for source in sources),
                               "identity": identity, "accounts": sources}
        return {"markets": markets, "cooldown": float(cooldown)}

    def invalidate_capacity_alerts(self, symbol, leverage=None):
        try:
            self.store.invalidate_capacity_alert(symbol, leverage)
            return True
        except Exception:
            # A notification failure must not take down price polling or trading.
            with self.lock:
                self.capacity_notification_errors[symbol] = "额度提醒状态保存失败，等待重试"
            return False

    def observe_capacity_alerts(self, symbol, capacities, checked_at):
        if self.demo or self.shutdown.is_set():
            return
        try:
            policy = self.capacity_alert_config()
            market_policy = policy["markets"].get(symbol) if policy else None
            if market_policy is None:
                if self.invalidate_capacity_alerts(symbol):
                    with self.lock:
                        self.capacity_notification_errors.pop(symbol, None)
                return
            with self.store.capacity_alert_batch() as alerts:
                for leverage in TIERS:
                    if leverage not in capacities:
                        alerts.invalidate_capacity_alert(symbol, leverage)
                        continue
                    alerts.observe_capacity_alert(symbol, leverage, capacities[leverage],
                        threshold=market_policy["threshold"], cooldown=policy["cooldown"],
                        identity=market_policy["identity"], checked_at=checked_at,
                        account_labels=[f"{name}（{aid}，> {threshold:,.2f} USD1）"
                                        for aid, name, threshold in market_policy["accounts"]
                                        if dec(capacities[leverage]) > threshold])
            with self.lock:
                self.capacity_notification_errors.pop(symbol, None)
        except (TradingError, monitor.MonitorError, ValueError, TypeError, OSError):
            self.invalidate_capacity_alerts(symbol)
            with self.lock:
                self.capacity_notification_errors[symbol] = "额度提醒配置或数据无效，等待修正"
        except Exception:
            with self.lock:
                self.capacity_notification_errors[symbol] = "额度提醒状态保存失败，等待重试"

    def observe_relay_health(self, config):
        try:
            revision = self.store.monitoring_settings()["revision"]
            active = (bool(config) and not self.demo and not self.shutdown.is_set()
                      and isinstance(self.market, MarketData) and self.market.remote_capacity is True)
            status = self.market.capacity_relay.status() if active else None
            accepted = self.store.observe_relay_health(status, available=active, revision=revision)
            self.relay_health_error = None
            return accepted and active
        except Exception:
            self.relay_health_error = "副服务器状态提醒检查失败，等待重试"
            LOG.error("Relay health notification observation failed")
            return False

    def observe_position_imbalance(self, config):
        try:
            revision = self.store.monitoring_settings()["revision"]
            active = bool(config) and not self.demo and not self.shutdown.is_set()
            observations = position_observations.collect(self) if active else []
            accepted = self.store.observe_position_imbalance(observations, available=active,
                revision=revision, instance_id=self.position_observation_instance)
            self.position_imbalance_error = None
            return accepted and active
        except Exception:
            self.position_imbalance_error = "仓位不平衡提醒检查失败，等待重试"
            LOG.error("Position imbalance notification observation failed")
            return False

    def notify(self):
        if self.demo or self.shutdown.is_set():
            return 5
        configs = self.notification_configs()
        self.observe_relay_health(configs["event"])
        self.observe_position_imbalance(configs["event"])
        try:
            now = time.time()
            token = self.store.hourly_summary_due(available=bool(configs["scheduled"]), now=now)
            if token is not None:
                message = format_hourly_summary(self.state(), now)
                if not self.shutdown.is_set() and self.notification_config("scheduled") == configs["scheduled"]:
                    self.store.enqueue_hourly_summary(token, message)
            self.hourly_summary_error = None
        except Exception:
            self.hourly_summary_error = "定时摘要生成失败，等待重试"
            LOG.exception("Hourly summary generation failed")
        capacity_sent = 0
        available = {channel for channel, config in configs.items() if config is not None}
        for item in self.store.due_notifications(channels=available):
            if self.shutdown.is_set():
                break
            channel = notification_channels.for_item(item)
            try:
                config = self.notification_config(channel)
            except (monitor.MonitorError, OSError, ValueError, TypeError, KeyError):
                self.notification_channel_errors[channel] = "飞书配置无效"
                continue
            if not config or config != configs[channel]:
                continue
            if item.get("category") == "relay_health" and not self.observe_relay_health(config):
                continue
            if item.get("category") == "position_imbalance" and not self.observe_position_imbalance(config):
                continue
            # Re-read validity after preceding network calls and setting changes.
            item = self.store.notification_for_delivery(item["id"])
            if item is None:
                continue
            if item.get("capacity_key"):
                try:
                    capacity_policy = self.capacity_alert_config(config)
                    with self.lock:
                        self.capacity_notification_errors.pop("config", None)
                except (TradingError, ValueError, TypeError):
                    capacity_policy = None
                    with self.lock:
                        self.capacity_notification_errors["config"] = "额度提醒配置无效；成交汇总继续发送"
                symbol = item["capacity_key"].split(":")[1]
                market_policy = capacity_policy["markets"].get(symbol) if capacity_policy else None
                if market_policy is None or item.get("capacity_identity") != market_policy["identity"] or capacity_sent >= 2:
                    continue
                capacity_sent += 1
            try:
                monitor.send_feishu(config, item["message"])
                self.store.notification_result(item, True)
                self.notification_channel_errors[channel] = None
            except monitor.MonitorError:
                self.store.notification_result(item, False)
                self.notification_channel_errors[channel] = "飞书发送失败，等待重试"
        self.notification_error = next((error for error in self.notification_channel_errors.values() if error), None)
        return 5

    def state(self):
        # HTTP reads neither wait on the execution writer lock nor calculate history.
        state_now = time.time()
        channels = notification_channels.public_status({
            "scheduled": self.notification_channel_errors["scheduled"] or self.hourly_summary_error,
            "event": self.notification_channel_errors["event"] or self.relay_health_error or self.position_imbalance_error
                or self.margin_imbalance_error or next(iter(self.capacity_notification_errors.values()), None)})
        with self.store.read_snapshot() as reader:
            saved_accounts = reader.accounts()
            paired_states = self.pairs.states(reader)
            events = reader.events()
            pending_channels = reader.pending_notification_channels()
            pending_notifications = sum(pending_channels.values())
            for channel, count in pending_channels.items():
                channels[channel]["pending"] = count
            hourly_summary = reader.hourly_summary_status(
                available=not self.demo and channels["scheduled"]["configured"], now=state_now)
            listings = reader.get("usd1_listings") or {"initialized": False, "checked_at": None, "rows": {}}
            listings.update(enabled=self.listing_monitor is not None, poll_seconds=LISTING_POLL_SECONDS,
                            stale_seconds=LISTING_STALE_SECONDS, watched_symbols=reader.listing_watch_symbols())
            monitoring_state = self.monitoring_state(reader, saved_accounts)
            listings.update(monitoring_enabled=monitoring_state["settings"]["monitoring_enabled"],
                            discovery_enabled=monitoring_state["settings"]["discovery_enabled"])
            pending_records = {a["id"]: reader.intent(a["id"]) for a in saved_accounts}
            legacy_records = {a["id"]: reader.get("cycle:" + a["id"]) for a in saved_accounts}
            post_fill_checks = {a["id"]: reader.get("post_fill_check:" + a["id"]) for a in saved_accounts}
            deletion_blocks = {a["id"]: deletion_block(a, pending_records[a["id"]],
                post_fill_checks[a["id"]], legacy_records[a["id"]]) for a in saved_accounts}
        add_blocks = {a["id"]: ordinary_add_blocks(a) for a in saved_accounts}
        request_budget = self.market.api.budget.snapshot() if isinstance(self.market, MarketData) else None
        snapshot_schedules = self.scheduling(saved_accounts)
        with self.lock:
            accounts = [{**a, "risk_limits": {"base": a["policy"]["margin_limit"],
                                            "high_leverage": wire(opening_margin_limit(a["policy"], 10))},
                         **self.views.get(a["id"], {
                "status": "attention" if a.get("pause_reason") else "starting",
                "reason": a.get("pause_reason") or "等待读取账户", "credential_ready": False, "strategies": {}})} for a in saved_accounts]
            for account in accounts:
                account["deletion_block"] = deletion_blocks[account["id"]]
                owner = next((pair for pair in paired_states if account["id"] in
                              (pair["long_account_id"], pair["short_account_id"])), None)
                if owner:
                    direction = "long" if account["id"] == owner["long_account_id"] else "short"
                    account["pair_id"], account["pair_direction"] = owner["id"], direction.upper()
                    account["deletion_block"] = "账户由配对组管理，请先在配对组解除绑定"
                    pair_snapshot = owner["state"].get("snapshots", {}).get(direction)
                    if isinstance(pair_snapshot, dict):
                        account["snapshot"] = pair_snapshot
                    display_positions = owner["state"].get("display_positions", {}).get(direction)
                    if isinstance(display_positions, dict):
                        account["display_positions"] = display_positions
                # Display cadence only; this never extends a snapshot's
                # eight-second execution authority or starts an exchange read.
                interval = snapshot_schedules.get(account["id"], {}).get("interval", 5)
                account["snapshot_refresh"] = {"interval_seconds": interval}
                previous_display = self.display_snapshots.get(account["id"])
                if previous_display and previous_display["timestamp"] > (account.get("snapshot") or {}).get("timestamp", 0):
                    account["snapshot"] = previous_display
                if account["id"] in self.display_snapshots:
                    self.display_snapshots[account["id"]] = account["snapshot"]
                # This is selected-account policy, not a global market lock.
                # Recompute from saved configuration so an older view cannot
                # retain a block after the ordinary selection changes.
                account["ordinary_add_blocks"] = add_blocks[account["id"]]
            return json.loads(dumps({"demo": self.demo, "ready": self.ready, "error": self.error,
                "capacity_relay": (self.market.capacity_relay.status() if isinstance(self.market, MarketData)
                                   and self.market.remote_capacity is True else None),
                "accounts": accounts, "pairs": paired_states, "markets": self.markets, "listings": listings, "monitoring": monitoring_state, "events": events, "updated_at": time.time(), "request_budget": request_budget,
                "notification": {"configured": any(channel["configured"] for channel in channels.values()),
                                 "channels": channels, "routing_mode": notification_channels.routing_mode(),
                                 "enabled": monitoring_state["settings"]["feishu_enabled"], "pending": pending_notifications,
                                 "hourly_summary": hourly_summary,
                                 "error": self.notification_error or self.hourly_summary_error or self.relay_health_error or self.position_imbalance_error or self.margin_imbalance_error or next(iter(self.capacity_notification_errors.values()), None)}}))

    def poll_trading_rules(self):
        """One public rules attempt, isolated from the funds scheduler."""
        try:
            self.market.load_rules()
            if any(symbol not in self.market.rules for symbol in SYMBOLS):
                raise TradingError("缺少配置市场的交易规则")
            with self.lock:
                self.ready, self.error = True, None
            delay = 10
        except (TradingError, KeyError, ValueError, TypeError) as exc:
            with self.lock:
                self.error = str(exc) if isinstance(exc, TradingError) else "交易规则加载失败"
            delay = max(10, getattr(exc, "retry_after", 0))
        except Exception as exc:
            # Otherwise the status page keeps the startup "connecting" text and
            # an actual failure is indistinguishable from a slow connection.
            LOG.error("Trading rules load failed unexpectedly (%s)", type(exc).__name__)
            with self.lock:
                self.error = f"交易规则加载异常（{type(exc).__name__}），30 秒后重试"
            delay = 30
        # Preserve the completion-based deadline even if the scheduler consumes
        # this future on a later turn. This result applies to this attempt only.
        return delay, time.monotonic() + delay

    def run(self):
        from .margin_balance import MarginBalancer
        pending, due = {}, {}
        market_started, market_backoff = {}, {}
        adl_wake_jobs = set()
        account_ids, account_generation, accounts_due = [], -1, 0
        schedules, known_accounts, next_ordinary_start = {}, set(), 0
        saved_accounts, saved_pairs, pair_revisions = [], [], {}
        funds_pairs, funds_pairs_due, funds_generation = [], 0, -1
        # Account refresh and history never occupy an execution worker's slot.
        try:
            if isinstance(self.market, MarketData) and not self.shutdown.is_set():
                self.capacity_poll_schedule({})
                self.market.set_capacity_update_listener(lambda symbol, kind: self.scheduler_event.set())
                try:
                    self.market.start_stream()
                except Exception:
                    LOG.warning("Public quote stream unavailable; using REST quotes")
            with ThreadPoolExecutor(max_workers=MAX_ACCOUNTS // 2, thread_name_prefix="aster-pair") as pair_pool, \
                    ThreadPoolExecutor(max_workers=4 * MAX_ACCOUNTS + 4 * len(MARKET_SYMBOLS) + 1, thread_name_prefix="aster") as pool:
                try:
                    while not self.shutdown.is_set():
                        self.scheduler_event.clear()
                        for key, future in list(pending.items()):
                            if future.done():
                                failed = False
                                try:
                                    result = future.result()
                                    if key == "rules":
                                        delay, rules_deadline = result
                                    else:
                                        delay = result
                                except Exception:
                                    failed = True
                                    LOG.error("Worker failed; new work delayed (%s)", key)
                                    delay = 30
                                    if key.startswith("account:"):
                                        failed_aid = key.removeprefix("account:")
                                        with self.lock:
                                            self.work(failed_aid).backoff = time.monotonic() + delay
                                    elif key.startswith("private-stream:"):
                                        with self.lock:
                                            self.work(key.removeprefix("private-stream:")).stream_backoff = time.monotonic() + delay
                                aid = key.removeprefix("account:")
                                with self.lock:
                                    work = self.work(aid) if key.startswith("account:") else None
                                    urgent = bool(work and work.urgent)
                                    if work is not None:
                                        work.active_priority = False
                                        work.take_active_signals()
                                if key == "rules" and not failed:
                                    due[key] = max(time.monotonic(), rules_deadline)
                                elif (key.startswith("market:") and not failed and not isinstance(delay, PollBackoff)
                                      and delay <= max(CAPACITY_POLL_INTERVAL, self.capacity_interval(key.removeprefix("market:")))):
                                    # Successful sampling uses start times; failed
                                    # requests always retain completion-based backoff.
                                    delay = max(delay, self.capacity_interval(key.removeprefix("market:")))
                                    due[key] = max(time.monotonic(), market_started[key] + delay)
                                    market_backoff.pop(key, None)
                                else:
                                    if key.startswith("account:") and aid in schedules and not urgent:
                                        delay = max(delay, schedules[aid]["interval"])
                                    due[key] = time.monotonic() + delay
                                    if key.startswith("market:"):
                                        market_backoff[key] = due[key]
                                del pending[key]
                        if not self.ready:
                            # Funds are independent of public trading rules.
                            # Submit them before a bounded public rules request
                            # so a slow/failed market cannot stall their worker.
                            with self.lock:
                                generation = self.accounts_generation
                            if generation != funds_generation or time.monotonic() >= funds_pairs_due:
                                funds_pairs = self.store.pairs()
                                funds_generation = generation
                                funds_pairs_due = time.monotonic() + ACCOUNT_LIST_INTERVAL
                            for pair in funds_pairs:
                                journal = self.store.get("pair_margin:" + pair["id"], {})
                                if not (pair["margin"]["enabled"] or isinstance(journal, dict) and journal.get("pending")
                                        or MarginBalancer.unsettled_rejection(journal)):
                                    continue
                                key = "pair:" + pair["id"]
                                if key not in pending and time.monotonic() >= due.get(key, 0):
                                    pending[key] = pair_pool.submit(self.pairs.tick_margin, pair["id"])
                            if "rules" not in pending and time.monotonic() >= due.get("rules", 0):
                                pending["rules"] = pool.submit(self.poll_trading_rules)
                            if not self.ready:
                                # Startup failures still need local status reports.
                                # Market polling and trading jobs remain behind ready.
                                if (not self.shutdown.is_set() and "notify" not in pending
                                        and time.monotonic() >= due.get("notify", 0)):
                                    pending["notify"] = pool.submit(self.notify)
                                self.scheduler_event.wait(.1)
                                continue
                        with self.lock:
                            generation = self.accounts_generation
                        refresh_schedules = generation != account_generation or time.monotonic() >= accounts_due
                        if refresh_schedules:
                            saved_accounts = self.store.accounts()
                            saved_pairs = self.store.pairs()
                            current_pair_revisions = {pair["id"]: pair["revision"] for pair in saved_pairs}
                            for pair_id, revision in current_pair_revisions.items():
                                if pair_revisions.get(pair_id) != revision and "pair:" + pair_id not in pending:
                                    # A control change (especially pause) must
                                    # wake a group even during a long backoff.
                                    # Retain changes arriving during a worker
                                    # until its completion delay is installed.
                                    due["pair:" + pair_id] = 0
                                    pair_revisions[pair_id] = revision
                            pair_revisions = {pair_id: pair_revisions.get(pair_id) for pair_id in current_pair_revisions}
                            account_ids = [a["id"] for a in saved_accounts]
                            for aid in set(account_ids) - known_accounts:
                                if self.store.intent(aid) or self.store.get("post_fill_check:" + aid):
                                    with self.lock:
                                        self.work(aid).urgent = True
                            known_accounts = set(account_ids)
                            with self.lock:
                                for aid in set(self.account_work) - known_accounts:
                                    if "account:" + aid not in pending:
                                        self.account_work.pop(aid, None)
                            account_generation = generation
                            accounts_due = time.monotonic() + ACCOUNT_LIST_INTERVAL
                        targets = self.fast_capacity_targets(saved_accounts, saved_pairs)
                        capacity_symbols = self.capacity_market_symbols(saved_accounts)
                        intervals, brackets_interval, poll_enabled = self.capacity_poll_schedule(targets, capacity_symbols)
                        with self.lock:
                            old_targets = self.capacity_targets
                            old_intervals = self.capacity_intervals
                            self.capacity_targets, self.capacity_accounts = targets, saved_accounts
                            self.capacity_intervals = intervals
                            self.capacity_brackets_interval, self.capacity_poll_enabled = brackets_interval, poll_enabled
                        for symbol in MARKET_SYMBOLS:
                            if targets.get(symbol) != old_targets.get(symbol) or intervals[symbol] != old_intervals.get(symbol, CAPACITY_POLL_INTERVAL):
                                key = "market:" + symbol
                                interval = intervals[symbol]
                                due[key] = max(market_backoff.get(key, 0), market_started.get(key, 0) + interval)
                        if refresh_schedules or targets != old_targets or intervals != old_intervals:
                            schedules = self.scheduling(saved_accounts)
                        with self.lock:
                            for aid in tuple(self._adl_wakes):
                                adl_wake_jobs.add("adl:" + aid)
                                adl_wake_jobs.update("pair:" + pair["id"] for pair in saved_pairs
                                                    if aid in (pair["long_account_id"], pair["short_account_id"]))
                            self._adl_wakes.clear()
                            # Consume each task's signal independently; a slow
                            # history request cannot repeatedly wake its pair.
                            # Running tasks retain their signal until completion.
                            for key in adl_wake_jobs - pending.keys():
                                due[key] = 0
                                adl_wake_jobs.discard(key)
                            for aid, work in self.account_work.items():
                                key = "private-stream:" + aid
                                if work.stream_wake and key not in pending and time.monotonic() >= work.stream_backoff:
                                    due[key] = 0
                                    work.stream_wake = False
                                key = "account:" + aid
                                if work.wake and key not in pending:
                                    due[key] = 0
                                    work.wake = False
                            urgent_accounts = {aid for aid, work in self.account_work.items() if work.urgent}
                            priority_accounts = {aid for aid, work in self.account_work.items() if work.followup}
                            for aid, work in self.account_work.items():
                                if aid not in urgent_accounts and any(-1 <= time.time() - stamp <= 8
                                       and self.markets.get(symbol, {}).get("status") == "ok"
                                       for symbol, stamp in work.priority.items()):
                                    priority_accounts.add(aid)
                            ordinary_priority = set()
                            owners = {account["id"]: account for account in saved_accounts}
                            for aid in priority_accounts.copy():
                                work = self.work(aid)
                                owner = owners.get(aid)
                                if (not owner
                                        or aid in urgent_accounts or work.leverage_followup):
                                    continue
                                levels = {tier for symbol, stamp in work.priority.items()
                                          if -1 <= time.time() - stamp <= 8
                                          for tier in work.priority_levels.get(symbol, ())}
                                if (not levels.intersection(PRIORITY_TIERS)
                                        and (5 in levels or work.followup and work.ordinary_priority_retry)):
                                    ordinary_priority.add(aid)
                                    if time.monotonic() < work.ordinary_priority_after:
                                        priority_accounts.discard(aid)
                        monitored_symbols = self.monitored_market_symbols(saved_accounts)
                        # At most four disjoint pairs have their own four
                        # workers. Public polling/history cannot queue ahead of
                        # the funds-first pair turn, including cold startup.
                        jobs = {"pair:" + pair["id"]: (self.pairs.tick, pair["id"]) for pair in saved_pairs}
                        jobs.update({"market:" + s: (self.poll_market, s) for s in capacity_symbols})
                        if isinstance(self.market, MarketData):
                            jobs.update({"brackets:" + s: (self.poll_public_brackets, s) for s in capacity_symbols})
                        jobs.update({"book:" + s: (self.poll_book, s) for s in monitored_symbols})
                        jobs.update({"depth:" + s: (self.poll_depth, s) for s in monitored_symbols})
                        jobs["notify"] = (self.notify,)
                        if self.listing_monitor is not None:
                            jobs["listings"] = (self.listing_monitor.poll,)
                        live_ids = [a["id"] for a in saved_accounts if a["mode"] == "live"]
                        bound_ids = {pair[key] for pair in saved_pairs
                                     for key in ("long_account_id", "short_account_id")}
                        jobs.update({"adl:" + account["id"]: (self.poll_adl, account["id"])
                                     for account in saved_accounts if account["id"] in bound_ids
                                     and account["mode"] == "live" and self.live_allowed(account)})
                        jobs.update({"private-stream:" + aid: (self.poll_private_stream, aid) for aid in live_ids})
                        ordered_accounts = sorted(account_ids, key=lambda aid: (aid not in urgent_accounts,
                            aid not in priority_accounts))
                        jobs.update({"account:" + aid: (self.tick_account, aid) for aid in ordered_accounts})
                        for key, (function, *args) in jobs.items():
                            is_account = key.startswith("account:")
                            aid = key.removeprefix("account:")
                            priority = is_account and aid in priority_accounts
                            if key not in pending and (priority or time.monotonic() >= due.get(key, 0)):
                                if key.startswith("private-stream:"):
                                    with self.lock:
                                        if time.monotonic() < self.work(key.removeprefix("private-stream:")).stream_backoff:
                                            continue
                                if is_account:
                                    with self.lock:
                                        backoff = self.work(aid).backoff
                                        if time.monotonic() < backoff:
                                            continue
                                ordinary = is_account and aid in schedules and aid not in urgent_accounts and not priority
                                if ordinary and time.monotonic() < next_ordinary_start:
                                    continue
                                if priority:
                                    with self.lock:
                                        self.work(aid).ordinary_priority_retry = aid in ordinary_priority
                                        if aid in ordinary_priority:
                                            self.work(aid).ordinary_priority_after = time.monotonic() + schedules.get(aid, {}).get("interval", 10)
                                        self.work(aid).start_priority()
                                if key.startswith("market:"):
                                    market_started[key] = time.monotonic()
                                pending[key] = (pair_pool if key.startswith("pair:") else pool).submit(function, *args)
                                if ordinary or priority and aid in schedules and aid not in urgent_accounts:
                                    next_ordinary_start = max(next_ordinary_start, time.monotonic() + schedules[aid]["gap"])
                        self.scheduler_event.wait(.02 if targets else .1)
                finally:
                    # Fail health checks as soon as scheduling ends, before waiting
                    # for in-flight workers and closing their shared clients.
                    self.shutdown.set()
                    with self.lock:
                        self.ready, self.error = False, "交易调度已停止"
                        closing_ids = list(self.brokers)
                    for aid in closing_ids:
                        self.revoke_account_reads(aid, "交易调度已停止")
        except Exception:
            with self.lock:
                self.error = "交易调度异常停止，请检查服务后重启"
            LOG.error("Scheduler stopped unexpectedly")
        finally:
            self.shutdown.set()
            self.scheduler_event.set()
            with self.lock:
                self.ready = False
                brokers = list(self.brokers.items())
            # The pool context has joined all workers. One failing close must not
            # prevent the remaining clients from releasing their resources.
            for account_id, broker in brokers:
                try:
                    broker.close()
                except Exception:
                    LOG.error("Account client close failed (%s)", account_id)
            if isinstance(self.market, MarketData):
                try:
                    self.market.set_update_listener(None)
                    self.market.set_capacity_update_listener(None)
                    self.market.close_stream()
                except Exception:
                    LOG.error("Public quote stream close failed")
                try:
                    self.market.api.close()
                except Exception:
                    LOG.error("Market client close failed")

    def start(self):
        with self.lifecycle_lock:
            if self.thread is not None:
                raise TradingError("交易服务已经启动；请勿重复启动同一执行器")
            if self.shutdown.is_set():
                raise TradingError("交易服务正在停止或已停止，请重新创建执行器")
            self.process_lock.acquire()
            try:
                self.account_writer.initialize()
                self.thread = threading.Thread(target=self.run, name="aster-engine", daemon=True)
                self.thread.start()
            except BaseException:
                self.thread = None
                self.process_lock.release()
                raise

    def stop(self):
        with self.lifecycle_lock:
            self.shutdown.set()
            self.scheduler_event.set()
            with self.lock:
                closing_ids = list(self.brokers)
            for aid in closing_ids:
                self.revoke_account_reads(aid, "交易服务正在停止")
            if self.thread:
                self.thread.join(timeout=90)
            if not self.thread or not self.thread.is_alive():
                self.process_lock.release()
                self.account_writer.close()

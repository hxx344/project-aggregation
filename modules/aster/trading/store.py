"""Durable execution intents and notification outbox, isolated per account."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid

from .models import MARKET_SYMBOLS, MIN_OPEN_LEVERAGE, SYMBOLS, TIERS, TradingError, dec, positive
from . import hourly_notifications, listing_alerts, margin_imbalance_notifications, monitoring, notification_channels, relay_health_notifications, position_imbalance_notifications, position_observations
from .pair_legacy import without_cycle, rollback_cycle
from .account_deletion import deletion_block
from .capacity_timing import capacity_timing_text
from .identifiers import account_identifier
from .account_legacy import (without_removed_config, legacy_enabled, legacy_intent, legacy_position,
                             LEGACY_CONFIG_REASON, LEGACY_PENDING_REASON, REMOVED_CONFIG_KEYS)


CAPACITY_ALERT_MAX_AGE = 8
CAPACITY_ALERT_KEYS = frozenset(f"capacity_alert:{symbol}:{tier}" for symbol in MARKET_SYMBOLS for tier in TIERS)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def _cycle_check_metadata(raw):
    """Unreadable historical metadata is a boundary, never a reason to lose an event."""
    try:
        value = json.loads(raw)
        required = {"symbol", "phase", "count", "first_at", "last_at"}
        if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"diagnostic"}:
            return None
        if value["symbol"] not in SYMBOLS or value["phase"] not in ("open", "close"):
            return None
        if type(value["count"]) is not int or value["count"] < 1:
            return None
        if any(type(value[key]) not in (int, float) or not math.isfinite(value[key]) or not 0 <= value[key] <= 253402300799
               for key in ("first_at", "last_at")) or value["first_at"] > value["last_at"]:
            return None
        if "diagnostic" in value:
            diagnostic = value["diagnostic"]
            if not isinstance(diagnostic, dict) or diagnostic.get("symbol", value["symbol"]) != value["symbol"] \
                    or diagnostic.get("phase", value["phase"]) != value["phase"]:
                return None
        # json.loads accepts non-finite literals by default; these must not leak
        # through the API or make an invalid record eligible for aggregation.
        json.dumps(value, allow_nan=False)
        return value
    except (TypeError, ValueError, OverflowError, RecursionError):
        return None


class Store:
    def __init__(self, path, *, demo=None):
        # All aliases of one database must share its process lock and WAL files.
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._connection_local = threading.local()
        with self.connect() as db:
            # Decide HTTP exposure before touching historical schema or state.
            # Keep the claim and migrations in one rollback-capable transaction;
            # executescript would implicitly commit the claim before migrating.
            db.execute("BEGIN IMMEDIATE")
            if demo is not None:
                self._bind_runtime_mode(db, demo=demo)
            schema = """
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS deleted_accounts (
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, deleted_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pairs (
                    id TEXT PRIMARY KEY, data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pair_members (
                    account_id TEXT PRIMARY KEY, pair_id TEXT NOT NULL,
                    direction TEXT NOT NULL CHECK(direction IN ('LONG','SHORT')),
                    UNIQUE(pair_id,direction)
                );
                CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS intents (
                    id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
                    status TEXT NOT NULL, data TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_active_intent
                    ON intents(account_id) WHERE status NOT IN ('complete','aborted');
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
                    kind TEXT NOT NULL, message TEXT NOT NULL, created_at REAL NOT NULL,
                    cycle_check TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id,id);
                CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC,id DESC);
                CREATE INDEX IF NOT EXISTS idx_events_account_created ON events(account_id,created_at DESC,id DESC);
                CREATE TABLE IF NOT EXISTS outbox (
                    id TEXT PRIMARY KEY, message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    due_at REAL NOT NULL, delivered_at REAL, expires_at REAL, capacity_key TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(due_at) WHERE delivered_at IS NULL;
            """
            for statement in schema.split(";"):
                if statement.strip():
                    db.execute(statement)
            position_observations.initialize(db)
            # Existing trade notifications keep NULL expiry and remain deliverable.
            columns = {row[1] for row in db.execute("PRAGMA table_info(outbox)")}
            for name, kind in (("expires_at", "REAL"), ("capacity_key", "TEXT"), ("category", "TEXT"), ("symbols", "TEXT")):
                if name not in columns:
                    db.execute(f"ALTER TABLE outbox ADD COLUMN {name} {kind}")
            db.execute("CREATE INDEX IF NOT EXISTS idx_outbox_category_pending ON outbox(category,expires_at) WHERE delivered_at IS NULL")
            monitoring.initialize(db)
            event_columns = {row[1] for row in db.execute("PRAGMA table_info(events)")}
            if "cycle_check" not in event_columns:
                db.execute("ALTER TABLE events ADD COLUMN cycle_check TEXT")
            for row in db.execute("SELECT id,data FROM accounts").fetchall():
                account = json.loads(row["data"])
                normalized = self.account_defaults(account)
                if normalized != account:
                    db.execute("UPDATE accounts SET data=? WHERE id=?", (dumps({**account, **normalized}), row["id"]))
            placeholders = ",".join("?" for _ in CAPACITY_ALERT_KEYS)
            db.execute(f"""UPDATE outbox SET expires_at=0 WHERE delivered_at IS NULL
                AND capacity_key IS NOT NULL AND capacity_key NOT IN ({placeholders})""", tuple(CAPACITY_ALERT_KEYS))
        # WAL cannot be enabled inside the initialization transaction. A rejected
        # mode or failed migration never reaches these database-level changes.
        with self.connect() as db:
            # A competing initializer can hold a lock after our claim commits.
            # journal_mode may return BUSY immediately despite busy_timeout, so
            # bound this transition itself to the same ten-second wait budget.
            deadline = time.monotonic() + 10
            db.execute("PRAGMA busy_timeout=0")
            while True:
                try:
                    mode = db.execute("PRAGMA journal_mode=WAL").fetchone()
                    if not mode or mode[0] != "wal":
                        raise sqlite3.OperationalError("无法启用 SQLite WAL 日志模式")
                    break
                except sqlite3.OperationalError as exc:
                    code = getattr(exc, "sqlite_errorcode", None)
                    # SQLite primary BUSY/LOCKED are 5/6; extended codes keep
                    # their primary code in the low byte. Python 3.10 has no
                    # sqlite_errorcode, so accept only its exact lock messages.
                    locked = (code & 255) in (5, 6) if type(code) is int else code is None and str(exc) in (
                        "database is locked", "database table is locked")
                    remaining = deadline - time.monotonic()
                    if not locked or remaining <= 0:
                        raise
                    time.sleep(min(0.05, remaining))
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("PRAGMA optimize")

    @contextmanager
    def connection_scope(self):
        """Reuse a thread's handle, never its transactions or the writer lock."""
        if getattr(self._connection_local, "scoped", False):
            yield
            return
        self._connection_local.scoped = True
        try:
            yield
        finally:
            db = getattr(self._connection_local, "db", None)
            self._connection_local.db = None
            self._connection_local.scoped = False
            if db is not None:
                db.close()

    @contextmanager
    def connect(self):
        with self.lock:
            db = getattr(self._connection_local, "db", None)
            scoped = getattr(self._connection_local, "scoped", False)
            if db is None:
                db = sqlite3.connect(self.path, timeout=10)
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA synchronous=FULL")
                if scoped:
                    self._connection_local.db = db
            try:
                with db:
                    yield db
                    writer = getattr(self, "account_writer", None)
                    if writer is not None and db.in_transaction:
                        writer.assert_current()
            finally:
                if not scoped:
                    db.close()

    @contextmanager
    def capacity_alert_batch(self):
        """Commit a symbol's independent notification gates together."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            yield _StoreSnapshot(self, db)

    @contextmanager
    def read_snapshot(self):
        """Dashboard reads use a consistent WAL snapshot, outside the writer lock.

        SQLite enforces read-only access even if a caller accidentally invokes a
        mutating Store method. This connection never migrates or creates a DB.
        """
        db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=.25)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            reader = _StoreSnapshot(self, db)
            yield reader
        finally:
            db.close()

    def bind_runtime_mode(self, *, demo):
        """Bind HTTP exposure before an Engine can seed or publish account data."""
        with self.connect() as db:
            # Different Store objects/processes must not claim an empty ledger
            # with different exposure modes between the check and the write.
            db.execute("BEGIN IMMEDIATE")
            self._bind_runtime_mode(db, demo=demo)

    @staticmethod
    def _bind_runtime_mode(db, *, demo):
        if type(demo) is not bool:
            raise TradingError("账本运行用途无效")
        mode = "demo" if demo else "authenticated"
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                  if not row["name"].startswith("sqlite_")}
        row = db.execute("SELECT data FROM kv WHERE key='runtime_mode'").fetchone() if "kv" in tables else None
        if row is not None:
            try:
                saved = json.loads(row["data"])
            except (TypeError, ValueError):
                raise TradingError("账本用途标记无效，拒绝启动") from None
            if saved not in ("demo", "authenticated"):
                raise TradingError("账本用途标记无效，拒绝启动")
            if saved != mode:
                raise TradingError("账本用途与启动模式不符；演示与正式服务必须使用独立的数据目录")
            return
        if demo:
            expected = {"accounts", "deleted_accounts", "kv", "intents", "events", "outbox", "cycle_fills",
                        "cycle_volume_days", "cycle_symbol_volume_days", "cycle_volume_sync", "cycle_fill_versions",
                        "pairs", "pair_members", "cycle_quality_history", "pair_cost_revision", "pair_cost_changes"}
            # New databases may have no tables yet. Historical paper data and
            # unknown tables must never be claimed by the anonymous interface.
            if tables - expected or any(not Store._demo_claimable(db, table) for table in sorted(tables)):
                raise TradingError("演示模式不能使用用途未确认的已有账本；请指定新的空数据目录，原数据保留")
        db.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.execute("INSERT INTO kv(key,data) VALUES ('runtime_mode',?)", (dumps(mode),))

    @staticmethod
    def _demo_claimable(db, table):
        rows = db.execute(f"SELECT * FROM {table} LIMIT 2").fetchall()
        if table != "kv" or not rows:
            return not rows
        # Initializing a new ledger seeds the default monitoring settings; only
        # that exact untouched default leaves the ledger claimable as empty.
        if len(rows) != 1 or rows[0]["key"] != monitoring.KEY:
            return False
        try:
            return json.loads(rows[0]["data"]) == json.loads(json.dumps(monitoring.migrate_v1_to_v2({})))
        except (TypeError, ValueError):
            return False

    @staticmethod
    def account_defaults(account):
        normalized = without_removed_config(account)
        if legacy_enabled(account):
            normalized.update(enabled=False, pause_reason=LEGACY_CONFIG_REASON)
        policy = account.get("policy")
        if isinstance(policy, dict):
            policy = {"ordinary_symbol": "all", **policy}
            normalized["policy"] = policy
            previous = policy.get("min_open_leverage", MIN_OPEN_LEVERAGE)
            if type(previous) is int and 1 <= previous <= 125:
                minimum = next((tier for tier in TIERS if tier >= previous), TIERS[-1])
                normalized["policy"] = {**policy, "min_open_leverage": minimum}
                if previous > TIERS[-1]:
                    normalized.update(enabled=False, pause_reason="原最低开仓杠杆超出支持范围，已暂停；请在 5x、10x、20x 中确认设置后启动")
                    normalized["leverage_setting_required"] = True
        return normalized

    def accounts(self):
        with self.connect() as db:
            return [self.account_defaults(json.loads(r[0])) for r in db.execute("SELECT data FROM accounts ORDER BY id")]

    def account(self, account_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM accounts WHERE id=?", (account_id,)).fetchone()
            return self.account_defaults(json.loads(row[0])) if row else None

    @staticmethod
    def _keep_removed(raw, account):
        """Automatic writes keep removed settings so a rolled-back release still finds them."""
        if not isinstance(raw, dict):
            return account
        return {**account, **{key: raw[key] for key in REMOVED_CONFIG_KEYS if key in raw}}

    def save_account(self, account, *, user_control=False, discard_removed=False):
        account = self.account_defaults(account)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM deleted_accounts WHERE id=?", (account["id"],)).fetchone():
                raise TradingError("该账户标识已有删除记录，请使用新的账户标识")
            if account.get("enabled") and db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (account["id"],)).fetchone():
                raise TradingError("配对组成员不能启用单账户策略")
            row = None if discard_removed else db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
            stored = self._keep_removed(json.loads(row[0]), account) if row else account
            db.execute("INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (account["id"], dumps(stored)))
            if user_control:
                db.execute("DELETE FROM kv WHERE key=?", ("recovery_auto_pause:" + account["id"],))

    def pairs(self):
        with self.connect() as db:
            return [without_cycle(json.loads(row[0])) for row in db.execute("SELECT data FROM pairs ORDER BY id")]

    def pair(self, pair_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM pairs WHERE id=?", (pair_id,)).fetchone()
            return without_cycle(json.loads(row[0])) if row else None

    def pair_for_account(self, account_id):
        with self.connect() as db:
            row = db.execute("SELECT p.data FROM pairs p JOIN pair_members m ON p.id=m.pair_id WHERE m.account_id=?",
                             (account_id,)).fetchone()
            return without_cycle(json.loads(row[0])) if row else None

    def save_pair(self, pair, *, create=False):
        """Reserve both members in one durable transaction, across Store instances."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return self._save_pair(db, pair, create=create)

    def switch_pair_symbol(self, pair, runtime, *, expected_pair, expected_runtime,
                           expected_margin, accounts, check_current):
        """Atomically adopt a verified target symbol, retaining its old journal."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
            if (not row or without_cycle(json.loads(row[0])) != expected_pair
                    or expected_pair.get("enabled") is not False or pair.get("enabled") is not False
                    or pair.get("symbol") == expected_pair.get("symbol")):
                raise TradingError("切换标的期间配对组状态已变化，请重新核对")
            for key, expected in (("pair_runtime:" + pair["id"], expected_runtime),
                                  ("pair_margin:" + pair["id"], expected_margin)):
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                if (json.loads(row[0]) if row else {}) != expected:
                    raise TradingError("切换标的期间订单或划转记录已变化，请重新核对")
            for account in accounts:
                row = db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
                binding = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (account["id"],)).fetchone()
                side = "LONG" if account["id"] == expected_pair["long_account_id"] else "SHORT"
                if not row or self.account_defaults(json.loads(row[0])) != account or not binding or tuple(binding) != (pair["id"], side):
                    raise TradingError("切换标的期间子账户配置或绑定已变化，请重新核对")
                for prefix in ("post_fill_check:", "cycle:"):
                    row = db.execute("SELECT data FROM kv WHERE key=?", (prefix + account["id"],)).fetchone()
                    legacy = json.loads(row[0]) if row else {}
                    if (prefix == "post_fill_check:" and legacy) or (prefix == "cycle:" and legacy_position(legacy)):
                        raise TradingError("切换标的期间子账户出现未完成批次，请重新核对")
            # The database writer may have waited beyond the snapshot deadline.
            # Recheck identity and revocable read authority under that same lock.
            check_current()
            saved = self._save_pair(db, pair, allow_symbol_change=True)
            archive = {"pair": expected_pair, "runtime": expected_runtime,
                       "new_symbol": saved["symbol"], "changed_at": time.time()}
            db.execute("INSERT INTO kv(key,data) VALUES(?,?)", (
                f"pair_symbol_change:{pair['id']}:{saved['revision']}", dumps(archive)))
            db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("pair_runtime:" + pair["id"], dumps(runtime)))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                       (pair["id"], "pair", runtime["reason"] + "；本次切换未下单、撤单、调杠杆或划转", time.time()))
            return saved

    def activate_pair(self, pair, runtime, *, expected_runtime, expected_margin, accounts, check_current, message):
        """Commit an explicitly paused start and its verified baseline together."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
            if not row or json.loads(row[0]).get("enabled") is not False or pair.get("enabled") is not True:
                raise TradingError("配对组已变化，仅暂停状态可以重新核验并启动")
            for key, expected in (("pair_runtime:" + pair["id"], expected_runtime),
                                  ("pair_margin:" + pair["id"], expected_margin)):
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                if (json.loads(row[0]) if row else {}) != expected:
                    raise TradingError("启动核验期间运行或划转记录已变化，请重新核对")
            for account in accounts:
                row = db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
                if not row or self.account_defaults(json.loads(row[0])) != account:
                    raise TradingError("启动核验期间子账户配置已变化，请重新核对")
            # Acquiring the database writer lock may itself outlive the reads.
            # The caller holds both generation locks until this commit finishes.
            check_current()
            saved = self._save_pair(db, pair)
            db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("pair_runtime:" + pair["id"], dumps(runtime)))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                       (pair["id"], "pair", message, time.time()))
            return saved

    def commit_pair_recovery(self, pair, runtime, *, expected_runtime, expected_margin,
                             accounts, check_current, message, audit=None, batch=None):
        """A reviewed local recovery is atomic with its unchanged paused ownership."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
            if not row or without_cycle(json.loads(row[0])) != pair or pair.get("enabled") is not False:
                raise TradingError("核对期间配对组状态已变化，请重新核对")
            for key, expected in (("pair_runtime:" + pair["id"], expected_runtime),
                                  ("pair_margin:" + pair["id"], expected_margin)):
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                if (json.loads(row[0]) if row else {}) != expected:
                    raise TradingError("核对期间订单或划转记录已变化，请重新核对")
            for account in accounts:
                row = db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
                binding = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (account["id"],)).fetchone()
                side = "LONG" if account["id"] == pair["long_account_id"] else "SHORT"
                if not row or self.account_defaults(json.loads(row[0])) != account or not binding or tuple(binding) != (pair["id"], side):
                    raise TradingError("核对期间子账户配置或绑定已变化，请重新核对")
            check_current()
            self._save_pair(db, pair)
            if audit is not None:
                db.execute("INSERT INTO kv(key,data) VALUES (?,?)", (
                    "pair_order_recovery:" + pair["id"] + ":" + audit["pending"]["id"], dumps(audit)))
            if batch is not None:
                db.execute("INSERT INTO kv(key,data) VALUES (?,?)", ("pair_batch:" + batch["id"], dumps(batch)))
            db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("pair_runtime:" + pair["id"], dumps(runtime)))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                       (pair["id"], "pair", message + "；本次核对未下单或划转", time.time()))

    def _save_pair(self, db, pair, *, create=False, allow_symbol_change=False):
        row = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
        if create and row:
            raise TradingError("配对组标识已使用")
        if not create and not row:
            raise TradingError("配对组不存在")
        previous = json.loads(row[0]) if row else None
        if previous and pair.get("revision") != previous.get("revision"):
            raise TradingError("配对组配置已变化，请刷新后重试")
        if previous and any(previous[key] != pair[key] for key in ("long_account_id", "short_account_id")):
            raise TradingError("配对组账户及方向不可变更")
        if previous and previous.get("margin", {}).get("master_env_prefix") != pair.get("margin", {}).get("master_env_prefix"):
            from .margin_balance import MarginBalancer
            margin_row = db.execute("SELECT data FROM kv WHERE key=?", ("pair_margin:" + pair["id"],)).fetchone()
            if MarginBalancer.unsettled_rejection(json.loads(margin_row[0]) if margin_row else {}):
                raise TradingError("划转拒绝回执尚未完成共享结算，不能更换原主账户配置")
        if previous and previous["symbol"] != pair["symbol"] and not allow_symbol_change:
            raise TradingError("交易标的只能通过暂停后的空仓核验切换")
        members = [(pair["long_account_id"], "LONG"), (pair["short_account_id"], "SHORT")]
        if members[0][0] == members[1][0]:
            raise TradingError("配对组需要两个不同账户")
        for aid, direction in members:
            saved = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
            if saved is None or json.loads(saved[0]).get("enabled"):
                raise TradingError("配对组成员必须存在且已暂停单账户策略")
            existing = db.execute("SELECT pair_id FROM pair_members WHERE account_id=?", (aid,)).fetchone()
            if existing and existing[0] != pair["id"]:
                raise TradingError("账户已属于其他配对组")
            if db.execute("SELECT 1 FROM intents WHERE account_id=? AND status NOT IN ('complete','aborted')", (aid,)).fetchone():
                raise TradingError("账户旧批次尚未完成，请先核对")
        revision = (previous or {}).get("revision", 0) + 1
        saved_pair = {**without_cycle(pair), "revision": revision}
        # The previous release rejects ordinary and cycle together only when validating input.
        disable = bool(pair.get("enabled") or (pair.get("ordinary") or {}).get("enabled")) or allow_symbol_change
        cycle = rollback_cycle(previous, pair, disable=disable)
        db.execute("INSERT INTO pairs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                   (pair["id"], dumps({**saved_pair, "cycle": cycle})))
        for aid, direction in members:
            db.execute("INSERT INTO pair_members VALUES (?,?,?) ON CONFLICT(account_id) DO NOTHING",
                       (aid, pair["id"], direction))
        return saved_pair

    def delete_pair(self, pair_id, *, expected_pair=None, expected_runtime=None, expected_margin=None,
                    accounts=None, check_current=None, watch_evidence=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM pairs WHERE id=?", (pair_id,)).fetchone()
            if row is None:
                raise TradingError("配对组不存在")
            pair = without_cycle(json.loads(row[0]))
            if pair.get("enabled"):
                raise TradingError("请先暂停配对组")
            runtime_row = db.execute("SELECT data FROM kv WHERE key=?", ("pair_runtime:" + pair_id,)).fetchone()
            runtime = json.loads(runtime_row[0]) if runtime_row else {}
            if runtime.get("recovery_watch") is not None and (
                    expected_pair is None or expected_runtime is None or expected_margin is None
                    or accounts is None or check_current is None or watch_evidence is None):
                raise TradingError("人工归档订单仍需跟踪，不能解除子账户绑定；请保留此配对组")
            if runtime.get("pending"):
                raise TradingError("配对组仍有未完成批次")
            if any(dec(qty) for qty in (runtime.get("owned") or {}).values()) or any(
                    dec(qty) for qty in (runtime.get("progress") or {}).get("quantities", {}).values()):
                raise TradingError("配对组仍有记录持仓")
            margin_row = db.execute("SELECT data FROM kv WHERE key=?", ("pair_margin:" + pair_id,)).fetchone()
            margin = json.loads(margin_row[0]) if margin_row else {}
            from .margin_balance import MarginBalancer
            if margin.get("pending") or margin.get("status") in ("submitting", "acknowledged", "accepted", "unknown") or MarginBalancer.unsettled_rejection(margin):
                raise TradingError("保证金划转结果尚未核实")
            if expected_pair is not None:
                if pair != expected_pair or runtime != expected_runtime or margin != expected_margin:
                    raise TradingError("解除绑定期间配置、订单或划转记录已变化，请重新核对")
                for account in accounts:
                    row = db.execute("SELECT data FROM accounts WHERE id=?", (account["id"],)).fetchone()
                    binding = db.execute("SELECT pair_id,direction FROM pair_members WHERE account_id=?", (account["id"],)).fetchone()
                    side = "LONG" if account["id"] == pair["long_account_id"] else "SHORT"
                    if not row or self.account_defaults(json.loads(row[0])) != account or not binding or tuple(binding) != (pair_id, side):
                        raise TradingError("解除绑定期间子账户配置或归属已变化，请重新核对")
                if watch_evidence is not None:
                    prefix = "pair_watch_evidence:" + pair_id + ":"
                    saved_evidence = {row[0]: json.loads(row[1]) for row in db.execute(
                        "SELECT key,data FROM kv WHERE substr(key,1,?)=?", (len(prefix), prefix))}
                    if saved_evidence != watch_evidence:
                        raise TradingError("解除绑定期间历史观察证据已变化，请重新核对")
                check_current()
            deleted_at = time.time()
            if runtime.get("recovery_watch") is not None:
                archive = {"watch": runtime["recovery_watch"], "evidence": watch_evidence,
                           "identities": runtime.get("identities"), "flat_verified_at": deleted_at}
                db.execute("INSERT INTO kv VALUES (?,?)", ("pair_deleted_watch:" + pair_id, dumps(archive)))
                runtime.pop("recovery_watch")
                db.execute("UPDATE kv SET data=? WHERE key=?", (dumps(runtime), "pair_runtime:" + pair_id))
            db.execute("DELETE FROM pair_members WHERE pair_id=?", (pair_id,))
            db.execute("DELETE FROM pairs WHERE id=?", (pair_id,))
            db.execute("DELETE FROM kv WHERE key=?", ("pair_margin_control:" + pair_id,))
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("pair_deleted:" + pair_id, dumps({"deleted_at": deleted_at})))

    def account_id_used(self, account_id):
        with self.connect() as db:
            return db.execute("SELECT 1 FROM accounts WHERE id=? UNION ALL SELECT 1 FROM deleted_accounts WHERE id=?",
                              (account_id, account_id)).fetchone() is not None

    def delete_account(self, account_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (account_id,)).fetchone():
                raise TradingError("账户属于配对组，请先在配对组解除绑定")
            reader = _StoreSnapshot(self, db)
            account = reader.account(account_id)
            if account is None:
                if db.execute("SELECT 1 FROM deleted_accounts WHERE id=?", (account_id,)).fetchone():
                    return  # Retrying an acknowledged or timed-out deletion is safe.
                raise TradingError("账户不存在")
            reason = deletion_block(account, reader.intent(account_id), reader.get("post_fill_check:" + account_id),
                                    reader.get("cycle:" + account_id))
            if reason:
                raise TradingError(reason)
            now = time.time()
            db.execute("INSERT INTO deleted_accounts VALUES (?,?,?)", (account_id, dumps(account), now))
            db.execute("DELETE FROM accounts WHERE id=?", (account_id,))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)",
                       (account_id, "config", "账户已从工作台删除，历史记录保留", now))

    def pause_account(self, account, reason):
        account.update(enabled=False, pause_reason=reason)
        # A risk/user pause supersedes any older automatic recovery pause.
        self.save_account(account, user_control=True)

    def pause_intent(self, account, intent, reason):
        """Only this intent's own automatic pause may later be resumed."""
        aid = account["id"]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
            raw_account = json.loads(row[0]) if row else None
            current = self.account_defaults(raw_account) if row else None
            if current is None:
                raise TradingError("批次暂停期间账户已不存在")
            same_account = current == self.account_defaults(account)
            saved = db.execute("SELECT status FROM intents WHERE id=? AND account_id=?", (intent["id"], aid)).fetchone()
            if not saved or saved[0] in ("complete", "aborted"):
                raise TradingError("批次已经结束，不能重新暂停账户")
            key = "recovery_auto_pause:" + aid
            row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
            marker = json.loads(row[0]) if row else None
            paused = {**current, "enabled": False, "pause_reason": reason}
            if same_account and (current.get("enabled") or (isinstance(marker, dict) and marker.get("intent_id") == intent["id"]
                                          and without_removed_config(marker.get("paused_account") or {}) == current)):
                marker = {"intent_id": intent["id"], "paused_account": paused,
                          "paused_at": (marker or {}).get("paused_at", time.time())}
                db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(marker)))
            else:
                db.execute("DELETE FROM kv WHERE key=?", (key,))
            db.execute("UPDATE accounts SET data=? WHERE id=?", (dumps(self._keep_removed(raw_account, paused)), aid))
            db.execute("UPDATE intents SET status=?,data=? WHERE id=?", (intent["status"], dumps(intent), intent["id"]))
        account.clear()
        account.update(paused)

    def _resume_intent_pause(self, db, intent):
        """Release only the exact automatic pause owned by this terminal intent."""
        aid, key = intent["account_id"], "recovery_auto_pause:" + intent["account_id"]
        row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
        marker = json.loads(row[0]) if row else None
        if not isinstance(marker, dict) or marker.get("intent_id") != intent["id"]:
            return False
        row = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
        raw_account = json.loads(row[0]) if row else None
        current = self.account_defaults(raw_account) if row else None
        terminal = db.execute("SELECT status FROM intents WHERE id=? AND account_id=?", (intent["id"], aid)).fetchone()
        resumed = bool(current and terminal and terminal[0] in ("complete", "aborted")
            and without_removed_config(marker.get("paused_account") or {}) == current and not current.get("enabled")
            and not db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (aid,)).fetchone()
            and not db.execute("SELECT 1 FROM intents WHERE account_id=? AND status NOT IN ('complete','aborted')", (aid,)).fetchone())
        if resumed:
            current["enabled"] = True
            current.pop("pause_reason", None)
            db.execute("UPDATE accounts SET data=? WHERE id=?", (dumps(self._keep_removed(raw_account, current)), aid))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                       (aid, "recovery", "旧批次已正常核对完成，解除该批次自动暂停并恢复原策略运行", time.time()))
        db.execute("DELETE FROM kv WHERE key=?", (key,))
        return resumed

    def archive_recovered_intent(self, intent, account, *, expected_state, replacements,
                                 check_current, resolution, cooldown=None):
        """Atomically retire unknown execution without fabricating a receipt."""
        aid, now = account["id"], time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
            raw_account = json.loads(row[0]) if row else None
            if not row or self.account_defaults(raw_account) != account:
                raise TradingError("恢复核验期间账户配置已变化")
            rows = db.execute("SELECT id,data FROM intents WHERE account_id=? AND status NOT IN ('complete','aborted')", (aid,)).fetchall()
            if len(rows) != 1 or rows[0][0] != intent["id"] or json.loads(rows[0][1]) != intent:
                raise TradingError("恢复核验期间批次记录已变化")
            if db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (aid,)).fetchone():
                raise TradingError("恢复核验期间账户已绑定配对组")
            for key, expected in expected_state.items():
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                if (json.loads(row[0]) if row else None) != expected:
                    raise TradingError("恢复核验期间持仓或暂停记录已变化")
            # The callback uses captured broker evidence only, never Store reads.
            check_current()
            completed = {**intent, "status": "aborted", "completed_at": now,
                         "resolution": {**resolution, "previous_status": intent["status"]}}
            marker = expected_state.get("recovery_auto_pause:" + aid)
            resumed = (isinstance(marker, dict) and marker.get("intent_id") == intent["id"]
                       and without_removed_config(marker.get("paused_account") or {}) == account)
            updated_account = dict(account)
            if resumed:
                updated_account["enabled"] = True
                updated_account.pop("pause_reason", None)
                db.execute("UPDATE accounts SET data=? WHERE id=?", (dumps(self._keep_removed(raw_account, updated_account)), aid))
            db.execute("DELETE FROM kv WHERE key=?", ("recovery_auto_pause:" + aid,))
            db.execute("UPDATE intents SET status='aborted',data=? WHERE id=?", (dumps(completed), intent["id"]))
            quantities = resolution.get("known_quantities")
            if (intent.get("kind") == "pair" and resolution.get("execution_result_unknown") is False
                    and quantities and any(dec(quantities[key]) for key in ("long_qty", "short_qty"))):
                key = "campaign:" + aid
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                campaign = json.loads(row[0]) if row else {"id": intent["id"], "batches": [], "started_at": now}
                campaign["batches"].append({"symbol": intent["symbol"], "quantities": quantities, "leverage": intent["leverage"]})
                campaign["last_fill_at"] = now
                db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(campaign)))
            for key, value in replacements.items():
                if value is None:
                    db.execute("DELETE FROM kv WHERE key=?", (key,))
                else:
                    db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(value)))
            if cooldown is not None:
                db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                           (f"recovery_leverage_cooldown:{aid}:{intent['symbol']}", dumps(cooldown)))
            audit = {"intent": intent, "previous_state": expected_state, "resolution": completed["resolution"],
                     "resumed": resumed, "next_state": replacements}
            db.execute("INSERT INTO kv VALUES (?,?)", (f"intent_recovery:{aid}:{intent['id']}", dumps(audit)))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES(?,?,?,?)",
                       (aid, "recovery", resolution["reason"] + ("；恢复原策略运行" if resumed else "；保留当前账户运行开关"), now))
        return completed, updated_account

    def get(self, key, default=None):
        with self.connect() as db:
            row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.connect() as db:
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(value)))

    def intent(self, account_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM intents WHERE account_id=? AND status NOT IN ('complete','aborted')", (account_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def monitoring_settings(self):
        with self.connect() as db:
            return monitoring.read(db)

    def edit_monitoring(self, changes, *, symbol=None):
        fields = monitoring.SYMBOL_FIELDS if symbol is not None else monitoring.GLOBAL_FIELDS
        monitoring.validate_edit(changes, fields)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            state = listing_alerts.read(db, "usd1_listings", {})
            config = monitoring.register_symbols(db, set(MARKET_SYMBOLS) | set(state.get("rows", {})))
            previous = deepcopy(config)
            previous_watch = desired_watch = False
            if symbol is not None:
                monitoring.validate_symbol(db, symbol)
                previous_watch = listing_alerts.read(db, listing_alerts.WATCH_PREFIX + symbol, {}).get("enabled", False)
                effective_changes = {key: value for key, value in changes.items()
                                     if key not in ("alerts", "max_capacity_alert") or value !=
                                     (previous_watch if key == "max_capacity_alert" else config["symbols"][symbol][key])}
                desired_watch = monitoring.edit_symbol(config, symbol, effective_changes, previous_watch)
            else:
                monitoring.edit_global(config, {key: value for key, value in changes.items() if config[key] != value},
                                       set(listing_alerts.selected_symbols(db)))
            if config == previous and previous_watch == desired_watch:
                return config
            config["revision"] += 1
            monitoring.write(db, config)
            if previous_watch != desired_watch:
                listing_alerts.set_watch(db, symbol, desired_watch, time.time())
            elif symbol is not None and not listing_alerts.same_rule(
                    listing_alerts.rule(previous, symbol), listing_alerts.rule(config, symbol)):
                listing_alerts.refresh_rule(db, symbol, time.time())
            monitoring.cancel_disabled(db, config)
            if any(previous[key] != config[key] for key in
                   ("feishu_enabled", "hourly_summary_alerts", "hourly_summary_interval_minutes")):
                hourly_notifications.reset(db, time.time(), monitoring.allowed(config, "hourly_summary", []))
            if any(previous[key] != config[key] for key in ("feishu_enabled", "relay_health_alerts")):
                relay_health_notifications.reset(db)
            if any(previous[key] != config[key] for key in ("feishu_enabled", "margin_imbalance_alerts")):
                margin_imbalance_notifications.reset(db)
            if previous["feishu_enabled"] != config["feishu_enabled"]:
                position_imbalance_notifications.reset(db)
            else:
                for name in config["symbols"]:
                    if (("position_imbalance" in previous["symbols"][name]["notification_types"])
                            != ("position_imbalance" in config["symbols"][name]["notification_types"])):
                        position_imbalance_notifications.reset(db, symbol=name)
            return config

    def observe_position_imbalance(self, observations, *, available, revision, instance_id, now=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            observations = [{**row, "suppressed": True} if not position_observations.current(db, row) else row
                            for row in observations]
            return position_imbalance_notifications.observe(db, observations, available=available,
                revision=revision, instance_id=instance_id, now=time.time() if now is None else now)

    def observe_margin_imbalance(self, observation, *, now=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return margin_imbalance_notifications.observe(db, observation, now=time.time() if now is None else now)

    def observe_relay_health(self, status, *, available, revision, now=None):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return relay_health_notifications.observe(db, status, available=available,
                revision=revision, now=time.time() if now is None else now)

    def hourly_summary_due(self, *, available, now=None):
        """Read only the persisted timer and settings on ordinary notification ticks."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return hourly_notifications.due(db, time.time() if now is None else now, available)

    def enqueue_hourly_summary(self, token, message, *, now=None):
        """Publish one current bucket and advance its timer in the same transaction."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return hourly_notifications.enqueue(db, token, message, time.time() if now is None else now)

    def hourly_summary_status(self, *, available, now=None):
        with self.connect() as db:
            return hourly_notifications.status(db, time.time() if now is None else now, available)

    def save_listing_state(self, state, alerts=(), *, policy_revision=None):
        """Persist discovery progress and its notification outbox atomically."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            config = monitoring.register_symbols(db, state.get("rows", {}))
            previous = listing_alerts.read(db, "usd1_listings", {})
            changed = policy_revision is not None and policy_revision != config["revision"]
            if not config["monitoring_enabled"] or not config["discovery_enabled"]:
                state["rebaseline"] = True
            elif changed and previous.get("rebaseline"):
                state["rebaseline"] = True
            for symbol, row in state.get("rows", {}).items():
                old = previous.get("rows", {}).get(symbol, {})
                if (changed or old.get("notification_phase") == "suppressed"
                        or not monitoring.allowed(config, "new_listing", [symbol])) and row.get("notification_phase") in ("pending", "incomplete"):
                    row["notification_phase"] = "suppressed"
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("usd1_listings", dumps(state)))
            for symbol in state.get("rows", {}):
                if ("listing_capacity" in config["symbols"][symbol]["notification_types"]
                        and not listing_alerts.read(db, listing_alerts.WATCH_PREFIX + symbol, {}).get("enabled")):
                    listing_alerts.set_watch(db, symbol, True, time.time())
            for notification_id, message in alerts:
                item = {"id": notification_id}
                if changed or not monitoring.message_allowed(db, item, config):
                    continue
                db.execute("INSERT OR IGNORE INTO outbox(id,message,due_at) VALUES (?,?,?)",
                           (notification_id, message, time.time()))
            listing_alerts.observe_all(db, state, time.time())

    def set_listing_watch(self, symbol, enabled):
        return self.edit_monitoring({"max_capacity_alert": enabled}, symbol=symbol)

    def listing_watch_symbols(self):
        with self.connect() as db:
            return listing_alerts.selected_symbols(db)

    def save_intent(self, intent):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (intent["account_id"],)).fetchone():
                raise TradingError("配对组成员不能创建单账户批次")
            db.execute("INSERT INTO intents VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
                       (intent["id"], intent["account_id"], intent["status"], dumps(intent)))

    def event(self, account_id, kind, message):
        with self.connect() as db:
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)", (account_id, kind, message, time.time()))

    def events(self, limit=100, *, account_id=None):
        if account_id is not None:
            account_identifier(account_id)
        with self.connect() as db:
            rows = [dict(row) for row in db.execute("SELECT * FROM events"
                    + (" WHERE account_id IN (?, '')" if account_id is not None else "")
                    + " ORDER BY created_at DESC,id DESC LIMIT ?",
                    (limit,) if account_id is None else (account_id, limit))]
        for row in rows:
            raw = row.pop("cycle_check", None)
            metadata = _cycle_check_metadata(raw) if row["kind"] == "cycle_check" else None
            if metadata is not None:
                row["cycle_check"] = metadata
        return rows

    def complete_leverage(self, intent, actual):
        """Persist confirmation and the first-add priority in the same transaction."""
        if legacy_intent(intent):
            raise TradingError(LEGACY_PENDING_REASON)
        intent.update(status="complete", confirmed_leverage=actual)
        with self.connect() as db:
            row = db.execute("SELECT status FROM intents WHERE id=?", (intent["id"],)).fetchone()
            if row and row[0] in ("complete", "aborted"):
                return
            db.execute("UPDATE intents SET status='complete',data=? WHERE id=?", (dumps(intent), intent["id"]))
            key = f"open_after_leverage:{intent['account_id']}:{intent['symbol']}"
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(actual)))
            self._resume_intent_pause(db, intent)

    def complete_pair(self, intent, quantities):
        """Commit the acknowledgement and aggregate progress in one transaction."""
        with self.connect() as db:
            row = db.execute("SELECT status FROM intents WHERE id=?", (intent["id"],)).fetchone()
            if row and row[0] in ("complete", "aborted"):
                return
            intent["status"] = "complete"
            db.execute("UPDATE intents SET status='complete',data=? WHERE id=?", (dumps(intent), intent["id"]))
            db.execute("DELETE FROM kv WHERE key=?", (f"open_after_leverage:{intent['account_id']}:{intent['symbol']}",))
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("post_fill_check:" + intent["account_id"], dumps({"symbol": intent["symbol"], "leverage": intent.get("leverage")})))
            key = "campaign:" + intent["account_id"]
            row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
            campaign = json.loads(row[0]) if row else {"id": intent["id"], "batches": [], "started_at": time.time()}
            campaign["batches"].append({"symbol": intent["symbol"], "quantities": quantities, "leverage": intent["leverage"]})
            campaign["last_fill_at"] = time.time()
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(campaign)))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)", (
                intent["account_id"], "fill", f"{intent['symbol']} {intent['leverage']}x 本批成交已核对，多头增加 {quantities['long_qty']}，空头增加 {quantities['short_qty']}" + capacity_timing_text(intent), time.time()))
            self._resume_intent_pause(db, intent)

    def abort_pair(self, intent):
        """Even a fully repaired batch may have reduced equity through fees."""
        completed = {**intent, "status": "aborted"}
        with self.connect() as db:
            row = db.execute("SELECT status FROM intents WHERE id=?", (intent["id"],)).fetchone()
            if row and row[0] in ("complete", "aborted"):
                return
            db.execute("UPDATE intents SET status='aborted',data=? WHERE id=?", (dumps(completed), intent["id"]))
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       ("post_fill_check:" + intent["account_id"], dumps({"symbol": intent["symbol"], "leverage": intent.get("leverage")})))
            self._resume_intent_pause(db, completed)
        intent.update(completed)

    def finish_campaign(self, account, reason, ratio):
        from .models import dec
        with self.connect() as db:
            key = "campaign:" + account["id"]
            row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
            if not row:
                return
            campaign = json.loads(row[0])
            totals = {}
            for batch in campaign["batches"]:
                entry = totals.setdefault(batch["symbol"], {"long_qty": dec(0), "short_qty": dec(0), "notional": dec(0), "leverage": batch["leverage"]})
                quantities = batch["quantities"]
                # Campaigns persisted by older versions have one matched quantity.
                for side in ("long_qty", "short_qty"):
                    entry[side] += dec(quantities.get(side, quantities.get("qty")))
                entry["notional"] += dec(quantities["notional"])
                entry["leverage"] = batch["leverage"]
            lines = [f"Aster 双向开仓完成{'（模拟）' if account['mode'] == 'paper' else ''}", f"账户：{account['name']}（{account['id']}）"]
            lines.extend(f"{symbol} · {v['leverage']}x · 本轮多头增加 {v['long_qty']}，空头增加 {v['short_qty']}，新增总名义金额 {v['notional']:,.2f} USD1" for symbol, v in totals.items())
            ratio_text = f"{dec(ratio) * 100:.2f}%" if ratio is not None else "无法计算（账户总权益不足）"
            lines.extend([f"结束原因：{reason}", f"USD1 保证金占用率（总占用保证金 / 总权益）：{ratio_text}", f"批次数：{len(campaign['batches'])}"])
            message = "\n".join(lines)
            # Simulated trading must never send external completion messages.
            if account["mode"] == "live":
                config = monitoring.read(db)
                for symbol, values in totals.items():
                    if not monitoring.allowed(config, "trade_summary", [symbol]):
                        continue
                    batches = sum(batch["symbol"] == symbol for batch in campaign["batches"])
                    text = "\n".join([*lines[:2],
                        f"{symbol} · {values['leverage']}x · 本轮多头增加 {values['long_qty']}，空头增加 {values['short_qty']}，新增总名义金额 {values['notional']:,.2f} USD1",
                        *lines[-3:-1], f"该币批次数：{batches}"])
                    db.execute("INSERT OR IGNORE INTO outbox(id,message,due_at,category,symbols) VALUES (?,?,?,?,?)",
                        (f"{campaign['id']}:trade:{symbol}", text, time.time(), "trade_summary", dumps([symbol])))
            db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)", (account["id"], "complete", message, time.time()))
            db.execute("DELETE FROM kv WHERE key=?", (key,))

    @staticmethod
    def capacity_alert_key(symbol, leverage):
        if symbol not in MARKET_SYMBOLS or type(leverage) is not int or leverage not in TIERS:
            raise TradingError("额度提醒市场或杠杆档位无效")
        return f"capacity_alert:{symbol}:{leverage}"

    def observe_capacity_alert(self, symbol, leverage, value, *, threshold, cooldown, identity, checked_at, now=None,
                               account_labels=()):
        """Atomically persist an independent threshold gate and its one pending message."""
        key = self.capacity_alert_key(symbol, leverage)
        value, threshold = positive(value, True), positive(threshold, True)
        cooldown = float(positive(cooldown, True))
        now = time.time() if now is None else float(positive(now, True))
        checked_at = float(positive(checked_at, True))
        if not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise TradingError("额度提醒配置标识无效")
        if not all(math.isfinite(v) for v in (now, checked_at, cooldown)):
            raise TradingError("额度提醒时间无效")
        if not -1 <= now - checked_at < CAPACITY_ALERT_MAX_AGE:
            return False
        try:
            checked_text = datetime.fromtimestamp(checked_at, timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            raise TradingError("额度提醒检查时间无效") from None
        above = value > threshold
        account_text = "满足网页额度阈值的账户：" + "、".join(account_labels) + "\n" if account_labels else ""
        message = (f"Aster 开仓额度提醒\n{symbol} · {leverage}x\n"
                   f"公开剩余可开额度（估算）：{value:,.2f} USD1\n"
                   f"触发条件：> {threshold:,.2f} USD1\n"
                   f"{account_text}"
                   "未扣除个人持仓和挂单占用，请以账户页面为准。\n"
                   f"检查时间：{checked_text}\n"
                   f"https://www.asterdex.com/zh-CN/trade/pro/futures/{symbol}")
        queued = False
        with self.connect() as db:
            # Serialize read-modify-write across separate Store instances/processes.
            if not db.in_transaction:
                db.execute("BEGIN IMMEDIATE")
            if not monitoring.allowed(monitoring.read(db), "strategy_capacity", [symbol]):
                return False
            row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
            gate = json.loads(row[0]) if row else None
            if gate and checked_at <= gate.get("resume_after", 0):
                return False
            if not gate or gate.get("identity") != identity:
                if gate and gate.get("pending_id"):
                    db.execute("UPDATE outbox SET expires_at=0 WHERE id=? AND delivered_at IS NULL", (gate["pending_id"],))
                gate = {"identity": identity, "notified": False, "last_alert": None, "pending_id": None,
                        "above": False, "fall_generation": 0}
            elif checked_at < gate.get("checked_at", 0):
                return False
            gate.setdefault("fall_generation", 0)
            if gate.get("above") and not above:
                gate["fall_generation"] += 1
            gate.update(above=above, checked_at=checked_at)
            pending_id = gate.get("pending_id")
            pending = db.execute("SELECT delivered_at FROM outbox WHERE id=?", (pending_id,)).fetchone() if pending_id else None
            if not pending or pending["delivered_at"] is not None:
                pending_id = gate["pending_id"] = None
            if not above:
                gate["notified"] = False
                if pending_id:
                    # Keep an in-flight id attached to the gate until its result is known.
                    db.execute("UPDATE outbox SET expires_at=0 WHERE id=?", (pending_id,))
            elif pending_id:
                # Refresh the estimate without resetting a failed send's retry backoff.
                db.execute("UPDATE outbox SET message=?,expires_at=? WHERE id=?",
                           (message, checked_at + CAPACITY_ALERT_MAX_AGE, pending_id))
            elif not gate.get("notified") and (gate.get("last_alert") is None or now - gate["last_alert"] >= cooldown):
                pending_id = "capacity-" + uuid.uuid4().hex
                db.execute("INSERT INTO outbox(id,message,due_at,expires_at,capacity_key) VALUES (?,?,?,?,?)",
                           (pending_id, message, now, checked_at + CAPACITY_ALERT_MAX_AGE, key))
                gate["pending_id"], queued = pending_id, True
            db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, dumps(gate)))
        return queued

    def invalidate_capacity_alert(self, symbol, leverage=None):
        """Pause stale/disabled sources without treating a failed read as a threshold fall."""
        keys = [self.capacity_alert_key(symbol, tier) for tier in (TIERS if leverage is None else (leverage,))]
        with self.connect() as db:
            db.executemany("UPDATE outbox SET expires_at=0 WHERE capacity_key=? AND delivered_at IS NULL", ((key,) for key in keys))

    @staticmethod
    def _notification_item(db, row):
        item = dict(row)
        if not monitoring.message_allowed(db, item):
            return None
        if item.get("category") == "relay_health" and not relay_health_notifications.deliverable(db, item):
            return None
        if item.get("category") == "margin_imbalance" and not margin_imbalance_notifications.deliverable(db, item, time.time()):
            return None
        if item.get("category") == "position_imbalance":
            capture = position_imbalance_notifications.delivery_observation(db, item)
            if (not position_imbalance_notifications.deliverable(db, item) or not capture
                    or not position_observations.current(db, capture)):
                return None
        if item["id"].startswith(listing_alerts.MESSAGE_PREFIX) and not listing_alerts.deliverable(db, item, time.time()):
            return None
        if item["capacity_key"]:
            if item["capacity_key"] not in CAPACITY_ALERT_KEYS:
                return None
            saved = db.execute("SELECT data FROM kv WHERE key=?", (item["capacity_key"],)).fetchone()
            gate = json.loads(saved[0]) if saved else None
            if not gate or gate.get("pending_id") != item["id"] or not gate.get("above"):
                return None
            item["capacity_identity"] = gate["identity"]
            item["capacity_generation"] = gate.get("fall_generation", 0)
        return item

    def due_notifications(self, *, channels=None):
        if channels is not None and not channels:
            return []
        with self.connect() as db:
            now = time.time()
            rows = db.execute("""SELECT * FROM outbox WHERE delivered_at IS NULL AND due_at<=?
                AND (expires_at IS NULL OR expires_at>?)
                ORDER BY (capacity_key IS NOT NULL),due_at,id""", (now, now))
            result = []
            buckets = {channel: [] for channel in notification_channels.CHANNELS if channels is not None and channel in channels}
            for row in rows:
                channel = notification_channels.for_item(dict(row)) if channels is not None else None
                if channels is not None and (channel not in buckets or len(buckets[channel]) >= 5):
                    continue
                if (item := self._notification_item(db, row)) is not None:
                    if channels is None:
                        result.append(item)
                        if len(result) == 5:
                            break
                    else:
                        buckets[channel].append(item)
                        if all(len(items) >= 5 for items in buckets.values()):
                            break
            if channels is not None:
                # Interleave destinations: a backlog on one cannot starve the other.
                result = [items[index] for index in range(5) for items in buckets.values() if len(items) > index]
            return result

    def notification_for_delivery(self, notification_id):
        """Re-read just before sending: a queued estimate may have fallen or expired."""
        with self.connect() as db:
            now = time.time()
            row = db.execute("""SELECT * FROM outbox WHERE id=? AND delivered_at IS NULL AND due_at<=?
                AND (expires_at IS NULL OR expires_at>?)""", (notification_id, now, now)).fetchone()
            return self._notification_item(db, row) if row else None

    def notification_result(self, item, success):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM outbox WHERE id=?", (item["id"],)).fetchone()
            if not row or row["delivered_at"] is not None:
                return
            now = time.time()
            if success:
                db.execute("UPDATE outbox SET delivered_at=? WHERE id=?", (now, item["id"]))
                if row["category"] == "hourly_summary":
                    hourly_notifications.delivered(db, now)
                if row["category"] == "relay_health":
                    relay_health_notifications.delivered(db, dict(row))
                if row["category"] == "position_imbalance":
                    position_imbalance_notifications.delivered(db, dict(row))
                if row["category"] == "margin_imbalance":
                    margin_imbalance_notifications.delivered(db, dict(row), now)
                if item["id"].startswith(listing_alerts.MESSAGE_PREFIX):
                    listing_alerts.delivered(db, item)
                if row["capacity_key"]:
                    saved = db.execute("SELECT data FROM kv WHERE key=?", (row["capacity_key"],)).fetchone()
                    gate = json.loads(saved[0]) if saved else None
                    if gate and gate.get("pending_id") == item["id"] and gate.get("identity") == item.get("capacity_identity"):
                        # An in-flight success does not consume a newer threshold crossing.
                        current_generation = item.get("capacity_generation", 0) == gate.get("fall_generation", 0)
                        gate.update(last_alert=now, notified=bool(gate.get("above")) and current_generation, pending_id=None)
                        db.execute("UPDATE kv SET data=? WHERE key=?", (dumps(gate), row["capacity_key"]))
                        _, symbol, leverage = row["capacity_key"].split(":")
                        db.execute("INSERT INTO events(account_id,kind,message,created_at) VALUES (?,?,?,?)",
                                   ("", "capacity", f"{symbol} {leverage}x 额度达标提醒已发送飞书", now))
            else:
                attempts = row["attempts"] + 1
                db.execute("UPDATE outbox SET attempts=?,due_at=? WHERE id=?", (attempts, now + min(3600, 5 * 2 ** min(attempts, 10)), item["id"]))

    def pending_notifications(self):
        return sum(self.pending_notification_channels().values())

    def pending_notification_channels(self):
        with self.connect() as db:
            config = monitoring.read(db)
            rows = db.execute("SELECT * FROM outbox WHERE delivered_at IS NULL AND (expires_at IS NULL OR expires_at>?)", (time.time(),))
            counts = dict.fromkeys(notification_channels.CHANNELS, 0)
            for row in rows:
                item = dict(row)
                if monitoring.message_allowed(db, item, config):
                    counts[notification_channels.for_item(item)] += 1
            return counts


class _StoreSnapshot(Store):
    """Single-threaded reader sharing one read-only transaction."""
    def __init__(self, owner, db):
        self.path, self.db = owner.path, db

    @contextmanager
    def connect(self):
        yield self.db

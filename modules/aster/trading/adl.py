"""Durable ADL response for bound live account pairs.

Only exchange-confirmed ADL fills authorize this workflow. Every reduction has
one durable client ID, closes a freshly observed position, and is reconciled
before another order can be prepared. Ordinary strategy recovery stays frozen.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from copy import deepcopy
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
import math
import threading
import time
import uuid

from . import adl_events, adl_exchange, adl_notifications
from .exchange import ExchangeError, AmbiguousOrder, RequestNotSent, ORDER_REJECTION_CODES
from .execution import Executor, TERMINAL
from .models import TradingError, dec, floor_step, wire
from .store import dumps

SCAN_SECONDS = 60
SCAN_OVERLAP_MS = 60000
BATCH_NOTIONAL = Decimal("1000")
MAX_SECONDS = 1800
MAX_BATCHES = 500


def _get(db, key, default=None):
    row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else deepcopy(default)


def _put(db, key, value):
    db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
               (key, dumps(value)))


def _owner(broker):
    user = broker.api.credentials["user"].lower()
    return hashlib.sha256(user.encode()).hexdigest()[:32]


def _event_key(owner, event):
    return f"adl_event:{owner}:{event['symbol']}:{event['order_id']}"


def _unhandled(db, pair_id):
    records = []
    for row in db.execute("SELECT key,data FROM kv WHERE key GLOB 'adl_event:*'"):
        item = json.loads(row[1])
        if item["pair_id"] == pair_id and (item.get("conflict") or dec(item["executed_qty"]) > dec(item.get("handled_qty", "0"))):
            records.append((row[0], item))
    return records


def _merge_event(db, pair, account, owner, event):
    key = _event_key(owner, event)
    old = _get(db, key)
    value = {**event, "owner": owner, "account_id": account["id"], "account_name": account["name"],
             "pair_id": pair["id"], "handled_qty": "0", "received_at": time.time(), "first_event_at": event["event_at"]}
    if old:
        immutable = ("symbol", "order_id", "position_side", "side", "owner", "account_id", "pair_id")
        if (any(old.get(field) != value.get(field) for field in immutable)
                or dec(old["original_qty"]) != dec(value["original_qty"])):
            old["conflict"] = True
            _put(db, key, old)
            return
        value["handled_qty"] = old.get("handled_qty", "0")
        value["first_event_at"] = min(old.get("first_event_at", old["event_at"]), event["event_at"])
        if "order_at" not in value and "order_at" in old:
            value["order_at"] = old["order_at"]
        if old.get("conflict"):
            value["conflict"] = True
        if dec(old["executed_qty"]) > dec(value["executed_qty"]):
            return
        if dec(old["executed_qty"]) == dec(value["executed_qty"]):
            if old["status"] in TERMINAL or value["event_at"] < old["event_at"]:
                return
    _put(db, key, value)


def scene_json(accounts, snapshots):
    return {aid: {"name": accounts[aid]["name"], "positions": [
        {"symbol": p.symbol, "position_side": p.position_side, "direction": p.side,
         "quantity": wire(p.quantity)} for p in snapshot.positions]}
        for aid, snapshot in snapshots.items()}


def require_adl_reflected(incident, snapshots):
    """A fresh HTTP response may still contain positions from before the fill."""
    for event in incident["events"]:
        snapshot = snapshots[event["account_id"]]
        updated = snapshot.position_updates.get((event["symbol"], event["position_side"]), 0)
        if updated < event["event_at"]:
            raise TradingError(f"{event['symbol']} 持仓更新时间尚未覆盖 ADL 成交，等待交易所现场同步")


def imbalances(snapshots, symbols):
    result = {}
    for symbol in symbols:
        net = sum((Fraction(p.quantity) * (1 if p.side == "LONG" else -1)
                   for snapshot in snapshots.values() for p in snapshot.positions if p.symbol == symbol), Fraction(0))
        if net:
            result[symbol] = net
    return result


def plan_reduction(snapshots, symbols, rules):
    """Pick one strictly reducing batch; never round across equality."""
    for symbol in sorted(symbols):
        holdings = [(aid, p) for aid, snapshot in snapshots.items() for p in snapshot.positions if p.symbol == symbol]
        totals = {side: sum((Fraction(p.quantity) for _, p in holdings if p.side == side), Fraction(0)) for side in ("LONG", "SHORT")}
        excess = totals["LONG"] - totals["SHORT"]
        if not excess:
            continue
        direction = "LONG" if excess > 0 else "SHORT"
        rule = rules[symbol]
        candidates = sorted(((aid, p) for aid, p in holdings if p.side == direction),
                            key=lambda item: (-item[1].quantity, item[0], item[1].position_side))
        for aid, position in candidates:
            # A single valid lot can exceed the nominal monetary batch limit.
            cap = max(Fraction(BATCH_NOTIONAL) / Fraction(position.mark), Fraction(rule.min_qty), Fraction(rule.step))
            qty = floor_step(min(abs(excess), Fraction(position.quantity), Fraction(rule.max_qty), cap), rule.step)
            if qty < rule.min_qty:
                continue
            order = {"symbol": symbol, "positionSide": position.position_side,
                     "side": "SELL" if direction == "LONG" else "BUY", "type": "MARKET", "quantity": wire(qty),
                     "newClientOrderId": "adl_" + uuid.uuid4().hex[:28], "newOrderRespType": "RESULT"}
            if position.position_side == "BOTH":
                order["reduceOnly"] = "true"
            return {"account_id": aid, "order": order, "position_before": wire(position.quantity),
                    "direction": direction, "excess_before": wire(abs(excess))}
        raise TradingError(f"{symbol} 剩余差额 {wire(abs(excess))} 小于可执行市价数量，已停止减仓并保留现场")
    return None


class AdlController:
    def __init__(self, engine):
        self.engine, self.store = engine, engine.store
        self.lock = threading.RLock()
        self.queue = {}
        self.wake = set()
        self.overflow = set()
        self.next_scan = {}
        self.scan_backoff = {}

    def _wake(self, account_id):
        wake = getattr(self.engine, "wake_adl", None)
        if wake:
            wake(account_id)

    def observe(self, account_id, broker, payload):
        event = adl_events.parse_ws(payload)
        if event is None:
            return
        with self.lock:
            key = (account_id, id(broker), event["symbol"], event["order_id"])
            if key in self.queue or len(self.queue) < 1024:
                previous = self.queue.get(key)
                if not previous or dec(event["executed_qty"]) >= dec(previous[1]["executed_qty"]):
                    self.queue[key] = (broker, event)
            else:
                self.overflow.add(account_id)
            self.wake.add(account_id)
        self._wake(account_id)

    def reconnected(self, account_id, broker):
        with self.lock:
            self.wake.add(account_id)
        self._wake(account_id)

    def _memory_pending(self, account_ids):
        with self.lock:
            return bool(self.overflow.intersection(account_ids) or any(
                key[0] in account_ids and event["confirmed"] for key, (_, event) in self.queue.items()))

    def _flush(self, account, broker, pair):
        aid = account["id"]
        with self.lock:
            items = [(key, value) for key, value in self.queue.items() if key[0] == aid]
        if not items:
            return
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            saved = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
            if not saved or aid not in (json.loads(saved[0])["long_account_id"], json.loads(saved[0])["short_account_id"]):
                raise TradingError("ADL 证据接收期间配对绑定发生变化")
            for _, (source, event) in items:
                if source is not broker:
                    raise TradingError("ADL 事件来自已更换的账户连接，请核对账户身份")
                _merge_event(db, pair, account, _owner(broker), event)
        with self.lock:
            for key, value in items:
                if self.queue.get(key) is value:
                    self.queue.pop(key)
        self._wake(aid)

    def poll(self, account):
        pair = self.store.pair_for_account(account["id"])
        if not pair or account["mode"] != "live" or not self.engine.live_allowed(account):
            return SCAN_SECONDS
        broker = self.engine.broker(account)
        self._flush(account, broker, pair)
        aid, owner = account["id"], _owner(broker)
        key = f"adl_scan:{pair['id']}:{aid}:{owner}"
        now = time.time()
        with self.lock:
            urgent = aid in self.wake
            self.wake.discard(aid)
        if now < self.scan_backoff.get(key, 0):
            return 1
        if not urgent and now < self.next_scan.get(key, 0):
            return min(1, self.next_scan[key] - now)
        scan = self.store.get(key)
        if scan is not None and now < scan.get("retry_at", 0):
            return 1
        if scan is None:
            # First installation starts now. It never trades old seven-day history.
            scan = {"started_ms": int(now * 1000), "cursor_ms": int(now * 1000), "windows": []}
            self.store.put(key, scan)
        if not scan["windows"]:
            end = min(int(now * 1000), scan["cursor_ms"] + 7 * 86400000 - SCAN_OVERLAP_MS)
            windows = [[max(scan["started_ms"], scan["cursor_ms"] - SCAN_OVERLAP_MS), end]]
            # Keep zero-filled candidates and partial ADL orders observable even
            # after the normal history watermark has moved past their creation.
            with self.store.connect() as db:
                candidates = [json.loads(row[0]) for row in db.execute(
                    "SELECT data FROM kv WHERE key GLOB ?", (f"adl_event:{owner}:*",))]
            for event in candidates:
                if event["pair_id"] != pair["id"] or event["account_id"] != aid or event["status"] in TERMINAL:
                    continue
                stamp = int(event.get("order_at", event.get("first_event_at", event["event_at"])) * 1000)
                candidate = [max(0, stamp - (1 if "order_at" in event else SCAN_OVERLAP_MS)), stamp + 1]
                if not any(start <= candidate[0] and finish >= candidate[1] for start, finish in windows):
                    windows.append(candidate)
            scan.update(target_ms=end, windows=windows)
        with broker.reconciliation_budget():
            result = adl_events.scan_force_orders(broker.api, scan["windows"], request_limit=2)
        if self.store.account(aid) != account or self.engine.broker(account) is not broker or _owner(broker) != owner:
            raise TradingError("ADL 补查期间账户连接发生变化")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for event in result["events"]:
                if event["event_at"] * 1000 >= scan["started_ms"]:
                    _merge_event(db, pair, account, owner, event)
            scan.update(windows=result["remaining"], error=result.get("blocked") or result.get("error"),
                        retry_at=now + max(result.get("retry_after", 0), 10 if result.get("error") or result.get("blocked") else 1))
            if not scan["windows"]:
                scan["cursor_ms"] = scan["target_ms"]
            _put(db, key, scan)
        with self.lock:
            if not scan["windows"]:
                self.overflow.discard(aid)
        self.next_scan[key] = now + max(result.get("retry_after", 0), 10 if scan["error"] else 1 if scan["windows"] else SCAN_SECONDS)
        self.scan_backoff[key] = now + max(result.get("retry_after", 0), 10 if scan["error"] else 1)
        if any(event["confirmed"] for event in result["events"]):
            self._wake(aid)
        return 1

    def require_clear(self, pair_id, *, allow_completed=False):
        pair = self.store.pair(pair_id)
        if pair and self._memory_pending({pair["long_account_id"], pair["short_account_id"]}):
            raise TradingError("已收到 ADL 成交事件，等待确认现场，禁止普通交易和配置变更")
        with self.store.connect() as db:
            state = _get(db, "adl_pair:" + pair_id)
            if _unhandled(db, pair_id) or state and (state["status"] != "completed" or state.get("hold") and not allow_completed):
                raise TradingError("ADL 应急处理中或完成后保持暂停；请查看配对组处理状态")

    def before_enable(self, pair):
        self.require_clear(pair["id"], allow_completed=True)

    def after_enable(self, pair):
        try:
            self.require_clear(pair["id"], allow_completed=True)
        except TradingError:
            current = self.store.pair(pair["id"])
            if current and current["enabled"]:
                self.store.save_pair({**current, "enabled": False, "pause_reason": "启动期间收到新的 ADL，继续保持暂停"})
            raise
        blocked = False
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            state = _get(db, "adl_pair:" + pair["id"])
            if _unhandled(db, pair["id"]):
                current = json.loads(db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()[0])
                self.store._save_pair(db, {**current, "enabled": False, "pause_reason": "启动期间收到新的 ADL，继续保持暂停"})
                blocked = True
            elif state and state["status"] == "completed":
                state["hold"] = False
                _put(db, "adl_pair:" + pair["id"], state)
        if blocked:
            raise TradingError("启动期间收到新的 ADL，继续保持暂停")

    def _context(self, pair, incident=None):
        from .pair_execution import PairTrader
        accounts, brokers, identities = PairTrader(self.engine)._members(pair)
        by_id = {value["id"]: value for value in accounts.values()}
        by_broker = {accounts[key]["id"]: value for key, value in brokers.items()}
        if incident and (incident["identities"] != identities or incident["accounts"] != by_id):
            raise TradingError("ADL 处理期间账户身份或配置已变化，禁止自动减仓")
        return by_id, by_broker, identities

    def _save(self, incident, *, phase=None):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            _put(db, "adl_pair:" + incident["pair_id"], incident)
            _put(db, "adl_incident:" + incident["id"], incident)
            if phase:
                adl_notifications.enqueue(db, incident, phase)

    def _begin(self, pair, records, accounts, identities):
        incident = {"id": uuid.uuid4().hex, "pair_id": pair["id"], "pair_name": pair["name"],
                    "status": "active", "hold": True, "created_at": time.time(), "events": [], "symbols": [],
                    "accounts": deepcopy(accounts), "identities": identities, "before": {}, "after": {}, "batches": [],
                    "strategy_status": "保持暂停", "reason": "已确认 ADL 成交，正在读取两个账户的真实现场"}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            runtime = _get(db, "pair_runtime:" + pair["id"], {})
            incident["frozen_runtime"] = deepcopy(runtime)
            saved = self.store._save_pair(db, {**pair, "enabled": False, "pause_reason": "ADL 应急减仓，完成后保持暂停"})
            incident["revision"] = saved["revision"]
            self._include(incident, records)
            _put(db, "adl_pair:" + pair["id"], incident)
            _put(db, "adl_incident:" + incident["id"], incident)
        manager = getattr(self.engine, "pairs", None)
        if manager is not None:
            manager._changed(saved)
        return saved, incident

    @staticmethod
    def _include(incident, records):
        events = {event["evidence_key"]: event for event in incident["events"]}
        for key, event in records:
            events[key] = {**event, "evidence_key": key}
        incident["events"] = list(events.values())
        incident["symbols"] = sorted({event["symbol"] for event in events.values()})

    def _guard(self, pair, incident, accounts, brokers, snapshots=None):
        current = self.store.pair(pair["id"])
        if not current or current["revision"] != incident["revision"] or current["enabled"]:
            raise TradingError("ADL 处理期间配对组配置发生变化，等待核对")
        if self._context(current, incident)[1] != brokers:
            raise TradingError("ADL 账户连接已变化")
        original = incident["frozen_runtime"].get("identities")
        if original and original != incident["identities"]:
            raise TradingError("ADL 发生前策略记录与当前账户身份不一致，禁止自动处理旧订单或仓位")
        if self._memory_pending(set(accounts)):
            raise TradingError("收到新的 ADL 成交事件，等待重新确认现场")
        captured = {event["evidence_key"]: event for event in incident["events"]}
        with self.store.connect() as db:
            for key, event in _unhandled(db, pair["id"]):
                if (key not in captured or event.get("conflict")
                        or dec(event["executed_qty"]) != dec(captured[key]["executed_qty"])):
                    raise TradingError("ADL 成交证据已更新，等待重新确认现场")
        if getattr(self.engine.workspace, "active", False) or self.engine.shutdown.is_set():
            raise TradingError("工作台维护或停止中，ADL 记录已保留")
        for aid, snapshot in (snapshots or {}).items():
            snapshot.require_current(brokers[aid])

    def _read(self, brokers):
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="adl-scene") as pool:
            futures = {aid: pool.submit(adl_exchange.reduction_snapshot, broker) for aid, broker in brokers.items()}
            snapshots = {aid: future.result() for aid, future in futures.items()}
        for aid, snapshot in snapshots.items():
            snapshot.require_current(brokers[aid])
        return snapshots

    def _settle(self, incident, item, broker):
        from .adl_recovery import reconcile_order
        result = reconcile_order(item, broker, lambda: self._save(incident))
        item["reconciliation_phase"] = result
        self._save(incident)
        return result != "waiting"

    def _quiesce(self, pair, incident, brokers):
        from .pair_planning import require_runtime_symbols
        require_runtime_symbols(pair, incident["frozen_runtime"])
        pending = incident["frozen_runtime"].get("pending")
        if pending and (pending.get("identities") != incident["identities"] or pending.get("pair_id") != pair["id"]):
            raise TradingError("ADL 发生前未完成批次的账户身份或配对标识不一致，禁止查询或撤销原订单")
        watch = incident["frozen_runtime"].get("recovery_watch") or {}
        if watch.get("retired_identities", incident["identities"]) != incident["identities"]:
            raise TradingError("ADL 旧归档观察的账户身份不一致")
        batches = list(watch.get("batches", []))
        if pending and pending.get("kind") == "leverage":
            # The new workflow never retransmits this old write. Fresh modes and
            # positions below determine reduction readiness after its safety window.
            if time.time() - pending.get("created_at", incident["created_at"]) < 120:
                raise TradingError("ADL 已暂停策略，等待旧杠杆请求的安全观察窗口")
        elif pending:
            batches.append(pending)
        if "prior_orders" not in incident:
            prior = []
            seen = set()
            for batch in batches:
                if batch.get("identities") != incident["identities"]:
                    raise TradingError("ADL 旧归档订单的账户身份不一致，禁止查询或撤单")
                for leg in batch.get("legs", []) + batch.get("repairs", []):
                    if leg.get("key") not in ("long", "short"):
                        raise TradingError("ADL 原订单账户方向无效")
                    order = deepcopy(leg["order"])
                    aid = pair[leg["key"] + "_account_id"]
                    identity = (aid, order["symbol"], order["newClientOrderId"])
                    if identity in seen:
                        continue
                    seen.add(identity)
                    receipt = leg.get("receipt")
                    terminal = bool(receipt and receipt.get("status") in TERMINAL)
                    item = {"account_id": aid, "account_name": incident["accounts"][aid]["name"],
                            "order": order, "receipt": receipt,
                            "state": "terminal" if terminal or leg.get("dispatch") == "prepared" else "sending",
                            "sent_at": batch.get("last_possible_send_at", incident["created_at"])}
                    if leg.get("dispatch") == "prepared":
                        item["not_sent"] = True
                    if batch.get("bounded_queries_complete") and not terminal:
                        item.update(resolution="positions_verified_unknown", resolved_at=incident["created_at"])
                    prior.append(item)
            incident["prior_orders"] = prior
            self._save(incident)
        ready = True
        for item in incident["prior_orders"]:
            ready = self._settle(incident, item, brokers[item["account_id"]]) and ready
        return ready

    @staticmethod
    def _order_items(incident):
        return incident.get("prior_orders", []) + incident["batches"]

    def _reality(self, incident, snapshots):
        # Unknown is preserved as unknown. Fresh reality permits a different
        # reduce-only correction, never retransmission of the old client ID.
        items = self._order_items(incident)
        symbols = set(incident["symbols"]) | {item["order"]["symbol"] for item in items}
        if any(row.get("symbol") in symbols for snapshot in snapshots.values() for row in snapshot.open_orders):
            raise TradingError("ADL 标的或原订单标的存在未完成挂单，等待活动订单结束后再减仓")
        changed = False
        for item in items:
            if item.get("reconciliation_phase") == "reality" and not item.get("resolution"):
                item.update(resolution="positions_verified_unknown", resolved_at=time.time())
                changed = True
        if changed:
            self._save(incident)

    def _watch_completed(self, pair, incident, accounts, brokers, identities):
        """While held, late unknown fills reopen a separate audited response."""
        if not incident.get("watch_unknown") or time.time() < incident.get("watch_after", 0):
            return pair, incident, False
        incident["watch_after"] = time.time() + 10
        try:
            self._guard(pair, incident, accounts, brokers)
            snapshots = self._read(brokers)
            require_adl_reflected(incident, snapshots)
            self._reality(incident, snapshots)
            self._guard(pair, incident, accounts, brokers, snapshots)
            if imbalances(snapshots, incident["symbols"]):
                previous = incident
                records = [(event["evidence_key"], event) for event in previous["events"]]
                pair, incident = self._begin(pair, records, accounts, identities)
                incident.update(parent_id=previous["id"],
                    prior_orders=deepcopy([item for item in self._order_items(previous) if item.get("resolution")]),
                    reason="暂停观察期间再次出现净差，正在重新确认并分批减去多余仓位")
                self._save(incident)
                return pair, incident, True
            incident["reason"] = "ADL 已按实际仓位完成平衡；原订单结果仍有未知，保持暂停并观察迟到持仓变化"
            incident["watch_checked_at"] = time.time()
            self._save(incident)
        except TradingError as exc:
            reason = "ADL 已完成后的迟到订单观察受阻：" + str(exc)
            changed = incident.get("reason") != reason
            incident["reason"] = reason
            if changed:
                incident["notice_version"] = incident.get("notice_version", 0) + 1
            self._save(incident, phase="blocked" if changed else None)
        return pair, incident, False

    def _send(self, pair, incident, accounts, brokers, snapshots, batch):
        aid = batch["account_id"]
        batch.update(account_name=accounts[aid]["name"], sent_at=time.time(), state="sending")
        incident["batches"].append(batch)
        # Any crash after this commit leaves an uncertain request to query.
        self._save(incident)
        try:
            try:
                self._guard(pair, incident, accounts, brokers, snapshots)
            except TradingError as exc:
                raise RequestNotSent(str(exc)) from None
            with brokers[aid].reconciliation_budget():
                rows = brokers[aid].submit([batch["order"]], timeout=3)
            if not isinstance(rows, list) or len(rows) != 1:
                raise TradingError("ADL 单笔减仓回执不完整")
            receipt = rows[0]
            if isinstance(receipt, dict) and receipt.get("code") in ORDER_REJECTION_CODES:
                batch.update(state="terminal", error=f"交易所拒绝 ADL 减仓（代码 {receipt['code']}）", rejected=True)
            else:
                Executor.validate_receipt(batch["order"], receipt)
                batch["receipt"] = receipt
                if receipt["status"] in TERMINAL:
                    batch["state"] = "terminal"
        except RequestNotSent:
            batch.update(state="terminal", error="请求明确未发送，等待重新确认现场", not_sent=True)
        except ExchangeError as exc:
            if not isinstance(exc, AmbiguousOrder) and exc.code in ORDER_REJECTION_CODES and exc.http_status != 408 and not (exc.http_status and exc.http_status >= 500):
                batch.update(state="terminal", error=f"交易所拒绝 ADL 减仓（代码 {exc.code}）", rejected=True)
            else:
                batch["error"] = "ADL 减仓结果未知，按原客户端订单号查询"
        except Exception:
            batch["error"] = "ADL 减仓结果未知，按原客户端订单号查询"
        self._save(incident)

    def _complete(self, pair, incident, accounts, brokers, snapshots):
        from .pair_execution import empty_progress
        self._guard(pair, incident, accounts, brokers, snapshots)
        require_adl_reflected(incident, snapshots)
        if self._memory_pending(set(accounts)):
            raise TradingError("收到新的 ADL 事件，等待更新现场")
        # Keep both generation locks through the final durable adoption.
        with ExitStack() as stack:
            for aid in sorted(brokers):
                stack.enter_context(brokers[aid]._snapshot_lock)
                snapshots[aid].require_current(brokers[aid])
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                saved_pair = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
                if not saved_pair or json.loads(saved_pair[0]).get("revision") != incident["revision"]:
                    raise TradingError("ADL 完成核验期间配对配置已变化")
                for aid, account in accounts.items():
                    saved_account = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
                    if not saved_account or json.loads(saved_account[0]) != account:
                        raise TradingError("ADL 完成核验期间账户配置已变化")
                captured = {event["evidence_key"]: event for event in incident["events"]}
                for key, event in _unhandled(db, pair["id"]):
                    if key not in captured or event.get("conflict") or dec(event["executed_qty"]) != dec(captured[key]["executed_qty"]):
                        raise TradingError("ADL 成交证据已更新，重新确认持仓后再完成")
                for key, event in captured.items():
                    saved = _get(db, key)
                    saved["handled_qty"] = event["executed_qty"]
                    _put(db, key, saved)
                owned = {side: wire(sum((Fraction(p.quantity) for p in snapshots[pair[key + "_account_id"]].positions
                                        if p.symbol == pair["symbol"] and p.side == side), Fraction(0)))
                         for key, side in (("long", "LONG"), ("short", "SHORT"))}
                runtime = _get(db, "pair_runtime:" + pair["id"], {})
                runtime.update(owned=owned, pending=None, symbol=pair["symbol"], identities=incident["identities"],
                               progress=empty_progress(owned, (runtime.get("progress") or {}).get("completed_cycles", 0)),
                               phase="paused", reason="ADL 应急减仓完成，多空总数量已一致；策略保持暂停，请核对后手动启动",
                               updated_at=time.time())
                runtime.pop("attention", None)
                incident.update(status="completed", completed_at=time.time(), reason=runtime["reason"], hold=True,
                                after=scene_json(accounts, snapshots))
                incident["watch_unknown"] = any(item.get("resolution") for item in self._order_items(incident))
                incident["watch_after"] = time.time() + 10
                _put(db, "pair_runtime:" + pair["id"], runtime)
                _put(db, "adl_pair:" + pair["id"], incident)
                _put(db, "adl_incident:" + incident["id"], incident)
                adl_notifications.enqueue(db, incident, "completed")

    def _blocked(self, incident, reason, *, halt=False):
        changed = incident.get("reason") != reason or incident["status"] != "blocked"
        incident.update(status="blocked", reason=reason, retry_at=time.time() + 10)
        if halt:
            incident["halted"] = True
        if changed:
            incident["notice_version"] = incident.get("notice_version", 0) + 1
        self._save(incident, phase="blocked" if changed else None)

    def _runtime(self, pair, incident):
        runtime = self.store.get("pair_runtime:" + pair["id"]) or {}
        runtime.update(phase="paused" if incident["status"] == "completed" else "attention" if incident["status"] == "blocked" else "recovering",
                       reason=incident["reason"], updated_at=time.time(), retry_after=1 if incident["status"] == "active" else 10,
                       adl={key: incident.get(key) for key in ("id", "status", "symbols", "created_at", "completed_at", "reason")})
        self.store.put("pair_runtime:" + pair["id"], {key: value for key, value in runtime.items() if key != "retry_after"})
        return runtime

    def tick(self, pair):
        incident = self.store.get("adl_pair:" + pair["id"])
        accounts, brokers, identities = self._context(pair)
        for aid, account in accounts.items():
            self._flush(account, brokers[aid], pair)
        with self.store.connect() as db:
            records = _unhandled(db, pair["id"])
        if not records and not (incident and (incident["status"] != "completed" or incident.get("hold"))):
            return None
        if incident is None or incident["status"] == "completed" and records:
            previous = incident
            if previous and previous.get("watch_unknown") and previous.get("hold"):
                records = [(event["evidence_key"], event) for event in previous["events"]] + records
            pair, incident = self._begin(pair, records, accounts, identities)
            if previous and previous.get("watch_unknown") and previous.get("hold"):
                incident.update(parent_id=previous["id"],
                    prior_orders=deepcopy([item for item in self._order_items(previous) if item.get("resolution")]))
                self._save(incident)
        elif incident["status"] == "completed":
            pair, incident, resumed = self._watch_completed(pair, incident, accounts, brokers, identities)
            if not resumed:
                return self._runtime(pair, incident)
        else:
            self._include(incident, records)
        try:
            if time.time() < incident.get("retry_at", 0):
                return self._runtime(pair, incident)
            self._guard(pair, incident, accounts, brokers)
            if any(event.get("conflict") for event in incident["events"]):
                raise TradingError("ADL 原订单证据存在冲突，已暂停，需人工核对")
            snapshots = None
            if not incident["before"]:
                snapshots = self._read(brokers)
                incident["after"] = scene_json(accounts, snapshots)
                require_adl_reflected(incident, snapshots)
                incident["before"] = deepcopy(incident["after"])
                self._save(incident, phase="detected")
            if not self._quiesce(pair, incident, brokers):
                incident["reason"] = "已暂停配对策略，正在核对原策略订单，未重复发送"
                self._save(incident)
                return self._runtime(pair, incident)
            if incident["batches"] and not self._settle(incident, incident["batches"][-1], brokers[incident["batches"][-1]["account_id"]]):
                incident["reason"] = "正在核对 ADL 减仓原订单，确认结果后才发送下一批"
                self._save(incident)
                return self._runtime(pair, incident)
            if snapshots is None or self._order_items(incident):
                # An order query/cancellation may have advanced execution. The
                # bounded exit always reads reality after those operations.
                snapshots = self._read(brokers)
            incident["after"] = scene_json(accounts, snapshots)
            require_adl_reflected(incident, snapshots)
            self._guard(pair, incident, accounts, brokers, snapshots)
            if any(not snapshot.can_trade for snapshot in snapshots.values()):
                raise TradingError("ADL 账户没有交易权限，已保存现场")
            self._reality(incident, snapshots)
            if incident["batches"]:
                last = incident["batches"][-1]
                receipt = last.get("receipt") or {}
                filled = dec(receipt.get("executedQty", "0"))
                if filled:
                    raw_time = receipt.get("updateTime")
                    reflected = False
                    if raw_time is not None:
                        if (type(raw_time) not in (int, float) or not math.isfinite(raw_time)
                                or raw_time <= 0 or raw_time / 1000 > time.time() + 1):
                            raise TradingError("ADL 减仓回执的交易所更新时间无效，等待核对")
                        updated = snapshots[last["account_id"]].position_updates.get(
                            (last["order"]["symbol"], last["order"]["positionSide"]), 0)
                        if updated < raw_time / 1000:
                            raise TradingError("ADL 减仓成交时间尚未反映到持仓，等待新的现场")
                        reflected = True
                    actual = sum((Fraction(p.quantity) for p in snapshots[last["account_id"]].positions
                                  if p.symbol == last["order"]["symbol"] and p.position_side == last["order"]["positionSide"] and p.side == last["direction"]), Fraction(0))
                    if not reflected and actual > Fraction(dec(last["position_before"])) - Fraction(filled):
                        raise TradingError("成交回执尚未反映在真实持仓，等待新的现场，禁止继续减仓")
            rules = {symbol: adl_exchange.reduction_rule(self.engine.market, symbol)
                     for symbol in imbalances(snapshots, incident["symbols"])}
            batch = plan_reduction(snapshots, incident["symbols"], rules)
            if batch is None:
                self._complete(pair, incident, accounts, brokers, snapshots)
                return self._runtime(pair, incident)
            if incident.get("halted"):
                return self._runtime(pair, incident)
            if incident["batches"] and incident["batches"][-1].get("rejected"):
                self._blocked(incident, incident["batches"][-1]["error"], halt=True)
                return self._runtime(pair, incident)
            if time.time() - incident["created_at"] > MAX_SECONDS or len(incident["batches"]) >= MAX_BATCHES:
                self._blocked(incident, "ADL 自动减仓达到处理时限或批次数上限，已保留剩余仓位与完整记录", halt=True)
                return self._runtime(pair, incident)
            recent = incident["batches"][-3:]
            if len(recent) == 3 and all(item["state"] == "terminal" and not dec((item.get("receipt") or {}).get("executedQty", "0")) for item in recent):
                self._blocked(incident, "连续三批未成交，已停止自动重试并保留现场", halt=True)
                return self._runtime(pair, incident)
            incident.update(status="active", reason=f"正在分批市价关闭 {batch['order']['symbol']} 多余的 {batch['direction']} 仓位", retry_at=0)
            self._send(pair, incident, accounts, brokers, snapshots, batch)
        except TradingError as exc:
            self._blocked(incident, str(exc))
        return self._runtime(pair, incident)

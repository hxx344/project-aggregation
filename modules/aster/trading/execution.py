"""Crash-recoverable hedge execution. All mutations have durable intent IDs."""
import time
import uuid
from copy import deepcopy
from contextlib import nullcontext
from fractions import Fraction

from .ordinary_selection import ordinary_add_block_reason
from .account_legacy import legacy_intent, legacy_block_reason, LEGACY_PENDING_REASON
from .exchange import AmbiguousOrder, ExchangeError, LeverageRejected, LiveBroker, RequestNotSent
from .exchange_messages import MISSING_REJECT_REASON, exchange_reason
from .models import AccountModeError, MIN_BATCH_NOTIONAL, TradingError, dec, floor_step, hedge_balanced, minimum_open_leverage, opening_margin_limit, ordinary_leverage_wait, positive, require_non_decreasing_leverage, require_supported_leverage, wire
from .paper import PaperBroker, PaperOrderAbsent
from .capacity_timing import initial_timing, observe_capacity_submit, capacity_timing_text
from . import recovery

TERMINAL = {"FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"}


class Executor:
    def __init__(self, store, broker, market):
        self.store, self.broker, self.market = store, broker, market
        self.last_snapshot = None
        self.last_completed_intent = None

    def open_pair(self, account, snapshot, symbol, plan, book, *, capacity_observation=None):
        self.last_snapshot = None
        self.last_completed_intent = None
        if legacy_block_reason(self.store, account["id"]):
            raise TradingError(LEGACY_PENDING_REASON)
        blocked = ordinary_add_block_reason(account, symbol)
        if blocked:
            raise TradingError(blocked)
        snapshot.require_modes(account["policy"]["symbols"])
        long, short = snapshot.require_ready(symbol)
        minimum = minimum_open_leverage(account["policy"])
        if long.leverage < minimum:
            raise TradingError(ordinary_leverage_wait(long.leverage, minimum))
        require_supported_leverage(long.leverage)
        book.require_fresh()
        qty = positive(plan.qty)
        rule = self.market.rules[symbol]
        if qty != floor_step(qty, rule.step) or not rule.min_qty <= qty <= rule.max_qty:
            raise TradingError("批次数量不符合交易规则")
        if Fraction(qty) * Fraction(book.mark) < max(rule.min_notional, MIN_BATCH_NOTIONAL):
            raise TradingError("新开仓每边名义金额至少为 500 USD1，并须满足交易所最低金额")
        if not hedge_balanced(long.qty, short.qty):
            raise TradingError("已有多空数量差超过 0.1%，等待人工核对")
        if self.store.intent(account["id"]):
            raise TradingError("已有批次正在执行")
        # A previously selected account mapping cannot authorize an ordinary
        # addition after its saved market selection changes.
        latest = self.store.account(account["id"])
        if latest is None:
            raise TradingError("账户不存在，禁止普通新增开仓")
        blocked = ordinary_add_block_reason(latest, symbol)
        if blocked:
            raise TradingError(blocked)
        token = uuid.uuid4().hex
        orders = [self.order(symbol, side, "BUY" if side == "LONG" else "SELL", plan.qty,
                            side[0] + token[:28]) for side in ("LONG", "SHORT")]
        intent = {"id": token, "kind": "pair", "account_id": account["id"], "symbol": symbol, "leverage": long.leverage,
                  "status": "pending", "created_at": time.time(), "baseline": {"LONG": wire(long.qty), "SHORT": wire(short.qty)},
                  "orders": orders, "receipts": {}, "repairs": [], "repair_attempts": 0,
                  "capacity_timing": initial_timing(symbol, long.leverage, capacity_observation)}
        self.store.save_intent(intent)  # FULL synchronous commit before any write request.
        self.store.event(account["id"], "order", f"{symbol} {long.leverage}x 提交双向市价批次，每边 {wire(plan.qty)}")
        self.send(intent, orders, capacity_observation=capacity_observation)
        return self.reconcile(account, intent)

    @staticmethod
    def order(symbol, position_side, side, qty, client_id):
        return {"symbol": symbol, "positionSide": position_side, "side": side, "type": "MARKET",
                "quantity": wire(qty), "newClientOrderId": client_id, "newOrderRespType": "RESULT"}

    def send(self, intent, orders, *, repair=False, capacity_observation=None, persist=None):
        account = self.store.account(intent["account_id"])
        recovery.mark_send(intent, account, self.broker, orders)
        # Commit the marked intent before entering the possibly-sent boundary.
        (self.store.save_intent if persist is None else persist)(intent)
        not_sent = None
        rejections = []
        try:
            measurement = (observe_capacity_submit(intent["capacity_timing"], capacity_observation,
                                                   live=isinstance(self.broker, LiveBroker))
                           if not repair and intent.get("kind") == "pair" and "capacity_timing" in intent else nullcontext())
            with measurement:
                result = self.broker.submit(orders)
            if not isinstance(result, list) or len(result) != len(orders):
                raise TradingError("批量订单响应格式异常，等待逐笔核对")
            for order, row in zip(orders, result):
                cid = order["newClientOrderId"]
                if isinstance(row, dict) and isinstance(row.get("code"), int) and row["code"] < 0:
                    # A batch-level timeout still needs a query, even inside HTTP 200.
                    if row["code"] not in (-1006, -1007):
                        intent["receipts"][cid] = {**order, "clientOrderId": cid, "status": "REJECTED", "executedQty": "0",
                                                   "avgPrice": "0", "reject_code": row["code"],
                                                   "reject_reason": exchange_reason(row.get("msg")) or MISSING_REJECT_REASON}
                        rejections.append(self.order_outcome(order, intent["receipts"][cid]))
                else:
                    self.validate_receipt(order, row)
                    intent["receipts"][cid] = row
        except RequestNotSent as exc:
            not_sent = exc
            # The local budget rejected the request before any network write.
            # These orders are known absent and must never enter unknown-order recovery.
            for order in orders:
                cid = order["newClientOrderId"]
                receipt = {**order, "clientOrderId": cid, "status": "REJECTED", "executedQty": "0", "avgPrice": "0",
                           "local_not_sent": True}
                if isinstance(exc.code, int):
                    receipt["reject_code"] = exc.code
                intent["receipts"][cid] = receipt
            if repair:
                # Persist the refund with the known-absent receipt, so a restart
                # cannot count a local budget denial as an exchange repair attempt.
                intent["repair_attempts"] -= 1
        except TradingError as exc:
            # Even a transport failure may have reached the exchange. Never resend.
            intent["last_error"] = str(exc)
            if isinstance(exc, ExchangeError) and not isinstance(exc, AmbiguousOrder) and exc.code not in (-1006, -1007):
                rejections.append(str(exc))
        self.store.save_intent(intent)
        if not repair and intent.get("kind") == "pair" and "capacity_timing" in intent:
            self.store.event(intent["account_id"], "order", f"{intent['symbol']} {intent['leverage']}x 本批开仓耗时"
                             + capacity_timing_text(intent))
        if rejections:
            symbols = "/".join(dict.fromkeys(order["symbol"] for order in orders))
            self.store.event(intent["account_id"], "error", f"{symbols} 订单提交异常：{'；'.join(rejections)}")
        return not_sent

    @staticmethod
    def order_outcome(order, row):
        side = "多头" if order["positionSide"] == "LONG" else "空头"
        outcome = "本地未发送" if row.get("local_not_sent") else row["status"]
        code = row.get("reject_code")
        text = f"{side} {outcome}" + (f"（code={code}）" if isinstance(code, int) else "")
        if row["status"] == "REJECTED" and not row.get("local_not_sent") and not row.get("paper_not_committed"):
            text += "：" + (exchange_reason(row.get("reject_reason")) or MISSING_REJECT_REASON)
        return text

    @staticmethod
    def validate_receipt(order, row):
        if not isinstance(row, dict) or any(row.get(key) != order[key] for key in ("symbol", "positionSide", "side")) or row.get("clientOrderId") != order["newClientOrderId"]:
            raise TradingError("订单回执与本批委托不匹配")
        qty = positive(row.get("executedQty"), True)
        if qty > dec(order["quantity"]) or row.get("status") not in TERMINAL | {"NEW", "PARTIALLY_FILLED", "PENDING_CANCEL"}:
            raise TradingError("订单成交数量或状态无效")
        if row["status"] == "FILLED" and qty != dec(order["quantity"]):
            raise TradingError("完全成交回执数量与委托数量不一致")
        if qty:
            positive(row.get("avgPrice"))

    def leverage(self, account, symbol, old, target, snapshot=None, before_submit=None):
        self.last_snapshot = None
        self.last_completed_intent = None
        if legacy_block_reason(self.store, account["id"]):
            raise TradingError(LEGACY_PENDING_REASON)
        blocked = ordinary_add_block_reason(account, symbol)
        if blocked:
            raise TradingError(blocked)
        require_supported_leverage(target)
        require_non_decreasing_leverage(old, target)
        # Re-read before creating intent; the selection snapshot may now be stale.
        symbols = account["policy"]["symbols"]
        snapshot = self.broker.snapshot(symbols, fresh_modes=True)
        snapshot.require_modes(symbols)
        long, short = snapshot.require_ready(symbol)
        old = long.leverage
        require_non_decreasing_leverage(old, target)
        if not hedge_balanced(long.qty, short.qty):
            raise TradingError("已有多空数量差超过 0.1%，等待人工核对")
        if self.store.intent(account["id"]):
            raise TradingError("已有批次正在执行")
        if target == old:
            return f"当前已为 {old}x，保持杠杆不变"
        if before_submit is not None and not isinstance(self.broker, LiveBroker):
            before_submit(snapshot)
        latest = self.store.account(account["id"])
        if latest is None:
            raise TradingError("账户不存在，禁止普通杠杆调整")
        blocked = ordinary_add_block_reason(latest, symbol)
        if blocked:
            raise TradingError(blocked)
        intent = {"id": uuid.uuid4().hex, "kind": "leverage", "account_id": account["id"], "symbol": symbol,
                  "previous": old, "target": target, "created_at": time.time(), "status": "pending"}
        recovery.mark_send(intent, latest, self.broker)
        self.store.save_intent(intent)
        try:
            if isinstance(self.broker, LiveBroker):
                options = {"before_submit": before_submit} if before_submit is not None else {}
                response = self.broker.set_leverage(symbol, target, checked_snapshot=snapshot, **options)
            else:
                response = self.broker.set_leverage(symbol, target)
            if not isinstance(response, dict) or response.get("symbol") != symbol:
                raise TradingError("杠杆调整回执无效，等待实际账户确认")
            acknowledged = LiveBroker._leverage(response.get("leverage"))
            if acknowledged < target:
                raise TradingError("杠杆调整回执未达到目标，等待实际账户确认")
            # A write acknowledgement is useful diagnostics, not a replacement
            # for the fresh account confirmation needed before opening a pair.
            intent["change_response"] = {"symbol": symbol, "leverage": acknowledged}
        except RequestNotSent as exc:
            intent.update(status="aborted", last_error=str(exc))
            self.store.save_intent(intent)
            raise
        except LeverageRejected as exc:
            details = []
            if exc.http_status is not None and exc.http_status >= 400:
                details.append(f"HTTP {exc.http_status}")
            if exc.code is not None:
                details.append(f"代码 {exc.code}")
            reason = f"{symbol} {old}x→{target}x 杠杆调整被拒绝（{'，'.join(details)}），等待重新评估"
            intent.update(status="aborted", last_error=reason, submission_error=str(exc), submission_code=exc.code,
                          submission_http_status=exc.http_status)
            self.store.save_intent(intent)
            raise LeverageRejected(reason, code=exc.code, retry_after=exc.retry_after, http_status=exc.http_status) from None
        except TradingError as exc:
            intent.update(last_error=str(exc), submission_error=str(exc), submission_code=getattr(exc, "code", None),
                          submission_http_status=getattr(exc, "http_status", None))
        self.store.save_intent(intent)
        return f"正在核对 {symbol} {old}x→{target}x 杠杆调整结果"

    def attention(self, account, intent, reason):
        if intent.get("status") != "attention" or intent.get("last_error") != reason:
            self.store.event(account["id"], "error", reason)
        intent.update(status="attention", last_error=reason)
        self.store.pause_intent(account, intent, reason)
        return reason

    def _observe_recovery(self, account, intent):
        recovery.observe(intent, self.store.account(account["id"]), self.broker)
        self.store.save_intent(intent)

    def _read_recovery_snapshot(self, intent, read):
        try:
            snapshot = read()
        except TradingError as exc:
            recovery.checked(intent, "leverage", exc)
            self.store.save_intent(intent)
            raise
        recovery.checked(intent, "leverage")
        self.store.save_intent(intent)
        return snapshot

    @staticmethod
    def _unresolved_ids(intent):
        return [order["newClientOrderId"] for order in intent.get("orders", []) + intent.get("repairs", [])
                if intent.get("receipts", {}).get(order["newClientOrderId"], {}).get("status") not in TERMINAL]

    def _validate_known_terminal(self, intent):
        for order in intent.get("orders", []) + intent.get("repairs", []):
            receipt = intent.get("receipts", {}).get(order["newClientOrderId"])
            self.validate_receipt(order, receipt)
            if receipt["status"] not in TERMINAL:
                raise TradingError("原批次尚有未终结回执，不能按已知结果采纳仓位")

    def _current_recovery_wait(self, account, intent):
        if not intent["bounded_recovery"].get("current_state"):
            return None
        if recovery.due(intent, ["current_state"]):
            return self._recover_current(account, intent)
        if not recovery.can_query(intent, "current_state"):
            return "旧批次与实际持仓已完成有限次核对，等待安全观察窗口后按现实重新核验"
        return None

    def _recover_known_state(self, account, intent, reason):
        self._validate_known_terminal(intent)
        intent["bounded_recovery"]["current_state"] = True
        recovery.checked(intent, "current_state")
        self.store.save_intent(intent)
        if recovery.due(intent, ["current_state"]):
            return self._recover_current(account, intent)
        return self.attention(account, intent, reason)

    def _recover_current(self, account, intent):
        """Abandon only old request tracking; actual holdings stay untouched."""
        current_account = self.store.account(account["id"])
        recovery.observe(intent, current_account, self.broker)
        self.store.save_intent(intent)
        aid, kind = account["id"], intent["kind"]
        result_known = bool(intent["bounded_recovery"].get("current_state"))
        for order in intent.get("orders", []) + intent.get("repairs", []):
            cid = order["newClientOrderId"]
            if cid in intent.get("receipts", {}):
                self.validate_receipt(order, intent["receipts"][cid])
        if result_known:
            self._validate_known_terminal(intent)
        symbols = list(dict.fromkeys([*current_account["policy"]["symbols"], *intent.get("symbols", []), intent["symbol"]]))
        keys = ["recovery_auto_pause:" + aid, "post_fill_check:" + aid,
                f"open_after_leverage:{aid}:{intent['symbol']}"]
        if isinstance(self.broker, PaperBroker):
            keys.append("paper:" + aid)
        expected = {key: self.store.get(key) for key in keys}
        snapshot, actual, check_current, lock = recovery.safe_snapshot(current_account, self.broker, symbols)
        actual_leverage = actual[intent["symbol"]]["leverage"]
        require_supported_leverage(actual_leverage)
        margin_limit = opening_margin_limit(current_account["policy"], actual_leverage)
        if snapshot.margin_exceeds(margin_limit):
            raise TradingError("当前保证金占用率超过策略上限，暂不自动结束旧批次核对")
        now = time.time()
        reason = (f"{intent['symbol']} 已依据本轮完整挂单及实际平衡仓位结束旧批次跟踪；"
                  + ("已知成交回执保留，当前仓位作为新基线" if result_known else "历史成交结果保留未知")
                  + "，未重发原请求或下单")
        replacements = {"post_fill_check:" + aid: None,
                        f"open_after_leverage:{aid}:{intent['symbol']}": None}
        cooldown = None
        if kind == "leverage":
            cooldown = {"identity": recovery.broker_identity(current_account, self.broker),
                "config": recovery.recovery_config(current_account), "target": intent["target"],
                "actual": actual[intent["symbol"]]["leverage"], "until": now + recovery.LEVERAGE_COOLDOWN_SECONDS,
                "intent_id": intent["id"]}
        known_quantities = None
        if result_known and kind == "pair":
            filled = {side: Fraction(0) for side in ("LONG", "SHORT")}
            amounts = filled.copy()
            reduced = filled.copy()
            for order in intent["orders"]:
                receipt = intent["receipts"][order["newClientOrderId"]]
                side, qty = order["positionSide"], Fraction(dec(receipt["executedQty"]))
                filled[side] += qty
                if qty:
                    amounts[side] += qty * Fraction(dec(receipt["avgPrice"]))
            for order in intent["repairs"]:
                reduced[order["positionSide"]] += Fraction(dec(intent["receipts"][order["newClientOrderId"]]["executedQty"]))
            net = {side: filled[side] - reduced[side] for side in filled}
            if any(qty < 0 for qty in net.values()):
                raise TradingError("本批已知减仓超过新增量，不能归档为正常成交")
            known_quantities = {"long_qty": wire(net["LONG"]), "short_qty": wire(net["SHORT"]),
                "notional": wire(sum((amounts[side] * net[side] / filled[side] for side in filled if filled[side]), Fraction(0)))}
        with lock:
            completed, saved_account = self.store.archive_recovered_intent(intent, current_account,
                expected_state=expected, replacements=replacements, check_current=check_current,
                resolution={"kind": "current_state_adopted" if result_known else "unknown_current_state",
                            "execution_result_unknown": not result_known, "known_quantities": known_quantities,
                            "checked_at": now, "actual": actual, "reason": reason},
                cooldown=cooldown)
        intent.clear()
        intent.update(completed)
        account.clear()
        account.update(saved_account)
        self.last_snapshot, self.last_completed_intent = snapshot, deepcopy(completed)
        return reason

    def reconcile(self, account, intent=None):
        self.last_snapshot = None
        self.last_completed_intent = None
        if legacy_intent(intent or self.store.intent(account["id"])):
            self.store.pause_account(account, LEGACY_PENDING_REASON)
            return LEGACY_PENDING_REASON
        writer = getattr(self.store, "account_writer", None)
        if writer is not None:
            writer.settle_intent(intent or self.store.intent(account["id"]) or {})
        with getattr(self.broker, "reconciliation_budget", nullcontext)():
            return self._reconcile(account, intent)

    def _reconcile(self, account, intent=None):
        intent = intent or self.store.intent(account["id"])
        if not intent:
            return "没有未完成批次"
        if intent.get("status") in ("complete", "aborted"):
            return "批次已结束"
        if legacy_intent(intent):
            self.store.pause_account(account, LEGACY_PENDING_REASON)
            return LEGACY_PENDING_REASON
        self._observe_recovery(account, intent)
        waiting = self._current_recovery_wait(account, intent)
        if waiting:
            return waiting
        if intent["kind"] == "leverage":
            if recovery.due(intent, ["leverage"]):
                return self._recover_current(account, intent)
            if not recovery.can_query(intent, "leverage"):
                return "旧杠杆请求已完成有限次核对，等待安全观察窗口后读取当前账户"
            if isinstance(self.broker, PaperBroker):
                self.broker.reload()
            symbols = intent.get("symbols", account["policy"]["symbols"])
            snapshot = self._read_recovery_snapshot(intent, lambda: self.broker.snapshot(symbols, fresh_modes=True))
            snapshot.require_fresh()
            try:
                snapshot.require_modes(symbols)
            except AccountModeError as exc:
                return self.attention(account, intent, str(exc))
            long, short = snapshot.pair(intent["symbol"])
            if intent["target"] < intent["previous"]:
                if recovery.due(intent, ["leverage"]):
                    return self._recover_current(account, intent)
                return self.attention(account, intent, "旧降杠杆请求仅核对实际账户，不会重复提交；等待安全观察窗口")
            if long.leverage == short.leverage and long.leverage >= intent["target"]:
                writer = getattr(self.store, "account_writer", None)
                if writer is not None:
                    writer.resolve_prefix("aster:leverage:POST:" + intent["id"])
                    writer.resolve_prefix("aster:legacy:intent:" + intent["id"])
                self.store.complete_leverage(intent, long.leverage)
                self.store.event(account["id"], "leverage", f"{intent['symbol']} 已核实实际杠杆 {long.leverage}x（目标 {intent['target']}x）；按实际档位准备开仓，禁止降档")
                return "杠杆调整已确认"
            if isinstance(self.broker, PaperBroker) and long.leverage == short.leverage == intent["previous"]:
                # Paper mutations commit synchronously under the account lock;
                # unchanged durable leverage cannot become effective later.
                reason = "模拟杠杆调整未写入账本，已结束本次调整，等待重新检查"
                intent.update(status="aborted", last_error=reason)
                self.store.save_intent(intent)
                return reason
            if time.time() - intent["created_at"] > 120:
                if recovery.due(intent, ["leverage"]):
                    return self._recover_current(account, intent)
                reason = (f"{intent['symbol']} 杠杆变更尚未确认：{intent['previous']}x→{intent['target']}x，"
                          f"实际仍为 {long.leverage}x；请核对账户后重新检查")
                if intent.get("submission_error"):
                    reason += "；提交时：" + intent["submission_error"]
                if intent.get("submission_code") is not None:
                    reason += f"（代码 {intent['submission_code']}）"
                if intent.get("submission_http_status") is not None and intent["submission_http_status"] >= 400:
                    reason += f"（HTTP {intent['submission_http_status']}）"
                return self.attention(account, intent, reason)
            return f"等待账户确认 {intent['symbol']} 目标 {intent['target']}x，实际 {long.leverage}x"

        if recovery.due(intent, self._unresolved_ids(intent)):
            return self._recover_current(account, intent)
        orders = intent["orders"] + intent["repairs"]
        unresolved = []
        for order in orders:
            cid = order["newClientOrderId"]
            known = intent["receipts"].get(cid)
            if known and known.get("status") in TERMINAL:
                try:
                    self.validate_receipt(order, known)
                except TradingError as exc:
                    return self.attention(account, intent, str(exc))
                continue
            if not recovery.can_query(intent, cid):
                unresolved.append(cid)
                continue
            try:
                row = recovery.query(self.broker, intent, order)
                self.validate_receipt(order, row)
                intent["receipts"][cid] = row
                if row["status"] not in TERMINAL:
                    unresolved.append(cid)
                    if time.time() - intent["created_at"] > 10:
                        self.broker.cancel(intent["symbol"], cid)
            except ExchangeError as exc:
                if isinstance(self.broker, PaperBroker) and isinstance(exc, PaperOrderAbsent):
                    intent["receipts"][cid] = {**order, "clientOrderId": cid, "status": "REJECTED",
                                               "executedQty": "0", "avgPrice": "0", "paper_not_committed": True}
                    if order in intent["repairs"]:
                        # Save the refund and terminal receipt together below.
                        # A retry may already have reset the attempt counter.
                        intent["repair_attempts"] = max(0, intent["repair_attempts"] - 1)
                else:
                    unresolved.append(cid)
                    intent["last_error"] = str(exc)
            except TradingError as exc:
                return self.attention(account, intent, str(exc))
        self.store.save_intent(intent)
        if unresolved:
            if recovery.due(intent, unresolved):
                return self._recover_current(account, intent)
            if time.time() - intent["created_at"] > 120:
                return self.attention(account, intent, "订单结果仍不确定，已暂停新开仓；请核对未完成批次")
            return "核对订单回执中，不重复提交"

        # Confirm actual account positions before any repair, including manual changes/ADL.
        snapshot = self.broker.snapshot(account["policy"]["symbols"])
        snapshot.require_fresh()
        try:
            snapshot.require_modes(account["policy"]["symbols"])
        except AccountModeError as exc:
            return self.attention(account, intent, str(exc))
        long, short = snapshot.pair(intent["symbol"])
        filled = {side: Fraction(0) for side in ("LONG", "SHORT")}
        notionals = {side: Fraction(0) for side in filled}
        for order in intent["orders"]:
            row = intent["receipts"][order["newClientOrderId"]]
            qty = Fraction(dec(row["executedQty"]))
            filled[order["positionSide"]] += qty
            if qty:
                notionals[order["positionSide"]] += qty * Fraction(dec(row["avgPrice"]))
        repaired = {side: Fraction(0) for side in filled}
        for order in intent["repairs"]:
            repaired[order["positionSide"]] += Fraction(dec(intent["receipts"][order["newClientOrderId"]]["executedQty"]))
        net = {side: filled[side] - repaired[side] for side in filled}
        actual = {"LONG": Fraction(long.qty), "SHORT": Fraction(short.qty)}
        if any(net[s] < 0 for s in actual):
            return self.attention(account, intent, "本批减仓回执超过已知新增量，暂停并等待核对")
        if any(actual[s] != Fraction(dec(intent["baseline"][s])) + net[s] for s in actual):
            return self._recover_known_state(account, intent, "持仓变化与本批回执不一致，已暂停并有限次核对当前仓位")
        if not hedge_balanced(long.qty, short.qty):
            if not snapshot.can_trade or snapshot.open_orders:
                return self.attention(account, intent, "账户交易权限或未完成挂单不符合补偿条件，等待核对")
            if intent["repair_attempts"] >= 3:
                return self._recover_known_state(account, intent, "单腿补偿已达上限，暂停并核对当前仓位")
            side = "LONG" if long.qty > short.qty else "SHORT"
            book = self.market.book(intent["symbol"])
            book.require_fresh()
            snapshot.require_fresh()
            rule = self.market.rules[intent["symbol"]]
            # Bring total holdings back within tolerance without closing baseline holdings.
            room = floor_step(min(abs(net["LONG"] - net["SHORT"]), net[side], rule.max_qty,
                                  book.bid_qty if side == "LONG" else book.ask_qty), rule.step)
            qty = Fraction(floor_step(min(abs(actual["LONG"] - actual["SHORT"]), room), rule.step))
            other = "SHORT" if side == "LONG" else "LONG"
            # Old holdings may predate today's step. Crossing equality by one step
            # is allowed only when it restores tolerance and stays within this batch.
            step = Fraction(rule.step)
            if not hedge_balanced(actual[side] - qty, actual[other]) and qty + step <= room \
                    and hedge_balanced(actual[side] - qty - step, actual[other]):
                qty += step
            if qty <= 0:
                return self.attention(account, intent, "盘口不足以补偿本批单腿，请核对持仓")
            if qty < Fraction(rule.min_qty):
                return self.attention(account, intent, "可补偿数量低于市价最小数量，暂停并等待核对")
            repair = self.order(intent["symbol"], side, "SELL" if side == "LONG" else "BUY", qty,
                                "R" + uuid.uuid4().hex[:28])
            intent["repairs"].append(repair)
            intent["repair_attempts"] += 1
            intent["status"] = "repair"
            self.store.save_intent(intent)
            self.store.event(account["id"], "repair", f"{intent['symbol']} 处理单腿差额：仅市价平掉本批多出的 {side} {wire(qty)}")
            not_sent = self.send(intent, [repair], repair=True)
            if not_sent is not None:
                # Preserve the batch and let the scheduler honor retry_after.
                # The next pass skips this known-absent order and can retry repair.
                raise not_sent
            return self.reconcile(account, intent)

        added = any(net.values())
        if added:
            # Keep each side's retained fill; exclude quantities closed by repairs.
            total = sum(notionals[s] * net[s] / filled[s] for s in filled if filled[s])
            self.store.complete_pair(intent, {"long_qty": wire(net["LONG"]), "short_qty": wire(net["SHORT"]), "notional": wire(total)})
        else:
            self.store.abort_pair(intent)
            outcomes = []
            for order in intent["orders"]:
                row = intent["receipts"][order["newClientOrderId"]]
                outcomes.append(self.order_outcome(order, row))
            self.store.event(account["id"], "order", f"{intent['symbol']} 本批未形成新增双向仓位，订单已核对：{'；'.join(outcomes)}")
        # Reuse only the account read that verified every terminal receipt and
        # the final retained holdings, never the snapshot before a repair.
        self.last_snapshot = snapshot
        self.last_completed_intent = dict(intent)
        return "双向批次已核对完成，多空数量差不超过 0.1%" if added else "本批未成交或已完成单腿补偿"

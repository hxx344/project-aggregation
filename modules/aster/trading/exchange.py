"""Aster V3 EIP-712 API adapter. No automatic retries of signed mutations."""
import json
from collections import deque
from concurrent.futures import Future
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from dataclasses import replace
from email.utils import parsedate_to_datetime
from fractions import Fraction
import math
import os
import re
import threading
import time
from urllib.parse import urlencode

import httpx
from eth_account import Account as EthAccount
from eth_account.messages import encode_typed_data

import monitor
from .capacity_relay_client import CAPACITY_RELAY_SYMBOLS
from .depth import DEPTH_LIMIT, DEPTH_MAX_AGE, DEPTH_RESYNC_INTERVAL, DEPTH_WEIGHT, DepthSnapshot
from .depth_stream import PublicDepthStream
from .display_positions import account_positions
from .exchange_messages import MISSING_REJECT_REASON, exchange_reason
from .market_stream import PublicQuoteStream
from .user_stream import PrivateAccountStream
from .ws_evidence import PrivateEventEvidence
from .request_timing import transport_stage
from .models import AccountModeError, AccountSnapshot, Book, MarkPrice, MARKET_SYMBOLS, Position, Rules, SYMBOLS, TAKER_FEE_ESTIMATE, TradingError, dec, decimal_value, positive, require_non_decreasing_leverage, require_supported_leverage, validate_brackets

BASE = "https://fapi.asterdex.com"
PUBLIC_BRACKETS_REFRESH_INTERVAL = 60
PUBLIC_BRACKETS_MAX_AGE = 300
# Periodic mode calibration; startup, reconnects and configuration events still
# invalidate the cache and require an immediate authenticated read.
MULTI_ASSETS_MODE_MAX_AGE = 600
# Keep this well below the 200 ms scheduler cadence. The HTTP read starts
# after that scheduler's clock, so an equal TTL can skip every other sample.
PUBLIC_OI_SHARE_MAX_AGE = .1


class ExchangeError(TradingError):
    def __init__(self, message, code=None, retry_after=0, *, http_status=None):
        super().__init__(message)
        self.code, self.retry_after = code, retry_after
        self.http_status = http_status


class AmbiguousOrder(ExchangeError):
    """The exchange might have accepted a mutation; query before deciding."""


class RequestNotSent(ExchangeError):
    """A local admission check failed before any HTTP request was sent."""


class SendBasisExpired(RequestNotSent):
    """The account or quote evidence an order was sized from expired before HTTP."""


class TransferRejected(ExchangeError):
    """A documented transfer rejection; the request was sent but not accepted."""


class SnapshotSuperseded(TradingError):
    """An account event or write invalidated a read-only preparation."""


class PublicBracketsUnavailable(ExchangeError):
    """The background public risk table is not usable yet."""


class LeverageRejected(ExchangeError):
    """The leverage mutation received a documented, definitive rejection."""


# Restrict this classification to documented rejection codes, not network or
# unknown processing failures. It is used only for the leverage POST below.
LEVERAGE_REJECTION_CODES = frozenset({
    -1002, -1003, -1011, -1015, -1020, -1022, -1100, -1101, -1102, -1103, -1104, -1105,
    -1106, -1111, -1121, -1130, -2014, -2015, -2019, -2027, -2028, -4028,
})
# Aster documents these as WAF/rate-limit/IP-ban rejections. Gateways may
# return HTML or no body, so the status itself must survive JSON parsing.
LEVERAGE_REJECTION_HTTP_STATUSES = frozenset({403, 418, 429})
# Order POST rejections include NEW_ORDER_REJECTED and Aster's symbol notional
# cap (-2029 and the observed exchange rejection -5018). These order codes do
# not classify leverage updates or override an ambiguous transport outcome.
ORDER_REJECTION_CODES = LEVERAGE_REJECTION_CODES | {-2010, -2029, -5018}


# Unknown, disconnected/internal and timeout codes never describe the order's fate.
UNCERTAIN_ORDER_CODES = frozenset({-1000, -1001, -1006, -1007})


def definitive_order_error(code, http_status=None):
    """The exchange answered this order with an explicit, non-timeout error code.

    This alone is not a rejection: only a later original-ID read returning
    `order_absent` proves the order was never created."""
    return (type(code) is int and code < 0 and code not in UNCERTAIN_ORDER_CODES
            and http_status != 408 and not (type(http_status) is int and http_status >= 500))


def order_absent(exc):
    """A clean -2013 for the original client ID, not a throttled or uncertain read."""
    return (isinstance(exc, ExchangeError) and not isinstance(exc, (AmbiguousOrder, RequestNotSent))
            and exc.code == -2013 and not exc.retry_after and exc.http_status in (None, 400, 404))


class BudgetWait(RequestNotSent):
    """The local scheduler must wait; this is not an exchange rejection."""


def api_wait_notice(exc):
    """Expose only typed local quota waits and sanitized exchange throttles."""
    if isinstance(exc, BudgetWait):
        kind = "budget"
    elif isinstance(exc, ExchangeError) and (
            exc.http_status in (418, 429) or exc.code in (-1003, -1015)):
        kind = "rate_limit"
    elif isinstance(exc, ExchangeError) and str(exc).startswith("接口冷却中："):
        kind = "cooldown"
    else:
        return None
    return {"kind": kind, "text": exchange_reason(str(exc))}


class RateBudget:
    def __init__(self, reconciliation_reserve=300, capacity_reserve=0, margin_reserve=0):
        if type(reconciliation_reserve) is not int or reconciliation_reserve < 0:
            raise ExchangeError("订单核对保留额度无效")
        if type(capacity_reserve) is not int or capacity_reserve < 0:
            raise ExchangeError("额度监控保留预算无效")
        if type(margin_reserve) is not int or not 0 <= margin_reserve <= 1800:
            raise ExchangeError("保证金保留预算无效")
        self.lock = threading.Lock()
        self.until, self.window, self.weight = 0.0, time.monotonic(), 0
        self.cooldown_reason = "未记录触发原因"
        self.deadline = self.window + 60
        self.server_minute = None
        self.local_weight, self.reported_weight = 0, None
        self.inflight, self.sequence = {}, 0
        self.unreported = deque()
        self.limit = 1800
        self.reconciliation_reserve = reconciliation_reserve
        self.capacity_reserve = capacity_reserve
        self.margin_reserve = margin_reserve
        self.priority = threading.local()

    @contextmanager
    def margin(self):
        """Funds work alone may use its reserved share of the hard IP limit."""
        previous = getattr(self.priority, "margin", False)
        self.priority.margin = True
        try:
            yield self
        finally:
            self.priority.margin = previous

    def configure_capacity_reserve(self, weight):
        if type(weight) is not int or weight < 0:
            raise ExchangeError("额度监控保留预算无效")
        with self.lock:
            self.capacity_reserve = weight

    @contextmanager
    def capacity_monitoring(self):
        """Keep shared quota discovery moving when account execution is busy."""
        previous = getattr(self.priority, "capacity_monitoring", False)
        self.priority.capacity_monitoring = True
        try:
            yield self
        finally:
            self.priority.capacity_monitoring = previous

    @contextmanager
    def reconciliation(self):
        """Let an existing intent finish without lending its quota to other threads."""
        previous = getattr(self.priority, "reconciliation", False)
        self.priority.reconciliation = True
        try:
            yield self
        finally:
            self.priority.reconciliation = previous

    @contextmanager
    def pair_accounting(self):
        """Fill reporting cannot consume the reserved order-repair budget."""
        previous = getattr(self.priority, "pair_accounting", False)
        self.priority.pair_accounting = True
        try:
            yield self
        finally:
            self.priority.pair_accounting = previous

    def _priority_flags(self):
        return tuple(getattr(self.priority, name, False) for name in
                     ("reconciliation", "pair_accounting", "capacity_monitoring", "margin"))

    @contextmanager
    def _inherit_priority(self, flags):
        previous = self._priority_flags()
        names = ("reconciliation", "pair_accounting", "capacity_monitoring", "margin")
        for name, value in zip(names, flags):
            setattr(self.priority, name, value)
        try:
            yield
        finally:
            for name, value in zip(names, previous):
                setattr(self.priority, name, value)

    def _refresh(self, now):
        if now >= self.deadline:
            steps = int((now - self.deadline) // 60) + 1
            if self.server_minute is not None:
                self.server_minute += steps
            self.deadline += steps * 60
            self.window = self.deadline - 60
            # Requests sent near the boundary may be counted in the new minute.
            self.weight = self.local_weight = self._carry(now)
            self.reported_weight = None

    def _carry(self, now):
        while self.unreported and self.unreported[0][0] <= now - 60:
            self.unreported.popleft()
        return sum(self.inflight.values()) + sum(weight for _, weight in self.unreported)

    def _ordinary_limit(self):
        return self.limit - min(self.reconciliation_reserve, self.limit // 6)

    def _execution_limit(self):
        ordinary_limit = self._ordinary_limit()
        return ordinary_limit - min(self.capacity_reserve, ordinary_limit // 3)

    def _require_available(self, weight, now):
        self._refresh(now)
        if now < self.until:
            raise RequestNotSent(self._cooldown_message(now), retry_after=self.until - now)
        monitoring = getattr(self.priority, "capacity_monitoring", False)
        critical = (getattr(self.priority, "reconciliation", False) and not monitoring
                    and not getattr(self.priority, "pair_accounting", False))
        margin = bool(self.margin_reserve and getattr(self.priority, "margin", False))
        if margin:
            limit = self.limit
        elif monitoring:
            limit = self._ordinary_limit()
        else:
            limit = self.limit if critical else self._execution_limit()
        if not margin:
            limit = min(limit, self.limit - min(self.margin_reserve, self.limit))
        if self.weight + weight > limit:
            message = "本地 API 请求权重预算不足" if critical else "本地普通 API 请求权重预算不足，已为订单核对和补偿保留请求权重"
            if not critical and not monitoring and self.capacity_reserve:
                message = "本地执行 API 请求权重预算不足，已为市场额度监控、订单核对和补偿保留请求权重"
            reported = "未返回" if self.reported_weight is None else str(self.reported_weight)
            message += f"（估算已用权重/本类请求上限 {self.weight}/{limit}，本次需权重 {weight}；本进程计入 {self.local_weight} 权重，Aster 同 IP 回报已用权重 {reported}）"
            raise BudgetWait(message, retry_after=max(0.0, self.deadline - now))

    @staticmethod
    def _validate_weight(weight):
        if type(weight) is not int or weight <= 0:
            raise RequestNotSent("接口请求权重无效")

    def require_available(self, weight=200):
        """Check admission without spending; each actual request still reserves atomically."""
        self._validate_weight(weight)
        with self.lock:
            self._require_available(weight, time.monotonic())

    def reserve(self, weight, *, track=False):
        self._validate_weight(weight)
        with self.lock:
            now = time.monotonic()
            self._require_available(weight, now)
            self.weight += weight
            self.local_weight += weight
            if track:
                self.sequence += 1
                self.inflight[self.sequence] = weight
                return self.sequence
            self.unreported.append((now, weight))

    def finish(self, ticket):
        with self.lock:
            weight = self.inflight.pop(ticket, 0)
            if weight:
                # A timeout is not evidence that the exchange did not count it.
                self.unreported.append((time.monotonic(), weight))

    def cancel_unstarted(self, ticket):
        """Refund only local preparation that failed before HTTP dispatch."""
        with self.lock:
            self._refresh(time.monotonic())
            weight = self.inflight.pop(ticket, 0)
            if weight:
                # Every reset/observation carries this still-pending ticket, so
                # its own reservation can be removed without recomputing or
                # lowering unrelated high-water estimates and IP reports.
                self.weight = max(self.reported_weight or 0, self.weight - weight)
                self.local_weight = max(0, self.local_weight - weight)

    @staticmethod
    def _response_time(headers):
        try:
            date = parsedate_to_datetime(headers.get("Date", ""))
            stamp = date.timestamp()
            if date.tzinfo is not None and abs(stamp - time.time()) <= 300:
                return int(stamp)
        except (ValueError, TypeError, OverflowError, IndexError):
            pass
        return None

    def observe(self, headers, *, ticket=None):
        # Date identifies the exchange minute. Never treat a lower counter alone
        # as a reset: concurrent responses can arrive out of order.
        reported = headers.get("X-MBX-USED-WEIGHT-1M")
        valid_weight = isinstance(reported, str) and re.fullmatch(r"[0-9]{1,12}", reported)
        stamp = self._response_time(headers) if valid_weight else None
        with self.lock:
            now = time.monotonic()
            self._refresh(now)
            completed = self.inflight.pop(ticket, 0)
            if not valid_weight:
                if completed:
                    self.unreported.append((now, completed))
                return
            if stamp is not None:
                minute = stamp // 60
                if self.server_minute is not None and minute < self.server_minute:
                    return  # A delayed response must not revive last minute's use.
                if self.server_minute is not None and minute > self.server_minute:
                    self.weight = self.local_weight = completed + self._carry(now)
                    self.reported_weight = None
                if self.server_minute != minute:
                    self.server_minute = minute
                    # HTTP Date has one-second precision; allow that rounding and
                    # count from receipt, so the local reset cannot happen early.
                    self.deadline = now + 61 - stamp % 60
                    self.window = self.deadline - 60
            self.reported_weight = max(self.reported_weight or 0, int(reported))
            # A response may have been generated before an unreported request
            # reached Aster. Its counter cannot acknowledge that request merely
            # because our timeout (or headerless response) arrived first.
            self.weight = max(self.weight, self.reported_weight + self._carry(now))

    def snapshot(self):
        with self.lock:
            now = time.monotonic()
            self._refresh(now)
            ordinary_limit = self._ordinary_limit()
            execution_limit = self._execution_limit()
            reset_after = max(0.0, self.deadline - now)
            retry_after = max(0.0, self.until - now,
                              reset_after if self.weight >= execution_limit else 0.0)
            return {"used": self.weight, "limit": self.limit, "ordinary_limit": ordinary_limit,
                    "execution_limit": execution_limit, "capacity_reserve": ordinary_limit - execution_limit,
                    "margin_reserve": self.margin_reserve,
                    "local_used": self.local_weight, "aster_ip_used": self.reported_weight,
                    "remaining": max(0, self.limit - self.weight),
                    "ordinary_remaining": max(0, execution_limit - self.weight),
                    "reset_after": reset_after, "retry_after": retry_after}

    def _cooldown_message(self, now):
        remaining = max(0, math.ceil(self.until - now))
        return f"接口冷却中：{self.cooldown_reason}；本次请求时剩余 {remaining} 秒"

    def cooldown_message(self):
        with self.lock:
            return self._cooldown_message(time.monotonic())

    def block(self, seconds, *, reason="未记录触发原因"):
        try:
            seconds = float(seconds)
        except (TypeError, ValueError, OverflowError):
            seconds = 180.0
        if not math.isfinite(seconds) or seconds < 0:
            seconds = 180.0
        with self.lock:
            until = time.monotonic() + seconds
            # Keep the cause of the deadline actually governing admission.
            if until >= self.until:
                self.until = until
                self.cooldown_reason = reason
        return seconds


BUDGET = RateBudget(margin_reserve=120)


def cooldown_reason(method, path, *, status=None, codes=()):
    reasons = {403: "访问被拒绝或被防护规则拦截", 429: "请求频率超限", 418: "IP 被临时封禁",
               -1003: "请求频率或权重超限", -1015: "下单频率超限"}
    details = []
    if status is not None:
        details.append(f"HTTP {status}，{reasons[status]}")
    details.extend(f"错误码 {code}，{reasons[code]}" for code in sorted(set(codes)))
    # Only include the endpoint, never signed parameters or response bodies.
    return f"Aster {'；'.join(details)}；触发接口 {method} {path.split('?', 1)[0]}"


class API:
    def __init__(self, credentials=None, transport=None, budget=None):
        self.credentials = credentials
        self.http = httpx.Client(timeout=httpx.Timeout(8, connect=4), follow_redirects=False, transport=transport)
        self.budget = budget or BUDGET
        self.nonce_lock = threading.Lock()
        self.last_nonce = 0
        self.workspace_control = None
        self.account_writer = None
        self.writer_connection = None
        self._writer_prepared = ContextVar("aster_transport_prepared", default=None)
        self._final_check = ContextVar("aster_transport_final_check", default=None)
        self.http.event_hooks["request"].append(self._before_account_request)

    def _before_account_request(self, request):
        prepared = self._writer_prepared.get()
        if prepared is not None:
            self.account_writer.before_send(prepared, request)
        # Runs after every persistence and shared-admission wait, immediately
        # before the transport; a veto here is still a proven local no-send.
        final_check = self._final_check.get()
        if final_check is not None:
            final_check()

    def signed_parameters(self, params):
        if not self.credentials:
            raise TradingError("账户凭据尚未配置")
        with self.nonce_lock:
            self.last_nonce = max(time.time_ns() // 1000, self.last_nonce + 1)
            nonce = self.last_nonce
        data = {**params, "nonce": str(nonce), "user": self.credentials["user"], "signer": self.credentials["signer"]}
        message = encode_typed_data(full_message={
            "types": {"EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                         {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
                      "Message": [{"name": "msg", "type": "string"}]},
            "primaryType": "Message", "domain": {"name": "AsterSignTransaction", "version": "1", "chainId": 1666,
                         "verifyingContract": "0x0000000000000000000000000000000000000000"},
            "message": {"msg": urlencode(data)},
        })
        signature = EthAccount.sign_message(message, self.credentials["private_key"]).signature.hex()
        data["signature"] = signature if signature.startswith("0x") else "0x" + signature
        return data

    def call(self, method, path, params=None, signed=False, weight=1, *, timeout=None, before_send=None):
        # listenKey creation/renewal only maintains a private read stream. All
        # other signed non-GET calls must pass account admission before signing.
        writer = self.account_writer if signed and method != "GET" and path != "/fapi/v3/listenKey" else None
        if signed and method != "GET" and path != "/fapi/v3/listenKey" and os.environ.get("WORKSPACE_MANAGED") == "1" and writer is None:
            raise RequestNotSent("受管理交易请求未绑定账户保护，未发送请求")
        prepared = writer.prepare(self, method, path, params or {}) if writer is not None else None
        token = self._writer_prepared.set(prepared)
        final_token = self._final_check.set(before_send)
        try:
            try:
                result = self._call(method, path, params, signed, weight, timeout=timeout)
                # Batch rows with a non-whitelisted error code leave only that
                # leg unknown; the other legs' receipts must reach the caller.
                unconfirmed = writer.validate_response(path, params or {}, result) if writer is not None else ()
            except BaseException as exc:
                if writer is not None:
                    transfer_rejected = False
                    if isinstance(exc, TransferRejected):
                        from .margin_balance import REJECTION_CODES
                        transfer_rejected = method == "POST" and path == "/fapi/v3/subAccountTransfer" and type(exc.code) is int and exc.code in REJECTION_CODES
                    if transfer_rejected and prepared is not None:
                        prepared["transfer_rejection_code"] = exc.code
                    writer.finish(prepared, "rejected" if isinstance(exc, RequestNotSent) or transfer_rejected else "unknown")
                raise
            if writer is not None:
                writer.finish(prepared, "unknown" if unconfirmed else "confirmed")
            if unconfirmed:
                result = [{**row, "writer_unconfirmed": True} if index in unconfirmed else row
                          for index, row in enumerate(result)]
            return result
        finally:
            self._final_check.reset(final_token)
            self._writer_prepared.reset(token)

    def _call(self, method, path, params=None, signed=False, weight=1, *, timeout=None):
        with transport_stage("budget_ms"):
            ticket = self.budget.reserve(weight, track=True)
        try:
            try:
                with transport_stage("signing_ms"):
                    params = self.signed_parameters(params or {}) if signed else (params or {})
                    content = urlencode(params) if method != "GET" else None
            except BaseException:
                # No HTTP call has begun. Once request() is entered, failures
                # retain their reservation because delivery may be unknown.
                self.budget.cancel_unstarted(ticket)
                raise
            is_write = signed and method != "GET"
            try:
                control = self.workspace_control
                with transport_stage("http_ms"), (control.mutation() if is_write and control is not None else nullcontext()):
                    response = self.http.request(method, BASE + path,
                        params=params if method == "GET" else None, content=content,
                        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AsterAccountDesk/1.0"},
                        **({"timeout": timeout} if timeout is not None else {}))
            except httpx.HTTPError:
                error = AmbiguousOrder if is_write else ExchangeError
                raise error("请求结果未知，需核对订单" if is_write else "Aster 网络连接失败") from None
            self.budget.observe(response.headers, ticket=ticket)
        finally:
            self.budget.finish(ticket)
        gateway_delay = 0
        if response.status_code in (403, 429, 418):
            delay = {403: 30, 429: 180, 418: 86400}[response.status_code]
            try:
                supplied_delay = float(response.headers.get("Retry-After", "0"))
                if math.isfinite(supplied_delay):
                    delay = max(delay, supplied_delay)
            except ValueError:
                pass
            self.budget.block(delay, reason=cooldown_reason(method, path, status=response.status_code))
            if response.status_code != 403:
                raise ExchangeError(self.budget.cooldown_message(), retry_after=delay, http_status=response.status_code)
            # Preserve a WAF Retry-After even for non-JSON gateway pages, while
            # still honoring an explicit unknown-execution code in a JSON body.
            gateway_delay = delay
        if (response.status_code >= 500 or response.status_code == 408) and is_write:
            raise AmbiguousOrder("Aster 未确认请求结果，需核对订单", http_status=response.status_code)
        try:
            with transport_stage("response_decode_ms"):
                data = response.json()
        except ValueError:
            error = AmbiguousOrder if is_write else ExchangeError
            message = "Aster 返回无法识别的响应"
            if gateway_delay:
                message += f"；{self.budget.cooldown_message()}"
            raise error(message, retry_after=gateway_delay, http_status=response.status_code) from None
        batch_codes = ([row.get("code") for row in data
                        if isinstance(row, dict) and row.get("code") in (-1003, -1015)]
                       if isinstance(data, list) else [])
        if batch_codes:
            # Batch responses may mix fills and rate-limit failures. Retain every
            # receipt so the executor can reconcile/repair the successful leg.
            self.budget.block(180, reason=cooldown_reason(method, path, codes=batch_codes))
        # Only structured error messages cross into durable diagnostics. The
        # actual signed values are available here, before any receipt is saved.
        secrets = [params.get("signature")]
        if self.credentials:
            secrets.extend(self.credentials.get(key) for key in ("private_key", "user", "signer"))
        if isinstance(data, list):
            data = [{**row, "msg": exchange_reason(row.get("msg"), secrets=secrets)}
                    if isinstance(row, dict) and isinstance(row.get("code"), int) and row["code"] < 0 and "msg" in row
                    else row for row in data]
        code = data.get("code") if isinstance(data, dict) else None
        if isinstance(code, int) and code < 0:
            if code in (-1003, -1015):
                self.budget.block(180, reason=cooldown_reason(method, path,
                    status=response.status_code if gateway_delay else None, codes=(code,)))
                raise ExchangeError(self.budget.cooldown_message(), code, retry_after=max(180, gateway_delay), http_status=response.status_code)
            if code in (-1006, -1007) and is_write:
                message = "Aster 请求超时，需核对订单"
                if gateway_delay:
                    message += f"；{self.budget.cooldown_message()}"
                raise AmbiguousOrder(message, code, retry_after=gateway_delay, http_status=response.status_code)
            message = f"Aster 拒绝请求（代码 {code}）"
            if code not in (-1006, -1007):
                message += "：" + (exchange_reason(data.get("msg"), secrets=secrets) or MISSING_REJECT_REASON)
            if gateway_delay:
                message += f"；{self.budget.cooldown_message()}"
            raise ExchangeError(message, code, retry_after=gateway_delay, http_status=response.status_code)
        if not response.is_success:
            message = self.budget.cooldown_message() if gateway_delay else f"Aster HTTP {response.status_code}"
            raise ExchangeError(message, code, retry_after=gateway_delay, http_status=response.status_code)
        return data

    def close(self):
        self.http.close()


def credentials_for(prefix):
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{1,40}", prefix):
        raise TradingError("凭据变量前缀无效")
    values = {key: os.environ.get(prefix + suffix, "") for key, suffix in (
        ("user", "_USER"), ("signer", "_SIGNER"), ("private_key", "_PRIVATE_KEY"))}
    if not all(values.values()):
        raise TradingError("服务器尚未配置该子账户的 API 凭据")
    if any(not re.fullmatch(r"0x[0-9a-fA-F]{40}", values[k]) for k in ("user", "signer")):
        raise TradingError("API 用户或签名地址无效")
    try:
        if EthAccount.from_key(values["private_key"]).address.lower() != values["signer"].lower():
            raise ValueError()
    except (ValueError, TypeError):
        raise TradingError("API 签名密钥与 signer 不匹配") from None
    return values


class PublicCapacitySample(dict):
    """Keep the source time when several consumers share one public response."""

    def __init__(self, values, checked_at):
        super().__init__(values)
        self.checked_at = checked_at


class MarketData:
    def __init__(self, api=None, *, stream=None, depth_stream=None, capacity_relay=None):
        self.api = api or API()
        if capacity_relay is None:
            from .capacity_relay_client import PublicCapacityRelayClient
            capacity_relay = PublicCapacityRelayClient.from_env()
        self.capacity_relay = capacity_relay
        self.stream = stream if stream is not None else PublicQuoteStream()
        self.depth_stream = depth_stream if depth_stream is not None else PublicDepthStream()
        self.rules = {}
        self.assets = {}
        self.assets_lock = threading.Lock()
        self.assets_retry_at = 0
        self.books, self.book_locks = {}, {}
        self.book_guard = threading.Lock()
        self.marks, self.mark_locks = {}, {}
        self.mark_guard = threading.Lock()
        self.depth_locks = {symbol: threading.Lock() for symbol in MARKET_SYMBOLS}
        self.depth_retry_at = {}
        self.public_brackets = {}
        self.public_bracket_guard = threading.Lock()
        self.public_bracket_locks = {symbol: threading.Lock() for symbol in MARKET_SYMBOLS}
        self.public_sample_guard = threading.Lock()
        self.public_samples, self.public_sample_reads = {}, {}

    @property
    def remote_capacity(self):
        return self.capacity_relay is not None

    def uses_capacity_relay(self, symbol):
        """Only gold and silver use the optional remote public-data source."""
        return self.capacity_relay is not None and symbol in CAPACITY_RELAY_SYMBOLS

    def set_capacity_update_listener(self, listener):
        if self.capacity_relay is not None:
            self.capacity_relay.set_update_listener(listener)

    def set_update_listener(self, listener):
        """Forward optional market signals while supporting older injected streams."""
        if listener is not None and not callable(listener):
            raise ValueError("Invalid market update listener")
        for stream in (self.stream, self.depth_stream):
            setter = getattr(stream, "set_update_listener", None)
            if callable(setter):
                setter(listener)

    def start_stream(self):
        try:
            try:
                self.stream.start()
            finally:
                self.depth_stream.start()
        finally:
            if self.capacity_relay is not None:
                self.capacity_relay.start()

    def close_stream(self):
        try:
            try:
                self.stream.close()
            finally:
                self.depth_stream.close()
        finally:
            if self.capacity_relay is not None:
                self.capacity_relay.close()

    @staticmethod
    def market_quantity_limits(lot, market_lot=None):
        """Use quantities satisfying both general and market-specific lot filters."""
        minimums, maximums, steps = [], [], []
        for constraint in (lot,) if market_lot is None else (lot, market_lot):
            if not isinstance(constraint, dict) or any(key not in constraint for key in ("minQty", "maxQty", "stepSize")):
                raise TradingError("市价数量过滤器响应无效")
            minimum, maximum, step = (positive(constraint[key], True) for key in ("minQty", "maxQty", "stepSize"))
            minimums.append(minimum)
            if maximum:
                maximums.append(maximum)
            if step:
                # Rules/plan_pair use a zero-origin grid. Do not silently turn an
                # exchange-supplied offset grid into quantities it would reject.
                if Fraction(minimum) % Fraction(step):
                    raise TradingError("市价数量下限与步长不对齐，无法安全生成委托数量")
                steps.append(Fraction(step))
        if not steps or not maximums:
            # quantityPrecision is expressly not a substitute for stepSize.
            raise TradingError("市价数量规则缺少有效步长或数量上限")
        common_step = Fraction(math.lcm(*(s.numerator for s in steps)), math.gcd(*(s.denominator for s in steps)))
        step = decimal_value(common_step, exact=True)
        minimum, maximum = max(*minimums, step), min(maximums)
        first_lot = -(-Fraction(minimum) // common_step)
        if first_lot * common_step > Fraction(maximum):
            raise TradingError("市价数量上下限没有有效步进，暂停该规则加载")
        return step, minimum, maximum

    @staticmethod
    def _margin_assets(data):
        if not isinstance(data, dict) or not isinstance(data.get("symbols"), list) or not data["symbols"]:
            raise TradingError("交易所保证金资产信息响应无效")
        assets = {}
        for row in data["symbols"]:
            if (not isinstance(row, dict) or not isinstance(row.get("symbol"), str) or not row["symbol"]
                    or not isinstance(row.get("marginAsset"), str) or not row["marginAsset"]
                    or row["symbol"] in assets):
                raise TradingError("交易所保证金资产信息缺失或重复")
            assets[row["symbol"]] = row["marginAsset"]
        return assets

    def margin_asset(self, symbol):
        asset = self.assets.get(symbol)
        if asset is not None:
            return asset
        # Newly listed holdings may postdate startup. Share one read across
        # accounts; unknown symbols and failed reads must not create a loop.
        with self.assets_lock:
            if symbol not in self.assets and time.monotonic() >= self.assets_retry_at:
                self.assets_retry_at = time.monotonic() + 30
                try:
                    assets = self._margin_assets(self.api.call("GET", "/fapi/v3/exchangeInfo"))
                except TradingError as exc:
                    self.assets_retry_at = time.monotonic() + max(30, getattr(exc, "retry_after", 0))
                    raise
                self.assets = assets
            return self.assets.get(symbol)

    @classmethod
    def _market_rule(cls, row):
        order_types = row.get("orderTypes", row.get("OrderType"))
        if order_types is not None:
            if not isinstance(order_types, list) or any(not isinstance(kind, str) for kind in order_types):
                raise TradingError("交易订单类型响应无效")
            if "MARKET" not in order_types:
                return None
        if not isinstance(row.get("filters"), list):
            raise TradingError("交易过滤器响应无效")
        filters = {}
        for constraint in row["filters"]:
            if not isinstance(constraint, dict) or not isinstance(constraint.get("filterType"), str):
                raise TradingError("交易过滤器响应无效")
            kind = constraint["filterType"]
            if kind in filters:
                raise TradingError("交易过滤器重复，无法确认市价数量规则")
            filters[kind] = constraint
        lot, price = filters.get("LOT_SIZE"), filters.get("PRICE_FILTER")
        notional = filters.get("MIN_NOTIONAL", filters.get("NOTIONAL", {}))
        if lot and price and ("notional" in notional or "minNotional" in notional):
            step, minimum, maximum = cls.market_quantity_limits(lot, filters.get("MARKET_LOT_SIZE"))
            return Rules(row["symbol"], step, positive(price["tickSize"]), minimum, maximum,
                positive(notional.get("notional", notional.get("minNotional")), True), row["marginAsset"])
        return None

    def load_rules(self):
        data = self.api.call("GET", "/fapi/v3/exchangeInfo")
        assets = self._margin_assets(data)
        rules = {}
        for row in data["symbols"]:
            # All assets are needed to account for outside holdings, but only the
            # configured strategy universe needs executable MARKET quantity rules.
            if row.get("status") != "TRADING" or row["symbol"] not in MARKET_SYMBOLS:
                continue
            try:
                rule = self._market_rule(row)
            except (TradingError, KeyError, ValueError, TypeError):
                if row["symbol"] in SYMBOLS:
                    raise
                # An unavailable pair-only contract disables its own execution,
                # not startup or rules for the existing account strategies.
                continue
            if rule is not None:
                rules[row["symbol"]] = rule
        with self.assets_lock:
            self.rules, self.assets = rules, assets
        for rate in data.get("rateLimits", []):
            if rate.get("rateLimitType") == "REQUEST_WEIGHT" and rate.get("interval") == "MINUTE" and rate.get("intervalNum") == 1:
                self.api.budget.limit = min(1800, max(1, int(rate["limit"] * .8)))

    def _stream_book(self, symbol):
        try:
            streamed = self.stream.book(symbol)
            if streamed is not None:
                streamed.require_fresh()
                # Only the stream owns WS quotes. A disconnected stream must
                # not leave a second usable copy in the REST fallback cache.
                return streamed
        except TradingError:
            pass
        return None

    def book(self, symbol):
        # A recovered WS feed must not wait behind an in-flight REST fallback.
        streamed = self._stream_book(symbol)
        if streamed is not None:
            return streamed
        with self.book_guard:
            lock = self.book_locks.setdefault(symbol, threading.Lock())
        with lock:
            streamed = self._stream_book(symbol)
            if streamed is not None:
                return streamed
            cached = self.books.get(symbol)
            if cached is not None and 0 <= time.monotonic() - cached[0] < 1:
                try:
                    cached[1].require_fresh()
                    cached[2].require_fresh()
                    return replace(cached[1])
                except TradingError:
                    pass
            self.books.pop(symbol, None)
            started = time.monotonic()
            book, mark = self._read_book(symbol)
            # Network time is part of cache age; a slow read cannot renew it.
            # Book is mutable; consumers must not alter the shared REST copy.
            self.books[symbol] = (started, replace(book), mark)
            return book

    def _stream_mark_price(self, symbol):
        """Only the connected stream owns its mark cache; never copy it to REST."""
        getter = getattr(self.stream, "mark_price", None)
        if callable(getter):
            try:
                value = getter(symbol)
                if value is not None:
                    if not isinstance(value, MarkPrice) or value.symbol != symbol:
                        raise TradingError("标记价交易代码不匹配")
                    value.require_fresh()
                    return value
            except TradingError:
                pass
        return None

    def mark_price(self, symbol):
        """WS-first valuation mark, independent of executable BBO and its lock."""
        value = self._stream_mark_price(symbol)
        if value is not None:
            return value
        return self._rest_mark_price(symbol, allow_stream=True)

    def _rest_mark_price(self, symbol, *, allow_stream=False):
        """Share one REST valuation read without mixing partial WS quotes."""
        with self.mark_guard:
            lock = self.mark_locks.setdefault(symbol, threading.Lock())
        with lock:
            if allow_stream:
                value = self._stream_mark_price(symbol)
                if value is not None:
                    return value
            cached = self.marks.get(symbol)
            if cached is not None and 0 <= time.monotonic() - cached[0] < 1:
                try:
                    cached[1].require_fresh()
                    return cached[1]
                except TradingError:
                    pass
            self.marks.pop(symbol, None)
            started = time.monotonic()
            value = self._read_mark_price(symbol)
            self.marks[symbol] = (started, value)
            return value

    def _read_mark_price(self, symbol):
        started = time.monotonic()
        row = self.api.call("GET", "/fapi/v3/premiumIndex", {"symbol": symbol})
        if not isinstance(row, dict) or row.get("symbol") != symbol:
            raise TradingError(f"{symbol} 备用标记价响应或交易代码无效")
        try:
            timestamp = float(positive(row.get("time"), field=f"{symbol} 备用标记价时间戳（time）")) / 1000
            now, ticks = time.time(), time.monotonic()
            value = MarkPrice(symbol, positive(row.get("markPrice"), field=f"{symbol} 备用标记价（markPrice）"),
                              timestamp, ticks + 3 - (now - timestamp))
            value.require_fresh(now, monotonic=ticks)
        except TradingError as exc:
            raise TradingError(f"{symbol} 备用标记价无效：{exc}；本次查询耗时 {time.monotonic() - started:.3f} 秒。"
                               "已跳过该标记价，等待行情更新；持续发生时检查标记价连接与服务器时钟") from None
        return value

    def _read_book(self, symbol):
        # Account valuation and quote fallback share the same REST mark. Keep a
        # partial WS quote out of this complete REST fallback and fetch BBO last.
        started = time.monotonic()
        mark = self._rest_mark_price(symbol)
        row = self.api.call("GET", "/fapi/v3/ticker/bookTicker", {"symbol": symbol}, weight=1)
        if not isinstance(row, dict):
            raise TradingError("报价响应无效")
        if row.get("symbol") != symbol:
            raise TradingError("报价交易代码不匹配")
        labels = ("盘口（BBO）", "标记价")
        timestamps = [float(positive(row.get("time"), field=f"{symbol} 备用盘口（BBO）时间戳（time）")) / 1000,
                      mark.timestamp]
        now = time.time()
        ages = [now - stamp for stamp in timestamps]
        if any(not -1 <= age <= 3 for age in ages):
            details = []
            for label, age in zip(labels, ages):
                direction = "落后" if age >= 0 else "领先"
                state = "已过期" if age > 3 else "时间超前" if age < -1 else "有效"
                details.append(f"{label}{direction}程序时间 {abs(age):.3f} 秒（{state}）")
            elapsed = time.monotonic() - started
            raise TradingError(f"{symbol} 备用行情时间无效：{'；'.join(details)}；"
                               f"允许落后最多 3 秒、领先最多 1 秒；本次查询耗时 {elapsed:.3f} 秒。"
                               "已跳过该报价，等待行情更新；持续发生时检查行情连接与服务器时钟")
        # BBO I/O may outlive the shared mark, including a wall-clock rollback.
        mark.require_fresh(now)
        book = Book(positive(row["bidPrice"]), positive(row["askPrice"]), positive(row["bidQty"]),
                    positive(row["askQty"]), mark.price, min(timestamps))
        book.require_fresh(now)
        return book, mark

    def depth_weight(self, symbols):
        """Only missing stream seeds may require REST; healthy reads are free."""
        return sum(DEPTH_WEIGHT for symbol in set(symbols)
                   if self.depth_stream.seed_token(symbol) is not None
                   and time.monotonic() >= self.depth_retry_at.get(symbol, 0))

    def depth(self, symbol):
        """Read shared WS depth, obtaining REST only to seed a connected stream."""
        if symbol not in MARKET_SYMBOLS:
            raise TradingError("不支持的深度市场")
        depth = self.depth_stream.snapshot(symbol)
        if depth is not None:
            depth.require_fresh()
            return depth

        with self.depth_locks[symbol]:
            depth = self.depth_stream.snapshot(symbol)
            if depth is not None:
                depth.require_fresh()
                return depth
            token = self.depth_stream.seed_token(symbol)
            if token is None:
                raise TradingError("深度 WS 正在连接或同步，等待有效推送")
            retry_after = self.depth_retry_at.get(symbol, 0) - time.monotonic()
            if retry_after > 0:
                raise ExchangeError("深度正在重新同步，等待重试", retry_after=retry_after)
            # Per-symbol single-flight and cooldown also bound repeated gaps or
            # reconnects. Never turn a failed WS feed into continuous REST polls.
            self.depth_retry_at[symbol] = time.monotonic() + DEPTH_RESYNC_INTERVAL
            started, requested_at = time.monotonic(), time.time()
            try:
                data = self._read_depth(symbol)
            except TradingError as exc:
                self.depth_retry_at[symbol] = max(self.depth_retry_at[symbol],
                    time.monotonic() + getattr(exc, "retry_after", 0))
                raise
            if time.monotonic() - started > DEPTH_MAX_AGE:
                raise TradingError("深度请求耗时过长，等待更新")
            self.depth_stream.seed(symbol, data, token=token, requested_at=requested_at)
            depth = self.depth_stream.snapshot(symbol)
            if depth is None:
                raise TradingError("深度 WS 正在同步，等待连续更新")
            depth.require_fresh()
            return depth

    def _read_depth(self, symbol):
        """Raw REST seed; never expose an unbridged snapshot to consumers."""
        started, requested_at = time.monotonic(), time.time()
        data = self.api.call("GET", "/fapi/v3/depth", {"symbol": symbol, "limit": DEPTH_LIMIT}, weight=DEPTH_WEIGHT)
        if time.monotonic() - started > DEPTH_MAX_AGE:
            raise TradingError("深度请求耗时过长，等待更新")
        if isinstance(data, dict) and data.get("symbol", symbol) != symbol:
            raise TradingError("深度交易代码不匹配")
        DepthSnapshot.from_response(data, requested_at=requested_at)
        return data

    def listing_symbols(self):
        return self.api.call("GET", "/fapi/v3/exchangeInfo")

    def listing_detail(self, symbol, *, alert_leverage=None):
        from .listings import maximum_leverage
        if alert_leverage is not None and (type(alert_leverage) is not int or not 1 <= alert_leverage <= 10000):
            raise TradingError("通知杠杆必须为 1–10000 的整数或最大杠杆")
        _, brackets_checked_at, brackets = self._public_sample(
            monitor.BRACKETS_PATH, symbol, brackets=True, priority=False)
        try:
            leverage, cap = maximum_leverage(brackets, symbol)
        except monitor.MonitorError:
            raise ExchangeError("公开杠杆档位数据无效") from None
        detail = {"max_leverage": leverage, "bracket_cap": str(cap), "brackets_checked_at": brackets_checked_at,
                  "capacity": None, "remaining": None, "checked_at": None, "error": None}
        alert_sample = {"requested_leverage": alert_leverage,
                        "leverage": alert_leverage if alert_leverage is not None else leverage,
                        "capacity": None, "remaining": None, "bracket_cap": None,
                        "checked_at": None, "brackets_checked_at": None, "error": None}
        detail["capacity_alert_sample"] = alert_sample
        try:
            _, checked_at, oi = self._public_sample(monitor.OI_PATH, symbol, priority=False)
        except (monitor.MonitorError, ExchangeError):
            detail["error"] = "最大杠杆对应的公开额度暂不可用，等待重试"
            detail["tier_error"] = "公开档位额度暂不可用，保留上次结果并等待重试"
            alert_sample["error"] = "通知档位公开额度暂不可用，等待重试"
            return detail
        # Display tiers share the exact same source samples as the maximum-tier
        # notification. An unavailable tier is unknown, never a substitute zero.
        tier_capacities = {}
        for tier in (10, 20, 50):
            try:
                capacity, _, _ = monitor.extract_capacity(oi, brackets, symbol, tier)
                tier_capacities[str(tier)] = str(capacity)
            except monitor.MonitorError:
                tier_capacities[str(tier)] = None
        detail.update(tier_capacities=tier_capacities, tier_checked_at=checked_at,
                      tier_brackets_checked_at=brackets_checked_at, tier_error=None)
        alert_sample.update(checked_at=checked_at, brackets_checked_at=brackets_checked_at)
        try:
            amount, remaining, alert_cap = monitor.extract_capacity(oi, brackets, symbol, alert_sample["leverage"])
            alert_sample.update(capacity=str(amount), remaining=str(remaining), bracket_cap=str(alert_cap))
        except monitor.MonitorError:
            alert_sample["error"] = "所选杠杆的公开额度暂不可用，等待重试"
        try:
            capacity, remaining, cap = monitor.extract_capacity(oi, brackets, symbol, leverage)
        except monitor.MonitorError:
            detail["error"] = "最大杠杆对应的公开额度暂不可用，等待重试"
            return detail
        detail.update(capacity=str(capacity), remaining=str(remaining), checked_at=checked_at)
        return detail

    def _public_sample(self, path, symbol, *, brackets=False, priority=True):
        """Share only unsigned public responses, with one in-flight read per key."""
        if self.uses_capacity_relay(symbol):
            # Remote samples already carry their source age in local clock
            # coordinates. Neither receiving nor rereading may freshen them.
            sample = self.capacity_relay.sample("brackets" if brackets else "oi", symbol,
                                               max_age=PUBLIC_BRACKETS_MAX_AGE if brackets else 8)
            self._validate_public_sample(sample[2], symbol, brackets=brackets)
            return sample
        key = path, symbol
        lifetime = PUBLIC_BRACKETS_REFRESH_INTERVAL if brackets else PUBLIC_OI_SHARE_MAX_AGE
        while True:
            with self.public_sample_guard:
                cached = self.public_samples.get(key)
                if cached is not None and 0 <= time.monotonic() - cached[0] < lifetime:
                    return cached
                pending = self.public_sample_reads.get(key)
                owner = pending is None
                if owner:
                    pending = Future()
                    self.public_sample_reads[key] = pending
            if owner:
                break
            try:
                return pending.result()
            except BudgetWait:
                if not priority:
                    raise
                # A listing owner can exhaust ordinary execution quota while
                # the monitor still owns reserved headroom. Only that local
                # admission failure may retry; HTTP/cooldown failures propagate.
                with self.api.budget.capacity_monitoring():
                    self.api.budget.require_available(1)
                with self.public_sample_guard:
                    if self.public_sample_reads.get(key) is pending:
                        self.public_sample_reads.pop(key)
                # Rejoin under the same lock so monitor followers cannot fan out.
        try:
            started, checked_at = time.monotonic(), time.time()
            payload = self._public_json(path, symbol, brackets=brackets, priority=priority)
            self._validate_public_sample(payload, symbol, brackets=brackets)
            sample = started, checked_at, payload
            with self.public_sample_guard:
                self.public_samples[key] = sample
            pending.set_result(sample)
            return sample
        except BaseException as exc:
            # All concurrent consumers see this failure; a failed request cannot
            # publish a new timestamp or turn the previous sample fresh again.
            pending.set_exception(exc)
            raise
        finally:
            with self.public_sample_guard:
                if self.public_sample_reads.get(key) is pending:
                    self.public_sample_reads.pop(key)

    @staticmethod
    def _validate_public_sample(payload, symbol, *, brackets):
        try:
            if brackets:
                from .listings import maximum_leverage
                maximum_leverage(payload, symbol)
            else:
                data = monitor.unwrap(payload)
                if data.get("symbol") != symbol or not isinstance(data.get("leverageOiRemainingMap"), dict):
                    raise monitor.MonitorError("Public capacity symbol or leverage map is invalid")
        except monitor.MonitorError as exc:
            raise ExchangeError(str(exc)) from None

    def _public_json(self, path, symbol, *, brackets=False, priority=True):
        # Reuse the public client's connections; no account signature or data.
        with self.api.budget.capacity_monitoring() if priority else nullcontext():
            ticket = self.api.budget.reserve(1, track=True)
        try:
            try:
                response = self.api.http.request("POST" if brackets else "GET", monitor.BASE + path,
                    params=None if brackets else {"symbol": symbol},
                    json={"symbol": symbol} if brackets else None,
                    headers={"Accept": "application/json", "Cache-Control": "no-cache",
                             "User-Agent": "AsterAccountDesk/1.0"})
            except httpx.HTTPError:
                raise ExchangeError("公共额度网络连接失败") from None
            self.api.budget.observe(response.headers, ticket=ticket)
            if response.status_code in (403, 418, 429):
                delay = {403: 30, 418: 86400, 429: 180}[response.status_code]
                try:
                    supplied = float(response.headers.get("Retry-After", "0"))
                    if math.isfinite(supplied):
                        delay = max(delay, supplied)
                except ValueError:
                    pass
                self.api.budget.block(delay, reason="公共额度接口：" + cooldown_reason(
                    "POST" if brackets else "GET", path, status=response.status_code))
                raise ExchangeError(self.api.budget.cooldown_message(), retry_after=delay, http_status=response.status_code)
            if not response.is_success:
                raise ExchangeError(f"公共额度 HTTP {response.status_code}")
            try:
                return json.loads(response.content, parse_float=monitor.Decimal)
            except ValueError:
                raise ExchangeError("公共额度响应格式异常") from None
        finally:
            self.api.budget.finish(ticket)

    def refresh_public_brackets(self, symbol):
        """Background-only refresh; failed reads never renew the last valid data."""
        with self.public_bracket_locks[symbol]:
            started, _, payload = self._public_sample(monitor.BRACKETS_PATH, symbol, brackets=True)
            try:
                caps = {tier: positive(monitor.extract_bracket_cap(payload, symbol, tier), True)
                        for tier in monitor.SUPPORTED_LEVERAGES}
                # Paired groups follow the account's actual leverage, including
                # levels outside the ordinary 5x / 10x / 20x strategy. Missing levels
                # remain unavailable; never substitute a neighbouring tier.
                for tier in range(1, 126):
                    if tier not in caps:
                        try:
                            caps[tier] = positive(monitor.extract_bracket_cap(payload, symbol, tier), True)
                        except monitor.MonitorError:
                            continue
            except monitor.MonitorError as exc:
                raise ExchangeError(str(exc)) from None
            if time.monotonic() - started >= PUBLIC_BRACKETS_MAX_AGE:
                raise ExchangeError("公共风控档位更新耗时过长")
            with self.public_bracket_guard:
                self.public_brackets[symbol] = (started, caps)

    def capacities(self, symbol, leverages):
        with self.public_bracket_guard:
            cached = self.public_brackets.get(symbol)
        if cached is None or not 0 <= time.monotonic() - cached[0] < PUBLIC_BRACKETS_MAX_AGE:
            raise PublicBracketsUnavailable("公共风控档位尚未就绪或已过期，等待后台更新")
        _, checked_at, data = self._public_sample(monitor.OI_PATH, symbol)
        try:
            oi = monitor.unwrap(data)
            if oi.get("symbol") != symbol:
                raise monitor.MonitorError("Aster returned a different symbol")
            mapping = oi.get("leverageOiRemainingMap")
            if not isinstance(mapping, dict):
                raise monitor.MonitorError("Requested leverage tier missing")
            result = {}
            for tier in set(leverages):
                try:
                    result[tier] = min(positive(monitor.number(mapping.get(str(tier))), True), cached[1][tier])
                except (monitor.MonitorError, KeyError):
                    continue  # Missing is unavailable, never a substituted tier or zero.
        except monitor.MonitorError as exc:
            raise ExchangeError(str(exc)) from None
        if not 0 <= time.monotonic() - cached[0] < PUBLIC_BRACKETS_MAX_AGE:
            raise PublicBracketsUnavailable("公共风控档位已过期，等待后台更新")
        return PublicCapacitySample(result, checked_at)


class LiveBroker:
    mode = "live"

    def __init__(self, credentials, market, api=None):
        self.api = api or API(credentials)
        self.market = market
        self.cached, self.cached_at = {}, {}
        self._snapshot_lock = threading.RLock()
        self._ordinary_read_lock = threading.Lock()
        self._snapshot_generation = 0
        self._private_stream_lock = threading.Lock()
        self._private_stream_callback_lock = threading.RLock()
        self._private_stream_token = None
        self._private_stream_connected = None
        self._adl_on_event = None
        self._adl_on_reconnected = None
        self._private_evidence = PrivateEventEvidence()
        self._private_stream_closed = False
        self.private_stream = None
        self.leverage_snapshot = None

    def set_adl_listener(self, *, on_event=None, on_reconnected=None):
        """Attach local queue callbacks; they must never perform DB or HTTP work."""
        if any(callback is not None and not callable(callback) for callback in (on_event, on_reconnected)):
            raise ValueError("Invalid ADL listener")
        with self._private_stream_callback_lock:
            self._adl_on_event, self._adl_on_reconnected = on_event, on_reconnected

    def start_private_stream(self):
        """Start one private stream; neither construction nor start reads REST here."""
        with self._private_stream_lock:
            if self._private_stream_closed:
                raise TradingError("账户私有数据流已关闭")
            if self.private_stream is None:
                token = object()
                stream = PrivateAccountStream(self.api,
                    on_state=lambda connected: self._private_stream_state(token, connected),
                    on_event=lambda kind: self._private_stream_event(token, kind),
                    on_payload=lambda event: self._private_stream_payload(token, event))
                with self._private_stream_callback_lock:
                    with self._snapshot_lock:
                        self._private_stream_token = token
                        self._private_stream_connected = None
                        self._private_evidence.reset(False)
                self.private_stream = stream
            self.private_stream.start()

    def stop_private_stream(self):
        """Stop private monitoring while keeping this broker's API reusable."""
        with self._private_stream_lock:
            stream, self.private_stream = self.private_stream, None
            with self._private_stream_callback_lock:
                if self._private_stream_token is not None:
                    self._invalidate_snapshot_reads(refresh_modes=True)
                with self._snapshot_lock:
                    self._private_stream_token = None
                    self._private_stream_connected = None
                    self._private_evidence.reset(False)
            if stream is not None:
                stream.close()

    def _private_stream_state(self, token, connected):
        # A stopped stream may finish after a replacement has connected.
        with self._private_stream_callback_lock:
            if token is self._private_stream_token:
                # A stream gap may hide a mode change. Invalidate once per state
                # transition, not on every disconnected retry callback.
                changed = connected is not self._private_stream_connected
                if changed:
                    with self._snapshot_lock:
                        self._private_stream_connected = connected
                        self._private_evidence.reset(connected)
                        self._invalidate_snapshot_reads(refresh_modes=True)
                if changed and self._adl_on_reconnected is not None:
                    self._adl_on_reconnected()

    def _private_stream_event(self, token, kind):
        with self._private_stream_callback_lock:
            if token is self._private_stream_token:
                self._private_account_event(kind)

    def _private_stream_payload(self, token, event):
        with self._private_stream_callback_lock:
            if token is self._private_stream_token:
                with self._snapshot_lock:
                    self._private_evidence.payload(event)
                if self._adl_on_event is not None:
                    self._adl_on_event(event)

    def order_event_receipt(self, order, *, include_active=False):
        """Return fresh matching evidence; active receipts are an explicit opt-in."""
        with self._snapshot_lock:
            return self._private_evidence.order_receipt(order, include_active=include_active)

    def transfer_ws_checkpoint(self, wallet):
        with self._snapshot_lock:
            return self._private_evidence.checkpoint(wallet)

    def transfer_ws_checkpoint_current(self, checkpoint):
        with self._snapshot_lock:
            return self._private_evidence.checkpoint_current(checkpoint)

    def transfer_ws_balance(self, checkpoint, delta, created_at):
        with self._snapshot_lock:
            evidence = self._private_evidence.transfer_balance(checkpoint, delta, created_at)
            if evidence is None:
                return None
            generation = self._snapshot_generation

        def require_current():
            # Commit code already holds this RLock. Never acquire the stream
            # callback lock here: stream callbacks take those locks in reverse.
            with self._snapshot_lock:
                latest = self._private_evidence.transfer_balance(checkpoint, delta, created_at)
                if generation != self._snapshot_generation or latest != evidence:
                    raise SnapshotSuperseded("划转账户事件已变化，等待重新核对")

        return evidence, require_current

    def invalidate_account_reads(self, reason, *, refresh_modes=False):
        self._invalidate_snapshot_reads(refresh_modes=refresh_modes)

    def _invalidate_snapshot_reads(self, *, refresh_modes=False):
        with self._snapshot_lock:
            self._snapshot_generation += 1
            self.leverage_snapshot = None
            if refresh_modes:
                self.cached_at.pop("dual", None)
                self.cached_at.pop("multi", None)

    def _private_account_event(self, kind):
        with self._snapshot_lock:
            self._private_evidence.event(kind)
            self._invalidate_snapshot_reads(refresh_modes=kind not in ("ACCOUNT_UPDATE", "ORDER_TRADE_UPDATE"))

    def _account_write(self, method, path, params, *, weight=1, refresh_modes=False, timeout=None,
                       basis_generation=None, before_send=None):
        # No snapshot HTTP lock: in-flight background results are revoked by
        # generation instead of making a ready order wait for another request.
        with self._snapshot_lock:
            if basis_generation is not None and basis_generation != self._snapshot_generation:
                raise SendBasisExpired("下单依据的账户快照已被账户事件或写入撤销，本批未发送，等待重新规划")
            self.invalidate_account_reads("账户写入开始", refresh_modes=refresh_modes)
            # This write's own invalidation is expected; any later one is not.
            written = self._snapshot_generation
        options = {"timeout": timeout} if timeout is not None else {}
        if basis_generation is not None or before_send is not None:
            def final_check():
                if basis_generation is not None:
                    with self._snapshot_lock:
                        if written != self._snapshot_generation:
                            raise SendBasisExpired("发送前账户发生变化，下单依据已失效，本批未发送，等待重新规划")
                if before_send is not None:
                    before_send()
            options["before_send"] = final_check
        try:
            return self.api.call(method, path, params, signed=True, weight=weight, **options)
        finally:
            # A refresh that started during this write must also be discarded.
            self.invalidate_account_reads("账户写入结束", refresh_modes=refresh_modes)

    def reconciliation_budget(self):
        budget = getattr(self.api, "budget", None)
        return budget.reconciliation() if budget is not None else nullcontext()

    def cached_call(self, key, path, params=None, ttl=300, weight=1):
        with self._snapshot_lock:
            started = time.monotonic()
            if started - self.cached_at.get(key, -1e9) < ttl:
                return self.cached[key]
            generation = self._snapshot_generation
        value = self.api.call("GET", path, params, signed=True, weight=weight)
        with self._snapshot_lock:
            if generation != self._snapshot_generation:
                raise SnapshotSuperseded("账户在查询期间发生变化，等待新快照")
            # Slow reads cannot overwrite a newer result or renew its lifetime.
            if started >= self.cached_at.get(key, -1e9):
                self.cached[key], self.cached_at[key] = value, started
        return value

    def snapshot_weight(self, symbols, *, fresh_modes=False, reuse_account_mode=False):
        with self._snapshot_lock:
            return self._snapshot_weight(symbols, fresh_modes=fresh_modes, reuse_account_mode=reuse_account_mode)

    def _snapshot_weight(self, symbols, *, fresh_modes=False, reuse_account_mode=False, include_brackets=True):
        """Conservative admission estimate using cache expiries, without a request."""
        now = time.monotonic()
        def due(key, ttl):
            # Leave time for this read to complete before reusing an expiring item.
            return now - self.cached_at.get(key, -1e9) + 8 >= ttl
        weight = 10 + len(symbols)  # Balances, all positions, mark-only fallback.
        previous_dual = self.cached.get("dual")
        reuse_dual = (reuse_account_mode and not fresh_modes and isinstance(previous_dual, dict)
                      and previous_dual.get("dualSidePosition") is True
                      and "dual" in self.cached_at and now >= self.cached_at["dual"])
        weight += sum(30 for key, ttl in (("dual", 15), ("multi", MULTI_ASSETS_MODE_MAX_AGE))
                      if not (key == "dual" and reuse_dual) and (fresh_modes or due(key, ttl)))
        if include_brackets:
            weight += sum(1 for symbol in symbols if due("bracket:" + symbol, 5))
        return weight

    def snapshot(self, symbols, fresh_modes=False, *, reuse_account_mode=False):
        with self._ordinary_read_lock:
            return self._snapshot(symbols, fresh_modes=fresh_modes, reuse_account_mode=reuse_account_mode)

    def margin_snapshot_weight(self, symbols, *, fresh_modes=False, reuse_account_mode=False):
        with self._snapshot_lock:
            return self._snapshot_weight(symbols, fresh_modes=fresh_modes,
                                         reuse_account_mode=reuse_account_mode, include_brackets=False)

    def margin_snapshot(self, symbols, *, fresh_modes=False, reuse_account_mode=False):
        """Read collateral risk without depending on opening tiers or capacity.

        Retain the ordinary reader's full positions, mode evidence and revocable
        generation. This read has no opening tiers or leverage-write authority.
        """
        with self._ordinary_read_lock:
            return self._snapshot(symbols, fresh_modes=fresh_modes,
                                  reuse_account_mode=reuse_account_mode, include_brackets=False,
                                  authorize_leverage=False)

    @staticmethod
    def _transfer_wallet_equity(asset):
        """Use the same wallet/PnL scope at preparation and final transfer reads."""
        def amount(field):
            try:
                return dec(asset.get(field))
            except TradingError as exc:
                raise TradingError(f"USD1 划转余额（{field}）：{exc}") from None

        # Keep total-wallet and cross-wallet PnL in their own accounting
        # scopes. Mixing total wallet with cross PnL can hide isolated loss.
        wallet_field, pnl_field = (("walletBalance", "unrealizedProfit") if "walletBalance" in asset
                                   else ("crossWalletBalance", "crossUnPnl"))
        wallet = amount(wallet_field)
        if "marginBalance" in asset:
            equity = amount("marginBalance")
            unrealized = (amount(pnl_field) if pnl_field in asset else
                          decimal_value(Fraction(equity) - Fraction(wallet), exact=True))
        else:
            unrealized = amount(pnl_field)
            equity = decimal_value(Fraction(wallet) + Fraction(unrealized), exact=True)
        return wallet, unrealized, equity

    def transfer_snapshot_weight(self):
        return 5

    def transfer_snapshot(self):
        """Read USD1 transfer balances without claiming any trading evidence.

        Position rows supply a separate, optional display inventory only.
        Market metadata and account modes are not required. The withdrawal limit remains mandatory, and
        account events/writes revoke this read just like an ordinary snapshot.
        """
        with self._ordinary_read_lock:
            with self._snapshot_lock:
                generation = self._snapshot_generation
                self.leverage_snapshot = None
            started = time.time()
            account = self.api.call("GET", "/fapi/v3/accountWithJoinMargin", signed=True, weight=5)
            asset = self._account_asset(account)
            wallet, unrealized, equity = self._transfer_wallet_equity(asset)
            try:
                available = dec(asset.get("availableBalance"))
            except TradingError as exc:
                raise TradingError(f"USD1 划转余额（availableBalance）：{exc}") from None
            snapshot = AccountSnapshot(equity,
                positive(asset.get("maintMargin"), True, field="USD1 维持保证金（maintMargin）"),
                available, wallet, unrealized, [], None, None, None,
                account.get("canTrade") is True, started)
            snapshot.transfer_withdrawable = positive(asset.get("maxWithdrawAmount"), True,
                field="USD1 可划转额度（maxWithdrawAmount）")
            # Display only: USD1 position margin from this same balance read.
            # Do not infer it from empty trading positions, available balance,
            # maintenance margin, or account-wide totals in another asset.
            try:
                snapshot.display_occupied_margin = positive(asset.get("positionInitialMargin"), True)
            except TradingError:
                snapshot.display_occupied_margin = None
            snapshot.display_positions = account_positions(account, started)
            with self._snapshot_lock:
                if generation != self._snapshot_generation:
                    raise SnapshotSuperseded("账户在查询期间发生变化，等待新快照")
                snapshot.require_fresh()
                snapshot.account_read_generation = generation
            return snapshot

    @staticmethod
    def _account_asset(account):
        if (not isinstance(account, dict) or not isinstance(account.get("assets"), list)
                or any(not isinstance(a, dict) for a in account["assets"])):
            raise TradingError("账户资产响应无效")
        assets = [a for a in account["assets"] if a.get("asset") == "USD1"]
        if not assets:
            raise TradingError("账户缺少 USD1 保证金资产")
        if len(assets) != 1:
            raise TradingError("账户 USD1 保证金资产重复")
        return assets[0]

    @staticmethod
    def _account_snapshot(account, asset, positions, symbols, *, hedge, multi, started, brackets=None):
        wallet = dec(asset["crossWalletBalance"])
        account_unrealized = Fraction(dec(asset["crossUnPnl"]))
        # Charge newer losses immediately, without funding additions with an
        # unconfirmed gain. All USD1 positions contribute, including other markets.
        position_unrealized = sum((Fraction(p.unrealized) for p in positions), Fraction(0))
        marked_unrealized = sum((Fraction(p.qty) * (Fraction(p.mark) - Fraction(p.entry)) * (1 if p.side == "LONG" else -1)
                                 for p in positions), Fraction(0))
        selected_pnl = min(account_unrealized, position_unrealized, marked_unrealized)
        unrealized = decimal_value(selected_pnl, exact=True)
        available = decimal_value(Fraction(dec(asset["availableBalance"])) - (account_unrealized - selected_pnl), exact=True)
        equity = decimal_value(Fraction(wallet) + selected_pnl, exact=True)
        return AccountSnapshot(equity, positive(asset["maintMargin"], True, field="USD1 维持保证金（maintMargin）"), available, wallet,
            unrealized, positions, None, hedge, multi, account.get("canTrade") is True,
            started, dict.fromkeys(symbols, TAKER_FEE_ESTIMATE), brackets or {})

    def _require_usd1(self, symbol):
        resolve = getattr(self.market, "margin_asset", None)
        asset = resolve(symbol) if callable(resolve) else self.market.assets.get(symbol)
        if asset is None:
            raise TradingError(f"{symbol} 保证金资产尚未确认，等待交易所市场信息更新")
        if asset != "USD1":
            raise TradingError(f"{symbol} 保证金资产为 {asset}；检测到非 USD1 仓位，需要核对风险范围")

    def _snapshot(self, symbols, fresh_modes=False, *, read=None, started=None, reuse_account_mode=False,
                  include_brackets=True, authorize_leverage=True):
        """Shared parsing; the ordinary path retains its sequential reads."""
        with self._snapshot_lock:
            generation = self._snapshot_generation
            self.leverage_snapshot = None
            # Only paired ordinary reads opt in. The first read, explicit mode
            # checks and mode invalidations still require the dedicated GET.
            # A past positive check is not fresh authority: below, both current
            # authenticated position responses must prove hedge mode again.
            previous_dual = self.cached.get("dual")
            position_mode = (reuse_account_mode and not fresh_modes
                and isinstance(previous_dual, dict) and previous_dual.get("dualSidePosition") is True
                and "dual" in self.cached_at and time.monotonic() >= self.cached_at["dual"])
        started = time.time() if started is None else started
        if read is None:
            def read(key, path, params=None, *, ttl=None, weight=1):
                if ttl is not None:
                    return self.cached_call(key, path, params, ttl=ttl, weight=weight)
                return self.api.call("GET", path, params, signed=True, weight=weight)
        if fresh_modes:
            with self._snapshot_lock:
                self.cached_at.pop("dual", None)
                self.cached_at.pop("multi", None)
        dual = None if position_mode else read("dual", "/fapi/v3/positionSide/dual", ttl=15, weight=30)
        multi = read("multi", "/fapi/v3/multiAssetsMargin", ttl=MULTI_ASSETS_MODE_MAX_AGE, weight=30)
        if (not isinstance(multi, dict) or type(multi.get("multiAssetsMargin")) is not bool
                or (not position_mode and (not isinstance(dual, dict) or type(dual.get("dualSidePosition")) is not bool))):
            raise TradingError("账户持仓或保证金模式响应无效")
        account = read("account", "/fapi/v3/accountWithJoinMargin", weight=5)
        rows = read("positions", "/fapi/v3/positionRisk", weight=5)
        asset = self._account_asset(account)
        account_positions = self._position_rows(account.get("positions"))
        present = self._position_rows(rows)
        if position_mode:
            # As in the cycle reader, LONG/SHORT rows are the current account's
            # mode evidence. Never infer absent legs as flat or accept BOTH,
            # including unrelated flat markets; retain all risk cross-checks.
            if any(side == "BOTH" for _, side in account_positions) or any(side == "BOTH" for _, side in present):
                raise AccountModeError("账户与持仓的双向模式尚未同步，请核对账户模式")
            for symbol in symbols:
                if any((symbol, side) not in account_positions for side in ("LONG", "SHORT")):
                    raise TradingError(f"{symbol} 缺少双向持仓信息，无法复用账户模式核验")
            dual = {"dualSidePosition": True}
        # Some V3 responses omit flat symbols; use authenticated account rows for
        # their configured leverage and margin mode, rather than inventing defaults.
        rows = list(rows)
        for row in account_positions.values():
            if row["symbol"] in symbols and (row["symbol"], row["positionSide"]) not in present:
                if type(row.get("isolated")) is not bool:
                    raise TradingError("账户全仓保证金模式响应无效")
                if dec(row["positionAmt"]):
                    raise TradingError("账户与持仓接口尚未同步")
                rows.append({"symbol": row["symbol"], "positionSide": row["positionSide"], "positionAmt": "0",
                             "entryPrice": "0", "markPrice": "0",
                             "leverage": row["leverage"], "unRealizedProfit": "0", "liquidationPrice": "0",
                             "marginType": "isolated" if row["isolated"] else "cross",
                             "updateTime": row.get("updateTime")})
        positions = []
        for row in rows:
            if row["symbol"] not in symbols and not dec(row["positionAmt"]):
                continue
            self._require_usd1(row["symbol"])
            qty = dec(row["positionAmt"]).copy_abs()
            field_prefix = f"{row['symbol']} {row['positionSide']}"
            entry = positive(row["entryPrice"], allow_zero=not qty, field=f"{field_prefix} 开仓价（entryPrice）")
            positions.append(Position(row["symbol"], row["positionSide"], qty, entry,
                positive(row["markPrice"], True, field=f"{field_prefix} 标记价（markPrice）"),
                self._leverage(row.get("leverage"), field=f"{field_prefix} 实际杠杆（leverage）"), dec(row["unRealizedProfit"]),
                positive(row["liquidationPrice"], True, field=f"{field_prefix} 强平价（liquidationPrice）"),
                isolated=row["marginType"].lower() not in ("cross", "crossed"),
                update_time=self._position_update_time(row)))
        # Never combine balances and positions from different fills.
        represented = {(p.symbol, p.side) for p in positions}
        if any(dec(row["positionAmt"]) and key not in represented for key, row in account_positions.items()):
            raise TradingError("账户全部持仓尚未同步，无法计算总占用保证金")
        for p in positions:
            other = account_positions.get((p.symbol, p.side))
            if not other or dec(other["positionAmt"]).copy_abs() != p.qty or self._leverage(other.get("leverage")) != p.leverage:
                raise TradingError("账户余额与持仓快照正在同步，稍后重试")
            if type(other.get("isolated")) is not bool or other["isolated"] != p.isolated:
                raise TradingError("账户与持仓的保证金模式尚未同步，稍后重试")
        positions = self._fill_missing_marks(positions)
        brackets = {}
        for symbol in symbols if include_brackets else ():
            b = read("bracket:" + symbol, "/fapi/v3/leverageBracket", {"symbol": symbol}, ttl=5)
            if isinstance(b, list):
                if any(not isinstance(item, dict) for item in b):
                    raise TradingError("账户风控档位响应无效")
                matches = [item for item in b if item.get("symbol") == symbol]
                if len(matches) != 1:
                    raise TradingError("账户风控档位缺失或重复")
                b = matches[0]
            if not isinstance(b, dict) or b.get("symbol") != symbol:
                raise TradingError("账户风控档位交易代码不匹配")
            try:
                brackets[symbol] = validate_brackets(b["brackets"])
            except TradingError as exc:
                raise TradingError(f"{symbol}：{exc}") from None
        # External orders are not queried; None must not imply a verified empty
        # order book. Fees are a fixed planning estimate, not a fetched fee rate.
        snapshot = self._account_snapshot(account, asset, positions, symbols, hedge=dual["dualSidePosition"],
            multi=multi["multiAssetsMargin"], started=started, brackets=brackets)
        with self._snapshot_lock:
            if generation != self._snapshot_generation:
                raise SnapshotSuperseded("账户在查询期间发生变化，等待新快照")
            snapshot.account_read_generation = generation
            if fresh_modes and authorize_leverage:
                self.leverage_snapshot = (snapshot, time.monotonic())
        return snapshot

    def require_snapshot_current(self, snapshot):
        """A prepared ordinary read cannot cross an account write or event."""
        with self._snapshot_lock:
            if getattr(snapshot, "account_read_generation", None) != self._snapshot_generation:
                raise TradingError("账户预读结果已失效，等待新快照")
        snapshot.require_fresh()

    @staticmethod
    def _position_rows(rows):
        if not isinstance(rows, list):
            raise TradingError("持仓响应无效")
        result = {}
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get("symbol"), str) or not row["symbol"]
                    or row.get("positionSide") not in ("LONG", "SHORT", "BOTH")):
                raise TradingError("持仓交易代码或方向无效")
            quantity = dec(row.get("positionAmt"))
            if quantity and row["positionSide"] == "BOTH":
                raise AccountModeError("双向账户出现单向持仓，需核对账户模式")
            key = (row["symbol"], row["positionSide"])
            if key in result:
                raise TradingError("持仓接口返回重复记录，无法核对总占用保证金")
            result[key] = row
        return result

    def _fill_missing_marks(self, positions):
        """Resolve zero marks during snapshot reads, never on the cycle hot path."""
        marks = {}
        for position in positions:
            if position.mark != 0 or position.symbol in marks:
                continue
            # Valuation requires only a fresh mark, not an executable BBO.
            # A zero risk mark is never zero exposure.
            try:
                value = self.market.mark_price(position.symbol)
                if not isinstance(value, MarkPrice) or value.symbol != position.symbol:
                    raise TradingError("标记价交易代码不匹配")
                value.require_fresh()
                marks[position.symbol] = value
            except TradingError as exc:
                # Keep the original error type and retry metadata: adding read
                # context must not turn a rate-limit wait into an ordinary error.
                exc.args = (f"{position.symbol} 持仓标记价缺失，补充行情失败，本次账户快照未更新：{exc}",)
                raise
        # Another symbol's fallback may have taken long enough to expire the
        # first result. Do not publish that partially stale valuation set.
        for symbol, value in marks.items():
            try:
                value.require_fresh()
            except TradingError as exc:
                exc.args = (f"{symbol} 补充标记价在账户读取期间失效，本次账户快照未更新：{exc}",)
                raise
        # A mixed pair of a recovered and an older mark would distort its PnL.
        # Revalue both sides together, including positions outside the strategy.
        return [replace(p, mark=marks[p.symbol].price) if p.symbol in marks else p for p in positions]

    @staticmethod
    def _position_update_time(row):
        value = row.get("updateTime")
        if value is None:
            return None
        stamp = positive(value, True)
        if stamp != stamp.to_integral_value() or stamp > dec(str(time.time() + 1)) * 1000:
            raise TradingError("持仓更新时间无效或超前")
        return int(stamp)

    @staticmethod
    def _leverage(value, *, field="账户实际杠杆（leverage）"):
        leverage = positive(value, field=field)
        if not 1 <= leverage <= 125 or leverage != leverage.to_integral_value():
            raise TradingError(f"{field}无效：必须为 1 至 125 的整数（收到 {leverage}）")
        return int(leverage)

    def set_leverage(self, symbol, leverage, *, checked_snapshot=None, before_submit=None):
        require_supported_leverage(leverage)
        verified, self.leverage_snapshot = self.leverage_snapshot, None
        snapshot = (checked_snapshot if verified is not None and checked_snapshot is verified[0]
                    and 0 <= time.monotonic() - verified[1] <= 1 else None)
        if snapshot is not None:
            try:
                snapshot.require_fresh()
            except TradingError:
                snapshot = None
        if snapshot is None:
            snapshot = self.snapshot([symbol], fresh_modes=True)
            self.leverage_snapshot = None
        snapshot.require_modes([symbol])
        long, short = snapshot.require_ready(symbol)
        require_non_decreasing_leverage(long.leverage, leverage)
        if leverage == long.leverage:
            return {"symbol": symbol, "leverage": leverage}
        if before_submit is not None:
            try:
                # This is the last account read, including the stale-token fallback.
                before_submit(snapshot)
                snapshot.require_ready(symbol)
            except RequestNotSent:
                raise
            except TradingError as exc:
                raise RequestNotSent(str(exc), retry_after=getattr(exc, "retry_after", 0)) from None
        try:
            return self._account_write("POST", "/fapi/v3/leverage", {"symbol": symbol, "leverage": str(leverage)}, refresh_modes=True)
        except ExchangeError as exc:
            status_rejected = exc.http_status in LEVERAGE_REJECTION_HTTP_STATUSES and exc.code not in (-1006, -1007)
            code_rejected = not isinstance(exc, AmbiguousOrder) and exc.code in LEVERAGE_REJECTION_CODES
            if not isinstance(exc, RequestNotSent) and (status_rejected or code_rejected):
                raise LeverageRejected(str(exc), code=exc.code, retry_after=max(30, exc.retry_after),
                                       http_status=exc.http_status) from None
            raise

    def submit(self, orders, *, timeout=None, basis_generation=None, before_send=None):
        """``basis_generation`` and ``before_send`` re-check sizing evidence in the final HTTP hook."""
        self.leverage_snapshot = None
        options = {"timeout": timeout} if timeout is not None else {}
        if basis_generation is not None:
            options["basis_generation"] = basis_generation
        if before_send is not None:
            options["before_send"] = before_send
        if len(orders) == 1:
            return [self._account_write("POST", "/fapi/v3/order", orders[0], **options)]
        return self._account_write("POST", "/fapi/v3/batchOrders", {"batchOrders": json.dumps(orders, separators=(",", ":"))}, weight=5, **options)

    def query(self, symbol, client_id, *, timeout=None):
        with self.reconciliation_budget():
            options = {"timeout": timeout} if timeout is not None else {}
            row = self.api.call("GET", "/fapi/v3/order", {"symbol": symbol, "origClientOrderId": client_id}, signed=True, **options)
            if getattr(self.api, "account_writer", None) is not None:
                self.api.account_writer.observe_order(self.api.writer_connection, symbol, client_id, row)
            return row

    def cancel(self, symbol, client_id):
        with self.reconciliation_budget():
            return self._account_write("DELETE", "/fapi/v3/order", {"symbol": symbol, "origClientOrderId": client_id})

    def close(self):
        with self._private_stream_lock:
            self._private_stream_closed = True
        try:
            self.stop_private_stream()
        finally:
            self.api.close()

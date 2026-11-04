"""USD1 transfers between verified subaccounts; never retry an uncertain write.

The caller holds the pair lock and both member-account locks. Transfer identity
comes from authenticated Aster responses, never a locally supplied account name.
"""
from contextlib import ExitStack, contextmanager, nullcontext
from copy import copy, deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
import logging
import math
import re
import time
import uuid
from .account_writer import ADMISSION_CODES, funds_priority, protected_pair, protected_transfer, writer_for
from urllib.parse import urlencode

from eth_account import Account as EthAccount
from eth_account.messages import encode_typed_data

from .exchange import API, AmbiguousOrder, ExchangeError, LiveBroker, RequestNotSent, TransferRejected, api_wait_notice, credentials_for
from .models import TradingError, dec, decimal_value, positive, wire
from .pair_planning import PairRecoveryConflict
from .margin_control import margin_running

LOG = logging.getLogger("aster.trading")


DEFAULT_MARGIN = {"enabled": False, "master_env_prefix": "", "check_interval_seconds": 5,
    "threshold": "10", "min_transfer": "1", "max_transfer": "1000", "buffer_ratio": "0.05",
    "cooldown_seconds": 30}
TRANSFER_TYPES = frozenset({"TRANSFER", "SUBUSER_ASSET_TRANSFER"})
TRANSFER_UNIT = Fraction(Decimal("0.00000001"))
TRANSFER_WS_GRACE_SECONDS = 2
TRANSFER_HISTORY_QUERY_LIMIT = 3
TRANSFER_HISTORY_WAIT_SECONDS = 120
# A skipped unknown transfer is settled only from history. One early read
# after the observation window may confirm it; rejection needs two empty reads
# at least SPACING apart, both taken after the whole SPAN has passed so a late
# processed request is inside the window. The window also starts TOLERANCE
# before the local send time to absorb clock skew. Failed or partial reads are
# bounded by TRANSFER_HISTORY_QUERY_LIMIT, then a person settles it. The shared
# admission refuses new writes on both accounts until then, so SPAN trades a
# trading pause against a transfer the exchange processes minutes late; a wrong
# rejection only moves funds between the pair's own sub-accounts again.
TRANSFER_ABSENCE_READS = 2
TRANSFER_ABSENCE_SPACING_SECONDS = 30
TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS = 180
TRANSFER_CLOCK_TOLERANCE_SECONDS = 60
# Seen receipts are evidence that the transfer may exist. Once one is stored,
# empty reads no longer count toward rejection; a person settles it at the
# bound unless both sides later match the same receipt.
TRANSFER_EVIDENCE_LIMIT = 20
# /income returns at most one page of 1000 rows per window and an active
# account may fill it with commissions and fills. A full page is split by
# time (both halves share the midpoint, so either endTime convention is
# covered and exact duplicates merge) up to this many requests per account;
# a full window of two milliseconds or less, or the bound, leaves the read
# incomplete.
TRANSFER_INCOME_PAGE_ROWS = 1000
TRANSFER_INCOME_MAX_PAGES = 8
SETTLE_WAIT = "结算前共享准入暂停该组账户的新写入，原请求不会重发"
SETTLE_MANUAL = "请人工核对交易所划转记录后结算原请求；结算前共享准入暂停该组账户的新写入，原请求不会重发"
REJECTION_CODES = frozenset({-1002, -1003, -1011, -1015, -1020, -1022, -1100, -1101,
    -1102, -1103, -1104, -1105, -1106, -1111, -1130, -2014, -2015, -2019})


def validate_margin(config):
    if not isinstance(config, dict) or set(config) - set(DEFAULT_MARGIN):
        raise TradingError("保证金平衡配置字段无效")
    value = {**DEFAULT_MARGIN, **config}
    if type(value["enabled"]) is not bool:
        raise TradingError("保证金平衡开关必须是布尔值")
    prefix = value["master_env_prefix"]
    if not isinstance(prefix, str) or (prefix and not re.fullmatch(r"[A-Z][A-Z0-9_]{1,40}", prefix)):
        raise TradingError("主账户凭据变量前缀无效")
    for name, low, high in (("check_interval_seconds", 1, 3600), ("cooldown_seconds", 1, 86400)):
        number = value[name]
        if type(number) not in (int, float) or not math.isfinite(number) or not low <= number <= high:
            raise TradingError("保证金检查间隔或划转冷却时间无效")
    for name in ("threshold", "min_transfer", "max_transfer", "buffer_ratio"):
        amount = positive(value[name], allow_zero=name in {"threshold", "buffer_ratio"})
        if amount > 1000000000 or (name == "buffer_ratio" and amount >= 1):
            raise TradingError("保证金平衡金额或风险缓冲无效")
        value[name] = wire(amount)
    if dec(value["max_transfer"]) < dec(value["min_transfer"]) or dec(value["min_transfer"]) < Decimal("0.00000001"):
        raise TradingError("最大划转金额不得小于最小金额，最小金额至少为 0.00000001 USD1")
    return value


class TransferAPI(API):
    """Only transfer mutations use signer-only auth; ordinary API is unchanged."""

    def __init__(self, credentials=None, transport=None, budget=None, *, before_submit=None):
        super().__init__(credentials, transport=transport, budget=budget)
        self.before_submit = before_submit
        # Snapshot guards run first; shared ownership is checked by API's final
        # request hook immediately after them and before transport dispatch.
        self.http.event_hooks["request"].insert(0, self._before_request)

    def _before_request(self, request):
        # HTTPX calls request hooks after budget admission/signing and before
        # transport dispatch. A revoked read here is definitively NOT sent.
        if request.method != "GET" and self.before_submit is not None:
            try:
                self.before_submit()
            except Exception:
                raise RequestNotSent("划转发送前账户状态已变化，未发送请求") from None

    def _call(self, method, path, params=None, signed=False, weight=1, *, timeout=None):
        try:
            return super()._call(method, path, params, signed, weight, timeout=timeout)
        except ExchangeError as exc:
            # Match the balancer's existing documented rejection policy only
            # for this fixed transfer endpoint. Timeouts/gateway uncertainty
            # and every other signed mutation keep their unknown semantics.
            if (method == "POST" and path == "/fapi/v3/subAccountTransfer" and signed
                    and not isinstance(exc, (AmbiguousOrder, RequestNotSent))
                    and type(exc.code) is int and exc.code in REJECTION_CODES):
                raise TransferRejected("交易所明确拒绝保证金划转", code=exc.code,
                    retry_after=exc.retry_after, http_status=exc.http_status) from None
            raise

    def signed_parameters(self, params):
        if not self.credentials or any(key in params for key in ("user", "signer", "nonce", "signature")):
            raise RequestNotSent("划转签名参数无效，未发送请求")
        with self.nonce_lock:
            self.last_nonce = max(time.time_ns() // 1000, self.last_nonce + 1)
            nonce = self.last_nonce
        data = {**params, "nonce": str(nonce), "signer": self.credentials["signer"]}
        try:
            message = encode_typed_data(domain_data={"name": "AsterSignTransaction", "version": "1",
                "chainId": 1666, "verifyingContract": "0x" + "00" * 20},
                message_types={"Message": [{"name": "msg", "type": "string"}]},
                message_data={"msg": urlencode(data)})
            signature = EthAccount.sign_message(message, self.credentials["private_key"]).signature.hex()
        except Exception:
            raise RequestNotSent("划转无法在本地签名，未发送请求") from None
        data["signature"] = signature if signature.startswith("0x") else "0x" + signature
        return data


def _identifier(value):
    if type(value) is int and value > 0:
        return str(value)
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value):
        return value
    return None


def _address(row):
    addresses = {str(row[key]).lower() for key in ("address", "sourceAddr", "subSourceAddr", "walletAddress")
                 if row.get(key) is not None}
    if len(addresses) > 1 or any(not re.fullmatch(r"0x[0-9a-f]{40}", address) for address in addresses):
        raise TradingError("子账户列表的钱包地址字段冲突或无效")
    return next(iter(addresses), None)


def _public_record(record):
    if not isinstance(record, dict) or not record:
        return None
    return {key: record[key] for key in ("request_id", "source", "destination", "amount", "created_at",
        "status", "confirmed_at", "acknowledged_at", "refreshed_at", "refresh_source", "skipped_at", "transaction_id", "income_type") if key in record}


def _display_amount(value):
    try:
        return wire(value)
    except (TradingError, ArithmeticError, TypeError, ValueError):
        return "未确认"


def _remaining_time(deadline, now):
    if type(deadline) not in (int, float) or type(now) not in (int, float):
        return ""
    try:
        remaining = deadline - now
        if not math.isfinite(remaining):
            return ""
        return f"（本次检查时剩余约 {max(0, math.ceil(remaining))} 秒）"
    except (ArithmeticError, ValueError):
        return ""


class MarginBalancer:
    def __init__(self, engine):
        self.engine = engine
        self.store = engine.store
        self.refreshed_snapshots = None

    def _members(self, pair):
        members = {side: self.store.account(pair[side + "_account_id"]) for side in ("long", "short")}
        if not all(members.values()) or members["long"]["id"] == members["short"]["id"]:
            raise TradingError("保证金平衡需要两个存在且不同的子账户")
        if len({member["mode"] for member in members.values()}) != 1:
            raise TradingError("模拟与实盘账户不能互相划转")
        return members

    @staticmethod
    def _valid_pending(pending):
        if (not isinstance(pending, dict) or not pending
                or pending.get("status") not in {"submitting", "acknowledged", "accepted", "unknown"}
                or {pending.get("source"), pending.get("destination")} != {"long", "short"}
                or not _identifier(pending.get("request_id")) or not isinstance(pending.get("identity"), str)
                or type(pending.get("created_at")) not in (int, float)
                or not math.isfinite(pending["created_at"]) or pending["created_at"] <= 0):
            return False
        try:
            positive(pending.get("amount"))
        except TradingError:
            return False
        return True

    @staticmethod
    def unsettled_rejection(state):
        last = state.get("last_transfer") if isinstance(state, dict) else None
        if not isinstance(last, dict) or "writer_rejection" not in last:
            return False
        evidence = last["writer_rejection"]
        return not isinstance(evidence, dict) or evidence.get("settled") is not True

    @staticmethod
    def unsettled_shared(state):
        """A rejection proof or a skipped unknown transfer still holds a shared write."""
        return MarginBalancer.unsettled_rejection(state) or (
            isinstance(state, dict) and state.get("unsettled_transfers") not in (None, []))

    @staticmethod
    def resume_ready(state):
        """A balance refresh enables reserved trading, never another transfer."""
        pending = state.get("pending") if isinstance(state, dict) else None
        if not MarginBalancer._valid_pending(pending) or pending["status"] != "unknown":
            return False
        stamp = pending.get("trading_baseline_at")
        return (type(stamp) in (int, float) and math.isfinite(stamp)
                and pending["created_at"] <= stamp <= time.time())

    def _verify_pending_identity(self, pair, members, pending):
        if members["long"]["mode"] != "live":
            raise TradingError("模拟划转出现未完成日志，需要核对")
        with self._master(pair, members) as (_, master, children):
            # Existing journals used a symbol-bound identity. Accept that exact
            # legacy binding while new transfers belong only to the accounts.
            identities = {self._fingerprint(pair, members, children, master),
                          self._fingerprint(pair, members, children, master, legacy=True)}
            if pending.get("identity") not in identities:
                raise TradingError("划转待核对记录与当前账户身份不一致")

    def risk_snapshots(self, pair, snapshots, *, recovery=False):
        """Reserve an uncertain outgoing debit on copies of fresh real reads."""
        state = self.store.get("pair_margin:" + pair["id"], {})
        if not isinstance(state, dict):
            raise TradingError("保证金划转日志无效")
        pending = state.get("pending")
        if pending is None:
            return snapshots
        if not self._valid_pending(pending):
            raise TradingError("保证金划转待核对记录无效")
        if pending["status"] not in {"unknown", "submitting"}:
            if recovery:
                return snapshots
            raise TradingError("划转尚未完成余额刷新，暂不新增")
        if not recovery and not self.resume_ready(state):
            raise TradingError("未知划转等待新的保证金基线，暂不新增")
        self._verify_pending_identity(pair, self._members(pair), pending)
        for snapshot in snapshots.values():
            snapshot.require_fresh()
            if not recovery and snapshot.timestamp < pending["trading_baseline_at"]:
                raise TradingError("账户快照早于保证金恢复基线，等待新快照")
        result = dict(snapshots)
        source = pending["source"]
        result[source] = copy(snapshots[source])
        for field in ("available", "equity", "wallet"):
            setattr(result[source], field, decimal_value(
                Fraction(dec(getattr(snapshots[source], field))) - Fraction(positive(pending["amount"])), exact=True))
        return result

    def _resume_unknown(self, pair, members, state, config):
        """Abandon reconciliation after a new read, without claiming settlement."""
        pending = state["pending"]
        saved_pair = self.store.pair(pair["id"])
        if saved_pair is not None and saved_pair != pair:
            raise TradingError("配对组配置已变化，等待重新读取余额")
        brokers = {side: self.engine.broker(member) for side, member in members.items()}
        self._require_budget(members, {side: broker.transfer_snapshot_weight()
            for side, broker in brokers.items()}, reconciliation=True)
        started = time.time()
        snapshots = {}
        for side, broker in brokers.items():
            with getattr(broker, "reconciliation_budget", nullcontext)():
                snapshots[side] = broker.transfer_snapshot()
            snapshots[side].require_fresh()
            if snapshots[side].timestamp < max(started, pending["created_at"]):
                raise TradingError("跳过旧划转前必须重新取得两侧余额，等待新快照")
        with ExitStack() as locks:
            for side in sorted(brokers, key=lambda value: members[value]["id"]):
                locks.enter_context(brokers[side]._snapshot_lock)
            self._verify_pending_identity(pair, members, pending)
            self._check_snapshots(pair, snapshots)
            done = {**pending, "status": "skipped", "refresh_source": "rest"}
            updated = {**state, "pending": None, "last_transfer": done}
            # Skipping only releases the private reservation. The exact shared
            # write stays unknown until bounded history settles it before the
            # next transfer; otherwise every later transfer is ACCOUNT_UNRESOLVED.
            follow_up = {key: deepcopy(pending[key]) for key in ("request_id", "source", "destination", "amount",
                "created_at", "identity", "transaction_id", "before_receipts")
                if key in pending and (pending[key] or key not in ("transaction_id", "before_receipts"))}
            if writer_for(self.engine).enabled:
                updated["unsettled_transfers"] = [*state.get("unsettled_transfers", []),
                    {**follow_up, "failures": 0, "empty": 0, "evidence": []}]
            for field in ("api_notice", "blocked_reason", "retry_without_blocking"):
                updated.pop(field, None)
            archive = {"pair_id": pair["id"], "original": pending, "result": done,
                "baseline": {side: {"account_id": members[side]["id"], "timestamp": value.timestamp,
                    **{field: wire(getattr(value, field)) for field in ("available", "equity", "wallet")}}
                    for side, value in snapshots.items()}}
            key = "pair_margin:" + pair["id"]
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
                from .pair_legacy import without_cycle
                current_pair = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
                if (row is None or json.loads(row[0]) != state
                        or (without_cycle(json.loads(current_pair[0])) if current_pair else None) != saved_pair):
                    raise TradingError("划转记录或配对配置已变化，保留原请求并重新检查")
                for side, broker in brokers.items():
                    account = db.execute("SELECT data FROM accounts WHERE id=?", (members[side]["id"],)).fetchone()
                    if account is None or self.store.account_defaults(json.loads(account[0])) != members[side]:
                        raise TradingError("划转成员配置已变化，等待重新读取余额")
                    broker.require_snapshot_current(snapshots[side])
                now = time.time()
                done.update(skipped_at=now, refreshed_at=now)
                updated.update(
                    cooldown_until=max(state.get("cooldown_until", 0), now + config["cooldown_seconds"]),
                    next_check_at=max(state.get("next_check_at", 0), now + config["check_interval_seconds"]))
                db.execute("INSERT INTO kv(key,data) VALUES (?,?)",
                    ("pair_margin_skipped:" + pair["id"] + ":" + pending["request_id"], json.dumps(archive)))
                db.execute("UPDATE kv SET data=? WHERE key=?", (json.dumps(updated), key))
            state.clear()
            state.update(updated)
            self.refreshed_snapshots = snapshots
        self._invalidate(members)
        return self._view(state, config, "skipped",
            "旧划转核对已跳过，两侧余额已重新读取；按新余额继续运行，不再额外预留旧金额。原请求已归档，未标记成功且不会重发", blocks=True)

    def _require_budget(self, members, weights, *, reconciliation=False):
        """Admit a complete read group before spending on its first account."""
        groups = {}
        for side, weight in weights.items():
            broker = self.engine.broker(members[side])
            budget = getattr(getattr(broker, "api", None), "budget", None)
            if budget is not None and weight:
                group = groups.setdefault(id(budget), [broker, budget, 0])
                group[2] += weight
        for broker, budget, weight in groups.values():
            priority = getattr(broker, "reconciliation_budget", nullcontext)() if reconciliation else nullcontext()
            with priority:
                budget.require_available(weight)

    def _live_budget_weights(self, pair, members, snapshots, snapshot_guards=None):
        # Listing and POST use the long member's shared budget. Each member
        # additionally needs its fresh account withdrawal limit.
        weights = {"long": 15, "short": 5}
        for side, member in members.items():
            if (type(getattr(snapshots[side], "account_read_generation", None)) is not int
                    and not callable((snapshot_guards or {}).get(side))):
                weights[side] += self.engine.broker(member).transfer_snapshot_weight()
        return weights

    @contextmanager
    def _master(self, pair, members):
        config = validate_margin(pair.get("margin", {}))
        prefix = config["master_env_prefix"]
        if not prefix or prefix in {member["env_prefix"] for member in members.values()}:
            raise TradingError("请配置独立的主账户 API signer 环境变量前缀")
        master = credentials_for(prefix)
        children = {side: credentials_for(member["env_prefix"]) for side, member in members.items()}
        users = [value["user"].lower() for value in children.values()]
        signers = [value["signer"].lower() for value in children.values()]
        if len(set(users)) != 2 or master["user"].lower() in users:
            raise TradingError("划转成员必须是主账户下两个不同子账户")
        if master["signer"].lower() in signers or master["signer"].lower() == master["user"].lower():
            raise TradingError("划转必须使用独立授权的主账户 API signer")
        budget = getattr(getattr(self.engine.broker(members["long"]), "api", None), "budget", None)
        api = API(master, budget=budget)
        writer_for(self.engine).bind_api(api, "master:" + prefix)
        try:
            yield api, master, children
        finally:
            api.close()

    def _account_rows(self, members):
        return {side: self.engine.broker(member).api.call("GET", "/fapi/v3/accountWithJoinMargin",
            signed=True, weight=5) for side, member in members.items()}

    @staticmethod
    def _verify(listing, children, accounts):
        if not isinstance(listing, list) or not listing or any(not isinstance(row, dict) for row in listing):
            raise TradingError("主账户子账户列表响应无效，无法确认归属")
        if any(type(row.get("parentAccount")) is not bool for row in listing):
            raise TradingError("子账户列表缺少明确的主子账户标记")
        parents = [row for row in listing if row["parentAccount"]]
        if len(parents) != 1:
            raise TradingError("子账户列表未唯一标识主账户")
        ids = [_identifier(row.get("accountId")) for row in listing]
        if any(value is None for value in ids) or len(set(ids)) != len(ids):
            raise TradingError("子账户列表包含缺失或重复的账户标识")
        found = []
        for side, credentials in children.items():
            address = credentials["user"].lower()
            raw = accounts.get(side)
            if not isinstance(raw, dict):
                raise TradingError("子账户信息响应无效，无法确认归属")
            raw_id = _identifier(raw.get("accountId"))
            matches = [row for row in listing if _address(row) == address]
            if not matches and raw_id:
                matches = [row for row in listing if _identifier(row.get("accountId")) == raw_id]
            if len(matches) != 1 or matches[0]["parentAccount"]:
                raise TradingError("无法核实同主账户归属：需要子账户列表地址，或账户信息中的 accountId 与列表一致")
            row = matches[0]
            if raw_id and raw_id != _identifier(row["accountId"]):
                raise TradingError("子账户地址与账户标识不一致")
            if _address(row) is not None and _address(row) != address:
                raise TradingError("子账户标识对应的钱包地址不一致")
            if row.get("status", row.get("subAccountStatus")) in {"FROZEN", "FREEZE"}:
                raise TradingError("子账户已冻结，禁止划转")
            found.append(_identifier(row["accountId"]))
        if len(set(found)) != 2:
            raise TradingError("两个凭据解析为同一个子账户")

    def verify_members(self, pair):
        """Read-only ownership check used when enabling a live pair."""
        members = self._members(pair)
        if members["long"]["mode"] == "paper":
            return {"verified": True, "mode": "paper"}
        with self._master(pair, members) as (api, master, children):
            listing = api.call("GET", "/fapi/v3/getSubAccountList", signed=True, weight=5)
            self._verify(listing, children, self._account_rows(members))
        return {"verified": True, "mode": "live"}

    @staticmethod
    def _fingerprint(pair, members, children=None, master=None, *, legacy=False):
        binding = {"pair": pair["id"],
            "members": {side: {"id": member["id"], "mode": member["mode"], "prefix": member["env_prefix"]}
                        for side, member in members.items()}}
        if legacy:
            binding["symbol"] = pair.get("symbol", "XAUUSD1")
        if children is not None:
            binding["users"] = {side: value["user"].lower() for side, value in children.items()}
        if master is not None:
            binding["master"] = master["user"].lower()
        return hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()

    @staticmethod
    def _check_snapshots(pair, snapshots):
        if set(snapshots) != {"long", "short"}:
            raise TradingError("保证金平衡缺少两侧账户快照")
        for snapshot in snapshots.values():
            snapshot.require_fresh()
            for number in (snapshot.available, snapshot.wallet, snapshot.equity):
                dec(number)

    @staticmethod
    def _balance_delta(snapshots):
        return Fraction(dec(snapshots["long"].available)) - Fraction(dec(snapshots["short"].available))

    @staticmethod
    def _may_need_transfer(snapshots, config):
        # This upper bound can only skip a new transfer. A candidate still needs
        # ownership, withdrawal, cash buffer and revocable-read checks below.
        difference = abs(MarginBalancer._balance_delta(snapshots))
        if difference <= Fraction(dec(config["threshold"])):
            return False
        units = difference // (2 * TRANSFER_UNIT)
        return units * TRANSFER_UNIT >= Fraction(dec(config["min_transfer"]))

    @staticmethod
    def _no_transfer_reason(snapshots, config, diagnostics=None):
        """Explain a rejected plan using the same already-validated read only."""
        difference = abs(MarginBalancer._balance_delta(snapshots))
        threshold = Fraction(dec(config["threshold"]))
        minimum = Fraction(dec(config["min_transfer"]))
        detail = f"本次检查两侧可用余额差 {_display_amount(difference)} USD1"
        if difference <= threshold:
            detail += f"，未超过划转门槛 {_display_amount(threshold)} USD1（须严格大于）"
        else:
            rounded_half = (difference // (2 * TRANSFER_UNIT)) * TRANSFER_UNIT
            if rounded_half < minimum:
                detail += (f"；差额一半按划转精度向下取整为 {_display_amount(rounded_half)} USD1，"
                           f"低于最小划转额 {_display_amount(minimum)} USD1")
            elif diagnostics:
                detail += "；" + diagnostics["reason"]
            else:
                detail += (f"；来源账户按可划余额、单次限额与现金保留共同约束后，"
                           f"按划转精度取整后的安全可划金额低于最小划转额 {_display_amount(minimum)} USD1")
        return detail + "；本次不划转，后续按检查间隔重新评估"

    @staticmethod
    def _plan(pair, members, snapshots, config, withdrawable, *, diagnostics=None):
        delta = MarginBalancer._balance_delta(snapshots)
        if abs(delta) <= dec(config["threshold"]):
            return None
        source, destination = ("long", "short") if delta > 0 else ("short", "long")
        snapshot = snapshots[source]
        buffer = Fraction(dec(config["buffer_ratio"]))
        # The exchange's withdrawal limit already accounts for positions and
        # reserved funds. Opening-strategy limits do not govern a funds transfer.
        equity = max(Fraction(0), Fraction(dec(snapshot.equity)))
        cash_room = Fraction(snapshot.available) - equity * buffer
        constraints = {"余额差的一半": Fraction(abs(delta)) / 2,
            "单次上限": Fraction(dec(config["max_transfer"])),
            "来源账户可划余额": Fraction(positive(withdrawable[source], True)),
            "现金保留": cash_room}
        amount = min(constraints.values())
        amount = max(Fraction(0), amount)
        units = amount // TRANSFER_UNIT
        rounded = Decimal(int(units)) * Decimal("0.00000001")
        if rounded < dec(config["min_transfer"]):
            if diagnostics is not None:
                def cash(value):
                    return wire(Decimal(int(max(Fraction(0), value) // TRANSFER_UNIT)) * Decimal("0.00000001"))
                limited = "、".join(f"{name}（可划 {cash(value)} USD1）" for name, value in constraints.items()
                    if max(Fraction(0), value) // TRANSFER_UNIT * TRANSFER_UNIT < dec(config["min_transfer"]))
                side = "A 多侧" if source == "long" else "B 空侧"
                diagnostics["reason"] = (
                    f"转出侧 {side}；现金保留 {cash(equity * buffer)} USD1；"
                    f"限制项：{limited}；共同约束后的安全可划金额 {wire(rounded)} USD1，"
                    f"低于最小划转额 {_display_amount(Fraction(dec(config['min_transfer'])))} USD1")
            return None
        return {"source": source, "destination": destination, "amount": wire(rounded)}

    @staticmethod
    def _view(state, config, status, reason, *, blocks=False, plan=None):
        notice = state.get("api_notice")
        notice = ({"kind": notice["kind"], "text": notice["text"]}
                  if isinstance(notice, dict) and notice.get("kind") in {"budget", "cooldown", "rate_limit"}
                  and isinstance(notice.get("text"), str) and notice["text"] else None)
        resumed = (MarginBalancer.resume_ready(state) and not blocks
                   and (not state.get("blocked_reason") or state.get("retry_without_blocking")))
        result = {"enabled": config["enabled"], "status": status, "reason": reason,
            "blocks_trading": bool(blocks or state.get("pending") and not resumed),
            "trading_resume_allowed": resumed, "checked_at": state.get("checked_at"),
            "pending": _public_record(state.get("pending")), "last_transfer": _public_record(state.get("last_transfer")),
            "plan": plan, "next_check_at": state.get("next_check_at", 0), "cooldown_until": state.get("cooldown_until", 0),
            "api_notice": notice,
            "error": state["blocked_reason"] if isinstance(state.get("blocked_reason"), str) and state["blocked_reason"].strip() else None}
        deadline = state.get("next_check_at", 0)
        if notice and type(deadline) in (int, float) and math.isfinite(deadline):
            result["retry_after"] = max(0, deadline - time.time())
        return result

    @staticmethod
    def status_view(pair, journal, runtime_view=None, *, control=None):
        """Project the durable journal without letting an older view hide a write."""
        config = validate_margin(pair.get("margin", {}))
        if journal is None:
            journal = {}
        if not isinstance(journal, dict):
            return MarginBalancer._view({}, config, "blocked", "保证金划转日志无效，停止新开仓和新划转；请人工核对服务器日志与交易所划转记录", blocks=True)
        view = lambda status, reason, **kwargs: MarginBalancer._view(journal, config, status, reason, **kwargs)
        if MarginBalancer.unsettled_rejection(journal):
            return view("blocked", "划转拒绝回执已保存，等待恢复共享结算；完成前保留原配对配置和账户绑定", blocks=True)
        pending = journal.get("pending")
        records = journal.get("unsettled_transfers")
        if pending is None and records not in (None, []):
            # Mirrors _settle_skipped(): visible even while disabled or paused.
            # The latest check explains the exact step; the durable follow-up
            # guarantees that explanation is still current.
            if (isinstance(runtime_view, dict) and runtime_view.get("pending") is None
                    and runtime_view.get("blocks_trading") is True
                    and runtime_view.get("status") in {"unknown", "blocked"}
                    and isinstance(runtime_view.get("reason"), str)):
                return view(runtime_view["status"], runtime_view["reason"], blocks=True)
            exhausted = not isinstance(records, list) or any(not MarginBalancer._valid_unsettled(record)
                or record["failures"] >= TRANSFER_HISTORY_QUERY_LIMIT for record in records)
            if exhausted:
                return view("blocked", "上次结果未知的划转无法自动核实；" + SETTLE_MANUAL, blocks=True)
            return view("unknown", "上次划转结果未知，系统正在有限次核对两侧划转流水并结算；" + SETTLE_WAIT, blocks=True)
        if pending is not None:
            if not isinstance(pending, dict) or pending.get("status") not in {"submitting", "unknown", "accepted", "acknowledged"}:
                return view("blocked", "保证金划转待核对记录无效，停止新开仓和新划转；请人工核对服务器日志与交易所划转记录", blocks=True)
            status = "unknown" if pending["status"] == "submitting" else pending["status"]
            if MarginBalancer.resume_ready(journal) and (not journal.get("blocked_reason") or journal.get("retry_without_blocking")):
                return view("unknown", f"等待重新读取两侧余额后跳过旧划转；读取成功前仍预留 {pending['amount']} USD1，不重发原请求")
            reasons = {"unknown": "划转结果未知，等待重新读取两侧余额后自动跳过旧核对；原请求会归档，不会重发或标记为成功",
                "accepted": "划转请求已受理，系统有限次查询两侧 USD1 流水；仍无法匹配时重新读取两侧余额并归档旧请求",
                "acknowledged": "交易所已确认划转，系统继续读取两侧最新余额；刷新前不开始新开仓或新划转"}
            return view(status, journal.get("blocked_reason") or reasons[status], blocks=True)
        # Match tick(): a corrupt journal stays visible even while disabled or
        # paused, instead of surfacing only after the balancer is re-enabled.
        for field in ("checked_at", "next_check_at", "cooldown_until"):
            value = journal.get(field)
            if field in journal and (type(value) not in (int, float) or not math.isfinite(value)):
                return view("blocked", "保证金划转日志时间无效", blocks=True)
        if not config["enabled"]:
            return view("disabled", "自动保证金平衡未启用")
        if not margin_running(pair, control):
            return view("paused", "配对组已暂停，不发起新划转；已有划转仍继续只读核对，需启动配对组后才重新评估新划转")
        if journal.get("blocked_reason"):
            return view("waiting" if journal.get("retry_without_blocking") else "blocked", journal["blocked_reason"],
                        blocks=not journal.get("retry_without_blocking"))
        if time.time() < journal.get("cooldown_until", 0):
            return view("cooldown", "划转冷却中" + _remaining_time(journal["cooldown_until"], time.time())
                        + "；结束后重新评估划转条件")
        # An execution view can explain a current check, but cannot resurrect a
        # pending write, reuse an old transfer, or override changed configuration.
        if (isinstance(runtime_view, dict) and runtime_view.get("enabled") == config["enabled"]
                and runtime_view.get("checked_at") == journal.get("checked_at")
                and runtime_view.get("pending") is None
                and runtime_view.get("last_transfer") == _public_record(journal.get("last_transfer"))
                and runtime_view.get("status") in {"waiting", "confirmed", "acknowledged", "paper_confirmed", "rejected", "skipped", "blocked"}
                and isinstance(runtime_view.get("reason"), str)):
            plan = runtime_view.get("plan")
            plan = {key: plan[key] for key in ("source", "destination", "amount") if key in plan} if isinstance(plan, dict) else None
            return view(runtime_view["status"], runtime_view["reason"], blocks=runtime_view.get("blocks_trading") is True, plan=plan)
        return view("waiting", "等待系统下一次保证金检查" + _remaining_time(journal.get("next_check_at"), time.time())
                    + "；满足余额差额及安全可划条件后才发起划转")

    def _income(self, members, start, end, *, reconciliation=False, observation=None):
        self._require_budget(members, {side: 30 for side in members}, reconciliation=reconciliation)
        result = {}
        for side, member in members.items():
            broker = self.engine.broker(member)
            windows, rows, seen, pages = [(start, end)], [], set(), 0
            while windows:
                low, high = windows.pop()
                if pages >= TRANSFER_INCOME_MAX_PAGES:
                    raise TradingError(f"划转流水超过 {TRANSFER_INCOME_MAX_PAGES} 段读取上限，无法完整核对")
                pages += 1
                page = self._income_page(broker, low, high, reconciliation, observation)
                if observation is not None:
                    # Receipts already read stay usable as evidence when a
                    # later page or side fails.
                    observation.setdefault("rows", {}).setdefault(side, []).extend(page)
                if len(page) >= TRANSFER_INCOME_PAGE_ROWS:
                    if high - low <= 1:
                        raise TradingError("划转流水在极短时间窗内超过单页上限，无法完整核对")
                    middle = (low + high) // 2
                    # Pop order reads the earlier half first.
                    windows += [(middle, high), (low, middle)]
                    continue
                for row in page:
                    identity = json.dumps(row, sort_keys=True, default=str)
                    if identity not in seen:
                        seen.add(identity)
                        rows.append(row)
            result[side] = rows
        return result

    @staticmethod
    def _income_page(broker, start, end, reconciliation, observation):
        priority = getattr(broker, "reconciliation_budget", nullcontext)() if reconciliation else nullcontext()
        with priority:
            try:
                rows = broker.api.call("GET", "/fapi/v3/income",
                    {"startTime": start, "endTime": end, "limit": TRANSFER_INCOME_PAGE_ROWS}, signed=True, weight=30)
            except RequestNotSent:
                raise
            except ExchangeError as exc:
                # A local cooldown has not made a historical query. An
                # actual network failure still consumes one bounded round.
                notice = api_wait_notice(exc)
                if observation is not None and not (notice and notice["kind"] == "cooldown"
                        and exc.http_status is None and exc.code is None):
                    observation["queried"] = True
                raise
            else:
                if observation is not None:
                    observation["queried"] = True
        if not isinstance(rows, list) or len(rows) > TRANSFER_INCOME_PAGE_ROWS or any(not isinstance(row, dict) for row in rows):
            raise TradingError("划转流水不完整，无法核对")
        for row in rows:
            # Only a row that is clearly another asset or type may be left
            # out; an unreadable candidate makes the read incomplete instead
            # of looking like the transfer is absent.
            asset, kind = row.get("asset"), row.get("incomeType")
            if not isinstance(asset, str) or not isinstance(kind, str):
                raise TradingError("划转流水含无法分类的记录，无法核对")
            if asset != "USD1" or kind not in TRANSFER_TYPES:
                continue
            try:
                if not _identifier(row.get("tranId")):
                    raise TradingError("缺少流水编号")
                dec(row.get("time"))
                dec(row.get("income"))
            except TradingError:
                raise TradingError("划转流水含无法解析的 USD1 划转记录，无法核对") from None
        return rows

    @staticmethod
    def _receipt_matches(pending, rows, state, start, end):
        """Return unused USD1 transfer receipts per side: [source debits, destination credits]."""
        matches = []
        for side, sign in ((pending["source"], -1), (pending["destination"], 1)):
            found = set()
            for row in rows[side]:
                txn = _identifier(row.get("tranId"))
                kind = row.get("incomeType")
                if row.get("asset") != "USD1" or kind not in TRANSFER_TYPES or not txn:
                    continue
                if pending.get("transaction_id") and txn != pending["transaction_id"]:
                    continue
                if [kind, txn] in pending.get("before_receipts", {}).get(side, []):
                    continue
                if [kind, txn] in state.get("used_receipts", []):
                    continue
                try:
                    stamp = dec(row.get("time"))
                    amount = dec(row.get("income"))
                except TradingError:
                    continue
                if start <= stamp <= end and amount == dec(pending["amount"]) * sign:
                    found.add((kind, txn))
            matches.append(found)
        return matches

    @staticmethod
    def _valid_unsettled(record):
        if not (isinstance(record, dict) and _identifier(record.get("request_id"))
                and {record.get("source"), record.get("destination")} == {"long", "short"}
                and isinstance(record.get("identity"), str)
                and type(record.get("created_at")) in (int, float) and math.isfinite(record["created_at"])
                and record["created_at"] > 0
                and type(record.get("failures")) is int and 0 <= record["failures"] <= TRANSFER_HISTORY_QUERY_LIMIT
                and type(record.get("empty")) is int and 0 <= record["empty"] <= TRANSFER_ABSENCE_READS
                and ("queried_at" not in record or type(record["queried_at"]) in (int, float)
                     and math.isfinite(record["queried_at"]))
                and isinstance(record.get("before_receipts", {}), dict)
                and (record.get("transaction_id") is None or _identifier(record["transaction_id"]))):
            return False
        evidence = record.get("evidence", [])
        if not (isinstance(evidence, list) and len(evidence) <= TRANSFER_EVIDENCE_LIMIT
                and all(isinstance(item, list) and len(item) == 3 and item[0] in ("long", "short")
                        and item[1] in TRANSFER_TYPES and _identifier(item[2]) == item[2] for item in evidence)
                # Evidence voids any absence streak; both at once is corrupt.
                and not (evidence and record["empty"])):
            return False
        try:
            positive(record.get("amount"))
        except TradingError:
            return False
        return True

    def _settle_skipped(self, pair, members, state, config):
        """Settle the shared write of a skipped unknown transfer; never resend it.

        Returns the view to show while it is unsettled, else None. Until then
        the shared admission refuses new writes on these accounts, so every
        view says trading waits; an unexpected failure only delays the check.
        """
        try:
            return self._settle_skipped_records(pair, members, state, config)
        except Exception as exc:  # noqa: BLE001 - surface as a retry, never crash the tick
            LOG.warning("pair %s skipped transfer settlement failed: %s", pair["id"], type(exc).__name__)
            return self._view(state, config, "unknown", "未知划转的共享结算暂未完成（" + str(exc)[:200]
                + "），稍后重试；" + SETTLE_WAIT, blocks=True)

    def _settle_skipped_records(self, pair, members, state, config):
        """Confirm from one-to-one receipts, reject from two late empty reads."""
        records = state.get("unsettled_transfers")
        if records is None:
            return None
        key = "pair_margin:" + pair["id"]
        writer = writer_for(self.engine)
        if not writer.enabled:
            # Standalone runs keep no shared write to settle.
            state.pop("unsettled_transfers", None)
            self.store.put(key, state)
            return None
        view = lambda status, reason: self._view(state, config, status, reason, blocks=True)
        if not isinstance(records, list) or any(not self._valid_unsettled(record) for record in records):
            return view("blocked", "未知划转的结算记录无效；" + SETTLE_MANUAL)
        migrated = False
        for record in records:
            if "evidence" not in record:
                # Written before evidence was kept: a partial or failed read
                # may sit between its empty reads, so restart the run.
                if record["failures"] and record["empty"]:
                    record["empty"] = 0
                record["evidence"] = []
                migrated = True
        if migrated:
            self.store.put(key, state)
        ids = [member["id"] for member in members.values()] + ["master:" + config["master_env_prefix"]]
        settled = []
        while records:
            record = records[0]
            label = "上次划转（" + record["request_id"][:8] + "）结果未知"
            exhausted = record["failures"] >= TRANSFER_HISTORY_QUERY_LIMIT
            now = time.time()
            created = record["created_at"]
            span_end = created + TRANSFER_UNKNOWN_HISTORY_SPAN_SECONDS
            ready_at = created + TRANSFER_HISTORY_WAIT_SECONDS
            if "queried_at" in record:
                ready_at = max(ready_at, record["queried_at"] + TRANSFER_ABSENCE_SPACING_SECONDS)
                if record["queried_at"] < span_end:
                    # The early read was not conclusive; wait for the full span.
                    ready_at = max(ready_at, span_end)
            if not exhausted and now < ready_at:
                progress = "已有 1 次完整时间窗内两侧均无该笔划转，" if record["empty"] else ""
                return view("unknown", label + "，" + progress + "等待观察时间结束后核对两侧划转流水"
                    + _remaining_time(ready_at, now) + "；" + SETTLE_WAIT)
            # Identity first: a shared row that the current accounts cannot see
            # must not be read as already settled.
            try:
                self._verify_pending_identity(pair, members, record)
            except TradingError as exc:
                return view("blocked", label + "，" + str(exc) + "；恢复原账户凭据后自动继续核对。"
                    "原账户已不可用时需人工核对交易所划转记录并处理；" + SETTLE_WAIT)
            candidates = ("aster:transfer:" + record["request_id"],
                          "aster:legacy:pair_margin:" + pair["id"] + ":" + record["request_id"])
            with writer.accounts(ids) as ticket:
                open_ids = {row["operationId"] for row in writer.registry.unresolved(ticket)} if ticket is not None else set()
            open_ops = [value for value in candidates if value in open_ids]
            if not open_ops:
                # Settled elsewhere, including by a person after the bound.
                records.pop(0)
                self.store.put(key, state)
                continue
            if exhausted:
                return view("blocked", label + f"，{TRANSFER_HISTORY_QUERY_LIMIT} 次流水核对仍无法确认；" + SETTLE_MANUAL)
            if record["empty"] >= TRANSFER_ABSENCE_READS and not record.get("evidence"):
                # The absence proof is durable; an earlier settle failed.
                self._resolve_skipped(writer, ids, open_ops, rejected=True)
                settled.append("rejected")
                records.pop(0)
                self.store.put(key, state)
                continue
            start = int((created - TRANSFER_CLOCK_TOLERANCE_SECONDS) * 1000)
            end = int(min(now, span_end) * 1000)
            complete = now >= span_end
            observation = {}
            try:
                rows = self._income(members, start, end, reconciliation=True, observation=observation)
            except ExchangeError as exc:
                notice = api_wait_notice(exc)
                if observation.get("queried"):
                    record["queried_at"] = now
                    if notice is None:
                        # A failed read breaks the run of empty reads.
                        record.update(failures=record["failures"] + 1, empty=0)
                    self._keep_evidence(record, observation, state, start, end)
                    self.store.put(key, state)
                return view("unknown", label + "，流水核对未完成（" + (notice["text"] if notice else self._read_error_detail(exc))
                    + "），稍后有限次重试；" + SETTLE_WAIT)
            except TradingError as exc:
                if observation.get("queried"):
                    record.update(queried_at=now, failures=record["failures"] + 1, empty=0)
                    self._keep_evidence(record, observation, state, start, end)
                    self.store.put(key, state)
                return view("unknown", label + "，流水核对失败：" + str(exc) + "；稍后有限次重试，" + SETTLE_WAIT)
            # Persist the read before deciding, so a later failure still
            # leaves the read spaced and bounded.
            record["queried_at"] = now
            self.store.put(key, state)
            source, destination = self._receipt_matches(record, rows, state, start, end)
            common = source & destination
            evidence = record.get("evidence", [])
            if (len(common) == 1 and len(source) == 1 and len(destination) == 1
                    and all((item[1], item[2]) in common for item in evidence)):
                kind, txn = common.pop()
                self._resolve_skipped(writer, ids, open_ops)
                # Recorded after settling: recording first and crashing would
                # hide this receipt from the next read and fake an absence.
                # Crashing in between only leaves this receipt unrecorded.
                state["used_receipts"] = (state.get("used_receipts", []) + [[kind, txn]])[-100:]
                settled.append("confirmed")
            elif not source and not destination and evidence:
                # An earlier read saw part of this transfer; an empty read now
                # means the history view is unstable, not that it never landed.
                record["failures"] += 1
                self.store.put(key, state)
                return view("unknown", label + "，此前已读到该笔划转的部分流水，本次两侧均未读到；"
                    "不按未送达结算，继续有限次核对；" + SETTLE_WAIT)
            elif not source and not destination:
                if complete:
                    record["empty"] += 1
                self.store.put(key, state)
                if record["empty"] < TRANSFER_ABSENCE_READS:
                    later = ("约 " + str(TRANSFER_ABSENCE_SPACING_SECONDS) + " 秒后再核对一次" if complete
                             else "完整时间窗结束后再核对两次")
                    return view("unknown", label + "，本次两侧流水均无该笔划转；" + later + "；" + SETTLE_WAIT)
                self._resolve_skipped(writer, ids, open_ops, rejected=True)
                settled.append("rejected")
            else:
                # Partial or conflicting receipts: keep them as durable proof
                # that the transfer may exist, so later empty reads cannot
                # reject it.
                record["failures"] += 1
                overflow = self._add_evidence(record, source, destination)
                self.store.put(key, state)
                if overflow:
                    return view("blocked", label + "，两侧流水出现过多冲突回执；" + SETTLE_MANUAL)
                return view("unknown", label + "，两侧流水只部分匹配，继续有限次核对；" + SETTLE_WAIT)
            records.pop(0)
            self.store.put(key, state)
        state.pop("unsettled_transfers", None)
        if not settled:
            self.store.put(key, state)
            return None
        # Do not plan a new transfer in the same check that settled the old
        # one: wait a cooldown and start again from fresh balances.
        now = time.time()
        state["cooldown_until"] = max(state.get("cooldown_until", 0),
            now + max(config["cooldown_seconds"], TRANSFER_ABSENCE_SPACING_SECONDS))
        self.store.put(key, state)
        if "confirmed" in settled:
            self._invalidate(members)
        outcome = "已由两侧流水核实到账" if settled[-1] == "confirmed" else "已核实未送达并结算"
        return self._view(state, config, "cooldown", "上次结果未知的划转" + outcome
                          + "；冷却结束后按最新余额重新评估，原请求不会重发")

    @staticmethod
    def _add_evidence(record, source, destination):
        evidence = record.get("evidence", [])
        seen = [[side, kind, txn] for side, found in ((record["source"], source),
                (record["destination"], destination)) for kind, txn in sorted(found)]
        merged = evidence + [item for item in seen if item not in evidence]
        if not merged:
            return False
        overflow = len(merged) > TRANSFER_EVIDENCE_LIMIT
        if overflow:
            # Too many conflicting receipts to check later: a person decides.
            merged = merged[:TRANSFER_EVIDENCE_LIMIT]
            record["failures"] = TRANSFER_HISTORY_QUERY_LIMIT
        record.update(empty=0, evidence=merged)
        return overflow

    def _keep_evidence(self, record, observation, state, start, end):
        """Keep receipts from the pages a failed read did complete; never confirm from them."""
        rows = observation.get("rows") or {}
        if rows:
            source, destination = self._receipt_matches(
                record, {side: rows.get(side, []) for side in ("long", "short")}, state, start, end)
            self._add_evidence(record, source, destination)

    @staticmethod
    def _resolve_skipped(writer, ids, operation_ids, *, rejected=False):
        with writer.accounts(ids):
            for operation_id in operation_ids:
                writer.resolve_prefix(operation_id, rejected=rejected)

    def _reconcile(self, pair, members, state, config):
        pending = state["pending"]
        if pending.get("status") == "submitting":
            pending["status"] = "unknown"
            state["last_transfer"] = pending
            self.store.put("pair_margin:" + pair["id"], state)
        if pending.get("status") == "unknown":
            return self._resume_unknown(pair, members, state, config)
        recovery = pending.setdefault("history_recovery", {"first_observed_at": time.time(), "query_rounds": 0})
        if (not isinstance(recovery, dict) or type(recovery.get("query_rounds")) is not int
                or not 0 <= recovery["query_rounds"] <= TRANSFER_HISTORY_QUERY_LIMIT
                or type(recovery.get("first_observed_at")) not in (int, float)
                or not math.isfinite(recovery["first_observed_at"])):
            raise TradingError("划转历史核对进度无效，保留原请求")
        # Old records have no durable dispatch boundary: allow a full recovery
        # window after first observation, including across process restarts.
        deadline = max(pending["created_at"], recovery["first_observed_at"]) + TRANSFER_HISTORY_WAIT_SECONDS
        self.store.put("pair_margin:" + pair["id"], state)
        if recovery["query_rounds"] >= TRANSFER_HISTORY_QUERY_LIMIT:
            if time.time() >= deadline:
                return self._resume_unknown(pair, members, state, config)
            return self._view(state, config, "accepted", "旧划转流水已完成有限次核对，等待恢复观察窗口结束"
                + _remaining_time(deadline, time.time()) + "后重新读取两侧余额；不再重复查询旧流水", blocks=True)
        start = int(pending["created_at"] * 1000) // 1000 * 1000
        end = int((pending["created_at"] + 90) * 1000)
        observation = {}
        try:
            rows = self._income(members, start, end, reconciliation=True, observation=observation)
        except TradingError:
            if observation.get("queried"):
                recovery["query_rounds"] += 1
                self.store.put("pair_margin:" + pair["id"], state)
                if recovery["query_rounds"] >= TRANSFER_HISTORY_QUERY_LIMIT and time.time() >= deadline:
                    return self._resume_unknown(pair, members, state, config)
            raise
        if observation.get("queried"):
            recovery["query_rounds"] += 1
        self._record_success(pair, state)
        matches = self._receipt_matches(pending, rows, state, start, end)
        common = matches[0] & matches[1]
        if len(common) != 1 or any(len(values) != 1 for values in matches):
            if recovery["query_rounds"] >= TRANSFER_HISTORY_QUERY_LIMIT and time.time() >= deadline:
                return self._resume_unknown(pair, members, state, config)
            return self._view(state, config, pending["status"], "两侧 USD1 划转流水尚未匹配；有限次核对后将以新余额归档旧请求，期间不开始新开仓或新划转")
        kind, txn = common.pop()
        writer = writer_for(self.engine)
        with writer.accounts([member["id"] for member in members.values()] + ["master:" + config["master_env_prefix"]]):
            writer.resolve_prefix("aster:transfer:" + pending["request_id"])
            writer.resolve_prefix("aster:legacy:pair_margin:" + pair["id"] + ":" + pending["request_id"])
        done = {**pending, "status": "confirmed", "confirmed_at": time.time(), "transaction_id": txn, "income_type": kind}
        state.update(pending=None, last_transfer=done)
        state["used_receipts"] = (state.get("used_receipts", []) + [[kind, txn]])[-100:]
        self.store.put("pair_margin:" + pair["id"], state)
        self._invalidate(members)
        return self._view(state, config, "confirmed", "划转已由两侧流水核实，系统重新读取账户余额；取得新快照前不开始新开仓或新划转", blocks=True)

    def _refresh_acknowledged(self, pair, members, state, config):
        """Official success is final; refresh balances without another write.

        Aster documents code=200/msg=success, not a transaction ID. Do not turn
        that successful response into an ambiguous result merely because income
        IDs may differ between accounts. A timeout never enters this path.
        """
        pending = state["pending"]
        acknowledged_at = pending.get("acknowledged_at")
        if type(acknowledged_at) not in (int, float) or not math.isfinite(acknowledged_at):
            raise TradingError("划转成功回执缺少有效时间，保留待核对状态")
        writer_for(self.engine).settle_transfer(pair, pending)
        brokers = {side: self.engine.broker(member) for side, member in members.items()}
        done = self._refresh_acknowledged_ws(pair, members, brokers, state)
        if done is not None:
            self._invalidate(members)
            return self._view(state, config, "acknowledged", "交易所回执确认，两侧 WebSocket 余额已核对；等待下一轮账户快照",
                blocks=True, plan={key: done[key] for key in ("source", "destination", "amount")})
        # Give an already connected pair one bounded, non-blocking opportunity
        # to deliver events. The deadline never moves on retries; disconnected
        # or restarted sessions immediately use the ordinary REST fallback.
        checkpoints = pending.get("ws_checkpoints")
        deadline = acknowledged_at + TRANSFER_WS_GRACE_SECONDS
        now = time.time()
        if (pending.get("acknowledgement_code") == 200 and now < deadline
                and isinstance(checkpoints, dict) and set(checkpoints) == set(brokers)
                and all(callable(getattr(broker, "transfer_ws_checkpoint_current", None))
                        and broker.transfer_ws_checkpoint_current(checkpoints[side])
                        for side, broker in brokers.items())):
            state["next_check_at"] = min(now + 1, deadline)
            self._record_success(pair, state)
            return self._view(state, config, "acknowledged", "交易所已确认划转，等待两侧 WebSocket 余额；最多 2 秒后改用 REST 刷新",
                blocks=True)
        self._require_budget(members, {side: broker.transfer_snapshot_weight()
                                     for side, broker in brokers.items()}, reconciliation=True)
        snapshots = {}
        for side, broker in brokers.items():
            with getattr(broker, "reconciliation_budget", nullcontext)():
                current = broker.transfer_snapshot()
                current.require_fresh()
                if current.timestamp < acknowledged_at:
                    raise TradingError("划转后的账户查询返回旧快照，继续等待新余额")
                broker.require_snapshot_current(current)
                snapshots[side] = current
        with ExitStack() as locks:
            for side in sorted(brokers, key=lambda value: members[value]["id"]):
                locks.enter_context(brokers[side]._snapshot_lock)
            for side, broker in brokers.items():
                broker.require_snapshot_current(snapshots[side])
            done = {**pending, "refreshed_at": time.time(), "refresh_source": "rest"}
            state.update(pending=None, last_transfer=done)
            self._record_success(pair, state)
            self.refreshed_snapshots = snapshots
        self._invalidate(members)
        return self._view(state, config, "acknowledged", "交易所回执确认，余额已刷新；等待下一轮账户快照", blocks=True,
            plan={key: done[key] for key in ("source", "destination", "amount")})

    def _refresh_acknowledged_ws(self, pair, members, brokers, state):
        """Balance evidence only refreshes an explicit REST success receipt."""
        pending = state["pending"]
        checkpoints = pending.get("ws_checkpoints")
        if (pending.get("status") != "acknowledged" or pending.get("acknowledgement_code") != 200
                or not isinstance(checkpoints, dict)
                or set(checkpoints) != set(brokers)):
            return None
        balances = {}
        for side, broker in brokers.items():
            read = getattr(broker, "transfer_ws_balance", None)
            if not callable(read):
                return None
            sign = -1 if side == pending["source"] else 1
            result = read(checkpoints[side], dec(pending["amount"]) * sign, pending["created_at"])
            if result is None:
                return None
            balances[side] = result
        with ExitStack() as locks:
            for side in sorted(brokers, key=lambda value: members[value]["id"]):
                locks.enter_context(brokers[side]._snapshot_lock)
            try:
                for _, require_current in balances.values():
                    require_current()
            except TradingError:
                return None
            # Session tokens remain in the private checkpoint only. Store a
            # small, credential-free audit, never a raw private account event.
            evidence = {side: {key: value[key] for key in ("event_cursor", "event_time", "transaction_time",
                "reason", "asset", "delta", "wallet") if key in value} for side, (value, _) in balances.items()}
            done = {**pending, "refreshed_at": time.time(), "refresh_source": "websocket", "balance_evidence": evidence}
            state.update(pending=None, last_transfer=done)
            self._record_success(pair, state)
        return done

    def _invalidate(self, members):
        for member in members.values():
            broker = self.engine.broker(member)
            callback = getattr(broker, "invalidate_account_reads", None)
            if callback:
                callback("子账户保证金划转，重新读取余额")

    def _paper(self, pair, members, snapshots, state, pending):
        key = "pair_margin:" + pair["id"]
        amount = dec(pending["amount"])
        completed = {**pending, "status": "paper_confirmed", "confirmed_at": time.time()}
        state.update(pending=None, last_transfer=completed)
        # All wallets and the receipt share ONE SQLite transaction. A crash or
        # disk failure cannot publish just one side, even across Store instances.
        with self.engine.workspace.mutation(), self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            wallets = {}
            for side, member in members.items():
                row = db.execute("SELECT data FROM kv WHERE key=?", ("paper:" + member["id"],)).fetchone()
                if row is None:
                    raise TradingError("模拟账户账本不存在")
                wallets[side] = json.loads(row[0])
                if dec(wallets[side]["wallet"]) != snapshots[side].wallet:
                    raise TradingError("模拟账户余额已变化，等待新快照")
            for side, member in members.items():
                change = -amount if side == pending["source"] else amount
                wallets[side]["wallet"] = wire(dec(wallets[side]["wallet"]) + change)
                db.execute("UPDATE kv SET data=? WHERE key=?", (json.dumps(wallets[side]), "paper:" + member["id"]))
            db.execute("INSERT INTO kv(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                       (key, json.dumps(state)))
        for member in members.values():
            self.engine.broker(member).reload()

    @funds_priority
    @protected_pair
    def tick(self, pair, snapshots, pending_orders=False, *, snapshot_guards=None, snapshot_loader=None):
        # Include funds reads, ownership discovery, POST and the acknowledged
        # balance refresh in one isolated priority context.
        with ExitStack() as priorities:
            seen = set()
            for member in self._members(pair).values():
                budget = getattr(getattr(self.engine.broker(member), "api", None), "budget", None)
                if budget is not None and id(budget) not in seen:
                    priorities.enter_context(getattr(budget, "margin", nullcontext)())
                    seen.add(id(budget))
            return self._tick(pair, snapshots, pending_orders, snapshot_guards=snapshot_guards,
                snapshot_loader=snapshot_loader)

    def _tick(self, pair, snapshots, pending_orders=False, *, snapshot_guards=None, snapshot_loader=None):
        """Return display state; the caller must obey ``blocks_trading``."""
        config = validate_margin(pair.get("margin", {}))
        try:
            state = self.store.get("pair_margin:" + pair["id"], {})
        except Exception:
            return self._view({}, config, "blocked", "保证金划转日志无法读取，停止新开仓和新划转；请检查服务器日志及存储状态", blocks=True)
        if not isinstance(state, dict):
            return self._view({}, config, "blocked", "保证金划转日志无效，停止新开仓和新划转；请人工核对服务器日志与交易所划转记录", blocks=True)
        preparing = False
        try:
            members = self._members(pair)
            last = state.get("last_transfer")
            rejection = last.get("writer_rejection") if isinstance(last, dict) else None
            if not state.get("pending") and isinstance(rejection, dict) and rejection.get("settled") is not True:
            # Only this version's durable rejection proof may settle the exact
                # shared operation. Old unknown/skipped records are not proof.
                writer_for(self.engine).settle_transfer(pair, last)
                self.store.put("pair_margin:" + pair["id"], state)
            now = time.time()
            for field in ("checked_at", "next_check_at", "cooldown_until"):
                if field in state and (type(state[field]) not in (int, float) or not math.isfinite(state[field])):
                    raise TradingError("保证金划转日志时间无效")
            pending = state.get("pending")
            if pending is not None and not self._valid_pending(pending):
                raise TradingError("保证金划转待核对记录无效")
            if pending:
                positive(pending.get("amount"))
                if now < state.get("next_check_at", 0):
                    if self.resume_ready(state) and (not state.get("blocked_reason") or state.get("retry_without_blocking")):
                        return self._view(state, config, "unknown",
                            f"等待重新读取两侧余额后跳过旧划转；读取成功前仍预留 {pending['amount']} USD1，不重发原请求")
                    return self._view(state, config, pending.get("status", "unknown"),
                        state.get("blocked_reason") or ("等待下一次划转只读核对" + _remaining_time(state["next_check_at"], now)
                        + "；保留原请求，期间不开始新开仓或新划转"))
                state.update(checked_at=now, next_check_at=now + config["check_interval_seconds"])
                self.store.put("pair_margin:" + pair["id"], state)
                # A changed environment must not query the wrong accounts and
                # accidentally match an unrelated transfer of the same amount.
                self._verify_pending_identity(pair, members, pending)
                if pending["status"] == "acknowledged":
                    return self._refresh_acknowledged(pair, members, state, config)
                return self._reconcile(pair, members, state, config)
            # Settle a skipped unknown transfer even while balancing is disabled
            # or the pair is paused, so a later urgent transfer is not the first
            # to meet the blocker. Its own spacing bounds the reads.
            held = None if self.engine.workspace.active else self._settle_skipped(pair, members, state, config)
            if self.engine.workspace.active:
                reason = "工作台维护中，暂停新划转"
                workspace = self.engine.workspace
                if (not workspace.reads_paused and snapshot_loader is not None and config["enabled"]
                        and margin_running(pair, self.store.get("pair_margin_control:" + pair["id"]))
                        and now >= workspace.display_due.get(pair["id"], 0)):
                    reason = self._maintenance_read(pair, config, now, snapshot_loader) or reason
                return self._view(state, config, "paused", reason, blocks=True)
            if held is not None:
                return held
            if not config["enabled"]:
                return self._view(state, config, "disabled", "自动保证金平衡未启用")
            if not margin_running(pair, self.store.get("pair_margin_control:" + pair["id"])):
                return self._view(state, config, "paused", "配对组已暂停，不发起新划转；已有划转仍继续只读核对，需启动配对组后才重新评估新划转")
            if any(not self.engine.live_allowed(member) for member in members.values()):
                return self._view(state, config, "blocked", "实盘全局开关未开启，禁止划转", blocks=True)
            if state.get("api_notice") and now < state.get("next_check_at", 0):
                return self._view(state, config, "waiting" if state.get("retry_without_blocking") else "blocked", state.get("blocked_reason") or
                    "等待 API 请求预算恢复后重新检查保证金", blocks=not state.get("retry_without_blocking"))
            if now < state.get("cooldown_until", 0):
                return self._view(state, config, "cooldown", "划转冷却中" + _remaining_time(state["cooldown_until"], now)
                                  + "；结束后重新评估划转条件")
            if now < state.get("next_check_at", 0):
                blocked = bool(state.get("blocked_reason") and not state.get("retry_without_blocking"))
                return self._view(state, config, "blocked" if blocked else "waiting",
                    state.get("blocked_reason", "等待下一次保证金检查" + _remaining_time(state["next_check_at"], now)
                              + "；届时重新评估余额差额及安全可划条件"), blocks=blocked)
            state.update(checked_at=now, next_check_at=now + config["check_interval_seconds"])
            self.store.put("pair_margin:" + pair["id"], state)
            preparing = True
            if snapshot_loader is not None:
                snapshots, snapshot_guards = snapshot_loader()
            self._check_snapshots(pair, snapshots)
            diagnostics = {}
            may_transfer = self._may_need_transfer(snapshots, config)
            if may_transfer and members["long"]["mode"] == "live":
                # The transfer snapshot already carries the exchange withdrawal
                # ceiling. Use it for this local decline-only preview instead of
                # paying for a full ownership+account re-read when the source
                # account simply cannot transfer. While an earlier failure is
                # still unresolved, keep the old path so ownership/credential
                # verification is not silently cleared by a local decline.
                if state.get("blocked_reason") or state.get("api_notice"):
                    withdrawable = dict.fromkeys(members, config["max_transfer"])
                else:
                    withdrawable = {}
                    for side, snapshot in snapshots.items():
                        value = getattr(snapshot, "transfer_withdrawable", None)
                        withdrawable[side] = config["max_transfer"] if value is None else positive(value, True)
                may_transfer = self._plan(pair, members, snapshots, config,
                    withdrawable, diagnostics=diagnostics) is not None
            if not may_transfer:
                # No extra account read is needed to decline a transfer. Hot
                # snapshots remain protected by the caller's account leases;
                # no result from this precheck can authorize a funds write.
                for side, snapshot in snapshots.items():
                    guard = (snapshot_guards or {}).get(side)
                    if callable(guard):
                        guard()
                    elif members[side]["mode"] == "live" and type(getattr(snapshot, "account_read_generation", None)) is int:
                        self.engine.broker(members[side]).require_snapshot_current(snapshot)
                    snapshot.require_fresh()
                self._record_success(pair, state)
                return self._view(state, config, "waiting", self._no_transfer_reason(snapshots, config, diagnostics))
            if members["long"]["mode"] == "paper":
                diagnostics = {}
                plan = self._plan(pair, members, snapshots, config,
                    {side: max(Decimal(0), min(snapshot.available, snapshot.wallet)) for side, snapshot in snapshots.items()},
                    diagnostics=diagnostics)
                if plan is None:
                    self._record_success(pair, state)
                    return self._view(state, config, "waiting", self._no_transfer_reason(snapshots, config, diagnostics))
                for guard in (snapshot_guards or {}).values():
                    guard()
                pending = {**plan, "request_id": uuid.uuid4().hex, "created_at": now, "status": "submitting"}
                state["cooldown_until"] = now + config["cooldown_seconds"]
                self._paper(pair, members, snapshots, state, pending)
                self._record_success(pair, state)
                return self._view(state, config, "paper_confirmed", "模拟 USD1 划转已原子入账，系统重新读取两侧余额；取得新快照前不开始新开仓或新划转", blocks=True, plan=plan)
            return self._live(pair, members, snapshots, state, config, snapshot_guards)
        except PairRecoveryConflict:
            raise
        except TradingError as exc:
            # Local validation messages are fixed strings; remote error bodies
            # and credential values never enter durable state or the dashboard.
            notice = api_wait_notice(exc)
            detail = self._read_error_detail(exc) if isinstance(exc, ExchangeError) else None
            reason = (notice["text"] if notice else
                f"Aster 划转只读检查失败（{detail}），系统将重试账户或流水查询；核实前不开始新开仓或新划转"
                if isinstance(exc, ExchangeError) else str(exc))
            soft = isinstance(exc, ExchangeError) and (
                preparing and state.get("pending") is None or self.resume_ready(state))
            if soft:
                reason = "本轮保证金检查已跳过，稍后重新读取余额；交易仍按新鲜快照及原风控检查。" + (
                    notice["text"] if notice else detail or str(exc))
            state = self._record_failure(pair, state, reason, exc=exc, soft=soft)
            if (isinstance(exc, ExchangeError) and isinstance(state.get("pending"), dict)
                    and state["pending"].get("status") == "acknowledged"):
                reason = "交易所已确认划转，但两侧余额尚未完成刷新；继续只读重试，不重新划转" + (
                    "；最近反馈：" + (notice["text"] if notice else detail))
            return self._view(state, config, "waiting" if soft and not state.get("pending") else self._failure_status(state),
                              reason, blocks=not soft or not state.get("retry_without_blocking"))
        except Exception:
            state = self._record_failure(pair, state, "保证金日志或账户读取失败，禁止新划转")
            return self._view(state, config, self._failure_status(state), "保证金日志或账户读取失败，禁止新划转", blocks=True)

    def _maintenance_read(self, pair, config, now, snapshot_loader):
        """Refresh displayed balances during an admitted update; never plans a transfer."""
        due = self.engine.workspace.display_due
        due[pair["id"]] = now + config["check_interval_seconds"]
        try:
            snapshot_loader()
        except Exception as exc:
            # A display read leaves no failure record behind for the transfer path.
            if not isinstance(exc, TradingError):
                LOG.exception("维护期间余额显示读取失败 pair=%s", pair["id"])
            due[pair["id"]] = max(due[pair["id"]], now + (getattr(exc, "retry_after", 0) or 0))
            notice = api_wait_notice(exc) if isinstance(exc, TradingError) else None
            detail = (notice["text"] if notice else self._read_error_detail(exc) if isinstance(exc, ExchangeError)
                      else str(exc) if isinstance(exc, TradingError) else "账户读取失败")
            return f"工作台维护中，暂停新划转；余额读取失败（{detail}），下次检查时重试"
        return None

    @staticmethod
    def _read_error_detail(exc):
        """Keep useful read diagnostics without publishing remote response text."""
        details = []
        if str(exc) == "Aster 网络连接失败":
            details.append("网络连接失败")
        elif str(exc).startswith("Aster 返回无法识别的响应"):
            details.append("响应格式无法识别")
        if type(exc.http_status) is int and 100 <= exc.http_status <= 599:
            details.append(f"HTTP {exc.http_status}")
        if type(exc.code) is int and -1000000 <= exc.code < 0:
            details.append(f"错误码 {exc.code}")
        return "；".join(details) or "未返回可识别的错误类别或错误码"

    @staticmethod
    def _failure_status(state):
        pending = state.get("pending")
        if isinstance(pending, dict) and pending.get("status") == "acknowledged":
            return "acknowledged"
        return "unknown" if pending else "blocked"

    def _record_success(self, pair, state):
        state.pop("api_notice", None)
        state.pop("blocked_reason", None)
        state.pop("retry_without_blocking", None)
        self.store.put("pair_margin:" + pair["id"], state)

    @staticmethod
    def _apply_api_wait(state, exc):
        notice = api_wait_notice(exc)
        if notice:
            state["api_notice"] = notice
        delay = getattr(exc, "retry_after", 0)
        if type(delay) in (int, float) and math.isfinite(delay) and delay > 0:
            deadline = state.get("next_check_at", 0)
            if type(deadline) not in (int, float) or not math.isfinite(deadline):
                deadline = 0
            state["next_check_at"] = max(deadline, time.time() + delay)

    def _record_failure(self, pair, state, reason, *, exc=None, soft=False):
        # Re-read durable state: a rolled-back paper transfer or failed receipt
        # commit must never be saved as completed by an error handler.
        try:
            durable = self.store.get("pair_margin:" + pair["id"], {})
            if isinstance(durable, dict):
                durable["blocked_reason"] = reason
                durable["retry_without_blocking"] = bool(soft and (durable.get("pending") is None or self.resume_ready(durable)))
                self._apply_api_wait(durable, exc)
                self.store.put("pair_margin:" + pair["id"], durable)
                return durable
        except Exception:
            pass
        self._apply_api_wait(state, exc)
        return state

    def _live_snapshots(self, pair, members, snapshots, snapshot_guards=None):
        brokers = {side: self.engine.broker(member) for side, member in members.items()}
        originals = dict(snapshots)
        guards = {}
        replacements = []
        for side, broker in brokers.items():
            if not callable(getattr(broker, "require_snapshot_current", None)) or not hasattr(broker, "_snapshot_lock"):
                raise TradingError("账户缺少可撤销的快照校验，禁止划转")
            # PairTrader can lend its revocable hot lease for this synchronous
            # call under the same account locks. A bare snapshot is insufficient.
            guard = (snapshot_guards or {}).get(side)
            if callable(guard):
                # Keep the caller's configuration/identity guard as well as
                # the snapshot lease, including REST reads with generations.
                guards[side] = guard
            elif type(getattr(originals[side], "account_read_generation", None)) is not int:
                replacements.append(side)
        if replacements:
            # Funds reads do not depend on trading modes, positions or markets.
            with ThreadPoolExecutor(max_workers=len(replacements), thread_name_prefix="margin-read") as pool:
                def read(side, budget, flags):
                    with budget._inherit_priority(flags) if flags is not None else nullcontext():
                        return brokers[side].transfer_snapshot()
                reads = {}
                for side in replacements:
                    budget = getattr(getattr(brokers[side], "api", None), "budget", None)
                    flags = budget._priority_flags() if callable(getattr(budget, "_priority_flags", None)) else None
                    reads[side] = pool.submit(read, side, budget, flags)
                originals.update({side: future.result() for side, future in reads.items()})
        for side in brokers:
            if side in guards:
                continue
            if type(getattr(originals[side], "account_read_generation", None)) is not int:
                raise TradingError("账户快照缺少有效代次，禁止划转")
            guards[side] = lambda side=side: brokers[side].require_snapshot_current(originals[side])

        def require_current():
            # Check both generations at one local admission boundary. Holding
            # these locks only for validation does not stall account events on
            # network I/O. Keep originals: dataclasses.replace drops the token.
            with ExitStack() as locks:
                for side in sorted(brokers, key=lambda value: members[value]["id"]):
                    locks.enter_context(brokers[side]._snapshot_lock)
                for guard in guards.values():
                    guard()
                if any(not self.engine.live_allowed(member) for member in members.values()):
                    raise TradingError("实盘全局开关已关闭，禁止划转")

        require_current()
        self._check_snapshots(pair, originals)
        return originals, require_current

    def _live(self, pair, members, snapshots, state, config, snapshot_guards=None):
        # New transfers may never spend the recovery reserve.
        with ExitStack() as ordinary:
            seen = set()
            for member in members.values():
                budget = getattr(getattr(self.engine.broker(member), "api", None), "budget", None)
                if budget is not None and id(budget) not in seen:
                    ordinary.enter_context(budget.pair_accounting())
                    seen.add(id(budget))
            self._require_budget(members, self._live_budget_weights(pair, members, snapshots, snapshot_guards))
            result = self._submit_live(pair, members, snapshots, state, config, snapshot_guards)
        # Only an already accepted write may use the recovery reserve. Leave
        # the ordinary context before its one confirmation refresh.
        if isinstance(state.get("pending"), dict) and state["pending"].get("status") == "acknowledged":
            return self._refresh_acknowledged(pair, members, state, config)
        return result

    @protected_transfer
    def _submit_live(self, pair, members, snapshots, state, config, snapshot_guards=None):
        key = "pair_margin:" + pair["id"]
        snapshots, require_current = self._live_snapshots(pair, members, snapshots, snapshot_guards)
        with self._master(pair, members) as (api, master, children):
            listing = api.call("GET", "/fapi/v3/getSubAccountList", signed=True, weight=5)
            accounts = self._account_rows(members)
            self._verify(listing, children, accounts)
            available, wallets = {}, {}
            for side, payload in accounts.items():
                asset = LiveBroker._account_asset(payload)
                # ACCOUNT_UPDATE.wb is total wallet balance, not available or
                # cross-wallet balance. Missing/invalid REST values disable
                # this optional evidence path without inventing a baseline.
                try:
                    wallets[side] = dec(asset.get("walletBalance"))
                except TradingError:
                    pass
                available[side] = positive(asset.get("maxWithdrawAmount"), True)
                # Re-read the actual withdrawal ceiling and available balances
                # immediately before planning. No position matching is needed.
                _, _, equity = LiveBroker._transfer_wallet_equity(asset)
                snapshots = {**snapshots, side: replace(snapshots[side], available=dec(asset.get("availableBalance")),
                    equity=equity)}
            self._check_snapshots(pair, snapshots)
            require_current()
            diagnostics = {}
            plan = self._plan(pair, members, snapshots, config, available, diagnostics=diagnostics)
            if plan is None:
                self._record_success(pair, state)
                return self._view(state, config, "waiting", self._no_transfer_reason(snapshots, config, diagnostics))
            # The fresh exchange withdrawal limit includes reserved funds;
            # trading recovery and archived orders cannot gate this transfer.
            require_current()
            created = time.time()
            pending = {**plan, "request_id": uuid.uuid4().hex, "created_at": created, "status": "submitting",
                "identity": self._fingerprint(pair, members, children, master)}
            checkpoints = {}
            for side, wallet in wallets.items():
                checkpoint = getattr(self.engine.broker(members[side]), "transfer_ws_checkpoint", None)
                value = checkpoint(wallet) if callable(checkpoint) else None
                if value is not None:
                    checkpoints[side] = value
            if set(checkpoints) == set(members):
                pending["ws_checkpoints"] = checkpoints
            state.update(pending=pending, last_transfer=pending, cooldown_until=created + config["cooldown_seconds"])
            state.pop("api_notice", None)
            state.pop("blocked_reason", None)
            self.store.put(key, state)  # Must commit before any signed mutation.
            transfer = TransferAPI(master, budget=api.budget, before_submit=require_current)
            transfer.workspace_control = self.engine.workspace
            writer = writer_for(self.engine)
            writer.bind_api(transfer, "master:" + config["master_env_prefix"])
            receipt_write_failed = False
            rejection_code = None
            rejection_error = None
            def persist_rejection(operation, outcome, sent):
                nonlocal receipt_write_failed
                if outcome != "rejected":
                    return
                if sent and rejection_code not in REJECTION_CODES:
                    raise TradingError("划转拒绝缺少可验证的交易所回执，保留共享未决")
                done = {**pending, "status": "rejected", "writer_rejection": {
                    "schema_version": 1, "operation_id": operation["operationId"], "body_hash": operation["bodyHash"],
                    "request_sent": sent, "settled": False}}
                if sent:
                    done["writer_rejection"]["exchange_code"] = rejection_code
                    done["exchange_rejection_code"] = rejection_code
                updated = {**state, "pending": None, "last_transfer": done, "retry_without_blocking": True}
                # This commit is also the recovery boundary for a known rate
                # limit. A process exit before shared finish must not shorten it.
                self._apply_api_wait(updated, rejection_error)
                # A crash after this commit can reject the original shared
                # operation by its exact body hash, never by a new balance.
                receipt_write_failed = True
                self.store.put(key, updated)
                receipt_write_failed = False
                pending.update(done)
                state.update(updated)
            try:
                params = {"toAccountAddress": children[plan["destination"]]["user"].lower(), "asset": "USD1", "amount": plan["amount"],
                    "kindType": "FUTURE_FUTURE", "fromAccountAddress": children[plan["source"]]["user"].lower()}
                with writer.accounts([member["id"] for member in members.values()] + ["master:" + config["master_env_prefix"]]), writer.batch("aster:transfer:" + pending["request_id"], params, before_finish=persist_rejection,
                        margin_transfer={"source": members[plan["source"]]["id"],
                            "destination": members[plan["destination"]]["id"],
                            "master": "master:" + config["master_env_prefix"]}):
                    try:
                        response = transfer.call("POST", "/fapi/v3/subAccountTransfer", params, signed=True, weight=5)
                    except (TransferRejected, RequestNotSent) as exc:
                        rejection_error = exc
                        rejection_code = exc.code if isinstance(exc, TransferRejected) else None
                        raise
                    if (not isinstance(response, dict) or type(response.get("code")) not in (int, str)
                            or response.get("code") not in (0, 200, "0", "200")
                            or not isinstance(response.get("msg"), str) or response["msg"].strip().lower() != "success"):
                        raise AmbiguousOrder("划转没有明确的接受回执")
                    acknowledged = {**pending, "status": "acknowledged", "acknowledged_at": time.time(),
                        "acknowledgement_code": int(response["code"])}
                    if _identifier(response.get("tranId")):
                        acknowledged["transaction_id"] = _identifier(response["tranId"])
                    receipt_write_failed = True
                    self.store.put(key, {**state, "pending": acknowledged, "last_transfer": acknowledged})
                    receipt_write_failed = False
                    pending.update(acknowledged)
                    state.update(pending=pending, last_transfer=pending)
            except Exception as exc:
                if receipt_write_failed:
                    # Leave the durable submitting record intact. The outer
                    # failure handler re-reads it instead of inventing a receipt.
                    raise
                # Once the official acknowledgement is durable, a failed
                # shared finish cannot turn it into a guessed unknown.
                if pending.get("status") != "acknowledged":
                    rejected = isinstance(exc, RequestNotSent) or (isinstance(exc, ExchangeError)
                        and not isinstance(exc, AmbiguousOrder) and exc.code in REJECTION_CODES)
                    if isinstance(exc, TransferRejected) and writer.enabled and not pending.get("writer_rejection"):
                        rejected = False  # Never release a partially rejected batch.
                    rejected |= pending.get("status") == "rejected" and isinstance(pending.get("writer_rejection"), dict)
                    pending["status"] = "rejected" if rejected else "unknown"
                    if rejected:
                        state["pending"] = None
                        state["retry_without_blocking"] = True
                        if isinstance(exc, RequestNotSent):
                            code = getattr(exc, "admission_code", None)
                            code = code if isinstance(code, str) and code in ADMISSION_CODES else "REQUEST_NOT_SENT"
                            pending["write_admission"] = {"code": code, "phase": "before_send"}
                            detail = ("账户仍有旧未决写入，须核对原请求；读取新余额不会解除该保护"
                                if code in {"ACCOUNT_UNRESOLVED", "OPERATION_UNRESOLVED"} else "发送前的本地校验未通过")
                            state["blocked_reason"] = f"划转未发送（{code}）：{detail}"
                        elif isinstance(exc, TransferRejected):
                            state["blocked_reason"] = f"交易所明确拒绝本次保证金划转（{exc.code}），本次未划转；冷却后重新评估"
                        elif pending.get("writer_rejection"):
                            state["blocked_reason"] = "划转拒绝回执已持久保存，共享结算等待恢复；不重发原请求"
                        if pending.get("writer_rejection"):
                            writer.settle_transfer(pair, pending)
                        state["last_transfer"] = dict(pending)
                self._apply_api_wait(state, exc)
                if state.get("api_notice"):
                    state["blocked_reason"] = state["api_notice"]["text"]
            finally:
                transfer.close()
                self._invalidate(members)
            self.store.put(key, state)
            if pending["status"] == "acknowledged":
                return self._view(state, config, "acknowledged", "交易所已确认划转，继续刷新两侧余额", blocks=True)
            reason = {"unknown": "划转结果未知，等待重新读取两侧余额后自动跳过旧核对；原请求会归档，不会重发或标记为成功",
                      "rejected": "划转请求明确未被接受，本次未划转；冷却结束后系统重新评估划转条件"}[pending["status"]]
            if state.get("api_notice"):
                reason += "；" + state["api_notice"]["text"]
            elif pending["status"] == "rejected" and state.get("blocked_reason"):
                reason = state["blocked_reason"]
            return self._view(state, config, pending["status"], reason, blocks=True, plan=plan)

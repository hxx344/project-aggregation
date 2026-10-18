"""Shared account ownership for managed Aster transports and durable receipts."""
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from functools import wraps
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import threading
import time

from .models import TradingError, dec


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str, allow_nan=False).encode()).hexdigest()


class _UnmanagedWriter:
    enabled = False

    @contextmanager
    def accounts(self, *args, **kwargs):
        yield None

    batch = accounts

    @staticmethod
    def wrap(function):
        return function

    @staticmethod
    def bind_api(*args):
        pass

    @staticmethod
    def resolve_prefix(*args, **kwargs):
        pass

    settle_intent = resolve_prefix
    settle_pair = resolve_prefix
    settle_adl = resolve_prefix
    settle_transfer = resolve_prefix


_UNMANAGED = _UnmanagedWriter()


def writer_for(engine):
    return getattr(engine, "account_writer", _UNMANAGED)


def protected_account(method):
    @wraps(method)
    def run(self, account_id, *args, **kwargs):
        writer = getattr(self, "account_writer", None)
        if writer is None or not writer.enabled:
            return method(self, account_id, *args, **kwargs)
        with writer.accounts([account_id]):
            return method(self, account_id, *args, **kwargs)
    return run


def protected_pair(method):
    @wraps(method)
    def run(self, pair, *args, **kwargs):
        writer = getattr(self.engine, "account_writer", None)
        if writer is None or not writer.enabled:
            return method(self, pair, *args, **kwargs)
        with writer.accounts([pair["long_account_id"], pair["short_account_id"]]):
            return method(self, pair, *args, **kwargs)
    return run


def protected_pair_id(method):
    @wraps(method)
    def run(self, pair_id, *args, **kwargs):
        writer = writer_for(self.engine)
        pair = self.store.pair(pair_id) if writer.enabled else None
        if pair is None:
            return method(self, pair_id, *args, **kwargs)
        with writer.accounts([pair["long_account_id"], pair["short_account_id"]]):
            return method(self, pair_id, *args, **kwargs)
    return run


def protected_transfer(method):
    @wraps(method)
    def run(self, pair, *args, **kwargs):
        writer = writer_for(self.engine)
        if not writer.enabled:
            return method(self, pair, *args, **kwargs)
        ids = [pair["long_account_id"], pair["short_account_id"], "master:" + pair["margin"]["master_env_prefix"]]
        with writer.accounts(ids):
            return method(self, pair, *args, **kwargs)
    return run


class ManagedWriter:
    scope = {"authority": "aster", "environment": "mainnet"}

    def __init__(self, engine):
        self.engine = engine
        self.enabled = os.environ.get("WORKSPACE_MANAGED") == "1"
        self.ready = not self.enabled
        self.registry = None
        self.connections = {}
        self.error = None
        self.current = ContextVar("aster_writer_ticket", default=None)
        self.current_ids = ContextVar("aster_writer_connections", default=())
        self.active_batch = ContextVar("aster_writer_batch", default=None)
        self.lock = threading.RLock()
        self.observed_orders = {}
        if not self.enabled:
            return
        source = Path(os.environ.get("WORKSPACE_WRITER_MODULE", ""))
        database = os.environ.get("WORKSPACE_WRITER_DB", "")
        runtime = os.environ.get("WORKSPACE_RUNTIME_ID", "")
        if not source.is_absolute() or not Path(database).is_absolute() or not runtime:
            raise RuntimeError("Managed account writer configuration is missing")
        spec = importlib.util.spec_from_file_location("workspace_account_writer", source)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.registry = module.AccountWriter(database, "aster", runtime)
        self.refresh_bindings()

    def refresh_bindings(self):
        """Register every configured live connection before doing private reads."""
        if not self.enabled:
            return
        configured = {account["id"]: account["env_prefix"] for account in self.engine.store.accounts()
                      if account["mode"] == "live"}
        for pair in self.engine.store.pairs():
            prefix = pair.get("margin", {}).get("master_env_prefix")
            margin_state = self.engine.store.get("pair_margin:" + pair["id"], {})
            pending = margin_state.get("pending") if isinstance(margin_state, dict) else True
            if prefix and (pair.get("margin", {}).get("enabled") or pending):
                configured["master:" + prefix] = prefix
        with self.lock:
            for connection in set(self.connections) - set(configured):
                self.registry.release_binding(connection)
                self.connections.pop(connection)
            for connection, prefix in configured.items():
                revision = digest([os.environ.get(prefix + suffix, "")
                                   for suffix in ("_USER", "_SIGNER", "_PRIVATE_KEY")])
                previous = self.connections.get(connection)
                if previous is None or previous["revision"] != revision or previous["prefix"] != prefix:
                    self.registry.bind(connection, None, revision, self.scope)
                    self.connections[connection] = {"prefix": prefix, "revision": revision, "identity": None}

    def verify_connection(self, connection):
        from .exchange import API, credentials_for
        row = self.connections[connection]
        if time.monotonic() < row.get("retry_at", 0):
            raise TradingError("账户身份读取尚在退避，保持只读")
        row["retry_at"] = time.monotonic() + 30
        if connection.startswith("master:"):
            api = API(credentials_for(row["prefix"]))
            try:
                self.verify(connection, api)
            finally:
                api.close()
        else:
            self.verify(connection, self.engine.broker(self.engine.store.account(connection)).api)

    def verify(self, connection, api):
        row = self.connections[connection]
        if digest([api.credentials.get(key) for key in ("user", "signer", "private_key")]) != row["revision"]:
            raise TradingError("账户客户端凭据与配置版本不一致，须重启核实")
        # A successful authenticated private account response proves the USER
        # address's signing authorization; the local signer address alone cannot.
        raw = api.call("GET", "/fapi/v3/accountWithJoinMargin", signed=True, weight=5)
        if not isinstance(raw, dict) or not isinstance(raw.get("assets"), list):
            raise TradingError("交易所没有返回可核验的账户信息")
        user = api.credentials["user"].lower()
        if len(user) != 42 or not user.startswith("0x"):
            raise TradingError("交易所账户钱包身份无效")
        identity = {**self.scope, "accountId": user}
        self.registry.bind(connection, identity, row["revision"], self.scope)
        row["identity"] = identity
        row["externalAccountId"] = str(raw["accountId"]) if raw.get("accountId") is not None else None
        self.bind_api(api, connection)

    def bind_api(self, api, connection):
        if self.enabled:
            api.account_writer = self
            api.writer_connection = connection

    def initialize(self):
        if not self.enabled:
            return
        self.refresh_bindings()
        self.error = None
        for connection, row in list(self.connections.items()):
            try:
                if row["identity"] is None:
                    self.verify_connection(connection)
            except Exception:
                self.error = "部分实盘账户身份尚未核实，账户保持只读"
        # No new side effect is admitted until the complete old inventory has
        # been imported, including pending records belonging to paused accounts.
        try:
            self.import_legacy()
            self.ready = True
        except Exception as exc:
            self.error = "持久恢复记录或账户所有权尚未核实，账户保持只读"
            self.ready = False
            verified = [row["identity"] for row in self.connections.values() if row["identity"] is not None]
            if verified and (not hasattr(exc, "code") or exc.code == "OPERATION_CONFLICT"):
                self.registry.freeze(verified, "legacy-conflict")

    def _identities(self, ids):
        identities = []
        for connection in ids:
            account = self.engine.store.account(connection) if not connection.startswith("master:") else None
            if account is not None and account["mode"] == "paper":
                continue
            row = self.connections.get(connection)
            if row is not None and row["identity"] is None:
                self.verify_connection(connection)
            if row is None or row["identity"] is None:
                raise TradingError("实盘账户身份尚未核实，禁止交易写入")
            revision = digest([os.environ.get(row["prefix"] + suffix, "")
                               for suffix in ("_USER", "_SIGNER", "_PRIVATE_KEY")])
            if revision != row["revision"]:
                raise TradingError("账户凭据已改变，须重新核实身份")
            identities.append(row["identity"])
        return identities

    @contextmanager
    def accounts(self, ids, *, recovery=False):
        if not self.enabled:
            yield None
            return
        if not self.ready and not recovery:
            raise TradingError(self.error or "账户写入保护尚未就绪")
        self.refresh_bindings()
        identities = self._identities(ids)
        if not identities:
            yield None
            return
        # Nested helpers must retain the complete parent ticket. Reducing it to
        # one leg would lose the other account's final-send fence checks.
        parent = self.current.get()
        combined = sorted(set(self.current_ids.get()) | set(ids))
        try:
            ticket = (self.registry.claim(self._identities(combined))
                      if parent is None or set(ids) - set(self.current_ids.get()) else parent)
        except Exception as exc:
            if recovery and getattr(exc, "code", None) in {"ACCOUNT_PINNED", "OWNER_ALIVE"}:
                self.registry.freeze(identities, "legacy-conflict")
            raise
        self.registry.assert_owned(ticket)
        token = self.current.set(ticket)
        ids_token = self.current_ids.set(tuple(combined))
        try:
            yield ticket
        finally:
            self.current.reset(token)
            self.current_ids.reset(ids_token)

    def wrap(self, function):
        context = copy_context()
        return lambda *args, **kwargs: context.copy().run(function, *args, **kwargs)

    def assert_current(self):
        ticket = self.current.get()
        if self.enabled and ticket is not None:
            try:
                self.registry.assert_owned(ticket, budget_ms=0)
            except Exception as exc:
                raise TradingError("账户写入所有权已失效，拒绝旧执行者状态写回") from exc

    @contextmanager
    def batch(self, operation_id, payload):
        if not self.enabled:
            yield
            return
        ticket = self.current.get()
        if ticket is None:
            raise TradingError("多账户写入缺少整体账户所有权")
        try:
            operation = self.registry.prepare(ticket, operation_id, payload)
        except Exception as exc:
            raise TradingError("账户有未决交易或不具备整体写入权，未发送请求") from exc
        state = {"operation": operation, "unknown": False, "sent": False, "lock": threading.Lock()}
        token = self.active_batch.set(state)
        try:
            yield
        except BaseException:
            state["unknown"] = True
            raise
        finally:
            self.active_batch.reset(token)
            self.registry.assert_owned(operation, budget_ms=0)
            self.registry.finish(operation, "unknown" if state["unknown"] else "confirmed" if state["sent"] else "rejected")

    def prepare(self, api, method, path, params):
        if not self.enabled:
            return None
        from .exchange import RequestNotSent
        if not self.ready or self.engine.workspace.active or self.engine.shutdown.is_set():
            raise RequestNotSent("工作台维护、账户保护未就绪或正在停止，未发送请求")
        connection = api.writer_connection
        try:
            self._identities([connection])
            if digest([api.credentials.get(key) for key in ("user", "signer", "private_key")]) != self.connections[connection]["revision"]:
                raise TradingError("实际交易凭据版本已变化")
            ticket = self.current.get() or self.registry.claim(self._identities([connection]))
            self.registry.assert_owned(ticket)
        except Exception as exc:
            raise RequestNotSent("账户真实身份或写入权未通过验证，未发送请求") from exc
        batch = self.active_batch.get()
        if batch is not None:
            return {"batch": batch, "ticket": batch["operation"]}
        operation = self.operation_id(connection, method, path, params)
        try:
            prepared = self.registry.prepare(ticket, operation, {"method": method, "path": path, "params": params})
        except Exception as exc:
            raise RequestNotSent("账户存在未决操作或写入权已变化，未发送请求") from exc
        return {"ticket": prepared}

    def operation_id(self, connection, method, path, params):
        if path.endswith("/order"):
            identity = params.get("newClientOrderId") or params.get("origClientOrderId")
        elif path.endswith("/batchOrders"):
            orders = json.loads(params["batchOrders"])
            identity = digest([row["newClientOrderId"] for row in orders])
        elif path.endswith("/leverage"):
            intent = self.engine.store.intent(connection)
            identity = intent["id"] if intent else None
        else:
            identity = None
        if not isinstance(identity, str) or not identity:
            raise TradingError("交易操作缺少持久原始身份，未发送请求")
        return "aster:" + path.rsplit("/", 1)[-1] + ":" + method + ":" + identity

    @staticmethod
    def validate_response(path, params, result):
        from .exchange import AmbiguousOrder, ORDER_REJECTION_CODES
        if path.endswith("/subAccountTransfer"):
            if not isinstance(result, dict) or result.get("code") not in (0, 200, "0", "200") or str(result.get("msg", "")).lower() != "success":
                raise AmbiguousOrder("划转回执尚未明确确认")
        elif path.endswith("/leverage"):
            if not isinstance(result, dict) or result.get("symbol") != params.get("symbol") or dec(result.get("leverage")) != dec(params.get("leverage")):
                raise AmbiguousOrder("杠杆变更回执与原始参数不一致")
        else:
            orders = json.loads(params["batchOrders"]) if path.endswith("/batchOrders") else [params]
            rows = result if isinstance(result, list) else [result]
            if len(rows) != len(orders):
                raise AmbiguousOrder("交易所回执数量与原始订单不一致")
            for order, row in zip(orders, rows):
                if isinstance(row, dict) and type(row.get("code")) is int and row["code"] in ORDER_REJECTION_CODES:
                    continue
                cid = order.get("newClientOrderId") or order.get("origClientOrderId")
                if not isinstance(row, dict) or row.get("clientOrderId") != cid or row.get("symbol") != order.get("symbol") or not row.get("orderId"):
                    raise AmbiguousOrder("交易所回执缺少匹配的原始订单身份")
                if "newClientOrderId" in order and not ManagedWriter._verified_receipt(order, row):
                    raise AmbiguousOrder("交易所回执与原始订单方向或数量不一致")

    def before_send(self, prepared):
        if prepared is not None:
            from .exchange import RequestNotSent
            try:
                self.registry.assert_owned(prepared["ticket"])
            except Exception as exc:
                raise RequestNotSent("发送前账户所有权已改变，未发送请求") from exc
            if "batch" in prepared:
                with prepared["batch"]["lock"]:
                    prepared["batch"]["sent"] = True

    def finish(self, prepared, outcome):
        if prepared is None:
            return
        self.registry.assert_owned(prepared["ticket"], budget_ms=0)
        if "batch" in prepared:
            with prepared["batch"]["lock"]:
                prepared["batch"]["unknown"] |= outcome == "unknown"
            return
        self.registry.finish(prepared["ticket"], outcome)

    def resolve_prefix(self, prefix, *, rejected=False):
        if not self.enabled:
            return
        ticket = self.current.get()
        if ticket is None:
            return
        active = self.active_batch.get()
        if active is not None and active["operation"]["operationId"] == prefix:
            return
        for row in self.registry.unresolved(ticket):
            if row["operationId"] == prefix:
                self.registry.resolve(row["operationId"], ticket, outcome="rejected" if rejected else "confirmed")

    def import_legacy(self):
        store = self.engine.store
        with store.connect() as db:
            intents = [json.loads(row[0]) for row in db.execute("SELECT data FROM intents WHERE status NOT IN ('complete','aborted')")]
            records = [(row[0], json.loads(row[1])) for row in db.execute(
                "SELECT key,data FROM kv WHERE key GLOB 'pair_runtime:*' OR key GLOB 'pair_margin:*' OR key GLOB 'adl_pair:*'")]
        for intent in intents:
            account = store.account(intent["account_id"])
            if account is None or account["mode"] == "live":
                with self.accounts([intent["account_id"]], recovery=True) as ticket:
                    self.registry.import_unknown(ticket, "aster:legacy:intent:" + intent["id"],
                        {key: intent.get(key) for key in ("id", "kind", "symbol", "orders", "target")})
                    for item in intent.get("repairs", []):
                        order = item.get("order", item)
                        self.registry.import_unknown(ticket, "aster:legacy:order:" + order["newClientOrderId"], {"order": order})
                    self.settle_intent(intent)
        for key, state in records:
            if not isinstance(state, dict):
                continue
            pending = state.get("pending")
            batches = state.get("recovery_watch", {}).get("batches", []) if isinstance(state.get("recovery_watch"), dict) else []
            active_adl = key.startswith("adl_pair:") and (state.get("status") != "completed" or state.get("hold"))
            if not pending and not batches and not active_adl:
                continue
            pair = store.pair(key.split(":", 1)[1])
            if pair is None:
                raise TradingError("恢复记录缺少原始配对账户，禁止新写入")
            ids = [pair["long_account_id"], pair["short_account_id"]]
            if key.startswith("pair_margin:"):
                ids.append("master:" + pair["margin"]["master_env_prefix"])
            if all(store.account(aid) and store.account(aid)["mode"] == "paper" for aid in ids):
                continue
            with self.accounts(ids, recovery=True) as ticket:
                if pending:
                    identity = pending.get("id") or pending.get("request_id")
                    if not identity:
                        raise TradingError("未决记录缺少持久操作身份")
                    payload = {field: pending.get(field) for field in ("id", "request_id", "kind", "symbol", "target_leverage", "amount", "source", "destination")}
                    payload["orders"] = [leg["order"] for leg in pending.get("legs", [])]
                    self.registry.import_unknown(ticket, "aster:legacy:" + key + ":" + identity, payload)
                    for leg in pending.get("repairs", []):
                        order = leg["order"]
                        self.registry.import_unknown(ticket, "aster:legacy:order:" + order["newClientOrderId"], {"order": order})
                for batch in batches:
                    for leg in batch.get("legs", []) + batch.get("repairs", []):
                        order = leg["order"]
                        self.registry.import_unknown(ticket, "aster:legacy:order:" + order["newClientOrderId"], {"order": order})
                if active_adl:
                    for batch in state.get("batches", []) + state.get("prior_orders", []):
                        if batch.get("state") != "terminal":
                            order = batch["order"]
                            self.registry.import_unknown(ticket, "aster:legacy:order:" + order["newClientOrderId"], {"order": order})
                if key.startswith("adl_pair:"):
                    self.settle_adl(pair, state)
                elif key.startswith("pair_runtime:"):
                    self.settle_pair(pair, state)
                elif key.startswith("pair_margin:") and pending and pending.get("status") == "acknowledged":
                    self.settle_transfer(pair, pending)

    @staticmethod
    def _verified_receipt(order, row):
        if not isinstance(row, dict) or not row.get("orderId"):
            return False
        if (row.get("clientOrderId") != order.get("newClientOrderId") or row.get("symbol") != order.get("symbol")
                or row.get("side") != order.get("side") or row.get("positionSide") != order.get("positionSide")
                or row.get("status") not in {"NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"}):
            return False
        try:
            quantity, filled = dec(order.get("quantity")), dec(row.get("executedQty"))
            return (dec(row.get("origQty")) == quantity and 0 <= filled <= quantity
                    and (row["status"] != "FILLED" or filled == quantity)
                    and (filled == 0 or dec(row.get("avgPrice")) > 0))
        except TradingError:
            return False

    @staticmethod
    def _durable_outcome(order, row):
        """Trust only a validated receipt or an explicit durable no-send/reject."""
        if ManagedWriter._verified_receipt(order, row):
            return "confirmed"
        if not isinstance(row, dict) or row.get("status") != "REJECTED":
            return None
        from .exchange import ORDER_REJECTION_CODES
        if any(row.get(key) != order.get(key) for key in ("symbol", "side", "positionSide")) or row.get("clientOrderId") != order.get("newClientOrderId"):
            return None
        try:
            if dec(row.get("executedQty")) != 0 or dec(row.get("quantity")) != dec(order["quantity"]):
                return None
        except TradingError:
            return None
        return "rejected" if row.get("local_not_sent") is True or row.get("reject_code") in ORDER_REJECTION_CODES else None

    def observe_order(self, connection, symbol, client_id, row, *, persisted=False):
        """Resolve from matching original-ID reads or persisted verified receipts."""
        if not self.enabled or self.current.get() is None:
            return
        store = self.engine.store
        groups = []
        intent = store.intent(connection)
        if intent and intent.get("kind") != "leverage":
            orders = intent.get("orders", []) + intent.get("repairs", [])
            orders = [item.get("order", item) for item in orders]
            groups.append(([(connection, order) for order in orders],
                           ["aster:legacy:intent:" + intent["id"]]))
            originals = intent.get("orders", [])
            if intent.get("kind") == "migration":
                originals = [order for order in originals if intent.get("order_roles", {}).get(order["newClientOrderId"]) == "open_target"]
            groups.append(([(connection, order) for order in originals], []))
            by_id = {order["newClientOrderId"]: order for order in orders}
            batches = list(intent.get("repair_batches", {}).values()) + [batch["cids"] for batch in intent.get("reduction_batches", [])]
            for ids in batches:
                groups.append(([(connection, by_id[cid]) for cid in ids], []))
        for pair in store.pairs():
            member_ids = {side: pair[side + "_account_id"] for side in ("long", "short")}
            if connection not in member_ids.values():
                continue
            state = store.get("pair_runtime:" + pair["id"], {})
            pending = state.get("pending")
            batches = ([pending] if pending and pending.get("kind") != "leverage" else [])
            watch = state.get("recovery_watch")
            if isinstance(watch, dict):
                batches += watch.get("batches", [])
            adl = store.get("adl_pair:" + pair["id"], {})
            frozen = adl.get("frozen_runtime", {}) if isinstance(adl, dict) else {}
            old = frozen.get("pending")
            if old and old.get("kind") != "leverage":
                batches.append(old)
            if isinstance(frozen.get("recovery_watch"), dict):
                batches += frozen["recovery_watch"].get("batches", [])
            for batch in batches:
                legs = batch.get("legs", []) + batch.get("repairs", [])
                bindings = [(member_ids[leg["key"]], leg["order"]) for leg in legs]
                operations = ["aster:legacy:pair_runtime:" + pair["id"] + ":" + batch["id"]]
                groups.append((bindings, operations))
                dispatches = batch.get("writer_dispatches")
                if dispatches is None:
                    # Pre-M1 records only have the original two-leg dispatch;
                    # their repairs have no shared parent operation to infer.
                    originals = batch.get("legs", [])
                    groups.append(([(member_ids[leg["key"]], leg["order"]) for leg in originals],
                        ["aster:pair-orders:" + batch["id"] + ":" + ":".join(leg["order"]["newClientOrderId"] for leg in originals)]))
                else:
                    by_id = {leg["order"]["newClientOrderId"]: leg for leg in legs}
                    if not isinstance(dispatches, list) or len(dispatches) > 32:
                        raise TradingError("持久配对发送分组无效，保留共享未知操作")
                    for dispatch in dispatches:
                        ids = dispatch.get("clientOrderIds") if isinstance(dispatch, dict) else None
                        if (not isinstance(ids, list) or not ids or any(not isinstance(cid, str) or cid not in by_id for cid in ids)
                                or len(set(ids)) != len(ids)
                                or dispatch.get("operationId") != "aster:pair-orders:" + batch["id"] + ":" + ":".join(ids)):
                            raise TradingError("持久发送分组与原始订单不一致，保留共享未知操作")
                        groups.append(([(member_ids[by_id[cid]["key"]], by_id[cid]["order"]) for cid in ids], [dispatch["operationId"]]))
            for batch in adl.get("batches", []) + adl.get("prior_orders", []):
                groups.append(([(batch["account_id"], batch["order"])], []))
        with self.lock:
            for bindings, operations in groups:
                matched = next((order for owner, order in bindings if owner == connection
                                and order.get("newClientOrderId") == client_id and order.get("symbol") == symbol), None)
                outcome = self._durable_outcome(matched, row) if matched is not None and persisted else "confirmed" if matched is not None and self._verified_receipt(matched, row) else None
                if outcome is None:
                    continue
                old = self.observed_orders.get((connection, client_id))
                if old and dec(row["executedQty"]) < dec(old["executedQty"]):
                    raise TradingError("原单核对累计成交倒退，保留未知状态")
                self.observed_orders[(connection, client_id)] = dict(row)
                self.resolve_prefix("aster:order:POST:" + client_id, rejected=outcome == "rejected")
                self.resolve_prefix("aster:legacy:order:" + client_id, rejected=outcome == "rejected")
                if row["status"] in {"FILLED", "CANCELED", "EXPIRED", "EXPIRED_IN_MATCH", "REJECTED"}:
                    self.resolve_prefix("aster:order:DELETE:" + client_id)
                outcomes = [self._durable_outcome(order, self.observed_orders.get((owner, order["newClientOrderId"]))) for owner, order in bindings]
                if bindings and all(outcomes):
                    for operation in operations:
                        self.resolve_prefix(operation, rejected=all(value == "rejected" for value in outcomes))
                    self.resolve_prefix("aster:batchOrders:POST:" + digest([order["newClientOrderId"] for _, order in bindings]), rejected=all(value == "rejected" for value in outcomes))

    def settle_intent(self, intent):
        if not self.enabled or self.current.get() is None:
            return
        frozen = intent.get("bounded_recovery", {}).get("identity", {})
        if not self._same_user(intent.get("account_id"), frozen):
            return
        for item in intent.get("orders", []) + intent.get("repairs", []):
            order = item.get("order", item)
            row = intent.get("receipts", {}).get(order["newClientOrderId"])
            if row is not None:
                self.observe_order(intent["account_id"], order["symbol"], order["newClientOrderId"], row, persisted=True)

    def settle_pair(self, pair, state):
        if not self.enabled or self.current.get() is None:
            return
        frozen = state.get("identities", {})
        if not all(self._same_user(pair[side + "_account_id"], frozen.get(side, {})) for side in ("long", "short")):
            return
        pending = state.get("pending")
        batches = [pending] if isinstance(pending, dict) and pending.get("kind") != "leverage" else []
        watch = state.get("recovery_watch")
        if isinstance(watch, dict):
            batches += watch.get("batches", [])
        for batch in batches:
            identities = batch.get("identities", {})
            if not all(self._same_user(pair[side + "_account_id"], identities.get(side, {})) for side in ("long", "short")):
                continue
            for leg in batch.get("legs", []) + batch.get("repairs", []):
                if leg.get("receipt") is not None:
                    order = leg["order"]
                    self.observe_order(pair[leg["key"] + "_account_id"], order["symbol"], order["newClientOrderId"], leg["receipt"], persisted=True)

    def settle_adl(self, pair, incident):
        if not self.enabled or self.current.get() is None:
            return
        self.settle_pair(pair, incident.get("frozen_runtime", {}))
        identities = incident.get("identities", {})
        if not all(self._same_user(pair[side + "_account_id"], identities.get(side, {})) for side in ("long", "short")):
            return
        for item in incident.get("batches", []) + incident.get("prior_orders", []):
            if item.get("receipt") is not None:
                order = item["order"]
                self.observe_order(item["account_id"], order["symbol"], order["newClientOrderId"], item["receipt"], persisted=True)

    def _same_user(self, connection, frozen):
        current = self.connections.get(connection, {}).get("identity")
        return bool(current and isinstance(frozen, dict) and frozen.get("user", "").lower() == current["accountId"])

    def settle_transfer(self, pair, pending):
        if not self.enabled or self.current.get() is None:
            return
        if (pending.get("status") != "acknowledged" or type(pending.get("acknowledgement_code")) is not int
                or pending.get("acknowledgement_code") not in (0, 200)
                or not isinstance(pending.get("request_id"), str) or not pending["request_id"]):
            return
        members = {side: self.engine.store.account(pair[side + "_account_id"]) for side in ("long", "short")}
        from .exchange import credentials_for
        from .margin_balance import MarginBalancer
        acknowledged = pending.get("acknowledged_at")
        if (not MarginBalancer._valid_pending(pending) or type(acknowledged) not in (int, float)
                or not math.isfinite(acknowledged) or acknowledged < pending["created_at"]):
            raise TradingError("持久划转成功回执缺少有效的原请求或确认时间")
        children = {side: credentials_for(member["env_prefix"]) for side, member in members.items()}
        master = credentials_for(pair["margin"]["master_env_prefix"])
        if pending.get("identity") != MarginBalancer._fingerprint(pair, members, children, master):
            raise TradingError("持久划转成功回执的原账户身份不一致")
        with self.accounts([member["id"] for member in members.values()] + ["master:" + pair["margin"]["master_env_prefix"]], recovery=not self.ready):
            self.resolve_prefix("aster:transfer:" + pending["request_id"])
            self.resolve_prefix("aster:legacy:pair_margin:" + pair["id"] + ":" + pending["request_id"])

    def status(self):
        return {"writerProtectionVersion": 1 if self.enabled and self.registry is not None else None,
                "recoveryProtectionVersion": getattr(self.registry, "recovery_protection_version", None),
                "ready": self.ready, "registeredConnections": len(self.connections), "error": self.error}

    def close(self):
        if self.registry is not None:
            self.registry.close()

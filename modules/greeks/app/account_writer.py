"""Managed-account admission at the final Bybit transport boundary."""
from contextvars import ContextVar
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from decimal import Decimal, InvalidOperation


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class ManagedWriter:
    def __init__(self, engine):
        self.engine = engine
        self.enabled = os.environ.get("WORKSPACE_MANAGED") == "1"
        self.ready = not self.enabled
        self.identity = None
        self.error = None
        self.current = ContextVar("greeks_writer_ticket", default=None)
        self.registry = None
        self.verified_orders = {}
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
        self.registry = module.AccountWriter(database, "greeks", runtime)
        self.revision = self._revision()
        if engine.settings.bybit_api_key or engine.settings.bybit_api_secret or self._has_legacy_recovery():
            self.registry.bind("bybit", None, self.revision, self.scope)

    def _has_legacy_recovery(self):
        return bool(self.engine.state_error or any(not entry.get("terminal") for entry in self.engine.order_journal.values())
                    or self.engine._rfq_unresolved())

    @property
    def scope(self):
        return {"authority": "bybit", "environment": "testnet" if self.engine.settings.private_testnet else "mainnet"}

    def _revision(self):
        settings = self.engine.settings
        return _digest([settings.bybit_api_key, settings.bybit_api_secret, settings.private_testnet])

    async def initialize(self):
        if not self.enabled:
            return
        settings = self.engine.settings
        if not settings.bybit_api_key and not settings.bybit_api_secret:
            if self._has_legacy_recovery():
                self.registry.bind("bybit", None, self.revision, self.scope)
                self.ready = False
                self.error = "旧交易库存尚未核实且账户凭据缺失，保持只读"
            else:
                self.ready = True
            return
        try:
            raw = await self.engine.client.api_key_info()
            uid = raw.get("userID")
            if isinstance(uid, bool) or not isinstance(uid, (str, int)) or not str(uid).isdigit() or int(uid) <= 0:
                raise ValueError("Bybit did not verify the account UID")
            if type(raw.get("isMaster")) is not bool or type(raw.get("readOnly")) is not int or raw.get("readOnly") not in (0, 1):
                raise ValueError("Bybit account identity or API permissions are incomplete")
            parent = raw.get("parentUid")
            if not isinstance(parent, (str, int)) or isinstance(parent, bool) or not str(parent).isdigit():
                raise ValueError("Bybit did not verify the parent account identity")
            if raw["isMaster"] != (int(parent) == 0):
                raise ValueError("Bybit returned inconsistent parent account identity")
            self.identity = {**self.scope, "accountId": str(int(uid))}
            if int(parent):
                self.identity["parentAccountId"] = str(int(parent))
            self.read_only = raw["readOnly"] == 1
            self.registry.bind("bybit", self.identity, self.revision, self.scope)
            if self.engine.state_error:
                self.registry.freeze([self.identity], "legacy-conflict")
                raise ValueError("Legacy trading inventory is unreadable")
            needs_import = any(not entry.get("terminal") for entry in self.engine.order_journal.values()) or self.engine._rfq_unresolved()
            if not needs_import:
                self.ready = True
                return
            try:
                ticket = self.registry.claim([self.identity])
            except Exception as exc:
                if getattr(exc, "code", None) in {"ACCOUNT_PINNED", "OWNER_ALIVE"}:
                    self.registry.freeze([self.identity], "legacy-conflict")
                raise
            # Import old original identities before opening any write admission.
            for link, entry in self.engine.order_journal.items():
                if not entry.get("terminal"):
                    self.registry.import_unknown(ticket, "greeks:legacy:order:" + link,
                        {"symbol": entry["symbol"], "side": entry["side"], "qty": str(entry["qty"]), "orderLinkId": link})
            if self.engine._rfq_unresolved():
                state = self.engine.rfq_state
                identity = state.get("rfq_link_id") or state.get("rfq_id")
                if not isinstance(identity, str) or not identity:
                    raise ValueError("Unresolved RFQ has no original identity")
                phase = "execute" if state.get("selected_quote_id") else "cancel" if state.get("status") == "CancelUnknown" else "create"
                payload = {"rfq_link_id": state.get("rfq_link_id"), "legs": state.get("legs")}
                if phase != "create":
                    payload["rfq_id"] = state.get("rfq_id")
                if phase == "execute":
                    payload.update(quote_id=state.get("selected_quote_id"), quote_side=state.get("selected_quote_side"))
                self.registry.import_unknown(ticket, "greeks:legacy:rfq:" + identity + ":" + phase, payload)
            self.ready = True
            self.error = None
        except Exception as exc:
            if self.identity is not None and getattr(exc, "code", None) == "OPERATION_CONFLICT":
                self.registry.freeze([self.identity], "legacy-conflict")
            self.error = "账户身份或持久恢复记录尚未核实，交易只读"
            # Preserve the unknown binding; absence of identity cannot grant writes.
            self.ready = False

    def claim(self):
        if not self.enabled:
            return None
        self.assert_current()
        if not self.ready or self.identity is None or self._revision() != self.revision or self.read_only:
            raise ValueError(self.error or "账户身份尚未核实或 API 只读，禁止交易写入")
        ticket = self.registry.claim([self.identity])
        self.current.set(ticket)
        return ticket

    def assert_current(self):
        ticket = self.current.get()
        if self.enabled and ticket is not None:
            self.registry.assert_owned(ticket, budget_ms=0)

    def prepare(self, method, path, body):
        if not self.enabled:
            return None
        if self.engine.workspace_maintenance or self.engine._trade_shutdown:
            raise ValueError("工作台维护或正在停止，未发送交易请求")
        client, settings = self.engine.client, self.engine.settings
        expected_url = "https://api-testnet.bybit.com" if settings.private_testnet else "https://api.bybit.com"
        if client.api_key != settings.bybit_api_key or client.api_secret != settings.bybit_api_secret or client.private_base_url != expected_url:
            raise ValueError("实际发送凭据或环境已变化，须重新核实账户身份")
        ticket = self.claim()
        if path.startswith("/v5/order/"):
            identity = body.get("orderLinkId")
        else:
            identity = body.get("rfqLinkId") or body.get("rfqId")
        if not isinstance(identity, str) or not identity:
            raise ValueError("交易写入缺少持久的原始请求身份")
        action = path.rsplit("/", 1)[-1]
        operation = "greeks:" + action + ":" + identity
        if action == "amend":
            entry = self.engine.order_journal.get(identity)
            if not isinstance(entry, dict) or entry.get("symbol") != body.get("symbol"):
                raise ValueError("改单缺少匹配的原订单持久记录")
            sequence = entry.get("amendment_sequence", 0)
            if type(sequence) is not int or sequence < 0:
                raise ValueError("原订单改单序号无效，禁止发送交易请求")
            # A new identity must not bypass an earlier amendment whose result
            # is still unknown or sending, including legacy body-hash IDs.
            if any(row["operationId"].startswith(operation + ":") for row in self.registry.unresolved(ticket)):
                raise ValueError("原订单的改单结果尚未核实，禁止重复发送")
            entry["amendment_sequence"] = sequence + 1
            # Persist the reservation before preparing or sending. A skipped
            # number is safe; reusing an already sent number after restart is not.
            self.engine._save_state()
            operation += ":" + str(entry["amendment_sequence"])
        payload = {"method": method, "path": path, "body": body}
        # The parent mapping is saved before the gather starts. Every child
        # keeps its own complete semantic payload and original order identity.
        if path.startswith("/v5/order/"):
            parent = self.engine.execution_group_links.get(identity)
            if parent and parent in self.engine.execution_groups:
                payload["groupId"] = "greeks:execution:" + parent
            else:
                payload["groupId"] = "greeks:order:" + identity
            target = {"symbol": body.get("symbol"), "clientOrderId": identity}
            if action == "amend":
                payload.update(intentAction="amend", intentTarget=target)
            elif action == "cancel":
                verified = self.verified_orders.get((body.get("symbol"), identity))
                if verified and 0 <= time.monotonic() - verified["observed_at"] <= 30:
                    payload.update(intentAction="cancel", intentTarget=target)
        else:
            state = self.engine.rfq_state
            parent = state.get("rfq_link_id") or state.get("rfq_id")
            if parent and identity in {state.get("rfq_link_id"), state.get("rfq_id")}:
                payload["groupId"] = "greeks:rfq:" + parent
        return self.registry.prepare(ticket, operation, payload)

    def observe_order(self, symbol, link, row):
        """Bind a cancellation exception to a fresh, strictly verified original."""
        if not self.enabled or not self.ready or not isinstance(row, dict):
            return
        entry = self.engine.order_journal.get(link)
        if not entry or entry.get("symbol") != symbol or row.get("symbol") != symbol or row.get("orderLinkId") != link:
            return
        if row.get("side") != entry.get("side") or not isinstance(row.get("orderId"), str) or not row["orderId"]:
            return
        statuses = {"New", "PartiallyFilled", "Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"}
        terminal = row.get("orderStatus") in {"Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"}
        if row.get("orderStatus") not in statuses:
            return
        try:
            qty, requested, filled, previous = [Decimal(str(value)) for value in
                (entry.get("qty"), row.get("qty"), row.get("cumExecQty"), entry.get("filledQty", 0))]
            if not all(value.is_finite() for value in (qty, requested, filled, previous)) or requested != qty or not previous <= filled <= qty:
                return
            if row["orderStatus"] == "Filled" and filled != qty:
                return
        except (InvalidOperation, ValueError, TypeError):
            return
        self.assert_current()
        self.resolved_order(link, terminal=terminal)
        self.verified_orders[(symbol, link)] = {"observed_at": time.monotonic()}

    def finish(self, operation, outcome):
        if operation is not None:
            self.registry.assert_owned(operation, budget_ms=0)
            self.registry.finish(operation, outcome)

    @staticmethod
    def validate_response(path, body, result):
        if path.startswith("/v5/order/"):
            if (not isinstance(result.get("orderId"), str) or not result["orderId"]
                    or result.get("orderLinkId") not in (None, "", body.get("orderLinkId"))):
                raise ValueError("Bybit order acknowledgement has no matching original identity")
        elif path.endswith("/create-rfq"):
            if not isinstance(result.get("rfqId"), str) or not result["rfqId"] or result.get("rfqLinkId") not in (None, "", body.get("rfqLinkId")):
                raise ValueError("Bybit inquiry acknowledgement has no matching original identity")
        elif result.get("rfqId") != body.get("rfqId") or ("quoteId" in result and result["quoteId"] != body.get("quoteId")):
            raise ValueError("Bybit RFQ acknowledgement has no matching original identity")

    def resolved_order(self, link, *, terminal):
        if not self.enabled or not self.ready:
            return
        ticket = self.claim()
        for row in self.registry.unresolved(ticket):
            operation = row["operationId"]
            create = operation in {"greeks:create:" + link, "greeks:legacy:order:" + link}
            amend = operation.startswith("greeks:amend:" + link + ":")
            cancel = operation == "greeks:cancel:" + link
            if create or (terminal and (amend or cancel)):
                self.registry.resolve(operation, ticket)

    def resolved_rfq(self, state):
        if not self.enabled or not self.ready:
            return
        ticket = self.claim()
        rfq_id, link, status = state.get("rfq_id"), state.get("rfq_link_id"), state.get("status")
        terminal = status in {"Filled", "Canceled", "Expired", "Failed"}
        for row in self.registry.unresolved(ticket):
            operation = row["operationId"]
            if operation in {"greeks:create-rfq:" + str(link), "greeks:legacy:rfq:" + str(link or rfq_id) + ":create"} or (terminal and operation in {
                    "greeks:execute-quote:" + str(rfq_id), "greeks:cancel-rfq:" + str(rfq_id),
                    "greeks:legacy:rfq:" + str(link or rfq_id) + ":execute", "greeks:legacy:rfq:" + str(link or rfq_id) + ":cancel"}):
                self.registry.resolve(operation, ticket)

    def status(self):
        return {"writerProtectionVersion": 1 if self.enabled and self.registry is not None else None,
                "recoveryProtectionVersion": getattr(self.registry, "recovery_protection_version", None),
                "ready": self.ready, "registeredConnections": int(self.identity is not None), "error": self.error}

    def close(self):
        if self.registry is not None:
            self.registry.close()

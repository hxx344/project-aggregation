"""Shared, fail-closed account write fencing. This module never sends exchange requests.

Adapters verify the remote account identity, persist their original operation identifiers,
and call assert_owned immediately before transport and before applying a response.
The SQLite schema, account keys, semantic hashes and JSON tickets match account-writer.mjs.
"""

from __future__ import annotations

import hashlib
from functools import wraps
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import threading
import time
import uuid

TTL_MS = 60_000
RECOVERY_SCHEMA_VERSION = 1
HEARTBEAT_MS = 5_000
SAFETY_MS = 10_000
AUTHORITIES = frozenset(("binance", "bybit", "okx", "gate-crossex", "aster"))
ENVIRONMENTS = frozenset(("mainnet", "testnet", "demo"))
SECRET_KEY = re.compile(r"^(?:api[_-]?key|api[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|signer|signature|timestamp|nonce|passphrase|password|authorization|access[_-]?token|refresh[_-]?token|token)$", re.I)
RECOVERY_IDS = ("authorityId", "recoveryId", "checkpointId", "handoffId", "sourceAuthorityId")
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class AccountWriterError(RuntimeError):
    def __init__(self, code):
        super().__init__(f"Account execution control: {code}")
        self.code = code


def _fail(code):
    raise AccountWriterError(code)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _identifier(value, code="INVALID_IDENTIFIER"):
    if not isinstance(value, str) or not value or len(value) > 256 or re.search(r"[\x00-\x1f\x7f]", value):
        _fail(code)
    return value


def _scope(value):
    if not isinstance(value, dict) or set(value) - {"authority", "environment"}:
        _fail("INVALID_SCOPE")
    if not isinstance(value.get("authority"), str) or not isinstance(value.get("environment"), str) or value["authority"] not in AUTHORITIES or value["environment"] not in ENVIRONMENTS:
        _fail("INVALID_SCOPE")
    return {"authority": value["authority"], "environment": value["environment"]}


def _uid(value, authority):
    if authority == "aster":
        if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
            _fail("INVALID_IDENTITY")
        return value.lower()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not 0 < value <= 9007199254740991 or not math.isfinite(value) or value != int(value):
            _fail("INVALID_IDENTITY")
        value = str(int(value))
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,128}", value):
        _fail("INVALID_IDENTITY")
    result = value.lstrip("0")
    if not result:
        _fail("INVALID_IDENTITY")
    return result


def normalize_account_identity(identity):
    if not isinstance(identity, dict) or set(identity) - {"authority", "environment", "accountId", "parentAccountId"}:
        _fail("INVALID_IDENTITY")
    result = _scope({"authority": identity.get("authority"), "environment": identity.get("environment")})
    result["accountId"] = _uid(identity.get("accountId"), result["authority"])
    if identity.get("parentAccountId") is not None:
        result["parentAccountId"] = _uid(identity["parentAccountId"], result["authority"])
    return result


def account_key(identity):
    value = normalize_account_identity(identity)
    return hashlib.sha256(f"account-writer:v1\0{value['authority']}\0{value['environment']}\0{value['accountId']}".encode()).hexdigest()


def _semantic(value, depth=0):
    if depth > 32:
        _fail("INVALID_PAYLOAD")
    if value is None:
        return ["null"]
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeError:
            _fail("INVALID_PAYLOAD")
        return ["string", value]
    if isinstance(value, bool):
        return ["boolean", value]
    if isinstance(value, (int, float)):
        if abs(value) > 9007199254740991 or not math.isfinite(value):
            _fail("INVALID_PAYLOAD")
        return ["number", struct.pack(">d", 0.0 if value == 0 else float(value)).hex()]
    if isinstance(value, list):
        return ["array", [_semantic(child, depth + 1) for child in value]]
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        _fail("INVALID_PAYLOAD")
    result = []
    for key in sorted(value):
        try:
            key.encode("utf-8")
        except UnicodeError:
            _fail("INVALID_PAYLOAD")
        if SECRET_KEY.fullmatch(key):
            _fail("UNSAFE_PAYLOAD")
        result.append([key, _semantic(value[key], depth + 1)])
    return ["object", result]


def _payload_hash(keys, payload):
    encoded = _json(_semantic({"accounts": keys, "payload": payload})).encode()
    if len(encoded) > 262144:
        _fail("INVALID_PAYLOAD")
    return hashlib.sha256(encoded).hexdigest()


def _exact_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def _positive_decimal(value):
    return isinstance(value, str) and len(value) <= 128 and re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is not None and re.search(r"[1-9]", value) is not None


def _margin_metadata(module_id, keys, payload):
    transfer = payload["marginTransfer"]
    if module_id != "aster" or not _exact_keys(payload, ("marginTransfer",)) or not _exact_keys(transfer, ("version", "method", "path", "params", "source", "destination", "master")) or type(transfer["version"]) not in (int, float) or transfer["version"] != 1 or transfer["method"] != "POST" or transfer["path"] != "/fapi/v3/subAccountTransfer":
        _fail("INVALID_MARGIN_TRANSFER")
    params = transfer["params"]
    if not _exact_keys(params, ("fromAccountAddress", "toAccountAddress", "asset", "amount", "kindType")) or params["asset"] != "USD1" or params["kindType"] != "FUTURE_FUTURE" or not _positive_decimal(params["amount"]) or not re.fullmatch(r"(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?", params["amount"]):
        _fail("INVALID_MARGIN_TRANSFER")
    whole, _, fraction = params["amount"].partition(".")
    if int(whole) * 100_000_000 + int(fraction.ljust(8, "0")) > 100_000_000_000_000_000:
        _fail("INVALID_MARGIN_TRANSFER")
    identities = [transfer[role] for role in ("source", "destination", "master")]
    for identity in identities:
        if not _exact_keys(identity, ("authority", "environment", "accountId")) or identity["authority"] != "aster" or identity["environment"] != "mainnet" or not isinstance(identity["accountId"], str) or not re.fullmatch(r"0x[0-9a-f]{40}", identity["accountId"]):
            _fail("INVALID_MARGIN_TRANSFER")
    transfer_keys = sorted(account_key(identity) for identity in identities)
    if len(set(transfer_keys)) != 3 or keys != transfer_keys or params["fromAccountAddress"] != identities[0]["accountId"] or params["toAccountAddress"] != identities[1]["accountId"]:
        _fail("INVALID_MARGIN_TRANSFER")
    return {"action": "margin-transfer", "targetHash": _payload_hash(keys, payload)}


def _original_order(value):
    required = {"symbol", "side", "type", "positionSide", "quantity", "newClientOrderId"}
    allowed = required | {"newOrderRespType", "timeInForce", "price", "reduceOnly"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - allowed:
        return False
    return (isinstance(value["symbol"], str) and re.fullmatch(r"[A-Z0-9_]{1,64}", value["symbol"]) is not None
            and value["side"] in ("BUY", "SELL") and value["positionSide"] in ("LONG", "SHORT", "BOTH") and value["type"] in ("MARKET", "LIMIT") and _positive_decimal(value["quantity"])
            and isinstance(value["newClientOrderId"], str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,36}", value["newClientOrderId"]) is not None
            and ("newOrderRespType" not in value or value["newOrderRespType"] in ("ACK", "RESULT"))
            and ("timeInForce" not in value or value["timeInForce"] in ("GTC", "IOC", "FOK", "GTX"))
            and ("price" not in value or _positive_decimal(value["price"])) and (value["type"] != "LIMIT" or ("price" in value and "timeInForce" in value))
            and ("reduceOnly" not in value or type(value["reduceOnly"]) is bool or value["reduceOnly"] in ("true", "false")))


def _valid_symbol(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Z0-9_]{1,64}", value) is not None


def _valid_leverage(value):
    if isinstance(value, str):
        return re.fullmatch(r"(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-5])", value) is not None
    return type(value) in (int, float) and math.isfinite(value) and value == int(value) and 1 <= value <= 125


def _legacy_id(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and re.search(r"[\x00-\x1f\x7f]", value) is None


def _matching_orders(orders, symbol=None):
    return isinstance(orders, list) and 0 < len(orders) <= 100 and all(_original_order(order) and (symbol is None or order["symbol"] == symbol) for order in orders) and len({order["newClientOrderId"] for order in orders}) == len(orders)


def _nonfunding_action(payload):
    if _exact_keys(payload, ("order",)) and _original_order(payload["order"]):
        return "order"
    if _exact_keys(payload, ("orders",)) and isinstance(payload["orders"], list) and 0 < len(payload["orders"]) <= 100 and all(_original_order(order) for order in payload["orders"]):
        return "order"
    if _exact_keys(payload, ("symbol", "target")) and _valid_symbol(payload["symbol"]) and _valid_leverage(payload["target"]):
        return "leverage"
    if _exact_keys(payload, ("id", "kind", "symbol", "orders", "target")) and _legacy_id(payload["id"]) and _valid_symbol(payload["symbol"]):
        if payload["kind"] in ("pair", "cycle") and payload["target"] is None and _matching_orders(payload["orders"], payload["symbol"]):
            return "order"
        if payload["kind"] == "migration" and payload["target"] is None and _matching_orders(payload["orders"]):
            return "order"
        if payload["kind"] in ("leverage", "cycle_leverage") and payload["orders"] is None and _valid_leverage(payload["target"]):
            return "leverage"
    if _exact_keys(payload, ("id", "request_id", "kind", "symbol", "target_leverage", "amount", "source", "destination", "orders")) and _legacy_id(payload["id"]) and (payload["request_id"] is None or _legacy_id(payload["request_id"])) and _valid_symbol(payload["symbol"]) and payload["amount"] is None and payload["source"] is None and payload["destination"] is None:
        if payload["kind"] in ("ordinary", "cycle") and payload["target_leverage"] is None and _matching_orders(payload["orders"], payload["symbol"]):
            return "order"
        if payload["kind"] == "leverage" and isinstance(payload["orders"], list) and not payload["orders"] and _valid_leverage(payload["target_leverage"]):
            return "leverage"
    if not _exact_keys(payload, ("method", "path", "params")):
        return None
    method, endpoint, params = payload["method"], payload["path"], payload["params"]
    if method == "POST" and endpoint == "/fapi/v3/order" and _original_order(params):
        return "order"
    if method == "POST" and endpoint == "/fapi/v3/batchOrders" and _exact_keys(params, ("batchOrders",)):
        try:
            orders = json.loads(params["batchOrders"]) if isinstance(params["batchOrders"], str) else params["batchOrders"]
        except (TypeError, ValueError):
            return None
        if isinstance(orders, list) and 0 < len(orders) <= 100 and all(_original_order(order) for order in orders):
            return "order"
    if method == "POST" and endpoint == "/fapi/v3/leverage" and _exact_keys(params, ("symbol", "leverage")) and isinstance(params["symbol"], str) and re.fullmatch(r"[A-Z0-9_]{1,64}", params["symbol"]) and type(params["leverage"]) in (str, int, float):
        leverage = params["leverage"]
        if isinstance(leverage, str) and re.fullmatch(r"(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-5])", leverage) or type(leverage) in (int, float) and math.isfinite(leverage) and leverage == int(leverage) and 1 <= leverage <= 125:
            return "leverage"
    return None


def _intent_metadata(module_id, keys, payload):
    if isinstance(payload, dict) and "marginTransfer" in payload:
        return _margin_metadata(module_id, keys, payload)
    action = payload.get("intentAction") if isinstance(payload, dict) else None
    target = payload.get("intentTarget") if isinstance(payload, dict) else None
    if action is None and target is None:
        inferred = _nonfunding_action(payload)
        return {"action": inferred, "targetHash": _payload_hash(keys, payload) if inferred else None}
    if action not in ("amend", "cancel") or not isinstance(target, dict) or set(target) - {"accountKey", "symbol", "clientOrderId", "remoteId"} or not (target.get("clientOrderId") or target.get("remoteId")):
        _fail("INVALID_INTENT_TARGET")
    target_key = target.get("accountKey", keys[0] if len(keys) == 1 else None)
    if not target_key or target_key not in keys:
        _fail("INVALID_INTENT_TARGET")
    _identifier(target.get("symbol"), "INVALID_INTENT_TARGET")
    for key in ("clientOrderId", "remoteId"):
        if key in target:
            _identifier(target[key], "INVALID_INTENT_TARGET")
    semantic_target = {key: value for key, value in target.items() if key != "accountKey"}
    if module_id == "aster" and (set(payload) - {"intentAction", "intentTarget", "price", "quantity", "groupId"} or any(key in payload and not _positive_decimal(payload[key]) for key in ("price", "quantity"))):
        _fail("INVALID_INTENT_TARGET")
    return {"action": action, "targetHash": _payload_hash([target_key], semantic_target)}


def _reduces_amend_risk(operation, pending):
    return operation["intent_action"] == "cancel" and bool(operation["intent_target_hash"]) and pending["module_id"] == operation["module_id"] and pending["intent_action"] == "amend" and pending["intent_target_hash"] == operation["intent_target_hash"]


def _safe_database_path(value):
    value = os.fspath(value)
    if not isinstance(value, str) or not os.path.isabs(value) or value.startswith(("\\\\", "//", "\\??\\")) or "\0" in value:
        _fail("UNSAFE_DATABASE_PATH")
    if os.name == "nt" and ":" in value[2:]:
        _fail("UNSAFE_DATABASE_PATH")
    database = Path(os.path.abspath(value))
    marker = Path(str(database) + ".required")
    if (marker.exists() or marker.is_symlink()) and not database.exists():
        _fail("REGISTRY_MISSING")

    def check_components():
        for target in (*reversed(database.parents), database):
            if target.is_symlink():
                _fail("UNSAFE_DATABASE_PATH")
            if os.name == "nt" and target.exists() and getattr(target.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                _fail("UNSAFE_DATABASE_PATH")

    check_components()
    database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_components()
    if str(database.parent.resolve()).startswith(("\\\\", "//")):
        _fail("UNSAFE_DATABASE_PATH")
    if os.name != "nt":
        for ancestor in (database.parent, *database.parent.parents):
            info = ancestor.stat()
            trusted_owner = info.st_uid in (0, os.getuid())
            foreign_can_rename = info.st_mode & 0o003 == 0o003 or info.st_mode & 0o030 == 0o030
            if not trusted_owner or (foreign_can_rename and not info.st_mode & 0o1000):
                _fail("UNSAFE_DATABASE_PATH")
        parent_stat = database.parent.stat()
        if parent_stat.st_mode & 0o022 or parent_stat.st_uid != os.getuid():
            _fail("UNSAFE_DATABASE_PATH")
    try:
        descriptor = os.open(database, os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.close(descriptor)
    except FileExistsError:
        pass
    for target in (database, Path(str(database) + "-wal"), Path(str(database) + "-shm")):
        if not target.exists() and not target.is_symlink():
            continue
        metadata = target.lstat()
        if not stat.S_ISREG(metadata.st_mode) or target.is_symlink() or metadata.st_nlink != 1 or (os.name != "nt" and metadata.st_uid != os.getuid()):
            _fail("UNSAFE_DATABASE_PATH")
        target.chmod(0o600)
    marker_path = Path(str(database) + ".required")
    if marker_path.exists() or marker_path.is_symlink():
        try:
            evidence = _read_required(marker_path)["evidence"]
            current = _file_identity(database)
            if evidence.get("schema") != 1 or evidence.get("dev") != current["dev"] or evidence.get("ino") != current["ino"] or not isinstance(evidence.get("registryId"), str):
                _fail("REGISTRY_REPLACED")
        except AccountWriterError:
            raise
        except Exception:
            _fail("REGISTRY_REPLACED")
    return str(database)


def _registry_marker_admission(database, database_path):
    required = Path(database_path + ".required")
    deadline = time.monotonic() + 0.75

    def reject_missing():
        if required.exists() or required.is_symlink():
            return False
        _fail("REGISTRY_MISSING")

    tables = [row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    while True:
        if required.exists() or required.is_symlink():
            return False
        meta = dict(database.execute("SELECT key,value FROM aw_meta WHERE key IN ('registry_id','recovery_schema','recovery_state')")) if "aw_meta" in tables else {}
        if any(key != "registry_id" for key in meta):
            # A concurrent cold publisher can finish between the path and meta reads.
            return reject_missing()
        registry_id = meta.get("registry_id")
        if registry_id is None:
            known = ("aw_meta", "aw_owners", "aw_bindings", "aw_accounts", "aw_operations", "aw_operation_accounts", "aw_isolations")
            if any(name not in known for name in tables):
                return reject_missing()
            for name in tables:
                query = "SELECT 1 FROM aw_meta WHERE key<>'schema' LIMIT 1" if name == "aw_meta" else f"SELECT 1 FROM {name} LIMIT 1"
                if database.execute(query).fetchone() is not None:
                    return reject_missing()
            return True
        if not isinstance(registry_id, str) or not UUID_PATTERN.fullmatch(registry_id):
            _fail("REGISTRY_REPLACED")
        expected = {"schema": 1, "registryId": registry_id, **_file_identity(database_path)}
        prefix = required.name + ".tmp-"
        for name in os.listdir(required.parent):
            if not name.startswith(prefix):
                continue
            match = re.fullmatch(r"([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", name[len(prefix):])
            if match is None or not _default_alive(int(match[1])):
                continue
            target = required.parent / name
            try:
                info = target.lstat()
                if not stat.S_ISREG(info.st_mode) or target.is_symlink() or info.st_nlink != 1 or info.st_size > 1024 or (os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077)):
                    continue
                evidence = json.loads(target.read_text(encoding="utf-8"))
                if isinstance(evidence, dict) and type(evidence.get("schema")) is int and evidence == expected:
                    return True
            except (OSError, ValueError):
                continue
        if time.monotonic() >= deadline:
            return reject_missing()
        time.sleep(0.01)


def _file_identity(target):
    value = Path(target)
    info = value.lstat()
    if not stat.S_ISREG(info.st_mode) or value.is_symlink() or info.st_nlink != 1:
        _fail("REGISTRY_REPLACED")
    return {"dev": str(info.st_dev), "ino": str(info.st_ino)}


def _read_required(target):
    deadline = time.monotonic() + 0.75
    while True:
        value = Path(target)
        info = value.lstat()
        if not stat.S_ISREG(info.st_mode) or value.is_symlink():
            _fail("REGISTRY_REPLACED")
        try:
            with value.open(encoding="utf-8") as stream:
                evidence = json.load(stream)
        except Exception:
            _fail("REGISTRY_REPLACED")
        if not isinstance(evidence, dict) or len(evidence) != 4 or evidence.get("schema") != 1 or not isinstance(evidence.get("registryId"), str) or not re.fullmatch(r"[0-9a-f-]{36}", evidence["registryId"]):
            _fail("REGISTRY_REPLACED")
        if info.st_nlink == 2:
            prefix = value.name + ".tmp-"
            candidates = []
            for name in os.listdir(value.parent):
                if not name.startswith(prefix):
                    continue
                match = re.fullmatch(r"([1-9][0-9]*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", name[len(prefix):])
                if match is None or _default_alive(int(match[1])):
                    continue
                candidate = value.parent / name
                try:
                    entry = candidate.lstat()
                except FileNotFoundError:
                    continue
                if stat.S_ISREG(entry.st_mode) and not candidate.is_symlink() and entry.st_nlink == 2 and entry.st_dev == info.st_dev and entry.st_ino == info.st_ino and (os.name == "nt" or entry.st_uid == os.getuid()):
                    candidates.append(candidate)
            if len(candidates) == 1:
                database_path = str(value)[:-len(".required")]
                database_identity = _file_identity(database_path)
                if not str(value).endswith(".required") or evidence.get("dev") != database_identity["dev"] or evidence.get("ino") != database_identity["ino"]:
                    _fail("REGISTRY_REPLACED")
                database = sqlite3.connect(Path(database_path).as_uri() + "?mode=ro", uri=True, timeout=0.75, isolation_level=None)
                try:
                    row = database.execute("SELECT value FROM aw_meta WHERE key='registry_id'").fetchone()
                    if row is None or row[0] != evidence["registryId"]:
                        _fail("REGISTRY_REPLACED")
                finally:
                    database.close()
                try:
                    candidate = candidates[0].lstat()
                except FileNotFoundError:
                    continue
                required = value.lstat()
                if required.st_nlink == 1:
                    continue
                if not stat.S_ISREG(candidate.st_mode) or candidates[0].is_symlink() or candidate.st_dev != info.st_dev or candidate.st_ino != info.st_ino or candidate.st_nlink != 2 or required.st_dev != info.st_dev or required.st_ino != info.st_ino or required.st_nlink != 2:
                    _fail("REGISTRY_REPLACED")
                try:
                    candidates[0].unlink()
                except FileNotFoundError:
                    pass
                if os.name != "nt":
                    directory = os.open(str(value.parent), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                    try:
                        os.fsync(directory)
                    finally:
                        os.close(directory)
                continue
            if time.monotonic() >= deadline:
                _fail("REGISTRY_BUSY")
            time.sleep(0.01)
            continue
        if info.st_nlink != 1:
            _fail("REGISTRY_REPLACED")
        return {"identity": {"dev": str(info.st_dev), "ino": str(info.st_ino)}, "evidence": evidence}


SCHEMA = """
CREATE TABLE IF NOT EXISTS aw_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO aw_meta VALUES ('schema','1');
CREATE TABLE IF NOT EXISTS aw_owners (owner_id TEXT PRIMARY KEY, module_id TEXT NOT NULL, runtime_id TEXT NOT NULL, pid INTEGER NOT NULL, status TEXT NOT NULL, last_now INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aw_bindings (module_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority TEXT NOT NULL, environment TEXT NOT NULL, account_key TEXT, revision TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL, evidence_hash TEXT, PRIMARY KEY(module_id,connection_id));
CREATE TABLE IF NOT EXISTS aw_accounts (account_key TEXT PRIMARY KEY, authority TEXT NOT NULL, environment TEXT NOT NULL, module_id TEXT NOT NULL, owner_id TEXT NOT NULL, fence INTEGER NOT NULL, lease_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS aw_operations (operation_id TEXT PRIMARY KEY, module_id TEXT NOT NULL, body_hash TEXT NOT NULL, account_keys TEXT NOT NULL, owner_id TEXT NOT NULL, ticket_json TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, group_id TEXT NOT NULL, intent_action TEXT, intent_target_hash TEXT);
CREATE TABLE IF NOT EXISTS aw_operation_accounts (operation_id TEXT NOT NULL, account_key TEXT NOT NULL, PRIMARY KEY(operation_id,account_key));
CREATE INDEX IF NOT EXISTS aw_operation_account_lookup ON aw_operation_accounts(account_key,operation_id);
CREATE TABLE IF NOT EXISTS aw_isolations (account_key TEXT PRIMARY KEY, authority TEXT NOT NULL, environment TEXT NOT NULL, reason TEXT NOT NULL, module_id TEXT NOT NULL, created_at INTEGER NOT NULL);
"""


def _default_alive(pid):
    if os.name == "nt":
        # os.kill(pid, 0) uses TerminateProcess on Windows Python; use a read-only handle.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87  # Access denied/unknown is conservatively alive.
        try:
            result = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(result)) or result.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _synchronized(method):
    @wraps(method)
    def synchronized(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return synchronized


class AccountWriter:
    recovery_protection_version = RECOVERY_SCHEMA_VERSION

    @property
    def recoveryProtectionVersion(self):
        return RECOVERY_SCHEMA_VERSION

    def __init__(self, database_path, module_id, runtime_id, owner_id=None, pid=None, now=None, process_alive=None):
        self.module_id = _identifier(module_id)
        self.runtime_id = _identifier(runtime_id)
        self.owner_id = _identifier(owner_id if owner_id is not None else str(uuid.uuid4()))
        self.pid = os.getpid() if pid is None else pid
        self.now = now if now is not None else lambda: time.time_ns() // 1_000_000
        self.process_alive = process_alive if process_alive is not None else _default_alive
        if isinstance(self.pid, bool) or not isinstance(self.pid, int) or self.pid <= 0 or not callable(self.now) or not callable(self.process_alive):
            _fail("INVALID_OPTIONS")
        self.retired = False
        self.closed = False
        self._last_now = None
        self._held = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._db = None
        try:
            self.database_path = _safe_database_path(database_path)
            if os.stat(self.database_path).st_size > 0:
                admission = sqlite3.connect(Path(self.database_path).as_uri() + "?mode=ro", uri=True, timeout=0.75, isolation_level=None)
                try:
                    admission.execute("PRAGMA busy_timeout=750")
                    _registry_marker_admission(admission, self.database_path)
                finally:
                    admission.close()
            self._db = sqlite3.connect(self.database_path, timeout=0.75, isolation_level=None, check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA busy_timeout=750")
            _registry_marker_admission(self._db, self.database_path)
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.executescript(SCHEMA)
            if self._db.execute("SELECT value FROM aw_meta WHERE key='schema'").fetchone()[0] != "1":
                _fail("UNSUPPORTED_SCHEMA")
            self._register_file()
            current = self._time()
            self._transaction(lambda: self._db.execute("INSERT INTO aw_owners VALUES (?,?,?,?,?,?)", (self.owner_id, self.module_id, self.runtime_id, self.pid, "active", current)), initialize_recovery=True)
        except Exception as error:
            if self._db is not None:
                self._db.close()
            if isinstance(error, AccountWriterError):
                raise
            if "UNIQUE constraint" in str(error):
                _fail("OWNER_ID_REUSED")
            self._error(error)

    @staticmethod
    def _error(error):
        if isinstance(error, AccountWriterError):
            raise error
        _fail("REGISTRY_BUSY" if re.search("busy|locked", str(error), re.I) else "REGISTRY_UNAVAILABLE")

    def _transaction(self, action, initialize_recovery=False, closing=False):
        with self._lock:
            started = False
            try:
                if hasattr(self, "_registry_identity"):
                    self._check_registry_file()
                self._db.execute("BEGIN IMMEDIATE")
                started = True
                if initialize_recovery:
                    if self._db.execute("SELECT 1 FROM aw_meta WHERE key='recovery_state'").fetchone() is None and self._db.execute("SELECT 1 FROM aw_meta WHERE key='recovery_schema'").fetchone() is not None:
                        _fail("INVALID_RECOVERY_STATE")
                    self._db.execute("INSERT OR IGNORE INTO aw_meta VALUES ('recovery_state',?)", (_json({"schemaVersion": 1, "authorityId": str(uuid.uuid4()), "state": "normal"}),))
                    self._db.execute("INSERT OR IGNORE INTO aw_meta VALUES ('recovery_schema','1')")
                if not closing:
                    self._recovery_gate(0)
                result = action()
                if hasattr(self, "_registry_identity"):
                    self._check_registry_file()
                self._db.execute("COMMIT")
                return result
            except Exception as error:
                if started:
                    try:
                        self._db.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                self._error(error)

    def _recovery_state(self):
        schema = self._db.execute("SELECT value FROM aw_meta WHERE key='recovery_schema'").fetchone()
        if schema is not None and schema[0] != "1":
            _fail("UNSUPPORTED_RECOVERY_SCHEMA")
        row = self._db.execute("SELECT value FROM aw_meta WHERE key='recovery_state'").fetchone()
        raw = row[0] if row is not None else None
        try:
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > 65536:
                _fail("INVALID_RECOVERY_STATE")
            value = json.loads(raw, parse_constant=lambda _: _fail("INVALID_RECOVERY_STATE"))
        except AccountWriterError:
            raise
        except Exception:
            _fail("INVALID_RECOVERY_STATE")
        version = value.get("schemaVersion") if isinstance(value, dict) else None
        if isinstance(version, bool) or not isinstance(version, (int, float)) or not math.isfinite(version) or version != int(version) or abs(version) > 9007199254740991:
            _fail("INVALID_RECOVERY_STATE")
        if value["schemaVersion"] != 1:
            _fail("UNSUPPORTED_RECOVERY_SCHEMA")
        if any(key not in ("schemaVersion", "state", "admittedTarget", *RECOVERY_IDS) for key in value) or value.get("state") not in ("normal", "quarantine", "retired") or not isinstance(value.get("authorityId"), str) or not UUID_PATTERN.fullmatch(value["authorityId"]):
            _fail("INVALID_RECOVERY_STATE")
        for key in RECOVERY_IDS:
            if key in value and (not isinstance(value[key], str) or not UUID_PATTERN.fullmatch(value[key])):
                _fail("INVALID_RECOVERY_STATE")
        if "admittedTarget" in value and not isinstance(value["admittedTarget"], dict):
            _fail("INVALID_RECOVERY_STATE")
        return value

    def _recovery_gate(self, budget_ms):
        value = self._recovery_state()
        if value["state"] == "retired":
            _fail("AUTHORITY_RETIRED")
        if value["state"] == "quarantine" and budget_ms > 0:
            _fail("RECOVERY_REQUIRED")
        return value

    def _register_file(self):
        may_publish = _registry_marker_admission(self._db, self.database_path)
        self._registry_identity = _file_identity(self.database_path)
        if may_publish:
            self._db.execute("INSERT OR IGNORE INTO aw_meta VALUES ('registry_id',?)", (str(uuid.uuid4()),))
        row = self._db.execute("SELECT value FROM aw_meta WHERE key='registry_id'").fetchone()
        self._registry_id = row[0] if row is not None else None
        if not isinstance(self._registry_id, str) or not UUID_PATTERN.fullmatch(self._registry_id):
            _fail("REGISTRY_REPLACED")
        self._required_path = self.database_path + ".required"
        if not may_publish:
            self._marker_identity = _read_required(self._required_path)["identity"]
            if os.name != "nt" and os.stat(self._required_path).st_uid != os.getuid():
                _fail("UNSAFE_DATABASE_PATH")
            os.chmod(self._required_path, 0o600)
            self._check_registry_file()
            return
        content = _json({"schema": 1, "registryId": self._registry_id, **self._registry_identity})
        temporary = f"{self._required_path}.tmp-{os.getpid()}-{uuid.uuid4()}"
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            try:
                os.link(temporary, self._required_path)
            except FileExistsError:
                pass
            os.unlink(temporary)
            if os.name != "nt":
                parent_descriptor = os.open(str(Path(self._required_path).parent), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(parent_descriptor)
                finally:
                    os.close(parent_descriptor)
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        self._marker_identity = _read_required(self._required_path)["identity"]
        if os.name != "nt" and os.stat(self._required_path).st_uid != os.getuid():
            _fail("UNSAFE_DATABASE_PATH")
        os.chmod(self._required_path, 0o600)
        self._check_registry_file()

    def _check_registry_file(self):
        try:
            current = _file_identity(self.database_path)
            required = _read_required(self._required_path)
            marker, evidence = required["identity"], required["evidence"]
            if current != self._registry_identity or marker != self._marker_identity or evidence != {"schema": 1, "registryId": self._registry_id, **current}:
                _fail("REGISTRY_REPLACED")
        except Exception as error:
            self.retired = True
            if isinstance(error, FileNotFoundError):
                _fail("REGISTRY_MISSING")
            if isinstance(error, AccountWriterError):
                raise
            _fail("REGISTRY_REPLACED")

    def _time(self):
        if self.closed:
            _fail("WRITER_CLOSED")
        if self.retired:
            _fail("WRITER_RETIRED")
        current = self.now()
        if isinstance(current, bool) or not isinstance(current, (int, float)) or not math.isfinite(current) or current != int(current) or not 0 <= current <= 9007199254740991:
            self.retired = True
            _fail("INVALID_CLOCK")
        current = int(current)
        if self._last_now is not None and current < self._last_now:
            self.retired = True
            _fail("CLOCK_ROLLBACK")
        self._last_now = current
        return current

    def _owner(self, current):
        owner = self._db.execute("SELECT * FROM aw_owners WHERE owner_id=?", (self.owner_id,)).fetchone()
        if owner is None or owner["status"] != "active" or owner["module_id"] != self.module_id or owner["runtime_id"] != self.runtime_id or owner["pid"] != self.pid:
            self.retired = True
            _fail("OWNERSHIP_LOST")
        if current < owner["last_now"]:
            self.retired = True
            _fail("CLOCK_ROLLBACK")
        self._db.execute("UPDATE aw_owners SET last_now=? WHERE owner_id=?", (current, self.owner_id))

    @_synchronized
    def bind(self, connection_id, identity, revision, scope=None):
        _identifier(connection_id)
        if isinstance(revision, bool) or not isinstance(revision, (str, int)) or (isinstance(revision, int) and abs(revision) > 9007199254740991):
            _fail("INVALID_REVISION")
        revision_value = _json(revision)
        if len(revision_value) > 512:
            _fail("INVALID_REVISION")
        normalized = None if identity is None else normalize_account_identity(identity)
        normalized_scope = _scope(scope) if normalized is None else {"authority": normalized["authority"], "environment": normalized["environment"]}
        if scope is not None and _scope(scope) != normalized_scope:
            _fail("INVALID_SCOPE")
        key = account_key(normalized) if normalized is not None else None
        evidence_hash = hashlib.sha256(_json(normalized).encode()).hexdigest() if normalized is not None else None
        current = self._time()

        def action():
            self._owner(current)
            old = self._db.execute("SELECT * FROM aw_bindings WHERE module_id=? AND connection_id=?", (self.module_id, connection_id)).fetchone()
            changed = old is None or not old["active"] or old["authority"] != normalized_scope["authority"] or old["environment"] != normalized_scope["environment"] or old["account_key"] != key or old["revision"] != revision_value or old["evidence_hash"] != evidence_hash
            generation = old["generation"] + int(changed) if old is not None else 1
            self._db.execute("INSERT INTO aw_bindings VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(module_id,connection_id) DO UPDATE SET authority=excluded.authority,environment=excluded.environment,account_key=excluded.account_key,revision=excluded.revision,generation=excluded.generation,active=1,evidence_hash=excluded.evidence_hash", (self.module_id, connection_id, normalized_scope["authority"], normalized_scope["environment"], key, revision_value, generation, evidence_hash))
            if changed and old is not None and old["account_key"]:
                self._held.pop(old["account_key"], None)
            return {"connectionId": connection_id, "generation": generation, "accountKey": key, "verified": key is not None}

        return self._transaction(action)

    @_synchronized
    def claim(self, identities):
        if not isinstance(identities, list) or not 1 <= len(identities) <= 100:
            _fail("INVALID_ACCOUNT_SET")
        normalized = [normalize_account_identity(identity) for identity in identities]
        accounts = {account_key(identity): identity for identity in normalized}
        if len(accounts) != len(normalized):
            _fail("DUPLICATE_ACCOUNT")
        current = self._time()

        def action():
            self._owner(current)
            claims, bindings = [], []
            for key in sorted(accounts):
                identity = accounts[key]
                if self._db.execute("SELECT 1 FROM aw_isolations WHERE account_key=?", (key,)).fetchone():
                    _fail("ACCOUNT_ISOLATED")
                if self._db.execute("SELECT 1 FROM aw_bindings WHERE active=1 AND module_id<>? AND authority=? AND environment=? AND account_key IS NULL LIMIT 1", (self.module_id, identity["authority"], identity["environment"])).fetchone():
                    _fail("UNVERIFIED_BINDING")
                verified = self._db.execute("SELECT connection_id,generation FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=? ORDER BY connection_id", (self.module_id, key)).fetchall()
                if not verified:
                    _fail("BINDING_REQUIRED")
                bindings.extend({"connectionId": row["connection_id"], "generation": row["generation"], "accountKey": key} for row in verified)
                old = self._db.execute("SELECT * FROM aw_accounts WHERE account_key=?", (key,)).fetchone()
                if old is not None and old["module_id"] != self.module_id:
                    _fail("ACCOUNT_PINNED")
                fence = old["fence"] if old is not None else 1
                if old is not None and old["owner_id"] == self.owner_id:
                    if old["lease_until"] <= current:
                        self.retired = True
                        _fail("LEASE_EXPIRED")
                elif old is not None:
                    owner = self._db.execute("SELECT * FROM aw_owners WHERE owner_id=?", (old["owner_id"],)).fetchone()
                    if owner is None or (owner["status"] != "closed" and self.process_alive(owner["pid"])):
                        _fail("OWNER_ALIVE")
                    fence += 1
                self._db.execute("INSERT INTO aw_accounts VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,lease_until=excluded.lease_until", (key, identity["authority"], identity["environment"], self.module_id, self.owner_id, fence, current + TTL_MS))
                claims.append({"accountKey": key, "fence": fence})
            return {"ownerId": self.owner_id, "moduleId": self.module_id, "runtimeId": self.runtime_id, "claims": claims, "bindings": bindings}

        with self._lock:
            ticket = self._transaction(action)
            for claim in ticket["claims"]:
                self._held[claim["accountKey"]] = {"claim": dict(claim), "bindings": [dict(binding) for binding in ticket["bindings"] if binding["accountKey"] == claim["accountKey"]]}
            self._heartbeat_start()
            return ticket

    def _validate(self, ticket, current, budget_ms, renew_always=False):
        if not isinstance(ticket, dict) or ticket.get("ownerId") != self.owner_id or ticket.get("moduleId") != self.module_id or ticket.get("runtimeId") != self.runtime_id or not isinstance(ticket.get("claims"), list) or not ticket["claims"] or not isinstance(ticket.get("bindings"), list):
            _fail("INVALID_TICKET")
        if isinstance(budget_ms, bool) or not isinstance(budget_ms, int) or not 0 <= budget_ms <= TTL_MS - SAFETY_MS:
            _fail("INVALID_BUDGET")
        self._recovery_gate(budget_ms)
        self._owner(current)
        keys = set()
        for claim in ticket["claims"]:
            if not isinstance(claim, dict) or not isinstance(claim.get("accountKey"), str) or not re.fullmatch(r"[a-f0-9]{64}", claim["accountKey"]) or isinstance(claim.get("fence"), bool) or not isinstance(claim.get("fence"), int) or claim["fence"] < 1 or claim["accountKey"] in keys:
                _fail("INVALID_TICKET")
            keys.add(claim["accountKey"])
            if self._db.execute("SELECT 1 FROM aw_isolations WHERE account_key=?", (claim["accountKey"],)).fetchone():
                _fail("ACCOUNT_ISOLATED")
            row = self._db.execute("SELECT * FROM aw_accounts WHERE account_key=?", (claim["accountKey"],)).fetchone()
            if row is None or row["owner_id"] != self.owner_id or row["module_id"] != self.module_id or row["fence"] != claim["fence"]:
                self.retired = True
                _fail("OWNERSHIP_LOST")
            if row["lease_until"] <= current:
                self.retired = True
                _fail("LEASE_EXPIRED")
            relevant = [binding for binding in ticket["bindings"] if isinstance(binding, dict) and binding.get("accountKey") == claim["accountKey"]]
            bindings = self._db.execute("SELECT connection_id,generation FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=? ORDER BY connection_id", (self.module_id, claim["accountKey"])).fetchall()
            if not relevant or len(bindings) != len(relevant) or any(not any(old.get("connectionId") == binding["connection_id"] and old.get("generation") == binding["generation"] for old in relevant) for binding in bindings):
                _fail("BINDING_CHANGED")
            if self._db.execute("SELECT 1 FROM aw_bindings WHERE active=1 AND module_id<>? AND authority=? AND environment=? AND account_key IS NULL LIMIT 1", (self.module_id, row["authority"], row["environment"])).fetchone():
                _fail("UNVERIFIED_BINDING")
            if renew_always or row["lease_until"] - current < budget_ms + SAFETY_MS:
                self._db.execute("UPDATE aw_accounts SET lease_until=? WHERE account_key=? AND owner_id=? AND fence=?", (current + TTL_MS, claim["accountKey"], self.owner_id, claim["fence"]))
        if any(not isinstance(binding, dict) or binding.get("accountKey") not in keys for binding in ticket["bindings"]):
            _fail("INVALID_TICKET")
        return True

    def assert_owned(self, ticket, budget_ms=35000):
        with self._lock:
            current = self._time()
            def action():
                self._validate(ticket, current, budget_ms)
                if budget_ms > 0 and "operationId" in ticket:
                    self._validate_sending(ticket)
                return True
            return self._transaction(action)

    def _validate_sending(self, ticket):
        _identifier(ticket["operationId"], "INVALID_OPERATION_ID")
        operation = self._db.execute("SELECT * FROM aw_operations WHERE operation_id=?", (ticket["operationId"],)).fetchone()
        if operation is None:
            _fail("OPERATION_NOT_FOUND")
        base = {key: ticket[key] for key in ("ownerId", "moduleId", "runtimeId", "claims", "bindings")}
        if operation["owner_id"] != self.owner_id or operation["module_id"] != self.module_id or operation["body_hash"] != ticket.get("bodyHash") or json.loads(operation["ticket_json"]) != base:
            _fail("OPERATION_CONFLICT")
        if operation["state"] != "sending":
            _fail("ALREADY_SUBMITTED" if operation["state"] == "confirmed" else "ALREADY_REJECTED" if operation["state"] == "rejected" else "OPERATION_UNRESOLVED")
        for claim in ticket["claims"]:
            pending = self._db.execute("SELECT o.* FROM aw_operation_accounts a JOIN aw_operations o ON o.operation_id=a.operation_id WHERE a.account_key=? AND o.operation_id<>? AND o.state IN ('sending','unknown')", (claim["accountKey"], ticket["operationId"])).fetchall()
            if any((not _reduces_amend_risk(operation, row) and not self._margin_compatible(operation, row)) if row["state"] == "unknown" else (operation["intent_action"] == "margin-transfer" and not self._margin_compatible(operation, row)) for row in pending):
                _fail("ACCOUNT_UNRESOLVED")

    def _margin_compatible(self, operation, pending):
        if operation["module_id"] != "aster" or operation["intent_action"] != "margin-transfer" or not operation["intent_target_hash"] or pending["module_id"] != "aster" or pending["intent_action"] not in ("order", "leverage", "amend", "cancel") or not pending["intent_target_hash"]:
            return False
        if pending["state"] == "unknown":
            return True
        if pending["state"] != "sending":
            return False
        # A fenced ticket may have passed its final guard already; its sender must also be dead.
        try:
            ticket = json.loads(pending["ticket_json"])
            keys = json.loads(pending["account_keys"])
        except (ValueError, TypeError):
            return False
        if not isinstance(ticket, dict) or ticket.get("ownerId") != pending["owner_id"] or ticket.get("moduleId") != pending["module_id"] or not isinstance(ticket.get("claims"), list) or not ticket["claims"] or not isinstance(keys, list) or len(keys) != len(ticket["claims"]) or any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys) or not isinstance(ticket.get("bindings"), list) or not ticket["bindings"]:
            return False
        if any(not isinstance(claim, dict) or not isinstance(claim.get("accountKey"), str) for claim in ticket["claims"]) or len({claim["accountKey"] for claim in ticket["claims"]}) != len(keys):
            return False
        for binding in ticket["bindings"]:
            if not _exact_keys(binding, ("connectionId", "generation", "accountKey")) or not isinstance(binding["connectionId"], str) or not binding["connectionId"] or len(binding["connectionId"]) > 256 or re.search(r"[\x00-\x1f\x7f]", binding["connectionId"]) or binding["accountKey"] not in keys or type(binding["generation"]) is not int or binding["generation"] < 1:
                return False
        if len({binding["connectionId"] for binding in ticket["bindings"]}) != len(ticket["bindings"]):
            return False
        fenced = True
        for claim in ticket["claims"]:
            if not isinstance(claim, dict) or claim.get("accountKey") not in keys or type(claim.get("fence")) is not int or claim["fence"] < 1:
                return False
            current = self._db.execute("SELECT owner_id,fence,module_id FROM aw_accounts WHERE account_key=?", (claim["accountKey"],)).fetchone()
            if current is None or current["module_id"] != "aster" or not any(binding["accountKey"] == claim["accountKey"] for binding in ticket["bindings"]):
                return False
            fenced = fenced and (current["owner_id"] != pending["owner_id"] or current["fence"] != claim["fence"])
        if not fenced:
            return False
        owner = self._db.execute("SELECT * FROM aw_owners WHERE owner_id=?", (pending["owner_id"],)).fetchone()
        if owner is None or owner["module_id"] != "aster" or owner["runtime_id"] != ticket.get("runtimeId") or type(owner["pid"]) is not int or owner["pid"] <= 0 or owner["status"] not in ("active", "closed"):
            return False
        try:
            return self.process_alive(owner["pid"]) is False
        except Exception:
            return False

    def _heartbeat_start(self):
        if self._thread is not None:
            return

        def heartbeat():
            while not self._stop.wait(HEARTBEAT_MS / 1000):
                with self._lock:
                    if not self._held:
                        continue
                    try:
                        current = self._time()
                        def action():
                            for key, value in list(self._held.items()):
                                ticket = {"ownerId": self.owner_id, "moduleId": self.module_id, "runtimeId": self.runtime_id, "claims": [value["claim"]], "bindings": value["bindings"]}
                                try:
                                    self._validate(ticket, current, 0, True)
                                except AccountWriterError as error:
                                    if error.code in ("ACCOUNT_ISOLATED", "BINDING_CHANGED", "UNVERIFIED_BINDING"):
                                        self._held.pop(key, None)
                                    else:
                                        raise
                        self._transaction(action)
                    except AccountWriterError as error:
                        # A briefly locked registry is retried next beat; an expired lease still retires via _validate.
                        if error.code == "REGISTRY_BUSY" and not self.retired:
                            continue
                        self.retired = True
                        self._stop.set()

        self._thread = threading.Thread(target=heartbeat, name="account-writer-heartbeat", daemon=True)
        self._thread.start()

    @staticmethod
    def _operation_ticket(ticket, operation_id, body_hash, state):
        return {**json.loads(_json(ticket)), "operationId": operation_id, "bodyHash": body_hash, "state": state}

    @_synchronized
    def _record(self, ticket, operation_id, payload, importing):
        _identifier(operation_id, "INVALID_OPERATION_ID")
        if not isinstance(ticket, dict) or not isinstance(ticket.get("claims"), list) or not ticket["claims"]:
            _fail("INVALID_TICKET")
        keys = sorted(claim.get("accountKey", "") for claim in ticket["claims"])
        body_hash = _payload_hash(keys, payload)
        group_id = _identifier(payload["groupId"], "INVALID_GROUP_ID") if isinstance(payload, dict) and payload.get("groupId") is not None else operation_id
        intent = _intent_metadata(self.module_id, keys, payload)
        current = self._time()

        def action():
            self._validate(ticket, current, 0 if importing else 35000)
            old = self._db.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if old is not None:
                if old["module_id"] != self.module_id or old["body_hash"] != body_hash or old["account_keys"] != _json(keys):
                    _fail("OPERATION_CONFLICT")
                if importing:
                    if old["intent_action"] is None and old["intent_target_hash"] is None:
                        if intent["action"] is not None:
                            self._db.execute("UPDATE aw_operations SET intent_action=?,intent_target_hash=? WHERE operation_id=?", (intent["action"], intent["targetHash"], operation_id))
                    elif old["intent_action"] != intent["action"] or old["intent_target_hash"] != intent["targetHash"]:
                        _fail("OPERATION_CONFLICT")
                    return self._operation_ticket(ticket, operation_id, body_hash, old["state"])
                _fail("ALREADY_SUBMITTED" if old["state"] == "confirmed" else "ALREADY_REJECTED" if old["state"] == "rejected" else "OPERATION_UNRESOLVED")
            if not importing:
                for key in keys:
                    pending = self._db.execute("SELECT o.* FROM aw_operation_accounts a JOIN aw_operations o ON o.operation_id=a.operation_id WHERE a.account_key=? AND o.state IN ('sending','unknown')", (key,)).fetchall()
                    proposed = {"module_id": self.module_id, "intent_action": intent["action"], "intent_target_hash": intent["targetHash"]}
                    if any(not _reduces_amend_risk(proposed, row) and not self._margin_compatible(proposed, row) and (intent["action"] == "margin-transfer" or row["state"] != "sending" or row["module_id"] != self.module_id or row["owner_id"] != self.owner_id or row["group_id"] != group_id or row["account_keys"] != _json(keys) or json.loads(row["ticket_json"]) != ticket) for row in pending):
                        _fail("ACCOUNT_UNRESOLVED")
            state = "unknown" if importing else "sending"
            self._db.execute("INSERT INTO aw_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (operation_id, self.module_id, body_hash, _json(keys), self.owner_id, _json(ticket), state, current, current, group_id, intent["action"], intent["targetHash"]))
            self._db.executemany("INSERT INTO aw_operation_accounts VALUES (?,?)", [(operation_id, key) for key in keys])
            return self._operation_ticket(ticket, operation_id, body_hash, state)

        return self._transaction(action)

    def prepare(self, ticket, operation_id, payload):
        return self._record(ticket, operation_id, payload, False)

    def import_unknown(self, ticket, operation_id, payload):
        return self._record(ticket, operation_id, payload, True)

    @_synchronized
    def finish(self, operation_ticket, outcome):
        if outcome not in ("confirmed", "rejected", "unknown"):
            _fail("INVALID_OUTCOME")
        current = self._time()

        def action():
            self._validate(operation_ticket, current, 0)
            operation = self._db.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_ticket.get("operationId"),)).fetchone()
            if operation is None:
                _fail("OPERATION_NOT_FOUND")
            base_ticket = {key: operation_ticket[key] for key in ("ownerId", "moduleId", "runtimeId", "claims", "bindings")}
            if operation["owner_id"] != self.owner_id or operation["module_id"] != self.module_id or operation["body_hash"] != operation_ticket.get("bodyHash") or json.loads(operation["ticket_json"]) != base_ticket:
                _fail("OPERATION_CONFLICT")
            if operation["state"] in ("confirmed", "rejected") and operation["state"] != outcome:
                _fail("OPERATION_FINAL")
            self._db.execute("UPDATE aw_operations SET state=?,updated_at=? WHERE operation_id=?", (outcome, current, operation_ticket["operationId"]))
            return {"operationId": operation_ticket["operationId"], "state": outcome}

        return self._transaction(action)

    @_synchronized
    def resolve(self, operation_id, ticket, outcome="confirmed"):
        _identifier(operation_id, "INVALID_OPERATION_ID")
        if outcome not in ("confirmed", "rejected"):
            _fail("INVALID_OUTCOME")
        current = self._time()

        def action():
            self._validate(ticket, current, 0)
            operation = self._db.execute("SELECT * FROM aw_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if operation is None:
                _fail("OPERATION_NOT_FOUND")
            keys = {claim["accountKey"] for claim in ticket["claims"]}
            if operation["module_id"] != self.module_id or not set(json.loads(operation["account_keys"])).issubset(keys):
                _fail("OPERATION_CONFLICT")
            if operation["state"] in ("confirmed", "rejected") and operation["state"] != outcome:
                _fail("OPERATION_FINAL")
            self._db.execute("UPDATE aw_operations SET state=?,updated_at=? WHERE operation_id=?", (outcome, current, operation_id))
            return {"operationId": operation_id, "state": outcome}

        return self._transaction(action)

    @_synchronized
    def unresolved(self, ticket):
        current = self._time()

        def action():
            self._validate(ticket, current, 0)
            keys = {claim["accountKey"] for claim in ticket["claims"]}
            rows = self._db.execute("SELECT operation_id,body_hash,account_keys,state,created_at FROM aw_operations WHERE module_id=? AND state IN ('sending','unknown') ORDER BY created_at,operation_id", (self.module_id,)).fetchall()
            return [{"operationId": row["operation_id"], "bodyHash": row["body_hash"], "state": row["state"], "createdAt": row["created_at"]} for row in rows if set(json.loads(row["account_keys"])).issubset(keys)]

        return self._transaction(action)

    @_synchronized
    def freeze(self, identities, reason="legacy-conflict"):
        if not isinstance(identities, list) or not 1 <= len(identities) <= 100 or reason not in ("legacy-conflict", "identity-conflict", "manual-isolation"):
            _fail("INVALID_ISOLATION")
        normalized = [normalize_account_identity(identity) for identity in identities]
        current = self._time()

        def action():
            self._owner(current)
            for identity in normalized:
                key = account_key(identity)
                if not self._db.execute("SELECT 1 FROM aw_bindings WHERE active=1 AND module_id=? AND account_key=?", (self.module_id, key)).fetchone():
                    _fail("BINDING_REQUIRED")
                self._db.execute("INSERT OR IGNORE INTO aw_isolations VALUES (?,?,?,?,?,?)", (key, identity["authority"], identity["environment"], reason, self.module_id, current))
            return {"isolated": len(normalized), "reason": reason}

        return self._transaction(action)

    @_synchronized
    def release_binding(self, connection_id):
        _identifier(connection_id)
        current = self._time()

        def action():
            self._owner(current)
            binding = self._db.execute("SELECT * FROM aw_bindings WHERE module_id=? AND connection_id=?", (self.module_id, connection_id)).fetchone()
            if binding is None or not binding["active"]:
                return False
            pending = self._db.execute("SELECT ticket_json FROM aw_operations WHERE module_id=? AND state IN ('sending','unknown')", (self.module_id,)).fetchall()
            if any(any(value["connectionId"] == connection_id for value in json.loads(row["ticket_json"])["bindings"]) for row in pending):
                _fail("BINDING_UNRESOLVED")
            self._db.execute("UPDATE aw_bindings SET active=0,generation=generation+1 WHERE module_id=? AND connection_id=?", (self.module_id, connection_id))
            if binding["account_key"]:
                self._held.pop(binding["account_key"], None)
            return True

        return self._transaction(action)

    def snapshot(self):
        with self._lock:
            if self.closed:
                _fail("WRITER_CLOSED")
            try:
                self._check_registry_file()
                recovery_state = self._recovery_state()
                recovery = {key: recovery_state[key] for key in ("schemaVersion", "state", *RECOVERY_IDS) if key in recovery_state}
                current = self.now()
                rows = self._db.execute("SELECT a.authority,a.environment,a.module_id,a.lease_until,o.status FROM aw_accounts a LEFT JOIN aw_owners o ON o.owner_id=a.owner_id ORDER BY a.authority,a.environment,a.module_id").fetchall()
                accounts = [{"authority": row["authority"], "environment": row["environment"], "moduleId": row["module_id"], "state": "closed" if row["status"] == "closed" else "expired" if row["lease_until"] <= current else "owned"} for row in rows]
                bindings = [{"authority": row["authority"], "environment": row["environment"], "moduleId": row["module_id"], "verified": bool(row["verified"]), "count": row["count"]} for row in self._db.execute("SELECT authority,environment,module_id,CASE WHEN account_key IS NULL THEN 0 ELSE 1 END AS verified,COUNT(*) AS count FROM aw_bindings WHERE active=1 GROUP BY authority,environment,module_id,verified")]
                operations = [{"moduleId": row["module_id"], "state": row["state"], "count": row["count"]} for row in self._db.execute("SELECT module_id,state,COUNT(*) AS count FROM aw_operations GROUP BY module_id,state")]
                isolations = [{"authority": row["authority"], "environment": row["environment"], "reason": row["reason"], "moduleId": row["module_id"]} for row in self._db.execute("SELECT authority,environment,reason,module_id FROM aw_isolations ORDER BY authority,environment,module_id")]
                return {"accounts": accounts, "bindings": bindings, "operations": operations, "isolations": isolations, "recovery": recovery}
            except Exception as error:
                self._error(error)

    def close(self):
        """Stop admission and drain in-flight transport in the adapter before calling this."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)
        with self._lock:
            if self.closed:
                return
            try:
                self._transaction(lambda: self._db.execute("UPDATE aw_owners SET status='closed' WHERE owner_id=?", (self.owner_id,)), closing=True)
            finally:
                self.closed = True
                self._db.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

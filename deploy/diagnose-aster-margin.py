#!/usr/bin/env python3
"""Read bounded, redacted Aster evidence without sending requests or settling writes.

Run as the database owner, for example:
sudo -u project-aggregation /usr/bin/python3 -I /opt/project-aggregation/current/deploy/diagnose-aster-margin.py /var/lib/project-aggregation

SQLite mode=ro reads the live WAL; it does not use immutable or change the gate.
SQLite may maintain its own shared-memory reader locks, so POSIX callers must
have the same real/effective UID as the database and existing WAL/SHM files.
"""
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time


SCHEMA = "aster-margin-diagnostics/v1"
OPERATION_LIMIT = 200
PAIR_LIMIT = 100
JOURNAL_LIMIT = 100
JSON_LIMIT = 262144
STATES = frozenset({"sending", "unknown", "confirmed", "rejected"})
TRANSFER_STATES = frozenset({"submitting", "unknown", "accepted", "acknowledged",
    "rejected", "confirmed", "skipped", "paper_confirmed"})
ADMISSION_CODES = frozenset({"ACCOUNT_UNRESOLVED", "OPERATION_UNRESOLVED", "ACCOUNT_ISOLATED",
    "ACCOUNT_PINNED", "OWNER_ALIVE", "OWNERSHIP_LOST", "LEASE_EXPIRED", "BINDING_CHANGED",
    "UNVERIFIED_BINDING", "RECOVERY_REQUIRED", "AUTHORITY_RETIRED", "ALREADY_SUBMITTED",
    "ALREADY_REJECTED", "WRITER_UNAVAILABLE", "REQUEST_NOT_SENT"})
TIMESTAMPS = ("created_at", "acknowledged_at", "confirmed_at", "refreshed_at",
    "skipped_at", "trading_baseline_at")


class DiagnosticError(Exception):
    """Only fixed, non-sensitive codes cross the CLI boundary."""


def _reject(code):
    raise DiagnosticError(code)


def _safe_text(value, pattern, limit):
    return value if isinstance(value, str) and len(value) <= limit and re.fullmatch(pattern, value) else None


def _identifier(value):
    return _safe_text(value, r"[A-Za-z0-9_.:-]+", 100)


def _operation_id(value):
    if not isinstance(value, str) or not value.startswith("aster:") or not re.fullmatch(r"[A-Za-z0-9_.:-]+", value):
        return None
    return value[:200]


def _timestamp(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 10**15 else None


def _json_object(raw):
    def invalid_number(_):
        _reject("INVALID_DATA")

    def integer(value):
        if len(value) > 32:
            _reject("INVALID_DATA")
        return int(value)

    def floating(value):
        number = float(value)
        if not math.isfinite(number):
            _reject("INVALID_DATA")
        return number

    if not isinstance(raw, str) or len(raw.encode("utf-8")) > JSON_LIMIT:
        _reject("INVALID_DATA")
    try:
        result = json.loads(raw, parse_constant=invalid_number, parse_int=integer, parse_float=floating)
    except (TypeError, ValueError, RecursionError):
        _reject("INVALID_DATA")
    if not isinstance(result, dict):
        _reject("INVALID_DATA")
    return result


def _lstat(path, *, directory=False, optional=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return None
        _reject("DATABASE_MISSING" if not directory else "UNSAFE_PATH")
    if (stat.S_ISLNK(info.st_mode)
            or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or (not directory and info.st_nlink != 1)):
        _reject("UNSAFE_PATH")
    if not directory and os.name == "posix" and (os.getuid() != info.st_uid or os.geteuid() != info.st_uid):
        _reject("OWNER_MISMATCH")
    return info


def _validate_root(raw):
    root = Path(raw)
    if not root.is_absolute() or ".." in root.parts:
        _reject("INVALID_ARGUMENT")
    for directory in reversed((root, *root.parents)):
        _lstat(directory, directory=True)
    return root


def _validate_database(path):
    for directory in reversed((path.parent, *path.parent.parents)):
        _lstat(directory, directory=True)
    info = _lstat(path)
    for suffix in ("-wal", "-shm", "-journal"):
        _lstat(Path(str(path) + suffix), optional=True)
    return info


@contextmanager
def _open_readonly(path):
    before = _validate_database(path)
    # URI quoting comes from as_uri(); user paths cannot inject SQLite options.
    database = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=1, isolation_level=None)
    try:
        database.execute("PRAGMA query_only=ON")
        database.execute("PRAGMA trusted_schema=OFF")
        allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_TRANSACTION}

        def authorize(action, first, second, _database, _trigger):
            return sqlite3.SQLITE_OK if action in allowed or (
                action == sqlite3.SQLITE_FUNCTION and second in {"substr", "length", "glob"}) else sqlite3.SQLITE_DENY

        database.set_authorizer(authorize)
        deadline = time.monotonic() + 5
        database.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        database.execute("BEGIN")
        after = _validate_database(path)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            _reject("UNSAFE_PATH")
        yield database
        after = _validate_database(path)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            _reject("UNSAFE_PATH")
    finally:
        database.close()


def _shared_record(row):
    operation, state, body_hash, created_at = row
    result = {"operationId": _operation_id(operation), "state": state if state in STATES else None,
        "createdAt": _timestamp(created_at)}
    if isinstance(operation, str) and len(operation) > 200:
        result["operationIdTruncated"] = True
    checked_hash = _safe_text(body_hash, r"[a-f0-9]{64}", 64)
    if checked_hash:
        result["bodyHash"] = checked_hash
    return result


def _matching_shared(database, pair_id, request_id):
    if pair_id is None or request_id is None:
        return []
    originals = ("aster:transfer:" + request_id, "aster:legacy:pair_margin:" + pair_id + ":" + request_id)
    rows = database.execute("SELECT substr(operation_id,1,201),state,substr(body_hash,1,65),created_at FROM aw_operations "
        "WHERE module_id='aster' AND operation_id IN (?,?) ORDER BY operation_id LIMIT 2", originals).fetchall()
    return [_shared_record(row) for row in rows]


def _transfer(record, pair_id, shared):
    if not isinstance(record, dict):
        return None
    request_id = _identifier(record.get("request_id"))
    result = {"requestId": request_id,
        "status": record.get("status") if record.get("status") in TRANSFER_STATES else None,
        "sharedOperations": _matching_shared(shared, pair_id, request_id)}
    amount = _safe_text(record.get("amount"), r"[0-9]+(?:\.[0-9]+)?", 100)
    if amount is not None:
        result["amount"] = amount
    for field in TIMESTAMPS:
        value = _timestamp(record.get(field))
        if value is not None:
            result[field] = value
    admission = record.get("write_admission")
    if isinstance(admission, dict):
        code = admission.get("code")
        result["writeAdmission"] = {"code": code if isinstance(code, str) and code in ADMISSION_CODES else None,
            "phase": "before_send" if admission.get("phase") == "before_send" else None}
    rejection = record.get("writer_rejection")
    result["writerRejection"] = {"present": isinstance(rejection, dict),
        "settled": rejection.get("settled") if isinstance(rejection, dict) and type(rejection.get("settled")) is bool else None}
    return result


def diagnose(raw_root):
    root = _validate_root(raw_root)
    shared_path = root / "execution-control.sqlite"
    private_path = root / "modules" / "aster" / "trading.sqlite3"
    # Validate both first: missing/unsafe paths cannot be created by SQLite.
    _validate_database(shared_path)
    _validate_database(private_path)
    with ExitStack() as stack:
        shared = stack.enter_context(_open_readonly(shared_path))
        private = stack.enter_context(_open_readonly(private_path))
        recovery_row = shared.execute("SELECT substr(value,1,?) FROM aw_meta WHERE key='recovery_state'", (JSON_LIMIT + 1,)).fetchone()
        recovery = _json_object(recovery_row[0]).get("state") if recovery_row else None
        recovery = recovery if recovery in {"normal", "quarantine", "retired"} else "unavailable"
        operations = shared.execute("SELECT substr(operation_id,1,201),state,substr(body_hash,1,65),created_at FROM aw_operations "
            "WHERE module_id='aster' AND state IN ('sending','unknown') ORDER BY created_at,operation_id LIMIT ?",
            (OPERATION_LIMIT + 1,)).fetchall()
        pair_rows = private.execute("SELECT substr(id,1,101),substr(data,1,?) FROM pairs ORDER BY id LIMIT ?",
            (JSON_LIMIT + 1, PAIR_LIMIT + 1)).fetchall()
        pairs = []
        for pair_id, raw in pair_rows[:PAIR_LIMIT]:
            pair = _json_object(raw)
            pairs.append({"id": _identifier(pair_id), "symbol": _safe_text(pair.get("symbol"), r"[A-Z0-9]+", 32),
                "enabled": pair.get("enabled") if type(pair.get("enabled")) is bool else None,
                "marginEnabled": pair.get("margin", {}).get("enabled") if isinstance(pair.get("margin"), dict)
                    and type(pair["margin"].get("enabled")) is bool else None})
        journal_rows = private.execute("SELECT substr(key,1,113),substr(data,1,?) FROM kv WHERE key GLOB 'pair_margin:*' ORDER BY key LIMIT ?",
            (JSON_LIMIT + 1, JOURNAL_LIMIT + 1)).fetchall()
        journals = []
        for key, raw in journal_rows[:JOURNAL_LIMIT]:
            journal = _json_object(raw)
            pair_id = _identifier(key[len("pair_margin:"):])
            journals.append({"pairId": pair_id, "pending": _transfer(journal.get("pending"), pair_id, shared),
                "lastTransfer": _transfer(journal.get("last_transfer"), pair_id, shared)})
    return {"schema": SCHEMA, "capturedAt": datetime.now(timezone.utc).isoformat(),
        "notice": "Read-only evidence; does not prove a request was not sent, settle an operation, or change the recovery gate. The two databases are separate snapshots.",
        "recoveryState": recovery,
        "sharedOperations": {"items": [_shared_record(row) for row in operations[:OPERATION_LIMIT]],
            "truncated": len(operations) > OPERATION_LIMIT},
        "pairs": {"items": pairs, "truncated": len(pair_rows) > PAIR_LIMIT},
        "marginJournals": {"items": journals, "truncated": len(journal_rows) > JOURNAL_LIMIT}}


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        if len(arguments) != 1:
            _reject("INVALID_ARGUMENT")
        result = diagnose(arguments[0])
        status = 0
    except DiagnosticError as exc:
        result, status = {"schema": SCHEMA, "error": str(exc)}, 1
    except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError, RecursionError):
        result, status = {"schema": SCHEMA, "error": "DATABASE_UNAVAILABLE"}, 1
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return status


if __name__ == "__main__":
    raise SystemExit(main())

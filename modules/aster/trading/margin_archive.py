"""Bounded local evidence view. Notes never change transfer or writer state."""
import json
import math
import re
import time
import uuid

from .models import TradingError

LIMIT = 50
BASES = {
    "late_receipt_confirmed": "两侧回执匹配（按金额/时间归属，仍须核对来源）",
    "nonce_expired_no_receipt": "已到结算时间；未取得匹配回执，不代表未到账",
    "nonce_expired_partial_receipt": "已到结算时间；仅有单侧回执",
    "nonce_expired_ambiguous_receipt": "已到结算时间；存在多条候选回执",
    "nonce_expired_unreadable": "流水读取失败，到账结果未知",
    "identity_changed": "账户身份已变化，到账结果未知",
    "nonce_expired_no_follow_up": "缺少后续证据，到账结果未知",
}


def _text(value, maximum):
    return value if isinstance(value, str) and len(value) <= maximum else None


def _stamp(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value > 0 else None


def _record(value):
    value = value if isinstance(value, dict) else {}
    result = {key: _text(value.get(key), 100) for key in ("request_id", "amount", "transaction_id")}
    result.update({key: value.get(key) if value.get(key) in ("long", "short") else None for key in ("source", "destination")})
    result.update({key: _stamp(value.get(key)) for key in ("created_at", "confirmed_at", "acknowledged_at", "refreshed_at", "skipped_at")})
    result["status"] = value.get("status") if value.get("status") in ("submitting", "unknown", "acknowledged", "confirmed", "rejected", "skipped") else "unknown"
    return result


def _matches(archive, pair):
    baseline = archive.get("baseline", {})
    return archive.get("pair_id") == pair["id"] and all(
        isinstance(baseline.get(side), dict) and baseline[side].get("account_id") == pair[side + "_account_id"]
        for side in ("long", "short"))


def archive_view(store, pair_id, *, before=""):
    if before and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", before):
        raise TradingError("归档游标无效")
    pair = store.pair(pair_id)
    if pair is None:
        raise TradingError("配对组不存在")
    prefix = "pair_margin_skipped:" + pair_id + ":"
    # Prefix range uses the kv primary-key index; fixed row and payload bounds.
    with store.connect() as db:
        rows = db.execute("SELECT key,CASE WHEN length(data)<=131072 THEN data ELSE NULL END AS data FROM kv WHERE key>=? AND key<? ORDER BY key DESC LIMIT ?",
            (prefix, prefix + before if before else prefix + "\uffff", LIMIT + 1)).fetchall()
    items, unavailable = [], 0
    for row in rows[:LIMIT]:
        if row["data"] is None:
            unavailable += 1
            continue
        archive = json.loads(row["data"])
        if not isinstance(archive, dict) or not _matches(archive, pair):
            unavailable += 1
            continue
        original = _record(archive.get("original"))
        request_id = row["key"][len(prefix):]
        if original["request_id"] != request_id:
            continue
        settlement = archive.get("settlement") if isinstance(archive.get("settlement"), dict) else {}
        evidence = settlement.get("evidence", archive.get("original", {}).get("evidence", []))
        receipts = []
        for item in evidence[:20] if isinstance(evidence, list) else []:
            if isinstance(item, (list, tuple)) and len(item) == 3 and item[0] in ("long", "short") and item[1] in ("TRANSFER", "SUBUSER_ASSET_TRANSFER") and _text(item[2], 100):
                receipts.append({"side": item[0], "kind": item[1], "transaction_id": item[2]})
        notes = store.get("pair_margin_review:" + pair_id + ":" + request_id, [])
        items.append({"request_id": request_id, "original": original, "result": _record(archive.get("result")),
            "basis": BASES.get(settlement.get("basis"), "归档未取得完整结算证据，到账结果未知"),
            "shared_outcome": settlement.get("outcome") if settlement.get("outcome") in ("confirmed", "rejected") else "unknown",
            "settled_at": _stamp(settlement.get("settled_at")), "receipts": receipts,
            "evidence_times": {side: _stamp(archive.get("baseline", {}).get(side, {}).get("timestamp")) for side in ("long", "short")},
            "notes": [{"id": note["id"], "at": _stamp(note.get("at")), "actor": "authenticated_admin", "note": note["note"], "source": note["source"]}
                for note in notes[-10:] if isinstance(note, dict) and _text(note.get("id"), 100) and _text(note.get("note"), 500) and _text(note.get("source"), 200)] if isinstance(notes, list) else []})
    return {"items": items, "unavailable": unavailable, "next": rows[LIMIT - 1]["key"][len(prefix):] if len(rows) > LIMIT else None,
        "notice": "共享 rejected 可能仅表示原请求过期、不再阻塞；不等同于交易所拒绝。缺证与读取失败均为未知。"}


def add_note(store, pair_id, request_id, *, note, source):
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", request_id):
        raise TradingError("原请求编号无效")
    if not isinstance(note, str) or not isinstance(source, str) or not 1 <= len(note.strip()) <= 500 or not 1 <= len(source.strip()) <= 200:
        raise TradingError("请填写核对说明（最多500字）及证据来源（最多200字），勿填写凭据")
    if re.search(r"(?:private.?key|secret|signature|authorization|password)\s*[:=]|/bot/v2/hook/", note + " " + source, re.I):
        raise TradingError("核对说明不可包含凭据或完整签名")
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        pair_row = db.execute("SELECT data FROM pairs WHERE id=?", (pair_id,)).fetchone()
        archive_row = db.execute("SELECT data FROM kv WHERE key=?", ("pair_margin_skipped:" + pair_id + ":" + request_id,)).fetchone()
        pair = json.loads(pair_row[0]) if pair_row else None
        archive = json.loads(archive_row[0]) if archive_row else None
        if not pair or not isinstance(archive, dict) or not _matches(archive, pair) or archive.get("original", {}).get("request_id") != request_id:
            raise TradingError("当前配对没有该归档请求")
        key = "pair_margin_review:" + pair_id + ":" + request_id
        row = db.execute("SELECT data FROM kv WHERE key=?", (key,)).fetchone()
        notes = json.loads(row[0]) if row else []
        notes = [*notes[-9:], {"id": uuid.uuid4().hex, "at": time.time(), "actor": "authenticated_admin", "note": note.strip(), "source": source.strip()}]
        db.execute("INSERT INTO kv(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", (key, json.dumps(notes)))
    return {"ok": True}

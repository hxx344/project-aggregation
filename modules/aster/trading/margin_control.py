"""Durable funds intent during an ADL-only strategy pause.

This is not transfer authority: current ownership, balances and final transport
guards still apply. A user pause revokes the continuation without changing the
configuration revision frozen by the ADL controller.
"""
import json
import uuid

from .models import TradingError
from .pair_legacy import without_cycle
from .store import dumps


def continuation(pair):
    return {"origin": "adl", "enabled": True, "pair_id": pair["id"],
            "revision": pair["revision"], "long_account_id": pair["long_account_id"],
            "short_account_id": pair["short_account_id"]}


def margin_running(pair, control=None):
    if pair.get("margin", {}).get("enabled") is not True:
        return False
    if pair.get("enabled") is True:
        return True
    return (isinstance(control, dict) and control.get("enabled") is True
            and type(control.get("revision")) is int
            and all(control.get(key) == value for key, value in continuation(pair).items()))


def adl_margin_start_allowed(pair, incident, control=None):
    return (pair.get("enabled") is False and pair.get("margin", {}).get("enabled") is True
            and not margin_running(pair, control) and isinstance(incident, dict)
            and incident.get("pair_id") == pair["id"] and bool(incident.get("id"))
            and incident.get("revision") == pair.get("revision")
            and incident.get("hold") is True
            and incident.get("status") in {"active", "blocked", "completed"})


def read_control(db, pair_id):
    row = db.execute("SELECT data FROM kv WHERE key=?", ("pair_margin_control:" + pair_id,)).fetchone()
    return json.loads(row[0]) if row else None


def save_control(db, pair, *, enabled=True):
    db.execute("INSERT INTO kv(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
               ("pair_margin_control:" + pair["id"], dumps({**continuation(pair), "enabled": enabled,
                                                          "generation": uuid.uuid4().hex})))


def pause_for_adl(store, db, pair, reason):
    """Caller owns the transaction: pause strategy and preserve funds together."""
    row = db.execute("SELECT data FROM pairs WHERE id=?", (pair["id"],)).fetchone()
    if not row or without_cycle(json.loads(row[0])) != pair:
        raise TradingError("ADL 暂停期间配对配置已变化，等待重新核对")
    running = margin_running(pair, read_control(db, pair["id"]))
    saved = store._save_pair(db, {**pair, "enabled": False, "pause_reason": reason})
    save_control(db, saved, enabled=running)
    return saved

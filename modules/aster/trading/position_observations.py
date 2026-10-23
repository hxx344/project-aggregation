"""Read existing position evidence without fetching or blocking trading workers."""
from contextlib import ExitStack
from copy import deepcopy
from fractions import Fraction
import json
import math

from .execution import Executor, TERMINAL
from .models import SYMBOLS, TradingError, positive, wire
from .position_imbalance_notifications import KEY as NOTIFICATIONS_KEY, finite_time

ACTIVITY_PREFIX = "position_activity:"


def initialize(db):
    # Transactional counters catch batches which begin and finish between two
    # notification ticks, including execution paths that write SQL directly.
    # No historical scan, new table or execution-side notification call is needed.
    for action, condition in (("INSERT", "1"), ("UPDATE", "NEW.status != OLD.status")):
        db.execute(f"""CREATE TRIGGER IF NOT EXISTS position_intent_{action.lower()}
            AFTER {action} ON intents WHEN {condition}
            BEGIN
              INSERT INTO kv(key,data) VALUES ('{ACTIVITY_PREFIX}account:' || NEW.account_id,'1')
              ON CONFLICT(key) DO UPDATE SET data=CAST(CAST(kv.data AS INTEGER)+1 AS TEXT);
            END""")
    for action, condition in (("INSERT", "json_extract(NEW.data,'$.pending') IS NOT NULL"),
                              ("UPDATE", """json_extract(NEW.data,'$.pending.id') IS NOT json_extract(OLD.data,'$.pending.id')
                                OR (json_extract(NEW.data,'$.pending') IS NOT NULL
                                    AND json_extract(NEW.data,'$.phase') IS NOT json_extract(OLD.data,'$.phase'))""")):
        db.execute(f"""CREATE TRIGGER IF NOT EXISTS position_pair_{action.lower()}
            AFTER {action} ON kv WHEN NEW.key GLOB 'pair_runtime:*' AND ({condition})
            BEGIN
              INSERT INTO kv(key,data) VALUES ('{ACTIVITY_PREFIX}pair:' || substr(NEW.key,14),'1')
              ON CONFLICT(key) DO UPDATE SET data=CAST(CAST(kv.data AS INTEGER)+1 AS TEXT);
            END""")


def terminal(orders, receipts):
    if not orders:
        return False
    try:
        for order, receipt in zip(orders, receipts, strict=True):
            Executor.validate_receipt(order, receipt)
            if receipt["status"] not in TERMINAL:
                return False
    except (TradingError, ValueError, TypeError, KeyError):
        return False
    return True


def settled_attention(pending, phase=None):
    if not pending or (phase if phase is not None else pending.get("status")) != "attention":
        return False
    if "legs" in pending:
        legs = pending["legs"] + pending.get("repairs", [])
        return terminal([leg["order"] for leg in legs], [leg.get("receipt") for leg in legs])
    orders = pending.get("orders", []) + pending.get("repairs", [])
    return terminal(orders, [pending.get("receipts", {}).get(order.get("newClientOrderId")) for order in orders])


def quantity(snapshot, symbol, side):
    positions = snapshot.get("positions") if isinstance(snapshot, dict) else None
    if not isinstance(positions, list):
        return None
    matches = [p for p in positions if isinstance(p, dict) and p.get("symbol") == symbol and p.get("side") == side]
    return matches[0].get("qty") if len(matches) == 1 else None


def activity(store, scope):
    return str(store.get(ACTIVITY_PREFIX + scope, 0))


def acquire(stack, locks):
    for lock in locks:
        if not lock.acquire(blocking=False):
            return False
        stack.callback(lock.release)
    return True


def sample(row, snapshots, sides):
    row["sample_times"] = [s.get("timestamp") for s in snapshots]
    row["long_qty"], row["short_qty"] = [quantity(s, row["symbol"], side) for s, side in zip(snapshots, sides)]
    row["suppressed"] |= any(bool(s.get("open_orders")) for s in snapshots)


def pair_inventory(state, side, configured_symbol):
    """Choose complete local holdings for alerts, never for trading authority."""
    trading = state.get("snapshots", {}).get(side) or {}
    display = state.get("display_positions", {}).get(side) or {}
    displayed = display.get("snapshot") or {}
    candidates = [(trading, False), (displayed, True)]
    candidates = [(snapshot, complete) for snapshot, complete in candidates
                  if finite_time(snapshot.get("timestamp"))]
    if not candidates:
        return None
    snapshot, complete = max(candidates, key=lambda item: (item[0]["timestamp"], item[1]))
    # A later failed inventory cannot be hidden by a still-fresh older success.
    if (finite_time(display.get("checked_at")) and display["checked_at"] >= snapshot["timestamp"]
            and (display.get("error") or not isinstance(displayed.get("positions"), list))):
        return None
    if not isinstance(snapshot.get("positions"), list):
        return None
    quantities = {}
    try:
        for position in snapshot["positions"]:
            symbol, direction = position["symbol"], position["side"]
            if (not isinstance(symbol, str) or not symbol.strip() or symbol != symbol.strip()
                    or direction not in ("LONG", "SHORT") or (symbol, direction) in quantities):
                return None
            quantities[symbol, direction] = Fraction(positive(position.get("qty"), True))
    except (TradingError, KeyError, TypeError):
        return None
    # Broker snapshots include every nonzero holding, but their configured
    # market must still have explicit two-sided evidence. Display inventories
    # are complete lists of nonzero holdings and may legitimately be empty.
    if not complete and any((configured_symbol, direction) not in quantities for direction in ("LONG", "SHORT")):
        return None
    return snapshot, quantities


def collect(engine):
    accounts, pairs = engine.store.accounts(), engine.store.pairs()
    members = {p[key] for p in pairs for key in ("long_account_id", "short_account_id")}
    modes = {a["id"]: a["mode"] for a in accounts}
    prefixes = {a["id"]: a.get("env_prefix") for a in accounts}
    names = {a["id"]: a["name"] for a in accounts}
    previous = engine.store.get(NOTIFICATIONS_KEY, {}).get("targets", {})
    schedules = engine.scheduling(accounts)
    result = []
    for pair in pairs:
        aids = [pair["long_account_id"], pair["short_account_id"]]
        if any(modes.get(aid) != "live" for aid in aids):
            continue
        scope = "pair:" + pair["id"]
        bindings = {aid: prefixes[aid] for aid in aids}
        identity = scope + ":" + ":".join(aids + [str(prefixes[aid]) for aid in aids])
        symbols = {pair["symbol"]} | {target["symbol"] for target in previous.values()
                    if (target.get("capture") or {}).get("scope") == scope}
        margin = pair.get("margin") or {}
        interval = margin.get("check_interval_seconds", 5) if (margin.get("enabled")
            and not (pair.get("ordinary") or {}).get("enabled")) else 30
        interval = min(3600, max(1, interval)) if finite_time(interval) else 30
        base = {"scope": scope, "bindings": bindings, "label": "配对组「" + pair["name"] + "」",
                "configured_symbol": pair["symbol"], "activity": activity(engine.store, scope),
                "sample_times": [], "suppressed": True, "max_gap": max(70, 2 * interval + 10), "attention": False}
        rows = {symbol: {**base, "key": identity + ":" + symbol, "symbol": symbol} for symbol in sorted(symbols)}
        result.extend(rows.values())
        with ExitStack() as stack:
            if not acquire(stack, [engine.pairs.group_lock(pair["id"])] + [engine.account_lock(aid) for aid in sorted(aids)]):
                continue
            with engine.store.read_snapshot() as store:
                current = store.pair(pair["id"])
                if current != pair:
                    continue
                state = store.get("pair_runtime:" + pair["id"], {}) or {}
                pending = state.get("pending")
                base["activity"] = activity(store, scope)
                base["attention"] = settled_attention(pending, state.get("phase"))
                # Archived unknown orders cannot be inferred settled from holdings.
                base["suppressed"] = bool(state.get("recovery_watch") or (pending and not base["attention"]))
                inventories = [pair_inventory(state, side, pair["symbol"]) for side in ("long", "short")]
                if any(inventory is None for inventory in inventories):
                    continue
                snapshots, quantities = zip(*inventories)
                base["sample_times"] = [s["timestamp"] for s in snapshots]
                base["suppressed"] |= any(bool(s.get("open_orders")) for s in snapshots)
                symbols |= {symbol for inventory in quantities for symbol, _ in inventory}
                for symbol in sorted(symbols):
                    if symbol not in rows:
                        rows[symbol] = {"key": identity + ":" + symbol, "symbol": symbol}
                        result.append(rows[symbol])
                    row = rows[symbol]
                    row.update(base)
                    row["member_quantities"] = [{"name": names[aid], **{
                        direction.lower() + "_qty": wire(inventory.get((symbol, direction), Fraction()))
                        for direction in ("LONG", "SHORT")}} for aid, inventory in zip(aids, quantities)]
                    # Include reverse-side holdings in the actual hedge totals.
                    row["long_qty"], row["short_qty"] = [wire(sum(
                        (inventory.get((symbol, direction), Fraction()) for inventory in quantities), Fraction()))
                        for direction in ("LONG", "SHORT")]
    for account in accounts:
        aid = account["id"]
        if aid in members or account["mode"] != "live":
            continue
        scope = "account:" + aid
        interval = schedules.get(aid, {}).get("interval", 60)
        marker = activity(engine.store, scope)
        rows = [{"key": scope + ":" + str(prefixes[aid]) + ":" + symbol, "scope": scope, "bindings": {aid: prefixes[aid]},
                 "label": "账户「" + account["name"] + "」",
                 "symbol": symbol, "activity": marker, "sample_times": [], "suppressed": False,
                 "max_gap": min(180, max(20, 2 * interval + 10)), "attention": False} for symbol in SYMBOLS]
        result.extend(rows)
        with ExitStack() as stack:
            if not acquire(stack, [engine.account_lock(aid)]):
                continue
            with engine.store.read_snapshot() as store:
                if store.account(aid) != account or store.pair_for_account(aid):
                    continue
                pending, post_fill = store.intent(aid), store.get("post_fill_check:" + aid)
                marker = activity(store, scope)
                attention = settled_attention(pending)
                suppressed = bool(post_fill or (pending and not attention))
                with engine.lock:
                    candidates = [deepcopy(engine.views.get(aid, {}).get("snapshot") or {}),
                                  deepcopy(engine.display_snapshots.get(aid) or {})]
                for row in rows:
                    row.update(activity=marker, suppressed=suppressed, attention=attention)
                    # A partial snapshot must not erase another symbol's evidence.
                    available = [s for s in candidates if type(s.get("timestamp")) in (float, int)
                                 and math.isfinite(s["timestamp"])
                                 and all(quantity(s, row["symbol"], side) is not None for side in ("LONG", "SHORT"))]
                    snapshot = max(available, key=lambda s: s.get("timestamp", 0), default={})
                    sample(row, [snapshot, snapshot], ["LONG", "SHORT"])
    return result


def current(db, row):
    """Recheck durable identity/activity after capture, in the outbox transaction."""
    scope = row["scope"]
    marker = db.execute("SELECT data FROM kv WHERE key=?", (ACTIVITY_PREFIX + scope,)).fetchone()
    if row["activity"] != str(json.loads(marker[0]) if marker else 0):
        return False
    kind, identity = scope.split(":", 1)
    table = "pairs" if kind == "pair" else "accounts"
    saved = db.execute(f"SELECT data FROM {table} WHERE id=?", (identity,)).fetchone()
    if not saved:
        return False
    for aid, prefix in row.get("bindings", {}).items():
        member = db.execute("SELECT data FROM accounts WHERE id=?", (aid,)).fetchone()
        if not member:
            return False
        member = json.loads(member[0])
        if member.get("mode") != "live" or member.get("env_prefix") != prefix:
            return False
    if kind == "pair":
        pair = json.loads(saved[0])
        aids = [pair["long_account_id"], pair["short_account_id"]]
        runtime = db.execute("SELECT data FROM kv WHERE key=?", ("pair_runtime:" + identity,)).fetchone()
        runtime = json.loads(runtime[0]) if runtime else {}
        if (runtime.get("recovery_watch") or (runtime.get("pending")
                and not settled_attention(runtime["pending"], runtime.get("phase")))):
            return False
        return (set(row["bindings"]) == set(aids)
                and isinstance(row.get("symbol"), str) and bool(row["symbol"])
                and pair["symbol"] == row.get("configured_symbol")
                and row["key"] == scope + ":" + ":".join(aids + [str(row["bindings"][aid]) for aid in aids])
                    + ":" + row["symbol"])
    intent = db.execute("SELECT data FROM intents WHERE account_id=? AND status NOT IN ('complete','aborted')", (identity,)).fetchone()
    check = db.execute("SELECT data FROM kv WHERE key=?", ("post_fill_check:" + identity,)).fetchone()
    if (intent and not settled_attention(json.loads(intent[0]))) or (check and json.loads(check[0])):
        return False
    return not db.execute("SELECT 1 FROM pair_members WHERE account_id=?", (identity,)).fetchone()

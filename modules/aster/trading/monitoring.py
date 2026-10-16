"""Persisted monitoring choices and the shared notification delivery policy."""
import json
import re
import time
from copy import deepcopy

import monitor
from .models import MARKET_SYMBOLS, SYMBOLS, TradingError

KEY = "monitoring_settings"
LEGACY_DEFAULTS = {
    "monitoring_enabled": True,
    "discovery_enabled": True,
    "auto_monitor_new": True,
    "feishu_enabled": True,
    "new_listing_alerts": True,
    "strategy_capacity_alerts": True,
    "listing_capacity_alerts": True,
    "trade_summary_alerts": True,
    "hourly_summary_alerts": True,
    "hourly_summary_interval_minutes": 60,
    "relay_health_alerts": True,
    "position_imbalance_alerts": True,
}
NOTIFICATION_TYPES = ("new_listing", "listing_capacity", "strategy_capacity", "trade_summary", "position_imbalance")
DEFAULTS = {**LEGACY_DEFAULTS, "schema_version": 2, "auto_discover": True,
            "default_notification_types": [kind for kind in NOTIFICATION_TYPES if kind != "listing_capacity"]}
GLOBAL_FIELDS = set(DEFAULTS) - {"schema_version"}
CAPACITY_DEFAULTS = {"listing_capacity_leverage": None, "listing_capacity_threshold": "0"}
SYMBOL_FIELDS = {"monitor_enabled", "notification_types", "monitor", "alerts", "max_capacity_alert", *CAPACITY_DEFAULTS}
CATEGORIES = set(NOTIFICATION_TYPES) | {"hourly_summary", "relay_health"}


def applicable_types(types, symbol):
    return [kind for kind in NOTIFICATION_TYPES if kind in types
            and (kind != "strategy_capacity" or symbol in MARKET_SYMBOLS)]


def migrate_v1_to_v2(old_config, watches=None, symbols=()):
    """Preserve the effective legacy policy and every durable delivery gate."""
    config = {**deepcopy(LEGACY_DEFAULTS), "symbols": {}, "revision": 0, **deepcopy(old_config)}
    if config.get("schema_version", 1) >= 2:
        return config
    watches = watches or {}
    defaults = [kind for kind in NOTIFICATION_TYPES
                if kind != "listing_capacity" and config[kind + "_alerts"]]
    config.update(schema_version=2, auto_discover=config["discovery_enabled"],
                  default_notification_types=defaults)
    for symbol in set(config["symbols"]) | set(symbols) | set(watches) | set(MARKET_SYMBOLS):
        options = {"monitor": symbol in SYMBOLS or config["auto_monitor_new"], "alerts": True,
                   **config["symbols"].get(symbol, {})}
        types = applicable_types(defaults, symbol) if options["alerts"] else []
        # max_capacity_alert was never the durable selection. Only the separate
        # watch record can prove that the user selected this notification.
        if config["listing_capacity_alerts"] and options["alerts"] and watches.get(symbol, {}).get("enabled"):
            types = applicable_types([*types, "listing_capacity"], symbol)
        options.update(monitor_enabled=options["monitor"], notification_types=types)
        options.pop("max_capacity_alert", None)
        config["symbols"][symbol] = options
    return config


def _load(db):
    row = db.execute("SELECT data FROM kv WHERE key=?", (KEY,)).fetchone()
    config = json.loads(row[0]) if row else {}
    if config.get("schema_version", 1) < 2:
        watches = {row[0].split(":", 1)[1]: json.loads(row[1]) for row in
                   db.execute("SELECT key,data FROM kv WHERE key GLOB 'usd1_watch:*'")}
        row = db.execute("SELECT data FROM kv WHERE key='usd1_listings'").fetchone()
        symbols = json.loads(row[0]).get("rows", {}) if row else {}
        return migrate_v1_to_v2(config, watches, symbols), True
    config = {**deepcopy(DEFAULTS), "symbols": {}, "revision": 0, **config}
    config["discovery_enabled"] = config["auto_discover"]
    return config, False


def read(db):
    # read_snapshot() uses query_only. Migration persistence belongs exclusively
    # to Store's existing initialization transaction, never a dashboard read.
    return _load(db)[0]


def initialize(db):
    config, migrated = _load(db)
    if migrated:
        db.execute("INSERT OR IGNORE INTO kv(key,data) SELECT 'monitoring_settings_v1_backup',data FROM kv WHERE key=?", (KEY,))
        write(db, config)


def write(db, config):
    db.execute("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
               (KEY, json.dumps(config, ensure_ascii=False, separators=(",", ":"))))


def symbol_options(config, symbol):
    monitor_enabled = symbol in SYMBOLS or config["auto_monitor_new"]
    options = {**CAPACITY_DEFAULTS, "monitor": monitor_enabled, "monitor_enabled": monitor_enabled, "alerts": True,
               "notification_types": applicable_types(config["default_notification_types"], symbol),
               **config["symbols"].get(symbol, {})}
    return {**options, "monitor": options["monitor_enabled"],
            "notification_types": list(options["notification_types"])}


def monitored(config, symbol):
    return config["monitoring_enabled"] and symbol_options(config, symbol)["monitor_enabled"]


def allowed(config, category, symbols):
    if not config["feishu_enabled"]:
        return False
    # ADL recovery reports cover every native symbol in a bound account pair.
    # They have no optional per-symbol notification setting.
    if category == "adl":
        return True
    if category not in CATEGORIES:
        return False
    if category in ("hourly_summary", "relay_health"):
        return config[category + "_alerts"]
    if not symbols or not all(category in symbol_options(config, symbol)["notification_types"] for symbol in symbols):
        return False
    if category not in ("trade_summary", "position_imbalance") and not all(monitored(config, symbol) for symbol in symbols):
        return False
    return category != "new_listing" or config["auto_discover"]


allowed_v2 = allowed


def metadata(item):
    if item.get("category"):
        return item["category"], json.loads(item["symbols"] or "[]")
    if item.get("capacity_key"):
        return "strategy_capacity", [item["capacity_key"].split(":")[1]]
    parts = item["id"].split(":")
    if parts[0] in ("usd1-listing", "usd1-capacity") and len(parts) >= 2:
        return ("new_listing" if parts[0] == "usd1-listing" else "listing_capacity"), [parts[1]]
    # Legacy trade messages have no trustworthy symbol metadata. Preserve them
    # by default; cancel the whole old aggregate if any constituent is muted.
    return "trade_summary", list(SYMBOLS)


def message_allowed(db, item, config=None):
    category, symbols = metadata(item)
    return allowed(config or read(db), category, symbols)


def validate_capacity_threshold(value):
    """Use the editor's decimal grammar without converting amounts to floats."""
    if type(value) is not str:
        raise TradingError("额度通知阈值必须为非负十进制字符串")
    text = value.strip()
    if not re.fullmatch(r"\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", text):
        raise TradingError("额度通知阈值必须为有效的非负十进制数")
    try:
        monitor.number(text)
    except monitor.MonitorError:
        raise TradingError("额度通知阈值必须为有效的非负十进制数") from None
    return text


def validate_edit(changes, fields):
    if not changes or set(changes) - set(fields):
        raise TradingError("请提交有效的监控或告警开关")
    for field, value in changes.items():
        if field == "listing_capacity_leverage":
            if value is not None and (type(value) is not int or not 1 <= value <= 10000):
                raise TradingError("额度通知杠杆必须为 1–10000 的整数或最大杠杆")
        elif field == "listing_capacity_threshold":
            validate_capacity_threshold(value)
        elif field == "hourly_summary_interval_minutes":
            if type(value) is not int or not 1 <= value <= 1440:
                raise TradingError("摘要发送间隔必须为 1–1440 的整数分钟")
        elif field in ("notification_types", "default_notification_types"):
            if (not isinstance(value, list) or any(type(kind) is not str or kind not in NOTIFICATION_TYPES for kind in value)
                    or len(set(value)) != len(value)):
                raise TradingError("请选择有效且不重复的通知类型")
        elif type(value) is not bool:
            raise TradingError("请提交有效的监控或告警开关")
    for current, legacy in (("auto_discover", "discovery_enabled"), ("monitor_enabled", "monitor")):
        if current in changes and legacy in changes and changes[current] != changes[legacy]:
            raise TradingError("新旧监控字段不能设置为不同值")
    if "notification_types" in changes and {"alerts", "max_capacity_alert"} & changes.keys():
        raise TradingError("通知类型不能与旧告警开关同时修改")
    if "default_notification_types" in changes and any(kind + "_alerts" in changes for kind in NOTIFICATION_TYPES):
        raise TradingError("默认通知类型不能与旧通知类型开关同时修改")


def edit_symbol(config, symbol, changes, watch_enabled):
    options = config["symbols"][symbol]
    for key, default in CAPACITY_DEFAULTS.items():
        if key in changes:
            before, after = options.get(key, default), changes[key]
            if key == "listing_capacity_threshold":
                after = validate_capacity_threshold(after)
            # Equivalent decimal spellings and the first default save must not
            # reset an existing notification episode or raise the revision.
            changed = (monitor.number(before) != monitor.number(after)
                       if key == "listing_capacity_threshold" else before != after)
            if changed:
                options[key] = after
    if "monitor_enabled" in changes or "monitor" in changes:
        options["monitor_enabled"] = changes.get("monitor_enabled", changes.get("monitor"))
        options["monitor"] = options["monitor_enabled"]
    if "notification_types" in changes:
        types = changes["notification_types"]
        if "strategy_capacity" in types and symbol not in MARKET_SYMBOLS:
            raise TradingError("只有策略品种可启用策略额度通知")
        options["notification_types"] = applicable_types(types, symbol)
        options["alerts"] = bool(types)
        return "listing_capacity" in types
    if "alerts" in changes:
        options["alerts"] = changes["alerts"]
        types = [kind for kind in NOTIFICATION_TYPES if config[kind + "_alerts"]
                 and (kind != "listing_capacity" or watch_enabled)] if changes["alerts"] else []
        options["notification_types"] = applicable_types(types, symbol)
    if "max_capacity_alert" in changes:
        enabled = changes["max_capacity_alert"]
        types = set(options["notification_types"])
        if enabled and options["alerts"] and config["listing_capacity_alerts"]:
            types.add("listing_capacity")
        else:
            types.discard("listing_capacity")
        options["notification_types"] = applicable_types(types, symbol)
        return enabled
    return watch_enabled


def edit_global(config, changes, watched):
    config.update(changes)
    if "auto_discover" in changes or "discovery_enabled" in changes:
        config["auto_discover"] = changes.get("auto_discover", changes.get("discovery_enabled"))
        config["discovery_enabled"] = config["auto_discover"]
    if "default_notification_types" in changes:
        config["default_notification_types"] = [kind for kind in NOTIFICATION_TYPES
                                                 if kind in changes["default_notification_types"]]
    # Old clients still make explicit bulk edits. These flags are retained for
    # compatibility, but are never hidden runtime gates on v2 symbol choices.
    for kind in NOTIFICATION_TYPES:
        field = kind + "_alerts"
        if field not in changes:
            continue
        defaults = set(config["default_notification_types"])
        if changes[field] and kind != "listing_capacity":
            defaults.add(kind)
        else:
            defaults.discard(kind)
        config["default_notification_types"] = [value for value in NOTIFICATION_TYPES if value in defaults]
        for symbol, options in config["symbols"].items():
            types = set(options["notification_types"])
            if changes[field] and options["alerts"] and (kind != "listing_capacity" or symbol in watched):
                types.add(kind)
            else:
                types.discard(kind)
            options["notification_types"] = applicable_types(types, symbol)


def validate_symbol(db, symbol):
    state = db.execute("SELECT data FROM kv WHERE key='usd1_listings'").fetchone()
    rows = json.loads(state[0]).get("rows", {}) if state else {}
    saved_symbols = read(db)["symbols"]
    if (not isinstance(symbol, str) or not re.fullmatch(r"[\w.-]{1,80}", symbol)
            or symbol not in set(MARKET_SYMBOLS) | set(rows) | set(saved_symbols)):
        raise TradingError("请选择列表中已有的交易对")


def register_symbols(db, symbols):
    config = read(db)
    missing = set(symbols) - config["symbols"].keys()
    if missing:
        for symbol in missing:
            config["symbols"][symbol] = symbol_options(config, symbol)
        write(db, config)
    return config


def cancel_disabled(db, config):
    """Cancellation is durable: later re-enabling cannot revive old retries."""
    for row in db.execute("SELECT * FROM outbox WHERE delivered_at IS NULL AND (expires_at IS NULL OR expires_at>0)").fetchall():
        item = dict(row)
        if not message_allowed(db, item, config):
            db.execute("UPDATE outbox SET expires_at=0 WHERE id=?", (item["id"],))
    for row in db.execute("SELECT key,data FROM kv WHERE key GLOB 'capacity_alert:*' OR key GLOB 'usd1_watch:*'").fetchall():
        parts = row["key"].split(":")
        category = "strategy_capacity" if parts[0] == "capacity_alert" else "listing_capacity"
        if not allowed(config, category, [parts[1]]):
            gate = json.loads(row["data"])
            gate.update(pending_id=None, notified=False, resume_after=time.time())
            db.execute("UPDATE kv SET data=? WHERE key=?", (json.dumps(gate), row["key"]))
    row = db.execute("SELECT data FROM kv WHERE key='usd1_listings'").fetchone()
    if row:
        state = json.loads(row[0])
        if not config["monitoring_enabled"] or not config["discovery_enabled"]:
            # Resuming discovery establishes a baseline for the disabled period.
            state["rebaseline"] = True
        for symbol, listing in state.get("rows", {}).items():
            if not allowed(config, "new_listing", [symbol]) and listing.get("notification_phase") in ("pending", "incomplete"):
                listing["notification_phase"] = "suppressed"
        db.execute("UPDATE kv SET data=? WHERE key='usd1_listings'", (json.dumps(state, ensure_ascii=False),))

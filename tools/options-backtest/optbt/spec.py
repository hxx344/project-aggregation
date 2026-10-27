"""Backtest spec: a JSON document, defaults, validation and `--set path=value` overrides."""
import copy
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
FILLS = ("mark", "mid", "cross", "passive")
EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
DEFAULTS = {
    "name": "backtest",
    "description": "",
    "start": None,  # first entry date (UTC, inclusive); default: first data hour
    "end": None,    # last entry date (UTC, inclusive); default: last data hour
    "entry": {"weekdays": None, "hours": [0]},  # UTC; weekdays None = every day
    "expiry": {"weekday": None, "dte": 2, "min_hours": 1},
    "legs": [],
    "qty": 1.0,
    "fill": "mid",
    "fees": {"rate": 0.0003, "cap_pct": 0.07, "settle_rate": 0.00015, "settle_cap_pct": 0.125, "perp_rate": 0.0005},
    "exit": {"take_profit_pct": None, "stop_loss_pct": None, "close_hours_before_expiry": None},
    "max_open": 1,
    "margin": {"mode": "regular", "mm_factor": 0.03, "max_im_factor": 0.10, "min_im_factor": 0.05, "liquidation_fee_rate": 0.002,
               "perp_im": 0.10},
}
LEG_DEFAULTS = {"side": None, "type": None, "delta": None, "qty": 1.0, "beyond": None, "expiry": None}


class SpecError(ValueError):
    pass


def load(text):
    """A spec from a JSON file path, an inline JSON object or an example name."""
    if text.lstrip().startswith("{"):
        return json.loads(text)
    path = Path(text).expanduser()
    if not path.exists() and (EXAMPLES / f"{text}.json").exists():
        path = EXAMPLES / f"{text}.json"
    if not path.exists():
        names = ", ".join(sorted(p.stem for p in EXAMPLES.glob("*.json")))
        raise SpecError(f"spec {text!r} is not a file, inline JSON or example ({names})")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_value(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def parse_choices(text):
    """`0.3,0.4` -> [0.3, 0.4]; `mid,cross` -> ["mid", "cross"]; `null,0.5` -> [None, 0.5]."""
    try:
        values = json.loads(f"[{text}]")
    except json.JSONDecodeError:
        values = [parse_value(part) for part in text.split(",")]
    return values


def set_path(spec, path, value):
    """Set `legs.0.delta`-style paths in place, creating dicts as needed."""
    parts = path.split(".")
    target = spec
    for index, part in enumerate(parts):
        last = index == len(parts) - 1
        key = int(part) if isinstance(target, list) else part
        if isinstance(target, list) and not -len(target) <= key < len(target):
            raise SpecError(f"--set {path}: index {key} out of range")
        if last:
            target[key] = value
        else:
            if not isinstance(target, list) and not isinstance(target.get(key), (dict, list)):
                target[key] = {}
            target = target[key]


def _merge(defaults, given, where):
    if given is None:
        return copy.deepcopy(defaults)
    if not isinstance(given, dict):
        raise SpecError(f"{where} must be an object")
    unknown = set(given) - set(defaults)
    if unknown:
        raise SpecError(f"{where}: unknown keys {sorted(unknown)}; allowed {sorted(defaults)}")
    return {**copy.deepcopy(defaults), **given}


def _number(value, where, low=-math.inf, high=math.inf, optional=False, open_low=False):
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SpecError(f"{where} must be a number")
    if value < low or value > high or (open_low and value == low):
        raise SpecError(f"{where} must be in {'(' if open_low else '['}{low}, {high}]")
    return float(value)


def _hour(value, where, end=False):
    if value is None:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise SpecError(f"{where} must be an ISO date like 2024-01-31 or 2024-01-31T21:00") from exc
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    hour = int(moment.timestamp() // 3600)
    date_only = re.fullmatch(r"\d{4}-?\d{2}-?\d{2}(Z|[+-]\d{2}(:?\d{2})?)?", str(value).strip(), re.IGNORECASE)
    return hour + 23 if end and date_only else hour


def _weekday(value, where):
    """0-6 from a day name ("fri", "Friday") or an index, as written back to a result's spec.json."""
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6:
        return value
    if str(value).lower()[:3] not in WEEKDAYS:
        raise SpecError(f"{where} must be one of {WEEKDAYS}")
    return WEEKDAYS.index(str(value).lower()[:3])


def _expiry_rule(rule, where):
    rule = _merge(DEFAULTS["expiry"], rule, where)
    if rule["weekday"] is not None:
        rule["weekday"] = _weekday(rule["weekday"], f"{where}.weekday")
    rule["dte"] = _number(rule["dte"], f"{where}.dte", 0, 800)
    rule["min_hours"] = _number(rule["min_hours"], f"{where}.min_hours", 0, 24 * 800)
    return rule


def validate(raw):
    """Fill defaults and check every field; returns a normalized copy."""
    spec = _merge(DEFAULTS, raw, "spec")
    spec["name"] = str(spec["name"])
    spec["start_hour"], spec["end_hour"] = _hour(spec["start"], "start"), _hour(spec["end"], "end", end=True)
    entry = spec["entry"] = _merge(DEFAULTS["entry"], spec["entry"], "entry")
    if entry["weekdays"] is not None:
        if not isinstance(entry["weekdays"], list) or not entry["weekdays"]:
            raise SpecError(f"entry.weekdays must list days from {WEEKDAYS} (or be null for every day)")
        entry["weekdays"] = sorted({_weekday(day, "entry.weekdays") for day in entry["weekdays"]})
    hours = entry["hours"]
    if not isinstance(hours, list) or not hours or any(isinstance(h, bool) or not isinstance(h, int) or not 0 <= h <= 23 for h in hours):
        raise SpecError("entry.hours must be a non-empty list of UTC hours 0-23")
    spec["expiry"] = _expiry_rule(spec["expiry"], "expiry")
    if not isinstance(spec["legs"], list) or not spec["legs"]:
        raise SpecError("legs must be a non-empty list")
    legs = []
    for index, leg in enumerate(spec["legs"]):
        where = f"legs.{index}"
        leg = _merge(LEG_DEFAULTS, leg, where)
        if leg["side"] not in ("buy", "sell"):
            raise SpecError(f"{where}.side must be buy or sell")
        if leg["type"] not in ("call", "put", "perp"):
            raise SpecError(f"{where}.type must be call, put or perp")
        if leg["type"] == "perp":
            if leg["delta"] is not None or leg["beyond"] is not None or leg["expiry"] is not None:
                raise SpecError(f"{where}: a perp leg takes no delta, beyond or expiry (it closes with the options)")
        else:
            leg["delta"] = _number(leg["delta"], f"{where}.delta", 0, 1, open_low=True)
        leg["qty"] = _number(leg["qty"], f"{where}.qty", 0, 1000, open_low=True)
        if leg["beyond"] is not None:
            if not isinstance(leg["beyond"], int) or not 0 <= leg["beyond"] < index or spec["legs"][leg["beyond"]].get("type") != leg["type"]:
                raise SpecError(f"{where}.beyond must be the index of an earlier {leg['type']} leg")
        leg["expiry"] = None if leg["expiry"] is None else _expiry_rule(leg["expiry"], f"{where}.expiry")
        legs.append(leg)
    spec["legs"] = legs
    if all(leg["type"] == "perp" for leg in legs):
        raise SpecError("legs need at least one option leg; perp legs close at its expiry")
    spec["qty"] = _number(spec["qty"], "qty", 0, 1000, open_low=True)
    if spec["fill"] not in FILLS:
        raise SpecError(f"fill must be one of {FILLS}")
    fees = spec["fees"] = _merge(DEFAULTS["fees"], spec["fees"], "fees")
    for key in fees:
        fees[key] = _number(fees[key], f"fees.{key}", 0, 1)
    exits = spec["exit"] = _merge(DEFAULTS["exit"], spec["exit"], "exit")
    exits["take_profit_pct"] = _number(exits["take_profit_pct"], "exit.take_profit_pct", 0, 100, optional=True, open_low=True)
    exits["stop_loss_pct"] = _number(exits["stop_loss_pct"], "exit.stop_loss_pct", 0, 100, optional=True, open_low=True)
    exits["close_hours_before_expiry"] = _number(exits["close_hours_before_expiry"], "exit.close_hours_before_expiry", 1, 24 * 800, optional=True)
    if isinstance(spec["max_open"], bool) or not isinstance(spec["max_open"], int) or spec["max_open"] < 1:
        raise SpecError("max_open must be an integer >= 1")
    margin = spec["margin"] = _merge(DEFAULTS["margin"], spec["margin"], "margin")
    if margin["mode"] not in ("regular", "max_loss"):
        raise SpecError("margin.mode must be regular (Bybit regular option IM) or max_loss")
    for key in ("mm_factor", "max_im_factor", "min_im_factor", "liquidation_fee_rate", "perp_im"):
        margin[key] = _number(margin[key], f"margin.{key}", 0, 1)
    return spec

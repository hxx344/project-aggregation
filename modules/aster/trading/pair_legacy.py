"""Read-only compatibility for removed paired-cycle configurations and journals."""
from .models import TradingError, dec

LEGACY_CYCLE_REASON = "旧循环批次或增量待人工核对，循环功能已移除"


def without_cycle(pair):
    return {key: value for key, value in pair.items() if key != "cycle"}


# The previous release reads pair["cycle"] directly. Every write keeps that key
# in the shape it would have validated itself, so a rollback still loads pairs.
ROLLBACK_CYCLE = {"enabled": False, "leverage": 2, "spread_notional": "10000", "spread_limit_bp": "0.1",
                  "min_notional": "0", "max_notional": "10000", "capacity_multiplier": "1",
                  "notional_scope": "per_side", "hold_seconds": 60, "daily_volume_limit": "0"}


def rollback_cycle(previous, pair, *, disable):
    """Keep an old cycle setting untouched unless this write starts or re-targets the pair."""
    cycle = (previous or {}).get("cycle")
    if not isinstance(cycle, dict):
        return {**ROLLBACK_CYCLE, "symbol": pair["symbol"]}
    return {**cycle, "enabled": False, "symbol": pair["symbol"]} if disable else cycle

def has_legacy_cycle(state, reader=None):
    state = state or {}
    progress = state.get("progress")
    if progress is not None:
        if (not isinstance(progress, dict) or not isinstance(progress.get("quantities"), dict)
                or set(progress["quantities"]) != {"LONG", "SHORT"}):
            return True
        try:
            if any(dec(qty) for qty in progress["quantities"].values()):
                return True
        except (TradingError, ValueError, TypeError):
            return True
    pending = state.get("pending")
    if isinstance(pending, dict):
        if pending.get("kind") == "cycle":
            return True
        if reader is not None and pending.get("id"):
            batch = reader.get("pair_batch:" + pending["id"])
            if isinstance(batch, dict) and batch.get("kind") == "cycle":
                return True
    return False


def require_no_legacy_cycle(state, reader=None):
    if has_legacy_cycle(state, reader):
        from .pair_planning import PairPositionError
        raise PairPositionError(LEGACY_CYCLE_REASON)

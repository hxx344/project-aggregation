"""Display-only monitoring health; never grants trading or notification authority."""
from enum import Enum
import math


class SymbolMonitorStatus(str, Enum):
    ACTIVE = "active"
    STALE = "stale"
    PAUSED = "paused"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


def _positive_number(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def compute_freshness(timestamp, now, threshold=180):
    threshold = threshold if _positive_number(threshold) else 180
    result = {"status": "stale", "timestamp": None, "age_seconds": None,
              "threshold_seconds": threshold}
    if not _positive_number(timestamp) or not _positive_number(now) or now - timestamp < -1:
        return result
    age = max(0, now - timestamp)
    result.update(timestamp=timestamp, age_seconds=age,
                  status="fresh" if age < threshold / 2 else "aging" if age < threshold else "stale")
    return result


def compute_symbol_view(symbol_config, listing, listings, now, *, monitoring_enabled=True, demo=False):
    """Check each source clock; stopping discovery only releases the catalog clock."""
    listing, listings = listing or {}, listings or {}
    discovery = listings.get("discovery_enabled", True)
    threshold = listings.get("stale_seconds", 180)
    stamps = [listing.get("checked_at"), listing.get("brackets_checked_at")]
    if discovery:
        stamps.append(listings.get("checked_at"))
    samples = [compute_freshness(stamp, now, threshold) for stamp in stamps]
    freshness = next((sample for sample in samples if sample["timestamp"] is None),
                     min(samples, key=lambda sample: sample["timestamp"] or 0))
    if demo or not monitoring_enabled or not symbol_config.get("monitor_enabled", symbol_config.get("monitor", True)):
        status = SymbolMonitorStatus.PAUSED
    elif listing.get("error") or discovery and listings.get("error"):
        status = SymbolMonitorStatus.ERROR
    elif listing.get("status") and listing["status"] != "TRADING":
        status = SymbolMonitorStatus.UNAVAILABLE
    elif listing.get("status") != "TRADING" or not listings.get("initialized") or freshness["status"] == "stale":
        status = SymbolMonitorStatus.STALE
    else:
        status = SymbolMonitorStatus.ACTIVE
    return {"monitor_status": status.value, "freshness": freshness,
            "data_available": status == SymbolMonitorStatus.ACTIVE}


def compute_symbol_status(symbol_config, listing, now, stale_threshold=180):
    """Convenience form for a row without a separately maintained catalog."""
    view = compute_symbol_view(symbol_config, listing,
                               {"initialized": True, "discovery_enabled": False,
                                "stale_seconds": stale_threshold}, now)
    return SymbolMonitorStatus(view["monitor_status"])

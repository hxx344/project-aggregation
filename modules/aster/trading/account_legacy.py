"""Read-only guards for removed single-account strategies and their journals."""
from .models import TradingError, dec

REMOVED_CONFIG_KEYS = frozenset({"cycle", "migration", "migration_run_id"})
LEGACY_CONFIG_REASON = "循环/仓位迁移功能已移除，请确认普通开仓设置后重新启动"
LEGACY_PENDING_REASON = "旧循环/迁移批次待人工核对，功能已移除"


def without_removed_config(account):
    return {key: value for key, value in account.items() if key not in REMOVED_CONFIG_KEYS}


def legacy_enabled(account):
    return bool(account.get("enabled") and any(
        isinstance(account.get(key), dict) and account[key].get("enabled")
        for key in ("cycle", "migration")))


def legacy_intent(intent):
    return bool(isinstance(intent, dict) and intent.get("status") not in ("complete", "aborted")
                and (intent.get("kind") in ("cycle", "cycle_leverage", "migration")
                     or intent.get("kind") == "leverage" and intent.get("purpose") == "migration"))


def legacy_position(progress):
    """Only an absent record or a valid, flat, finished one is safe to ignore."""
    if progress is None or progress == {}:
        return False
    if not isinstance(progress, dict):
        return True
    quantities = progress.get("quantities", {})
    if (not isinstance(quantities, dict) or set(quantities) - {"LONG", "SHORT"}
            or progress.get("opened_at") is not None
            or progress.get("phase", "waiting_open") not in ("waiting_open", "complete", "disabled")):
        return True
    try:
        return any(dec(value) != 0 for value in quantities.values())
    except TradingError:
        return True

def legacy_block_reason(store, account_id):
    post_fill = store.get("post_fill_check:" + account_id)
    if (legacy_intent(store.intent(account_id))
            or isinstance(post_fill, dict) and post_fill.get("kind") == "migration"
            or legacy_position(store.get("cycle:" + account_id))):
        return LEGACY_PENDING_REASON
    return None

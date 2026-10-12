"""Read-only process update gate; does not submit, cancel or mutate orders."""
from datetime import datetime, timezone

from .execution_activity import ACTIVE_EXECUTIONS


def update_status(engine):
    if engine.state_error:
        return {"busy": True, "reason": "Greeks 状态不可可靠读取"}
    if engine._trade_admitting or engine.lock.locked() or any(not worker.done() for worker in engine.trade_workers.values()):
        return {"busy": True, "reason": "Greeks 交易执行尚未结束"}
    if any(group.get("execution_status") in ACTIVE_EXECUTIONS for group in engine.execution_groups.values()):
        return {"busy": True, "reason": "Greeks 执行任务等待完成或恢复"}
    if any(not order.get("terminal") for order in engine.order_journal.values()) or engine._rfq_unresolved():
        return {"busy": True, "reason": "Greeks 存在未确认的委托或询价"}
    if engine.settings.can_send_orders or engine.active_strategy_symbols:
        last = engine.reconciliation_last_success
        if (engine.reconciliation_error or last is None or last.tzinfo is None
                or (datetime.now(timezone.utc) - last).total_seconds() > max(60, engine.settings.reconciliation_seconds * 3)):
            return {"busy": True, "reason": "Greeks 交易对账尚未确认"}
    return {"busy": False}

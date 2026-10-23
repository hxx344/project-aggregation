"""Deletion eligibility shared by the dashboard and transactional removal."""
from .account_legacy import legacy_position, LEGACY_PENDING_REASON


def deletion_block(account, pending, post_fill, cycle):
    if account["enabled"]:
        return "请先暂停账户，再删除"
    if pending or post_fill:
        return "账户仍有未完成交易或成交后核对，请处理完成后再删除"
    if legacy_position(cycle):
        return LEGACY_PENDING_REASON + "，处理后再删除"
    return None

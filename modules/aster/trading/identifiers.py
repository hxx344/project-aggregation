"""Validation for account-scoped ledger queries."""
import re
from .models import TradingError


def account_identifier(value):
    if not isinstance(value, str) or re.fullmatch(r"[a-z0-9_-]{1,32}", value) is None:
        raise TradingError("账户标识无效")
    return value

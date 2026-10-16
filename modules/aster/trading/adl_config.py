"""Validated pair settings and immutable per-incident ADL execution policy."""
import re

from .models import TradingError, dec, wire


DEFAULT_ADL = {"enabled": True, "batch_notional": "1000"}
_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?\Z")


def validate_adl(value):
    """Return detached defaults for legacy data and strict canonical settings."""
    if value is None:
        value = {}
    if not isinstance(value, dict) or set(value) - set(DEFAULT_ADL):
        raise TradingError("ADL 配置格式无效或包含未知字段")
    result = {**DEFAULT_ADL, **value}
    if type(result["enabled"]) is not bool:
        raise TradingError("ADL 自动减仓开关必须为布尔值")
    amount = result["batch_notional"]
    if (not isinstance(amount, str) or len(amount) > 40
            or not _DECIMAL.fullmatch(amount)):
        raise TradingError("ADL 单批金额上限必须为不超过 40 字符的普通十进制字符串")
    number = dec(amount)
    if not 1 <= number <= 1000000:
        raise TradingError("ADL 单批金额上限必须在 1 到 1000000 之间")
    canonical = wire(number)
    result["batch_notional"] = canonical.rstrip("0").rstrip(".") if "." in canonical else canonical
    return result

"""Pair-only market catalogue; availability is checked from live data at runtime."""
from typing import Literal

from .models import TradingError


PairSymbol = Literal["XAUUSD1", "XAGUSD1"]
DEFAULT_PAIR_SYMBOL = "XAUUSD1"
SUPPORTED_SYMBOLS = {
    symbol: {
        "display_name": name,
        "min_notional": "500",
        "default_order_notional": "1000",
        "default_threshold": "10000",
        "default_spread_limit": "0.0005",
    }
    for symbol, name in (("XAUUSD1", "黄金 XAUUSD1"), ("XAGUSD1", "白银 XAGUSD1"))
}


def validate_symbol(symbol):
    if not isinstance(symbol, str) or symbol not in SUPPORTED_SYMBOLS:
        raise TradingError("配对交易标的仅支持 " + "、".join(SUPPORTED_SYMBOLS))
    return symbol


def get_symbol_config(symbol):
    return dict(SUPPORTED_SYMBOLS[validate_symbol(symbol)])


def supported_symbols_list():
    return [{"symbol": symbol, **config} for symbol, config in SUPPORTED_SYMBOLS.items()]

"""Account-local market selection for ordinary opening orders."""
from .models import SYMBOLS, TradingError


def ordinary_selection(account):
    policy = account.get("policy", {}) if isinstance(account, dict) else None
    if not isinstance(policy, dict):
        raise TradingError("本账户普通加仓配置无效，已停止普通加仓")
    selected = policy.get("ordinary_symbol", "all")
    if (not isinstance(selected, str) or selected not in ("all", *SYMBOLS)
            or selected != "all" and selected not in policy.get("symbols", SYMBOLS)):
        raise TradingError("本账户有额度开仓交易对无效，已停止普通加仓")
    return selected


def ordinary_add_block_reason(account, symbol):
    if not isinstance(symbol, str) or symbol not in SYMBOLS:
        raise TradingError("本账户普通加仓品种无效，已停止普通加仓")
    selected = ordinary_selection(account)
    if selected != "all" and selected != symbol:
        return f"本账户有额度开仓仅限 {selected}，禁止 {symbol} 普通加仓"
    return None


def ordinary_add_blocks(account):
    return {symbol: reason for symbol in SYMBOLS
            if (reason := ordinary_add_block_reason(account, symbol))}


def ordinary_add_symbols(account):
    blocked = ordinary_add_blocks(account)
    return [symbol for symbol in account["policy"]["symbols"] if symbol not in blocked]

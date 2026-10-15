"""Complete account holdings for display; never execution or risk evidence."""
from .models import TradingError, dec, wire


def account_positions(account, timestamp):
    """Parse the inventory independently of transfer eligibility and market data."""
    result = {"checked_at": timestamp, "error": None}
    try:
        rows = account.get("positions")
        if not isinstance(rows, list):
            raise TradingError("账户接口未返回完整持仓清单")
        positions, seen = [], set()
        for row in rows:
            if not isinstance(row, dict):
                raise TradingError("账户持仓记录无效")
            symbol, side = row.get("symbol"), row.get("positionSide")
            if not isinstance(symbol, str) or not symbol.strip() or symbol != symbol.strip():
                raise TradingError("账户持仓缺少有效标的")
            if side not in ("LONG", "SHORT", "BOTH"):
                raise TradingError("账户持仓方向无效")
            try:
                amount = dec(row.get("positionAmt"))
            except TradingError:
                raise TradingError("账户持仓数量无效") from None
            identity = (symbol, side)
            if identity in seen or (side == "BOTH" and any(key[0] == symbol for key in seen)) or (
                    side != "BOTH" and (symbol, "BOTH") in seen):
                raise TradingError("账户持仓记录重复或方向冲突")
            seen.add(identity)
            if amount == 0:
                continue
            if side == "BOTH":
                side = "LONG" if amount > 0 else "SHORT"

            def optional(field, *, absolute=False, nonnegative=False, positive=False):
                try:
                    value = dec(row.get(field))
                    if absolute:
                        value = value.copy_abs()
                    if (positive and value <= 0) or (nonnegative and value < 0):
                        return None
                    return wire(value)
                except TradingError:
                    return None

            positions.append({"symbol": symbol, "side": side, "qty": wire(amount.copy_abs()),
                "entry": optional("entryPrice", nonnegative=True),
                "mark": optional("markPrice", positive=True),
                "leverage": optional("leverage", positive=True),
                "notional": optional("notional", absolute=True),
                "occupied_margin": optional("positionInitialMargin", nonnegative=True),
                "unrealized": optional("unrealizedProfit"),
                "liquidation": optional("liquidationPrice", positive=True)})
        result["snapshot"] = {"timestamp": timestamp, "positions": positions}
    except TradingError as exc:
        result["error"] = str(exc)
    return result

"""Official account response rows and a local quote market for exchange tests."""
import time

from trading.models import Book, dec
from trading.paper import DemoMarket


SYMBOL = "XAUUSD1"
ACCOUNT = "/fapi/v3/accountWithJoinMargin"
MULTI = "/fapi/v3/multiAssetsMargin"
ORDERS = "/fapi/v3/openOrders"
RISK = "/fapi/v3/positionRisk"
BRACKET = "/fapi/v3/leverageBracket"


def account_row(symbol=SYMBOL, side="LONG", *, amount="0", leverage="5", entry="0", pnl="0", cap="1000000"):
    # These are accountWithJoinMargin fields, not positionRisk fields.
    return {"symbol": symbol, "positionSide": side, "positionAmt": amount, "entryPrice": entry,
            "leverage": leverage, "isolated": False, "unrealizedProfit": pnl, "maxNotional": cap,
            "initialMargin": "0", "maintMargin": "0", "positionInitialMargin": "0",
            "openOrderInitialMargin": "0", "updateTime": 0}


def join_margin_responses(symbols=(SYMBOL,)):
    return {MULTI: {"multiAssetsMargin": False},
            ACCOUNT: {"canTrade": True,
                      "assets": [{"asset": "USD1", "crossWalletBalance": "200", "crossUnPnl": "0",
                                  "maintMargin": "5", "availableBalance": "150", "marginAvailable": True}],
                      "positions": [account_row(symbol, side) for symbol in symbols for side in ("LONG", "SHORT")]}}


def risk_row(row, *, mark="100", pnl=None):
    return {"symbol": row["symbol"], "positionSide": row["positionSide"], "positionAmt": row["positionAmt"],
            "entryPrice": row["entryPrice"], "leverage": row["leverage"], "marginType": "isolated" if row["isolated"] else "cross",
            "unRealizedProfit": row["unrealizedProfit"] if pnl is None else pnl, "markPrice": mark,
            "liquidationPrice": "0"}


class LocalQuoteMarket(DemoMarket):
    demo = False

    def __init__(self):
        super().__init__()
        self.marks = {SYMBOL: dec(100), "SPCXUSD1": dec(200), "CLUSD1": dec(50)}
        self.connected = set(self.marks)
        self.public_reads = []

    def _quote(self, symbol):
        mark = self.marks[symbol]
        return Book(mark - dec(".01"), mark + dec(".01"), dec(100), dec(100), mark, time.time())

    def _stream_book(self, symbol):
        return self._quote(symbol) if symbol in self.connected else None

    def book(self, symbol):
        self.public_reads.append(symbol)
        return self._quote(symbol)

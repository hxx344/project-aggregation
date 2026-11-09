"""Shared two-account pair fixtures: paper brokers and live brokers backed by them.

Plain classes, not TestCase: test modules borrow their methods explicitly.
"""
from copy import deepcopy
import tempfile
from pathlib import Path
from unittest.mock import patch

from tests.helpers import account, seed_market_capacity
from trading.engine import Engine
from trading.exchange import LiveBroker, RateBudget
from trading.models import dec, wire
from trading.pair_execution import PairTrader
from trading.pairing import validate_pair
from trading.paper import PAPER_BRACKETS, DemoMarket, PaperBroker
from trading.store import Store


SYMBOL = "XAUUSD1"
DUAL = "/fapi/v3/positionSide/dual"
MULTI = "/fapi/v3/multiAssetsMargin"


class OfflineAPI:
    def __init__(self, paper, budget, identity):
        self.paper, self.budget = paper, budget
        self.credentials = {"user": f"0x{identity:040x}", "signer": f"0x{identity + 10:040x}"}
        self.calls = []
        self.hedge = True

    def call(self, method, path, params=None, *, signed=False, weight=1, timeout=None, before_send=None):
        self.budget.reserve(weight)
        if before_send is not None:
            before_send()  # The real API runs it in the final transport hook.
        self.calls.append((method, path, self.budget._priority_flags()))
        if path == "/fapi/v3/order":
            if method == "POST":
                return self.paper.submit([params])[0]
            return self.paper.query(params["symbol"], params["origClientOrderId"])
        if path == "/fapi/v3/leverage":
            return self.paper.set_leverage(params["symbol"], int(params["leverage"]))
        if path == DUAL:
            return {"dualSidePosition": self.hedge}
        if path == MULTI:
            return {"multiAssetsMargin": False}
        if path == "/fapi/v3/leverageBracket":
            return {"symbol": SYMBOL, "brackets": deepcopy(PAPER_BRACKETS)}
        snapshot = self.paper.snapshot([SYMBOL])
        positions = [{"symbol": p.symbol, "positionSide": p.side,
                      "positionAmt": wire(p.qty if p.side == "LONG" else -p.qty),
                      "entryPrice": wire(p.entry), "markPrice": wire(p.mark),
                      "leverage": str(p.leverage), "isolated": False,
                      "unrealizedProfit": wire(p.unrealized), "maxNotional": "10000000"}
                     for p in snapshot.positions]
        if path == "/fapi/v3/accountWithJoinMargin":
            return {"canTrade": True, "positions": positions,
                    "assets": [{"asset": "USD1", "crossWalletBalance": wire(snapshot.wallet),
                                "crossUnPnl": wire(snapshot.unrealized), "maintMargin": wire(snapshot.maintenance),
                                "availableBalance": wire(snapshot.available),
                                "maxWithdrawAmount": wire(max(dec(0), snapshot.available))}]}
        if path == "/fapi/v3/positionRisk":
            return [{**row, "marginType": "cross", "unRealizedProfit": row["unrealizedProfit"],
                     "liquidationPrice": "0"} for row in positions]
        raise AssertionError((method, path))


class PairTradingTests:
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "state.sqlite3")
        self.market = DemoMarket()
        self.engine = Engine(self.store, market=self.market)
        self.brokers = {}
        for key in ("long", "short"):
            value = account(key)
            value["enabled"] = False
            self.store.save_account(value)
            self.brokers[key] = PaperBroker(key, self.market, self.store)
            self.engine.brokers[key] = self.brokers[key]
        self.pair = self.store.save_pair(validate_pair({"id": "gold", "name": "黄金配对", "long_account_id": "long",
            "short_account_id": "short", "enabled": True}), create=True)
        self.trader = PairTrader(self.engine)
        seed_market_capacity(self.engine)
        self.margin = patch("trading.margin_balance.MarginBalancer.tick", return_value={"blocks_trading": False})
        self.margin.start()
        self.addCleanup(self.margin.stop)

    def tick(self):
        return self.trader.tick(self.store.pair("gold"))

    def snapshots(self):
        return {key: broker.snapshot([SYMBOL]) for key, broker in self.brokers.items()}


class PairBudgetTests:
    setUp = PairTradingTests.setUp
    tick = PairTradingTests.tick

    def live_brokers(self):
        self.budget = RateBudget()
        self.paper = getattr(self, "paper", self.brokers)
        self.brokers = {key: LiveBroker({}, self.market, api=OfflineAPI(broker, self.budget, index))
                        for index, (key, broker) in enumerate(self.paper.items(), 1)}
        self.engine.brokers.update(self.brokers)
        state = self.store.get("pair_runtime:gold")
        if state:
            state.pop("identities", None)
            self.store.put("pair_runtime:gold", state)


BATCH_ID = "e38af3e9e37845fca5072e21432700000"


def seed_legacy_pending(store, pair_id="gold", kind="ordinary"):
    """Write a runtime left by a version that still sent pair orders (no exchange state needed)."""
    before = {"LONG": "3.039", "SHORT": "3.039"}
    legs = [{"key": key, "order": {"symbol": SYMBOL, "positionSide": side, "side": direction, "type": "MARKET",
                                   "quantity": "0.2", "newClientOrderId": side[0] + BATCH_ID[:28]},
             "dispatch": "sending", "receipt": None, "error": "previous result unknown"}
            for key, side, direction in (("long", "LONG", "BUY"), ("short", "SHORT", "SELL"))]
    pending = {"id": BATCH_ID, "kind": kind, "phase": "open", "symbol": SYMBOL, "quantity": "0.2",
               "before": before, "leverage": 5, "legs": legs, "repairs": [], "repair_attempts": 0}
    runtime = {"phase": "reconciling", "reason": "原订单结果未知", "owned": before, "pending": pending,
               "progress": {"quantities": {"LONG": "0", "SHORT": "0"}},
               "daily_volume": {"2026-09-29": {"long": "123", "short": "456"}},
               "last_batch": {"id": "completed-before", "completed": True}}
    store.put("pair_runtime:" + pair_id, runtime)
    return deepcopy(runtime)

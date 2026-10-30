from pathlib import Path
import tempfile
import time
from unittest import mock

from trading.engine import DEFAULT_POLICY
from trading.paper import DemoMarket, PaperBroker
from trading.store import Store


def clear_of_utc_midnight(test, margin=3900):
    """Keep the test clock on one UTC date, at least ``margin`` seconds from midnight.

    Pair fixtures date unfinished batches an hour back while fills are stamped
    now; a batch spanning UTC midnight rightly leaves its daily volume unknown,
    so near midnight the clock moves within the same date instead.
    """
    since = time.time() % 86400
    shift = max(margin - since, 0) + min(86400 - margin - since, 0)
    if shift:
        real = time.time
        patcher = mock.patch("time.time", lambda: real() + shift)
        patcher.start()
        test.addCleanup(patcher.stop)


def seed_market_capacity(engine, *, now=None, symbols=("XAUUSD1",)):
    """Explicit public-cache prerequisite for tests of other trading conditions."""
    now = time.time() if now is None else now
    for symbol in symbols:
        engine.markets[symbol] = {"status": "ok", "checked_at": now,
                                  "capacity_checked_at": {str(v): now for v in range(1, 21)},
                                  "capacities": {str(v): "1000000" for v in range(1, 21)}}


def account(account_id="test", mode="paper"):
    return {"id": account_id, "name": "测试子账户", "mode": mode, "env_prefix": "ASTER_" + account_id.upper(),
            "enabled": True, "policy": {**DEFAULT_POLICY, "symbols": ["XAUUSD1"]}}


class Fixture:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.directory.name) / "state.sqlite3")
        self.account = account()
        self.store.save_account(self.account)
        self.market = DemoMarket()
        self.broker = PaperBroker("test", self.market, self.store)

    def close(self):
        self.directory.cleanup()


def live_snapshot(live, read):
    """Stamp a fixture account read the way LiveBroker.snapshot does."""
    def snapshot(symbols, **kwargs):
        result = read(symbols, **kwargs)
        result.account_read_generation = live._snapshot_generation
        return result
    return snapshot

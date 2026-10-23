"""Deterministic scheduler harness shared by engine scheduling tests."""
from contextlib import ExitStack
from copy import deepcopy
from fractions import Fraction
from unittest.mock import Mock, patch

from trading.depth import DepthSnapshot
from trading.engine import Engine
from trading.exchange import MarketData
from trading.models import Book, dec


SYMBOL = "XAUUSD1"
OTHER = "SPCXUSD1"
WALL = 1_800_000_000


class _Future:
    def __init__(self, value=5, *, done=True, error=None):
        self.value, self.complete, self.error = value, done, error

    def done(self):
        return self.complete

    def result(self):
        if self.error is not None:
            raise self.error
        return self.value


class _Pool:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def submit(self, function, *args, **kwargs):
        result = function(*args, **kwargs)
        return result if isinstance(result, _Future) else _Future(result)


class _SchedulerEvent:
    def __init__(self, harness):
        self.harness = harness
        self.flag = False
        self.set_count = 0

    def clear(self):
        self.flag = False

    def set(self):
        self.flag = True
        self.set_count += 1

    def wait(self, timeout):
        run = self.harness
        run.iteration += 1
        try:
            if run.iteration > 16:
                raise AssertionError("deterministic scheduler did not stop")
            run.control(run.iteration)
        except BaseException as exc:
            run.failure = exc
            run.engine.shutdown.set()
        return self.flag


class _Harness:
    """Run the real scheduler with controlled futures and no thread or network."""

    def __init__(self, fixture):
        self.fixture = fixture
        self.ticks = 100
        self.iteration = 0
        self.failure = None
        self.calls = []
        self.timing = {"test": {"interval": 30, "gap": 30}}
        self.on_submit = lambda aid: _Future()
        self.control = lambda iteration: self.engine.shutdown.set()
        self.quote = Mock(spec=["book", "start", "close", "set_update_listener"])
        self.depth = Mock(spec=["snapshot", "start", "close", "set_update_listener"])
        self.api = Mock()
        self.market = MarketData(api=self.api, stream=self.quote, depth_stream=self.depth)
        self.market.rules = fixture.market.rules
        row = deepcopy(fixture.account)
        row["policy"]["symbols"] = [OTHER]
        fixture.store.save_account(row)
        self.engine = Engine(fixture.store, market=self.market)
        self.engine.ready = True
        self.event = _SchedulerEvent(self)
        self.engine.scheduler_event = self.event
        self.refresh()

    @property
    def wall(self):
        return WALL + self.ticks - 100

    def refresh(self):
        self.engine.markets[SYMBOL] = {"status": "ok", "checked_at": self.wall, "capacities": {"5": "1000000"}}
        self.engine.view("test", snapshot={"timestamp": self.wall, "positions": [{"symbol": SYMBOL, "leverage": 5}]})
        self.quote.book.return_value = Book(dec("100"), dec("100"), dec("1000"), dec("1000"), dec("100"), self.wall)
        self.depth.snapshot.return_value = DepthSnapshot(((Fraction(100), Fraction(1000)),),
            ((Fraction(100), Fraction(1000)),), self.wall)

    def submit_account(self, aid):
        if any(call["aid"] == aid and not call["future"].done() for call in self.calls):
            raise AssertionError("overlapping workers for one account")
        future = self.on_submit(aid)
        self.calls.append({"aid": aid, "at": self.ticks,
                           "priority": deepcopy(self.engine.work(aid).active_signals), "future": future})
        return future

    def run(self, control):
        self.control = control
        with ExitStack() as stack:
            stack.enter_context(patch("trading.engine.ThreadPoolExecutor", return_value=_Pool()))
            stack.enter_context(patch("trading.engine.time.monotonic", side_effect=lambda: self.ticks))
            stack.enter_context(patch("trading.engine.time.time", side_effect=lambda: self.wall))
            stack.enter_context(patch.object(self.engine, "scheduling", return_value=self.timing))
            stack.enter_context(patch.object(self.engine, "tick_account", side_effect=self.submit_account))
            # Keep the independent listing feed out of quote/execution request
            # assertions, just like the other background market pollers below.
            if self.engine.listing_monitor is not None:
                stack.enter_context(patch.object(self.engine.listing_monitor, "poll", return_value=60))
            for name in ("poll_market", "poll_book", "poll_depth", "notify"):
                stack.enter_context(patch.object(self.engine, name, return_value=60))
            self.engine.run()
        if self.failure is not None:
            raise self.failure

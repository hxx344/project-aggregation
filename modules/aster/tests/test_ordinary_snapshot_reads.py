"""Signed ordinary account reads and shared budget priority, using public fixture keys and no exchange."""
from concurrent.futures import ThreadPoolExecutor
import copy
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from eth_account import Account
import httpx

from trading.exchange import API, BudgetWait, LiveBroker, RateBudget
from trading.models import TradingError
from trading.paper import DemoMarket
from .test_exchange_hardening import FixtureAPI, account_responses


SYMBOL = "XAUUSD1"
DUAL = "/fapi/v3/positionSide/dual"
MULTI = "/fapi/v3/multiAssetsMargin"
ACCOUNT = "/fapi/v3/accountWithJoinMargin"
POSITIONS = "/fapi/v3/positionRisk"
BRACKET = "/fapi/v3/leverageBracket"


class OrdinarySnapshotReadTests(unittest.TestCase):
    def make_broker(self, *, responses=None):
        responses = account_responses() if responses is None else responses
        # Deterministic public signing fixture; never a funded credential.
        private_key = bytes(range(1, 33))
        credentials = {"private_key": private_key, "signer": Account.from_key(private_key).address,
                       "user": "0x" + "22" * 20}
        observed = SimpleNamespace(requests=[], lock=threading.Lock(), active=0, peak=0)

        def handle(request):
            with observed.lock:
                observed.requests.append(request)
                observed.active += 1
                observed.peak = max(observed.peak, observed.active)
            try:
                value = copy.deepcopy(responses[request.url.path])
                if request.url.path == BRACKET and isinstance(value, dict):
                    value["symbol"] = request.url.params["symbol"]
                return httpx.Response(200, json=value)
            finally:
                with observed.lock:
                    observed.active -= 1

        api = API(credentials, transport=httpx.MockTransport(handle), budget=RateBudget())
        self.addCleanup(api.close)
        return LiveBroker(credentials, DemoMarket(), api=api), observed

    def test_ordinary_snapshot_remains_sequential_and_does_not_query_orders(self):
        broker, observed = self.make_broker()
        snapshot = broker.snapshot([SYMBOL], fresh_modes=True)
        self.assertIsNone(snapshot.open_orders)
        self.assertEqual(observed.peak, 1)
        self.assertEqual([request.url.path for request in observed.requests], [DUAL, MULTI, ACCOUNT, POSITIONS, BRACKET])
        self.assertTrue(all(request.method == "GET" for request in observed.requests))

    def test_slow_ordinary_round_is_aged_from_its_first_request(self):
        wall = SimpleNamespace(now=1000.0)
        api = FixtureAPI(account_responses())
        original = api.call
        def call(method, path, *args, **kwargs):
            if path == BRACKET:
                wall.now = 1009.0
            return original(method, path, *args, **kwargs)
        api.call = call
        broker = LiveBroker({}, DemoMarket(), api=api)
        with patch("trading.exchange.time.time", side_effect=lambda: wall.now):
            snapshot = broker.snapshot([SYMBOL], fresh_modes=True)
        self.assertEqual(snapshot.timestamp, 1000.0)
        with patch("trading.models.time.time", return_value=1009.0), \
             self.assertRaisesRegex(TradingError, "快照已过期"):
            snapshot.require_fresh()

    def test_invalid_account_responses_never_publish_leverage_token(self):
        for path, change in ((MULTI, lambda value: []),
                             (ACCOUNT, lambda value: {**value, "assets": value["assets"] * 2}),
                             (ACCOUNT, lambda value: {**value, "positions": [{**value["positions"][0], "positionSide": "BOTH"},
                                                                             value["positions"][1]]})):
            with self.subTest(path=path):
                responses = account_responses()
                responses[path] = change(responses[path])
                broker, observed = self.make_broker(responses=responses)
                with self.assertRaises(TradingError):
                    broker.snapshot([SYMBOL], fresh_modes=True)
                self.assertIsNone(broker.leverage_snapshot)
                self.assertEqual(observed.active, 0)
                self.assertTrue(all(request.method == "GET" for request in observed.requests))

    def test_inherited_priority_does_not_leak_after_worker_exception(self):
        budget = RateBudget(capacity_reserve=180)
        budget.reserve(1320)
        def inherited():
            with budget._inherit_priority((True, False, False, False)):
                budget.reserve(1)
                raise RuntimeError("worker failed")
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.assertRaises(RuntimeError):
                pool.submit(inherited).result()
            with self.assertRaises(BudgetWait):
                pool.submit(budget.reserve, 1).result()


if __name__ == "__main__":
    unittest.main()

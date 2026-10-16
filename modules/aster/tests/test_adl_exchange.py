"""ADL evidence uses native all-symbol data and never calls a live exchange."""
from contextlib import contextmanager
import copy
from dataclasses import replace
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from trading.adl_exchange import reduction_rule, reduction_snapshot
from trading.exchange import LiveBroker
from trading.models import MARKET_SYMBOLS, TradingError, dec


ACCOUNT = "/fapi/v3/accountWithJoinMargin"
RISK = "/fapi/v3/positionRisk"
DUAL = "/fapi/v3/positionSide/dual"
ORDERS = "/fapi/v3/openOrders"
INFO = "/fapi/v3/exchangeInfo"


class FakeBudget:
    def __init__(self):
        self.active = False

    @contextmanager
    def reconciliation(self):
        self.active = True
        try:
            yield
        finally:
            self.active = False


class FakeAPI:
    def __init__(self, responses):
        self.responses, self.calls = responses, []
        self.budget = FakeBudget()
        self.credentials = {"user": "wallet-a", "signer": "signer-a"}
        self.on_read = None

    def call(self, method, path, *args, **kwargs):
        self.calls.append((method, path, args, kwargs, self.budget.active))
        if self.on_read:
            self.on_read(path)
        response = self.responses[path]
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


def responses(*, hedge=True):
    side = "LONG" if hedge else "BOTH"
    amount = "1.25" if hedge else "-1.25"
    account = {"symbol": "BTCUSDT", "positionSide": side, "positionAmt": amount,
               "entryPrice": "60000", "leverage": "37", "isolated": True}
    risk = {key: value for key, value in account.items() if key != "isolated"}
    risk.update(markPrice="61000", marginType="isolated")
    return {ACCOUNT: {"canTrade": True, "positions": [account]}, RISK: [risk],
            DUAL: {"dualSidePosition": hedge}, ORDERS: []}


def market_row(symbol="BTCUSDT"):
    return {"symbol": symbol, "quoteAsset": "USDT", "marginAsset": "USDT", "status": "TRADING",
            "orderTypes": ["LIMIT", "MARKET"], "filters": [
                {"filterType": "LOT_SIZE", "minQty": ".002", "maxQty": "20", "stepSize": ".002"},
                {"filterType": "MARKET_LOT_SIZE", "minQty": ".003", "maxQty": "2", "stepSize": ".003"},
                {"filterType": "PRICE_FILTER", "tickSize": ".1"},
                {"filterType": "MIN_NOTIONAL", "notional": "5"}]}


class ReductionSnapshotTests(unittest.TestCase):
    def broker(self, data=None):
        api = FakeAPI(data if data is not None else responses())
        return LiveBroker({}, SimpleNamespace(), api=api), api

    def test_all_symbol_isolated_non_usd1_snapshot_has_no_opening_gates_or_cache_writes(self):
        broker, api = self.broker()
        broker.cached = {"old": "unchanged"}
        broker.cached_at = {"old": 7}
        broker.leverage_snapshot = "unchanged"
        result = reduction_snapshot(broker)
        position, = result.positions
        self.assertEqual((position.symbol, position.position_side, position.side), ("BTCUSDT", "LONG", "LONG"))
        self.assertEqual((position.quantity, position.signed_quantity, position.leverage), (dec("1.25"), dec("1.25"), 37))
        self.assertEqual((position.mark, position.entry), (dec(61000), dec(60000)))
        self.assertNotIn(position.symbol, MARKET_SYMBOLS)
        self.assertEqual(broker.cached, {"old": "unchanged"})
        self.assertEqual(broker.cached_at, {"old": 7})
        self.assertEqual(broker.leverage_snapshot, "unchanged")
        self.assertEqual([call[1] for call in api.calls], [ACCOUNT, RISK, DUAL, ORDERS])
        self.assertEqual([call[3] for call in api.calls], [
            {"signed": True, "weight": 5}, {"signed": True, "weight": 5},
            {"signed": True, "weight": 30}, {"signed": True, "weight": 40}])
        self.assertTrue(all(call[0] == "GET" and not call[2] and call[4] for call in api.calls))
        self.assertFalse(api.budget.active)
        result.require_current(broker)

    def test_both_keeps_execution_side_and_signed_economic_direction(self):
        for amount, direction in (("-1.25", "SHORT"), ("1.25", "LONG")):
            with self.subTest(amount=amount):
                data = responses(hedge=False)
                data[ACCOUNT]["positions"][0]["positionAmt"] = amount
                data[RISK][0]["positionAmt"] = amount
                broker, _ = self.broker(data)
                result = reduction_snapshot(broker)
                position, = result.positions
                self.assertFalse(result.hedge_mode)
                self.assertEqual(position.position_side, "BOTH")
                self.assertEqual(position.side, direction)
                self.assertEqual(position.signed_quantity, dec(amount))
                self.assertEqual(position.quantity, dec("1.25"))

    def test_both_hedge_directions_and_other_symbols_are_retained(self):
        data = responses()
        for symbol, side, amount in (("BTCUSDT", "SHORT", "-.75"), ("ETHUSDC", "LONG", "3")):
            account = {**data[ACCOUNT]["positions"][0], "symbol": symbol, "positionSide": side, "positionAmt": amount}
            risk = {**data[RISK][0], "symbol": symbol, "positionSide": side, "positionAmt": amount}
            data[ACCOUNT]["positions"].append(account)
            data[RISK].append(risk)
        broker, _ = self.broker(data)
        actual = reduction_snapshot(broker).positions
        self.assertEqual([(p.symbol, p.side, p.quantity) for p in actual], [
            ("BTCUSDT", "LONG", dec("1.25")), ("BTCUSDT", "SHORT", dec(".75")), ("ETHUSDC", "LONG", dec(3))])

    def test_flat_rows_can_be_omitted_but_missing_nonzero_or_different_quantity_is_unknown(self):
        data = responses()
        data[ACCOUNT]["positions"].append({"symbol": "XAGUSD1", "positionSide": "SHORT", "positionAmt": "0"})
        broker, _ = self.broker(data)
        self.assertEqual(len(reduction_snapshot(broker).positions), 1)
        for change in (lambda d: d[RISK].clear(), lambda d: d[ACCOUNT]["positions"].clear(),
                       lambda d: d[RISK][0].update(positionAmt="1.24")):
            with self.subTest(change=change):
                data = responses()
                change(data)
                broker, _ = self.broker(data)
                with self.assertRaisesRegex(TradingError, "尚未同步"):
                    reduction_snapshot(broker)

    def test_empty_complete_responses_prove_flat_and_disabled_trading_stays_explicit(self):
        data = responses()
        data[ACCOUNT] = {"canTrade": False, "positions": []}
        data[RISK] = []
        broker, _ = self.broker(data)
        result = reduction_snapshot(broker)
        self.assertEqual(result.positions, ())
        self.assertEqual(result.open_orders, [])
        self.assertFalse(result.can_trade)

    def test_missing_envelopes_and_malformed_rows_never_become_empty(self):
        mutations = (
            lambda d: d.update({ACCOUNT: {"canTrade": True}}),
            lambda d: d[ACCOUNT].pop("canTrade"),
            lambda d: d.update({RISK: {"positions": []}}),
            lambda d: d.update({ORDERS: {"orders": []}}),
            lambda d: d.update({DUAL: {"dualSidePosition": "true"}}),
            lambda d: d[RISK][0].pop("positionAmt"),
            lambda d: d[RISK][0].update(positionAmt="NaN"),
            lambda d: d[RISK][0].update(markPrice="0"),
            lambda d: d[RISK][0].update(entryPrice="-1"),
            lambda d: d[RISK][0].update(leverage="1.5"),
            lambda d: d[RISK][0].update(marginType="unknown"),
            lambda d: d[ACCOUNT]["positions"][0].update(isolated="true"),
            lambda d: d[RISK].append(dict(d[RISK][0])),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                data = responses()
                mutate(data)
                broker, _ = self.broker(data)
                with self.assertRaises(TradingError):
                    reduction_snapshot(broker)

    def test_mode_conflict_including_flat_unrelated_rows_and_signed_hedge_mismatch_rejects(self):
        for hedge, side, amount in ((True, "BOTH", "0"), (False, "LONG", "0"),
                                    (True, "SHORT", "1"), (True, "LONG", "-1")):
            with self.subTest(hedge=hedge, side=side, amount=amount):
                data = responses(hedge=hedge)
                data[RISK].append({"symbol": "OTHERUSDT", "positionSide": side, "positionAmt": amount})
                broker, _ = self.broker(data)
                with self.assertRaisesRegex(TradingError, "方向"):
                    reduction_snapshot(broker)

    def test_entire_order_rows_are_verified_and_copied(self):
        data = responses()
        data[ORDERS] = [{"symbol": "ETHUSDT", "clientOrderId": "other-order", "orderId": 7,
                         "side": "BUY", "positionSide": "LONG", "status": "NEW",
                         "origQty": "1", "executedQty": "0"}]
        broker, _ = self.broker(data)
        result = reduction_snapshot(broker)
        self.assertEqual(result.open_orders, data[ORDERS])
        result.open_orders[0]["symbol"] = "CHANGED"
        self.assertEqual(data[ORDERS][0]["symbol"], "ETHUSDT")
        for field, value in (("symbol", None), ("clientOrderId", None), ("orderId", "0"),
                             ("positionSide", "BOTH"), ("status", "FILLED"), ("executedQty", "2")):
            with self.subTest(field=field):
                bad = copy.deepcopy(data)
                bad[ORDERS][0][field] = value
                broker, _ = self.broker(bad)
                with self.assertRaises(TradingError):
                    reduction_snapshot(broker)

    def test_account_event_during_each_read_invalidates_whole_result(self):
        for market_only in (False, True):
            for path in (ACCOUNT, RISK, DUAL) + (() if market_only else (ORDERS,)):
                with self.subTest(market_only=market_only, path=path):
                    broker, api = self.broker()
                    def event(current):
                        if current == path:
                            broker._snapshot_generation += 1
                    api.on_read = event
                    with self.assertRaisesRegex(TradingError, "发生变化"):
                        reduction_snapshot(broker, market_only=market_only)

    def test_market_only_skips_order_inventory_and_preserves_complete_position_evidence(self):
        for orders in (None, {"invalid": "orders"}, [{"symbol": "OTHERUSDT"}]):
            with self.subTest(orders=orders):
                data = responses()
                data[ORDERS] = orders
                data[RISK][0]["updateTime"] = 1234567
                broker, api = self.broker(data)
                result = reduction_snapshot(broker, market_only=True)
                self.assertEqual([call[1] for call in api.calls], [ACCOUNT, RISK, DUAL])
                self.assertEqual(sum(call[3]["weight"] for call in api.calls), 40)
                self.assertEqual(result.open_orders, [])
                self.assertEqual(result.position_updates, {("BTCUSDT", "LONG"): 1234.567})
                self.assertEqual(result.positions[0].quantity, dec("1.25"))
                self.assertEqual(result.positions[0].leverage, 37)
                result.require_current(broker)
                with self.assertRaises(TradingError):
                    reduction_snapshot(broker)

    def test_market_only_still_rejects_incomplete_or_conflicting_account_evidence(self):
        for mutate in (lambda d: d[ACCOUNT].pop("canTrade"),
                       lambda d: d[ACCOUNT].pop("positions"),
                       lambda d: d.update({RISK: []}),
                       lambda d: d[DUAL].update(dualSidePosition="true"),
                       lambda d: d[RISK][0].update(positionAmt="1.24"),
                       lambda d: d[RISK][0].update(updateTime="NaN"),
                       lambda d: d[RISK][0].update(marginType="unknown")):
            with self.subTest(mutation=mutate):
                data = responses()
                mutate(data)
                broker, _ = self.broker(data)
                with self.assertRaises(TradingError):
                    reduction_snapshot(broker, market_only=True)

    def test_exchange_position_updates_include_explicit_flat_legs_only(self):
        data = responses()
        data[RISK][0]["updateTime"] = 1234567
        data[RISK].append({"symbol": "ETHUSDT", "positionSide": "SHORT", "positionAmt": "0", "updateTime": 1234500})
        data[ACCOUNT]["positions"].append({"symbol": "OTHERUSDT", "positionSide": "LONG", "positionAmt": "0", "updateTime": 9999999})
        broker, _ = self.broker(data)
        result = reduction_snapshot(broker)
        self.assertEqual(result.position_updates, {("BTCUSDT", "LONG"): 1234.567, ("ETHUSDT", "SHORT"): 1234.5})
        self.assertEqual(len(result.positions), 1)
        # The account-only zero row is no substitute for positionRisk evidence.
        self.assertNotIn(("OTHERUSDT", "LONG"), result.position_updates)

    def test_missing_or_zero_exchange_update_never_uses_local_read_time(self):
        broker, api = self.broker()
        self.assertEqual(reduction_snapshot(broker).position_updates, {})
        api.responses[RISK][0]["updateTime"] = 0
        result = reduction_snapshot(broker)
        self.assertEqual(result.position_updates, {("BTCUSDT", "LONG"): 0})
        self.assertGreater(result.timestamp, 0)

    def test_invalid_exchange_position_update_is_not_reconciliation_evidence(self):
        for value in (None, True, "NaN", "-1", "1.2", "99999999999999999"):
            with self.subTest(value=value):
                data = responses()
                data[RISK][0]["updateTime"] = value
                broker, _ = self.broker(data)
                with self.assertRaises(TradingError):
                    reduction_snapshot(broker)

    def test_oldest_read_owns_freshness_and_post_read_identity_generation_are_checked(self):
        for market_only in (False, True):
            with self.subTest(market_only=market_only):
                broker, api = self.broker()
                with patch("trading.adl_exchange.time.time", side_effect=[100, 109, 109]):
                    with self.assertRaisesRegex(TradingError, "过期"):
                        reduction_snapshot(broker, market_only=market_only)
                result = reduction_snapshot(broker, market_only=market_only)
                for stamp in (result.timestamp - 10, result.timestamp + 10, float("nan")):
                    with self.subTest(timestamp=stamp), self.assertRaises(TradingError):
                        replace(result, timestamp=stamp).require_current(broker)
                broker._snapshot_generation += 1
                with self.assertRaises(TradingError):
                    result.require_current(broker)
                broker._snapshot_generation -= 1
                api.credentials["user"] = "different-wallet"
                with self.assertRaises(TradingError):
                    result.require_current(broker)
                api.credentials["user"] = "wallet-a"
                other, _ = self.broker()
                with self.assertRaises(TradingError):
                    result.require_current(other)
                broker.api = FakeAPI(responses())
                with self.assertRaises(TradingError):
                    result.require_current(broker)


class ReductionRuleTests(unittest.TestCase):
    def market(self, data=None):
        api = FakeAPI({INFO: {"symbols": [market_row()]} if data is None else data})
        return SimpleNamespace(api=api, rules={"XAUUSD1": "ordinary-rule"}, assets={"XAUUSD1": "USD1"}), api

    def test_native_rule_intersects_market_filters_and_keeps_strategy_universe_unchanged(self):
        market, api = self.market()
        rule = reduction_rule(market, "BTCUSDT")
        self.assertEqual((rule.symbol, rule.quote_asset, rule.margin_asset), ("BTCUSDT", "USDT", "USDT"))
        self.assertEqual((rule.step, rule.min_qty, rule.max_qty), (dec(".006"), dec(".006"), dec(2)))
        self.assertEqual((rule.tick, rule.min_notional), (dec(".1"), dec(5)))
        self.assertEqual(market.rules, {"XAUUSD1": "ordinary-rule"})
        self.assertEqual(market.assets, {"XAUUSD1": "USD1"})
        self.assertNotIn("BTCUSDT", MARKET_SYMBOLS)
        self.assertTrue(api.calls[0][4])
        self.assertIs(reduction_rule(market, "BTCUSDT"), rule)
        self.assertEqual(len(api.calls), 1)

    def test_cached_rules_expire_without_stale_fallback_or_renewed_timestamp(self):
        market, api = self.market()
        with patch("trading.adl_exchange.time.monotonic", return_value=100):
            reduction_rule(market, "BTCUSDT")
        api.responses[INFO]["symbols"][0]["status"] = "BREAK"
        with patch("trading.adl_exchange.time.monotonic", return_value=159):
            reduction_rule(market, "BTCUSDT")
        with patch("trading.adl_exchange.time.monotonic", return_value=160):
            with self.assertRaises(TradingError):
                reduction_rule(market, "BTCUSDT")
        self.assertEqual(len(api.calls), 2)
        self.assertEqual(market._adl_rule_cache["BTCUSDT"][0], 100)

    def test_missing_invalid_or_delisted_rules_do_not_enter_cache(self):
        mutations = (
            lambda d: d.pop("symbols"),
            lambda d: d.update(symbols=[]),
            lambda d: d["symbols"].append(copy.deepcopy(d["symbols"][0])),
            lambda d: d["symbols"][0].update(symbol="ETHUSDT"),
            lambda d: d["symbols"][0].update(status="BREAK"),
            lambda d: d["symbols"][0].pop("quoteAsset"),
            lambda d: d["symbols"][0].pop("marginAsset"),
            lambda d: d["symbols"][0].pop("orderTypes"),
            lambda d: d["symbols"][0].update(orderTypes=["LIMIT"]),
            lambda d: d["symbols"][0].update(filters=[]),
            lambda d: d["symbols"][0]["filters"][0].pop("stepSize"),
            lambda d: d["symbols"][0]["filters"][1].update(maxQty="0.001"),
        )
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                data = {"symbols": [market_row()]}
                mutate(data)
                market, _ = self.market(data)
                with self.assertRaises(TradingError):
                    reduction_rule(market, "BTCUSDT")
                self.assertEqual(market._adl_rule_cache, {})

    def test_replaced_api_and_slow_fetch_cannot_reuse_rule(self):
        market, api = self.market()
        reduction_rule(market, "BTCUSDT")
        replacement = FakeAPI({INFO: {"symbols": [market_row()]}})
        market.api = replacement
        reduction_rule(market, "BTCUSDT")
        self.assertEqual(len(replacement.calls), 1)
        fresh, _ = self.market()
        with patch("trading.adl_exchange.time.monotonic", side_effect=[100, 161]):
            with self.assertRaisesRegex(TradingError, "失效"):
                reduction_rule(fresh, "BTCUSDT")
        self.assertEqual(fresh._adl_rule_cache, {})


if __name__ == "__main__":
    unittest.main()

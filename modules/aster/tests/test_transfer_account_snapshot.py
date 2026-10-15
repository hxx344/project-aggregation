"""Transfer balances are independent of position/trading readiness evidence."""
import copy
import time
from unittest import TestCase
from unittest.mock import patch

from tests.test_exchange_hardening import FixtureAPI
from trading.exchange import LiveBroker, SnapshotSuperseded
from trading.models import AccountModeError, TradingError, dec


ACCOUNT = "/fapi/v3/accountWithJoinMargin"
SYMBOL = "XAUUSD1"


def account_response():
    return {"canTrade": True, "assets": [{"asset": "USD1", "walletBalance": "200",
        "unrealizedProfit": "-25", "marginBalance": "175", "availableBalance": "140",
        "maintMargin": "5", "maxWithdrawAmount": "130"}]}


class UnusedMarket:
    def __getattribute__(self, name):
        raise AssertionError("Transfer read must not access market data: " + name)


class TransferAccountSnapshotTests(TestCase):
    def broker(self, account=None):
        api = FixtureAPI({ACCOUNT: account_response() if account is None else account})
        return LiveBroker({}, UnusedMarket(), api=api), api

    def test_no_argument_read_uses_only_one_signed_account_get_with_weight_five(self):
        broker, api = self.broker()
        before = time.time()
        snapshot = broker.transfer_snapshot()
        self.assertEqual(api.calls, [("GET", ACCOUNT, (), {"signed": True, "weight": 5})])
        self.assertEqual((snapshot.wallet, snapshot.equity, snapshot.available, snapshot.unrealized,
                          snapshot.maintenance, snapshot.transfer_withdrawable),
                         tuple(map(dec, (200, 175, 140, -25, 5, 130))))
        self.assertLessEqual(before, snapshot.timestamp)
        self.assertLessEqual(snapshot.timestamp, time.time())
        self.assertEqual(snapshot.account_read_generation, broker._snapshot_generation)
        broker.require_snapshot_current(snapshot)

    def test_estimate_is_constant_and_does_not_read_or_change_broker_state(self):
        broker, api = self.broker()
        marker = broker.leverage_snapshot = object()
        self.assertEqual(broker.transfer_snapshot_weight(), 5)
        self.assertEqual(api.calls, [])
        self.assertIs(broker.leverage_snapshot, marker)
        broker.transfer_snapshot()
        self.assertEqual(broker.transfer_snapshot_weight(), 5)
        self.assertEqual(len(api.calls), 1)

    def test_unknown_symbols_one_way_isolated_and_malformed_positions_do_not_block_balances(self):
        variants = (None, {}, "invalid positions", [None],
            [{"symbol": "UNLISTED", "positionSide": "BOTH", "positionAmt": "10", "isolated": True}],
            [{"symbol": "XAGUSD1", "positionSide": "LONG", "positionAmt": "4", "isolated": True},
             {"symbol": "BTCUSDT", "positionSide": "SHORT", "positionAmt": "3"}])
        for positions in variants:
            with self.subTest(positions=positions):
                account = account_response()
                account["positions"] = positions
                broker, api = self.broker(account)
                snapshot = broker.transfer_snapshot()
                self.assertEqual(snapshot.available, dec(140))
                self.assertEqual(snapshot.positions, [])
                self.assertEqual(len(api.calls), 1)

    def test_total_and_cross_wallet_pnl_are_never_mixed(self):
        account = account_response()
        asset = account["assets"][0]
        asset.update(crossWalletBalance="150", crossUnPnl="10")
        broker, _ = self.broker(account)
        self.assertEqual(broker.transfer_snapshot().equity, dec(175))
        del asset["marginBalance"]
        self.assertEqual(broker.transfer_snapshot().equity, dec(175))
        self.assertEqual(LiveBroker._transfer_wallet_equity(asset), (dec(200), dec(-25), dec(175)))
        del asset["walletBalance"]
        del asset["unrealizedProfit"]
        snapshot = broker.transfer_snapshot()
        self.assertEqual((snapshot.wallet, snapshot.equity, snapshot.unrealized),
                         (dec(150), dec(160), dec(10)))
        self.assertEqual(LiveBroker._transfer_wallet_equity(asset), (dec(150), dec(10), dec(160)))
        for cross in ({}, {"crossWalletBalance": "150", "crossUnPnl": "10"}):
            with self.subTest(cross_fields=bool(cross)):
                account = account_response()
                asset = account["assets"][0]
                del asset["marginBalance"]
                asset.update(walletBalance="200.00000000000000000000000001",
                             unrealizedProfit="-25.00000000000000000000000002", **cross)
                expected = tuple(map(dec, ("200.00000000000000000000000001",
                    "-25.00000000000000000000000002", "174.99999999999999999999999999")))
                self.assertEqual(LiveBroker._transfer_wallet_equity(asset), expected)
                broker, _ = self.broker(account)
                snapshot = broker.transfer_snapshot()
                self.assertEqual((snapshot.wallet, snapshot.unrealized, snapshot.equity), expected)

    def test_explicit_equity_can_supply_missing_pnl_without_a_zero_default(self):
        account = account_response()
        del account["assets"][0]["unrealizedProfit"]
        broker, _ = self.broker(account)
        snapshot = broker.transfer_snapshot()
        self.assertEqual(snapshot.unrealized, dec(-25))
        account["assets"][0]["unrealizedProfit"] = None
        with self.assertRaisesRegex(TradingError, "unrealizedProfit"):
            broker.transfer_snapshot()

    def test_missing_wallet_or_missing_equity_and_matching_pnl_fails_explicitly(self):
        account = account_response()
        del account["assets"][0]["walletBalance"]
        broker, _ = self.broker(account)
        with self.assertRaisesRegex(TradingError, "crossWalletBalance"):
            broker.transfer_snapshot()
        account = account_response()
        for field in ("marginBalance", "unrealizedProfit"):
            del account["assets"][0][field]
        account["assets"][0]["crossUnPnl"] = "0"
        broker, _ = self.broker(account)
        with self.assertRaisesRegex(TradingError, "unrealizedProfit"):
            broker.transfer_snapshot()

    def test_missing_duplicate_or_malformed_usd1_assets_fail(self):
        for assets in (None, {}, [], [{"asset": "USDT"}], [None],
                       account_response()["assets"] * 2):
            with self.subTest(assets=assets):
                broker, _ = self.broker({"assets": assets})
                with self.assertRaises(TradingError):
                    broker.transfer_snapshot()

    def test_required_amounts_reject_missing_nonfinite_boolean_and_malformed_values(self):
        fields = ("walletBalance", "marginBalance", "availableBalance", "unrealizedProfit",
                  "maintMargin", "maxWithdrawAmount")
        for field in fields:
            for value in (None, "NaN", "Infinity", "-Infinity", True, False, "private-invalid-value"):
                with self.subTest(field=field, value=value):
                    account = account_response()
                    account["assets"][0][field] = value
                    broker, _ = self.broker(account)
                    with self.assertRaisesRegex(TradingError, field) as error:
                        broker.transfer_snapshot()
                    self.assertNotIn("private-invalid-value", str(error.exception))
        for field in ("availableBalance", "maintMargin", "maxWithdrawAmount"):
            with self.subTest(missing=field):
                account = account_response()
                del account["assets"][0][field]
                broker, _ = self.broker(account)
                with self.assertRaisesRegex(TradingError, field):
                    broker.transfer_snapshot()

    def test_withdrawal_and_maintenance_limits_are_nonnegative_and_zero_is_valid(self):
        for field in ("maxWithdrawAmount", "maintMargin"):
            account = account_response()
            account["assets"][0][field] = "-1"
            broker, _ = self.broker(account)
            with self.assertRaisesRegex(TradingError, field + ".*非负"):
                broker.transfer_snapshot()
        account = account_response()
        account["assets"][0].update(maxWithdrawAmount="0", maintMargin="0", availableBalance="-1")
        broker, _ = self.broker(account)
        snapshot = broker.transfer_snapshot()
        self.assertEqual(snapshot.transfer_withdrawable, 0)
        self.assertEqual(snapshot.maintenance, 0)
        self.assertEqual(snapshot.available, -1)

    def test_snapshot_never_claims_modes_open_orders_or_trading_readiness(self):
        broker, _ = self.broker()
        snapshot = broker.transfer_snapshot()
        self.assertTrue(snapshot.can_trade)
        self.assertEqual(snapshot.positions, [])
        self.assertIsNone(snapshot.open_orders)
        self.assertIsNone(snapshot.hedge_mode)
        self.assertIsNone(snapshot.multi_assets)
        self.assertEqual(snapshot.brackets, {})
        self.assertEqual(snapshot.current_leverage_caps, {})
        with self.assertRaises(AccountModeError):
            snapshot.require_ready(SYMBOL)
        broker.api.responses[ACCOUNT]["canTrade"] = False
        self.assertFalse(broker.transfer_snapshot().can_trade)

    def test_transfer_read_revokes_leverage_authority_even_when_it_fails(self):
        broker, _ = self.broker()
        for response in (account_response(), TradingError("account unavailable")):
            broker.leverage_snapshot = (object(), time.monotonic())
            broker.api.responses[ACCOUNT] = response
            if isinstance(response, Exception):
                with self.assertRaises(TradingError):
                    broker.transfer_snapshot()
            else:
                broker.transfer_snapshot()
            self.assertIsNone(broker.leverage_snapshot)

    def test_leverage_paths_must_obtain_separate_trading_evidence(self):
        broker, api = self.broker()
        snapshot = broker.transfer_snapshot()
        for setter, reader in ((broker.set_leverage, "snapshot"), (broker.set_cycle_leverage, "cycle_snapshot")):
            with self.subTest(setter=setter.__name__), patch.object(broker, reader,
                    side_effect=TradingError("separate trading evidence required")) as trading_read:
                with self.assertRaisesRegex(TradingError, "separate trading evidence"):
                    setter(SYMBOL, 10, checked_snapshot=snapshot)
                trading_read.assert_called_once()
        self.assertTrue(all(call[0] == "GET" for call in api.calls))

    def test_account_event_during_read_revokes_the_result(self):
        for event in ("ACCOUNT_UPDATE", "ORDER_TRADE_UPDATE", "ACCOUNT_CONFIG_UPDATE"):
            with self.subTest(event=event):
                broker, api = self.broker()
                original = api.call

                def changed(*args, **kwargs):
                    result = original(*args, **kwargs)
                    broker._cycle_account_event(event)
                    return result

                with patch.object(api, "call", side_effect=changed):
                    with self.assertRaises(SnapshotSuperseded):
                        broker.transfer_snapshot()
                self.assertIsNone(broker.leverage_snapshot)

    def test_events_after_read_revoke_currentness_and_another_read_does_not_restore_it(self):
        broker, _ = self.broker()
        snapshot = broker.transfer_snapshot()
        broker._cycle_account_event("ACCOUNT_UPDATE")
        latest = broker.transfer_snapshot()
        broker.require_snapshot_current(latest)
        with self.assertRaisesRegex(TradingError, "失效"):
            broker.require_snapshot_current(snapshot)

    def test_old_or_future_snapshots_and_slow_reads_cannot_pass_freshness(self):
        broker, api = self.broker()
        snapshot = broker.transfer_snapshot()
        for offset in (-9, 2):
            with self.subTest(offset=offset):
                changed = copy.copy(snapshot)
                changed.timestamp = time.time() + offset
                with self.assertRaisesRegex(TradingError, "过期"):
                    broker.require_snapshot_current(changed)
        with patch("trading.exchange.time.time", side_effect=[100, 109]):
            with self.assertRaisesRegex(TradingError, "过期"):
                broker.transfer_snapshot()
        self.assertIsNone(broker.leverage_snapshot)
        self.assertTrue(all(call[0] == "GET" for call in api.calls))

"""Unmanaged holdings retain their account risk without becoming pair legs."""
from dataclasses import replace
from fractions import Fraction
import time
from unittest import TestCase

from trading.models import AccountSnapshot, Book, Position, dec
from trading.pair_planning import positions, resource_gate
from trading.pairing import validate_pair


SYMBOL = "XAUUSD1"


class PairPositionScopeTests(TestCase):
    def setUp(self):
        self.pair = validate_pair({"id": "gold", "name": "Gold", "long_account_id": "long",
                                  "short_account_id": "short", "ordinary": {"enabled": True}})
        self.book = Book(dec(100), dec(100), dec(100), dec(100), dec(100), time.time())

    def snapshots(self):
        return {key: AccountSnapshot(dec(10000), dec(0), dec(10000), dec(10000), dec(0),
                    [Position(SYMBOL, side, dec(2 if side == key.upper() else 0), dec(100), dec(100), 5)
                     for side in ("LONG", "SHORT")], [], True, False, True, time.time(),
                    fees={SYMBOL: dec(0)}, current_leverage_caps={SYMBOL: (5, dec(100000))})
                for key in ("long", "short")}

    def other(self, snapshot, side, quantity, *, symbol=SYMBOL):
        position = Position(symbol, side, dec(quantity), dec(100), dec(100), 5)
        snapshot.positions = [p for p in snapshot.positions if (p.symbol, p.side) != (symbol, side)] + [position]

    def test_position_selection_keeps_other_holdings_in_the_account_snapshot(self):
        snapshots = self.snapshots()
        self.other(snapshots["long"], "SHORT", 16)
        self.other(snapshots["short"], "LONG", 17, symbol="XAGUSD1")
        held = positions(snapshots, SYMBOL)
        self.assertEqual({side: row.qty for side, row in held.items()}, {"LONG": dec(2), "SHORT": dec(2)})
        self.assertEqual(snapshots["long"].occupied_margin_exact, Fraction(360))
        self.assertEqual(snapshots["short"].occupied_margin_exact, Fraction(380))

    def test_opposite_holdings_consume_each_accounts_gross_symbol_cap(self):
        for key, other_side in (("long", "SHORT"), ("short", "LONG")):
            with self.subTest(account=key):
                snapshots = self.snapshots()
                self.other(snapshots[key], other_side, 16)
                snapshots[key].current_leverage_caps[SYMBOL] = (5, dec(2000))
                gate = resource_gate(self.pair, snapshots, self.book)
                self.assertTrue(gate(Fraction(2), Fraction(200), Fraction(200), Fraction(100)))
                quantity = Fraction("2.000000000000000000000001")
                self.assertFalse(gate(quantity, quantity * 100, quantity * 100, Fraction(100)))

    def test_other_symbols_still_consume_the_account_margin_budget(self):
        for key in ("long", "short"):
            with self.subTest(account=key):
                snapshots = self.snapshots()
                snapshots[key].equity = snapshots[key].available = dec(1000)
                self.other(snapshots[key], "LONG", 24, symbol="XAGUSD1")
                gate = resource_gate(self.pair, snapshots, self.book)
                self.assertFalse(gate(Fraction(1), Fraction(100), Fraction(100), Fraction(100)))

    def test_opposite_mark_losses_and_occupied_margin_are_revalued_without_netting(self):
        self.pair["ordinary"]["margin_limit"] = "1"
        for key, other_side, mark, required in (("long", "SHORT", 110, 142), ("short", "LONG", 90, 120)):
            with self.subTest(account=key):
                snapshots = self.snapshots()
                self.other(snapshots[key], key.upper(), 0)
                self.other(snapshots[key], other_side, 10)
                book = replace(self.book, bid=dec(mark), ask=dec(mark), mark=dec(mark))
                snapshots[key].available = dec(required)
                gate = resource_gate(self.pair, snapshots, book)
                self.assertTrue(gate(Fraction(1), Fraction(mark), Fraction(mark), Fraction(mark)))
                snapshots[key].available -= dec("0.00000001")
                self.assertFalse(gate(Fraction(1), Fraction(mark), Fraction(mark), Fraction(mark)))

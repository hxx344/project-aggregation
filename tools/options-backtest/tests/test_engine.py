"""Engine, spec and report tests on a synthetic Black-76 market (standard library only)."""
import contextlib
import io
import json
import math
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optbt import engine, report, spec as specs  # noqa: E402
from optbt.engine import Quote  # noqa: E402
from optbt.pricing import black, payoff  # noqa: E402

FRIDAY_21 = int(datetime(2024, 1, 5, 21, tzinfo=timezone.utc).timestamp() // 3600)
SATURDAY_08, SUNDAY_08 = FRIDAY_21 + 11, FRIDAY_21 + 35
NEXT_FRIDAY_08 = SUNDAY_08 + 5 * 24


class FakeMarket:
    """Flat-IV chains around a forward path; bid/ask are mark -/+ `spread` of the mark."""

    def __init__(self, forwards, iv=0.5, spread=0.02, settlements=None, perp_offset=0.0, funding_rate=0.0, expiring=False):
        """`iv` is a number or a function of the hour; the perp trades at forward + `perp_offset` and
        charges `funding_rate` every 8 hours (00/08/16 UTC). `expiring` also lists a contract at its
        expiry hour from the 07:59 snapshot, as the parquet market does."""
        self.forwards, self.iv, self.spread = forwards, iv, spread
        self.expiring = expiring
        self.settlements = settlements or {}
        self.perp_offset, self.funding_rate = perp_offset, funding_rate

    def span(self):
        return min(self.forwards), max(self.forwards)

    def _quote(self, hour, expiry, strike, is_call):
        forward, time = self.forwards[hour], hour * 3600 - 60
        iv = self.iv(hour) if callable(self.iv) else self.iv
        mark = black(forward, strike, (expiry * 3600 - time) / (365 * 86400), iv, is_call)[0]
        bid = mark * (1 - self.spread)
        return Quote(expiry, strike, is_call, time, forward, iv, mark, bid, mark * (1 + self.spread))

    def chain(self, hour):
        if hour not in self.forwards:
            return []
        forward = self.forwards[hour]
        strikes = [round(forward / 500) * 500 + 500 * step for step in range(-12, 13)]
        return [self._quote(hour, expiry, strike, is_call) for expiry in (SATURDAY_08, SUNDAY_08, NEXT_FRIDAY_08)
                if self._listed(hour, expiry) for strike in strikes for is_call in (True, False)]

    def _listed(self, hour, expiry):
        return expiry > hour or (self.expiring and expiry == hour)

    def quote(self, hour, expiry, strike, is_call):
        return self._quote(hour, expiry, strike, is_call) if hour in self.forwards and self._listed(hour, expiry) else None

    def settlement(self, expiry):
        return self.settlements.get(expiry)

    def perp(self, hour):
        return self.forwards[hour] + self.perp_offset if hour in self.forwards else None

    def funding(self, after, upto):
        return sum(self.funding_rate * self.perp(hour) for hour in range(after + 1, upto + 1) if hour % 8 == 0 and hour in self.forwards)


def condor(**overrides):
    raw = specs.load("iron_condor")
    raw.update({"start": "2024-01-05", "end": "2024-01-05", **overrides})
    return specs.validate(raw)


def flat(forward=40000.0, hours=range(FRIDAY_21, SUNDAY_08 + 1)):
    return {hour: forward for hour in hours}


class EngineTest(unittest.TestCase):
    def test_live_condor_picks_sunday_expiry_deltas_and_wings(self):
        market = FakeMarket(flat(), settlements={SUNDAY_08: 40000.0})
        position, reason = engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, condor())
        self.assertIsNone(reason)
        self.assertEqual({leg.expiry for leg in position.legs}, {SUNDAY_08})
        chain = [q for q in market.chain(FRIDAY_21) if q.expiry == SUNDAY_08]
        for leg, target in zip(position.legs, (0.45, 0.45, 0.10, 0.10)):
            same_side = [q for q in chain if q.is_call == leg.is_call]
            if leg.sign > 0:
                inner = position.legs[0 if leg.is_call else 1].strike
                same_side = [q for q in same_side if (q.strike > inner if leg.is_call else q.strike < inner)]
            best = min(same_side, key=lambda q: abs(abs(q.delta) - target))
            self.assertEqual(leg.strike, best.strike)
        short_call, short_put, long_call, long_put = position.legs
        self.assertGreater(long_call.strike, short_call.strike)
        self.assertLess(long_put.strike, short_put.strike)

    def test_otm_expiry_keeps_credit_minus_entry_fees(self):
        market = FakeMarket(flat(), settlements={SUNDAY_08: 40000.0})
        spec = condor()
        trades, skipped, _ = engine.run(spec, market)
        self.assertEqual((len(trades), skipped), (1, {}))
        trade = trades[0]
        position, _ = engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, spec)
        short_call, short_put = position.legs[:2]
        self.assertLessEqual(short_put.strike, 40000.0)  # settlement leaves every leg worthless
        self.assertLessEqual(40000.0, short_call.strike)
        quotes = {(q.strike, q.is_call): q for q in market.chain(FRIDAY_21) if q.expiry == SUNDAY_08}
        credit = fees = 0.0
        for leg in position.legs:
            quote = quotes[(leg.strike, leg.is_call)]
            mid = (quote.bid + quote.ask) / 2
            credit -= leg.sign * mid
            fees += min(0.0003 * 40000.0, 0.07 * mid)
        self.assertEqual(trade["reason"], "expiry")
        self.assertAlmostEqual(trade["credit"], credit, places=2)
        self.assertAlmostEqual(trade["pnl"], credit - fees, places=2)
        width = max(position.legs[2].strike - short_call.strike, short_put.strike - position.legs[3].strike)
        self.assertAlmostEqual(trade["max_loss"], width - (credit - fees), places=2)

    def test_itm_settlement_pays_intrinsic_and_settlement_fee(self):
        spec = condor()
        position, _ = engine.open_position(FakeMarket(flat()).chain(FRIDAY_21), FRIDAY_21, spec)
        settle_at = position.legs[0].strike + 300  # between short and long call
        trade = engine.run(spec, FakeMarket(flat(), settlements={SUNDAY_08: settle_at}))[0][0]
        intrinsic = payoff(settle_at, position.legs[0].strike, True)
        settle_fee = min(0.00015 * settle_at, 0.125 * intrinsic)
        self.assertAlmostEqual(trade["pnl"], position.credit - position.fees - intrinsic - settle_fee, places=2)
        self.assertEqual(trade["settlement"], settle_at)

    def test_take_profit_closes_when_premium_decays(self):
        market = FakeMarket(flat(), iv=lambda hour: 0.5 if hour < FRIDAY_21 + 10 else 0.2, settlements={SUNDAY_08: 40000.0})
        trade = engine.run(condor(exit={"take_profit_pct": 0.5}), market)[0][0]
        self.assertEqual((trade["reason"], trade["exit_hour"]), ("take_profit", FRIDAY_21 + 10))
        self.assertGreater(trade["pnl"], 0)

    def test_time_exit_and_stop_loss(self):
        market = FakeMarket(flat(), settlements={SUNDAY_08: 40000.0})
        trade = engine.run(condor(exit={"close_hours_before_expiry": 3}), market)[0][0]
        self.assertEqual((trade["reason"], trade["exit_hour"]), ("time_exit", SUNDAY_08 - 3))
        moves = {**flat(), **{hour: 46000.0 for hour in range(FRIDAY_21 + 5, SUNDAY_08 + 1)}}
        trade = engine.run(condor(exit={"stop_loss_pct": 0.5}), FakeMarket(moves, settlements={SUNDAY_08: 46000.0}))[0][0]
        self.assertEqual((trade["reason"], trade["exit_hour"]), ("stop_loss", FRIDAY_21 + 5))
        self.assertLessEqual(trade["pnl"], -0.5 * trade["credit"])

    def test_cross_fills_pay_the_spread_on_entry_and_exit(self):
        market = FakeMarket(flat(), settlements={SUNDAY_08: 40000.0})
        spec = condor(fill="cross", exit={"close_hours_before_expiry": 3})
        trade = engine.run(spec, market)[0][0]
        position, _ = engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, spec)
        credit = cash = fees = 0.0
        for leg in position.legs:
            opening = market.quote(FRIDAY_21, SUNDAY_08, leg.strike, leg.is_call)
            closing = market.quote(SUNDAY_08 - 3, SUNDAY_08, leg.strike, leg.is_call)
            paid, received = (opening.ask, closing.bid) if leg.sign > 0 else (opening.bid, closing.ask)
            credit -= leg.sign * paid
            cash += leg.sign * received
            fees += min(0.0003 * 40000.0, 0.07 * paid) + min(0.0003 * 40000.0, 0.07 * received)
        self.assertEqual(trade["reason"], "time_exit")
        self.assertAlmostEqual(trade["credit"], credit, places=2)
        self.assertAlmostEqual(trade["pnl"], credit + cash - fees, places=2)

    def test_covered_call_with_long_perp(self):
        raw = {"start": "2024-01-05", "end": "2024-01-05", "entry": {"weekdays": ["fri"], "hours": [21]}, "expiry": {"weekday": "sun"},
               "legs": [{"side": "buy", "type": "perp"}, {"side": "sell", "type": "call", "delta": 0.3}]}
        spec = specs.validate(raw)
        moves = {**flat(), **{hour: 41000.0 for hour in range(FRIDAY_21 + 1, SUNDAY_08 + 1)}}
        events = [hour for hour in range(FRIDAY_21 + 1, SUNDAY_08 + 1) if hour % 8 == 0]  # funding times while held
        for settle_at in (37000.0, 43000.0):
            market = FakeMarket(moves, settlements={SUNDAY_08: settle_at}, perp_offset=20.0, funding_rate=0.0001)
            trade = engine.run(spec, market)[0][0]
            position, _ = engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, spec, market.perp(FRIDAY_21))
            perp, call = position.legs
            self.assertEqual((perp.is_perp, perp.price, perp.expiry), (True, 40020.0, SUNDAY_08))
            quote = market.quote(FRIDAY_21, SUNDAY_08, call.strike, True)
            premium = (quote.bid + quote.ask) / 2
            intrinsic = max(0.0, settle_at - call.strike)
            paid = sum(0.0001 * market.perp(hour) for hour in events)
            fees = (0.0005 * 40020.0 + 0.0005 * 41020.0 + min(0.0003 * 40000.0, 0.07 * premium)
                    + min(0.00015 * settle_at, 0.125 * intrinsic))
            self.assertAlmostEqual(trade["credit"], premium, places=2)  # the perp adds no premium
            self.assertAlmostEqual(trade["perp_pnl"], 1000.0, places=2)  # closed at the expiry hour's perp price
            self.assertAlmostEqual(trade["funding"], paid, places=2)
            self.assertAlmostEqual(trade["pnl"], 1000.0 - paid + premium - intrinsic - fees, places=2)
            self.assertRegex(trade["legs"], r"^\+1 \w+-PERP -1 \w+-\d+-C$")
        trade = engine.run(specs.validate({**raw, "exit": {"close_hours_before_expiry": 3}}), market)[0][0]
        closing = market.quote(SUNDAY_08 - 3, SUNDAY_08, call.strike, True)
        buyback = (closing.bid + closing.ask) / 2
        paid = sum(0.0001 * market.perp(hour) for hour in events if hour <= SUNDAY_08 - 3)
        fees = (0.0005 * 40020.0 + 0.0005 * 41020.0 + min(0.0003 * 40000.0, 0.07 * premium)
                + min(0.0003 * 41000.0, 0.07 * buyback))
        self.assertEqual(trade["reason"], "time_exit")
        self.assertAlmostEqual(trade["pnl"], 1000.0 - paid + premium - buyback - fees, places=2)
        summary = report.summarize([trade], {}, (FRIDAY_21, SUNDAY_08))
        self.assertAlmostEqual(summary["funding"], paid, places=2)
        for legs, message in [([{"side": "buy", "type": "perp", "expiry": {"dte": 30}}, raw["legs"][1]], "no delta, beyond or expiry"),
                              ([{"side": "buy", "type": "perp", "delta": 0.5}, raw["legs"][1]], "no delta, beyond or expiry"),
                              ([{"side": "buy", "type": "perp"}], "at least one option leg")]:
            with self.assertRaisesRegex(specs.SpecError, message):
                specs.validate({**raw, "legs": legs})
        self.assertEqual(engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, spec, None), (None, "no_perp"))

    def test_back_to_back_rolls_hold_the_perp_without_new_entry_fees(self):
        raw = {"start": "2024-01-06", "end": "2024-01-07", "entry": {"hours": [8]}, "expiry": {"dte": 1},
               "legs": [{"side": "buy", "type": "perp"}, {"side": "sell", "type": "call", "delta": 0.3}]}
        market = FakeMarket(flat(hours=range(FRIDAY_21, NEXT_FRIDAY_08 + 1)), settlements={SUNDAY_08: 40000.0, NEXT_FRIDAY_08: 40000.0})
        with_perp = engine.run(specs.validate(raw), market)[0]
        calls_only = engine.run(specs.validate({**raw, "legs": raw["legs"][1:]}), market)[0]
        self.assertEqual([t["exit_hour"] for t in with_perp], [SUNDAY_08, NEXT_FRIDAY_08])  # rolled at Sunday 08:00
        perp_fees = sum(t["fees"] for t in with_perp) - sum(t["fees"] for t in calls_only)
        self.assertAlmostEqual(perp_fees, 0.0005 * 40000.0 * 2, places=2)  # held through the roll: one open, one close
        self.assertAlmostEqual(sum(t["pnl"] for t in calls_only) - sum(t["pnl"] for t in with_perp), perp_fees, places=2)

    def test_carry_after_early_exit_and_only_one_refund_per_reopen(self):
        perp, call = {"side": "buy", "type": "perp"}, {"side": "sell", "type": "call", "delta": 0.3}

        def perp_fees(raw, market):
            with_perp = engine.run(specs.validate(raw), market)[0]
            calls_only = engine.run(specs.validate({**raw, "legs": [call]}), market)[0]
            self.assertEqual([t["exit_hour"] for t in with_perp], [t["exit_hour"] for t in calls_only])
            for trade in with_perp:
                self.assertLessEqual(trade["worst_open_pnl"], trade["pnl"])
            return with_perp, sum(t["fees"] for t in with_perp) - sum(t["fees"] for t in calls_only)

        fee = 0.0005 * 40000.0
        market = FakeMarket(flat(hours=range(FRIDAY_21, SUNDAY_08 + 1)), settlements={SUNDAY_08: 40000.0})
        rolled = {"start": "2024-01-05", "end": "2024-01-06", "entry": {"hours": [21]}, "expiry": {"weekday": "sun"},
                  "exit": {"close_hours_before_expiry": 11}, "legs": [perp, call]}
        trades, fees = perp_fees(rolled, market)  # time exit at Sat 21:00 and reopen in the same hour
        self.assertEqual([(t["reason"], t["exit_hour"]) for t in trades], [("time_exit", SUNDAY_08 - 11), ("time_exit", SUNDAY_08 - 10)])
        self.assertAlmostEqual(fees, 2 * fee, places=2)
        trades, fees = perp_fees({**rolled, "end": "2024-01-07", "entry": {"hours": [8, 21]}, "exit": {}}, market)
        self.assertEqual(len(trades), 1)  # Sunday 08:00 reopen fails (no later Sunday listed): no refund
        self.assertAlmostEqual(fees, 2 * fee, places=2)
        market = FakeMarket(flat(hours=range(FRIDAY_21 - 1, NEXT_FRIDAY_08 + 1)), settlements={SUNDAY_08: 40000.0, NEXT_FRIDAY_08: 40000.0})
        two = {"start": "2024-01-05", "end": "2024-01-07", "entry": {"hours": [8, 20, 21]}, "expiry": {"dte": 2}, "max_open": 2, "legs": [perp, call]}
        trades, fees = perp_fees(two, market)  # two close at Sunday 08:00, one reopens then, one more at 20:00
        self.assertEqual([(t["entry_hour"], t["exit_hour"]) for t in trades],
                         [(FRIDAY_21 - 1, SUNDAY_08), (FRIDAY_21, SUNDAY_08), (SUNDAY_08, NEXT_FRIDAY_08), (SUNDAY_08 + 12, NEXT_FRIDAY_08)])
        self.assertAlmostEqual(fees, 6 * fee, places=2)  # opens: 2 Friday + Sunday 20:00; closes: 1 Sunday 08:00 + 2 next Friday

    def test_beyond_finds_its_leg_by_spec_index_after_a_perp(self):
        raw = {"start": "2024-01-05", "end": "2024-01-05", "entry": {"weekdays": ["fri"], "hours": [21]}, "expiry": {"weekday": "sun"},
               "legs": [{"side": "buy", "type": "perp"}, {"side": "sell", "type": "put", "delta": 0.3},
                        {"side": "buy", "type": "put", "delta": 0.1, "beyond": 1}]}
        market = FakeMarket(flat())
        position, _ = engine.open_position(market.chain(FRIDAY_21), FRIDAY_21, specs.validate(raw), market.perp(FRIDAY_21))
        perp, short, wing = position.legs
        self.assertTrue(perp.is_perp)
        self.assertLess(wing.strike, short.strike)

    def test_max_loss_tolerates_float_quantities(self):
        legs = [engine.Leg(i, sign, SUNDAY_08, strike, True, qty, 0.0, 0.0, 0.5)
                for i, (sign, strike, qty) in enumerate([(-1, 100.0, 0.1), (-1, 110.0, 0.2), (1, 120.0, 0.3)])]
        self.assertAlmostEqual(engine.max_loss(legs, 0.0), 0.1 * 20 + 0.2 * 10)
        self.assertIsNone(engine.max_loss(legs[:2], 0.0))

    def test_fill_models_and_mark_fallback(self):
        quote = Quote(SUNDAY_08, 40000.0, True, 0, 40000.0, 0.5, 100.0, 90.0, 110.0)
        self.assertEqual(engine.fill_price(quote, True, "cross"), (110.0, False))
        self.assertEqual(engine.fill_price(quote, False, "cross"), (90.0, False))
        self.assertEqual(engine.fill_price(quote, True, "passive"), (90.0, False))
        self.assertEqual(engine.fill_price(quote, False, "mid"), (100.0, False))
        no_bid = Quote(SUNDAY_08, 40000.0, True, 0, 40000.0, 0.5, 100.0, math.nan, 110.0)
        self.assertEqual(engine.fill_price(no_bid, False, "cross"), (100.0, True))
        self.assertEqual(engine.fill_price(no_bid, True, "mid"), (100.0, True))
        self.assertEqual(engine.fill_price(no_bid, True, "cross"), (110.0, False))

    def test_strangle_is_unbounded_and_uses_regular_margin(self):
        raw = specs.load("short_strangle")
        raw.update(start="2024-01-05", end="2024-01-05")
        trade = engine.run(specs.validate(raw), FakeMarket(flat(), settlements={SUNDAY_08: 40000.0}))[0][0]
        self.assertIsNone(trade["max_loss"])
        self.assertGreater(trade["margin"], 0.1 * 40000.0)

    def test_skips_and_max_open(self):
        hours = range(FRIDAY_21, NEXT_FRIDAY_08 + 1)
        spec = specs.validate({"legs": [{"side": "sell", "type": "put", "delta": 0.3}], "entry": {"hours": [21]},
                               "expiry": {"dte": 7}, "start": "2024-01-05", "end": "2024-01-07"})
        trades, skipped, _ = engine.run(spec, FakeMarket(flat(hours=hours), settlements={NEXT_FRIDAY_08: 40000.0}))
        self.assertEqual(len(trades), 1)
        self.assertEqual(skipped, {"max_open": 2})
        self.assertEqual(engine.run(condor(), FakeMarket({FRIDAY_21 - 1: 40000.0, FRIDAY_21 + 1: 40000.0}))[1], {"no_data": 1})

    def test_trend_picks_legs_by_the_trailing_mean(self):
        raw = {"start": "2024-01-05", "end": "2024-01-05", "entry": {"weekdays": ["fri"], "hours": [21]}, "expiry": {"weekday": "sun"},
               "trend": {"ma_days": 1}, "legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "above"},
                                                 {"side": "sell", "type": "call", "delta": 0.3, "when": "below"}]}
        spec = specs.validate(raw)

        def market(before):
            return FakeMarket({**{hour: before for hour in range(FRIDAY_21 - 30, FRIDAY_21)}, **flat()}, settlements={SUNDAY_08: 40000.0})

        rising, falling = engine.run(spec, market(39000.0))[0], engine.run(spec, market(41000.0))[0]
        self.assertEqual([(t["trend"], t["legs"][-1]) for t in rising + falling], [("above", "P"), ("below", "C")])
        summary = report.summarize(rising, {}, (FRIDAY_21, SUNDAY_08))
        self.assertEqual(summary["by_trend"], {"above": {"trades": 1, "pnl": rising[0]["pnl"], "wins": int(rising[0]["pnl"] > 0)}})
        self.assertIn("by trend (1-day mean) above", "\n".join(report.text(spec, summary)))
        above_only = specs.validate({**raw, "legs": raw["legs"][:1]})
        self.assertEqual(engine.run(above_only, market(41000.0))[:2], ([], {"flat_below": 1}))
        self.assertEqual(engine.run(spec, FakeMarket(flat(), settlements={SUNDAY_08: 40000.0}))[:2], ([], {"no_trend_data": 1}))
        gappy = market(39000.0)
        for hour in range(FRIDAY_21 - 20, FRIDAY_21 - 18):  # 2 of 24 hours missing still counts, the entry hour must exist
            del gappy.forwards[hour]
        self.assertEqual(engine.trend_state(gappy, FRIDAY_21, 1), "above")
        del gappy.forwards[FRIDAY_21 - 1]
        self.assertIsNone(engine.trend_state(gappy, FRIDAY_21, 1))
        self.assertEqual(engine.trend_state(market(40000.0), FRIDAY_21, 1), "below")  # equal to the mean is not above
        wavy = FakeMarket({hour: 40000.0 + 900 * math.sin(hour / 7) for hour in range(FRIDAY_21 - 80, NEXT_FRIDAY_08)
                           if hour % 29 and not FRIDAY_21 + 70 <= hour < FRIDAY_21 + 74})  # scattered gaps and a 4-hour hole
        for days in (1, 2):
            window = engine.TrendWindow(wavy, days)
            hours = [*range(FRIDAY_21, FRIDAY_21 + 60, 1), *range(FRIDAY_21 + 61, FRIDAY_21 + 100, 9),
                     FRIDAY_21 + 97 + days * 24, FRIDAY_21 + 98 + days * 24 + 30, NEXT_FRIDAY_08 - 1, FRIDAY_21 + 5]  # steps, one window, more, back
            states = [window.state(hour) for hour in hours]
            self.assertEqual(states, [engine.trend_state(wavy, hour, days) for hour in hours])
            self.assertEqual({None, "above", "below"}, set(states))
        self.assertEqual(engine.run(specs.validate({k: v for k, v in raw.items() if k != "trend"} | {"legs": [raw["legs"][0] | {"when": None}]}),
                                    market(41000.0))[0][0]["trend"], None)

    def test_trend_flip_closes_the_perp_instead_of_holding_it(self):
        def spec(below_side):
            return specs.validate({"start": "2024-01-06", "end": "2024-01-07", "entry": {"hours": [8]}, "expiry": {"dte": 1}, "trend": {"ma_days": 1},
                                   "legs": [{"side": "buy", "type": "perp", "when": "above"}, {"side": "sell", "type": "call", "delta": 0.3, "when": "above"},
                                            {"side": below_side, "type": "perp", "when": "below"}, {"side": "sell", "type": "put", "delta": 0.3, "when": "below"}]})

        forwards = {hour: 39000.0 if hour < SATURDAY_08 else 41000.0 if hour < SUNDAY_08 else 38000.0
                    for hour in range(SATURDAY_08 - 30, NEXT_FRIDAY_08 + 1)}
        market = FakeMarket(forwards, settlements={SUNDAY_08: 38000.0, NEXT_FRIDAY_08: 38000.0})
        flipped, held = engine.run(spec("sell"), market)[0], engine.run(spec("buy"), market)[0]
        self.assertEqual([(t["trend"], t["exit_hour"]) for t in flipped], [("above", SUNDAY_08), ("below", NEXT_FRIDAY_08)])
        self.assertRegex(flipped[1]["legs"], r"^-1 \w+-PERP")
        self.assertAlmostEqual(sum(t["fees"] for t in flipped) - sum(t["fees"] for t in held), 2 * 0.0005 * 38000.0, places=2)

    def test_never_opens_a_contract_expiring_at_the_decision_hour(self):
        market = FakeMarket(flat(hours=range(FRIDAY_21, NEXT_FRIDAY_08 + 1)), settlements={SUNDAY_08: 40000.0}, expiring=True)
        self.assertIn(SUNDAY_08, {q.expiry for q in market.chain(SUNDAY_08)})  # 07:59 snapshot, still has time value
        spec = specs.validate({"start": "2024-01-07T08", "end": "2024-01-07T08", "entry": {"hours": [8]},
                               "expiry": {"weekday": "sun", "min_hours": 0}, "legs": [{"side": "sell", "type": "call", "delta": 0.5}]})
        self.assertEqual(engine.open_position(market.chain(SUNDAY_08), SUNDAY_08, spec), (None, "no_expiry"))
        self.assertEqual(engine.run(spec, market)[:2], ([], {"no_expiry": 1}))
        rule = {"weekday": None, "dte": 0, "min_hours": 0}
        self.assertEqual(engine.choose_expiry([SUNDAY_08, NEXT_FRIDAY_08], SUNDAY_08, rule), NEXT_FRIDAY_08)
        self.assertIsNone(engine.choose_expiry([SUNDAY_08], SUNDAY_08, rule))

    def test_calendar_legs_settle_at_their_own_expiry(self):
        spec = specs.validate({"start": "2024-01-05", "end": "2024-01-05", "entry": {"weekdays": ["fri"], "hours": [21]}, "fill": "mark",
                               "legs": [{"side": "sell", "type": "put", "delta": 0.5, "expiry": {"weekday": "sat"}},
                                        {"side": "buy", "type": "call", "delta": 0.5, "expiry": {"weekday": "sun"}}]})
        marked = range(FRIDAY_21, SATURDAY_08)  # both legs quoted until the near expiry
        both = {SATURDAY_08: 40000.0, SUNDAY_08: 40000.0}
        position, _ = engine.open_position(FakeMarket(flat()).chain(FRIDAY_21), FRIDAY_21, spec)
        put, call = position.legs
        self.assertEqual((put.expiry, call.expiry), (SATURDAY_08, SUNDAY_08))

        def run(hours, settlements):
            return engine.run(spec, FakeMarket(flat(hours=hours), settlements=settlements, expiring=True))

        def settled(leg, price):
            value = payoff(price, leg.strike, leg.is_call)
            return leg.sign * value - min(0.00015 * price, 0.125 * value)

        def closed(leg, market, hour):
            mark = market.quote(hour, leg.expiry, leg.strike, leg.is_call).mark
            return leg.sign * mark - min(0.0003 * 40000.0, 0.07 * mark)

        # Normal calendar: the near leg settles, the far leg closes at market the same hour.
        trade = run(range(FRIDAY_21, SUNDAY_08 + 1), both)[0][0]
        market = FakeMarket(flat(), expiring=True)
        self.assertEqual((trade["reason"], trade["exit_hour"], trade["fills"]), ("expiry", SATURDAY_08, 3))
        self.assertAlmostEqual(trade["pnl"], position.credit - position.fees + settled(put, 40000.0) + closed(call, market, SATURDAY_08), places=2)
        # Far quote missing at the near expiry: wait for the first quote while it is still alive.
        trade = run([*marked, *range(SATURDAY_08 + 4, SUNDAY_08 + 1)], both)[0][0]
        self.assertEqual((trade["reason"], trade["exit_hour"]), ("expiry", SATURDAY_08 + 4))
        self.assertAlmostEqual(trade["pnl"], position.credit - position.fees + settled(put, 40000.0) + closed(call, market, SATURDAY_08 + 4), places=2)
        # The far leg expires while waiting: its 07:59 quote is not tradable, it settles at its own delivery price.
        trade = run([*marked, SUNDAY_08], both)[0][0]
        self.assertAlmostEqual(trade["pnl"], position.credit - position.fees + settled(put, 40000.0) + settled(call, 40000.0), places=2)
        self.assertEqual((trade["reason"], trade["exit_hour"], trade["settlement"], trade["fills"]), ("expiry", SUNDAY_08, 40000.0, 2))
        far_up = run([*marked, SUNDAY_08], {SATURDAY_08: 40000.0, SUNDAY_08: 41000.0})[0][0]
        self.assertAlmostEqual(far_up["pnl"], position.credit - position.fees + settled(put, 40000.0) + settled(call, 41000.0), places=2)
        # No delivery evidence for the far expiry: unresolved and flagged, then the last marked forward after six hours.
        self.assertEqual(run([*marked, *range(SUNDAY_08, SUNDAY_08 + 4)], {SATURDAY_08: 40000.0})[:2], ([], {"unsettled_at_data_end": 1}))
        trade = run([*marked, *range(SUNDAY_08, SUNDAY_08 + 7)], {SATURDAY_08: 40000.0})[0][0]
        self.assertEqual((trade["reason"], trade["exit_hour"]), ("expiry_last_forward", SUNDAY_08 + 6))
        self.assertAlmostEqual(trade["pnl"], position.credit - position.fees + settled(put, 40000.0) + settled(call, 40000.0), places=2)
        # A live far leg without quotes until the data ends stays open, not unsettled.
        market = FakeMarket(flat(hours=[*marked, SATURDAY_08 + 1]), settlements=both, expiring=True)
        quote = market.quote
        market.quote = lambda hour, expiry, *rest: None if hour >= SATURDAY_08 else quote(hour, expiry, *rest)
        self.assertEqual(engine.run(spec, market)[:2], ([], {"open_at_data_end": 1}))


class SpecTest(unittest.TestCase):
    def test_defaults_and_errors(self):
        spec = condor()
        self.assertEqual((spec["entry"]["weekdays"], spec["expiry"]["weekday"]), ([4], 6))
        self.assertEqual(spec["end_hour"] - spec["start_hour"], 23)  # a date-only end includes its whole day
        for bad, message in [({"legz": []}, "unknown keys"), ({"legs": []}, "non-empty"),
                             ({"legs": [{"side": "sell", "type": "call", "delta": 1.5}]}, "delta"),
                             ({"legs": [{"side": "buy", "type": "put", "delta": 0.1, "beyond": 0}]}, "beyond"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3}], "fill": "best"}, "fill"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "above"}]}, "needs trend.ma_days"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3}], "trend": {"ma_days": 50}}, "needs at least one leg with when"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "up"}], "trend": {"ma_days": 50}}, "above or below"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "above"}], "trend": {"ma_days": 0.5}}, "integer"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "above"},
                                        {"side": "buy", "type": "put", "delta": 0.1, "beyond": 0, "when": "below"}], "trend": {"ma_days": 50}}, "same trend state"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3, "when": "above"}, {"side": "buy", "type": "perp", "when": "below"}],
                               "trend": {"ma_days": 50}}, "below the mean need at least one option leg")]:
            with self.assertRaisesRegex(specs.SpecError, message):
                specs.validate(bad)

    def test_set_paths_and_choices(self):
        raw = specs.load("iron_condor")
        specs.set_path(raw, "legs.0.delta", 0.3)
        specs.set_path(raw, "exit.take_profit_pct", 0.5)
        self.assertEqual((raw["legs"][0]["delta"], raw["exit"]["take_profit_pct"]), (0.3, 0.5))
        with self.assertRaises(specs.SpecError):
            specs.set_path(raw, "legs.9.delta", 0.3)
        self.assertEqual(specs.parse_choices("0.3,0.4"), [0.3, 0.4])
        self.assertEqual(specs.parse_choices("mid,cross"), ["mid", "cross"])
        self.assertEqual(specs.parse_choices("null,0.5"), [None, 0.5])
        self.assertEqual(specs.load('{"name": "inline"}'), {"name": "inline"})

    def test_written_spec_reruns_and_compact_dates(self):
        for spec in (condor(), specs.validate(specs.load("trend_premium"))):
            with tempfile.TemporaryDirectory() as folder:
                report.write(Path(folder), spec, [], {})
                again = specs.validate(specs.load(str(Path(folder) / "spec.json")))
            self.assertEqual(again, spec)
        spec = condor()
        self.assertEqual(condor(end="20240105")["end_hour"], spec["end_hour"])
        for exact in ("2024-01-05T00:00", "2024-01-05t00", "2024-01-05 00:00"):
            self.assertEqual(condor(end=exact)["end_hour"], spec["end_hour"] - 23)


class ReportTest(unittest.TestCase):
    def test_drawdown_and_summary(self):
        self.assertEqual(report.drawdown([100, -50, -80, 200, -10]), -130)
        trades = [{"entry": f"2024-01-0{i} 21:00", "entry_hour": i, "exit_hour": i + 1, "pnl": pnl, "credit": 100.0, "fees": 1.0,
                   "margin": 1000.0, "worst_open_pnl": min(pnl, 0), "reason": "expiry", "fallback_fills": 0, "fills": 4}
                   for i, pnl in enumerate([100.0, -50.0, 30.0], 1)]
        summary = report.summarize(trades, {}, (0, 10))
        self.assertEqual((summary["total_pnl"], summary["max_drawdown"], summary["win_rate"]), (80.0, -50.0, 0.6667))
        self.assertTrue(any("trades 3" in line for line in report.text(condor(), summary)))
        with tempfile.TemporaryDirectory() as folder:
            report.write(Path(folder), condor(), trades, summary)
            self.assertEqual(len((Path(folder) / "trades.csv").read_text().splitlines()), 4)


try:
    import numpy  # noqa: F401
    import pyarrow  # noqa: F401
    HAS_ARROW = True
except ImportError:
    HAS_ARROW = False


class BinanceTest(unittest.TestCase):
    def test_archives_parse_and_funding_sums_without_network(self):
        import io
        from optbt import binance

        hour = FRIDAY_21 - 5  # a funding hour (multiple of 8)
        klines = "".join(f"{(hour + i - 1) * 3_600_000},0,0,0,{40000 + 100 * i},0,0,0,0,0,0,0\n" for i in range(3))
        funding = f"calc_time,funding_interval_hours,last_funding_rate\n{hour * 3_600_000 + 7},8,0.0001\n"
        self.assertEqual(binance.parse("open_time,open,high,low,close\n" + klines, "klines")[0], (hour, 40000.0))
        self.assertEqual(binance.parse(klines, "klines")[2], (hour + 2, 40200.0))  # older archives have no header
        self.assertEqual(binance.parse(funding, "funding"), [(hour, 0.0001)])
        with tempfile.TemporaryDirectory() as folder:
            month = binance.month_name(engine.utc(hour).year * 12 + engine.utc(hour).month - 1)
            target = Path(folder) / "BTCUSDT"
            target.mkdir()
            (target / f"klines-{month}.csv").write_text("".join(f"{h},{p}\n" for h, p in binance.parse(klines, "klines")))
            (target / f"funding-{month}.csv").write_text(f"{hour},0.0001\n")
            perp = binance.BinancePerp(directory=folder)  # month files exist: no download
            self.assertEqual((perp.price(hour + 1), perp.price(hour + 9)), (40100.0, None))
            self.assertAlmostEqual(perp.funding(hour - 1, hour), 4.0)  # 0.01% of 40,000 at the funding hour
            self.assertEqual(perp.funding(hour, hour + 2), 0.0)  # (after, upto]: entering at the funding hour pays nothing
            (target / f"funding-{month}.csv").write_text(f"{hour},0.0001\n{hour + 8},0.0001\n")
            with self.assertRaisesRegex(binance.PerpDataError, "no price at funding time"):
                binance.BinancePerp(directory=folder).funding(hour - 1, hour)  # never drops a payment silently
        calls, original = [], (binance.urllib.request.urlopen, binance.time.sleep)

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        binance.urllib.request.urlopen = lambda url, timeout: calls.append(url) or Response(b"not a zip")
        binance.time.sleep = lambda seconds: None
        try:
            with self.assertRaisesRegex(binance.PerpDataError, "after 3 attempts"):
                binance.fetch("https://example.invalid/x.zip")  # a corrupt archive is retried, then reported
        finally:
            binance.urllib.request.urlopen, binance.time.sleep = original
        self.assertEqual(len(calls), 3)


@unittest.skipUnless(HAS_ARROW, "needs numpy and pyarrow")
class ParquetMarketTest(unittest.TestCase):
    def test_month_files_cache_and_boundary_hours(self):
        import pyarrow as pa
        import pyarrow.parquet as pq
        from optbt.market import ParquetMarket
        boundary = int(datetime(2024, 2, 1, tzinfo=timezone.utc).timestamp())
        expiry = boundary + 2 * 86400 + 8 * 3600
        rows = {"jan": [(boundary - 30, 40000.0, True, 0.010), (boundary - 30, 40000.0, False, 0.011)],
                "feb": [(boundary, 40000.0, True, 0.012), (boundary + 3000, 41000.0, True, 0.013),
                        (boundary + 3000, 42000.0, True, math.nan)]}
        with tempfile.TemporaryDirectory() as folder:
            for name, month in (("jan", "2024-01"), ("feb", "2024-02")):
                times, strikes, calls, marks = zip(*rows[name])
                pq.write_table(pa.table({
                    "timestamp": pa.array([int(t * 1000) for t in times], pa.timestamp("ms", "UTC")),
                    "expiration": pa.array([expiry * 1000] * len(times), pa.timestamp("ms", "UTC")),
                    "strike_price": pa.array(strikes, pa.float32()), "type": ["call" if c else "put" for c in calls],
                    "mark_iv": [0.5] * len(times), "underlying_price": [40100.0] * len(times),
                    "mark_price": marks, "bid_price": [m - 0.001 for m in marks], "ask_price": [m + 0.001 for m in marks]}),
                    Path(folder) / f"{month}.parquet")
            for attempt in range(2):  # second pass reads the .npy cache
                market = ParquetMarket(folder)
                hour = boundary // 3600
                chain = sorted(market.chain(hour), key=lambda q: (q.strike, not q.is_call))
                self.assertEqual([(q.strike, q.is_call) for q in chain], [(40000.0, True), (40000.0, False)])
                self.assertAlmostEqual(chain[0].mark, 0.012 * 40100.0, places=1)  # Feb file's 00:00 snapshot is newer
                self.assertAlmostEqual(chain[0].bid, 0.011 * 40100.0, places=1)
                self.assertEqual(chain[0].expiry, expiry // 3600)
                self.assertIsNotNone(market.quote(hour + 1, expiry // 3600, 41000.0, True))
                self.assertIsNone(market.quote(hour + 1, expiry // 3600, 40000.0, True))
                self.assertIsNone(market.quote(hour + 1, expiry // 3600, 42000.0, True))  # no mark price
                self.assertEqual(market.span(), (hour, hour + 1))
            self.assertTrue((Path(folder) / ".optbt-cache").is_dir())

    def test_appending_later_quotes_keeps_earlier_prices_and_pnl(self):
        from optbt.market import ParquetMarket
        call = (FRIDAY_21 * 3600 - 60, SUNDAY_08 * 3600, 41000.0, True, 40000.0, 0.01, 0.009, 0.011)
        expiring = (SUNDAY_08 * 3600 - 60, SUNDAY_08 * 3600, 41000.0, True, 40000.0, 0.0001, math.nan, 0.0002)  # delivery estimate
        later = int(datetime(2024, 1, 20, tzinfo=timezone.utc).timestamp())
        deep_puts = [(later + i * 3600, later + 6 * 86400 + 8 * 3600, 440000.0, False, 40000.0, 10.0, 9.9, 10.1) for i in range(4)]
        spec = specs.validate({"start": "2024-01-05", "end": "2024-01-05", "entry": {"weekdays": ["fri"], "hours": [21]},
                               "expiry": {"weekday": "sun"}, "fill": "mark", "legs": [{"side": "sell", "type": "call", "delta": 0.3}]})
        results = []
        with tempfile.TemporaryDirectory() as folder:
            for rows in ([call, expiring], [call, expiring] + deep_puts):  # rewrite the month with quotes after the backtest end
                write_quotes(Path(folder) / "2024-01.parquet", rows)
                market = ParquetMarket(folder)
                quote = market.quote(FRIDAY_21, SUNDAY_08, 41000.0, True)
                trades = engine.run(spec, market)[0]
                results.append(((quote.mark, quote.bid, quote.ask), [(t["credit"], t["fees"], t["pnl"]) for t in trades]))
        self.assertEqual(results[0], results[1])
        (mark, bid, ask), trades = results[0]
        self.assertAlmostEqual(mark, 400.0, places=2)
        self.assertAlmostEqual(bid, 360.0, places=2)
        self.assertAlmostEqual(ask, 440.0, places=2)
        self.assertEqual(trades, [(400.0, 12.0, 388.0)])  # BTC premium in USD at the forward, OTM at delivery

    def test_declared_units_are_shared_by_mark_bid_ask_and_never_guessed(self):
        from optbt import parquet
        from optbt.market import ParquetMarket
        expiry = SUNDAY_08 * 3600
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "2024-01.parquet"
            # Cheap USD prices (< 5) stay USD when the file declares them.
            write_quotes(path, [(FRIDAY_21 * 3600 - 60, expiry, 60000.0, True, 40000.0, 3.0, 2.0, 4.0)], units={"price": "usd", "iv": "fraction"})
            quote = ParquetMarket(folder).quote(FRIDAY_21, SUNDAY_08, 60000.0, True)
            self.assertEqual((quote.mark, quote.bid, quote.ask), (3.0, 2.0, 4.0))
            with self.assertRaisesRegex(parquet.UnitError, "configured but the file declares"):
                ParquetMarket(folder, price_unit="btc").chain(FRIDAY_21)
            # BTC columns with different distributions: asks only on a deep ITM put, still converted like the marks.
            rows = [(FRIDAY_21 * 3600 - 60, expiry, strike, True, 40000.0, 0.02, math.nan, math.nan) for strike in (40000.0, 40500.0, 41000.0)]
            rows.append((FRIDAY_21 * 3600 - 60, expiry, 440000.0, False, 40000.0, 10.0, 9.9, 10.1))
            write_quotes(path, rows)
            put = ParquetMarket(folder).quote(FRIDAY_21, SUNDAY_08, 440000.0, False)
            self.assertAlmostEqual(put.mark, 400000.0, delta=1)
            self.assertAlmostEqual(put.bid, 396000.0, delta=1)
            self.assertAlmostEqual(put.ask, 404000.0, delta=1)
            # A declared unit the quotes contradict is refused, not reinterpreted.
            with self.assertRaisesRegex(parquet.UnitError, "mark prices are impossible read as usd"):
                ParquetMarket(folder, price_unit="usd").chain(FRIDAY_21)
            write_quotes(path, rows, iv=50.0)
            with self.assertRaisesRegex(parquet.UnitError, "outside 0.5%-1000% read as fraction"):
                ParquetMarket(folder).chain(FRIDAY_21)
            self.assertAlmostEqual(ParquetMarket(folder, iv_unit="percent").quote(FRIDAY_21, SUNDAY_08, 40000.0, True).iv, 0.5, places=6)
        # Epoch numbers are scaled one value at a time, not by the column's median.
        seconds = int(datetime(2024, 1, 5, tzinfo=timezone.utc).timestamp())
        self.assertEqual(parquet.epoch_seconds(pa_array([seconds, seconds * 1000, seconds * 1000])).tolist(), [seconds] * 3)

    def test_slim_declares_units_and_raw_files_need_them(self):
        import pyarrow.parquet as pq
        from optbt import parquet
        from optbt.market import ParquetMarket
        with tempfile.TemporaryDirectory() as folder:
            raw, slim = Path(folder) / "raw", Path(folder) / "slim"
            raw.mkdir()
            write_quotes(raw / "2024-01.parquet", [(FRIDAY_21 * 3600 - 60, SUNDAY_08 * 3600, 41000.0, True, 40000.0, 0.01, 0.009, 0.011)], iv=50.0)
            for flags, message in [([], "unit error: .*iv unit is not declared"), (["--iv-unit", "percent"], "unit error: .*price unit is not declared"),
                                   (["--iv-unit", "fraction", "--price-unit", "btc"], "unit error: .*read as fraction")]:
                with self.assertRaisesRegex(SystemExit, message):
                    parquet.main(["slim", str(raw), "-o", str(slim), *flags])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(parquet.main(["slim", str(raw), "-o", str(slim), "--iv-unit", "percent", "--price-unit", "btc"]), 0)
            self.assertEqual(json.loads(pq.read_schema(slim / "2024-01.parquet").metadata[b"optbt.units"]), {"price": "btc", "iv": "fraction"})
            quote = ParquetMarket(slim).quote(FRIDAY_21, SUNDAY_08, 41000.0, True)
            self.assertAlmostEqual(quote.mark, 400.0, places=2)
            self.assertAlmostEqual(quote.iv, 0.5, places=6)
            with self.assertRaisesRegex(parquet.UnitError, "configured but the file declares"):
                ParquetMarket(slim, iv_unit="percent").chain(FRIDAY_21)

    def test_cache_from_older_conversion_semantics_is_rebuilt(self):
        import numpy as np
        from optbt import market as markets
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "2024-01.parquet"
            write_quotes(path, [(FRIDAY_21 * 3600 - 60, SUNDAY_08 * 3600, 41000.0, True, 40000.0, 0.01, 0.009, 0.011)])
            markets.ParquetMarket(folder).chain(FRIDAY_21)
            cache = Path(folder) / ".optbt-cache" / f"v{markets.CACHE_VERSION}" / "2024-01"
            self.assertIn(f"schema={markets.DATA_SCHEMA}", (cache / "source.txt").read_text())
            np.save(cache / "mark.npy", np.full(1, 0.01, "float32"))  # what the old month-median guess could have cached
            stat = path.stat()
            (cache / "source.txt").write_text(f"{stat.st_size}:{stat.st_mtime_ns}:{markets.CODE}")  # stamp written before DATA_SCHEMA
            self.assertAlmostEqual(markets.ParquetMarket(folder).quote(FRIDAY_21, SUNDAY_08, 41000.0, True).mark, 400.0, places=2)


def pa_array(values):
    import pyarrow as pa
    return pa.array(values, pa.int64())


def write_quotes(path, rows, units=None, iv=0.5):
    """A slim-format month file; rows are (snapshot s, expiry s, strike, is_call, forward, mark, bid, ask)."""
    import pyarrow as pa
    import pyarrow.parquet as pq
    times, expiries, strikes, calls, forwards, marks, bids, asks = zip(*rows)
    table = pa.table({
        "timestamp": pa.array([int(t * 1000) for t in times], pa.timestamp("ms", "UTC")),
        "expiration": pa.array([int(e * 1000) for e in expiries], pa.timestamp("ms", "UTC")),
        "strike_price": pa.array(strikes, pa.float32()), "type": ["call" if c else "put" for c in calls],
        "mark_iv": [float(iv)] * len(rows), "underlying_price": list(forwards),
        "mark_price": list(marks), "bid_price": list(bids), "ask_price": list(asks)})
    if units:
        table = table.replace_schema_metadata({b"optbt.units": json.dumps(units).encode()})
    pq.write_table(table, path)
    shutil.rmtree(Path(path).parent / ".optbt-cache", ignore_errors=True)  # a same-size rewrite may keep a coarse mtime


if __name__ == "__main__":
    unittest.main()

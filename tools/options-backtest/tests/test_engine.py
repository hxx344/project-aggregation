"""Engine, spec and report tests on a synthetic Black-76 market (standard library only)."""
import math
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

    def __init__(self, forwards, iv=0.5, spread=0.02, settlements=None, perp_offset=0.0, funding_rate=0.0):
        """`iv` is a number or a function of the hour; the perp trades at forward + `perp_offset` and
        charges `funding_rate` every 8 hours (00/08/16 UTC)."""
        self.forwards, self.iv, self.spread = forwards, iv, spread
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
                if expiry > hour for strike in strikes for is_call in (True, False)]

    def quote(self, hour, expiry, strike, is_call):
        return self._quote(hour, expiry, strike, is_call) if hour in self.forwards and expiry > hour else None

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


class SpecTest(unittest.TestCase):
    def test_defaults_and_errors(self):
        spec = condor()
        self.assertEqual((spec["entry"]["weekdays"], spec["expiry"]["weekday"]), ([4], 6))
        self.assertEqual(spec["end_hour"] - spec["start_hour"], 23)  # a date-only end includes its whole day
        for bad, message in [({"legz": []}, "unknown keys"), ({"legs": []}, "non-empty"),
                             ({"legs": [{"side": "sell", "type": "call", "delta": 1.5}]}, "delta"),
                             ({"legs": [{"side": "buy", "type": "put", "delta": 0.1, "beyond": 0}]}, "beyond"),
                             ({"legs": [{"side": "sell", "type": "put", "delta": 0.3}], "fill": "best"}, "fill")]:
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
        spec = condor()
        with tempfile.TemporaryDirectory() as folder:
            report.write(Path(folder), spec, [], {})
            again = specs.validate(specs.load(str(Path(folder) / "spec.json")))
        self.assertEqual(again, spec)
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
        import zipfile
        from optbt import binance

        def archive(text):
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as handle:
                handle.writestr("data.csv", text)
            return buffer.getvalue()

        hour = FRIDAY_21 - 5  # a funding hour (multiple of 8)
        klines = "".join(f"{(hour + i - 1) * 3_600_000},0,0,0,{40000 + 100 * i},0,0,0,0,0,0,0\n" for i in range(3))
        funding = f"calc_time,funding_interval_hours,last_funding_rate\n{hour * 3_600_000 + 7},8,0.0001\n"
        self.assertEqual(binance.parse(archive("open_time,open,high,low,close\n" + klines), "klines")[0], (hour, 40000.0))
        self.assertEqual(binance.parse(archive(klines), "klines")[2], (hour + 2, 40200.0))  # older archives have no header
        self.assertEqual(binance.parse(archive(funding), "funding"), [(hour, 0.0001)])
        with tempfile.TemporaryDirectory() as folder:
            month = binance.month_name(engine.utc(hour).year * 12 + engine.utc(hour).month - 1)
            target = Path(folder) / "BTCUSDT"
            target.mkdir()
            (target / f"klines-{month}.csv").write_text("".join(f"{h},{p}\n" for h, p in binance.parse(archive(klines), "klines")))
            (target / f"funding-{month}.csv").write_text(f"{hour},0.0001\n")
            perp = binance.BinancePerp([engine.utc(hour).year * 12 + engine.utc(hour).month - 1], directory=folder)  # no download
        self.assertEqual((perp.price(hour + 1), perp.price(hour + 9)), (40100.0, None))
        self.assertAlmostEqual(perp.funding(hour - 1, hour), 4.0)  # 0.01% of 40,000 at the funding hour
        self.assertEqual(perp.funding(hour, hour + 2), 0.0)  # (after, upto]: entering at the funding hour pays nothing


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


if __name__ == "__main__":
    unittest.main()

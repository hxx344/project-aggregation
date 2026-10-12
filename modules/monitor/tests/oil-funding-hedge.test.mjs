import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateOilFundingHedge } from '../lib/oil-funding-hedge.ts';

const HOUR = 3_600_000, FROM = Date.UTC(2026, 9, 1), TO = FROM + 3 * HOUR;
const identities = [['bybit', 'BZUSDT'], ['bybit', 'CLUSDT'], ['binance', 'BZUSDT'], ['binance', 'CLUSDT']];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function fixture() {
  const stamp = new Date(TO).toISOString(), coverage = { from: FROM, to: TO };
  const history = (exchange, leftRate, rightRate) => ({ exchange, monitorId: 'oil', currency: 'USDT', fetchedAt: stamp, status: 'live', availability: 'supported', reason: '',
    left: { symbol: 'BZUSDT', fetchedAt: stamp, error: '', coverage }, right: { symbol: 'CLUSDT', fetchedAt: stamp, error: '', coverage },
    rows: [{ time: FROM + HOUR, leftRate, rightRate }],
  });
  return {
    prices: { monitorId: 'oil', currency: 'USDT', intervalMs: HOUR, priceBasis: 'hour-open-mark', fetchedAt: stamp, status: 'live',
      legs: identities.map(([exchange, symbol], index) => ({ exchange, symbol, fetchedAt: stamp, error: '', coverage, rows: Array.from({ length: 4 }, (_, hour) => ({ time: FROM + hour * HOUR, price: [100, 90, 101, 89][index] })) })),
    },
    bybit: history('bybit', -0.01, 0.02), binance: history('binance', 0.03, -0.04),
    from: FROM, to: TO, notional: 380, bybitMakerRate: 0.0002, binanceMakerRate: 0.0003, direction: 'bybit-long',
  };
}

test('equal-barrel four-leg funding, gross denominator and per-leg maker costs reconcile', () => {
  const result = calculateOilFundingHedge(fixture());
  assert.equal(result.status, 'complete'); assert.equal(result.quantity, 1); assert.equal(result.openingNotional, 380);
  assert.deepEqual(result.legs.map(leg => leg.side), ['long', 'short', 'short', 'long']);
  [1, 1.8, 3.03, 3.56].forEach((expected, index) => close(result.legs[index].funding, expected));
  close(result.openingFee, 0.095); close(result.final.makerCost, 0.19);
  close(result.final.funding, 9.39); close(result.final.fundingNet, 9.295);
  close(result.final.netPnl, 9.20); close(result.returnPct, 9.2 / 380 * 100);
  close(result.legs.reduce((sum, leg) => sum + leg.openingFee + leg.closingFee, 0), result.final.makerCost);
  close(result.entry.hedgeEntryValue, 2); close(result.entry.bzCrossPct, 1);
  close(result.entry.bybitSpreadPct, (100 / 90 - 1) * 100);
  close(result.entry.spreadDifferencePp, (100 / 90 - 101 / 89) * 100);
  assert.equal(result.points[0].funding, 0); close(result.points[0].netPnl, -0.19);
});

test('reversing all sides negates funding and price P&L while retaining maker costs', () => {
  const input = fixture();
  input.prices.legs.forEach((leg, i) => { leg.rows.at(-1).price = [102, 91, 104, 92][i]; });
  const forward = calculateOilFundingHedge(input), reverse = calculateOilFundingHedge({ ...input, direction: 'bybit-short' });
  close(forward.final.pricePnl, 1); close(reverse.final.pricePnl, -1);
  close(reverse.final.funding, -forward.final.funding); close(reverse.final.makerCost, forward.final.makerCost);
  close(forward.final.makerCost, 0.095 + (102 + 91) * 0.0002 + (104 + 92) * 0.0003);
  close(forward.final.netPnl, forward.final.funding + 1 - forward.final.makerCost);
  close(reverse.entry.hedgeEntryValue, -2);
});

test('settlements retain asynchronous timestamps, exclude entry and include exit before simulated close', () => {
  const input = fixture();
  input.bybit.rows = [
    { time: FROM, leftRate: 0.5, rightRate: 0.5 },
    { time: FROM + HOUR + 17, leftRate: -0.01, rightRate: null },
    { time: FROM + 2 * HOUR + 31, leftRate: null, rightRate: 0.02 },
    { time: TO, leftRate: -0.001, rightRate: 0 },
  ];
  const result = calculateOilFundingHedge(input);
  assert.equal(result.points.find(point => point.time === FROM + HOUR).funding, 6.59);
  close(result.points.find(point => point.time === FROM + HOUR + 17).funding, 7.59);
  close(result.points.find(point => point.time === FROM + 2 * HOUR + 31).funding, 9.39);
  close(result.final.funding, 9.49);
  assert.equal(result.legs[0].settlements, 2); assert.equal(result.legs[1].settlements, 2);
});

test('funding uses the event-hour historical mark and never the entry or a future close', () => {
  const input = fixture();
  input.prices.legs[0].rows[1].price = 110;
  const result = calculateOilFundingHedge(input);
  close(result.legs[0].funding, 1.1); close(result.final.funding, 9.49);
  assert.equal(result.legs[0].entryPrice, 100);
});

test('missing entry is unavailable and cannot be backfilled from a later or current price', () => {
  const input = fixture(); input.prices.legs[0].rows.shift();
  const result = calculateOilFundingHedge(input);
  assert.equal(result.status, 'unavailable'); assert.equal(result.quantity, null);
  assert.equal(result.final, null); assert.equal(result.entry, null); assert.equal(result.points.length, 0);
});

test('missing settlement mark poisons cumulative funding after that event despite later good prices', () => {
  const input = fixture(); input.prices.legs[0].rows.splice(1, 1);
  input.bybit.rows.push({ time: FROM + 2 * HOUR, leftRate: -0.02, rightRate: null });
  const result = calculateOilFundingHedge(input);
  assert.equal(result.points[0].funding, 0);
  assert.equal(result.points[1].funding, null); assert.equal(result.final.funding, null);
  assert.equal(result.final.netPnl, null); assert.equal(result.returnPct, null);
  assert.equal(result.legs[0].funding, null); close(result.legs[0].knownFunding, 2);
  assert.equal(result.legs[1].funding, 1.8); assert.equal(result.final.pricePnl, 0);
});

test('an unrelated missing hour breaks valuation only and funding can still reconcile', () => {
  const input = fixture(); input.prices.legs[0].rows.splice(2, 1);
  const result = calculateOilFundingHedge(input);
  const gap = result.points.find(point => point.time === FROM + 2 * HOUR);
  assert.equal(gap.pricePnl, null); assert.equal(gap.makerCost, null); assert.equal(gap.netPnl, null);
  close(gap.funding, 9.39); close(result.final.netPnl, 9.2); assert.equal(result.status, 'partial');
});

test('partial/unknown funding coverage and empty history never report complete zero profits', () => {
  for (const coverage of [null, { from: FROM + 1, to: TO }, { from: FROM, to: TO - 1 }]) {
    const input = fixture(); input.bybit.left.coverage = coverage;
    const result = calculateOilFundingHedge(input);
    assert.equal(result.final.funding, null); assert.equal(result.legs[0].funding, null);
    assert.equal(result.status, 'partial'); close(result.legs[0].knownFunding, 1);
  }
  const empty = fixture(); empty.bybit.rows = [];
  assert.equal(calculateOilFundingHedge(empty).final.funding, null);
  const zero = fixture();
  for (const history of [zero.bybit, zero.binance]) history.rows = [{ time: FROM + HOUR, leftRate: 0, rightRate: 0 }];
  const result = calculateOilFundingHedge(zero);
  assert.equal(result.status, 'complete'); assert.equal(result.final.funding, 0); close(result.final.netPnl, -0.19);
});

test('zero maker rates and negative maker rebates are preserved; notional scales every cash amount', () => {
  const input = fixture(); input.bybitMakerRate = -0.0001; input.binanceMakerRate = 0;
  const result = calculateOilFundingHedge(input), doubled = calculateOilFundingHedge({ ...input, notional: 760 });
  close(result.openingFee, -0.019); close(result.final.makerCost, -0.038);
  close(doubled.final.netPnl, result.final.netPnl * 2); close(doubled.quantity, 2);
  close(doubled.returnPct, result.returnPct);
});

test('late funding source preserves the fully covered prefix and leaves only the uncovered tail blank', () => {
  const input = fixture(); input.bybit.left.coverage = { from: FROM, to: TO - 1 };
  const result = calculateOilFundingHedge(input);
  close(result.points.find(point => point.time === FROM + HOUR).funding, 9.39);
  close(result.points.find(point => point.time === FROM + 2 * HOUR).funding, 9.39);
  assert.equal(result.final.funding, null); assert.equal(result.final.netPnl, null);
  assert.equal(result.status, 'partial');
});

test('retained snapshots remain visibly partial without retimestamping or hiding known history', () => {
  const input = fixture(); input.prices.status = 'snapshot'; input.bybit.status = 'snapshot';
  const result = calculateOilFundingHedge(input);
  assert.equal(result.status, 'partial'); assert.ok(result.warnings.length); close(result.final.netPnl, 9.2);
});

test('reject invalid range, fee, size, direction and conflicting histories', () => {
  for (const patch of [{ from: FROM + 1 }, { to: FROM }, { to: FROM + 61 * 24 * HOUR }, { notional: 0 }, { notional: Infinity }, { notional: 1e10 }, { bybitMakerRate: NaN }, { binanceMakerRate: 0.011 }, { bybitMakerRate: -0.0011 }, { direction: 'automatic' }]) assert.throws(() => calculateOilFundingHedge({ ...fixture(), ...patch }));
  const duplicate = fixture(); duplicate.bybit.rows.push({ ...duplicate.bybit.rows[0] });
  assert.throws(() => calculateOilFundingHedge(duplicate));
});

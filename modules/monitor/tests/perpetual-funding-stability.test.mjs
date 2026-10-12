import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFundingStability } from '../lib/perpetual-funding-stability.ts';
import { PERPETUAL_FUNDING_STALE_MS } from '../lib/perpetual-funding-history.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR, NOW = Date.UTC(2026, 9, 12, 10, 35);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const settlements = (days = 32, rate = 0.0001, interval = HOUR, offset = 0) => Array.from(
  { length: Math.floor(days * DAY / interval) + 1 }, (_, index) => ({ time: NOW - offset - index * interval, rate }));
const leg = (extra = {}) => ({ key: 'a:BTCUSDT', exchange: 'a', symbol: 'BTCUSDT', identity: 'a:BTCUSDT:v1', status: 'ready',
  fetchedAt: NOW, coverage: { from: NOW - 32 * DAY, to: NOW }, records: settlements(), error: '', backfillComplete: true, ...extra });
const dailyLeg = (rates, extra = {}) => leg({ records: [{ time: NOW - rates.length * DAY, rate: 0 },
  ...rates.map((rate, index) => ({ time: NOW - (rates.length - index - 1) * DAY, rate }))], ...extra });

test('3, 7 and 30 days sum actual asynchronous hourly and eight-hour settlements without normalization', () => {
  const long = leg({ records: settlements(32, -0.0001) });
  const short = leg({ records: settlements(32, 0.0002, 8 * HOUR, 2.5 * HOUR) });
  for (const days of [3, 7, 30]) {
    const result = analyzeFundingStability(long, short, days, NOW);
    assert.equal(result.status, 'ready'); assert.equal(result.validDays, days); assert.equal(result.totalDays, days);
    assert.equal(result.total.longCount, days * 24); assert.equal(result.total.shortCount, days * 3);
    near(result.total.netPercent, days * 0.30); near(result.meanDayPercent, 0.30);
    assert.equal(result.positiveDays, days); assert.equal(result.positiveRatio, 1);
    assert.equal(result.longEvents[0].rate, -0.0001); assert.equal(result.shortEvents[0].rate, 0.0002);
    assert.ok(result.events.some(event => event.longPercent === 0));
    assert.ok(result.events.some(event => event.shortPercent === 0));
  }
});

test('the exact shared cutoff excludes the left boundary and newer settlements on either leg', () => {
  const asOf = NOW - 300_000, from = asOf - 3 * DAY;
  const rows = [{ time: from, rate: 0.8 }, ...[2, 1, 0].map(day => ({ time: asOf - day * DAY, rate: 0.001 }))];
  const long = leg({ records: [...rows, { time: NOW, rate: 0.5 }] });
  const short = leg({ coverage: { from: NOW - 32 * DAY, to: asOf }, records: rows.map(row => ({ ...row, rate: 0.002 })) });
  const result = analyzeFundingStability(long, short, 3, NOW);
  assert.equal(result.status, 'ready'); assert.equal(result.asOf, asOf); assert.equal(result.from, from);
  assert.equal(result.total.longCount, 3); assert.equal(result.total.shortCount, 3); near(result.total.netPercent, 0.3);
  assert.deepEqual(result.daily.map(day => [day.from, day.to]), [0, 1, 2].map(day => [from + day * DAY, from + (day + 1) * DAY]));
  assert.equal(result.events.at(-1).time, asOf); assert.equal(result.cumulative[0].time, from);
  assert.equal(result.cumulative[0].netPercent, 0);
});

test('direction reversal negates daily and cumulative carry while recomputing downside risk', () => {
  const long = dailyLeg([0, 0, 0]), short = dailyLeg([0.02, -0.03, 0.015]);
  const forward = analyzeFundingStability(long, short, 3, NOW), reverse = analyzeFundingStability(short, long, 3, NOW);
  near(forward.total.netPercent, 0.5); near(reverse.total.netPercent, -0.5);
  assert.deepEqual(forward.daily.map(day => day.netPercent), [2, -3, 1.5]);
  assert.deepEqual(reverse.daily.map(day => day.netPercent), [-2, 3, -1.5]);
  assert.equal(forward.maxDrawdownPercent, 3); assert.equal(reverse.maxDrawdownPercent, 2);
  assert.equal(forward.worstDayPercent, -3); assert.equal(forward.longestNegativeDays, 1);
  assert.equal(forward.positiveDays, 2); assert.equal(forward.positiveRatio, 2 / 3); near(forward.meanDayPercent, 1 / 6);
  for (let index = 0; index < forward.events.length; index++) near(reverse.events[index].cumulativePercent, -forward.events[index].cumulativePercent);
});

test('simultaneous cash flows merge before drawdown, while asynchronous debits create real intraday drawdown', () => {
  const simultaneous = analyzeFundingStability(dailyLeg([0.1, 0.1, 0.1]), dailyLeg([0.11, 0.11, 0.11]), 3, NOW);
  assert.equal(simultaneous.events.length, 3); assert.equal(simultaneous.maxDrawdownPercent, 0);
  near(simultaneous.events[0].netPercent, 1);
  const short = dailyLeg([0.02, 0.02, 0.02]);
  const long = dailyLeg([0.01, 0.01, 0.01]);
  long.records = long.records.map((row, index) => index ? { ...row, time: row.time - HOUR } : row);
  const asynchronous = analyzeFundingStability(long, short, 3, NOW);
  assert.equal(asynchronous.events.length, 6); near(asynchronous.total.netPercent, 3);
  near(asynchronous.maxDrawdownPercent, 1);
});

test('real zero is valid and equal carry at different settlement frequencies stays zero', () => {
  const zero = analyzeFundingStability(dailyLeg([0, 0, 0]), dailyLeg([0, 0, 0]), 3, NOW);
  assert.equal(zero.total.netPercent, 0); assert.equal(zero.positiveRatio, 0); assert.equal(zero.validDays, 3);
  assert.equal(zero.worstDayPercent, 0); assert.equal(zero.longestNegativeDays, 0); assert.equal(zero.maxDrawdownPercent, 0);
  const equal = analyzeFundingStability(leg({ records: settlements(32, 0.0001) }), leg({ records: settlements(32, 0.0008, 8 * HOUR) }), 30, NOW);
  assert.equal(equal.total.netPercent, 0); assert.equal(equal.positiveDays, 0);
  assert.ok(equal.daily.every(day => day.netPercent === 0));
});

test('negative streaks stop at a zero or positive day and include losses at the window start', () => {
  const result = analyzeFundingStability(dailyLeg([0, 0, 0, 0, 0, 0, 0]), dailyLeg([-0.01, -0.01, 0, -0.01, -0.01, -0.01, 0.01]), 7, NOW);
  assert.equal(result.longestNegativeDays, 3); assert.equal(result.maxDrawdownPercent, 5);
  assert.equal(result.positiveDays, 1); near(result.total.netPercent, -4);
});

test('partially backfilled histories retain complete days but no full-window cumulative or stability measures', () => {
  const partial = leg({ coverage: { from: NOW - 2 * DAY, to: NOW }, records: settlements(2), backfillComplete: false });
  const result = analyzeFundingStability(partial, leg({ records: settlements(32, 0.0002) }), 3, NOW);
  assert.equal(result.status, 'pending'); assert.equal(result.validDays, 2); assert.equal(result.positiveDays, 2);
  assert.equal(result.daily[0].longPercent, null); assert.equal(result.daily[0].netPercent, null);
  assert.ok(result.daily.slice(1).every(day => day.status === 'ready' && day.netPercent > 0));
  assert.equal(result.total.netPercent, null); assert.equal(result.total.longPercent, null);
  for (const field of ['positiveRatio', 'worstDayPercent', 'longestNegativeDays', 'maxDrawdownPercent', 'meanDayPercent']) assert.equal(result[field], null);
  assert.deepEqual(result.events, []); assert.deepEqual(result.cumulative, []); assert.equal(result.longEvents.length, 49);
  assert.equal(analyzeFundingStability({ ...partial, backfillComplete: true }, leg(), 3, NOW).status, 'partial');
});

test('coverage, an anchor and an actual settlement on each leg are required for every daily value', () => {
  const full = dailyLeg([0.01, 0.01, 0.01]);
  const missingDay = { ...full, records: full.records.filter(row => row.time !== NOW - DAY) };
  const result = analyzeFundingStability(missingDay, full, 3, NOW);
  assert.equal(result.daily[1].longCount, 0); assert.equal(result.daily[1].netPercent, null);
  assert.equal(result.validDays, 2); assert.equal(result.total.netPercent, null); assert.equal(result.status, 'partial');
  const noAnchor = analyzeFundingStability({ ...full, records: full.records.slice(1) }, full, 3, NOW);
  assert.equal(noAnchor.daily[0].netPercent, null); assert.equal(noAnchor.daily[1].netPercent, 0);
  const noCoverage = analyzeFundingStability({ ...full, coverage: null }, full, 3, NOW);
  assert.equal(noCoverage.status, 'pending'); assert.equal(noCoverage.total.netPercent, null); assert.equal(noCoverage.positiveRatio, null);
});

test('fresh completed recent days are usable even while older history remains backfilling', () => {
  const recent = leg({ coverage: { from: NOW - 4 * DAY, to: NOW }, records: settlements(4), backfillComplete: false });
  assert.equal(analyzeFundingStability(recent, leg(), 3, NOW).status, 'ready');
  const week = analyzeFundingStability(recent, leg(), 7, NOW);
  assert.equal(week.status, 'pending'); assert.equal(week.validDays, 4); assert.equal(week.total.netPercent, null);
});

test('stale and failed reads keep old numeric evidence and timestamps with explicit status', () => {
  const long = dailyLeg([0, 0, 0]), short = dailyLeg([0.01, 0.01, 0.01]);
  const stale = analyzeFundingStability(long, short, 3, NOW + PERPETUAL_FUNDING_STALE_MS + 1);
  assert.equal(stale.status, 'stale'); assert.equal(stale.asOf, NOW); assert.equal(stale.total.netPercent, 3);
  assert.equal(stale.positiveRatio, 1); assert.ok(stale.daily.every(day => day.status === 'stale'));
  const error = analyzeFundingStability({ ...long, status: 'error', error: '读取失败' }, short, 3, NOW);
  assert.equal(error.status, 'error'); assert.equal(error.total.netPercent, 3); assert.equal(error.meanDayPercent, 1);
  assert.ok(error.daily.every(day => day.status === 'error')); assert.match(error.reason, /更新失败/);
});

test('future cutoffs beyond tolerance, unsupported legs and absent legs cannot become trusted totals', () => {
  const full = dailyLeg([0, 0, 0]);
  const future = analyzeFundingStability(full, full, 3, NOW - 5001);
  assert.equal(future.status, 'stale'); assert.match(future.reason, /超前/); assert.equal(future.total.netPercent, null);
  assert.equal(future.positiveRatio, null); assert.deepEqual(future.events, []);
  assert.equal(analyzeFundingStability(full, full, 3, NOW - 5000).status, 'ready');
  assert.equal(analyzeFundingStability(undefined, full, 3, NOW).status, 'pending');
  assert.equal(analyzeFundingStability({ ...full, status: 'unsupported', error: '不支持' }, full, 3, NOW).status, 'unsupported');
});

test('duplicate observations are not double counted and conflicting or invalid evidence is rejected without mutating input', () => {
  const full = dailyLeg([0.001, 0.001, 0.001]);
  const duplicated = { ...full, records: [...full.records.toReversed(), { ...full.records[1] }] }, before = structuredClone(duplicated);
  const result = analyzeFundingStability(duplicated, full, 3, NOW);
  assert.equal(result.total.longCount, 3); assert.equal(result.total.netPercent, 0); assert.deepEqual(duplicated, before);
  const conflicting = { ...full, records: [...full.records, { ...full.records[1], rate: 0.5 }] };
  assert.equal(analyzeFundingStability(conflicting, full, 3, NOW).status, 'error');
  assert.equal(analyzeFundingStability({ ...full, records: [{ time: NOW, rate: NaN }] }, full, 3, NOW).status, 'error');
  assert.equal(analyzeFundingStability({ ...full, coverage: { from: NOW, to: NOW - 1 } }, full, 3, NOW).status, 'error');
});

test('query coverage does not invent missing settlements from a presumed cadence', () => {
  const sparse = dailyLeg([0.001, 0.001, 0.001]);
  const result = analyzeFundingStability(sparse, leg({ records: settlements(32, 0.0001) }), 3, NOW);
  assert.equal(result.status, 'ready'); assert.equal(result.total.longCount, 3);
  near(result.total.netPercent, 0.42);
  assert.ok(result.daily.every(day => day.longCount === 1 && day.shortCount === 24));
});

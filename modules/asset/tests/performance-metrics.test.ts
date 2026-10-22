import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMonthlyPerformance, calculateAnnualizedReturns, formatGain, formatReturnRate } from '../lib/performance-metrics.ts';
import { assetTrend, chinaDay } from '../lib/withdrawals.ts';
import type { Period, Withdrawal } from '../lib/types.ts';

const point = (date: string, adjusted: number) => ({ date, adjusted });
const annualized = (data: ReturnType<typeof point>[], today = '2024-02-15') =>
  calculateAnnualizedReturns(data, calculateMonthlyPerformance(data), today);
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('empty, single date and duplicate dates cannot produce returns', () => {
  for (const data of [[], [point('2024-01-01', 100)], [point('2024-01-01', 100), point('2024-01-01', 110)]]) {
    assert.deepEqual(calculateMonthlyPerformance(data), []);
    const result = annualized(data);
    assert.equal(result.hasData, false);
    assert.equal(result.overallAnnualized, null);
    assert.equal(result.monthlyAnnualized, null);
    assert.equal(result.daysSpan, 0);
  }
});

test('months use sorted observed endpoints, unique days and do not mutate input', () => {
  const data = [point('2024-02-29', 990), point('2023-12-31', 900), point('2024-01-31', 1100),
    point('2024-02-01', 1100), point('2024-01-01', 950), { ...point('2024-01-01', 1000), partial: true }];
  const before = structuredClone(data);
  const monthly = calculateMonthlyPerformance(data);
  assert.deepEqual(monthly.map(p => p.month), ['2024-02', '2024-01', '2023-12']);
  assert.deepEqual(monthly[0], { month: '2024-02', startValue: 1100, endValue: 990, gain: -110,
    returnRate: -0.1, snapshotCount: 2, startDate: '2024-02-01', endDate: '2024-02-29', daysSpan: 28 });
  assert.equal(monthly[1].gain, 100);
  assert.equal(monthly[1].snapshotCount, 2);
  assert.equal(monthly[2].gain, null);
  assert.equal(monthly[2].returnRate, null);
  assert.deepEqual(data, before);
});

test('zero and negative starting assets are unknown rates, not zero returns', () => {
  for (const start of [0, -100]) {
    const data = [point('2024-01-01', start), point('2024-01-31', 100)];
    assert.equal(calculateMonthlyPerformance(data)[0].gain, 100 - start);
    assert.equal(calculateMonthlyPerformance(data)[0].returnRate, null);
    assert.equal(annualized(data).monthlyAnnualized, null);
    assert.equal(annualized(data).overallAnnualized, null);
  }
  const flat = [point('2024-01-01', 100), point('2024-01-31', 100)];
  assert.equal(annualized(flat).monthlyAnnualized, 0);
  assert.equal(annualized(flat).overallAnnualized, 0);
  close(annualized([point('2024-01-01', 100), point('2024-01-31', 0)]).overallAnnualized, -366 / 30);
});

test('annualization uses elapsed days and actual calendar-year lengths', () => {
  const leap = annualized([point('2024-01-01', 100), point('2024-12-31', 110)], '2025-01-01');
  assert.equal(leap.daysSpan, 365);
  close(leap.overallAnnualized, 0.1 * 366 / 365);
  close(annualized([point('2024-01-01', 100), point('2025-01-01', 110)]).overallAnnualized, 0.1);
  close(annualized([point('2023-01-01', 100), point('2024-01-01', 110)]).overallAnnualized, 0.1);
  close(annualized([point('2023-12-31', 100), point('2024-01-02', 101)]).overallAnnualized, 0.01 / (1 / 365 + 1 / 366));
  close(annualized([point('2024-02-01', 100), point('2024-02-29', 101)], '2024-03-01').monthlyAnnualized, 0.01 * 366 / 28);
  close(annualized([point('2023-12-01', 100), point('2023-12-31', 101)], '2024-01-01').monthlyAnnualized, 0.01 * 365 / 30);
});

test('monthly annualization selects the previous Beijing calendar month, never a stale fallback', () => {
  const data = [point('2024-01-01', 100), point('2024-01-31', 101), point('2024-02-01', 102), point('2024-02-29', 103)];
  const beforeRollover = annualized(data.slice(0, 2), chinaDay(new Date('2024-01-31T15:59:59Z')));
  assert.equal(beforeRollover.referenceMonth, '2023-12');
  assert.equal(beforeRollover.monthlyAnnualized, null);
  const afterRollover = annualized(data, chinaDay(new Date('2024-01-31T16:00:00Z')));
  assert.equal(afterRollover.referenceMonth, '2024-01');
  close(afterRollover.monthlyAnnualized, 0.01 * 366 / 30);
  assert.equal(annualized(data, '2024-04-15').monthlyAnnualized, null);
  assert.equal(annualized(data, '2024-04-15').monthlyPeriod, null);
});

test('previous-month observation threshold is 25 elapsed days, not number of samples', () => {
  assert.equal(annualized([point('2024-01-01', 100), point('2024-01-25', 101)]).monthlyAnnualized, null);
  close(annualized([point('2024-01-01', 100), point('2024-01-26', 101)]).monthlyAnnualized, 0.01 * 366 / 25);
  const sparse = [point('2023-12-31', 100), point('2024-01-31', 101)];
  assert.equal(annualized(sparse).monthlyAnnualized, null);
  assert.notEqual(annualized(sparse).overallAnnualized, null);
});

test('malformed dates and non-finite assets cannot leak NaN or Infinity into metrics', () => {
  const valid = [point('2024-01-01', 100), point('2024-01-31', 101)];
  const data = [...valid, point('2024-02-30', 100), point('bad-date', 200), point('2024-01-15', Infinity), point('2024-01-16', NaN)];
  assert.deepEqual(calculateMonthlyPerformance(data), calculateMonthlyPerformance(valid));
  assert.deepEqual(annualized(data), annualized(valid));
  assert.equal(annualized(valid, 'bad-date').monthlyAnnualized, null);
  const overflowing = [point('2024-01-01', Number.MIN_VALUE), point('2024-01-31', Number.MAX_VALUE)];
  assert.equal(annualized(overflowing).overallAnnualized, null);
  assert.equal(annualized(overflowing).monthlyAnnualized, null);
});

test('withdrawal changes recalculate both month and lifetime metrics through actual assetTrend', () => {
  const period = (date: string, total: number): Period => ({ id: 'daily-' + date, date, total, fx: 7, cny: total * 7, future: false, difference: 0 });
  const withdrawals: Withdrawal[] = [{ id: 'withdrawal', date: '2024-01-15', amount: 100, note: '', createdAt: '', updatedAt: '' }];
  const ledger = { baselineDate: '2024-01-01', withdrawals, history: [period('2024-01-01', 1000), period('2024-01-31', 900)] };
  const metrics = () => annualized(assetTrend(ledger, '2024-02-15'));
  assert.equal(metrics().monthlyAnnualized, 0);
  assert.equal(metrics().overallAnnualized, 0);
  ledger.withdrawals[0].amount = 110;
  close(metrics().monthlyAnnualized, 0.01 * 366 / 30);
  ledger.withdrawals = [];
  close(metrics().overallAnnualized, -0.1 * 366 / 30);
  assert.equal(ledger.history[1].total, 900);
});

test('formatters distinguish missing, positive, negative and rounded zero values', () => {
  assert.equal(formatReturnRate(0.0523), '+5.23%');
  assert.equal(formatReturnRate(-0.021), '-2.10%');
  assert.equal(formatReturnRate(0), '+0.00%');
  assert.equal(formatReturnRate(-0.000001), '+0.00%');
  assert.equal(formatReturnRate(0.12345, 3), '+12.345%');
  assert.equal(formatGain(1234.56), '+1,234.56');
  assert.equal(formatGain(-987.65), '-987.65');
  assert.equal(formatGain(-0), '+0.00');
  for (const value of [null, NaN, Infinity, -Infinity]) {
    assert.equal(formatGain(value), '—');
    assert.equal(formatReturnRate(value), '—');
  }
});

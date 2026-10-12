import type { SettledFundingRecord } from './exchange-funding-history.ts';
import { PERPETUAL_FUNDING_STALE_MS, type FundingWindowHours, type FundingWindowTotal, type PerpetualFundingLeg } from './perpetual-funding-history.ts';

const DAY_MS = 86_400_000;
export type FundingStabilityDays = 3 | 7 | 30;
export type FundingStabilityStatus = FundingWindowTotal['status'];
export interface FundingStabilityDay {
  from: number;
  to: number;
  longPercent: number | null;
  shortPercent: number | null;
  netPercent: number | null;
  longCount: number;
  shortCount: number;
  status: FundingStabilityStatus;
  reason: string;
}
export interface FundingStabilityLegEvent extends SettledFundingRecord { percent: number }
export interface FundingStabilityEvent {
  time: number;
  /** Actual settlement charges, in percent of one leg's equal notional. */
  longPercent: number;
  shortPercent: number;
  netPercent: number;
  cumulativePercent: number;
}
export interface FundingStabilityReport {
  days: FundingStabilityDays;
  from: number | null;
  to: number | null;
  asOf: number | null;
  total: FundingWindowTotal;
  status: FundingStabilityStatus;
  reason: string;
  /** Oldest first; unavailable days contain null amounts, never synthetic zero. */
  daily: FundingStabilityDay[];
  /** Available only when every day of the requested window is covered. */
  events: FundingStabilityEvent[];
  cumulative: { time: number; netPercent: number }[];
  /** Original per-settlement rates, including partial history, without normalization. */
  longEvents: FundingStabilityLegEvent[];
  shortEvents: FundingStabilityLegEvent[];
  positiveDays: number;
  validDays: number;
  totalDays: number;
  /** Overall measures are null for incomplete windows; retained stale/error values keep their status. */
  positiveRatio: number | null;
  worstDayPercent: number | null;
  longestNegativeDays: number | null;
  maxDrawdownPercent: number | null;
  meanDayPercent: number | null;
}

function sum(values: readonly number[]) {
  let total = 0, correction = 0;
  for (const value of values) {
    const next = value - correction, updated = total + next;
    correction = (updated - total) - next; total = updated;
  }
  return total;
}
function net(long: number, short: number) {
  const difference = short - long;
  // Equal economic amounts collected at different frequencies can differ by a few ulps.
  return Math.abs(difference) <= Number.EPSILON * 4 * (Math.abs(long) + Math.abs(short)) ? 0 : difference;
}
function normalize(leg: PerpetualFundingLeg): PerpetualFundingLeg {
  const coverage = leg.coverage;
  if (coverage && (!Number.isSafeInteger(coverage.from) || !Number.isSafeInteger(coverage.to) || coverage.from < 0 || coverage.from > coverage.to)) throw Error('历史覆盖时间无效');
  const records = new Map<number, number>();
  for (const row of leg.records) {
    if (!Number.isSafeInteger(row.time) || row.time < 0 || !Number.isFinite(row.rate) || Math.abs(row.rate) > 1) throw Error('历史结算记录无效');
    if (!coverage || row.time < coverage.from || row.time > coverage.to) continue;
    if (records.has(row.time) && records.get(row.time) !== row.rate) throw Error('同一时刻的历史结算记录冲突');
    records.set(row.time, row.rate);
  }
  return { ...leg, records: [...records].sort(([left], [right]) => left - right).map(([time, rate]) => ({ time, rate })) };
}
function amount(leg: PerpetualFundingLeg, from: number, to: number) {
  const rows = leg.records.filter(row => row.time > from && row.time <= to);
  const covered = Boolean(leg.coverage && leg.coverage.from <= from && leg.coverage.to >= to
    && leg.records.some(row => row.time <= from) && rows.length);
  return { count: rows.length, percent: covered ? sum(rows.map(row => row.rate)) * 100 : null };
}

/** Actual settled carry for (from, asOf], short receipts minus long charges.
 * Coverage and a real preceding anchor establish an observable window, not proof
 * that an exchange omitted no settlements. Never infer past frequency from a current interval.
 */
export function analyzeFundingStability(longInput: PerpetualFundingLeg | undefined, shortInput: PerpetualFundingLeg | undefined,
  days: FundingStabilityDays, now: number): FundingStabilityReport {
  const total: FundingWindowTotal = { hours: days * 24 as FundingWindowHours, asOf: null,
    longPercent: null, shortPercent: null, netPercent: null, longCount: 0, shortCount: 0, status: 'pending', reason: '历史结算采集中' };
  const result: FundingStabilityReport = { days, from: null, to: null, asOf: null, total,
    status: total.status, reason: total.reason, daily: [], events: [], cumulative: [], longEvents: [], shortEvents: [],
    positiveDays: 0, validDays: 0, totalDays: days, positiveRatio: null, worstDayPercent: null,
    longestNegativeDays: null, maxDrawdownPercent: null, meanDayPercent: null };
  const finish = (status: FundingStabilityStatus, reason: string) => {
    result.status = total.status = status; result.reason = total.reason = reason;
    return result;
  };
  if (![3, 7, 30].includes(days) || !Number.isFinite(now)) return finish('error', '统计窗口或当前时间无效');
  if (!longInput || !shortInput) return result;
  if (longInput.status === 'unsupported' || shortInput.status === 'unsupported') return finish('unsupported',
    (longInput.status === 'unsupported' ? longInput.error : shortInput.error) || '该组合暂不支持历史结算');
  let long: PerpetualFundingLeg, short: PerpetualFundingLeg;
  try { long = normalize(longInput); short = normalize(shortInput); }
  catch (error) { return finish('error', error instanceof Error ? error.message : '历史结算记录无效'); }
  const failed = long.status === 'error' || short.status === 'error' || Boolean(long.error || short.error);
  if (!long.coverage || !short.coverage) return finish(failed ? 'error' : 'pending', long.error || short.error || '历史结算采集中');
  const asOf = Math.min(long.coverage.to, short.coverage.to), from = asOf - days * DAY_MS;
  result.asOf = result.to = total.asOf = asOf; result.from = from;
  if (asOf > now + 5_000) return finish('stale', '历史截止时间超前，暂不计算稳定度');
  const stale = now - asOf > PERPETUAL_FUNDING_STALE_MS;
  const pending = long.backfillComplete === false || short.backfillComplete === false || long.status === 'pending' || short.status === 'pending';
  const state = (complete: boolean): { status: FundingStabilityStatus; reason: string } => {
    if (stale) return { status: 'stale', reason: '历史已过期，保留已取得的结算数据' };
    if (failed) return { status: 'error', reason: '更新失败，保留已取得的结算数据' };
    if (!complete) return pending ? { status: 'pending', reason: '正在回补历史结算，完整日之外不补零' }
      : { status: 'partial', reason: '历史覆盖、窗口前结算或每日结算记录不足' };
    return { status: 'ready', reason: '' };
  };
  for (let day = 0; day < days; day++) {
    const start = from + day * DAY_MS, end = start + DAY_MS;
    const debit = amount(long, start, end), credit = amount(short, start, end);
    const netPercent = debit.percent === null || credit.percent === null ? null : net(debit.percent, credit.percent);
    result.daily.push({ from: start, to: end, longPercent: debit.percent, shortPercent: credit.percent,
      netPercent, longCount: debit.count, shortCount: credit.count, ...state(netPercent !== null) });
  }
  const raw = (leg: PerpetualFundingLeg): FundingStabilityLegEvent[] => leg.records
    .filter(row => row.time > from && row.time <= asOf).map(row => ({ ...row, percent: row.rate * 100 }));
  result.longEvents = raw(long); result.shortEvents = raw(short);
  total.longCount = result.longEvents.length; total.shortCount = result.shortEvents.length;
  if (result.daily.every(day => day.longPercent !== null)) total.longPercent = sum(result.longEvents.map(row => row.percent));
  if (result.daily.every(day => day.shortPercent !== null)) total.shortPercent = sum(result.shortEvents.map(row => row.percent));
  const valid = result.daily.filter(day => day.netPercent !== null);
  result.validDays = valid.length; result.positiveDays = valid.filter(day => day.netPercent! > 0).length;
  if (valid.length !== days) { const status = state(false); return finish(status.status, status.reason); }
  total.netPercent = net(total.longPercent!, total.shortPercent!);
  const grouped = new Map<number, { longPercent: number; shortPercent: number }>();
  for (const side of ['long', 'short'] as const) for (const row of result[`${side}Events`]) {
    const event = grouped.get(row.time) ?? { longPercent: 0, shortPercent: 0 };
    event[`${side}Percent`] = row.percent; grouped.set(row.time, event);
  }
  let cumulativeLong = 0, cumulativeShort = 0, longCorrection = 0, shortCorrection = 0, peak = 0, drawdown = 0;
  result.cumulative.push({ time: from, netPercent: 0 });
  for (const [time, value] of [...grouped].sort(([left], [right]) => left - right)) {
    const nextLong = value.longPercent - longCorrection, updatedLong = cumulativeLong + nextLong;
    const nextShort = value.shortPercent - shortCorrection, updatedShort = cumulativeShort + nextShort;
    longCorrection = (updatedLong - cumulativeLong) - nextLong; shortCorrection = (updatedShort - cumulativeShort) - nextShort;
    cumulativeLong = updatedLong; cumulativeShort = updatedShort;
    const cumulativePercent = net(cumulativeLong, cumulativeShort);
    peak = Math.max(peak, cumulativePercent); drawdown = Math.max(drawdown, peak - cumulativePercent);
    result.events.push({ time, ...value, netPercent: net(value.longPercent, value.shortPercent), cumulativePercent });
    result.cumulative.push({ time, netPercent: cumulativePercent });
  }
  if (result.cumulative.at(-1)!.time < asOf) result.cumulative.push({ time: asOf, netPercent: total.netPercent });
  let negative = 0, longest = 0;
  for (const day of result.daily) { negative = day.netPercent! < 0 ? negative + 1 : 0; longest = Math.max(longest, negative); }
  result.positiveRatio = result.positiveDays / days;
  result.worstDayPercent = Math.min(...valid.map(day => day.netPercent!));
  result.longestNegativeDays = longest; result.maxDrawdownPercent = drawdown; result.meanDayPercent = total.netPercent / days;
  const status = state(true); return finish(status.status, status.reason);
}

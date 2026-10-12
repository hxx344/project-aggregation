import type { SettledFundingRecord, FundingHistoryRange } from './exchange-funding-history.ts';

export const PERPETUAL_FUNDING_REFRESH_MS = 300_000;
export const PERPETUAL_FUNDING_STALE_MS = 615_000;
export const PERPETUAL_FUNDING_LOOKBACK_MS = 32 * 86_400_000;
export type FundingWindowHours = 24 | 72 | 168 | 720;
export interface FundingHistoryPairRequest { base: string; longKey: string; shortKey: string }
export interface PerpetualFundingLeg {
  key: string;
  exchange: string;
  symbol: string;
  /** Catalog fingerprint, independent of prices and current funding forecasts. */
  identity: string;
  status: 'pending' | 'ready' | 'error' | 'unsupported';
  fetchedAt: number | null;
  coverage: FundingHistoryRange | null;
  records: SettledFundingRecord[];
  error: string;
  /** A successful recent window can be read while older chunks are still backfilling. */
  backfillComplete?: boolean;
  nextRefreshAt?: number;
  cacheUpdatedAt?: number;
}
export interface PerpetualFundingHistoryReport {
  schemaVersion: 1;
  generatedAt: number;
  legs: Record<string, PerpetualFundingLeg>;
  storageError?: string;
}
export interface FundingWindowTotal {
  hours: FundingWindowHours;
  asOf: number | null;
  longPercent: number | null;
  shortPercent: number | null;
  netPercent: number | null;
  longCount: number;
  shortCount: number;
  status: 'ready' | 'pending' | 'partial' | 'stale' | 'error' | 'unsupported';
  reason: string;
}

/** Exact rolling (from, to] settlements; a positive net means receipts for this direction.
 * The denominator is one leg's equal notional, consistent with the holding estimate.
 * Query coverage plus a preceding real settlement avoids presenting a new listing as a full window.
 */
export function fundingWindowTotal(long: PerpetualFundingLeg | undefined, short: PerpetualFundingLeg | undefined, hours: FundingWindowHours, now: number): FundingWindowTotal {
  const result: FundingWindowTotal = { hours, asOf: null, longPercent: null, shortPercent: null, netPercent: null, longCount: 0, shortCount: 0, status: 'pending', reason: '历史结算采集中' };
  if (!long || !short) return result;
  if (long.status === 'unsupported' || short.status === 'unsupported') return { ...result, status: 'unsupported', reason: long.status === 'unsupported' ? long.error : short.error };
  if (!long.coverage || !short.coverage) return { ...result, status: long.status === 'error' || short.status === 'error' ? 'error' : 'pending', reason: long.error || short.error || result.reason };
  const asOf = Math.min(long.coverage.to, short.coverage.to), from = asOf - hours * 3_600_000;
  result.asOf = asOf;
  const totals = [long, short].map(leg => {
    const rows = leg.records.filter(row => row.time > from && row.time <= asOf);
    const covered = leg.coverage!.from <= from && leg.coverage!.to >= asOf && leg.records.some(row => row.time <= from) && rows.length > 0;
    return { count: rows.length, percent: covered ? rows.reduce((sum, row) => sum + row.rate, 0) * 100 : null };
  });
  [result.longCount, result.shortCount] = totals.map(total => total.count);
  [result.longPercent, result.shortPercent] = totals.map(total => total.percent);
  if (totals.some(total => total.percent === null)) return { ...result, status: long.backfillComplete === false || short.backfillComplete === false ? 'pending' : 'partial', reason: long.backfillComplete === false || short.backfillComplete === false ? '正在回补历史结算' : '历史不足或窗口内无结算记录' };
  result.netPercent = result.shortPercent! - result.longPercent!;
  if (asOf > now + 5_000 || now - asOf > PERPETUAL_FUNDING_STALE_MS) return { ...result, status: 'stale', reason: '历史已过期，保留上次累计' };
  if (long.error || short.error) return { ...result, status: 'error', reason: '更新失败，保留上次累计' };
  return { ...result, status: 'ready', reason: '' };
}

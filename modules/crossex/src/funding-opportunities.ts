import type { Instrument } from './live-types';

export type FundingLeg = {
  exchange: string; symbol: string; quoteCurrency: string;
  rate: number; intervalHours: number; normalized8hBps: number;
  nextFundingAt: number | null; fundingAt: number;
};
export type FundingOpportunity = {
  id: string; base: string; long: FundingLeg; short: FundingLeg;
  equivalent8hBps: number; grossBps: number | null;
  asOf: number; expiresAt: number; eligible: boolean; reason: string;
};

/** Recheck the server's independent funding/book/policy deadline as time passes. */
export function fundingStaleReason(row: FundingOpportunity, now: number, monitorStale: boolean) {
  if (monitorStale) return 'Monitor 行情待更新';
  if (!Number.isFinite(now) || !Number.isFinite(row.expiresAt) || now >= row.expiresAt
    || !Number.isFinite(row.asOf) || row.asOf > now + 1000) return '机会数据已过期，等待更新';
  return row.eligible ? '' : row.reason || '机会数据待核实';
}

/** Never substitute a similar contract when filling a funding direction. */
export function fundingPair(row: FundingOpportunity, instruments: Instrument[]) {
  const match = (leg: FundingLeg) => instruments.find(i => i.symbol === leg.symbol
    && i.exchange === leg.exchange && i.base === row.base && i.quoteCurrency === leg.quoteCurrency);
  const long = match(row.long), short = match(row.short);
  return long && short && long.exchange !== short.exchange ? { long, short } : null;
}

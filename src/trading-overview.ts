// Pure helpers for the compact position overview beside the live spread (价差下单).
import type { TradingReadState } from './trading-types';

export type OverviewSide = 'long' | 'short';
export type OverviewRow = {
  id: string; exchange: string; symbol: string; side: OverviewSide; quantity: string; unit: string;
  notional: string | null; unrealizedPnl: string | null; distancePercent: string | null;
  /** Inside the configured liquidation-alert threshold. */
  near?: boolean;
};
export type OverviewMarket = {
  id: 'oil' | 'hynix' | 'anthropic'; name: string; venues: string; state: TradingReadState; fetchedAt: string | null;
  rows: OverviewRow[]; summary: string | null; error: string | null;
  /** Shown when there are no rows: no position, not connected or not yet read. */
  empty: string;
};

const SEVERITY: Record<TradingReadState, number> = { live: 0, unconfigured: 1, loading: 2, stale: 3, error: 4 };
/** The least trustworthy state among a market's sources, so one failed account is never hidden behind a live one. */
export function worstState(states: TradingReadState[]): TradingReadState {
  const connected = states.filter(state => state !== 'unconfigured');
  const pool = connected.length ? connected : states;
  return pool.reduce<TradingReadState>((worst, state) => SEVERITY[state] > SEVERITY[worst] ? state : worst, pool[0] ?? 'unconfigured');
}

/** Distance from mark to liquidation as a percent of mark; null when either price is missing or not positive. */
export function liquidationDistance(markPrice: string | null, liquidationPrice: string | null) {
  const mark = Number(markPrice), liquidation = Number(liquidationPrice);
  if (markPrice === null || liquidationPrice === null || !(mark > 0) || !(liquidation > 0)) return null;
  return (Math.abs(mark - liquidation) / mark * 100).toFixed(2);
}

/** Oldest read time among sources, so the overview never claims fresher data than its stalest leg. */
export function oldestRead(times: (string | null)[]) {
  const valid = times.filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return valid.length ? valid.reduce((oldest, value) => Date.parse(value) < Date.parse(oldest) ? value : oldest) : null;
}

/** Long and short notional totals for a one-line hedge check; null when any leg's notional is unknown. */
export function sideNotional(rows: OverviewRow[]) {
  const total = (side: OverviewSide) => {
    const values = rows.filter(row => row.side === side).map(row => row.notional === null ? NaN : Number(row.notional));
    const sum = values.reduce((acc, value) => acc + value, 0);
    return Number.isFinite(sum) ? sum.toFixed(2) : null;
  };
  return { long: total('long'), short: total('short') };
}

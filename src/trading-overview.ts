// Pure helpers for the compact position overview beside the live spread (价差下单).
import type { TradingReadState } from './trading-types';

export type OverviewSide = 'long' | 'short';
export type OverviewRow = {
  id: string; exchange: string; symbol: string; side: OverviewSide; quantity: string; unit: string;
  notional: string | null; unrealizedPnl: string | null; pnlCurrency: string | null; distancePercent: string | null;
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

/** Sum the displayed positions, not historical receipts or inferred pairs. Round only when rendering. */
export function overviewPnl(market: OverviewMarket): { value: string | null; currency: string | null; note: string | null } {
  const unknown = (note: string) => ({ value: null, currency: null, note });
  if (!market.rows.length) return unknown('暂无持仓');
  if (market.state !== 'live' || market.error) return unknown('仓位数据未同步，暂不合计');
  const values: string[] = [];
  for (const row of market.rows) {
    if (row.unrealizedPnl === null || !/^-?\d+(?:\.\d+)?$/.test(row.unrealizedPnl)) return unknown('部分浮盈亏缺失，暂不合计');
    if (!row.pnlCurrency) return unknown('盈亏币种未确认，暂不合计');
    values.push(row.unrealizedPnl);
  }
  const currencies = new Set(market.rows.map(row => row.pnlCurrency!));
  // The existing ANT estimate permits only USDT/USDG at 1:1; it is not a general FX rule.
  const estimate = currencies.size > 1 && market.id === 'anthropic' && [...currencies].every(currency => currency === 'USDT' || currency === 'USDG');
  if (currencies.size > 1 && !estimate) return unknown('盈亏币种不同，暂不合计');
  const digits = Math.max(...values.map(value => value.split('.')[1]?.length ?? 0));
  const sum = values.reduce((total, value) => {
    const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
    const scaled = BigInt(integer + fraction.padEnd(digits, '0'));
    return total + (value.startsWith('-') ? -scaled : scaled);
  }, 0n);
  const text = (sum < 0n ? -sum : sum).toString().padStart(digits + 1, '0');
  const value = `${sum < 0n ? '-' : ''}${digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text}`;
  return { value, currency: estimate ? 'USDT' : market.rows[0].pnlCurrency, note: estimate ? '估算：USDG 按 1:1 折算 USDT' : null };
}

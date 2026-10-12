import Decimal from 'decimal.js';
import type { LivePosition } from './live-types';
import { exact, formatDecimal, netBaseQuantity } from './live-display';
const D = Decimal.clone({ precision: 100 });

export function fractionQuantity(quantity: string | null, percent: number, step?: string | null): string | null {
  if (exact(quantity) === '—' || !quantity || !Number.isInteger(percent) || percent <= 0 || percent > 100) return null;
  const amount = new D(quantity).abs();
  if (percent === 100) return amount.gt(0) ? amount.toFixed() : null;
  if (exact(step) === '—' || !step || new D(step).lte(0)) return null;
  const rounded = amount.mul(percent).div(100).div(step).floor().mul(step);
  return rounded.gt(0) ? rounded.toFixed() : null;
}

export type CurrencyAmount = { currency: string; value: string | null };
export function sumNative(legs: LivePosition[], value: (p: LivePosition) => string | null | undefined, currency: (p: LivePosition) => string): CurrencyAmount[] {
  const sums = new Map<string, { total: Decimal; complete: boolean }>();
  for (const leg of legs) {
    const coin = currency(leg) || '币种未知', amount = value(leg), previous = sums.get(coin) || { total: new D(0), complete: true };
    if (exact(amount) === '—') previous.complete = false;
    else previous.total = previous.total.add(amount!);
    sums.set(coin, previous);
  }
  return Array.from(sums, ([currency, amount]) => ({ currency, value: amount.complete ? amount.total.toFixed() : null }));
}

export function weightedPrice(legs: LivePosition[], field: 'entryPrice' | 'markPrice'): CurrencyAmount | null {
  const coins = new Set(legs.map(p => p.quoteCurrency));
  if (coins.size !== 1 || !legs.length || !legs[0].quoteCurrency) return null;
  let total = new D(0), size = new D(0);
  for (const p of legs) {
    if (exact(p[field]) === '—' || exact(p.baseQuantity) === '—') return null;
    const quantity = new D(p.baseQuantity!).abs(); total = total.add(quantity.mul(p[field]!)); size = size.add(quantity);
  }
  return size.gt(0) ? { currency: legs[0].quoteCurrency, value: total.div(size).toSignificantDigits(18).toFixed() } : null;
}

export function groupPositions(positions: LivePosition[]) {
  const groups = new Map<string, LivePosition[]>();
  for (const p of positions) { const key = p.baseCurrency || p.symbol, legs = groups.get(key) || []; legs.push(p); groups.set(key, legs); }
  return Array.from(groups, ([base, legs]) => ({ base, legs, net: netBaseQuantity(legs),
    entry: weightedPrice(legs, 'entryPrice'), mark: weightedPrice(legs, 'markPrice'),
    notional: sumNative(legs, p => p.notional, p => p.quoteCurrency),
    pnl: sumNative(legs, p => p.unrealizedPnl, p => p.pnlCurrency),
    realized: sumNative(legs, p => p.realizedPnl, p => p.pnlCurrency),
    funding: sumNative(legs, p => p.fundingFee, p => p.pnlCurrency),
  })).sort((a, b) => a.base.localeCompare(b.base));
}

export function decimalField(row: Record<string, unknown> | null | undefined, ...fields: string[]): string | null {
  for (const field of fields) { const value = row?.[field]; if (typeof value === 'string' && exact(value) !== '—') return value; }
  return null;
}
export function percentage(value: string | null | undefined): string { return exact(value) === '—' ? '—' : formatDecimal(new D(value!).mul(100).toFixed(), 'rate') + '%'; }

export function instrumentFees(fees: Record<string, unknown>[] | undefined, symbol: string | undefined) {
  const row = fees?.find(item => item.exchange_type === symbol?.split('_')[0]);
  const special = Array.isArray(row?.special_fee_list) ? (row.special_fee_list as Record<string, unknown>[]).find(item => item.symbol === symbol) : undefined;
  return { maker: decimalField(special, 'maker_fee_rate') ?? decimalField(row, 'future_maker_fee'), taker: decimalField(special, 'taker_fee_rate') ?? decimalField(row, 'future_taker_fee') };
}

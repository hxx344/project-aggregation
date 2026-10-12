import type { PerpetualQuote } from './perpetual-types.ts';
import type { PairTakerFees, TakerFee, TakerFeeOverrides } from './perpetual-fees.ts';
import { validFeePercent } from './perpetual-fees.ts';
import type { PerpetualDepthLeg } from './perpetual-execution.ts';

/** All prices and quantity are normalized per underlying asset, not contract lots. */
export interface PerpetualExitPosition {
  quantity: number;
  entryLongPrice: number;
  entryShortPrice: number;
  /** Total paid entry commissions in USDT, across both legs. */
  entryFeePaid: number;
  /** Settled funding cash flow in USDT: receipts positive, payments negative. */
  settledFunding: number;
  /** Total capital allocated to both accounts; null means return is unavailable. */
  capital: number | null;
}
export interface PerpetualExitInput extends PerpetualExitPosition {
  long: { exchange: string; symbol: string };
  short: { exchange: string; symbol: string };
  identity?: string;
  takerOverrides?: TakerFeeOverrides;
}
export interface PerpetualExitPnl {
  entryLongNotional: number;
  entryShortNotional: number;
  /** Return denominator: long-leg entry notional, not the sum of both legs. */
  entryNotional: number;
  longPnl: number;
  shortPnl: number;
  rawPnl: number;
  entryFeePaid: number;
  closeFeePaid: number | null;
  settledFunding: number;
  netPnl: number | null;
  notionalReturnPercent: number | null;
  capitalReturnPercent: number | null;
}
export interface PerpetualExitLeg extends PerpetualDepthLeg {
  action: 'sell' | 'buy';
  pnl: number | null;
  closeFee: number | null;
  fee: TakerFee;
}
export interface PerpetualExitEstimate extends Omit<PerpetualExitPnl, 'longPnl' | 'shortPnl' | 'rawPnl'> {
  kind: 'exit';
  identity: string;
  base: string;
  currency: 'USDT';
  position: PerpetualExitPosition;
  generatedAt: number;
  staleAfterMs: number;
  /** Both sides can fill the requested underlying quantity. */
  bookComplete: boolean;
  /** Complete fill and known closing fees. */
  complete: boolean;
  longPnl: number | null;
  shortPnl: number | null;
  rawPnl: number | null;
  fees: PairTakerFees;
  long: PerpetualExitLeg | null;
  short: PerpetualExitLeg | null;
  reasons: string[];
}

type ContractIdentity = Pick<PerpetualQuote, 'exchange' | 'symbol' | 'base' | 'quoteCurrency' | 'collateralCurrency' | 'multiplier' | 'contractUnit'>;
export const perpetualContractIdentity = (quote: ContractIdentity): string => JSON.stringify([
  quote.exchange, quote.symbol, quote.base, quote.quoteCurrency, quote.collateralCurrency ?? '', quote.multiplier ?? 1, quote.contractUnit ?? '',
]);
export const perpetualExitIdentity = (long: ContractIdentity, short: ContractIdentity): string => JSON.stringify([perpetualContractIdentity(long), perpetualContractIdentity(short)]);

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Reject invalid monetary inputs before they can consume a public-book request. */
export function validatePerpetualExitPosition(input: PerpetualExitPosition): void {
  if (!positive(input?.quantity) || input.quantity > 1e18) throw new Error('标的数量需大于 0 且不超过 10¹⁸');
  if (!positive(input.entryLongPrice) || !positive(input.entryShortPrice)) throw new Error('两腿开仓价格需为有效正数');
  for (const price of [input.entryLongPrice, input.entryShortPrice]) {
    const notional = input.quantity * price;
    if (!positive(notional) || notional > 10_000_000) throw new Error('每腿开仓名义金额需大于 0 且不超过 10,000,000 USDT');
  }
  if (typeof input.entryFeePaid !== 'number' || !Number.isFinite(input.entryFeePaid) || input.entryFeePaid < 0 || input.entryFeePaid > 1e9) throw new Error('已付开仓手续费需为 0 至 1,000,000,000 USDT');
  if (typeof input.settledFunding !== 'number' || !Number.isFinite(input.settledFunding) || Math.abs(input.settledFunding) > 1e9) throw new Error('累计已结算资金费需为有效 USDT 金额');
  if (input.capital !== null && (!positive(input.capital) || input.capital > 1e9)) throw new Error('投入本金需为有效正数；未填写时使用 null');
}

/**
 * Linear-contract realized PnL at specified exit VWAPs. This function does not
 * assert book freshness or available quantity; those are checked by the caller.
 * https://www.bybit.com/en/help-center/article/FAQ-Profit-Loss-Calculation
 */
export function calculatePerpetualExitPnl(position: PerpetualExitPosition, exitLongPrice: number, exitShortPrice: number, fees: Pick<PairTakerFees, 'long' | 'short'>): PerpetualExitPnl {
  validatePerpetualExitPosition(position);
  if (!positive(exitLongPrice) || !positive(exitShortPrice)) throw new Error('两腿平仓价格需为有效正数');
  const { quantity, entryLongPrice, entryShortPrice, entryFeePaid, settledFunding, capital } = position;
  const entryLongNotional = quantity * entryLongPrice, entryShortNotional = quantity * entryShortPrice;
  const longExitNotional = quantity * exitLongPrice, shortExitNotional = quantity * exitShortPrice;
  if (!Number.isFinite(longExitNotional) || !Number.isFinite(shortExitNotional)) throw new Error('平仓金额超出可计算范围');
  const longPnl = longExitNotional - entryLongNotional, shortPnl = entryShortNotional - shortExitNotional;
  const rawPnl = longPnl + shortPnl;
  const closeFeePaid = validFeePercent(fees.long.percent) && validFeePercent(fees.short.percent)
    ? longExitNotional * fees.long.percent / 100 + shortExitNotional * fees.short.percent / 100 : null;
  const netPnl = closeFeePaid === null ? null : rawPnl - entryFeePaid - closeFeePaid + settledFunding;
  return { entryLongNotional, entryShortNotional, entryNotional: entryLongNotional, longPnl, shortPnl, rawPnl, entryFeePaid, closeFeePaid, settledFunding, netPnl,
    notionalReturnPercent: netPnl === null ? null : netPnl / entryLongNotional * 100,
    capitalReturnPercent: netPnl === null || capital === null ? null : netPnl / capital * 100 };
}

/** Click time cannot refresh old exchange snapshots. */
export function exitEstimateExpired(result: PerpetualExitEstimate, now: number): boolean {
  const times = [result.generatedAt, result.long?.sourceTime, result.short?.sourceTime, result.long?.receivedAt, result.short?.receivedAt];
  const maxAge = Math.min(10_000, result.staleAfterMs);
  return !Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge <= 0 || times.some(time => typeof time !== 'number' || !Number.isFinite(time) || time > now + 5_000 || now - time > maxAge);
}

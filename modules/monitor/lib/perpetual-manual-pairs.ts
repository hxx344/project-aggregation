import type { PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from './perpetual-types.ts';
import { normalizedFunding8h, quoteIsFresh, quotePrice, quotePriceTime } from './perpetual-spreads.ts';
import { pairTakerFees, validFeePercent, type QualityBudget } from './perpetual-fees.ts';
import { quoteCurrencyFx, type PerpetualFxSnapshot } from './perpetual-fx.ts';

export const maxManualPairs = 20;
export interface ManualPair { id: string; first: string; second: string; firstFactor: number; secondFactor: number }
export const manualQuoteKey = (quote: PerpetualQuote) => `${quote.exchange}:${quote.symbol}`;
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9-]+:[^\s]{1,150}$/.test(value);
export const validManualFactor = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1e-12 && value <= 1e12;
export function validManualPair(value: unknown): value is ManualPair {
  if (!value || typeof value !== 'object') return false;
  const pair = value as ManualPair;
  return typeof pair.id === 'string' && pair.id.length > 0 && pair.id.length <= 100 && validKey(pair.first) && validKey(pair.second)
    && pair.first.split(':')[0] !== pair.second.split(':')[0] && validManualFactor(pair.firstFactor) && validManualFactor(pair.secondFactor);
}
export function parseManualPairs(value: string | null): ManualPair[] {
  try {
    const input = JSON.parse(value ?? 'null');
    if (input?.version !== 1 || !Array.isArray(input.pairs)) return [];
    const seenIds = new Set<string>(), seenPairs = new Set<string>();
    return input.pairs.filter((pair: unknown): pair is ManualPair => {
      if (!validManualPair(pair)) return false;
      const key = JSON.stringify([pair.first, pair.second].sort());
      if (seenIds.has(pair.id) || seenPairs.has(key)) return false;
      seenIds.add(pair.id); seenPairs.add(key); return true;
    }).slice(0, maxManualPairs).map((pair: ManualPair) => ({ id: pair.id, first: pair.first, second: pair.second, firstFactor: pair.firstFactor, secondFactor: pair.secondFactor }));
  } catch { return []; }
}

export interface ManualPairDirection {
  long: PerpetualQuote; short: PerpetualQuote;
  buy: number; sell: number; referenceBuy: number; referenceSell: number;
  spreadPercent: number; netSpreadPercent: number | null; fundingSpread8h: number | null;
  updatedAt: number; currency: string; fxAt: number | null; feeNote: string | null;
}
export interface ManualPairResult { reason: string | null; directions: ManualPairDirection[] }

/** Local, explicit pair only. Never changes catalog identities or server trading eligibility. */
export function evaluateManualPair(pair: ManualPair, snapshot: PerpetualSnapshot | null, byKey: ReadonlyMap<string, PerpetualQuote>, mode: PerpetualPriceMode, now: number, budget: QualityBudget, fx: PerpetualFxSnapshot | null): ManualPairResult {
  const unavailable = (reason: string): ManualPairResult => ({ reason, directions: [] });
  if (!validManualPair(pair)) return unavailable('配对设置无效，请重新编辑');
  if (!snapshot || snapshot.status === 'unavailable') return unavailable('等待行情服务');
  const first = byKey.get(pair.first), second = byKey.get(pair.second);
  if (!first || !second) return unavailable('合约尚未加载或已下架，配置仍保留');
  if ([first, second].some(q => !snapshot.exchanges.some(v => v.id === q.exchange && v.status === 'live'))) return unavailable('交易所未连接或报价异常');
  if ([first, second].some(q => !quoteIsFresh(q, mode, now, snapshot.staleAfterMs))) return unavailable('报价缺失或已过期，等待更新');
  if (Math.abs(quotePriceTime(first, mode) - quotePriceTime(second, mode)) > 5_000) return unavailable('两侧报价时间相差超过 5 秒');
  const cross = first.quoteCurrency !== second.quoteCurrency;
  const firstFx = cross ? quoteCurrencyFx(first.quoteCurrency, fx, now) : null;
  const secondFx = cross ? quoteCurrencyFx(second.quoteCurrency, fx, now) : null;
  if (cross && (!firstFx || !secondFx)) return unavailable('缺少有效汇率或汇率已过期，等待换汇行情');
  const legs = [{ quote: first, factor: pair.firstFactor, fx: firstFx }, { quote: second, factor: pair.secondFactor, fx: secondFx }];
  const directions: ManualPairDirection[] = [];
  for (const [longLeg, shortLeg] of [[legs[0], legs[1]], [legs[1], legs[0]]]) {
    const long = longLeg.quote, short = shortLeg.quote;
    const buy = quotePrice(long, mode, 'buy'), sell = quotePrice(short, mode, 'sell');
    if (buy === null || sell === null) continue;
    const referenceBuy = buy * longLeg.factor * (longLeg.fx?.ask ?? 1);
    const referenceSell = sell * shortLeg.factor * (shortLeg.fx?.bid ?? 1);
    const spreadPercent = (referenceSell / referenceBuy - 1) * 100;
    if (![referenceBuy, referenceSell, spreadPercent].every(Number.isFinite) || referenceBuy <= 0 || referenceSell <= 0) continue;
    // Resolve original identities: manually matching a stock must not inherit crypto fees.
    const fees = pairTakerFees({ long, short }, budget.takerOverrides, now);
    const feeNote = mode === 'mark' ? '标记价仅供参考，不计算净价差' : fees.roundTripPercent === null ? '费用缺失，可在手续费设置中填写账户费率' : !validFeePercent(budget.slippagePercent) ? '滑点预算无效' : null;
    const longFunding = normalizedFunding8h(long, now), shortFunding = normalizedFunding8h(short, now);
    directions.push({ long, short, buy, sell, referenceBuy, referenceSell, spreadPercent,
      netSpreadPercent: feeNote === null ? spreadPercent - fees.roundTripPercent! - budget.slippagePercent : null,
      fundingSpread8h: longFunding === null || shortFunding === null ? null : shortFunding - longFunding,
      updatedAt: Math.min(quotePriceTime(long, mode), quotePriceTime(short, mode)), currency: cross ? 'USDT' : first.quoteCurrency,
      fxAt: cross ? Math.min(firstFx!.at, secondFx!.at) : null, feeNote });
  }
  directions.sort((a, b) => b.spreadPercent - a.spreadPercent);
  return { reason: directions.length ? null : '暂无有效买卖价格', directions };
}

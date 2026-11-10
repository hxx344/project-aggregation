import type { HubPositionItem } from './hub-bridge.ts';
import type { AnthropicComparisonLeg } from './anthropic-history.ts';
import { ANTHROPIC_LEGS, anthropicPremium, anthropicSharesPerUnit, type AnthropicShares } from '../modules/anthropic/market.mjs';
import { venueKey } from './related-pairs.ts';

export type AnthropicPairQuotes = { premiums: Record<AnthropicComparisonLeg, number | null>; shares: AnthropicShares | null; fetchedAt: string | null; staleAfterMs: number; stale: boolean };
type Cash = { value: number | null; complete: boolean };
type CashKey = 'realizedPnl' | 'fees' | 'funding' | 'net';
export type AnthropicPositionPair = {
  leg: AnthropicComparisonLeg; label: string; items: readonly [HubPositionItem, HubPositionItem];
  opening: number | null; current: number | null; closing: number | null; change: number | null; currentStale: boolean; stale: boolean;
  narrowingFavors: boolean; shares: readonly [number | null, number | null];
  unrealized: Cash; realizedPnl: Cash; fees: Cash; funding: Cash; net: Cash; total: number | null; knownTotal: number | null;
  missing: string[];
};
const COMPARISONS: readonly AnthropicComparisonLeg[] = ['xyz', 'io', 'rh'];
// Explicit user-selected estimate. Unknown currencies never inherit a dollar value.
const ESTIMATED_USD = new Set(['USD', 'USDT', 'USDG']);
const number = (value: string | null | undefined) => {
  if (value == null || value.trim() === '') return null;
  const result = Number(value); return Number.isFinite(result) ? result : null;
};
const positive = (value: string | null | undefined) => { const result = number(value); return result !== null && result > 0 ? result : null; };
const sumKnown = (values: (number | null)[]) => {
  if (!values.some(value => value !== null)) return null;
  const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return Number.isFinite(sum) ? sum : null;
};
const cash = (values: (number | null)[], complete: boolean): Cash => ({ value: sumKnown(values), complete: complete && values.every(value => value !== null) });
const cycleKnown = (item: HubPositionItem) => !!item.cycle && ['complete', 'partial'].includes(item.cycle.status) && ESTIMATED_USD.has(item.cycle.currency ?? '');
const flow = (item: HubPositionItem, field: CashKey) => cycleKnown(item) ? number(item.cycle?.[field]) : null;
const label = (leg: AnthropicComparisonLeg) => `Binance ↔ ${ANTHROPIC_LEGS[leg].name}`;

/** A current-position comparison only. It never assigns historical fills to a pair. */
export function relatedAnthropicPair(items: readonly HubPositionItem[], quotes?: AnthropicPairQuotes, incomplete = false, now = Date.now()): { pair: AnthropicPositionPair | null; reason: string } {
  if (incomplete) return { pair: null, reason: '持仓来源未读完整，暂不确认组合；逐腿数据仍保留。' };
  const binance = items.filter(item => venueKey(item) === 'binance' && item.symbol === 'ANTHROPICUSDT');
  const comparisons = items.flatMap(item => COMPARISONS.flatMap(leg => venueKey(item) === ANTHROPIC_LEGS[leg].exchange && item.symbol === ANTHROPIC_LEGS[leg].symbol ? [{ item, leg }] : []));
  if (!binance.length || !comparisons.length) return { pair: null, reason: '缺少 Binance 或对比合约持仓，暂未形成当前双腿组合。' };
  if (binance.length !== 1 || comparisons.length !== 1) return { pair: null, reason: '存在多账户或多个对比合约，无法唯一分配 Binance 持仓，暂不合计，避免重复计入盈亏。' };
  const left = binance[0], { item: right, leg } = comparisons[0];
  if (left.side === right.side) return { pair: null, reason: `${label(leg)} 两腿同向，暂不作为反向组合合计。` };
  const pairItems = [left, right] as const, missing: string[] = [];
  const unrealizedValues = pairItems.map(item => ESTIMATED_USD.has(item.pnlCurrency ?? '') ? number(item.unrealizedPnl) : null);
  const unrealized = cash(unrealizedValues, true);
  const cashFields = ['realizedPnl', 'fees', 'funding', 'net'] as const;
  const fields = Object.fromEntries(cashFields.map(field => [field, cash(pairItems.map(item => flow(item, field)), pairItems.every(item => item.cycle?.status === 'complete'))])) as Record<CashKey, Cash>;
  const knownNetValues = pairItems.map(item => flow(item, 'net') ?? sumKnown(['realizedPnl', 'fees', 'funding'].map(field => flow(item, field as CashKey))));
  pairItems.forEach((item, index) => {
    const name = index === 0 ? 'Binance' : ANTHROPIC_LEGS[leg].name;
    const fieldsMissing = [unrealizedValues[index] === null ? '未实现或结算币种' : null,
      ...(['realizedPnl', 'fees', 'funding'] as const).map((field, i) => flow(item, field) === null ? ['已实现', '手续费', '资金费'][i] : null),
      item.cycle?.status === 'partial' ? '本轮统计不完整' : null].filter(Boolean);
    if (fieldsMissing.length) missing.push(`${name}：${fieldsMissing.join('、')}`);
  });
  const full = unrealized.complete && cashFields.every(field => fields[field].complete);
  const assumptions = quotes?.shares ?? null;
  const opening = anthropicPremium(positive(left.entryPrice), positive(right.entryPrice), leg, assumptions);
  const rawCurrent = quotes?.premiums[leg], current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent) ? rawCurrent : null;
  const quoteAt = Date.parse(quotes?.fetchedAt ?? '');
  const currentStale = !quotes || quotes.stale || !Number.isFinite(quoteAt) || now - quoteAt > quotes.staleAfterMs || quoteAt > now + 60_000;
  const canClose = pairItems.every(item => cycleKnown(item) && (positive(item.cycle?.closedQuantity) ?? 0) > 0);
  const closing = canClose ? anthropicPremium(positive(left.cycle?.closePrice), positive(right.cycle?.closePrice), leg, assumptions) : null;
  const shares = pairItems.map((item, i) => { const quantity = positive(item.quantity), units = anthropicSharesPerUnit(i === 0 ? 'binance' : leg, assumptions); return quantity === null || units === null ? null : quantity * units; }) as [number | null, number | null];
  return { reason: '', pair: { leg, label: label(leg), items: pairItems, opening, current, closing, currentStale, shares,
    change: opening !== null && current !== null ? current - opening : null, narrowingFavors: left.side === 'short', stale: pairItems.some(item => item.stale),
    unrealized, ...fields, total: full ? sumKnown([unrealized.value, fields.net.value]) : null,
    knownTotal: sumKnown([...unrealizedValues, ...knownNetValues]), missing } };
}

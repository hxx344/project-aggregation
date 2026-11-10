import type { PositionCycle, CycleEvidenceRow } from './positions-types.ts';
import { decimal, POSITIONS_INVALID } from './positions-decimal.ts';

export const CYCLE_LOOKBACK_DAYS = 85;
/** The replayed fills disagree with the exchange's own position, as opposed to malformed data. */
export const CYCLE_MISMATCH = '成交记录与当前持仓对不上，暂不统计本轮';
export const CYCLE_CURRENCY = '资金费币种与结算币种不同，暂不统计本轮';
export const CYCLE_LOOKBACK_MS = CYCLE_LOOKBACK_DAYS * 86_400_000;

/** One fill of the tracked position side; amounts keep the exchange's decimal text. */
export type CycleFill = {
  id: string; time: number; side: 'buy' | 'sell'; quantity: string; price: string;
  /** Realized trading PnL excluding fees and funding, in the settlement currency. */
  realizedPnl: string;
  /** Fee as a signed cash flow: a charge is negative, a rebate positive. */
  fee: string; feeCurrency: string;
  /** Signed position after this fill when the exchange reports it (Bybit). */
  sizeAfter?: string;
  /** Position in the exchange's newest-first listing; breaks same-millisecond ties when ids are not numeric. */
  order?: number;
};
/** Signed cash flow outside fills: funding, or USDC session settlement that realizes PnL. */
export type CycleCash = { id: string; time: number; kind: 'funding' | 'realized'; amount: string; currency: string };

type Scaled = { digits: bigint; scale: number };
const parse = (value: string): Scaled => {
  const text = decimal(value), negative = text.startsWith('-'), [whole, fraction = ''] = text.replace('-', '').split('.');
  const digits = BigInt(whole + fraction);
  return { digits: negative ? -digits : digits, scale: fraction.length };
};
const lift = (value: Scaled, scale: number) => value.digits * BigInt(10) ** BigInt(scale - value.scale);
function render({ digits, scale }: Scaled): string {
  const negative = digits < BigInt(0), absolute = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  let result = scale ? absolute.slice(0, -scale) + '.' + absolute.slice(-scale) : absolute;
  if (scale) result = result.replace(/0+$/, '').replace(/\.$/, '');
  return result === '0' ? '0' : (negative ? '-' : '') + result;
}
function combine(left: string, right: string, operation: (a: bigint, b: bigint) => bigint) {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  return render({ digits: operation(lift(a, scale), lift(b, scale)), scale });
}
export const add = (left: string, right: string) => combine(left, right, (a, b) => a + b);
export const subtract = (left: string, right: string) => combine(left, right, (a, b) => a - b);
export const negate = (value: string) => subtract('0', value);
export function compare(left: string, right: string) { const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale), x = lift(a, scale), y = lift(b, scale); return x === y ? 0 : x < y ? -1 : 1; }
export const sign = (value: string) => compare(value, '0');
export const magnitude = (value: string) => sign(value) < 0 ? negate(value) : render(parse(value));
export function multiply(left: string, right: string) { const a = parse(left), b = parse(right); return render({ digits: a.digits * b.digits, scale: a.scale + b.scale }); }
/** Truncates toward zero at `scale` places; only used for ratios and averages. */
export function divide(left: string, right: string, scale = 12) {
  const a = parse(left), b = parse(right);
  if (b.digits === BigInt(0)) throw new Error(POSITIONS_INVALID);
  return render({ digits: a.digits * BigInt(10) ** BigInt(scale + b.scale) / (b.digits * BigInt(10) ** BigInt(a.scale)), scale });
}
const sum = (values: string[]) => values.reduce(add, '0');
const delta = (fill: CycleFill) => fill.side === 'buy' ? fill.quantity : negate(fill.quantity);

/** Fills are newest first. Walks the current signed position back to the fill that opened it from zero. */
export function locateCycle(current: string, fills: readonly CycleFill[]): { index: number; openingFraction: string | null } | null {
  let after = current;
  for (let index = 0; index < fills.length; index++) {
    const before = subtract(after, delta(fills[index]));
    if (sign(before) === 0) return { index, openingFraction: null };
    // One fill closed the previous cycle and opened this one: only its opening share belongs here.
    if (sign(before) !== sign(after)) return { index, openingFraction: divide(magnitude(after), fills[index].quantity) };
    after = before;
  }
  return null;
}

const NUMERIC = /^\d{1,40}$/;
/** Same-millisecond fills keep execution order: numeric ids (Binance trade id, OKX billId) increase, otherwise the listing order decides. */
export function newestFirst(a: { time: number; id: string; order?: number }, b: { time: number; id: string; order?: number }) {
  if (a.time !== b.time) return b.time - a.time;
  if (NUMERIC.test(a.id) && NUMERIC.test(b.id)) { const x = BigInt(a.id), y = BigInt(b.id); return x === y ? 0 : x > y ? -1 : 1; }
  return (a.order ?? 0) - (b.order ?? 0);
}

export type CycleInput = {
  current: string; currency: string | null; fills: readonly CycleFill[]; cash: readonly CycleCash[];
  /** True when the opening fill was found; false when the lookback ended first. */
  complete: boolean; openingFraction: string | null; since: number;
  fundingAttributable: boolean; notes: string[]; updatedAt: string;
  excludedFills?: readonly CycleFill[];
};

/** `fills` hold only this cycle, newest first. Every replayed size must match the exchange's own. */
export function summarizeCycle(input: CycleInput): PositionCycle {
  const ordered = [...input.fills].reverse();
  let position = input.complete ? '0' : subtract(input.current, sum(ordered.map(delta)));
  let closed = '0', closeValue = '0';
  const realized: string[] = [], fees: string[] = [], notes = [...input.notes], evidence: CycleEvidenceRow[] = [];
  let feesKnown = true;
  ordered.forEach((fill, index) => {
    const opening = index === 0 && input.openingFraction !== null;
    let closingQuantity = '0';
    // The opening share is derived from the later fills so a truncated fraction cannot shift the replay.
    const after = opening ? subtract(input.current, sum(ordered.slice(1).map(delta))) : add(position, delta(fill));
    if (!opening && sign(position) !== 0 && sign(after) === sign(position) && compare(magnitude(after), magnitude(position)) < 0) {
      const amount = subtract(magnitude(position), magnitude(after));
      closingQuantity = amount;
      closed = add(closed, amount); closeValue = add(closeValue, multiply(amount, fill.price));
    }
    if (fill.sizeAfter !== undefined && compare(fill.sizeAfter, after) !== 0) throw new Error(CYCLE_MISMATCH);
    if (!opening) realized.push(fill.realizedPnl);
    if (fill.feeCurrency !== input.currency) feesKnown = false;
    else fees.push(opening ? multiply(fill.fee, input.openingFraction!) : fill.fee);
    evidence.push({ id: fill.id, time: new Date(fill.time).toISOString(), kind: 'fill', side: fill.side, closingQuantity, status: opening || fill.feeCurrency !== input.currency ? 'partial' : 'included',
      quantity: opening ? magnitude(after) : fill.quantity, price: fill.price, fraction: opening ? input.openingFraction : null,
      realizedPnl: opening ? null : fill.realizedPnl, fee: fill.feeCurrency === input.currency ? opening ? multiply(fill.fee, input.openingFraction!) : fill.fee : null,
      feeCurrency: fill.feeCurrency, amount: null, currency: input.currency,
      reason: [opening ? '翻仓只纳入本轮开仓份额的手续费，前轮已实现不纳入' : '', fill.feeCurrency !== input.currency ? '手续费币种不一致，费用不可合计' : ''].filter(Boolean).join('；') || null });
    position = after;
  });
  if (compare(position, input.current) !== 0) throw new Error(CYCLE_MISMATCH);
  const inCycle = input.cash.filter(item => item.time >= input.since);
  if (inCycle.some(item => item.currency !== input.currency)) throw new Error(CYCLE_CURRENCY);
  realized.push(...inCycle.filter(item => item.kind === 'realized').map(item => item.amount));
  const realizedPnl = sum(realized);
  const feeTotal = feesKnown ? sum(fees) : null;
  if (!feesKnown) notes.push('部分手续费以其他币种扣除，未计入');
  const funding = input.fundingAttributable ? sum(inCycle.filter(item => item.kind === 'funding').map(item => item.amount)) : null;
  for (const item of input.cash) {
    const included = item.time >= input.since && (item.kind !== 'funding' || input.fundingAttributable);
    evidence.push({ id: item.id, time: new Date(item.time).toISOString(), kind: item.kind, side: null, closingQuantity: null, status: included ? 'included' : 'excluded',
      quantity: null, price: null, fraction: null, realizedPnl: null, fee: null, feeCurrency: null,
      amount: included ? item.amount : null, currency: item.currency,
      reason: item.time < input.since ? '早于本轮起点' : !included ? '同合约反向持仓，资金费无法归属' : null });
  }
  for (const fill of input.excludedFills ?? []) evidence.push({ id: fill.id, time: new Date(fill.time).toISOString(), kind: 'fill', side: fill.side, closingQuantity: null, status: 'excluded',
    quantity: null, price: null, fraction: null, realizedPnl: null, fee: null, feeCurrency: null, amount: null, currency: input.currency, reason: '早于本轮开仓成交' });
  if (!input.fundingAttributable) notes.push('同一合约另有反向持仓，资金费无法拆分');
  if (!input.complete) notes.push(`开仓早于 ${CYCLE_LOOKBACK_DAYS} 天前，仅统计最近 ${CYCLE_LOOKBACK_DAYS} 天`);
  return {
    status: input.complete ? 'complete' : 'partial', since: new Date(input.since).toISOString(),
    closedQuantity: closed, closePrice: sign(closed) > 0 ? divide(closeValue, closed, 10) : null,
    realizedPnl, fees: feeTotal, funding,
    net: feeTotal !== null && funding !== null ? sum([realizedPnl, feeTotal, funding]) : null,
    currency: input.currency, note: notes.length ? notes.join('；') : null, updatedAt: input.updatedAt,
    evidence: { version: 1, coverageStart: new Date(input.since).toISOString(), coverageEnd: input.updatedAt, openingFound: input.complete,
      totalRows: evidence.length, truncated: evidence.length > 200, rows: evidence.slice(0, 200) },
  };
}

export const cycleUnavailable = (note: string, updatedAt: string | null, status: 'loading' | 'unavailable' = 'unavailable'): PositionCycle => ({
  status, since: null, closedQuantity: null, closePrice: null, realizedPnl: null, fees: null, funding: null, net: null, currency: null, note, updatedAt,
});

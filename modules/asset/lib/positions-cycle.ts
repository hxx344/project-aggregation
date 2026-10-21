import type { PositionCycle } from './positions-types.ts';
import { decimal, POSITIONS_INVALID } from './positions-values.ts';

export const CYCLE_LOOKBACK_DAYS = 85;
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
};

/** `fills` hold only this cycle, newest first. Every replayed size must match the exchange's own. */
export function summarizeCycle(input: CycleInput): PositionCycle {
  const ordered = [...input.fills].reverse();
  let position = input.complete ? '0' : subtract(input.current, sum(ordered.map(delta)));
  let closed = '0', closeValue = '0';
  const realized: string[] = [], fees: string[] = [], notes = [...input.notes];
  let feesKnown = true;
  ordered.forEach((fill, index) => {
    const opening = index === 0 && input.openingFraction !== null;
    // The opening share is derived from the later fills so a truncated fraction cannot shift the replay.
    const after = opening ? subtract(input.current, sum(ordered.slice(1).map(delta))) : add(position, delta(fill));
    if (!opening && sign(position) !== 0 && sign(after) === sign(position) && compare(magnitude(after), magnitude(position)) < 0) {
      const amount = subtract(magnitude(position), magnitude(after));
      closed = add(closed, amount); closeValue = add(closeValue, multiply(amount, fill.price));
    }
    if (fill.sizeAfter !== undefined && compare(fill.sizeAfter, after) !== 0) throw new Error(POSITIONS_INVALID);
    if (!opening) realized.push(fill.realizedPnl);
    if (fill.feeCurrency !== input.currency) feesKnown = false;
    else fees.push(opening ? multiply(fill.fee, input.openingFraction!) : fill.fee);
    position = after;
  });
  if (compare(position, input.current) !== 0) throw new Error(POSITIONS_INVALID);
  const inCycle = input.cash.filter(item => item.time >= input.since);
  if (inCycle.some(item => item.currency !== input.currency)) throw new Error(POSITIONS_INVALID);
  realized.push(...inCycle.filter(item => item.kind === 'realized').map(item => item.amount));
  const realizedPnl = sum(realized);
  const feeTotal = feesKnown ? sum(fees) : null;
  if (!feesKnown) notes.push('部分手续费以其他币种扣除，未计入');
  const funding = input.fundingAttributable ? sum(inCycle.filter(item => item.kind === 'funding').map(item => item.amount)) : null;
  if (!input.fundingAttributable) notes.push('同一合约另有反向持仓，资金费无法拆分');
  if (!input.complete) notes.push(`开仓早于 ${CYCLE_LOOKBACK_DAYS} 天前，仅统计最近 ${CYCLE_LOOKBACK_DAYS} 天`);
  return {
    status: input.complete ? 'complete' : 'partial', since: new Date(input.since).toISOString(),
    closedQuantity: closed, closePrice: sign(closed) > 0 ? divide(closeValue, closed, 10) : null,
    realizedPnl, fees: feeTotal, funding,
    net: feeTotal !== null && funding !== null ? sum([realizedPnl, feeTotal, funding]) : null,
    currency: input.currency, note: notes.length ? notes.join('；') : null, updatedAt: input.updatedAt,
  };
}

export const cycleUnavailable = (note: string, updatedAt: string | null, status: 'loading' | 'unavailable' = 'unavailable'): PositionCycle => ({
  status, since: null, closedQuantity: null, closePrice: null, realizedPnl: null, fees: null, funding: null, net: null, currency: null, note, updatedAt,
});

import type { Fill, ReadFill } from './hub-fills-types.ts';
import type { Position } from './positions-types.ts';
import { add, compare, negate, sign, subtract } from './positions-cycle.ts';

// Signed Binance/Bybit requests use recvWindow, OKX uses signature expiry; all allow <=60s.
// Use that conservative clock bound, and no upper bound: fills read after the snapshot may already be reflected.
const SNAPSHOT_CLOCK_BOUND_MS = 60_000;

export class FillConflict extends Error {}
const numericId = (fill: ReadFill) => fill.id.slice(fill.id.lastIndexOf(':') + 1);
export function fillsNewestFirst(a: ReadFill, b: ReadFill) {
  const time = Date.parse(b.time) - Date.parse(a.time);
  if (time) return time;
  const x = numericId(a), y = numericId(b);
  if (a.symbol === b.symbol && /^\d+$/.test(x) && /^\d+$/.test(y)) return BigInt(x) === BigInt(y) ? 0 : BigInt(x) > BigInt(y) ? -1 : 1;
  return (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);
}
function identity(fill: ReadFill) {
  // Page order is evidence for equal timestamps, not part of immutable exchange content.
  return JSON.stringify([fill.id, fill.symbol, fill.base, fill.time, fill.side, fill.positionSide, fill.quantity, fill.quantityUnit,
    fill.price, fill.priceCurrency, fill.fee, fill.feeCurrency, fill.realizedPnl, fill.sizeAfter ?? null]);
}
export function mergeFills(previous: readonly ReadFill[], incoming: readonly ReadFill[], lookbackStart: number) {
  const byId = new Map<string, ReadFill>();
  for (const fill of [...previous, ...incoming]) {
    if (Date.parse(fill.time) < lookbackStart) continue;
    const existing = byId.get(fill.id);
    if (existing && identity(existing) !== identity(fill)) throw new FillConflict();
    byId.set(fill.id, fill);
  }
  return [...byId.values()].sort(fillsNewestFirst);
}
export function replayFills(fills: readonly ReadFill[], positions: readonly Position[] | null, snapshotStart: number, exchange: string) {
  const groups = new Map<string, ReadFill[]>();
  for (const fill of fills) {
    const key = JSON.stringify([fill.symbol, fill.positionSide]), group = groups.get(key) ?? [];
    group.push(fill); groups.set(key, group);
  }
  const result: Fill[] = [];
  let skew = false;
  for (const group of groups.values()) {
    group.sort(fillsNewestFirst);
    const { symbol, positionSide } = group[0], held = positions?.filter(item => item.instrumentId === symbol) ?? [];
    // The position response may reflect any instant during the read, not only its start.
    const nearSnapshot = group.some(item => Date.parse(item.time) >= snapshotStart - SNAPSHOT_CLOCK_BOUND_MS);
    skew ||= nearSnapshot;
    let invalid = positions === null || nearSnapshot || (exchange === 'bybit' && new Set(held.map(item => item.side)).size > 1);
    // A mode change inside the history window cannot be reconstructed as independent legs.
    invalid ||= fills.some(item => item.symbol === symbol && (item.positionSide === 'net') !== (positionSide === 'net'));
    let current = '0';
    for (const item of held) {
      const leg = item.positionSide;
      if (exchange !== 'bybit' && leg && (leg === 'net') !== (positionSide === 'net')) invalid = true;
      if (positionSide === 'net' || (leg ?? item.side) === positionSide) current = add(current, item.side === 'short' ? negate(item.quantity) : item.quantity);
    }
    const projected: Fill[] = [];
    for (const fill of group) {
      const { sizeAfter } = fill, publicFill = { ...fill };
      delete publicFill.sizeAfter; delete publicFill.order;
      const after = current, before = subtract(after, fill.side === 'buy' ? fill.quantity : negate(fill.quantity));
      if (exchange === 'bybit' && (sizeAfter === null || sizeAfter === undefined || compare(sizeAfter, after) !== 0)) invalid = true;
      if ((positionSide === 'long' && (sign(before) < 0 || sign(after) < 0)) || (positionSide === 'short' && (sign(before) > 0 || sign(after) > 0))) invalid = true;
      projected.push({ ...publicFill, positionBefore: before, positionAfter: after }); current = before;
    }
    result.push(...projected.map(fill => invalid ? { ...fill, positionBefore: null, positionAfter: null } : fill));
  }
  const evidence = new Map(fills.map(fill => [fill.id, fill]));
  return { fills: result.sort((a, b) => fillsNewestFirst(evidence.get(a.id)!, evidence.get(b.id)!)), skew };
}

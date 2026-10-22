import { POSITIONS_CATALOG } from './positions-catalog.ts';
import type { Position, PositionCycle } from './positions-types.ts';

/** Positions as cached when a daily snapshot was written; balances and holdings share that moment. */
export type SnapshotCycle = Pick<PositionCycle, 'status' | 'since' | 'realizedPnl' | 'fees' | 'funding' | 'net' | 'currency' | 'updatedAt'>;
export type SnapshotPosition = Pick<Position, 'id' | 'symbol' | 'instrumentId' | 'side' | 'quantity' | 'quantityUnit' | 'unrealizedPnl' | 'pnlCurrency'> & { cycle: SnapshotCycle | null };
/** `generation` is a one-way digest of the stored credential, so a replaced account is never compared with the old one. */
export type SnapshotScope = { exchange: string; account: string; accountName: string; generation: string; scope: string; status: 'live' | 'stale'; fetchedAt: string; positions: SnapshotPosition[] };
export type PositionsCapture = { capturedAt: string; scopes: SnapshotScope[] };

export type ComboId = 'oil' | 'hynix';
export const COMBOS: { id: ComboId; label: string; bases: string[] }[] = [
  { id: 'oil', label: '原油套利', bases: ['CL', 'BZ'] },
  { id: 'hynix', label: '海力士套利', bases: ['SKHY', 'SKHX', 'SKHYNIX'] },
];
export type PositionChange = {
  key: string; account: string; symbol: string; side: Position['side']; combo: ComboId | null;
  previousQuantity: string | null; quantity: string | null; quantityUnit: string;
  /** Native PnL currency; `change` is converted to USD. */
  currency: string | null; unrealizedChange: number | null; cashFlowChange: number | null; change: number | null;
  /** Funding, fees and realized PnL are missing from `change`, or the whole change is unknown. */
  partial: boolean; note: string | null;
};
/** `positionsChange` sums known contributions only and is null when none is known; `readable` is false when some scope was not read live at both snapshots. */
export type ExchangeImpact = { exchange: string; name: string; balanceChange: number | null; positionsChange: number | null; other: number | null; complete: boolean; readable: boolean; positions: PositionChange[] };
export type ComboImpact = { id: ComboId; label: string; change: number | null; complete: boolean; legs: number; exchanges: string[] };
export type PositionAnalysis = { compared: boolean; capturedAt: string; previousCapturedAt: string | null; combos: ComboImpact[]; exchanges: ExchangeImpact[] };
type BalanceRow = { mode?: string; value: number | null; details?: { coin: string; value: number; price: number }[] };

const CENT = 0.005;
// Cycle summaries refresh every few minutes, so a flow landing just before a capture can shift to the next day; anything older means the summary stalled.
const CYCLE_MAX_LAG = 15 * 60_000;
const cents = (value: number) => Math.abs(value) < CENT ? 0 : value;
// Same prefix rule as the workbench's related-position matching, so both sides pick identical legs.
const SUFFIXES = new Set(['', 'USDT', 'USD', 'USDC', 'USD1', 'PERP', 'SWAP', 'USDTSWAP', 'USDTPERP', 'USDCPERP', 'USDSWAP', 'USDPERP']);
export function matchBase(symbol: string, bases: readonly string[]): string | null {
  const normalized = symbol.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  let match: string | null = null;
  for (const base of bases) if (normalized.startsWith(base) && SUFFIXES.has(normalized.slice(base.length)) && (!match || base.length > match.length)) match = base;
  return match;
}
export const comboOf = (position: Pick<Position, 'symbol' | 'instrumentId'>): ComboId | null =>
  COMBOS.find(combo => matchBase(position.symbol, combo.bases) || matchBase(position.instrumentId, combo.bases))?.id ?? null;

const amount = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
/** USD per unit of `currency`, from the snapshot's own balance details so the rate matches the balances. */
function usdRate(currency: string | null, rows: BalanceRow[], exchange: string) {
  if (currency === 'USD') return 1;
  if (!currency) return null;
  const candidates = [...rows.filter(row => row.mode === exchange), ...rows.filter(row => row.mode !== exchange)];
  for (const row of candidates) for (const detail of row.details ?? []) if (detail.coin === currency && detail.price > 0) return detail.price;
  return null;
}
const scopeKey = (scope: Pick<SnapshotScope, 'exchange' | 'account' | 'generation' | 'scope'>) => JSON.stringify([scope.exchange, scope.account, scope.generation, scope.scope]);
const knownSum = (values: (number | null)[]) => values.some(value => value !== null) ? cents(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)) : null;

const lagging = (cycle: SnapshotCycle, at: string) => !cycle.updatedAt || Date.parse(at) - Date.parse(cycle.updatedAt) > CYCLE_MAX_LAG;
function cashFlow(previous: SnapshotPosition | undefined, current: SnapshotPosition | undefined, previousAt: string, currentAt: string): number | null {
  const before = previous?.cycle, after = current?.cycle;
  if (!current || !after?.since || after.net === null || after.status === 'loading' || after.status === 'unavailable' || lagging(after, currentAt)) return null;
  if (!previous) {
    // Opened after the previous capture: every cycle flow falls inside this interval.
    return Date.parse(after.since) >= Date.parse(previousAt) ? amount(after.net) : null;
  }
  if (previous.side !== current.side || !before || before.since !== after.since || before.net === null || before.currency !== after.currency || lagging(before, previousAt)) return null;
  const end = amount(after.net), start = amount(before.net);
  return end === null || start === null ? null : end - start;
}

function positionChange(previous: SnapshotPosition | undefined, current: SnapshotPosition | undefined, at: { usable: boolean; previous: string | null; current: string }, rate: (currency: string | null) => number | null, account: string, key: string): PositionChange {
  const held = current ?? previous!, { usable, previous: previousAt } = at;
  const base = { key, account, symbol: held.symbol, side: held.side, combo: comboOf(held), previousQuantity: previous?.quantity ?? null, quantity: current?.quantity ?? null,
    quantityUnit: held.quantityUnit, currency: held.pnlCurrency };
  const unknown = (note: string): PositionChange => ({ ...base, unrealizedChange: null, cashFlowChange: null, change: null, partial: true, note });
  if (!usable || previousAt === null) return unknown(previousAt === null ? '前一份快照未记录持仓' : '持仓未在两份快照中同时有效读取');
  if (!current) return unknown('已平仓，平仓盈亏未单独统计');
  const before = previous ? amount(previous.unrealizedPnl) : 0, after = amount(current.unrealizedPnl);
  if (before === null || after === null) return unknown('缺少浮盈亏');
  const usd = rate(held.pnlCurrency);
  if (usd === null) return unknown(`缺少 ${held.pnlCurrency ?? '盈亏币种'} 兑 USD 价格`);
  const cash = cashFlow(previous, current, previousAt, at.current);
  const unrealizedChange = after - before;
  return { ...base, unrealizedChange, cashFlowChange: cash, change: cents((unrealizedChange + (cash ?? 0)) * usd), partial: cash === null,
    note: cash === null ? (current.cycle ? '本轮统计不可比，仅计浮盈亏变化' : '仅计浮盈亏变化，未含资金费与手续费') : null };
}

/** Compares two captures. Only scopes read live at both moments are attributed; everything else stays unknown, never zero. */
export function analyzePositions(input: { previous: PositionsCapture | null | undefined; current: PositionsCapture | null | undefined; rows: BalanceRow[]; balanceChange: (exchange: string) => number | null }): PositionAnalysis | null {
  const { previous, current } = input;
  if (!current) return null;
  const before = new Map((previous?.scopes ?? []).map(scope => [scopeKey(scope), scope]));
  const after = new Map(current.scopes.map(scope => [scopeKey(scope), scope]));
  const byExchange = new Map<string, PositionChange[]>(), unreadable = new Set<string>();
  for (const key of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(key), next = after.get(key), scope = next ?? old!;
    const usable = !!previous && old?.status === 'live' && next?.status === 'live';
    if (!usable) unreadable.add(scope.exchange);
    const oldPositions = new Map((old?.positions ?? []).map(item => [item.id, item]));
    const nextPositions = new Map((next?.positions ?? []).map(item => [item.id, item]));
    const list = byExchange.get(scope.exchange) ?? [];
    for (const id of new Set([...nextPositions.keys(), ...oldPositions.keys()])) {
      list.push(positionChange(oldPositions.get(id), nextPositions.get(id), { usable, previous: previous ? old?.fetchedAt ?? previous.capturedAt : null, current: next?.fetchedAt ?? current.capturedAt },
        currency => usdRate(currency, input.rows, scope.exchange), scope.accountName, JSON.stringify([key, id])));
    }
    byExchange.set(scope.exchange, list);
  }
  const exchanges: ExchangeImpact[] = [...byExchange].map(([exchange, positions]) => {
    const balanceChange = input.balanceChange(exchange);
    const readable = !unreadable.has(exchange), known = readable && positions.every(item => item.change !== null);
    // An empty list only proves "no holdings" when every scope was read live at both snapshots.
    const positionsChange = readable && !positions.length ? 0 : knownSum(positions.map(item => item.change));
    const complete = known && positions.every(item => !item.partial);
    return { exchange, name: POSITIONS_CATALOG.find(item => item.id === exchange)?.name ?? exchange, balanceChange, positionsChange, readable,
      other: balanceChange === null || !known || positionsChange === null ? null : cents(balanceChange - positionsChange), complete,
      positions: positions.sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0) || a.symbol.localeCompare(b.symbol)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const combos = COMBOS.flatMap(combo => {
    const legs = exchanges.flatMap(exchange => exchange.positions.filter(item => item.combo === combo.id).map(item => ({ item, name: exchange.name })));
    if (!legs.length) return [];
    return [{ id: combo.id, label: combo.label, change: knownSum(legs.map(leg => leg.item.change)),
      complete: legs.every(leg => leg.item.change !== null && !leg.item.partial), legs: legs.length, exchanges: [...new Set(legs.map(leg => leg.name))] }];
  });
  return { compared: !!previous, capturedAt: current.capturedAt, previousCapturedAt: previous?.capturedAt ?? null, combos, exchanges };
}

const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max;
const decimalOrNull = (value: unknown) => isText(value, 128) && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
/** Stored JSON is re-validated on read; malformed captures are dropped rather than trusted. */
export function positionsOf(value: unknown): PositionsCapture | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { capturedAt?: unknown; scopes?: unknown };
  if (!isText(raw.capturedAt) || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.scopes)) return null;
  const scopes: SnapshotScope[] = [];
  for (const item of raw.scopes) {
    if (!item || typeof item !== 'object') return null;
    const scope = item as Record<string, unknown>;
    if (![scope.exchange, scope.account, scope.accountName, scope.generation, scope.scope, scope.fetchedAt].every(field => isText(field)) || (scope.status !== 'live' && scope.status !== 'stale') || !Array.isArray(scope.positions)) return null;
    const positions: SnapshotPosition[] = [];
    for (const entry of scope.positions as unknown[]) {
      if (!entry || typeof entry !== 'object') return null;
      const p = entry as Record<string, unknown>, c = p.cycle as Record<string, unknown> | null | undefined;
      if (![p.id, p.symbol, p.instrumentId, p.quantityUnit].every(field => isText(field)) || (p.side !== 'long' && p.side !== 'short') || decimalOrNull(p.quantity) === null) return null;
      const cycle: SnapshotCycle | null = c && typeof c === 'object' && ['loading', 'complete', 'partial', 'unavailable'].includes(c.status as string)
        ? { status: c.status as SnapshotCycle['status'], since: isText(c.since) ? c.since : null, realizedPnl: decimalOrNull(c.realizedPnl), fees: decimalOrNull(c.fees),
          funding: decimalOrNull(c.funding), net: decimalOrNull(c.net), currency: isText(c.currency, 20) ? c.currency : null,
          updatedAt: isText(c.updatedAt) && Number.isFinite(Date.parse(c.updatedAt)) ? c.updatedAt : null } : null;
      positions.push({ id: p.id as string, symbol: p.symbol as string, instrumentId: p.instrumentId as string, side: p.side, quantity: p.quantity as string, quantityUnit: p.quantityUnit as string,
        unrealizedPnl: decimalOrNull(p.unrealizedPnl), pnlCurrency: isText(p.pnlCurrency, 20) ? p.pnlCurrency : null, cycle });
    }
    scopes.push({ exchange: scope.exchange as string, account: scope.account as string, accountName: scope.accountName as string, generation: scope.generation as string, scope: scope.scope as string,
      status: scope.status, fetchedAt: scope.fetchedAt as string, positions });
  }
  return { capturedAt: raw.capturedAt, scopes };
}

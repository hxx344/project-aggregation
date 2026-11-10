import type { PositionCycle, TradingPositionsResponse } from './trading-positions-types';
import { parseCycleEvidence } from '../server/cycle-evidence.mjs';

export const POSITION_MARKETS = ['oil', 'hynix', 'anthropic', 'perpetual'] as const;
export type PositionMarket = typeof POSITION_MARKETS[number];
export type PositionsStatus = 'ok' | 'unavailable' | 'unauthorized';
/** Why a read is unavailable, so the module can name the failing layer. 'background': the host page was not in the foreground. */
export type UnavailableReason = 'background' | 'timeout' | 'http' | 'network' | 'malformed';
export type PositionsRequest = { requestId: string; market: PositionMarket; symbols: string[] };
export type HubPositionItem = {
  key: string; source: string; exchange: string; exchangeId?: string; symbol: string; base: string; side: 'long' | 'short';
  quantity: string; quantityUnit: string; entryPrice: string | null; markPrice: string | null;
  unrealizedPnl: string | null; pnlCurrency: string | null; updatedAt: string | null; stale: boolean;
  cycle?: PositionCycle | null;
};
export type PositionsReply = {
  type: 'positions'; requestId: string; market: PositionMarket; status: PositionsStatus; generatedAt: string | null; incomplete: boolean; items: HubPositionItem[];
  /** Present on unavailable replies; `httpStatus` only with reason 'http'. */
  reason?: UnavailableReason; httpStatus?: number;
  /** Present on successful reads; counts cover provided source/scope lists before the item cap. */
  sourcesIncomplete?: boolean; truncated?: boolean; matchedCount?: number; itemLimit?: number;
};
export type PositionsOutcome = { status: 'ok'; data: unknown; at: number } | { status: 'unauthorized'; at: number }
  | { status: 'unavailable'; at: number; reason?: UnavailableReason; httpStatus?: number };

export const POSITIONS_CAPABILITIES = ['positions', 'open-trading'] as const;
export const MAX_POSITION_ITEMS = 50;
// Outlasts the server's 12 s Asset deadline so its degraded reply (kept positions marked stale) reaches the module.
export const POSITIONS_TIMEOUT_MS = 15_000;
export const POSITIONS_CACHE_MS = 20_000;
// Matches the trading center: a scope not re-read within this window is no longer live.
export const POSITIONS_STALE_AFTER_MS = 90_000;
const SUFFIXES = new Set(['', 'USDT', 'USD', 'USDC', 'USD1', 'PERP', 'SWAP', 'USDTSWAP', 'USDTPERP', 'USDCPERP', 'USDSWAP', 'USDPERP']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isMarket = (value: unknown): value is PositionMarket => POSITION_MARKETS.includes(value as PositionMarket);

export function positionsRequest(value: unknown): PositionsRequest | null {
  if (!record(value) || value.type !== 'positions-request') return null;
  const { requestId, market, symbols } = value;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(requestId) || !isMarket(market)) return null;
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 20) return null;
  if (!symbols.every(symbol => typeof symbol === 'string' && /^[A-Z0-9]{1,20}$/.test(symbol))) return null;
  return { requestId, market, symbols: [...new Set(symbols as string[])] };
}

export function openTradingRequest(value: unknown): PositionMarket | null {
  return record(value) && value.type === 'open-trading' && isMarket(value.market) ? value.market : null;
}

// Unicode letters survive normalization so native non-ASCII codes cannot
// collapse into an ASCII contract name.
export function matchBase(symbol: string, bases: readonly string[]): string | null {
  const normalized = symbol.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  let match: string | null = null;
  for (const base of bases) {
    if (normalized.startsWith(base) && SUFFIXES.has(normalized.slice(base.length)) && (!match || base.length > match.length)) match = base;
  }
  return match;
}

class MalformedPositions extends Error {}
const text = (value: unknown) => { if (typeof value !== 'string') throw new MalformedPositions(); return value; };
const optional = (value: unknown) => { if (value !== null && typeof value !== 'string') throw new MalformedPositions(); return value; };
const list = (value: unknown) => { if (!Array.isArray(value)) throw new MalformedPositions(); return value as unknown[]; };
const object = (value: unknown) => { if (!record(value)) throw new MalformedPositions(); return value; };
const CYCLE_STATES = new Set(['loading', 'complete', 'partial', 'unavailable']);
function cycleOf(value: unknown): PositionCycle | null {
  if (value === null) return null;
  const cycle = object(value);
  if (!CYCLE_STATES.has(cycle.status as string)) throw new MalformedPositions();
  const evidence = cycle.evidence === undefined ? undefined : parseCycleEvidence(cycle.evidence);
  if (evidence === null) throw new MalformedPositions();
  return { status: cycle.status as PositionCycle['status'], since: optional(cycle.since), closedQuantity: optional(cycle.closedQuantity), closePrice: optional(cycle.closePrice),
    realizedPnl: optional(cycle.realizedPnl), fees: optional(cycle.fees), funding: optional(cycle.funding), net: optional(cycle.net),
    currency: optional(cycle.currency), note: optional(cycle.note), updatedAt: optional(cycle.updatedAt), ...(evidence ? { evidence } : {}) };
}
const old = (value: string | null, now: number) => value === null || !Number.isFinite(Date.parse(value)) || now - Date.parse(value) > POSITIONS_STALE_AFTER_MS;

// Throws on any shape violation: a partial list must not be reported as complete.
// `incomplete` marks unconfirmed sources/scopes or a capped match list, so a subset
// is never mistaken for the complete set of related positions.
export function positionItems(response: unknown, bases: readonly string[], now: number): { items: HubPositionItem[]; incomplete: boolean; sourcesIncomplete: boolean; truncated: boolean; matchedCount: number; itemLimit: number } {
  const items: HubPositionItem[] = [], seen = new Map<string, number>();
  let sourcesIncomplete = false, matchedCount = 0;
  for (const sourceValue of list(object(response).sources)) {
    const source = object(sourceValue);
    const sourceName = text(source.name), sourceStatus = text(source.status);
    if (source.data === null) { if (sourceStatus === 'unavailable' || sourceStatus === 'stale') sourcesIncomplete = true; continue; }
    for (const exchangeValue of list(object(source.data).exchanges)) {
      const exchange = object(exchangeValue), exchangeId = text(exchange.id), exchangeName = text(exchange.name);
      for (const accountValue of list(exchange.accounts)) {
        for (const scopeValue of list(object(accountValue).scopes)) {
          const scope = object(scopeValue), scopeStatus = text(scope.status), fetchedAt = optional(scope.fetchedAt);
          const positions = list(scope.positions);
          if ((scopeStatus === 'error' || scopeStatus === 'loading') && !positions.length) sourcesIncomplete = true;
          const stale = scopeStatus === 'stale' || scopeStatus === 'error' || sourceStatus === 'stale' || sourceStatus === 'unavailable' || old(fetchedAt, now);
          for (const positionValue of positions) {
            const position = object(positionValue), symbol = text(position.symbol), instrumentId = text(position.instrumentId);
            const side = text(position.side);
            if (side !== 'long' && side !== 'short') throw new MalformedPositions();
            const item = { quantity: text(position.quantity), quantityUnit: text(position.quantityUnit), entryPrice: optional(position.entryPrice),
              markPrice: optional(position.markPrice), unrealizedPnl: optional(position.unrealizedPnl), pnlCurrency: optional(position.pnlCurrency) };
            const base = matchBase(symbol, bases) ?? matchBase(instrumentId, bases);
            if (!base) continue;
            matchedCount++;
            if (items.length >= MAX_POSITION_ITEMS) continue;
            const identity = `${exchangeId}:${symbol}:${side}`, count = (seen.get(identity) ?? 0) + 1;
            seen.set(identity, count);
            // A stable venue id lets the module pair legs without relying on display names.
            const venue = /^[a-z0-9-]{1,40}$/.test(exchangeId) ? { exchangeId } : {};
            const cycle = position.cycle === undefined ? {} : { cycle: cycleOf(position.cycle) };
            items.push({ key: `${identity}:${count}`, source: sourceName, exchange: exchangeName, ...venue, symbol, base, side, ...item, updatedAt: fetchedAt, stale, ...cycle });
          }
        }
      }
    }
  }
  const truncated = matchedCount > MAX_POSITION_ITEMS;
  return { items, incomplete: sourcesIncomplete || truncated, sourcesIncomplete, truncated, matchedCount, itemLimit: MAX_POSITION_ITEMS };
}

/** Markets whose Hyperliquid legs come from the live execution connection (`/api/trading/anthropic`); Asset does not read Hyperliquid positions. */
export const EXECUTION_LEG_MARKETS: readonly PositionMarket[] = ['anthropic'];
const EXECUTION_SOURCE = '套利交易实盘';
const LEG_STATES = new Set(['unconfigured', 'loading', 'live', 'stale', 'error']);
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const decimalText = (value: unknown) => { if (typeof value !== 'string' || !DECIMAL.test(value)) throw new MalformedPositions(); return value; };
const optionalDecimal = (value: unknown) => value === null ? null : decimalText(value);
// Only the fields positionItems reads; the Hyperliquid size is in coin units and the settlement coin is not reported.
function legPosition(value: unknown) {
  const row = object(value), symbol = text(row.symbol), side = text(row.side);
  if (side !== 'long' && side !== 'short') throw new MalformedPositions();
  return { symbol, instrumentId: symbol, side, quantity: decimalText(row.quantity), quantityUnit: symbol.slice(symbol.indexOf(':') + 1) || symbol,
    entryPrice: optionalDecimal(row.entryPrice), markPrice: optionalDecimal(row.markPrice), unrealizedPnl: optionalDecimal(row.unrealizedPnl), pnlCurrency: null };
}
function executionSource(legs: PositionsOutcome) {
  const unavailable = { projectId: 'trading-execution', name: EXECUTION_SOURCE, status: 'unavailable', error: null, checkedAt: null, data: null };
  if (legs.status !== 'ok') return unavailable;
  try {
    const source = list(object(legs.data).sources).map(object).find(item => item.exchange === 'hyperliquid');
    if (!source || source.connected !== true) return null;
    const state = text(source.state), fetchedAt = optional(source.fetchedAt);
    if (!LEG_STATES.has(state)) throw new MalformedPositions();
    const positions = list(source.positions).map(legPosition);
    return { projectId: 'trading-execution', name: EXECUTION_SOURCE, status: 'ready', error: null, checkedAt: fetchedAt, data: { exchanges: [{ id: 'hyperliquid', name: 'Hyperliquid', accounts: [
      { scopes: [{ id: 'perp', status: state, fetchedAt, positions }] }] }] } };
  } catch { return unavailable; }
}
/** Adds the execution connection's legs as one more source; a failed leg read marks only that source unavailable. */
export function withExecutionLegs(positions: PositionsOutcome, legs: PositionsOutcome): PositionsOutcome {
  if (positions.status !== 'ok' || !record(positions.data) || !Array.isArray(positions.data.sources)) return positions;
  const source = executionSource(legs);
  return source ? { ...positions, data: { ...positions.data, sources: [...positions.data.sources, source] } } : positions;
}
export function positionsReply(request: PositionsRequest, outcome: PositionsOutcome, now: number): PositionsReply {
  const failed = (status: 'unavailable' | 'unauthorized', cause: { reason?: UnavailableReason; httpStatus?: number } = {}): PositionsReply => ({ type: 'positions', requestId: request.requestId, market: request.market, status, generatedAt: null, incomplete: false, items: [], ...cause });
  if (outcome.status === 'unauthorized') return failed('unauthorized');
  if (outcome.status === 'unavailable') return failed('unavailable', { ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.httpStatus ? { httpStatus: outcome.httpStatus } : {}) });
  try {
    const selection = positionItems(outcome.data, request.symbols, now);
    const generatedAt = (outcome.data as TradingPositionsResponse).generatedAt;
    return { type: 'positions', requestId: request.requestId, market: request.market, status: 'ok', generatedAt: typeof generatedAt === 'string' && Number.isFinite(Date.parse(generatedAt)) ? generatedAt : null, ...selection };
  } catch (error) {
    if (error instanceof MalformedPositions) return failed('unavailable', { reason: 'malformed' });
    throw error;
  }
}

// api() rejects with a TimeoutError, an error carrying the HTTP status (200 for an unreadable body), or a fetch failure.
export function failedOutcome(error: unknown, at: number): PositionsOutcome {
  const value = error as { name?: unknown; status?: unknown } | null;
  if (value?.status === 401) return { status: 'unauthorized', at };
  if (value?.name === 'TimeoutError') return { status: 'unavailable', at, reason: 'timeout' };
  if (typeof value?.status === 'number' && Number.isInteger(value.status)) {
    return value.status >= 200 && value.status < 300 ? { status: 'unavailable', at, reason: 'malformed' } : { status: 'unavailable', at, reason: 'http', httpStatus: value.status };
  }
  return { status: 'unavailable', at, reason: 'network' };
}

// One in-flight read shared by concurrent requests; every outcome, including
// failures, is held for the cache window so a module cannot drive request rate.
export function createPositionsSource(load: (signal: AbortSignal) => Promise<unknown>, { cacheMs = POSITIONS_CACHE_MS, cacheMsFor = (_outcome: PositionsOutcome) => cacheMs, clock = () => performance.now() } = {}) {
  let cache: PositionsOutcome | null = null, cacheFor = cacheMs, pending: Promise<PositionsOutcome> | null = null, controller: AbortController | null = null;
  const fresh = () => cache && clock() - cache.at < cacheFor ? cache : null;
  return {
    read(allowNetwork: boolean): Promise<PositionsOutcome> {
      const hit = fresh();
      if (hit) return Promise.resolve(hit);
      if (pending) return pending;
      if (!allowNetwork) return Promise.resolve({ status: 'unavailable', at: clock(), reason: 'background' });
      const own = controller = new AbortController();
      const promise: Promise<PositionsOutcome> = load(own.signal).then(
        (data): PositionsOutcome => ({ status: 'ok', data, at: clock() }),
        (error): PositionsOutcome => failedOutcome(error, clock()),
      ).then(outcome => {
        if (controller === own) { cache = own.signal.aborted ? null : outcome; cacheFor = cacheMsFor(outcome); pending = null; controller = null; }
        return outcome;
      });
      pending = promise;
      return promise;
    },
    dispose() { controller?.abort(); controller = null; pending = null; cache = null; },
  };
}

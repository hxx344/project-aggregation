import type { PositionsOutcome } from './hub-positions';

export const FILLS_CAPABILITIES = ['fills'] as const;
export const FILLS_TIMEOUT_MS = 15_000;
export const FILLS_CACHE_MS = 20_000;
// A pending read is polled every few seconds; hold it only briefly so a finished scope shows at once.
export const FILLS_PENDING_CACHE_MS = 3_000;
export const FILLS_STALE_AFTER_MS = 15 * 60_000;
export const MAX_FILL_ITEMS = 2000;
export const FILL_MARKETS = { oil: ['CL', 'BZ'], hynix: ['SKHY', 'SKHYNIX'] } as const;
export type FillMarket = keyof typeof FILL_MARKETS;
export type FillsRequest = { requestId: string; market: FillMarket };
type ScopeStatus = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error' | 'unsupported';
export type HubFillItem = {
  key: string; sourceId: string; source: string; exchangeId: string; exchange: string; accountId: string; account: string; scope: string;
  symbol: string; base: (typeof FILL_MARKETS)[FillMarket][number]; time: string; side: 'buy' | 'sell'; positionSide: 'long' | 'short' | 'net';
  quantity: string; quantityUnit: string; price: string; priceCurrency: 'USDT' | 'USDC';
  fee: string | null; feeCurrency: string | null; realizedPnl: string | null; positionBefore: string | null; positionAfter: string | null; stale: boolean;
};
export type FillCoverage = {
  sourceId: string; source: string; exchangeId: string; exchange: string; account: string; scope: string; status: ScopeStatus;
  fetchedAt: string | null; coverageStart: string | null; coverageEnd: string | null; error: string | null;
};
export type FillsReply = {
  type: 'fills'; requestId: string; market: FillMarket; status: 'ok' | 'unavailable' | 'unauthorized';
  generatedAt: string | null; lookbackStart: string | null; pending: boolean; incomplete: boolean; truncated: boolean;
  coverage: FillCoverage[]; items: HubFillItem[];
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function fillsRequest(value: unknown): FillsRequest | null {
  if (!record(value) || value.type !== 'fills-request' || typeof value.market !== 'string' || !Object.hasOwn(FILL_MARKETS, value.market)
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value.requestId)
    || Object.keys(value).some(key => !['channel', 'version', 'type', 'market', 'requestId'].includes(key))) return null;
  return { requestId: value.requestId, market: value.market as FillMarket };
}

class MalformedFills extends Error {}
const object = (value: unknown) => { if (!record(value)) throw new MalformedFills(); return value; };
const text = (value: unknown): string => { if (typeof value !== 'string') throw new MalformedFills(); return value; };
const optional = (value: unknown): string | null => value === null ? null : text(value);
const list = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new MalformedFills(); return value; };
const flag = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new MalformedFills(); return value; };
function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new MalformedFills();
  return value as T;
}
function timestamp(value: unknown): string | null {
  const result = optional(value);
  if (result !== null && (!/^\d{4}-\d\d-\d\dT/.test(result) || !Number.isFinite(Date.parse(result)))) throw new MalformedFills();
  return result;
}
function decimal(value: unknown, positive = false): string | null {
  const result = optional(value);
  if (result === null ? positive : result.length > 128 || !/^-?\d+(?:\.\d+)?$/.test(result)
    || positive && (result.startsWith('-') || !/[1-9]/.test(result))) throw new MalformedFills();
  return result;
}

export function fillItems(response: unknown, now: number, market: FillMarket = 'oil') {
  const items: HubFillItem[] = [], coverage: FillCoverage[] = [], seen = new Set<string>();
  let pending = false, incomplete = false, truncated = false, lookbackStart: string | null = null;
  for (const sourceValue of list(object(response).sources)) {
    const source = object(sourceValue), sourceName = text(source.name), projectId = text(source.projectId);
    const sourceStatus = enumeration(source.status, ['ready', 'stale', 'unavailable', 'unconfigured']);
    const sourceFailed = sourceStatus === 'stale' || sourceStatus === 'unavailable';
    incomplete ||= sourceFailed;
    if (source.data === null) { incomplete ||= sourceStatus === 'ready'; continue; }
    const data = object(source.data);
    if (data.schemaVersion !== 1) throw new MalformedFills();
    const start = timestamp(data.lookbackStart);
    if (!start) throw new MalformedFills();
    // Across sources, the latest start is the shared lookback boundary.
    if (lookbackStart === null || Date.parse(start) > Date.parse(lookbackStart)) lookbackStart = start;
    for (const exchangeValue of list(data.exchanges)) {
      const exchange = object(exchangeValue), exchangeId = text(exchange.id), exchangeName = text(exchange.name);
      for (const accountValue of list(exchange.accounts)) {
        const account = object(accountValue), accountId = text(account.id), accountName = text(account.name);
        for (const scopeValue of list(account.scopes)) {
          const scope = object(scopeValue), scopeId = text(scope.id);
          const status = enumeration(scope.status, ['unconfigured', 'loading', 'live', 'stale', 'error', 'unsupported'] as const);
          const fetchedAt = timestamp(scope.fetchedAt), coverageStart = timestamp(scope.coverageStart), coverageEnd = timestamp(scope.coverageEnd);
          const old = fetchedAt === null || now - Date.parse(fetchedAt) > FILLS_STALE_AFTER_MS;
          const stale = sourceFailed || status === 'stale' || status === 'error' || old;
          const refreshing = flag(scope.refreshing);
          pending ||= status === 'loading' || refreshing;
          // Validate flags even when the accumulated result is already true.
          const scopeTruncated = flag(scope.truncated);
          truncated ||= scopeTruncated;
          incomplete ||= scopeTruncated || sourceFailed || status === 'stale' || status === 'error' || status === 'live' && old;
          const coverageStatus = status === 'live' && stale ? 'stale' : status;
          const error = coverageStatus === 'unsupported' ? 'Asset 暂不支持此产品范围的成交读取'
            : coverageStatus === 'error' ? 'Asset 读取此范围失败，请在 Asset 检查连接与权限'
              : coverageStatus === 'stale' ? '成交数据已过期，等待 Asset 更新' : null;
          coverage.push({ sourceId: projectId, source: sourceName, exchangeId, exchange: exchangeName, account: accountName, scope: scopeId,
            status: coverageStatus, fetchedAt, coverageStart, coverageEnd, error });
          for (const fillValue of list(scope.fills)) {
            const fill = object(fillValue), base = enumeration(fill.base, FILL_MARKETS[market]);
            const priceCurrency = enumeration(fill.priceCurrency, ['USDT', 'USDC'] as const), symbol = text(fill.symbol);
            const symbols = exchangeId === 'okx' ? [`${base}-USDT-SWAP`]
              : exchangeId === 'binance' ? [`${base}USDT`]
                : exchangeId === 'bybit' ? [base + priceCurrency, ...(priceCurrency === 'USDC' ? [base + 'PERP'] : [])] : [];
            if (!symbols.includes(symbol) || exchangeId !== 'bybit' && priceCurrency !== 'USDT') throw new MalformedFills();
            const time = timestamp(fill.time);
            if (!time) throw new MalformedFills();
            const key = [projectId, exchangeId, accountId, scopeId, text(fill.id)].map(encodeURIComponent).join('|');
            if (seen.has(key)) throw new MalformedFills();
            seen.add(key);
            const positionBefore = decimal(fill.positionBefore), positionAfter = decimal(fill.positionAfter);
            if ((positionBefore === null) !== (positionAfter === null)) throw new MalformedFills();
            incomplete ||= positionBefore === null || positionAfter === null;
            items.push({ key, sourceId: projectId, source: sourceName, exchangeId, exchange: exchangeName, accountId, account: accountName, scope: scopeId,
              symbol, base, time, side: enumeration(fill.side, ['buy', 'sell'] as const), positionSide: enumeration(fill.positionSide, ['long', 'short', 'net'] as const),
              quantity: decimal(fill.quantity, true)!, quantityUnit: enumeration(fill.quantityUnit, [exchangeId === 'okx' ? '张' : base]), price: decimal(fill.price, true)!, priceCurrency,
              fee: decimal(fill.fee), feeCurrency: optional(fill.feeCurrency), realizedPnl: decimal(fill.realizedPnl), positionBefore, positionAfter, stale });
          }
        }
      }
    }
  }
  items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.key.localeCompare(b.key));
  if (items.length > MAX_FILL_ITEMS) { truncated = true; incomplete = true; items.length = MAX_FILL_ITEMS; }
  return { items, coverage, lookbackStart, pending, incomplete, truncated };
}

export function fillsReply(request: FillsRequest, outcome: PositionsOutcome, now: number): FillsReply {
  const failed = (status: 'unavailable' | 'unauthorized'): FillsReply => ({ type: 'fills', ...request, status, generatedAt: null, lookbackStart: null,
    pending: false, incomplete: true, truncated: false, coverage: [], items: [] });
  if (outcome.status !== 'ok') return failed(outcome.status);
  try {
    return { type: 'fills', ...request, status: 'ok', generatedAt: timestamp(object(outcome.data).generatedAt), ...fillItems(outcome.data, now, request.market) };
  } catch (error) {
    if (error instanceof MalformedFills) return failed('unavailable');
    throw error;
  }
}

/** Malformed data is left to fillsReply to reject; here it only counts as not pending. */
export function fillsCacheMs(outcome: PositionsOutcome) {
  const items = (value: unknown, key: string) => record(value) && Array.isArray(value[key]) ? value[key] as unknown[] : [];
  const pending = outcome.status === 'ok' && items(outcome.data, 'sources').some(source => record(source) && items(source.data, 'exchanges')
    .some(exchange => items(exchange, 'accounts').some(account => items(account, 'scopes')
      .some(scope => record(scope) && (scope.status === 'loading' || scope.refreshing === true)))));
  return pending ? FILLS_PENDING_CACHE_MS : FILLS_CACHE_MS;
}

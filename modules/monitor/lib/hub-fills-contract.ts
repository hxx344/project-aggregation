import { createHubRequester, HUB_REQUEST_ID, type RequestTimers } from './hub-requester.ts';

export type HubFillItem = {
  key: string; sourceId: string; source: string; exchangeId: string; exchange: string; accountId: string; account: string; scope: string;
  symbol: string; base: 'CL' | 'BZ'; time: string; side: 'buy' | 'sell'; positionSide: 'long' | 'short' | 'net';
  quantity: string; quantityUnit: string; price: string; priceCurrency: 'USDT' | 'USDC';
  fee: string | null; feeCurrency: string | null; realizedPnl: string | null;
  positionBefore: string | null; positionAfter: string | null; stale: boolean;
};
export type FillCoverage = {
  sourceId: string; source: string; exchangeId: string; exchange: string; account: string; scope: string;
  status: 'unconfigured' | 'loading' | 'live' | 'stale' | 'error' | 'unsupported' | 'ready' | 'unavailable';
  fetchedAt: string | null; coverageStart: string | null; coverageEnd: string | null; error: string | null;
};
export type HubFillsReply = {
  requestId: string; market: 'oil'; status: 'ok' | 'unavailable' | 'unauthorized';
  generatedAt: string | null; lookbackStart: string | null; pending: boolean; incomplete: boolean; truncated: boolean;
  coverage: FillCoverage[]; items: HubFillItem[]; timedOut?: boolean;
};
export type HubFillsView = Omit<HubFillsReply, 'requestId' | 'market' | 'status'> & {
  status: HubFillsReply['status'] | 'standalone' | 'connecting' | 'unsupported' | 'loading';
  retained: boolean;
};
export const FILLS_TIMEOUT_MS = 20_000, FILLS_REFRESH_MS = 300_000, FILLS_FOLLOW_UP_MS = 25_000;
export const FILLS_MAX_FOLLOW_UPS = 6;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const sourceIdentity = (value: unknown) => { const id = text(value); return id && id.trim() === id ? id : undefined; };
const decimal = (value: unknown, positive = false) => typeof value === 'string' && value.length <= 160 && /^-?\d+(?:\.\d+)?$/.test(value) && (!positive || !value.startsWith('-') && /[1-9]/.test(value)) ? value : undefined;
const optionalDecimal = (value: unknown) => value === null ? null : decimal(value);
const iso = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : undefined;
const optionalIso = (value: unknown) => value === null ? null : iso(value);
const currency = (value: unknown) => typeof value === 'string' && /^[A-Z0-9]{1,20}$/.test(value) ? value : undefined;
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined;
function parseItem(value: unknown): HubFillItem | null {
  const v = record(value); if (!v) return null;
  const result = {
    key: text(v.key, 600), sourceId: sourceIdentity(v.sourceId), source: text(v.source), exchangeId: text(v.exchangeId, 40), exchange: text(v.exchange),
    accountId: text(v.accountId), account: text(v.account), scope: text(v.scope, 80), symbol: text(v.symbol, 80),
    base: v.base === 'CL' || v.base === 'BZ' ? v.base : undefined,
    time: iso(v.time), side: v.side === 'buy' || v.side === 'sell' ? v.side : undefined,
    positionSide: ['long', 'short', 'net'].includes(String(v.positionSide)) ? v.positionSide : undefined,
    quantity: decimal(v.quantity, true), quantityUnit: text(v.quantityUnit, 40), price: decimal(v.price, true),
    priceCurrency: v.priceCurrency === 'USDT' || v.priceCurrency === 'USDC' ? v.priceCurrency : undefined,
    fee: optionalDecimal(v.fee), feeCurrency: v.feeCurrency === null ? null : currency(v.feeCurrency),
    realizedPnl: optionalDecimal(v.realizedPnl), positionBefore: optionalDecimal(v.positionBefore), positionAfter: optionalDecimal(v.positionAfter),
    stale: bool(v.stale),
  };
  if (Object.values(result).some(field => field === undefined)) return null;
  if (!['binance', 'bybit', 'okx'].includes(result.exchangeId!)) return null;
  if (result.exchangeId !== 'bybit' && result.priceCurrency !== 'USDT') return null;
  const expected = result.exchangeId === 'okx' ? `${result.base}-${result.priceCurrency}-SWAP` : `${result.base}${result.priceCurrency}`;
  const usdcPerpetual = result.exchangeId === 'bybit' && result.priceCurrency === 'USDC' && result.symbol === `${result.base}PERP`;
  if (result.symbol !== expected && !usdcPerpetual || result.quantityUnit !== (result.exchangeId === 'okx' ? '张' : result.base)) return null;
  if ((result.positionBefore === null) !== (result.positionAfter === null)) return null;
  return result as HubFillItem;
}
function parseCoverage(value: unknown): FillCoverage | null {
  const v = record(value); if (!v) return null;
  const result = {
    sourceId: sourceIdentity(v.sourceId), source: text(v.source), exchangeId: text(v.exchangeId, 40), exchange: text(v.exchange), account: text(v.account), scope: text(v.scope, 80),
    status: ['unconfigured', 'loading', 'live', 'stale', 'error', 'unsupported', 'ready', 'unavailable'].includes(String(v.status)) ? v.status : undefined,
    fetchedAt: optionalIso(v.fetchedAt), coverageStart: optionalIso(v.coverageStart), coverageEnd: optionalIso(v.coverageEnd),
    // The host has already redacted upstream errors; do not pass unknown fields.
    error: v.error === null ? null : text(v.error, 300),
  };
  return Object.values(result).some(field => field === undefined) ? null : result as FillCoverage;
}
export function parseFillsReply(value: unknown): HubFillsReply | null {
  const v = record(value);
  if (!v || v.type !== 'fills' || typeof v.requestId !== 'string' || !HUB_REQUEST_ID.test(v.requestId) || v.market !== 'oil') return null;
  if (v.status !== 'ok' && v.status !== 'unavailable' && v.status !== 'unauthorized') return null;
  const generatedAt = optionalIso(v.generatedAt), lookbackStart = optionalIso(v.lookbackStart);
  if (generatedAt === undefined || lookbackStart === undefined || [v.pending, v.incomplete, v.truncated].some(flag => typeof flag !== 'boolean')) return null;
  if (!Array.isArray(v.items) || v.items.length > 2000 || !Array.isArray(v.coverage) || v.coverage.length > 2000) return null;
  const items = v.items.map(parseItem), coverage = v.coverage.map(parseCoverage);
  if (items.some(item => !item) || coverage.some(item => !item) || new Set(items.map(item => item!.key)).size !== items.length) return null;
  const ok = v.status === 'ok';
  return {
    requestId: v.requestId, market: 'oil', status: v.status, generatedAt: ok ? generatedAt : null, lookbackStart: ok ? lookbackStart : null,
    pending: ok && v.pending as boolean, incomplete: ok && v.incomplete as boolean, truncated: ok && v.truncated as boolean,
    items: ok ? (items as HubFillItem[]).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)) : [], coverage: ok ? coverage as FillCoverage[] : [],
  };
}
export const emptyFillsView = (status: HubFillsView['status']): HubFillsView => ({
  status, items: [], coverage: [], generatedAt: null, lookbackStart: null, pending: false, incomplete: false, truncated: false, retained: false, timedOut: false,
});
export function retainFillsReply(current: HubFillsView | null, reply: HubFillsReply): HubFillsView {
  if (reply.status === 'ok') return { ...reply, retained: false };
  if (current?.status === 'ok' || current?.retained) return { ...current, status: reply.status, pending: false, retained: true, timedOut: Boolean(reply.timedOut) };
  return { ...reply, retained: false };
}
export function createFillsRequester(options: RequestTimers & {
  send: (message: { type: 'fills-request'; requestId: string; market: 'oil' }) => void;
  onReply: (reply: HubFillsReply) => void;
}) {
  const requester = createHubRequester<{ market: 'oil' }, HubFillsReply>({
    ...options, timeoutMs: options.timeoutMs ?? FILLS_TIMEOUT_MS, parse: parseFillsReply, market: query => query.market,
    send: (query, requestId) => options.send({ type: 'fills-request', requestId, ...query }),
    timeout: (query, requestId) => ({ ...emptyFillsView('unavailable'), status: 'unavailable', ...query, requestId, timedOut: true }),
  });
  return { ...requester, request: (market: 'oil') => requester.request(market === 'oil' ? { market } : null) };
}

/** Pending reads get at most six follow-ups before returning to the regular refresh cadence. */
export function createFillsPoller(options: Parameters<typeof createFillsRequester>[0], market: 'oil') {
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout;
  let regular: unknown = null, followUp: unknown = null, followUpCount = 0, started = false;
  const clearFollowUp = () => { if (followUp !== null) cancel(followUp as never); followUp = null; };
  const requester = createFillsRequester({
    ...options,
    onReply(reply) {
      clearFollowUp();
      if (!reply.pending) followUpCount = 0;
      if (reply.status === 'ok' && reply.pending && followUpCount < FILLS_MAX_FOLLOW_UPS) {
        followUp = schedule(() => {
          followUp = null;
          if (!started) return;
          followUpCount++; requester.request(market);
        }, FILLS_FOLLOW_UP_MS);
      }
      options.onReply(reply);
    },
  });
  const run = () => {
    if (!started) return;
    clearFollowUp(); followUpCount = 0; requester.request(market);
    regular = schedule(run, FILLS_REFRESH_MS);
  };
  return {
    start() { if (!started) { started = true; run(); } },
    receive: requester.receive, retry: requester.retry,
    dispose() {
      started = false;
      if (regular !== null) cancel(regular as never);
      regular = null; clearFollowUp(); requester.dispose();
    },
  };
}

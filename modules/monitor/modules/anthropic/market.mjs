import { requestBinance } from '../oil/binance.mjs';
import { requestInfo } from '../oil/hyperliquid.mjs';

/**
 * Anthropic pre-IPO perpetuals on Binance, Hyperliquid and rh-Lighter quote different units, so every
 * comparison is per share. Shares per native unit mirror the trading page defaults
 * (src/trading-anthropic.ts DEFAULT_SHARES, server/trading-execution-plan.mjs SHARE_BASIS):
 * Binance quotes valuation per 1B outstanding shares (12.7B outstanding -> 12.7 shares per unit),
 * Entropy io:ANTH per 1B fully diluted shares (16.7B -> 16.7 shares), trade.xyz xyz:ANT is one share.
 * rh-Lighter (Lighter on Robinhood Chain, an independent order book collateralised in USDG) quotes
 * Pre-IPO markets as valuation per 1B assumed shares and settles after an IPO at
 * share price x fully diluted shares / 1B, so one unit is 16.7 shares like io:ANTH.
 * https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets
 * These are listing assumptions, not exchange facts; a different share count shifts the premium.
 */
export const ANTHROPIC_SHARES = Object.freeze({ outstanding: 12.7, diluted: 16.7 });
export const ANTHROPIC_LEGS = Object.freeze({
  binance: Object.freeze({ exchange: 'binance', symbol: 'ANTHROPICUSDT', name: 'Binance', venue: 'Binance', label: 'Binance ANTHROPICUSDT', sharesPerUnit: ANTHROPIC_SHARES.outstanding, basis: '流通股 127 亿' }),
  xyz: Object.freeze({ exchange: 'hyperliquid', symbol: 'xyz:ANT', dex: 'xyz', name: 'xyz:ANT', venue: 'Hyperliquid', label: 'Hyperliquid xyz:ANT', sharesPerUnit: 1, basis: '1 股' }),
  io: Object.freeze({ exchange: 'hyperliquid', symbol: 'io:ANTH', dex: 'io', name: 'io:ANTH', venue: 'Hyperliquid', label: 'Hyperliquid io:ANTH', sharesPerUnit: ANTHROPIC_SHARES.diluted, basis: '完全稀释 167 亿股' }),
  rh: Object.freeze({ exchange: 'rh-lighter', symbol: 'ANTHROPIC', name: 'rh-Lighter', venue: 'rh-Lighter', label: 'rh-Lighter ANTHROPIC', sharesPerUnit: ANTHROPIC_SHARES.diluted, basis: '完全稀释 167 亿股' }),
});
/**
 * @typedef {'xyz' | 'io' | 'rh'} AnthropicComparisonLeg
 * @typedef {'binance' | AnthropicComparisonLeg} AnthropicLegKey
 * @typedef {{ markPx: number, fundingRate: number | null, nextFundingTime: number | null }} BinanceLegQuote
 * @typedef {{ markPx: number, fundingRate: number | null, oraclePx: number | null }} HyperliquidLegQuote
 * @typedef {{ markPx: number, fundingRate: number | null, indexPx: number | null }} RhLighterLegQuote
 * @typedef {{ fetchedAt: string, binance: BinanceLegQuote | null, xyz: HyperliquidLegQuote | null, io: HyperliquidLegQuote | null, rh: RhLighterLegQuote | null, errors: Partial<Record<AnthropicLegKey, string>> }} AnthropicQuote
 * @typedef {{ time: number, binance: number | null, xyz: number | null, io: number | null, rh: number | null }} AnthropicCandleRow
 * @typedef {{ source: string, symbols: string[], interval: '15m', timezone: 'UTC', priceBasis: string, fetchedAt: string, firstObservation: string, lastObservation: string, rows: number, errors: Partial<Record<AnthropicLegKey, string>> }} AnthropicCandleMetadata
 * @typedef {{ status: 'live' | 'snapshot', metadata: AnthropicCandleMetadata, data: AnthropicCandleRow[] }} AnthropicCandles
 */
/** Hyperliquid legs, read through the shared Hyperliquid info endpoint. */
/** @type {readonly ('xyz' | 'io')[]} */
export const HYPERLIQUID_LEGS = Object.freeze(['xyz', 'io']);
/** Legs compared against Binance; the first is the default. */
/** @type {readonly AnthropicComparisonLeg[]} */
export const ANTHROPIC_COMPARISON_LEGS = Object.freeze([...HYPERLIQUID_LEGS, 'rh']);
/** @type {readonly AnthropicLegKey[]} */
export const ANTHROPIC_LEG_KEYS = Object.freeze(['binance', ...ANTHROPIC_COMPARISON_LEGS]);
const LEG_KEYS = ANTHROPIC_LEG_KEYS;
const SYMBOLS = LEG_KEYS.map(key => ANTHROPIC_LEGS[key].symbol);
export const ANTHROPIC_SOURCE = 'Binance + Hyperliquid + rh-Lighter';
/** Candle snapshots saved before the rh-Lighter leg existed; they validate with that leg empty. */
const LEGACY_CANDLE_SOURCE = Object.freeze({ source: 'Binance + Hyperliquid', symbols: JSON.stringify(['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH']) });
export const ANTHROPIC_QUOTE_REFRESH_MS = 10_000;
export const ANTHROPIC_CANDLE_ACTION = 'candles/15m';
export const ANTHROPIC_CANDLE_MS = 900_000;
export const ANTHROPIC_CANDLE_REFRESH_MS = 60_000;
/** Hyperliquid serves only its latest 5000 candles (about 52 days of 15-minute bars); the first read starts there. */
export const ANTHROPIC_INITIAL_DAYS = 50;
/** Saved history is trimmed to this many days, which also bounds a windowed read. */
export const ANTHROPIC_RETENTION_DAYS = 400;
const DAY_MS = 86_400_000, OVERLAP_BARS = 96, BINANCE_PAGE = 1500, BINANCE_MAX_PAGES = 40;
/**
 * rh-Lighter returns at most 500 candles per request. Pages per candle round are capped because the
 * Standard tier allows 60 REST requests per minute per IP, shared with the perpetual scanner; a
 * backfill longer than one round continues from the last saved close on the next round.
 * https://docs.lighter.xyz/developers/reference/rate-limits.md
 */
const RH_PAGE = 500, RH_MAX_PAGES = 4, RH_COOLDOWN_MS = 60_000;
const RH_API = 'https://api.rh.lighter.xyz';

const record = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid Anthropic object'); return value; };
const positive = value => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) throw Error('Invalid Anthropic price');
  return Number(value);
};
const rate = value => {
  if (value === null || value === undefined || value === '') return null;
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1) throw Error('Invalid Anthropic funding rate');
  return Number(value);
};
const stamp = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error('Invalid Anthropic timestamp'); return value; };

class VenueCooldown extends Error {
  constructor(venue, status) { super(`${venue} HTTP ${status} cooldown`); this.status = status; }
}

/** Short Chinese reason for a failed leg read; never echoes upstream bodies. */
export function legError(error) {
  if (error instanceof VenueCooldown) return `接口限流冷却中（HTTP ${error.status}）`;
  const message = String(error?.message ?? '');
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return http[1] === '451' ? '服务器所在地区被拒绝访问（HTTP 451）' : `接口返回 HTTP ${http[1]}`;
  if (/delisted/.test(message)) return '合约已下架';
  if (/missing/.test(message)) return '合约缺失';
  if (/ambiguous/.test(message)) return '合约目录出现多个同名合约';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return '请求超时';
  return '响应无效或网络失败';
}

/** Per-share price of a native quote. @param {AnthropicLegKey} leg @param {number} price */
export const perShare = (leg, price) => price / ANTHROPIC_LEGS[leg].sharesPerUnit;
/**
 * Binance per-share premium over a comparison leg, in percent; null when either side is missing.
 * @param {number | null | undefined} binance @param {number | null | undefined} other @param {AnthropicComparisonLeg} leg
 * @returns {number | null}
 */
export function anthropicPremium(binance, other, leg) {
  if (!binance || !other || !(binance > 0) || !(other > 0)) return null;
  const value = (perShare('binance', binance) / perShare(leg, other) - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

function validateLegQuote(key, value) {
  if (value === null) return null;
  const item = record(value);
  const result = { markPx: positive(item.markPx), fundingRate: rate(item.fundingRate) };
  if (key === 'binance') {
    const next = item.nextFundingTime ?? null;
    if (next !== null && !Number.isSafeInteger(next)) throw Error('Invalid Binance funding time');
    return { ...result, nextFundingTime: next };
  }
  if (key === 'rh') return { ...result, indexPx: item.indexPx == null ? null : positive(item.indexPx) };
  return { ...result, oraclePx: item.oraclePx == null ? null : positive(item.oraclePx) };
}

/**
 * Each leg is either a quote or null with a reason; at least one leg must be present.
 * Quotes saved before a leg existed read that leg as missing.
 * @param {unknown} input
 * @returns {AnthropicQuote}
 */
export function validateAnthropicQuote(input) {
  const quote = record(input), fetchedAt = stamp(quote.fetchedAt), errors = record(quote.errors ?? {});
  /** @type {any} */
  const result = { fetchedAt, errors: {} };
  for (const key of LEG_KEYS) {
    result[key] = validateLegQuote(key, quote[key] ?? null);
    const error = errors[key];
    if (error !== undefined && (typeof error !== 'string' || error.length > 200)) throw Error('Invalid Anthropic leg error');
    if (result[key] === null) result.errors[key] = error ?? '暂无报价';
  }
  if (LEG_KEYS.every(key => result[key] === null)) throw Error('No Anthropic quote');
  return result;
}

/**
 * Binance answers requests made while rate limited (429) with an escalating IP ban (418) that would
 * also stop the oil and Hynix Binance reads, so after either status this module sends no Binance
 * request for 60 s (429) or 120 s (418), mirroring lib/binance-quote-request.ts defaults.
 * One gate serves the quote and candle jobs and reads the wall clock when a request is sent or
 * fails (a candle backfill can page for a minute); tests pass their own gate and clock.
 */
export const createBinanceGate = () => ({ until: 0, status: 0 });
const sharedBinanceGate = createBinanceGate();
async function binanceRequest(path, params, { gate = sharedBinanceGate, clock = Date.now, ...options }) {
  if (clock() < gate.until) throw new VenueCooldown('Binance', gate.status);
  try { return await requestBinance(path, params, options); }
  catch (error) {
    const status = Number(/Binance HTTP (418|429)$/.exec(String(error?.message ?? ''))?.[1]);
    if (status) { gate.until = Math.max(gate.until, clock() + (status === 418 ? 120_000 : 60_000)); gate.status = status; }
    throw error;
  }
}

async function readBinanceQuote(options) {
  const item = record(await binanceRequest('/fapi/v1/premiumIndex', { symbol: ANTHROPIC_LEGS.binance.symbol }, options));
  if (item.symbol !== ANTHROPIC_LEGS.binance.symbol) throw Error('Unexpected Binance symbol');
  return { markPx: positive(item.markPrice), fundingRate: rate(item.lastFundingRate), nextFundingTime: Number.isSafeInteger(item.nextFundingTime) && item.nextFundingTime > 0 ? item.nextFundingTime : null };
}

async function readHyperliquidQuote(key, options) {
  const leg = ANTHROPIC_LEGS[key], response = await requestInfo({ type: 'metaAndAssetCtxs', dex: leg.dex }, options);
  if (!Array.isArray(response) || response.length !== 2 || !Array.isArray(response[0]?.universe) || !Array.isArray(response[1])) throw Error('Invalid Hyperliquid response');
  const index = response[0].universe.findIndex(asset => asset?.name === leg.symbol);
  if (index < 0 || !response[1][index]) throw Error('Hyperliquid market missing');
  // A delisted market keeps its last mark price; it must not read as a live quote.
  if (response[0].universe[index].isDelisted) throw Error('Hyperliquid market delisted');
  const context = record(response[1][index]);
  return { markPx: positive(context.markPx), fundingRate: rate(context.funding), oraclePx: context.oraclePx ? positive(context.oraclePx) : null };
}

/**
 * rh-Lighter request state shared by the quote and candle jobs: a 60 s cooldown after HTTP 429 or 405,
 * and the market found in the public catalog. The market id is never hard-coded: it is looked up by
 * symbol and type, kept until a single-market read stops matching, and then looked up again.
 * @typedef {{ id: number, listedAt: number | null }} RhLighterMarket
 * @typedef {{ until: number, status: number, market: RhLighterMarket | null, discovery: Promise<any> | null }} RhLighterState
 * @returns {RhLighterState}
 */
export const createRhLighterState = () => ({ until: 0, status: 0, market: null, discovery: null });
const sharedRhState = createRhLighterState();

/** Same REST format as Lighter mainnet on a separate deployment with its own market ids: https://apidocs.rh.lighter.xyz */
async function rhRequest(path, params, { rh = sharedRhState, clock = Date.now, fetcher = fetch, timeout = 10_000 }) {
  if (clock() < rh.until) throw new VenueCooldown('rh-Lighter', rh.status);
  const url = new URL(path, RH_API);
  url.search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const response = await fetcher(url.href, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    if (response.status === 429 || response.status === 405) { rh.until = Math.max(rh.until, clock() + RH_COOLDOWN_MS); rh.status = response.status; }
    throw Object.assign(Error(`rh-Lighter HTTP ${response.status}`), { status: response.status });
  }
  const body = record(await response.json());
  if (body.code !== 200) throw Error('Invalid rh-Lighter response code');
  return body;
}

const rhListedAt = item => {
  const created = Number(item.created_at);
  return Number.isSafeInteger(created) && created > 0 ? created : null;
};
/** A catalog row is usable only when it is the active ANTHROPIC perpetual. */
function rhActive(item, rh) {
  if (item.status !== 'active') { rh.market = null; throw Error('rh-Lighter market delisted'); }
  return item;
}

/** Full catalog read (about 70 perpetuals, one request); concurrent jobs share one discovery. */
async function discoverRhMarket(options) {
  const rh = options.rh ?? sharedRhState;
  rh.discovery ??= (async () => {
    try {
      // https://docs.lighter.xyz/api/orders/orderbookdetails.md
      const body = await rhRequest('/api/v1/orderBookDetails', {}, options);
      if (!Array.isArray(body.order_book_details)) throw Error('Invalid rh-Lighter catalog');
      const matches = body.order_book_details.filter(item => item?.symbol === ANTHROPIC_LEGS.rh.symbol && item.market_type === 'perp');
      if (matches.length > 1) throw Error('rh-Lighter market ambiguous');
      if (!matches.length) throw Error('rh-Lighter market missing');
      const item = record(matches[0]);
      if (!Number.isSafeInteger(item.market_id) || item.market_id < 0) throw Error('Invalid rh-Lighter market id');
      rhActive(item, rh);
      rh.market = { id: item.market_id, listedAt: rhListedAt(item) };
      return item;
    } finally { rh.discovery = null; }
  })();
  return rh.discovery;
}

/** One request: the cached market's details, or the catalog when no market is cached. */
async function readRhQuote(options) {
  const rh = options.rh ?? sharedRhState;
  let item;
  if (!rh.market) item = await discoverRhMarket(options);
  else {
    const id = rh.market.id;
    let body;
    try { body = await rhRequest('/api/v1/orderBookDetails', { market_id: id }, options); }
    catch (error) {
      // An unknown market index answers HTTP 400; look the symbol up again next round.
      if (error?.status === 400) { rh.market = null; throw Error('rh-Lighter market missing'); }
      throw error;
    }
    const rows = body.order_book_details;
    item = Array.isArray(rows) && rows.length === 1 ? record(rows[0]) : null;
    if (!item || item.market_id !== id || item.symbol !== ANTHROPIC_LEGS.rh.symbol || item.market_type !== 'perp') { rh.market = null; throw Error('rh-Lighter market missing'); }
    rhActive(item, rh);
    rh.market = { id, listedAt: rhListedAt(item) };
  }
  // The catalog carries no current funding rate, and a second request per round would exceed the
  // rate budget, so funding stays unknown rather than estimated.
  const index = typeof item.index_price === 'string' && item.index_price.trim() === '' ? NaN : Number(item.index_price);
  return { markPx: positive(item.mark_price), fundingRate: null, indexPx: Number.isFinite(index) && index > 0 ? index : null };
}

/** One quote round; a failed leg keeps its reason so the page can say which venue is missing. Each request times out after 10 s. */
export async function fetchAnthropicQuote({ fetcher = fetch, now = Date.now(), timeout = 10_000, gate = sharedBinanceGate, rh = sharedRhState, clock = Date.now } = {}) {
  const options = { fetcher, timeout, gate, rh, clock };
  const reads = await Promise.allSettled([readBinanceQuote(options), ...HYPERLIQUID_LEGS.map(key => readHyperliquidQuote(key, options)), readRhQuote(options)]);
  const quote = { fetchedAt: new Date(now).toISOString(), errors: {} };
  LEG_KEYS.forEach((key, index) => {
    const read = reads[index];
    quote[key] = read.status === 'fulfilled' ? read.value : null;
    if (read.status === 'rejected') quote.errors[key] = legError(read.reason);
  });
  return validateAnthropicQuote(quote);
}

/**
 * @param {unknown[]} rows
 * @param {string} fetchedAt
 * @param {'live' | 'snapshot'} status
 * @returns {AnthropicCandles}
 */
export function createAnthropicCandles(rows, fetchedAt, status = 'live', errors = {}) {
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received) || !['live', 'snapshot'].includes(status) || !Array.isArray(rows) || !rows.length || rows.length > 100_000) throw Error('Invalid Anthropic candle snapshot');
  let previous = -1;
  const data = rows.map(input => {
    const row = record(input);
    if (!Number.isSafeInteger(row.time) || row.time % ANTHROPIC_CANDLE_MS || row.time + ANTHROPIC_CANDLE_MS > received || row.time <= previous) throw Error('Invalid Anthropic candle time');
    previous = row.time;
    /** @type {any} */
    const result = { time: row.time };
    for (const key of LEG_KEYS) result[key] = row[key] === null || row[key] === undefined ? null : positive(row[key]);
    if (LEG_KEYS.every(key => result[key] === null)) throw Error('Empty Anthropic candle');
    return result;
  });
  // Legs whose latest candle read failed; their saved closes are kept but stop advancing until a read succeeds.
  const legErrors = {};
  for (const [key, error] of Object.entries(record(errors))) {
    if (!LEG_KEYS.includes(/** @type {any} */ (key)) || typeof error !== 'string' || !error || error.length > 200) throw Error('Invalid Anthropic candle leg error');
    legErrors[key] = error;
  }
  return { status, metadata: { source: ANTHROPIC_SOURCE, symbols: SYMBOLS, interval: '15m', timezone: 'UTC', priceBasis: 'Completed 15-minute trade candle closes', fetchedAt, firstObservation: new Date(data[0].time).toISOString(), lastObservation: new Date(data.at(-1).time).toISOString(), rows: data.length, errors: legErrors }, data };
}

/**
 * Snapshots saved before the rh-Lighter leg existed are accepted and returned in the current shape with that leg empty.
 * @param {unknown} input @returns {AnthropicCandles}
 */
export function validateAnthropicCandles(input) {
  const value = record(input), metadata = record(value.metadata), symbols = JSON.stringify(metadata.symbols);
  const current = metadata.source === ANTHROPIC_SOURCE && symbols === JSON.stringify(SYMBOLS);
  const legacy = metadata.source === LEGACY_CANDLE_SOURCE.source && symbols === LEGACY_CANDLE_SOURCE.symbols;
  if (!(current || legacy) || metadata.interval !== '15m' || metadata.timezone !== 'UTC') throw Error('Unexpected Anthropic candle source');
  const snapshot = createAnthropicCandles(/** @type {unknown[]} */ (value.data), /** @type {string} */ (metadata.fetchedAt), /** @type {'live' | 'snapshot'} */ (value.status), metadata.errors ?? {});
  for (const field of ['firstObservation', 'lastObservation', 'rows']) if (snapshot.metadata[field] !== metadata[field]) throw Error('Anthropic candle metadata mismatch');
  return snapshot;
}

/** Rows opening within `days` before the last row; `coverage` keeps the complete history's range. */
export function anthropicCandleWindow(snapshot, days) {
  const { data, metadata } = validateAnthropicCandles(snapshot);
  const start = Date.parse(metadata.lastObservation) - days * DAY_MS;
  if (data[0].time >= start) return snapshot;
  const window = createAnthropicCandles(data.filter(row => row.time >= start), metadata.fetchedAt, snapshot.status, metadata.errors);
  return { ...snapshot, ...window, windowDays: days, coverage: { firstObservation: metadata.firstObservation, lastObservation: metadata.lastObservation, rows: metadata.rows } };
}

async function binanceCandles(startTime, endTime, options) {
  const result = new Map();
  let cursor = startTime;
  for (let page = 0; page < BINANCE_MAX_PAGES && cursor <= endTime; page++) {
    const rows = await binanceRequest('/fapi/v1/klines', { symbol: ANTHROPIC_LEGS.binance.symbol, interval: '15m', startTime: cursor, endTime, limit: BINANCE_PAGE }, options);
    if (!Array.isArray(rows)) throw Error('Invalid Binance candle page');
    let last = cursor - 1;
    for (const row of rows) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] <= last || row[0] % ANTHROPIC_CANDLE_MS || row[6] !== row[0] + ANTHROPIC_CANDLE_MS - 1) throw Error('Invalid Binance candle');
      last = row[0];
      if (row[6] < endTime) result.set(row[0], positive(row[4]));
    }
    if (rows.length < BINANCE_PAGE) return result;
    cursor = last + ANTHROPIC_CANDLE_MS;
  }
  if (cursor <= endTime) throw Error('Binance candle pagination exceeded its limit');
  return result;
}

async function hyperliquidCandles(key, startTime, endTime, options) {
  const rows = await requestInfo({ type: 'candleSnapshot', req: { coin: ANTHROPIC_LEGS[key].symbol, interval: '15m', startTime, endTime } }, options);
  if (!Array.isArray(rows)) throw Error('Invalid Hyperliquid candles');
  const result = new Map();
  let last = -1;
  for (const row of rows) {
    if (!row || row.s !== ANTHROPIC_LEGS[key].symbol || row.i !== '15m' || !Number.isSafeInteger(row.t) || row.t <= last || row.t % ANTHROPIC_CANDLE_MS || row.T !== row.t + ANTHROPIC_CANDLE_MS - 1) throw Error('Invalid Hyperliquid candle');
    last = row.t;
    if (row.T < endTime) result.set(row.t, positive(row.c));
  }
  return result;
}

/**
 * Forward pages of at most 500 completed bars. Measured on 2026-11-07: `t` is the bar open in
 * milliseconds, rows ascend, bars opening at or after `end_timestamp` are excluded, and a request
 * returns the latest max(bars in range, count_back) bars before `end_timestamp`, capped at 500.
 * Responses are CDN-cached by a key that ignores `start_timestamp`, so `count_back` always equals the
 * page's bar count to keep each request's answer unambiguous.
 * https://docs.lighter.xyz/api/candlesticks/candles.md
 */
async function rhCandles(startTime, endTime, options) {
  const rh = options.rh ?? sharedRhState;
  if (!rh.market) await discoverRhMarket(options);
  const market = /** @type {RhLighterMarket} */ (rh.market);
  const closedEnd = Math.floor(endTime / ANTHROPIC_CANDLE_MS) * ANTHROPIC_CANDLE_MS;
  // Bars before the market existed are always empty pages; starting there would spend the round's page budget.
  const listed = market.listedAt === null ? startTime : Math.floor(market.listedAt / ANTHROPIC_CANDLE_MS) * ANTHROPIC_CANDLE_MS;
  let cursor = Math.max(startTime, listed);
  const result = new Map();
  for (let page = 0; page < RH_MAX_PAGES && cursor < closedEnd; page++) {
    const end = Math.min(cursor + RH_PAGE * ANTHROPIC_CANDLE_MS, closedEnd), count = (end - cursor) / ANTHROPIC_CANDLE_MS;
    const body = await rhRequest('/api/v1/candles', { market_id: market.id, resolution: '15m', start_timestamp: cursor, end_timestamp: end, count_back: count }, options);
    if (body.r !== '15m' || !Array.isArray(body.c) || body.c.length > RH_PAGE) throw Error('Invalid rh-Lighter candles');
    let last = -1;
    for (const row of body.c) {
      if (!row || !Number.isSafeInteger(row.t) || row.t <= last || row.t % ANTHROPIC_CANDLE_MS || row.t >= end) throw Error('Invalid rh-Lighter candle');
      last = row.t;
      if (row.t >= cursor) result.set(row.t, positive(row.c));
    }
    cursor = end;
  }
  return result;
}

/**
 * Resume each leg from its own last saved close (overlapping one day), so one venue's outage
 * never leaves a permanent gap. A failed leg keeps its saved closes; the round fails only when
 * every leg fails. Each request times out after 15 s; the collector retries on its next tick.
 * @param {unknown} [existing]
 * @param {{ fetcher?: typeof fetch, now?: number, timeout?: number, gate?: { until: number, status: number }, rh?: RhLighterState, clock?: () => number }} [options]
 */
export async function fetchAnthropicCandles(existing = null, { fetcher = fetch, now = Date.now(), timeout = 15_000, gate = sharedBinanceGate, rh = sharedRhState, clock = Date.now } = {}) {
  const previous = existing ? validateAnthropicCandles(existing) : null, options = { fetcher, timeout, gate, rh, clock };
  const firstStart = Math.floor((now - ANTHROPIC_INITIAL_DAYS * DAY_MS) / ANTHROPIC_CANDLE_MS) * ANTHROPIC_CANDLE_MS;
  const startOf = key => {
    const last = previous?.data.findLast(row => row[key] !== null);
    return last ? last.time - OVERLAP_BARS * ANTHROPIC_CANDLE_MS : previous ? Math.min(previous.data[0].time, firstStart) : firstStart;
  };
  const read = key => key === 'binance' ? binanceCandles(startOf(key), now, options) : key === 'rh' ? rhCandles(startOf(key), now, options) : hyperliquidCandles(key, startOf(key), now, options);
  const reads = await Promise.allSettled(LEG_KEYS.map(read));
  if (reads.every(read => read.status === 'rejected')) throw reads[0].reason;
  const merged = new Map((previous?.data ?? []).map(row => [row.time, { ...row }])), errors = {};
  LEG_KEYS.forEach((key, index) => {
    const read = reads[index];
    if (read.status !== 'fulfilled') { errors[key] = legError(read.reason); return; }
    for (const [time, close] of read.value) {
      const row = merged.get(time) ?? Object.fromEntries([['time', time], ...LEG_KEYS.map(leg => [leg, null])]);
      row[key] = close;
      merged.set(time, row);
    }
  });
  const cutoff = now - ANTHROPIC_RETENTION_DAYS * DAY_MS;
  const rows = [...merged.values()].filter(row => row.time >= cutoff).sort((a, b) => a.time - b.time);
  return createAnthropicCandles(rows, new Date(now).toISOString(), 'live', errors);
}

/**
 * Chart rows against one comparison leg: A = Binance per share, B = the leg per share; rows missing either are skipped.
 * @param {AnthropicCandleRow[]} rows
 * @param {AnthropicComparisonLeg} leg
 * @returns {{ time: number, adr: number, ordinary: number, equivalent: number, spread: number, premium: number }[]}
 */
export function anthropicChartRows(rows, leg) {
  return rows.flatMap(row => {
    const binance = row.binance, other = row[leg];
    if (binance === null || other === null) return [];
    const adr = perShare('binance', binance), equivalent = perShare(leg, other);
    return [{ time: row.time, adr, ordinary: other, equivalent, spread: adr - equivalent, premium: (adr / equivalent - 1) * 100 }];
  });
}

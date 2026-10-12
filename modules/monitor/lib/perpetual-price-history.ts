import type { FundingHistoryPairRequest } from './perpetual-funding-history.ts';
import { backgroundReadDelay } from './read-activity.ts';

export const PRICE_HOUR_MS = 3_600_000;
export const PRICE_HISTORY_LOOKBACK_MS = 30 * 24 * PRICE_HOUR_MS;
export const PRICE_HISTORY_STALE_MS = 75 * 60_000;
export type PriceHistoryDays = 3 | 7 | 30;
export interface PerpetualPricePoint { time: number; close: number }
export interface PerpetualPriceLeg {
  key: string;
  identity: string;
  exchange: string;
  symbol: string;
  currency: string;
  status: 'pending' | 'ready' | 'error' | 'unsupported';
  fetchedAt: number | null;
  /** Successfully scanned (from,to] hour-end timestamps; missing candles stay missing. */
  from: number | null;
  to: number | null;
  points: PerpetualPricePoint[];
  error: string;
  backfillComplete: boolean;
}
export interface PerpetualPriceHistoryReport {
  schemaVersion: 1;
  generatedAt: number;
  intervalMs: number;
  legs: Record<string, PerpetualPriceLeg>;
  storageError?: string;
}
interface PriceMarketIdentity {
  exchange: string; symbol: string; base: string; quoteCurrency: string;
  marketId?: number; multiplier?: number; contractUnit?: string; collateralCurrency?: string;
}
export const perpetualPriceIdentity = (market: PriceMarketIdentity) => JSON.stringify([market.exchange, market.symbol, market.base, market.quoteCurrency, market.marketId ?? null, market.multiplier ?? 1, market.contractUnit ?? null, market.collateralCurrency ?? null]);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= Date.UTC(2020, 0, 1);
const hour = (value: unknown): value is number => time(value) && value % PRICE_HOUR_MS === 0;

/** Validate untrusted transport/cache records before a chart can consume them. */
export function validatePerpetualPriceHistory(value: unknown, now = Date.now()): value is PerpetualPriceHistoryReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as PerpetualPriceHistoryReport;
  if (report.schemaVersion !== 1 || report.intervalMs !== PRICE_HOUR_MS || !time(report.generatedAt) || report.generatedAt > now + 5000 || !report.legs || typeof report.legs !== 'object' || Array.isArray(report.legs) || Object.keys(report.legs).length > 2 || (report.storageError !== undefined && typeof report.storageError !== 'string')) return false;
  return Object.entries(report.legs).every(([key, leg]) => {
    if (!leg || typeof leg !== 'object' || typeof leg.exchange !== 'string' || typeof leg.symbol !== 'string' || key !== `${leg.exchange}:${leg.symbol}` || leg.key !== key || key.length > 200 || typeof leg.identity !== 'string' || !leg.identity || leg.identity.length > 2000 || !['USD', 'USDT', 'USDC', 'USD1', 'USDG'].includes(leg.currency) || !['pending', 'ready', 'error', 'unsupported'].includes(leg.status) || typeof leg.error !== 'string' || typeof leg.backfillComplete !== 'boolean' || !Array.isArray(leg.points) || leg.points.length > 720) return false;
    try {
      const identity = JSON.parse(leg.identity);
      if (!Array.isArray(identity) || identity.length !== 8 || identity[0] !== leg.exchange || identity[1] !== leg.symbol || typeof identity[2] !== 'string' || identity[3] !== leg.currency || !Number.isFinite(identity[5]) || identity[5] <= 0) return false;
    } catch { return false; }
    if (leg.fetchedAt !== null && (!time(leg.fetchedAt) || leg.fetchedAt > report.generatedAt)) return false;
    if (leg.from === null || leg.to === null) return leg.from === null && leg.to === null && leg.fetchedAt === null && leg.points.length === 0 && leg.status !== 'ready' && !leg.backfillComplete;
    if (!hour(leg.from) || !hour(leg.to) || leg.from >= leg.to || leg.to > report.generatedAt || leg.to - leg.from > PRICE_HISTORY_LOOKBACK_MS || leg.fetchedAt === null || leg.to > leg.fetchedAt || (leg.backfillComplete && leg.to - leg.from !== PRICE_HISTORY_LOOKBACK_MS)) return false;
    let previous = leg.from;
    return leg.points.every(point => {
      if (!point || !hour(point.time) || point.time <= previous || point.time > leg.to! || typeof point.close !== 'number' || !Number.isFinite(point.close) || point.close <= 0 || point.close > 1e20) return false;
      previous = point.time; return true;
    });
  });
}

export function priceHistoryIsStale(report: PerpetualPriceHistoryReport | null, now = Date.now()) {
  return Boolean(report && Object.values(report.legs).some(leg => leg.points.length > 0 && (leg.status === 'error' || leg.fetchedAt === null || now - leg.fetchedAt > PRICE_HISTORY_STALE_MS || leg.to === null || now - leg.to > PRICE_HISTORY_STALE_MS)));
}

interface PriceFeedOptions {
  load: (pair: FundingHistoryPairRequest, days: PriceHistoryDays, signal: AbortSignal) => Promise<unknown>;
  onData: (report: PerpetualPriceHistoryReport | null) => void;
  onError: (message: string) => void;
  onLoading: (value: boolean) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** One active HTTP read; pair generations isolate late results, even when an
 * injected loader ignores abort. Days and direction reuse the same raw legs. */
export function startPerpetualPriceHistoryFeed(options: PriceFeedOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const cache = new Map<string, { report: PerpetualPriceHistoryReport; nextAt: number }>();
  let pair: FundingHistoryPairRequest | null = null, days: PriceHistoryDays = 7, selection = '', generation = 0;
  let active = false, stopped = false, timer: unknown, request: { controller: AbortController; generation: number; timeout: unknown } | null = null;
  const keyOf = (value: FundingHistoryPairRequest | null) => value ? JSON.stringify([value.base, ...[value.longKey, value.shortKey].sort()]) : '';
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function abort() { if (!request) return; const pending = request; request = null; cancel(pending.timeout); pending.controller.abort(); }
  function publish() { options.onData(cache.get(selection)?.report ?? null); }
  function next() {
    clearTimer();
    if (stopped || !active || !pair || request) return;
    const wait = Math.max(0, (cache.get(selection)?.nextAt ?? 0) - now());
    if (wait > 0) { timer = schedule(() => { timer = undefined; void read(); }, backgroundReadDelay(wait)); return; }
    void read();
  }
  async function read() {
    if (stopped || !active || !pair || request) return;
    const selected = selection, requestedPair = pair, controller = new AbortController();
    let timedOut = false;
    const pending = { controller, generation, timeout: schedule(() => { timedOut = true; controller.abort(); }, 12_000) };
    request = pending; options.onLoading(true);
    const current = () => !stopped && active && generation === pending.generation && selection === selected && request === pending;
    try {
      const result = await Promise.race([options.load(requestedPair, days, controller.signal), new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Error('Price read aborted')), { once: true }))]);
      if (!current() || controller.signal.aborted) return;
      if (!validatePerpetualPriceHistory(result, now())) throw Error('Invalid price history');
      const keys = [requestedPair.longKey, requestedPair.shortKey];
      if (Object.keys(result.legs).length !== 2 || keys.some(key => !Object.hasOwn(result.legs, key) || JSON.parse(result.legs[key].identity)[2] !== requestedPair.base)) throw Error('Price history selection mismatch');
      const old = cache.get(selected)?.report;
      if (old && result.generatedAt < old.generatedAt) throw Error('Price history response regressed');
      const legs = Object.fromEntries(keys.map(key => {
        const incoming = result.legs[key], previous = old?.legs[key];
        // An identity change intentionally drops old prices. Failed refreshes
        // may retain only an unchanged identity's previously validated data.
        return [key, previous && previous.identity === incoming.identity && incoming.points.length === 0 && ['pending', 'error'].includes(incoming.status) && previous.points.length ? { ...previous, status: incoming.status, error: incoming.error } : incoming];
      }));
      const report = { ...result, legs };
      const waiting = Object.values(legs).some(leg => leg.status === 'pending');
      cache.delete(selected); cache.set(selected, { report, nextAt: now() + backgroundReadDelay(waiting ? 3000 : 60_000) });
      while (cache.size > 20) cache.delete(cache.keys().next().value!);
      options.onError(''); options.onData(report);
    } catch {
      if (!current() || (controller.signal.aborted && !timedOut)) return;
      const previous = cache.get(selected);
      if (previous) previous.nextAt = now() + backgroundReadDelay(60_000);
      options.onError('成交价历史更新失败，保留已取得的数据。');
      // An empty first read also backs off; it must not recurse immediately.
      timer = schedule(() => { timer = undefined; void read(); }, backgroundReadDelay(60_000));
    } finally {
      cancel(pending.timeout);
      if (request === pending) { request = null; options.onLoading(false); if (timer === undefined) next(); }
    }
  }
  return {
    setSelection(value: FundingHistoryPairRequest | null, windowDays: PriceHistoryDays) {
      days = windowDays;
      const key = keyOf(value); pair = value;
      if (key === selection || stopped) return;
      generation++; selection = key; clearTimer(); abort(); options.onLoading(false); options.onError(''); publish(); next();
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value; generation++; clearTimer();
      if (!active) { abort(); options.onLoading(false); return; }
      publish(); next();
    },
    refresh() { if (!active || stopped) return; clearTimer(); const entry = cache.get(selection); if (entry) entry.nextAt = Math.min(entry.nextAt, now()); next(); },
    stop() { stopped = true; active = false; generation++; clearTimer(); abort(); },
  };
}

import { createPerpetualMetricsReader, sanitizePerpetualMetricsReaderState } from './perpetual-metrics-reader.mjs';
import { PERPETUAL_MARKET_METRICS_REFRESH_MS } from '../lib/perpetual-market-metrics.ts';
import { setImmediate as yieldToIO } from 'node:timers/promises';

const keyOf = market => `${market.exchange}:${market.symbol}`;
const IDENTITY_FIELDS = ['exchange', 'symbol', 'base', 'rawBase', 'quoteCurrency', 'marketId', 'multiplier', 'contractSize', 'dex', 'contractUnit', 'collateralCurrency', 'settlementCurrency', 'counterCurrency', 'productType', 'contractKind', 'assetClass'];
export const perpetualMetricsIdentity = market => JSON.stringify(['market-metrics-v1', ...IDENTITY_FIELDS.map(field => market[field] ?? null)]);
const hostOf = exchange => exchange === 'entropy' ? 'hyperliquid' : exchange;
const FAILURE_RETRY_MAX_MS = 300_000, RATE_LIMIT_MAX_MS = 900_000, UNSUPPORTED_RETRY_MS = 3_600_000, MAX_READS_PER_TURN = 30;
const invalid = () => Object.assign(Error('合约指标请求必须包含至多 30 个有效的当前合约组合'), { status: 400 });
const emptyMetric = () => ({ value: null, currency: null, observedAt: null, source: '', error: '' });
const empty = market => ({ key: keyOf(market), exchange: market.exchange, symbol: market.symbol, identity: perpetualMetricsIdentity(market), status: 'pending', fetchedAt: null, volume24h: emptyMetric(), openInterest: emptyMetric(), error: '' });
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value, now) => Number.isSafeInteger(value) && value >= 1e12 && value <= now + 5000;
const message = value => typeof value === 'string' ? value.slice(0, 500) : '';

function normalizeMetric(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.source !== 'string' || typeof raw.error !== 'string') throw Error('合约指标金额格式无效');
  const value = raw.value, currency = raw.currency, observedAt = raw.observedAt;
  if (value === null) {
    if (currency !== null || observedAt !== null) throw Error('空指标不能附带金额单位或时间');
  } else if (!nonnegative(value) || typeof currency !== 'string' || !/^[A-Z0-9]{2,12}$/.test(currency) || !timestamp(observedAt, now)) throw Error('合约指标金额、单位或时间无效');
  return { value, currency, observedAt, source: message(raw.source), error: message(raw.error) };
}
function retain(previous, next) {
  if (previous.value !== null && next.value === null) return { ...previous, error: next.error || '更新未返回有效金额，保留上次数据' };
  if (previous.value !== null && next.value !== null && next.observedAt < previous.observedAt) return { ...previous, error: '接口返回较旧快照，保留上次数据' };
  return next;
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}

/** Registrations survive browser departure and process restart. Reads validate a
 * whole pair batch before mutating anything and never await the upstream API. */
export function createPerpetualMarketMetricsService({ getSnapshot, getMarket = () => null, store, clock = Date.now, reader = createPerpetualMetricsReader({ clock }), cacheLimit = 500, maxConcurrent = 3, hostSpacingMs = 350, intervalMs = 1000 } = {}) {
  cacheLimit = Math.max(1, Math.min(500, Number.isInteger(cacheLimit) ? cacheLimit : 500));
  maxConcurrent = Math.max(1, Math.min(8, Number.isInteger(maxConcurrent) ? maxConcurrent : 3));
  const cache = new Map(), jobs = new Set(), busyHosts = new Set(), hostUntil = new Map(), hostBackoffUntil = new Map();
  let running = false, initialized = false, timer, collection, storageError = '';
  function savedEntry(raw) {
    const now = clock();
    try {
      if (!raw || typeof raw !== 'object' || !raw.market || typeof raw.market.exchange !== 'string' || typeof raw.market.symbol !== 'string' || raw.key !== keyOf(raw.market) || raw.identity !== perpetualMetricsIdentity(raw.market)) return null;
      const value = raw.value;
      if (!value || value.key !== raw.key || value.exchange !== raw.market.exchange || value.symbol !== raw.market.symbol || value.identity !== raw.identity || !['pending', 'ready', 'error', 'unsupported'].includes(value.status) || (value.fetchedAt !== null && !timestamp(value.fetchedAt, now))) return null;
      const volume24h = normalizeMetric(value.volume24h, now), openInterest = normalizeMetric(value.openInterest, now);
      if ((volume24h.value !== null || openInterest.value !== null) && value.fetchedAt === null) return null;
      const hostRetryAt = nonnegative(raw.hostRetryAt) ? Math.min(raw.hostRetryAt, now + RATE_LIMIT_MAX_MS) : 0;
      const retryLimit = value.status === 'unsupported' ? now + UNSUPPORTED_RETRY_MS : value.status === 'error' ? now + RATE_LIMIT_MAX_MS
        : (value.fetchedAt ?? now) + PERPETUAL_MARKET_METRICS_REFRESH_MS;
      return { key: raw.key, identity: raw.identity, market: structuredClone(raw.market), value: { ...value, volume24h, openInterest, error: message(value.error) },
        retryAt: Math.max(hostRetryAt, nonnegative(raw.retryAt) ? Math.min(raw.retryAt, retryLimit) : 0), hostRetryAt,
        failures: Number.isInteger(raw.failures) ? Math.min(5, Math.max(0, raw.failures)) : 0,
        lastAccessAt: nonnegative(raw.lastAccessAt) ? Math.min(now, raw.lastAccessAt) : now,
        readerState: sanitizePerpetualMetricsReaderState(raw.readerState, raw.market, now), controller: null, dirty: false, storageRetryAt: 0 };
    } catch { return null; }
  }
  function flush(entry, force = false) {
    if (!entry.dirty || !store?.saveContractMetrics || (!force && clock() < (entry.storageRetryAt ?? 0))) return;
    try {
      const { key, identity, market, value, retryAt, hostRetryAt, failures, lastAccessAt, readerState } = entry;
      store.saveContractMetrics({ key, identity, market, value, retryAt, failures, lastAccessAt, ...(hostRetryAt ? { hostRetryAt } : {}), ...(readerState ? { readerState } : {}) });
      entry.dirty = false; entry.storageRetryAt = 0;
      if (![...cache.values()].some(value => value.dirty)) storageError = '';
    } catch { entry.storageRetryAt = clock() + 5000; storageError = '合约指标仍可读取，持久缓存写入失败'; }
  }
  function persist(entry) {
    if (!store?.saveContractMetrics) return;
    entry.dirty = true; flush(entry);
  }
  function load(key) {
    try { const rows = store?.loadContractMetrics?.(key, cacheLimit); return Array.isArray(rows) ? rows.slice(0, cacheLimit).map(savedEntry).filter(Boolean) : []; } catch { storageError = '持久指标缓存读取失败，正在重新采集'; return []; }
  }
  function initialize() {
    if (initialized) return; initialized = true;
    for (const entry of load()) if (cache.size < cacheLimit && !cache.has(entry.key)) {
      cache.set(entry.key, entry);
      const host = hostOf(entry.market.exchange);
      hostBackoffUntil.set(host, Math.max(hostBackoffUntil.get(host) ?? 0, entry.hostRetryAt ?? 0));
    }
  }
  function prune(protectedKeys) {
    const candidates = [...cache].filter(([key, entry]) => !entry.controller && !entry.dirty && !protectedKeys.has(key)).sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
    while (cache.size >= cacheLimit && candidates.length) cache.delete(candidates.shift()[0]);
  }
  function catalogFor(entry) {
    const catalog = getMarket(entry.market.exchange, entry.market.symbol);
    if (!catalog || catalog.exchange !== entry.market.exchange || catalog.symbol !== entry.market.symbol) return null;
    // Quotes provide the visible identity. Catalog metadata provides contract
    // units and ids. Ignore transient prices/funding in both fingerprints.
    const market = { ...catalog };
    return perpetualMetricsIdentity(market) === entry.identity ? market : null;
  }
  function holdHost(host, until) {
    if (!nonnegative(until) || until <= clock()) return;
    const bounded = Math.min(until, clock() + RATE_LIMIT_MAX_MS);
    hostBackoffUntil.set(host, Math.max(hostBackoffUntil.get(host) ?? 0, bounded));
    // Persist the ban with every registered contract on the host, including
    // peers that did not issue the failing request. Restart cannot bypass it.
    for (const entry of cache.values()) if (hostOf(entry.market.exchange) === host) {
      entry.hostRetryAt = Math.max(entry.hostRetryAt ?? 0, bounded);
      entry.retryAt = Math.max(entry.retryAt, entry.hostRetryAt); persist(entry);
    }
  }
  async function collectTurn() {
    if (!running) return;
    for (const entry of cache.values()) flush(entry);
    // Oldest due work keeps its place when a host cannot serve every contract
    // within one refresh interval. A completed entry rejoins behind that work.
    const scheduled = [...cache.values()].sort((a, b) => a.retryAt - b.retryAt), visited = new Set(), networkHosts = new Set();
    let reads = 0;
    while (running && reads < MAX_READS_PER_TURN) {
      const launched = [];
      for (const entry of scheduled) {
      const now = clock(), host = hostOf(entry.market.exchange);
      if (jobs.size >= maxConcurrent || reads >= MAX_READS_PER_TURN) break;
      if (visited.has(entry) || cache.get(entry.key) !== entry || entry.controller || now < entry.retryAt || busyHosts.has(host) || now < (hostBackoffUntil.get(host) ?? 0)) continue;
      const market = catalogFor(entry);
      if (!market) continue;
      const cacheHit = reader.isCached?.(market) === true;
      if (!cacheHit && (networkHosts.has(host) || now < (hostUntil.get(host) ?? 0))) continue;
      const controller = new AbortController(); entry.controller = controller; entry.market = market;
      visited.add(entry); reads++; busyHosts.add(host);
      if (!cacheHit) { networkHosts.add(host); hostUntil.set(host, now + hostSpacingMs); }
      const job = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return abortable(reader(market, { signal: controller.signal, readerState: entry.readerState }), controller.signal);
      }).then(result => {
        if (!running || controller.signal.aborted || cache.get(entry.key) !== entry || !catalogFor(entry)) return;
        const completed = clock(), volume24h = normalizeMetric(result?.volume24h, completed), openInterest = normalizeMetric(result?.openInterest, completed);
        const hasFresh = volume24h.value !== null || openInterest.value !== null;
        entry.value = { ...entry.value, status: hasFresh ? 'ready' : 'error', fetchedAt: hasFresh ? completed : entry.value.fetchedAt,
          volume24h: retain(entry.value.volume24h, volume24h), openInterest: retain(entry.value.openInterest, openInterest), error: hasFresh ? '' : '本合约暂未取得有效指标' };
        entry.readerState = sanitizePerpetualMetricsReaderState(result?.readerState, market, completed) ?? entry.readerState;
        entry.retryAt = completed + PERPETUAL_MARKET_METRICS_REFRESH_MS; entry.failures = 0;
        holdHost(host, reader.retryAt?.(market)); persist(entry);
      }).catch(error => {
        if (!running || controller.signal.aborted || cache.get(entry.key) !== entry || !catalogFor(entry)) return;
        const unsupported = error?.code === 'UNSUPPORTED', reason = unsupported ? message(error.message) : '本合约指标更新失败，稍后重试';
        entry.value = { ...entry.value, status: unsupported ? 'unsupported' : 'error', error: reason, volume24h: { ...entry.value.volume24h, error: reason }, openInterest: { ...entry.value.openInterest, error: reason } };
        entry.retryAt = clock() + (unsupported ? UNSUPPORTED_RETRY_MS : Math.min(FAILURE_RETRY_MAX_MS, 60_000 * 2 ** Math.min(entry.failures++, 3)));
        if ([418, 429].includes(error?.status)) holdHost(host, clock() + Math.max(60_000, Math.min(RATE_LIMIT_MAX_MS, nonnegative(error.retryAfterMs) ? error.retryAfterMs : 60_000)));
        holdHost(host, reader.retryAt?.(market));
        persist(entry);
      }).finally(() => { if (entry.controller === controller) entry.controller = null; busyHosts.delete(host); jobs.delete(job); });
      jobs.add(job); launched.push(job);
      }
      if (!launched.length) break;
      // Cached projections settle in this event-loop turn. Never wait for a
      // slow network leg to release unrelated hosts or the next timer tick.
      await yieldToIO();
    }
  }
  function collect() {
    // Timer ticks and new registrations share one bounded drain.
    if (!collection) collection = collectTurn().finally(() => { collection = undefined; });
    return collection;
  }
  return {
    start() { if (running) return; initialize(); running = true; timer = setInterval(() => { void collect(); }, intervalMs); timer.unref?.(); queueMicrotask(() => { void collect(); }); },
    async stop() { running = false; clearInterval(timer); for (const entry of cache.values()) entry.controller?.abort(); reader.stop?.(); await Promise.allSettled([...jobs]); for (const entry of cache.values()) flush(entry, true); },
    collect,
    read(input) {
      if (!input || !Array.isArray(input.pairs) || input.pairs.length > 30) throw invalid();
      const quotes = new Map((getSnapshot()?.quotes ?? []).map(quote => [keyOf(quote), quote])), requested = new Map();
      for (const pair of input.pairs) {
        if (!pair || typeof pair.base !== 'string' || !pair.base || pair.base.length > 100 || typeof pair.longKey !== 'string' || pair.longKey.length > 200 || typeof pair.shortKey !== 'string' || pair.shortKey.length > 200) throw invalid();
        const long = quotes.get(pair.longKey), short = quotes.get(pair.shortKey);
        if (!long || !short || long.exchange === short.exchange || long.base !== pair.base || short.base !== pair.base || long.comparable === false || short.comparable === false) throw invalid();
        for (const quote of [long, short]) {
          const catalog = getMarket(quote.exchange, quote.symbol);
          if (!catalog || ['exchange', 'symbol', 'base', 'quoteCurrency'].some(field => catalog[field] !== quote[field])) throw invalid();
          if (IDENTITY_FIELDS.some(field => Object.hasOwn(quote, field) && Object.hasOwn(catalog, field) && quote[field] !== catalog[field])) throw invalid();
          if (catalog.comparable === false || (catalog.delistingAt && catalog.delistingAt <= clock())) throw invalid();
          const market = { ...catalog }; requested.set(keyOf(market), market);
        }
      }
      initialize();
      const now = clock(), legs = Object.create(null), protectedKeys = new Set(requested.keys());
      let registered = false;
      for (const [key, market] of requested) {
        let entry = cache.get(key), identity = perpetualMetricsIdentity(market);
        if (entry && entry.identity !== identity) { entry.controller?.abort(); cache.delete(key); entry = null; }
        if (!entry) {
          prune(protectedKeys);
          if (cache.size >= cacheLimit) { legs[key] = { ...empty(market), error: '指标缓存队列繁忙，稍后重试' }; continue; }
          entry = load(key).find(row => row.key === key && row.identity === identity) ?? { key, identity, market, value: empty(market), retryAt: 0, failures: 0, lastAccessAt: now, controller: null };
          const host = hostOf(market.exchange);
          entry.hostRetryAt = Math.max(entry.hostRetryAt ?? 0, hostBackoffUntil.get(host) ?? 0);
          entry.retryAt = Math.max(entry.retryAt, entry.hostRetryAt);
          hostBackoffUntil.set(host, Math.max(hostBackoffUntil.get(host) ?? 0, entry.hostRetryAt));
          cache.set(key, entry); entry.lastAccessAt = now; entry.market = market; persist(entry);
          registered = true;
        }
        entry.lastAccessAt = now; entry.market = market;
        legs[key] = structuredClone(entry.value);
      }
      if (running && registered) queueMicrotask(() => { void collect(); });
      return { schemaVersion: 1, generatedAt: now, legs, ...(storageError ? { storageError } : {}) };
    },
    metrics: () => ({ cached: cache.size, inFlight: jobs.size, storageError }),
  };
}

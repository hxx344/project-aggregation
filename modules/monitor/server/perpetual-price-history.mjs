import { createPerpetualPriceReader } from './perpetual-price-reader.mjs';
import { perpetualPriceIdentity, validatePerpetualPriceHistory, PRICE_HOUR_MS as HOUR, PRICE_HISTORY_LOOKBACK_MS as LOOKBACK } from '../lib/perpetual-price-history.ts';

const keyOf = market => `${market.exchange}:${market.symbol}`;
const hostOf = exchange => exchange === 'entropy' ? 'hyperliquid' : exchange;
const invalid = () => Object.assign(Error('成交价历史请求必须包含一个有效的当前合约组合，以及 3、7 或 30 天窗口。'), { status: 400 });
const empty = market => ({ key: keyOf(market), identity: perpetualPriceIdentity(market), exchange: market.exchange, symbol: market.symbol, currency: market.quoteCurrency, status: 'pending', fetchedAt: null, from: null, to: null, points: [], error: '', backfillComplete: false });
const reportOf = (legs, now) => ({ schemaVersion: 1, generatedAt: now, intervalMs: HOUR, legs });
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Selected contracts register short leases; reads never await network history.
 * Recent 3d loads first, then bounded 7d pages complete one reusable 30d cache.
 * Only a new closed hour is refreshed. Cache identity is catalog-derived. */
export function createPerpetualPriceHistoryService({ getSnapshot, getMarket, store, clock = Date.now, reader, cacheLimit = 100, maxConcurrent = 2, hostSpacingMs = 350, activeLeaseMs = 10 * 60_000 } = {}) {
  reader ??= createPerpetualPriceReader({ clock, requestSpacingMs: hostSpacingMs });
  maxConcurrent = Math.max(1, Math.min(2, Math.trunc(maxConcurrent) || 2));
  const cache = new Map(), jobs = new Set(), busyHosts = new Set(), hostUntil = new Map();
  let running = false, timer, storageError = '';
  function freshEntry(market, now) {
    return { key: keyOf(market), identity: perpetualPriceIdentity(market), market, value: empty(market), lastAccessAt: now, activeUntil: now + activeLeaseMs, nextAt: 0, failures: 0, controller: null, dirty: false };
  }
  function restore(saved, market, now) {
    if (!saved || saved.key !== keyOf(market) || saved.identity !== perpetualPriceIdentity(market) || saved.value?.identity !== saved.identity || !validatePerpetualPriceHistory(reportOf({ [saved.key]: saved.value }, now), now)) return null;
    return { ...freshEntry(market, now), value: saved.value, nextAt: Number.isFinite(saved.nextAt) ? Math.min(saved.nextAt, now + 300_000) : 0 };
  }
  function persist(entry) {
    if (!entry.dirty) return;
    try {
      store?.savePriceHistory?.({ key: entry.key, identity: entry.identity, value: entry.value, lastAccessAt: entry.lastAccessAt, nextAt: entry.nextAt });
      entry.dirty = false; storageError = '';
    } catch { storageError = '成交价缓存保存失败，当前保留内存记录。'; }
  }
  function prune(protectedKeys) {
    if (cache.size < cacheLimit) return;
    const removable = [...cache.values()].filter(entry => !entry.controller && !entry.dirty && !protectedKeys.has(entry.key)).sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    while (cache.size >= cacheLimit && removable.length) cache.delete(removable.shift().key);
  }
  function currentMarket(entry) {
    const market = getMarket?.(entry.market.exchange, entry.market.symbol);
    return market && keyOf(market) === entry.key && market.comparable !== false && perpetualPriceIdentity(market) === entry.identity ? market : null;
  }
  function taskFor(entry, now) {
    const to = Math.floor(now / HOUR) * HOUR, from = to - LOOKBACK, value = entry.value;
    if (value.to === null || value.to <= from) return { from: to - 72 * HOUR, to, replace: true };
    if (value.to < to) return { from: Math.max(from, value.to - HOUR), to: Math.min(to, value.to + 168 * HOUR), replace: false };
    if (value.from > from) return { from: Math.max(from, value.from - 168 * HOUR), to: value.from, replace: false };
    return null;
  }
  function accept(entry, incoming, task) {
    const now = clock();
    if (!Array.isArray(incoming) || incoming.length > 720) throw Error('成交价历史记录无效');
    const from = task.replace || entry.value.from === null ? task.from : Math.min(task.from, entry.value.from);
    const to = task.replace || entry.value.to === null ? task.to : Math.max(task.to, entry.value.to);
    const keptFrom = Math.max(from, to - LOOKBACK);
    const combined = new Map((task.replace ? [] : entry.value.points).map(point => [point.time, point.close]));
    const verified = new Map();
    for (const point of incoming) {
      if (!point || !Number.isSafeInteger(point.time) || point.time % HOUR || point.time <= task.from || point.time > task.to || !Number.isFinite(point.close) || point.close <= 0 || point.close > 1e20) throw Error('成交价历史记录无效');
      if (verified.has(point.time) && verified.get(point.time) !== point.close) throw Error('成交价历史同批记录冲突');
      verified.set(point.time, point.close);
    }
    // A later official response may revise a closed candle. Only validated
    // points inside this task's range replace cached values; contradictory
    // duplicates within one response still reject the entire batch atomically.
    for (const [time, close] of verified) combined.set(time, close);
    const complete = to - keptFrom === LOOKBACK;
    const value = { ...entry.value, status: complete ? 'ready' : 'pending', fetchedAt: now, from: keptFrom, to, points: [...combined].filter(([time]) => time > keptFrom && time <= to).sort(([a], [b]) => a - b).map(([time, close]) => ({ time, close })), error: '', backfillComplete: complete };
    if (!validatePerpetualPriceHistory(reportOf({ [entry.key]: value }, now), now)) throw Error('成交价历史验证失败');
    entry.value = value; entry.failures = 0; entry.nextAt = complete ? now + 60_000 : 0; entry.dirty = true; persist(entry);
  }
  async function collect() {
    if (!running) return;
    const launched = [], now = clock();
    for (const entry of [...cache.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt)) {
      persist(entry);
      if (entry.controller || now < entry.nextAt || now > entry.activeUntil) continue;
      if (!currentMarket(entry)) {
        // Identity changes invalidate both old values and outstanding work;
        // only a new authorized read may register the new identity.
        cache.delete(entry.key); continue;
      }
      const task = taskFor(entry, now), host = hostOf(entry.market.exchange);
      if (!task || busyHosts.has(host) || now < (hostUntil.get(host) ?? 0)) continue;
      if (jobs.size >= maxConcurrent) break;
      const controller = new AbortController(); entry.controller = controller;
      busyHosts.add(host); hostUntil.set(host, now + hostSpacingMs);
      const current = () => running && !controller.signal.aborted && cache.get(entry.key) === entry && Boolean(currentMarket(entry));
      const job = Promise.resolve().then(() => abortable(reader(entry.market, { from: task.from, to: task.to }, { signal: controller.signal }), controller.signal)).then(points => {
        if (current()) accept(entry, points, task);
      }).catch(error => {
        if (!current()) return;
        const unsupported = error?.code === 'UNSUPPORTED';
        entry.value = { ...entry.value, status: unsupported ? 'unsupported' : 'error', error: unsupported ? error.message : '成交价历史更新失败，保留已完成记录。' };
        entry.nextAt = clock() + (unsupported ? HOUR : Math.min(300_000, 60_000 * 2 ** Math.min(entry.failures++, 3)));
        if ([429, 418].includes(error?.status)) hostUntil.set(host, entry.nextAt);
        entry.dirty = true; persist(entry);
      }).finally(() => { if (entry.controller === controller) entry.controller = null; busyHosts.delete(host); jobs.delete(job); });
      jobs.add(job); launched.push(job);
    }
    await Promise.allSettled(launched);
  }
  return {
    start() { if (running) return; running = true; timer = setInterval(() => { void collect(); }, 1000); timer.unref?.(); },
    async stop() { running = false; clearInterval(timer); for (const entry of cache.values()) entry.controller?.abort(); await Promise.allSettled([...jobs]); for (const entry of cache.values()) persist(entry); },
    collect,
    read(input) {
      const pair = input?.pair;
      if (!pair || ![3, 7, 30].includes(input.days) || typeof pair.base !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(pair.base) || typeof pair.longKey !== 'string' || typeof pair.shortKey !== 'string' || pair.longKey.length > 160 || pair.shortKey.length > 160 || pair.longKey === pair.shortKey) throw invalid();
      const quotes = new Map(getSnapshot().quotes.map(quote => [keyOf(quote), quote])), requested = new Map();
      // Both current quotes and the current directory must agree. A persisted
      // quote alone is never permission to fetch an arbitrary contract.
      for (const key of [pair.longKey, pair.shortKey]) {
        const quote = quotes.get(key), market = quote && getMarket?.(quote.exchange, quote.symbol);
        if (!quote || !market || keyOf(market) !== key || quote.base !== pair.base || market.base !== pair.base || quote.quoteCurrency !== market.quoteCurrency || quote.comparable === false || market.comparable === false || (quote.multiplier ?? 1) !== (market.multiplier ?? 1)) throw invalid();
        requested.set(key, market);
      }
      if (requested.get(pair.longKey).exchange === requested.get(pair.shortKey).exchange) throw invalid();
      const now = clock(), legs = Object.create(null);
      for (const [key, market] of requested) {
        let entry = cache.get(key);
        if (entry && entry.identity !== perpetualPriceIdentity(market)) { entry.controller?.abort(); cache.delete(key); entry = null; }
        if (!entry) {
          prune(requested);
          if (cache.size >= cacheLimit) { legs[key] = { ...empty(market), error: '成交价历史队列繁忙，请稍后重试。' }; continue; }
          try { entry = restore(store?.loadPriceHistory?.(key)?.[0], market, now); }
          catch { storageError = '成交价缓存读取失败，重新读取公开历史。'; }
          entry ??= freshEntry(market, now); cache.set(key, entry);
        }
        entry.lastAccessAt = now; entry.activeUntil = now + activeLeaseMs; entry.market = market;
        legs[key] = structuredClone(entry.value);
      }
      if (running) queueMicrotask(() => { void collect(); });
      return { ...reportOf(legs, now), ...(storageError ? { storageError } : {}) };
    },
    metrics: () => ({ cached: cache.size, inFlight: jobs.size, storageError }),
  };
}

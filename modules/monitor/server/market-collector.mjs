import { loadQuote } from '../lib/quote-service.ts';
import { loadMarket, getMarketSnapshot } from '../lib/market-service.ts';
import { fetchHynixFundingSnapshot } from '../lib/hynix-funding-history.ts';
import { fetchDailySnapshot, marketFromExchangeQuote } from '../modules/oil/binance.mjs';
import { fetchFundingSnapshot } from '../modules/oil/binance-funding-history.mjs';
import oilArchive from '../public/oil/data/binance-2026.json' with { type: 'json' };
import oilFundingArchive from '../public/oil/data/binance-funding-2026.json' with { type: 'json' };
import hynixFundingArchive from '../data/hynix-funding.json' with { type: 'json' };
import { comparisonExchanges, exchangeAction, EXCHANGE_REFRESH_MS } from '../lib/exchange-quotes.ts';
import { createExchangeReader } from '../lib/exchange-service.ts';
import { fetchIntradaySnapshot, OIL_CANDLE_ACTION, OIL_CANDLE_REFRESH_MS } from '../modules/oil/intraday.mjs';
import oilIntradayArchive from '../public/oil/data/binance-15m.json' with { type: 'json' };
import { createGoldOilReader } from '../lib/gold-oil-service.ts';
import { GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, GOLD_OIL_VARIANTS, goldOilAction } from '../lib/gold-oil.ts';
import { exchangeFundingAction, HISTORY_REFRESH_MS } from '../lib/exchange-funding-history.ts';
import { createExchangeFundingReader } from '../lib/exchange-funding-service.ts';
import { OIL_HEDGE_PRICES_ACTION, HEDGE_PRICES_REFRESH_MS } from '../lib/oil-hedge-prices.ts';
import { createOilHedgePricesReader } from '../lib/oil-hedge-price-service.ts';
import { formatBinanceQuoteError } from '../lib/binance-quote-request.ts';

export function seedMarketDatabase(store) {
  store.write('hynix', 'history', getMarketSnapshot(), { seed: true });
  store.write('hynix', 'funding', hynixFundingArchive, { seed: true });
  store.write('oil', 'quote', oilArchive.market, { seed: true });
  store.write('oil', 'history', oilArchive, { seed: true });
  store.write('oil', 'funding', oilFundingArchive, { seed: true });
  store.write('oil', OIL_CANDLE_ACTION, oilIntradayArchive, { seed: true });
}

export function marketJobs({ oilIntervalMs = 30_000, variationalSession, variationalFetcher } = {}) {
  const readExchange = createExchangeReader({ variationalSession, variationalFetcher });
  const readFundingHistory = createExchangeFundingReader();
  const readHedgePrices = createOilHedgePricesReader();
  const goldOilJobs = GOLD_OIL_VARIANTS.flatMap(({ oilType, exchange }) => {
    const reader = createGoldOilReader({ oilType, exchange });
    return [
      { id: 'cl-xau', action: goldOilAction('quote', oilType, exchange), intervalMs: GOLD_OIL_QUOTE_MS, load: () => reader.quote() },
      { id: 'cl-xau', action: goldOilAction('history', oilType, exchange), intervalMs: GOLD_OIL_HISTORY_MS, load: previous => reader.history(previous) },
      { id: 'cl-xau', action: goldOilAction('funding', oilType, exchange), intervalMs: GOLD_OIL_FUNDING_MS, load: previous => reader.funding(previous) },
    ];
  });
  const fetchMarket = async () => marketFromExchangeQuote(await readExchange('binance', 'oil'));
  return [
    ...goldOilJobs,
    { id: 'hynix', action: 'quote', intervalMs: 10_000, load: () => loadQuote() },
    { id: 'oil', action: 'quote', intervalMs: oilIntervalMs, load: () => fetchMarket() },
    { id: 'hynix', action: 'history', intervalMs: 60_000, load: previous => loadMarket(fetch, Date.now(), previous ?? getMarketSnapshot()) },
    { id: 'oil', action: 'history', intervalMs: 300_000, async load(previous) {
      const next = await fetchDailySnapshot(await fetchMarket());
      const rows = new Map((previous?.data ?? []).map(row => [row.date, row]));
      for (const row of next.data) { const old = rows.get(row.date); rows.set(row.date, { date: row.date, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null }); }
      const data = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
      const paired = data.filter(row => row.brent !== null && row.wti !== null);
      return { ...next, data, metadata: { ...next.metadata, firstCommonObservation: paired[0].date, lastCommonObservation: paired.at(-1).date, pairedObservationRows: paired.length } };
    } },
    { id: 'hynix', action: 'funding', intervalMs: 300_000, load: previous => fetchHynixFundingSnapshot(previous ?? hynixFundingArchive, { signal: AbortSignal.timeout(12_000) }) },
    { id: 'oil', action: 'funding', intervalMs: 300_000, load: previous => fetchFundingSnapshot(previous ?? oilFundingArchive) },
    ...['oil', 'hynix'].flatMap(id => comparisonExchanges(id).map(exchange => ({ id, action: exchangeAction(exchange), intervalMs: EXCHANGE_REFRESH_MS, load: () => readExchange(exchange, id) }))),
    ...comparisonExchanges('oil').map(exchange => ({ id: 'oil', action: exchangeFundingAction(exchange), intervalMs: HISTORY_REFRESH_MS, load: previous => readFundingHistory(exchange, previous) })),
    { id: 'oil', action: OIL_HEDGE_PRICES_ACTION, intervalMs: HEDGE_PRICES_REFRESH_MS, load: previous => readHedgePrices(previous) },
    { id: 'oil', action: OIL_CANDLE_ACTION, intervalMs: OIL_CANDLE_REFRESH_MS, load: previous => fetchIntradaySnapshot(previous ?? oilIntradayArchive) },
  ];
}

/** Independent resident schedules; slow history never blocks current quotes. */
export function createMarketCollector(store, { jobs = marketJobs(), clock = Date.now, timers = globalThis, onStored = () => {} } = {}) {
  const pending = new Map(), scheduled = new Map(), storageFailures = new Set();
  const disabled = new Set();
  const generations = new Map();
  let running = false;
  function collect(job) {
    if (disabled.has(job.id)) return Promise.resolve(false);
    const key = `${job.id}/${job.action}`;
    const generation = generations.get(job.id);
    const cancelled = () => disabled.has(job.id) || generations.get(job.id) !== generation;
    if (pending.has(key)) return pending.get(key);
    const operation = Promise.resolve().then(async () => {
      let next;
      try {
        if (cancelled()) return false;
        next = await job.load(store.raw(job.id, job.action));
        if (cancelled()) return false;
        if (next?.status === 'snapshot') throw new Error('Upstream returned a retained snapshot');
      } catch (error) {
        if (cancelled()) return false;
        const message = formatBinanceQuoteError(error) ?? '采集暂时失败，保留上次成功数据；后台将自动重试。';
        try { store.fail(job.id, job.action, message); storageFailures.delete(key); }
        catch { storageFailures.add(key); }
        return false;
      }
      try { store.write(job.id, job.action, next); storageFailures.delete(key); }
      catch (error) {
        if (error.code === 'MARKET_DATA_INVALID') {
          try { store.fail(job.id, job.action, '本轮行情不完整或时间无效，保留上次成功数据。'); storageFailures.delete(key); return false; }
          catch { /* A failed status write is a database failure. */ }
        }
        storageFailures.add(key);
        return false;
      }
      // Alerts consume the committed quote promptly, without delaying collection.
      void Promise.resolve().then(() => { if (!cancelled()) return onStored(job); }).catch(() => {});
      return true;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }
  function schedule(job, initialDelay = 0) {
    const generation = generations.get(job.id);
    const tick = async () => {
      scheduled.delete(job);
      if (!running || disabled.has(job.id) || generations.get(job.id) !== generation) return;
      const started = clock();
      await collect(job);
      if (running && !disabled.has(job.id) && generations.get(job.id) === generation) scheduled.set(job, timers.setTimeout(tick, Math.max(1000, job.intervalMs - (clock() - started))));
    };
    if (initialDelay > 0) scheduled.set(job, timers.setTimeout(tick, initialDelay));
    else void tick();
  }
  function startSchedules(selected) {
    // Source time survives restarts. Saving or restarting must not renew a
    // dataset's lifetime; failed/seeded reads still need an upstream refresh.
    let saved;
    try { saved = new Map(store.status().map(row => [row.key, row])); }
    catch { saved = new Map(); }
    const now = clock();
    let goldHistorySlot = 0;
    for (const job of selected) {
      const quote = job.action === 'quote' || job.action.endsWith('/quote');
      if (quote) { schedule(job); continue; }
      const row = saved.get(`${job.id}/${job.action}`);
      const remaining = row?.success_ms != null && !row.error && Number.isFinite(row.source_ms) && row.source_ms <= now
        ? Math.max(0, job.intervalMs - (now - row.source_ms)) : 0;
      // Separate the four markets' history/funding starts without delaying
      // live quotes or imposing a shared lock on unrelated collectors.
      const stagger = job.id === 'cl-xau' ? goldHistorySlot++ * 350 : 0;
      schedule(job, remaining + stagger);
    }
  }
  return {
    collect,
    async pause(id) {
      disabled.add(id); generations.set(id, (generations.get(id) ?? 0) + 1);
      for (const [job, timer] of scheduled) if (job.id === id) { timers.clearTimeout(timer); scheduled.delete(job); }
      await Promise.all([...pending].filter(([key]) => key.startsWith(`${id}/`)).map(([, promise]) => promise));
    },
    resume(id) {
      if (!disabled.delete(id)) return;
      if (running) startSchedules(jobs.filter(job => job.id === id));
    },
    healthy: () => storageFailures.size === 0,
    start() {
      if (running) return;
      running = true;
      startSchedules(jobs.filter(job => !disabled.has(job.id)));
    },
    async stop() { running = false; for (const timer of scheduled.values()) timers.clearTimeout(timer); scheduled.clear(); await Promise.all(pending.values()); },
  };
}

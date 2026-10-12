import { EXCHANGES, discoverMarkets, createSubscriptions, parseMessage, getControlResponse } from '../modules/perpetual/exchanges.mjs';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PerpetualWebSocket } from './perpetual-socket.mjs';
import { createPerpetualQualityService } from './perpetual-quality-service.mjs';
import { createPerpetualAlertService } from './perpetual-alert-service.mjs';
import { createPerpetualExecutionService } from './perpetual-depth.mjs';
import { createPerpetualPaperService } from './perpetual-paper-service.mjs';
import { createPerpetualOpportunities } from './perpetual-opportunities.mjs';
import { createCrossExFilterService } from './perpetual-crossex-service.mjs';
import { createOpportunitiesV2Reader } from './perpetual-opportunities-v2.mjs';
import { createPerpetualFundingHistoryService } from './perpetual-funding-history.mjs';
import { createPerpetualPriceHistoryService } from './perpetual-price-history.mjs';
import { createPerpetualMarketMetricsService } from './perpetual-market-metrics.mjs';
import { createPerpetualScannerDataService } from './perpetual-scanner-data.mjs';
import { perpetualPriceIdentity } from '../lib/perpetual-price-history.ts';
import { STREAM_OBSERVATION_MS, MARKET_CATALOG_MS, MARKET_METRICS_POLL_MS, AUXILIARY_BOOK_POLL_MS } from '../modules/perpetual/collection-policy.mjs';

export const PERPETUAL_STALE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const fields = ['bid', 'ask', 'mark', 'last', 'fundingRate', 'fundingIntervalHours', 'nextFundingAt'];
const priceFields = new Set(['bid', 'ask', 'mark', 'last']);
const feeFields = ['takerFeeRate', 'takerFeeAt', 'takerFeeSource'];
const identityFields = ['assetClass', 'identitySource', 'identityVerified'];
const catalogFields = new Set(['delisting', 'delistingAt', ...feeFields, ...identityFields]);
const streamValueFields = [...fields, 'base', 'quoteCurrency', 'multiplier', 'displayBase', 'contractUnit', 'collateralCurrency', 'historyIdentity', 'comparable', 'transport', ...catalogFields];
const streamTimeFields = ['bidAt', 'askAt', 'bidAskAt', 'markAt', 'lastAt', 'fundingAt', 'fundingIntervalHoursUpdatedAt', 'nextFundingAtUpdatedAt', 'receivedAt', 'sourceTime'];
const historyIdentities = new WeakMap();

/** Only changed fields cross the wire. The retained baseline is exactly what readers received. */
export function createPerpetualPatch(snapshot, previous, freshnessMs = 5_000) {
  const patches = [], seen = new Set();
  for (const quote of snapshot.quotes) {
    const key = `${quote.exchange}:${quote.symbol}`, old = previous.get(key);
    seen.add(key);
    if (old === quote) continue;
    if (!old) { patches.push([key, quote]); previous.set(key, quote); continue; }
    const changes = {};
    for (const field of streamValueFields) if (old[field] !== quote[field]) changes[field] = quote[field] ?? null;
    const confirmed = Math.floor(quote.receivedAt / freshnessMs) > Math.floor(old.receivedAt / freshnessMs);
    // A price change includes its own original timestamp. Unchanged book/mark/rate
    // confirmations stay paced even when an unrelated last-trade price changes.
    for (const field of streamTimeFields) {
      const valueField = field === 'fundingAt' ? 'fundingRate' : field.endsWith('UpdatedAt') ? field.slice(0, -9) : field.slice(0, -2);
      const changed = Object.hasOwn(changes, valueField) || (field === 'bidAskAt' && (Object.hasOwn(changes, 'bid') || Object.hasOwn(changes, 'ask')));
      if ((confirmed || changed) && old[field] !== quote[field]) changes[field] = quote[field] ?? null;
    }
    if (!Object.keys(changes).length) continue;
    // Receipt time is transport metadata, never a substitute for field timestamps.
    changes.receivedAt = quote.receivedAt;
    if (old.sourceTime !== quote.sourceTime) changes.sourceTime = quote.sourceTime;
    patches.push([key, changes]); previous.set(key, { ...old, ...changes });
  }
  const removed = [];
  for (const key of previous.keys()) if (!seen.has(key)) { removed.push(key); previous.delete(key); }
  const metadata = { ...snapshot }; delete metadata.quotes;
  return { ...metadata, type: 'patch', patches, removed };
}

/** Visit only changed identities. Unchanged quote confirmations retain the same pacing. */
export function createPerpetualChangedPatch(metadata, quotes, previous, keys, freshnessMs = 5_000) {
  const changed = [], baseline = new Map(), removed = [];
  for (const key of keys) {
    const quote = quotes.get(key);
    if (!quote) { if (previous.delete(key)) removed.push(key); continue; }
    changed.push(quote);
    if (previous.has(key)) baseline.set(key, previous.get(key));
  }
  const frame = createPerpetualPatch({ ...metadata, quotes: changed }, baseline, freshnessMs);
  for (const [key, quote] of baseline) previous.set(key, quote);
  frame.removed = removed;
  return frame;
}

/** Shared incremental frame, preserving actual field times while pacing unchanged price confirmations. */
export function createPerpetualDelta(snapshot, previous, freshnessMs = 5_000) {
  const updates = [], seen = new Set();
  for (const quote of snapshot.quotes) {
    const key = `${quote.exchange}:${quote.symbol}`, old = previous.get(key);
    seen.add(key);
    if (!old || streamValueFields.some(field => old[field] !== quote[field]) || Math.floor(quote.receivedAt / freshnessMs) > Math.floor(old.receivedAt / freshnessMs)) {
      updates.push(quote); previous.set(key, quote);
    }
  }
  const removed = [];
  for (const key of previous.keys()) if (!seen.has(key)) { removed.push(key); previous.delete(key); }
  const metadata = { ...snapshot }; delete metadata.quotes;
  return { ...metadata, type: 'delta', updates, removed };
}

/** Merge sparse ticker messages without letting funding updates refresh old prices. */
export function mergePerpetualQuote(previous, update, now = Date.now()) {
  if (!update || typeof update.exchange !== 'string' || typeof update.symbol !== 'string' || typeof update.base !== 'string' || !['USD', 'USDT', 'USDC', 'USD1', 'USDG'].includes(update.quoteCurrency)) return previous;
  const sourceTime = Number.isFinite(update.sourceTime) ? update.sourceTime : null;
  if (sourceTime !== null && sourceTime > now + MAX_FUTURE_MS) return previous;
  const time = sourceTime === null ? now : Math.min(now, sourceTime);
  const multiplier = Number.isFinite(update.multiplier) && update.multiplier > 0 ? update.multiplier : 1;
  const identityChanged = previous && (previous.base !== update.base || previous.quoteCurrency !== update.quoteCurrency || (previous.multiplier ?? 1) !== multiplier || (typeof update.contractUnit === 'string' && previous.contractUnit !== update.contractUnit));
  const next = previous && !identityChanged ? { ...previous } : {
    exchange: update.exchange, symbol: update.symbol, base: update.base, quoteCurrency: update.quoteCurrency,
    multiplier,
    bid: null, ask: null, mark: null, last: null, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null,
    receivedAt: now, sourceTime, transport: 'ws',
  };
  let changed = false, rateUpdated = false;
  for (const field of fields) {
    if (!Object.hasOwn(update, field)) continue;
    const value = update[field];
    if (value !== null && (!Number.isFinite(value) || (priceFields.has(field) && value <= 0) || (field === 'fundingIntervalHours' && value <= 0))) continue;
    const stamp = priceFields.has(field) ? `${field}At` : field === 'fundingRate' ? 'fundingAt' : `${field}UpdatedAt`;
    if (Number.isFinite(next[stamp]) && time < next[stamp]) continue;
    // A delayed rate must not revive a value from before the current interval.
    if (field === 'fundingRate' && Number.isFinite(next.fundingIntervalHoursUpdatedAt) && time < next.fundingIntervalHoursUpdatedAt) continue;
    if (field === 'fundingIntervalHours' && next[field] !== null && value !== next[field] && !rateUpdated) next.fundingRate = null;
    next[field] = value; next[stamp] = time; changed = true;
    if (field === 'fundingRate') rateUpdated = true;
  }
  if (!changed) return previous;
  for (const field of ['displayBase', 'contractUnit', 'collateralCurrency']) if (typeof update[field] === 'string') next[field] = update[field];
  if (typeof update.comparable === 'boolean') next.comparable = update.comparable;
  next.bidAskAt = Number.isFinite(next.bidAt) && Number.isFinite(next.askAt) ? Math.min(next.bidAt, next.askAt) : undefined;
  next.receivedAt = now;
  next.sourceTime = sourceTime;
  next.transport = update.transport === 'rest' ? 'rest' : 'ws';
  return next;
}

function withMarketMetadata(quote, market) {
  // Directory classification is display metadata, not a new price confirmation or
  // permission to compare contracts. Old subscription contexts cannot override it.
  let classified = quote;
  for (const field of identityFields) {
    const candidate = market?.[field];
    const valid = field === 'identityVerified' ? typeof candidate === 'boolean' : typeof candidate === 'string' && candidate.trim().length > 0;
    const value = valid ? candidate : quote[field] === undefined ? undefined : null;
    if (value === quote[field]) continue;
    if (classified === quote) classified = { ...quote };
    classified[field] = value;
  }
  // History must match the current directory's complete contract identity,
  // without copying collateral/channel metadata into comparison eligibility.
  let historyIdentity = null;
  if (market && market.exchange === quote.exchange && market.symbol === quote.symbol
    && market.base === quote.base && market.quoteCurrency === quote.quoteCurrency
    && (market.multiplier ?? 1) === (quote.multiplier ?? 1)
    && (market.contractUnit ?? null) === (quote.contractUnit ?? null)) {
    historyIdentity = historyIdentities.get(market);
    if (!historyIdentity) { historyIdentity = perpetualPriceIdentity(market); historyIdentities.set(market, historyIdentity); }
  }
  if (historyIdentity !== quote.historyIdentity) {
    if (classified === quote) classified = { ...quote };
    classified.historyIdentity = historyIdentity;
  }
  quote = classified;
  const delisting = market?.delisting === true;
  const delistingAt = delisting && Number.isSafeInteger(market.delistingAt) && market.delistingAt > 0 && market.delistingAt <= 8.64e15 ? market.delistingAt : null;
  const sameLifecycle = quote.delisting === delisting && quote.delistingAt === delistingAt;
  // Fee metadata has its own age. It must propagate without a new ticker and
  // never confirm an old book. The normal per-tick path allocates nothing.
  if (market?.takerFeeRate === undefined && market?.takerFeeAt === undefined && market?.takerFeeSource === undefined
    && quote.takerFeeRate === undefined && quote.takerFeeAt === undefined && quote.takerFeeSource === undefined) return sameLifecycle ? quote : { ...quote, delisting, delistingAt };
  const takerFeeRate = Number.isFinite(market?.takerFeeRate) && market.takerFeeRate >= 0 && market.takerFeeRate <= 0.1 ? market.takerFeeRate : null;
  const takerFeeAt = takerFeeRate !== null && Number.isSafeInteger(market?.takerFeeAt) && market.takerFeeAt > 0 && market.takerFeeAt <= 8.64e15 ? market.takerFeeAt : null;
  const takerFeeSource = typeof market?.takerFeeSource === 'string' ? market.takerFeeSource : null;
  return sameLifecycle && quote.takerFeeRate === takerFeeRate && quote.takerFeeAt === takerFeeAt && quote.takerFeeSource === takerFeeSource
    ? quote : { ...quote, delisting, delistingAt, takerFeeRate, takerFeeAt, takerFeeSource };
}

export function createPerpetualService({ store, exchanges = EXCHANGES, discover = discoverMarkets, subscriptions = createSubscriptions, parse = parseMessage, control = getControlResponse, WebSocketImpl = PerpetualWebSocket, clock = Date.now, staleAfterMs = PERPETUAL_STALE_MS, retryMs = 5_000, discoveryIntervalMs = MARKET_CATALOG_MS, saveIntervalMs = 15_000, observationIntervalMs = STREAM_OBSERVATION_MS, broadcastIntervalMs = STREAM_OBSERVATION_MS, watchdogIntervalMs = 10_000, quoteTimeoutMs = 45_000, qualityOptions, fundingHistoryOptions, priceHistoryOptions, marketMetricsOptions, alertOptions, paperOptions, notifications, executionOptions, crossexOptions, fxIntervalMs = exchanges === EXCHANGES ? 60000 : 0 } = {}) {
  let sourceRevision = 0;
  const readOpportunitiesV2 = createOpportunitiesV2Reader();
  const crossex = createCrossExFilterService({ clock, ...crossexOptions });
  const quotes = new Map(), pendingQuotes = new Map(), dirty = new Map(), pendingPrunes = new Map(), connections = new Set(), clients = new Map(), timers = new Set(), discoveries = new Map(), publishedQuotes = new Map(), publishDirty = new Set(), pollBudgets = new Map();
  const states = new Map(exchanges.map(exchange => [exchange.id, { ...exchange, kind: exchange.kind ?? exchange.type, marketCount: 0, lastMessageAt: null, lastSourceLagMs: null, rejectedFuture: 0, error: null, discovering: false }]));
  let running = false, storageError = null, observationTimer, broadcastTimer, saveTimer, refreshTimer, metricsTimer, fxTimer, sequence = 0;
  const quality = store?.saveQualitySample ? createPerpetualQualityService({ getSnapshot: snapshot, store, clock, shouldDeferAuxiliary: () => metrics.eventLoopP99Ms > 80 || metrics.cpuPercent > 160, ...qualityOptions }) : null;
  const fundingHistory = createPerpetualFundingHistoryService({ getSnapshot: snapshot, getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), store, clock, ...fundingHistoryOptions });
  const priceHistory = createPerpetualPriceHistoryService({ getSnapshot: snapshot, getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), store, clock, ...priceHistoryOptions });
  const marketMetrics = createPerpetualMarketMetricsService({ getSnapshot: snapshot, getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), store, clock, ...marketMetricsOptions });
  const scannerData = createPerpetualScannerDataService({ getSnapshot: snapshot, getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), fundingHistory, marketMetrics, clock });
  const alerts = createPerpetualAlertService({ getQuote: key => quotes.get(key), isVenueLive: id => [...connections].some(connection => connection.exchange === id && connection.socket?.readyState === 1), marketHealthy: () => !storageError, clock, notifications, ...alertOptions });
  const execution = createPerpetualExecutionService({ getQuote: (exchange, symbol) => quotes.get(`${exchange}:${symbol}`), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), clock, ...executionOptions });
  const paper = createPerpetualPaperService({ getQuote: key => quotes.get(key), isVenueLive: id => [...connections].some(connection => connection.exchange === id && connection.socket?.readyState === 1), clock, ...paperOptions });
  const streamId = randomUUID(), eventLoop = monitorEventLoopDelay({ resolution: 20 });
  const metrics = { lastWriteMs: 0, lastPublishMs: 0, frames: 0, fullFrames: 0, frameBytes: 0, lastFrameUpdates: 0, lastPatchVisitedQuotes: 0, messages: 0, updates: 0, observations: 0, messagesPerSecond: 0, cpuPercent: 0, eventLoopP99Ms: 0, eventLoopMaxMs: 0 };
  const healthEvents = [];
  let healthEventId = 0;
  function recordHealth(exchange, kind, reason) {
    const now = clock(), last = healthEvents.find(item => item.exchange === exchange);
    if (last?.kind === kind && last.reason === reason && now - last.at < 60_000) return;
    healthEvents.unshift({ id: ++healthEventId, exchange, kind, reason, at: now });
    healthEvents.length = Math.min(healthEvents.length, 60);
  }
  function changedQuote(key, quote) { sourceRevision++; quotes.set(key, quote); dirty.set(key, quote); if (clients.size) publishDirty.add(key); }
  function observe() {
    for (const [key, quote] of pendingQuotes) {
      // Catalog metadata may change after receipt but before this observation.
      changedQuote(key, withMarketMetadata(quote, states.get(quote.exchange)?.markets?.get(quote.symbol)));
      metrics.observations++;
    }
    pendingQuotes.clear();
  }
  let cpuBaseline = process.cpuUsage(), sampledAt = performance.now(), sampledMessages = 0;
  // A persisted fingerprint is not evidence of the current market directory.
  for (const quote of store?.load() ?? []) if (states.has(quote.exchange)) quotes.set(`${quote.exchange}:${quote.symbol}`, { ...quote, historyIdentity: null });
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); if (running) fn(); }, ms);
    timer.unref?.(); timers.add(timer); return timer;
  };
  function flush() {
    if (!dirty.size && !pendingPrunes.size) return;
    const started = performance.now();
    try {
      for (const [exchange, symbols] of pendingPrunes) { store?.prune(exchange, symbols); pendingPrunes.delete(exchange); }
      if (dirty.size) { store?.save([...dirty.values()]); dirty.clear(); }
      storageError = null;
    }
    catch { storageError = '合约行情保存失败，当前仅显示内存报价。'; }
    finally { metrics.lastWriteMs = Number((performance.now() - started).toFixed(2)); }
  }
  function snapshot() {
    const now = clock();
    const fresh = time => Number.isFinite(time) && time >= now - staleAfterMs && time <= now + MAX_FUTURE_MS;
    const values = [...quotes.values()], counts = new Map();
    for (const quote of values) {
      const own = counts.get(quote.exchange) ?? { all: 0, fresh: 0, freshBook: 0, staleBook: 0, missingBook: 0 }; own.all++;
      if (quote.bid > 0 && quote.ask >= quote.bid && Number.isFinite(quote.bidAskAt) && quote.bidAskAt <= now + MAX_FUTURE_MS) {
        if (fresh(quote.bidAskAt)) own.freshBook++; else own.staleBook++;
      } else own.missingBook++;
      if ((quote.bid > 0 && quote.ask >= quote.bid && fresh(quote.bidAskAt)) || (quote.mark > 0 && fresh(quote.markAt))) own.fresh++;
      counts.set(quote.exchange, own);
    }
    const connectedExchanges = new Set([...connections].filter(connection => connection.socket?.readyState === 1).map(connection => connection.exchange));
    const exchangeViews = [...states.values()].map(state => {
      const own = counts.get(state.id) ?? { all: 0, fresh: 0, freshBook: 0, staleBook: 0, missingBook: 0 };
      const status = connectedExchanges.has(state.id) && own.fresh ? 'live' : own.all ? 'stale' : state.error ? 'error' : 'connecting';
      return { id: state.id, name: state.name, kind: state.kind, status, marketCount: state.marketCount, quoteCount: own.fresh, freshBookCount: own.freshBook, staleBookCount: own.staleBook, missingBookCount: own.missingBook, lastMessageAt: state.lastMessageAt, error: state.error || state.snapshotError || null };
    });
    const live = exchangeViews.filter(exchange => exchange.status === 'live').length;
    return { schemaVersion: 1, monitorId: 'perpetual', streamId, sequence, status: live === states.size && live > 0 ? 'live' : live ? 'partial' : quotes.size ? 'snapshot' : 'connecting', generatedAt: now, staleAfterMs, exchanges: exchangeViews, quotes: values, storageError };
  }
  function send(connection, value) {
    if (connection.socket.readyState === 1) connection.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }
  function connect(exchange, spec, attempt = 0) {
    if (!running || (spec.generation != null && spec.generation !== states.get(exchange).generation)) return;
    const state = states.get(exchange), connection = { exchange, socket: null, timers: new Set(), closed: false, lastMessageAt: clock(), lastQuoteAt: clock() };
    const context = structuredClone(spec.context ?? {});
    const pollHost = new URL(spec.url).host;
    let pollCursor = 0;
    if (spec.poll && !pollBudgets.has(pollHost)) pollBudgets.set(pollHost, { startedAt: clock(), sent: 0, nextAt: 0, blockedUntil: 0, failures: 0 });
    const clear = () => { for (const timer of connection.timers) { clearTimeout(timer); clearInterval(timer); timers.delete(timer); } connections.delete(connection); };
    const scheduleTask = (fn, ms) => { const timer = later(() => { connection.timers.delete(timer); if (!connection.closed) fn(); }, ms); connection.timers.add(timer); return timer; };
    connection.dispose = () => { connection.closed = true; clear(); connection.snapshotController?.abort(); try { if (connection.socket?.terminate) connection.socket.terminate(); else connection.socket?.close(); } catch {} };
    const fail = message => {
      if (connection.closed) return;
      state.error = message; state.reconnects = (state.reconnects ?? 0) + 1; recordHealth(exchange, 'error', message); connection.dispose();
      if (running) later(() => connect(exchange, spec, attempt + 1), Math.min(60_000, retryMs * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * retryMs / 4));
    };
    const acceptUpdates = (updates, now, transport = 'ws') => {
      for (const update of updates) {
        if (update.exchange !== exchange) continue;
        if (Number.isFinite(update.sourceTime)) {
          state.lastSourceLagMs = now - update.sourceTime; state.sourceLagObservedAt = now;
          if (state.lastSourceLagMs < -MAX_FUTURE_MS) { state.rejectedFuture++; state.error = '行情时间领先服务器，请检查服务器时钟。'; }
        }
        const key = `${exchange}:${update.symbol}`, previous = pendingQuotes.get(key) ?? quotes.get(key), next = mergePerpetualQuote(previous, transport === 'rest' ? { ...update, transport } : update, now);
        if (next && next !== previous) {
          const current = withMarketMetadata(next, state.markets?.get(update.symbol));
          metrics.updates++; pendingQuotes.set(key, current);
          if (observationIntervalMs <= 0) observe();
          if (transport === 'ws') connection.lastQuoteAt = now;
          state.lastMessageAt = now; state.error = null; attempt = 0;
        }
      }
    };
    const requestSnapshot = async () => {
      const controller = new AbortController(); connection.snapshotController = controller;
      try {
        const updates = await spec.snapshot({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]), now: clock() });
        if (running && !connection.closed) { acceptUpdates(updates, clock(), 'rest'); state.snapshotError = null; }
      } catch { if (running && !connection.closed) state.snapshotError = '盘口补充快照暂不可用，正在重试。'; }
      finally { if (running && !connection.closed) scheduleTask(() => { void requestSnapshot(); }, spec.snapshotIntervalMs ?? 10_000); }
    };
    const poll = () => {
      const started = clock(), messages = spec.poll.messages;
      const budget = pollBudgets.get(pollHost);
      if (budget.blockedUntil > started) { scheduleTask(poll, budget.blockedUntil - started); return; }
      let remaining = messages.length;
      const next = () => {
        const now = clock();
        if (budget.blockedUntil > now) { scheduleTask(poll, budget.blockedUntil - now); return; }
        if (spec.poll.maxPerMinute && budget.nextAt > now) { scheduleTask(next, budget.nextAt - now); return; }
        if (now < budget.startedAt || now - budget.startedAt >= 60_000) { budget.startedAt = now; budget.sent = 0; }
        if (spec.poll.maxPerMinute && budget.sent >= spec.poll.maxPerMinute) { scheduleTask(poll, Math.max(100, budget.startedAt + 60_000 - now)); return; }
        while (remaining > 0) {
          const message = messages[pollCursor++ % messages.length]; remaining--;
          const symbol = message.request?.payload?.coin, quote = pendingQuotes.get(`${exchange}:${symbol}`) ?? quotes.get(`${exchange}:${symbol}`);
          if (spec.poll.staleBookAfterMs && quote?.bid > 0 && quote.ask >= quote.bid && Number.isFinite(quote.bidAskAt)
            && quote.bidAskAt >= now - spec.poll.staleBookAfterMs && quote.bidAskAt <= now + MAX_FUTURE_MS) continue;
          try {
            send(connection, message); budget.sent++;
            if (spec.poll.maxPerMinute) budget.nextAt = now + Math.ceil(60_000 / spec.poll.maxPerMinute);
          } catch { fail('WebSocket 快照请求失败，正在重连。'); return; }
          break;
        }
        if (remaining > 0) scheduleTask(next, spec.poll.sendIntervalMs ?? 100);
        else scheduleTask(poll, Math.max(spec.poll.sendIntervalMs ?? 100, (spec.poll.intervalMs ?? 10_000) - (clock() - started)));
      };
      if (messages.length) next();
    };
    try {
      connection.socket = new WebSocketImpl(spec.url, { headers: spec.headers });
      connections.add(connection);
      scheduleTask(() => { if (connection.socket.readyState !== 1) fail('WebSocket 连接超时，正在重连。'); }, 20_000);
      connection.socket.addEventListener('open', () => {
        if (connection.closed || !running) return connection.dispose();
        state.lastConnectedAt = clock(); recordHealth(exchange, 'connected', '行情连接已建立');
        (spec.subscribe ?? []).forEach((message, index) => scheduleTask(() => {
          try { send(connection, message); } catch { fail('WebSocket 订阅失败，正在重连。'); }
        }, index * (spec.sendIntervalMs ?? 100)));
        if (spec.poll) scheduleTask(poll, ((spec.subscribe?.length ?? 0) + 1) * (spec.sendIntervalMs ?? 100));
        if (spec.snapshot) scheduleTask(() => { void requestSnapshot(); }, 500);
        if (spec.heartbeat) {
          const heartbeat = setInterval(() => { try { send(connection, spec.heartbeat); } catch { fail('WebSocket 心跳失败，正在重连。'); } }, spec.heartbeatMs ?? 20_000);
          heartbeat.unref?.(); connection.timers.add(heartbeat);
        }
        const watchdog = setInterval(() => {
          if (clock() - connection.lastMessageAt > quoteTimeoutMs) fail('WebSocket 未收到数据，正在重连。');
          else if (clock() - connection.lastQuoteAt > quoteTimeoutMs) fail('WebSocket 只有心跳，未收到有效行情，正在重订阅。');
        }, watchdogIntervalMs);
        watchdog.unref?.(); connection.timers.add(watchdog);
      });
      connection.socket.addEventListener('message', event => {
        if (connection.closed || !running) return;
        const now = clock(); connection.lastMessageAt = now;
        metrics.messages++;
        let payload;
        try { payload = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(Buffer.from(event.data).toString()); }
        catch { payload = event.data; }
        try {
          // Auxiliary info requests must not tear down a healthy BBO stream.
          // In particular, an exchange 429 backs off only the shared-host poller.
          if (spec.poll && payload?.channel === 'post' && payload.data?.response?.type === 'error') {
            const budget = pollBudgets.get(pollHost);
            budget.failures++;
            budget.blockedUntil = now + Math.min(300_000, 60_000 * 2 ** Math.min(budget.failures - 1, 3));
            state.lastProtocolError = `${exchange} auxiliary snapshot: ${String(payload.data.response.payload).slice(0, 230)}`;
            return;
          }
          if (spec.poll && payload?.channel === 'post' && payload.data?.response?.type === 'info') pollBudgets.get(pollHost).failures = 0;
          const reply = control(exchange, payload);
          if (reply != null) send(connection, reply);
          const updates = parse(exchange, payload, spec.markets ?? [], now, context);
          acceptUpdates(updates, now);
        } catch (error) { state.lastProtocolError = String(error?.message ?? 'Invalid public feed message').slice(0, 300); fail('行情消息无效，正在重新订阅。'); }
      });
      connection.socket.addEventListener('error', () => fail('WebSocket 暂不可用，正在重连。'));
      connection.socket.addEventListener('close', () => fail('WebSocket 已断开，正在重连。'));
    } catch { fail('无法建立 WebSocket，正在重试。'); }
  }
  async function refresh(exchange) {
    const state = states.get(exchange);
    if (!running || state.discovering) return;
    state.discovering = true;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const markets = await discover(exchange, { signal: controller.signal });
        if (!running) return;
        if (!markets.length) throw new Error('No active markets');
        const specs = subscriptions(exchange, markets);
        if (!specs.length) throw new Error('No subscriptions');
        state.marketCount = markets.length;
        // Funding intervals, contract multipliers and channel IDs may change while symbols stay the same.
        // Lifecycle, fee and classification metadata must reach readers without a new price, and
        // must not tear down subscriptions or refresh the original price times.
        const identities = new Map(markets.map(market => [market.symbol, market]));
        const signature = JSON.stringify([...markets].sort((left, right) => left.symbol.localeCompare(right.symbol)), (key, value) => catalogFields.has(key) ? undefined : value);
        state.markets = identities; sourceRevision++;
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange || !identities.has(quote.symbol)) continue;
          const current = withMarketMetadata(quote, identities.get(quote.symbol));
          if (current !== quote) changedQuote(key, current);
        }
        if (signature === state.signature) return;
        // Retired subscription generations must not publish a buffered old
        // contract after a directory identity or channel change.
        for (const [key, quote] of pendingQuotes) if (quote.exchange === exchange) pendingQuotes.delete(key);
        const symbols = new Set(markets.map(market => market.symbol));
        const keepStored = new Set(symbols);
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange) continue;
          const market = identities.get(quote.symbol);
          if (!market || quote.base !== market.base || quote.quoteCurrency !== market.quoteCurrency || (quote.multiplier ?? 1) !== (market.multiplier ?? 1) || (market.contractUnit && market.contractUnit !== quote.contractUnit) || (market.comparable === false && quote.comparable !== false)) {
            quotes.delete(key); sourceRevision++; dirty.delete(key); if (clients.size) publishDirty.add(key); keepStored.delete(quote.symbol);
          }
        }
        pendingPrunes.set(exchange, keepStored);
        try { store?.prune(exchange, keepStored); pendingPrunes.delete(exchange); } catch { storageError = '合约行情保存失败，正在重试。'; }
        // Retire previous-generation reconnect timers as well as live connections.
        state.generation = (state.generation ?? 0) + 1;
        for (const connection of [...connections]) if (connection.exchange === exchange) connection.dispose();
        state.signature = signature;
        for (const spec of specs) {
          const current = { ...spec, generation: state.generation };
          later(() => connect(exchange, current), spec.startDelayMs ?? 0);
        }
      } catch {
        if (running) { state.error = '合约列表获取失败，正在重试。'; recordHealth(exchange, 'error', state.error); later(() => { void refresh(exchange); }, 30_000); }
      } finally { state.discovering = false; discoveries.delete(exchange); }
    })();
    discoveries.set(exchange, { controller, promise });
    await promise;
  }
  function closeStreams() { for (const client of clients.values()) client.output.end(); clients.clear(); publishedQuotes.clear(); publishDirty.clear(); }
  return {
    start() {
      if (running) return; running = true;
      // Independent of browser subscriptions and SSE cadence. Register first so
      // equal-interval consumers see the newly committed observation.
      if (observationIntervalMs > 0) { observationTimer = setInterval(observe, observationIntervalMs); observationTimer.unref?.(); }
      fundingHistory.start();
      priceHistory.start();
      marketMetrics.start();
      if (fxIntervalMs > 0) { const refreshFx = () => void execution.fx().catch(() => {}); refreshFx(); fxTimer = setInterval(refreshFx, Math.max(60000, fxIntervalMs)); fxTimer.unref?.(); }
      quality?.start();
      alerts.start();
      paper.start();
      crossex.start();
      eventLoop.enable(); cpuBaseline = process.cpuUsage(); sampledAt = performance.now();
      metricsTimer = setInterval(() => {
        const now = performance.now(), elapsed = now - sampledAt, cpu = process.cpuUsage(cpuBaseline);
        metrics.cpuPercent = Number(((cpu.user + cpu.system) / (elapsed * 10)).toFixed(1));
        metrics.messagesPerSecond = Math.round((metrics.messages - sampledMessages) * 1000 / elapsed);
        metrics.eventLoopP99Ms = Number((eventLoop.percentile(99) / 1e6).toFixed(2));
        metrics.eventLoopMaxMs = Number((eventLoop.max / 1e6).toFixed(2));
        cpuBaseline = process.cpuUsage(); sampledAt = now; sampledMessages = metrics.messages; eventLoop.reset();
      }, 10_000);
      for (const exchange of states.keys()) void refresh(exchange);
      refreshTimer = setInterval(() => { for (const exchange of states.keys()) void refresh(exchange); }, discoveryIntervalMs);
      saveTimer = setInterval(flush, saveIntervalMs);
      broadcastTimer = setInterval(() => {
        void alerts.check().catch(() => {});
        void paper.check().catch(() => {});
        if (!clients.size) return;
        const started = performance.now(), baseSequence = sequence++;
        const current = snapshot();
        metrics.lastPatchVisitedQuotes = publishDirty.size;
        const delta = createPerpetualChangedPatch(current, quotes, publishedQuotes, publishDirty);
        publishDirty.clear();
        const message = `data: ${JSON.stringify({ ...delta, baseSequence })}\n\n`;
        let fullMessage = null;
        for (const [response, client] of clients) {
          const { output } = client;
          if (response.destroyed || response.writableEnded) { clients.delete(response); continue; }
          if (response.writableLength + output.writableLength > 4_000_000) { response.destroy(); clients.delete(response); continue; }
          if (response.writableNeedDrain || output.writableNeedDrain) { client.needsSnapshot = true; continue; }
          // A slow reader cannot skip a delta and continue with a broken baseline.
          if (client.needsSnapshot) { fullMessage ??= `data: ${JSON.stringify({ ...current, quotes: [...publishedQuotes.values()] })}\n\n`; output.write(fullMessage); client.needsSnapshot = false; metrics.fullFrames++; }
          else output.write(message);
        }
        metrics.frames++; metrics.frameBytes = Buffer.byteLength(message); metrics.lastFrameUpdates = delta.patches.length;
        metrics.lastPublishMs = Number((performance.now() - started).toFixed(2));
      }, broadcastIntervalMs);
      for (const timer of [refreshTimer, saveTimer, broadcastTimer, metricsTimer]) timer.unref?.();
    },
    async stop() {
      running = false; closeStreams();
      for (const timer of [observationTimer, refreshTimer, saveTimer, broadcastTimer, metricsTimer, fxTimer, ...timers]) clearTimeout(timer);
      eventLoop.disable();
      timers.clear();
      const pending = [...discoveries.values()];
      for (const item of pending) item.controller.abort();
      for (const connection of [...connections]) connection.dispose();
      observe();
      await Promise.allSettled(pending.map(item => item.promise));
      await quality?.stop();
      await fundingHistory.stop();
      await priceHistory.stop();
      await marketMetrics.stop();
      await alerts.stop();
      await paper.stop();
      await crossex.stop();
      execution.stop();
      flush(); store?.close();
    },
    summary() {
      const now = clock(), connected = new Set([...connections].filter(x => x.socket?.readyState === 1).map(x => x.exchange));
      const freshVenues = new Set(), onlineVenues = new Set(), bases = new Set();
      const blocked = new Set(crossex.filter().blockedBases);
      let fresh = 0, quoteUpdatedAt = null;
      for (const quote of quotes.values()) {
        const at = quote.bidAskAt;
        if (!blocked.has(quote.base)) bases.add(quote.base);
        const book = quote.bid > 0 && quote.ask >= quote.bid && Number.isFinite(at) && at <= now + MAX_FUTURE_MS;
        const mark = quote.mark > 0 && Number.isFinite(quote.markAt) && quote.markAt <= now + MAX_FUTURE_MS;
        // Funding and receipt timestamps must never renew retained price observations.
        if (book && at > 0) quoteUpdatedAt = Math.max(quoteUpdatedAt ?? 0, at);
        if (mark && quote.markAt > 0) quoteUpdatedAt = Math.max(quoteUpdatedAt ?? 0, quote.markAt);
        if (!connected.has(quote.exchange)) continue;
        if (book && now - at <= staleAfterMs) { fresh++; freshVenues.add(quote.exchange); }
        if (book && now - at <= staleAfterMs || mark && now - quote.markAt <= staleAfterMs) onlineVenues.add(quote.exchange);
      }
      const missing = [...states.keys()].filter(id => !freshVenues.has(id));
      const times = [...states.values()].map(state => state.lastMessageAt);
      const updatedAt = times.length && times.every(at => Number.isFinite(at) && at > 0 && at <= now + MAX_FUTURE_MS) ? Math.min(...times) : null;
      return { schemaVersion: 1, monitorId: 'perpetual', available: true, staleAfterMs,
        status: onlineVenues.size === states.size && onlineVenues.size > 0 ? 'live' : onlineVenues.size ? 'partial' : quotes.size ? 'snapshot' : 'connecting',
        baseCount: bases.size, onlineExchangeCount: onlineVenues.size, quoteUpdatedAt,
        state: !quotes.size ? 'offline' : !fresh ? 'stale' : storageError || missing.length || fresh < quotes.size ? 'partial' : 'online', updatedAt, quoteCount: quotes.size, exchangeCount: states.size, liveExchangeCount: freshVenues.size,
        message: [storageError, missing.length ? '行情待更新：' + missing.join('、') : '', fresh < quotes.size ? (quotes.size - fresh) + ' 条盘口过期或缺失' : ''].filter(Boolean).join('；') };
    },
    closeStreams, snapshot, healthy: () => !storageError && alerts.healthy(),
    metrics: () => ({ ...metrics, generatedAt: clock(), quotes: quotes.size, pendingWrites: dirty.size, pendingObservations: pendingQuotes.size,
      collection: { observationIntervalMs, discoveryIntervalMs, marketMetricsIntervalMs: MARKET_METRICS_POLL_MS, auxiliaryBookIntervalMs: AUXILIARY_BOOK_POLL_MS },
      connections: connections.size, clients: clients.size, rssMb: Number((process.memoryUsage.rss() / 1048576).toFixed(1)), storageError, events: healthEvents.filter(item => clock() - item.at <= 3_600_000), auxiliary: [...pollBudgets].map(([host, budget]) => ({ host, sentInWindow: budget.sent, retryAt: budget.blockedUntil })), venues: snapshot().exchanges.map(exchange => ({ ...exchange, sourceLagMs: states.get(exchange.id).lastSourceLagMs, sourceLagObservedAt: states.get(exchange.id).sourceLagObservedAt ?? null, rejectedFuture: states.get(exchange.id).rejectedFuture, reconnects: states.get(exchange.id).reconnects ?? 0, lastConnectedAt: states.get(exchange.id).lastConnectedAt ?? null, lastProtocolError: states.get(exchange.id).lastProtocolError ?? null })) }),
    actions: { 'crossex-settings': ['GET', 'PUT'], quote: ['GET'], summary: ['GET'], opportunities: ['GET'], 'opportunities-v2': ['GET'], stream: ['GET'], diagnostics: ['GET'], quality: ['POST'], 'funding-history': ['POST'], 'price-history': ['POST'], metrics: ['POST'], 'scanner-data': ['POST'], alerts: ['GET', 'PUT'], depth: ['POST'], exit: ['POST'], paper: ['GET', 'POST'], fx: ['GET'] },
    handle(action, method, input) { if (action === 'summary') return this.summary(); if (action === 'funding-history') return fundingHistory.read(input); if (action === 'price-history') return priceHistory.read(input); if (action === 'metrics') return marketMetrics.read(input); if (action === 'scanner-data') return scannerData.read(input); if (action === 'crossex-settings') return method === 'PUT' ? crossex.update(input) : crossex.view(); if (action === 'opportunities-v2') return readOpportunitiesV2(snapshot(), clock(), (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), execution.peekFx(), `${streamId}:${sourceRevision}`, crossex.filter()); if (action === 'opportunities') return createPerpetualOpportunities(snapshot(), clock(), (exchange, symbol) => states.get(exchange)?.markets?.get(symbol), crossex.filter()); if (action === 'quote') return snapshot(); if (action === 'diagnostics') return { ...this.metrics(), quality: quality?.metrics() ?? null, fundingHistory: fundingHistory.metrics(), priceHistory: priceHistory.metrics(), marketMetrics: marketMetrics.metrics(), alerts: alerts.metrics(), execution: execution.metrics(), paper: paper.metrics() }; if (action === 'quality') { if (!quality) throw new Error('质量采集服务未就绪'); return quality.read(input); } if (action === 'alerts') return method === 'PUT' ? alerts.update(input) : alerts.view(); if (action === 'depth') return execution.depth(input); if (action === 'exit') return execution.exit(input); if (action === 'paper') return method === 'POST' ? paper.update(input) : paper.view(); if (action === 'fx') return execution.fx(); },
    stream(request, response) {
      const gzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(request.headers['accept-encoding'] ?? '');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', Vary: 'Accept-Encoding', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
      // Streaming compression keeps full-market updates practical on mobile links.
      const output = gzip ? createGzip({ level: 1, flush: zlibConstants.Z_SYNC_FLUSH }) : response;
      if (gzip) { output.pipe(response); output.on('error', () => response.destroy()); }
      const initial = snapshot();
      if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); for (const quote of initial.quotes) publishedQuotes.set(`${quote.exchange}:${quote.symbol}`, quote); }
      // Join the exact shared patch baseline. An immediate newer quote can
      // reverse before the next broadcast, which then omits that price field;
      // sending it here would leave the new reader with a wrong price despite
      // a continuous sequence. This also avoids a second full snapshot.
      else initial.quotes = [...publishedQuotes.values()];
      metrics.fullFrames++;
      output.write(`retry: 5000\ndata: ${JSON.stringify(initial)}\n\n`);
      clients.set(response, { output, needsSnapshot: false });
      response.once('close', () => { clients.delete(response); if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); } if (gzip) output.destroy(); });
    },
  };
}

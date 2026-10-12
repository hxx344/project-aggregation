import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createPerpetualMarketMetricsService, perpetualMetricsIdentity } from '../server/perpetual-market-metrics.mjs';
import { createPerpetualMetricsReader } from '../server/perpetual-metrics-reader.mjs';

const NOW = Date.UTC(2026, 9, 8, 12), STEP = 300000;
const quote = (exchange, symbol = 'BTCUSDT', extra = {}) => ({ exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', comparable: true, multiplier: 1, ...extra });
const pair = (long, short) => ({ base: long.base, longKey: `${long.exchange}:${long.symbol}`, shortKey: `${short.exchange}:${short.symbol}` });
const metric = (value = 10, extra = {}) => ({ value, currency: 'USDT', observedAt: NOW, source: 'fixture', error: '', ...extra });
const result = (extra = {}) => ({ volume24h: metric(), openInterest: metric(0), ...extra });
function memoryStore() {
  const rows = new Map();
  return { rows, loadContractMetrics: (key, limit = 500) => structuredClone([...rows.values()].filter(row => !key || row.key === key).slice(0, limit)), saveContractMetrics: entry => rows.set(entry.key, structuredClone(entry)) };
}
function fixture(t, options = {}) {
  let now = options.now ?? NOW, calls = 0;
  const quotes = options.quotes ?? [quote('binance'), quote('bybit')], markets = new Map(quotes.map(row => [`${row.exchange}:${row.symbol}`, { ...row }]));
  const store = options.store ?? memoryStore();
  const reader = Object.assign(async (...args) => { calls++; return options.reader ? options.reader(...args) : result(); },
    { isCached: options.reader?.isCached, retryAt: options.reader?.retryAt, stop: options.reader?.stop });
  const service = createPerpetualMarketMetricsService({ getSnapshot: () => ({ quotes }), getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => now, store, hostSpacingMs: 0,
    reader, ...options.service });
  if (options.start !== false) service.start(); t.after(() => service.stop());
  return { service, quotes, markets, store, read: (pairs = [pair(quotes[0], quotes[1])]) => service.read({ pairs }), advance: ms => { now += ms; }, now: () => now, calls: () => calls };
}

test('reads return immediately, merge repeated legs across pairs, and perform no upstream work before background collection', async t => {
  const f = fixture(t, { quotes: [quote('binance'), quote('bybit'), quote('gate')] });
  const pairs = [pair(f.quotes[0], f.quotes[1]), pair(f.quotes[0], f.quotes[2])];
  assert.equal(Object.keys(f.read(pairs).legs).length, 3); assert.equal(f.calls(), 0); f.read(pairs);
  await f.service.collect(); assert.equal(f.calls(), 3); assert.equal(f.read().legs['binance:BTCUSDT'].openInterest.value, 0);
  await f.service.collect(); assert.equal(f.calls(), 3);
});

test('registered contracts keep refreshing after the browser leaves and do not use the former 120-second watch timeout', async t => {
  const f = fixture(t); f.read(); await f.service.collect();
  f.advance(29_999); await f.service.collect(); assert.equal(f.calls(), 2);
  f.advance(1); await f.service.collect(); assert.equal(f.calls(), 4);
  f.advance(120001); await f.service.collect(); assert.equal(f.calls(), 6);
  f.advance(30_000); await f.service.collect(); assert.equal(f.calls(), 8);
});

test('expired cache-hit HTTP reads only return old snapshots and never wake an upstream refresh', async t => {
  const f = fixture(t, { service: { intervalMs: 60000 } });
  f.read(); await f.service.collect(); await turn(); f.advance(STEP + 1);
  for (let i = 0; i < 20; i++) assert.equal(f.read().legs['binance:BTCUSDT'].volume24h.observedAt, NOW);
  await turn(); assert.equal(f.calls(), 2);
  await f.service.collect(); assert.equal(f.calls(), 4);
});

test('persisted registrations and successful snapshot TTL survive restart before another HTTP read', async t => {
  const first = fixture(t); first.read(); await first.service.collect(); await first.service.stop();
  const second = fixture(t, { store: first.store });
  await second.service.collect(); assert.equal(second.calls(), 0); assert.equal(second.read().legs['binance:BTCUSDT'].volume24h.value, 10);
  second.advance(29_999); await second.service.collect(); assert.equal(second.calls(), 0);
  second.advance(1); await second.service.collect(); assert.equal(second.calls(), 2);
});

test('restored registrations on a saturated host all refresh before earlier entries repeat', async t => {
  const quotes = Array.from({ length: 310 }, (_, i) => quote('binance', `BTC${i}USDT`)), store = memoryStore(), calls = new Map();
  for (const market of quotes) {
    const key = `${market.exchange}:${market.symbol}`, identity = perpetualMetricsIdentity(market);
    store.saveContractMetrics({ key, identity, market, retryAt: NOW, failures: 0, lastAccessAt: NOW,
      value: { key, exchange: market.exchange, symbol: market.symbol, identity, status: 'ready', fetchedAt: NOW - STEP,
        volume24h: metric(10, { observedAt: NOW - STEP }), openInterest: metric(0, { observedAt: NOW - STEP }), error: '' } });
  }
  const f = fixture(t, { quotes, store, service: { hostSpacingMs: 350, intervalMs: 60000 }, reader: async market => {
    calls.set(market.symbol, (calls.get(market.symbol) ?? 0) + 1); return result();
  } });
  assert.equal(f.service.metrics().cached, 310);
  for (let second = 0; second < 1200; second++) {
    await f.service.collect(); f.advance(1000);
    if (second === 309) {
      assert.equal(calls.size, 310, 'every restored contract refreshes before a second turn begins');
      assert.ok([...calls.values()].every(count => count === 1));
    }
  }
  assert.equal(f.calls(), 1200);
  assert.ok(quotes.every(market => calls.get(market.symbol) >= 3), 'all contracts continue refreshing throughout twenty minutes');
  assert.equal(Math.max(...calls.values()) - Math.min(...calls.values()), 1);
});

test('five hundred registered bulk metrics drain in at most thirty reads per turn using one shared upstream response', async t => {
  const quotes = Array.from({ length: 500 }, (_, index) => quote('bybit', `BTC${index}USDT`)), store = memoryStore();
  for (const market of quotes) {
    const key = `${market.exchange}:${market.symbol}`, identity = perpetualMetricsIdentity(market);
    store.saveContractMetrics({ key, identity, market, retryAt: NOW, failures: 0, lastAccessAt: NOW,
      value: { key, exchange: market.exchange, symbol: market.symbol, identity, status: 'ready', fetchedAt: NOW - STEP,
        volume24h: metric(10, { observedAt: NOW - STEP }), openInterest: metric(0, { observedAt: NOW - STEP }), error: '' } });
  }
  let requests = 0, f;
  const reader = createPerpetualMetricsReader({ clock: () => f.now(), hostSpacingMs: 0, fetchImpl: async () => {
    requests++;
    return { ok: true, status: 200, json: async () => ({ retCode: 0, time: NOW, result: { list: quotes.map(row => ({ symbol: row.symbol, turnover24h: '100', singleOpenInterestValue: '200' })) } }) };
  } });
  f = fixture(t, { quotes, store, reader, service: { hostSpacingMs: 350, intervalMs: 60_000 } });
  for (let tick = 0; tick < 17; tick++) {
    const before = f.calls(); await Promise.all([f.service.collect(), f.service.collect()]);
    assert.ok(f.calls() - before <= 30, 'Concurrent collection triggers share the same bounded turn'); f.advance(1000);
  }
  assert.equal(f.calls(), 500); assert.equal(requests, 1);
  assert.ok([...store.rows.values()].every(entry => entry.value.volume24h.value === 100 && entry.value.volume24h.observedAt === NOW));
});

test('failed updates retain both source timestamps and successful fetchedAt with bounded retry', async t => {
  let fail = false;
  const f = fixture(t, { reader: async () => { if (fail) throw Error('transport'); return result(); } });
  f.read(); await f.service.collect(); fail = true; f.advance(STEP + 1); await f.service.collect();
  const cached = f.read().legs['binance:BTCUSDT'];
  assert.equal(cached.status, 'error'); assert.equal(cached.volume24h.value, 10); assert.equal(cached.volume24h.observedAt, NOW); assert.equal(cached.fetchedAt, NOW);
  await f.service.collect(); assert.equal(f.calls(), 4); f.advance(60001); await f.service.collect(); assert.equal(f.calls(), 6);
});

test('thirty-second successes do not shorten transport failures, restart retry deadlines or unsupported waits', async t => {
  let fail = false;
  const first = fixture(t, { reader: async () => { if (fail) throw Error('offline'); return result(); } });
  first.read(); await first.service.collect(); fail = true; first.advance(30_000); await first.service.collect();
  const cached = first.read().legs['binance:BTCUSDT'];
  assert.equal(cached.volume24h.observedAt, NOW); assert.equal(cached.fetchedAt, NOW);
  await first.service.stop();
  const restarted = fixture(t, { store: first.store, now: NOW + 40_000, reader: async () => { throw Error('offline'); } });
  restarted.advance(49_999); await restarted.service.collect(); assert.equal(restarted.calls(), 0);
  restarted.advance(1); await restarted.service.collect(); assert.equal(restarted.calls(), 2);
  assert.equal(restarted.store.rows.get('binance:BTCUSDT').retryAt, NOW + 90_000 + 120_000);

  const unsupported = fixture(t, { reader: async () => { throw Object.assign(Error('unsupported'), { code: 'UNSUPPORTED' }); } });
  unsupported.read(); await unsupported.service.collect(); await unsupported.service.stop();
  const restored = fixture(t, { store: unsupported.store });
  restored.advance(3_599_999); await restored.service.collect(); assert.equal(restored.calls(), 0);
  restored.advance(1); await restored.service.collect(); assert.equal(restored.calls(), 2);
});

test('one failed metric retains its old amount and source while the successful metric advances', async t => {
  let refresh = false;
  const f = fixture(t, { reader: async () => refresh ? result({ volume24h: metric(20, { observedAt: NOW + STEP }), openInterest: { value: null, currency: null, observedAt: null, source: 'new failed source', error: '持仓读取失败' } }) : result() });
  f.read(); await f.service.collect(); refresh = true; f.advance(STEP); await f.service.collect();
  const leg = f.read().legs['binance:BTCUSDT'];
  assert.equal(leg.volume24h.value, 20); assert.equal(leg.openInterest.value, 0); assert.equal(leg.openInterest.observedAt, NOW); assert.equal(leg.openInterest.source, 'fixture'); assert.equal(leg.openInterest.error, '持仓读取失败');
});

test('delayed snapshots cannot overwrite newer per-metric source observations', async t => {
  let delayed = false;
  const f = fixture(t, { reader: async () => delayed ? result({ volume24h: metric(999, { observedAt: NOW - STEP }) }) : result() });
  f.read(); await f.service.collect(); delayed = true; f.advance(STEP); await f.service.collect();
  const leg = f.read().legs['binance:BTCUSDT'];
  assert.equal(leg.volume24h.value, 10); assert.equal(leg.volume24h.observedAt, NOW); assert.match(leg.volume24h.error, /较旧/);
});

test('whole invalid batches cannot register or persist any contracts', async t => {
  const f = fixture(t), good = pair(...f.quotes);
  for (const pairs of [[good, { ...good, shortKey: 'missing' }], [{ ...good, base: 'ETH' }], Array(31).fill(good), [{ ...good, longKey: good.shortKey }]]) assert.throws(() => f.read(pairs), /有效/);
  f.markets.delete('binance:BTCUSDT'); assert.throws(() => f.read(), /有效/);
  await f.service.collect(); assert.equal(f.calls(), 0); assert.equal(f.service.metrics().cached, 0); assert.equal(f.store.rows.size, 0);
});

test('same-key contract id or face value changes discard prior money and persisted reader state', async t => {
  const f = fixture(t); f.read(); await f.service.collect();
  const oldIdentity = f.read().legs['binance:BTCUSDT'].identity;
  f.markets.set('binance:BTCUSDT', { ...f.markets.get('binance:BTCUSDT'), marketId: 17, contractSize: 0.001 });
  const reset = f.read().legs['binance:BTCUSDT'];
  assert.equal(reset.status, 'pending'); assert.equal(reset.volume24h.value, null); assert.notEqual(reset.identity, oldIdentity);
  await f.service.collect(); assert.equal(f.calls(), 3);
});

test('removing catalog identity metadata invalidates old snapshots and prevents background publication', async t => {
  const quotes = [quote('binance'), quote('bybit')];
  const f = fixture(t, { quotes }); f.markets.get('binance:BTCUSDT').marketId = 12; f.read(); await f.service.collect();
  delete f.markets.get('binance:BTCUSDT').marketId; f.advance(STEP); await f.service.collect();
  assert.equal(f.calls(), 3); assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending');
});

test('malformed upstream numeric values and future timestamps cannot replace successful snapshots', async t => {
  let malformed = false;
  const f = fixture(t, { reader: async () => malformed ? result({ volume24h: metric(NaN) }) : result() });
  f.read(); await f.service.collect(); malformed = true; f.advance(STEP); await f.service.collect();
  const row = f.read().legs['binance:BTCUSDT']; assert.equal(row.status, 'error'); assert.equal(row.volume24h.value, 10); assert.equal(row.fetchedAt, NOW);
});

test('persistent rows with mismatched identities or corrupted source units are ignored', async t => {
  const first = fixture(t); first.read(); await first.service.collect(); await first.service.stop();
  first.store.rows.get('binance:BTCUSDT').value.volume24h.currency = 'evil currency';
  first.store.rows.get('bybit:BTCUSDT').market.base = 'ETH';
  const f = fixture(t, { store: first.store }); assert.equal(f.service.metrics().cached, 0); assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending');
});

test('OKX incremental candle state is bounded and restored through the persistent entry', async t => {
  const quotes = [quote('okx', 'BTC-USDT-SWAP'), quote('bybit')];
  let restored;
  const first = fixture(t, { quotes, reader: async market => result({ readerState: market.exchange === 'okx' ? { version: 1, symbol: market.symbol, currency: 'USDT', candles: [[NOW - STEP, 3]] } : undefined }) });
  first.read(); await first.service.collect(); await first.service.stop();
  const next = fixture(t, { quotes, store: first.store, reader: async (market, options) => { if (market.exchange === 'okx') restored = options.readerState; return result(); } });
  next.advance(STEP); await next.service.collect(); assert.deepEqual(restored.candles, [[NOW - STEP, 3]]);
});

test('host budgets share Hyperliquid/Entropy and stop is safe even for a reader ignoring abort', async t => {
  const releases = [], quotes = ['hyperliquid', 'entropy', 'binance', 'bybit', 'gate'].map(exchange => quote(exchange));
  const f = fixture(t, { quotes, reader: () => new Promise(resolve => releases.push(resolve)) });
  f.read(quotes.slice(1).map(other => pair(quotes[0], other))); void f.service.collect(); await turn();
  assert.equal(f.calls(), 3); assert.equal(f.service.metrics().inFlight, 3);
  await f.service.stop(); releases.forEach(resolve => resolve(result())); await turn();
  assert.equal(f.read().legs['hyperliquid:BTCUSDT'].status, 'pending'); assert.equal(f.service.metrics().inFlight, 0);
  const count = f.calls(); await f.service.collect(); assert.equal(f.calls(), count);
});

test('one stalled host cannot occupy idle slots or block later observation ticks for healthy hosts', async t => {
  const quotes = ['binance', 'bybit', 'gate', 'okx', 'bitget'].map(exchange => quote(exchange)), seen = [];
  const f = fixture(t, { quotes, reader: async market => {
    seen.push(market.exchange); return market.exchange === 'binance' ? new Promise(() => {}) : result();
  } });
  f.read(quotes.slice(1).map(other => pair(quotes[0], other))); await f.service.collect();
  assert.deepEqual(seen, ['binance', 'bybit', 'gate', 'okx', 'bitget']); assert.equal(f.service.metrics().inFlight, 1);
  f.advance(35_000); await f.service.collect();
  assert.deepEqual(seen.slice(5), ['bybit', 'gate', 'okx', 'bitget']); assert.equal(f.service.metrics().inFlight, 1);
});

test('rate limits hold all registered contracts sharing the host', async t => {
  const quotes = ['hyperliquid', 'entropy', 'bybit'].map(exchange => quote(exchange));
  const hosts = [];
  const f = fixture(t, { quotes, reader: async market => { hosts.push(market.exchange); if (market.exchange === 'hyperliquid') throw Object.assign(Error('limit'), { status: 429, retryAfterMs: 180000 }); return result(); } });
  f.read([pair(quotes[0], quotes[2]), pair(quotes[1], quotes[2])]); await f.service.collect(); await f.service.collect(); assert.equal(f.calls(), 2);
  f.advance(60000); await f.service.collect(); assert.deepEqual(hosts, ['hyperliquid', 'bybit', 'bybit']);
});

test('a host rate-limit deadline survives restart for both the failing registration and its unqueried peers', async t => {
  const quotes = ['hyperliquid', 'entropy', 'bybit'].map(exchange => quote(exchange));
  const first = fixture(t, { quotes, reader: async market => {
    if (market.exchange === 'hyperliquid') throw Object.assign(Error('limited'), { status: 429, retryAfterMs: 180_000 }); return result();
  } });
  first.read([pair(quotes[0], quotes[2]), pair(quotes[1], quotes[2])]); await first.service.collect(); await first.service.stop();
  assert.equal(first.store.rows.get('entropy:BTCUSDT').hostRetryAt, NOW + 180_000);
  const hosts = [], next = fixture(t, { quotes, store: first.store, now: NOW + 30_000, reader: async market => { hosts.push(market.exchange); return result(); } });
  next.advance(149_999); await next.service.collect(); assert.deepEqual(hosts, ['bybit']);
  next.advance(1); await next.service.collect(); await next.service.collect();
  assert.ok(hosts.includes('hyperliquid')); assert.ok(hosts.includes('entropy'));
});

test('partial Binance success persists a reader rate limit without freshening retained source data', async t => {
  let f;
  const reader = createPerpetualMetricsReader({ clock: () => f.now(), hostSpacingMs: 0, fetchImpl: async url => {
    if (url.includes('openInterestHist')) return { ok: false, status: 429, headers: { get: () => '120' } };
    return { ok: true, status: 200, json: async () => url.includes('bybit')
      ? { retCode: 0, time: NOW, result: { list: [{ symbol: 'BTCUSDT', turnover24h: '10', singleOpenInterestValue: '20' }] } }
      : [{ symbol: 'BTCUSDT', quoteVolume: '10', closeTime: NOW - STEP }] };
  } });
  f = fixture(t, { reader }); f.read(); await f.service.collect();
  const value = f.read().legs['binance:BTCUSDT'];
  assert.equal(value.status, 'ready'); assert.equal(value.volume24h.observedAt, NOW - STEP); assert.equal(value.openInterest.value, null);
  assert.equal(f.store.rows.get('binance:BTCUSDT').hostRetryAt, NOW + 120_000); await f.service.stop();
  const hosts = [], next = fixture(t, { store: f.store, reader: async market => { hosts.push(market.exchange); return result(); } });
  next.advance(119_999); await next.service.collect(); assert.deepEqual(hosts, ['bybit']);
  next.advance(1); await next.service.collect(); assert.ok(hosts.includes('binance'));
});

test('bounded memory may restore evicted snapshots from disk without another upstream read', async t => {
  const quotes = [quote('bybit'), ...Array.from({ length: 4 }, (_, i) => quote('binance', `BTC${i}USDT`))];
  const f = fixture(t, { quotes, service: { cacheLimit: 3 } });
  for (const other of quotes.slice(1)) { f.read([pair(quotes[0], other)]); await f.service.collect(); }
  assert.equal(f.service.metrics().cached, 3); const before = f.calls(); f.read([pair(quotes[0], quotes[1])]); await f.service.collect(); assert.equal(f.calls(), before);
});

test('storage failures remain visible without losing usable memory data', async t => {
  const f = fixture(t, { store: { saveContractMetrics() { throw Error('disk full'); }, loadContractMetrics() { return []; } } });
  f.read(); await f.service.collect(); const report = f.read();
  assert.match(report.storageError, /写入失败/); assert.equal(report.legs['binance:BTCUSDT'].volume24h.value, 10);
});

test('disk recovery retries dirty writes independently of the thirty-second upstream refresh', async t => {
  const backing = memoryStore(); let failed = true, writes = 0;
  const store = { loadContractMetrics: backing.loadContractMetrics, saveContractMetrics(entry) { writes++; if (failed) throw Error('disk full'); backing.saveContractMetrics(entry); } };
  const f = fixture(t, { store }); f.read(); await f.service.collect();
  assert.equal(f.calls(), 2); assert.equal(backing.rows.size, 0); assert.match(f.service.metrics().storageError, /写入失败/);
  const attempts = writes; await f.service.collect(); assert.equal(writes, attempts);
  failed = false; f.advance(5001); await f.service.collect();
  assert.equal(f.calls(), 2); assert.equal(backing.rows.size, 2); assert.equal(backing.rows.get('binance:BTCUSDT').value.volume24h.value, 10);
  assert.equal(f.service.metrics().storageError, ''); assert.equal(f.read().storageError, undefined);
});

test('dirty entries are not evicted and shutdown makes one final persistence attempt without fetching', async t => {
  const backing = memoryStore(); let failed = true;
  const store = { loadContractMetrics: backing.loadContractMetrics, saveContractMetrics(entry) { if (failed) throw Error('busy'); backing.saveContractMetrics(entry); } };
  const quotes = [quote('binance'), quote('bybit'), quote('gate')];
  const f = fixture(t, { quotes, store, service: { cacheLimit: 2 } }); f.read(); await f.service.collect();
  const report = f.read([pair(quotes[1], quotes[2])]); assert.match(report.legs['gate:BTCUSDT'].error, /繁忙/); assert.equal(f.service.metrics().cached, 2);
  failed = false; await f.service.stop(); assert.equal(f.calls(), 2); assert.equal(backing.rows.size, 2);
});

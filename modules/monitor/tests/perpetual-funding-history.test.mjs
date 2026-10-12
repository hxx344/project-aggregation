import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { fundingWindowTotal, PERPETUAL_FUNDING_STALE_MS } from '../lib/perpetual-funding-history.ts';
import { createPerpetualFundingHistoryService } from '../server/perpetual-funding-history.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 6, 12);
const quote = (exchange, symbol = 'BTCUSDT', extra = {}) => ({ exchange, symbol, base: 'BTC', quoteCurrency: 'USDT', comparable: true, ...extra });
const pair = (long, short) => ({ base: long.base, longKey: `${long.exchange}:${long.symbol}`, shortKey: `${short.exchange}:${short.symbol}` });
const settlements = (hours = 96, rate = 0.0001) => Array.from({ length: hours + 1 }, (_, index) => ({ time: NOW - index * HOUR, rate }));
const within = (range, rate = 0.0001) => {
  const records = [];
  for (let time = Math.ceil(range.from / HOUR) * HOUR; time <= range.to; time += HOUR) records.push({ time, rate });
  return records;
};
const leg = (extra = {}) => ({ key: 'binance:BTCUSDT', exchange: 'binance', symbol: 'BTCUSDT', status: 'ready', fetchedAt: NOW, coverage: { from: NOW - 96 * HOUR, to: NOW }, records: settlements(), error: '', ...extra });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('rolling actual settlements exclude the left boundary and include the right, without 8h normalization', () => {
  const long = leg({ records: settlements(96, -0.0001) });
  const short = leg({ records: settlements(12, 0.0002).map((row, index) => ({ ...row, time: NOW - index * 8 * HOUR })) });
  const day = fundingWindowTotal(long, short, 24, NOW), three = fundingWindowTotal(long, short, 72, NOW);
  assert.equal(day.status, 'ready'); assert.equal(day.longCount, 24); assert.equal(day.shortCount, 3);
  near(day.netPercent, 0.30); near(three.netPercent, 0.90);
  near(fundingWindowTotal(short, long, 24, NOW).netPercent, -0.30);
});

test('two legs use the same successful coverage cutoff, excluding newer settlements on one leg', () => {
  const long = leg({ coverage: { from: NOW - 96 * HOUR, to: NOW - HOUR }, records: settlements().slice(1) });
  const short = leg({ records: [{ time: NOW, rate: 0.2 }, ...settlements(96, 0.0002).slice(1)] });
  const total = fundingWindowTotal(long, short, 24, NOW);
  assert.equal(total.asOf, NOW - HOUR); assert.equal(total.status, 'stale'); near(total.netPercent, 0.24);
});

test('one-day history may be complete while three days lack the preceding settlement', () => {
  const recent = leg({ records: settlements(40) });
  assert.equal(fundingWindowTotal(recent, leg(), 24, NOW).status, 'ready');
  const total = fundingWindowTotal(recent, leg(), 72, NOW);
  assert.equal(total.status, 'partial'); assert.equal(total.netPercent, null); assert.equal(total.longPercent, null);
});

test('missing, unsupported and empty histories never become zero; real settled zero is valid', () => {
  assert.equal(fundingWindowTotal(undefined, leg(), 24, NOW).status, 'pending');
  assert.equal(fundingWindowTotal(leg({ status: 'unsupported', error: '无法核实' }), leg(), 24, NOW).status, 'unsupported');
  assert.equal(fundingWindowTotal(leg({ records: [] }), leg(), 24, NOW).netPercent, null);
  assert.equal(fundingWindowTotal(leg({ records: settlements(96, 0) }), leg({ records: settlements(96, 0) }), 72, NOW).netPercent, 0);
  assert.equal(fundingWindowTotal(leg({ status: 'error', coverage: null, error: '读取失败' }), leg(), 24, NOW).status, 'error');
});

test('old coverage, failed updates and future clocks are explicitly marked while retaining old totals', () => {
  assert.equal(fundingWindowTotal(leg(), leg(), 24, NOW + PERPETUAL_FUNDING_STALE_MS + 1).status, 'stale');
  const failed = fundingWindowTotal(leg({ status: 'error', error: '读取失败', fetchedAt: NOW + 1000 }), leg(), 24, NOW + 1000);
  assert.equal(failed.status, 'error'); assert.equal(failed.asOf, NOW); assert.equal(failed.netPercent, 0);
  assert.equal(fundingWindowTotal(leg(), leg(), 24, NOW - 6000).status, 'stale');
});

test('7-day and 30-day windows share actual records with exact boundaries and direction', () => {
  const long = leg({ coverage: { from: NOW - 32 * 24 * HOUR, to: NOW }, records: settlements(32 * 24, -.0001) });
  const short = leg({ ...long, records: settlements(32 * 24, .0002) });
  for (const hours of [24, 72, 168, 720]) {
    const total = fundingWindowTotal(long, short, hours, NOW);
    assert.equal(total.status, 'ready'); assert.equal(total.longCount, hours);
    near(total.netPercent, hours * .03);
    near(fundingWindowTotal(short, long, hours, NOW).netPercent, -total.netPercent);
  }
  const partial = { ...long, backfillComplete: false, coverage: { from: NOW - 4 * 24 * HOUR, to: NOW }, records: settlements() };
  assert.equal(fundingWindowTotal(partial, short, 24, NOW).status, 'ready');
  assert.equal(fundingWindowTotal(partial, short, 168, NOW).status, 'pending');
  assert.equal(fundingWindowTotal({ ...partial, backfillComplete: true }, short, 720, NOW).status, 'partial');
});

function fixture(t, options = {}) {
  let now = NOW, calls = 0;
  const quotes = options.quotes ?? [quote('binance'), quote('bybit')], markets = new Map(quotes.map(row => [`${row.exchange}:${row.symbol}`, row]));
  const service = createPerpetualFundingHistoryService({ getSnapshot: () => ({ quotes }), getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => now,
    reader: async (...args) => { calls++; return options.reader ? options.reader(...args) : within(args[1]); }, hostSpacingMs: 0, ...options.service });
  service.start(); t.after(() => service.stop());
  return { service, quotes, markets, read: (pairs = [pair(quotes[0], quotes[1])]) => service.read({ pairs }), advance: ms => { now += ms; }, calls: () => calls };
}

test('reads reuse one contract cache while bounded chunks backfill once, then only the tail refreshes', async t => {
  const ranges = [], f = fixture(t, { reader: async (market, range) => { ranges.push({ key: market.exchange, ...range }); return within(range); } });
  assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending'); assert.equal(f.calls(), 0);
  f.read(); await f.service.collect();
  assert.equal(f.calls(), 2); assert.equal(f.read().legs['binance:BTCUSDT'].status, 'ready');
  for (let chunk = 1; chunk < 8; chunk++) await f.service.collect();
  assert.equal(f.calls(), 16); assert.equal(f.read().legs['binance:BTCUSDT'].backfillComplete, true);
  assert.equal(new Set(ranges.map(range => JSON.stringify(range))).size, 16);
  for (let read = 0; read < 10; read++) f.read();
  await turn(); await f.service.collect(); assert.equal(f.calls(), 16);
  f.advance(300_001); f.read(); await turn(); assert.equal(f.calls(), 16, 'Reading a cache does not trigger its refresh');
  await f.service.collect(); assert.equal(f.calls(), 18);
  assert.equal(ranges.at(-1).from, NOW - 2 * HOUR); assert.equal(ranges.at(-1).to, NOW + 300_001);
  assert.equal(f.read().legs['binance:BTCUSDT'].records.length, 768);
});

test('failed refresh retains successful records and coverage and retries with backoff', async t => {
  let fail = false;
  const f = fixture(t, { reader: async () => { if (fail) throw Error('transport'); return settlements(); } });
  f.read(); await f.service.collect(); fail = true; f.advance(300_001); f.read(); await f.service.collect();
  const cached = f.read().legs['binance:BTCUSDT'];
  assert.equal(cached.status, 'error'); assert.equal(cached.coverage.to, NOW); assert.equal(cached.fetchedAt, NOW); assert.equal(cached.records.length, 97);
  await f.service.collect(); assert.equal(f.calls(), 4);
  f.advance(60_001); f.read(); await f.service.collect(); assert.equal(f.calls(), 6);
});

test('invalid batches cannot schedule arbitrary contracts, mismatched bases, or oversized reads', async t => {
  const f = fixture(t), good = pair(...f.quotes);
  for (const pairs of [[{ ...good, longKey: 'https://example.invalid' }], [{ ...good, base: 'ETH' }], Array(31).fill(good), [good, { ...good, shortKey: good.longKey }]]) assert.throws(() => f.read(pairs), /有效/);
  await f.service.collect(); assert.equal(f.calls(), 0); assert.equal(f.service.metrics().cached, 0);
});

test('contract directory identity changes invalidate records and malformed settlements are rejected', async t => {
  let malformed = false;
  const f = fixture(t, { reader: async () => malformed ? [{ time: NOW, rate: NaN }] : settlements() });
  f.read(); await f.service.collect();
  f.markets.set('binance:BTCUSDT', { ...f.quotes[0], marketId: 123 }); malformed = true;
  assert.equal(f.read().legs['binance:BTCUSDT'].status, 'pending'); await f.service.collect();
  const value = f.read().legs['binance:BTCUSDT'];
  assert.equal(value.status, 'error'); assert.equal(value.coverage, null); assert.deepEqual(value.records, []);
});

test('queue caps concurrency, shares host budgets and keeps registered contracts updating without watches', async t => {
  const releases = [], quotes = ['hyperliquid', 'entropy', 'binance', 'bybit', 'gate'].map(exchange => quote(exchange));
  const f = fixture(t, { quotes, reader: () => new Promise(resolve => { releases.push(() => resolve(settlements())); }) });
  f.read(quotes.slice(1).map(other => pair(quotes[0], other)));
  const first = f.service.collect(); await turn();
  assert.equal(f.calls(), 3); assert.equal(f.service.metrics().inFlight, 3);
  releases.splice(0).forEach(release => release()); await first;
  f.advance(120_001); const next = f.service.collect(); await turn();
  assert.equal(f.service.metrics().inFlight, 3); assert.equal(f.calls(), 6);
  releases.splice(0).forEach(release => release()); await next;
});

test('rate limits defer all contracts on the same host; stopped jobs cannot publish', async t => {
  const called = [];
  const quotes = [quote('hyperliquid'), quote('entropy'), quote('bybit')];
  const f = fixture(t, { quotes, reader: async market => {
    called.push(market.exchange);
    if (market.exchange === 'hyperliquid') throw Object.assign(Error('limit'), { status: 429, retryAfterMs: 180_000 });
    return settlements();
  } });
  f.read([pair(quotes[0], quotes[2]), pair(quotes[1], quotes[2])]); await f.service.collect();
  await f.service.collect(); assert.equal(called.filter(exchange => exchange !== 'bybit').length, 1);
  f.advance(60_000); f.read([pair(quotes[1], quotes[2])]); await f.service.collect(); assert.equal(called.filter(exchange => exchange !== 'bybit').length, 1);
  let aborted = false;
  const pending = fixture(t, { reader: (_market, _range, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }); }) });
  pending.read(); void pending.service.collect(); await turn(); await pending.service.stop();
  assert.equal(aborted, true); assert.equal(pending.read().legs['binance:BTCUSDT'].status, 'pending');
});

test('cache is bounded and requests after stop cannot start new work', async t => {
  const quotes = [quote('bybit'), ...Array.from({ length: 6 }, (_, index) => quote('binance', `BTC${index}USDT`))];
  const f = fixture(t, { quotes, service: { cacheLimit: 4 } });
  for (const other of quotes.slice(1)) { f.read([pair(quotes[0], other)]); await f.service.collect(); }
  assert.ok(f.service.metrics().cached <= 4);
  await f.service.stop(); const calls = f.calls(); f.read(); await f.service.collect(); assert.equal(f.calls(), calls);
});

test('perpetual runtime exposes the history action with existing service dispatch', async () => {
  const quotes = [quote('binance'), quote('bybit')];
  const service = createPerpetualService({ exchanges: quotes.map(row => ({ id: row.exchange, kind: 'cex' })), store: { load: () => quotes, close() {}, save() {} }, fundingHistoryOptions: { reader: async () => settlements() } });
  assert.deepEqual(service.actions['funding-history'], ['POST']);
  const report = service.handle('funding-history', 'POST', { pairs: [pair(...quotes)] });
  assert.equal(report.schemaVersion, 1); assert.equal(Object.keys(report.legs).length, 2);
  await service.stop();
});

test('failed backfill preserves contiguous progress, then resumes the missing chunk', async t => {
  let fail = false;
  const requested = [], f = fixture(t, { reader: async (market, range) => {
    requested.push({ key: market.exchange, ...range });
    if (fail) throw Error('offline');
    return within(range);
  } });
  f.read(); await f.service.collect(); await f.service.collect();
  const before = f.read().legs['binance:BTCUSDT'];
  assert.equal(before.coverage.from, NOW - 8 * 24 * HOUR);
  fail = true; await f.service.collect();
  assert.deepEqual(f.read().legs['binance:BTCUSDT'].coverage, before.coverage);
  assert.equal(f.read().legs['binance:BTCUSDT'].records.length, before.records.length);
  fail = false; f.advance(60_001); await f.service.collect();
  assert.equal(requested.at(-1).to, before.coverage.from);
  assert.equal(f.read().legs['binance:BTCUSDT'].coverage.from, NOW - 12 * 24 * HOUR);
});

test('durable complete caches restart without downloads, then refresh even with no browser read', async t => {
  const disk = new Map(), ranges = [];
  const store = { loadFundingHistory: key => [...disk.values()].filter(entry => !key || entry.key === key).map(entry => structuredClone(entry)), saveFundingHistory: entry => disk.set(entry.key, structuredClone(entry)) };
  const first = fixture(t, { service: { store } }); first.read();
  for (let index = 0; index < 8; index++) await first.service.collect();
  await first.service.stop(); assert.equal(disk.size, 2);
  const restarted = fixture(t, { service: { store }, reader: async (_market, range) => { ranges.push(range); return within(range); } });
  await turn(); await restarted.service.collect(); assert.equal(restarted.calls(), 0);
  assert.equal(restarted.read().legs['binance:BTCUSDT'].backfillComplete, true);
  restarted.advance(300_001); await restarted.service.collect();
  assert.equal(restarted.calls(), 2);
  assert.equal(ranges[0].from, NOW - 2 * HOUR);
  assert.equal(disk.get('binance:BTCUSDT').value.coverage.to, NOW + 300_001);
});

test('durable partial caches resume backfill and evicted contracts reload from disk', async t => {
  const disk = new Map();
  const store = { loadFundingHistory: key => [...disk.values()].filter(entry => !key || entry.key === key).map(entry => structuredClone(entry)), saveFundingHistory: entry => disk.set(entry.key, structuredClone(entry)) };
  const first = fixture(t, { service: { store } }); first.read(); await first.service.collect(); await first.service.collect(); await first.service.stop();
  const ranges = [], restarted = fixture(t, { service: { store }, reader: async (_market, range) => { ranges.push(range); return within(range); } });
  await restarted.service.collect();
  assert.equal(ranges[0].to, NOW - 8 * 24 * HOUR);
  assert.equal(restarted.read().legs['binance:BTCUSDT'].coverage.from, NOW - 12 * 24 * HOUR);
  await restarted.service.stop();
  // Disk-backed entries can be read even if they were outside the startup hot set.
  const late = fixture(t, { service: { store: { ...store, loadFundingHistory: key => key ? store.loadFundingHistory(key) : [] } } });
  assert.equal(late.read().legs['binance:BTCUSDT'].coverage.from, NOW - 12 * 24 * HOUR);
  assert.equal(late.calls(), 0);
});

test('persist retries do not fetch again and untrusted/corrupt persisted data is never exposed', async t => {
  let diskFailed = true, saved = 0;
  const store = { loadFundingHistory: () => [{ key: 'binance:BTCUSDT', market: quote('binance'), value: { records: [{ time: NOW, rate: NaN }] } }], saveFundingHistory: () => { if (diskFailed) throw Error('disk full'); saved++; } };
  const f = fixture(t, { service: { store }, reader: async (_market, range, options) => {
    options.onProgress({ coverage: range, records: within(range) }); return within(range);
  } });
  assert.equal(f.read().legs['binance:BTCUSDT'].coverage, null);
  for (let index = 0; index < 8; index++) await f.service.collect();
  assert.match(f.read().storageError, /保存失败/); const calls = f.calls();
  diskFailed = false; f.advance(5001); await f.service.collect();
  assert.equal(f.calls(), calls); assert.equal(saved, 2); assert.equal(f.read().storageError, undefined);
});

test('overlapping settlement conflicts cannot widen successful coverage or overwrite cached rates', async t => {
  let conflict = false;
  const f = fixture(t, { reader: async (_market, range) => within(range, conflict ? .5 : .0001) });
  f.read(); await f.service.collect(); const before = f.read().legs['binance:BTCUSDT'];
  conflict = true; await f.service.collect();
  const after = f.read().legs['binance:BTCUSDT'];
  assert.equal(after.status, 'error'); assert.deepEqual(after.coverage, before.coverage); assert.deepEqual(after.records, before.records);
});

test('more than 300 contracts on one host all start and backfill despite continuously due refreshes', async t => {
  let now = NOW;
  const markets = Array.from({ length: 310 }, (_, index) => quote('binance', `C${index}USDT`, { base: `C${index}` }));
  const catalog = new Map(markets.map(market => [market.symbol, market])), calls = new Map(), saved = new Map();
  const pending = markets.map(market => {
    const key = `binance:${market.symbol}`, identity = JSON.stringify([market.exchange, market.symbol, market.base, market.quoteCurrency, null, 1, null, null]);
    return { key, identity, market, lastAccessAt: NOW, retryAt: 0, value: { key, identity, exchange: 'binance', symbol: market.symbol, status: 'pending', fetchedAt: null, coverage: null, records: [], error: '', backfillComplete: false, nextRefreshAt: 0 } };
  });
  const service = createPerpetualFundingHistoryService({ clock: () => now, getSnapshot: () => ({ quotes: markets }), getMarket: (_exchange, symbol) => catalog.get(symbol),
    store: { loadFundingHistory: () => pending, saveFundingHistory: entry => saved.set(entry.key, structuredClone(entry)) },
    reader: async (market, range) => { calls.set(market.symbol, (calls.get(market.symbol) ?? 0) + 1); return within(range); } });
  t.after(() => service.stop()); service.start();
  for (let second = 0; second < 1200; second++) { await service.collect(); now += 1000; }
  assert.equal(calls.size, markets.length);
  for (const market of markets) {
    const value = saved.get(`binance:${market.symbol}`).value;
    assert.ok(value.coverage.to - value.coverage.from >= 8 * 24 * HOUR, `${market.symbol} backfill starved`);
  }
  for (let second = 1200; second < 6000; second++) { await service.collect(); now += 1000; }
  for (const market of markets) assert.equal(saved.get(`binance:${market.symbol}`).value.backfillComplete, true, `${market.symbol} never finished 32 days`);
});

test('retrying failed refreshes cannot monopolize the host ahead of new contracts', async t => {
  let now = NOW;
  const calls = new Set(), entries = Array.from({ length: 310 }, (_, index) => {
    const market = quote('binance', `C${index}USDT`, { base: `C${index}` }), key = `binance:${market.symbol}`;
    const identity = JSON.stringify([market.exchange, market.symbol, market.base, market.quoteCurrency, null, 1, null, null]);
    const coverage = index < 300 ? { from: NOW - 33 * 24 * HOUR, to: NOW - 24 * HOUR } : null;
    return { key, identity, market, lastAccessAt: NOW, retryAt: 0, value: { key, identity, exchange: 'binance', symbol: market.symbol, status: coverage ? 'ready' : 'pending', fetchedAt: coverage?.to ?? null, coverage, records: coverage ? within(coverage) : [], error: '', backfillComplete: Boolean(coverage), nextRefreshAt: coverage ? NOW - 23 * HOUR : 0 } };
  });
  const catalog = new Map(entries.map(entry => [entry.market.symbol, entry.market]));
  const service = createPerpetualFundingHistoryService({ clock: () => now, getSnapshot: () => ({ quotes: [...catalog.values()] }), getMarket: (_exchange, symbol) => catalog.get(symbol),
    store: { loadFundingHistory: () => entries }, reader: async (market, range) => {
      calls.add(market.symbol); if (Number(market.base.slice(1)) < 300) throw Error('Persistent upstream failure'); return within(range);
    } });
  t.after(() => service.stop()); service.start();
  for (let second = 0; second < 1800; second++) { await service.collect(); now += 1000; }
  assert.equal(calls.size, entries.length);
});

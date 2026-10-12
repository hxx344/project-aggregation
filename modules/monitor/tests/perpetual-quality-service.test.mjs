import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createPerpetualQualityService } from '../server/perpetual-quality-service.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { createHandler } from '../server/http.mjs';

const START = 1_790_000_100_000;
const key = quote => `${quote.exchange}:${quote.symbol}`;
const pair = (long, short) => ({ base: long.base, longKey: key(long), shortKey: key(short) });
const pairId = row => JSON.stringify([row.base, row.longKey, row.shortKey]);
function quote(exchange = 'binance', base = 'BTC', extra = {}) {
  return { exchange, base, symbol: `${base}USDT`, quoteCurrency: 'USDT', multiplier: 1, comparable: true,
    bid: exchange === 'binance' ? 100 : 102, ask: exchange === 'binance' ? 101 : 103,
    fundingRate: exchange === 'binance' ? 0.0001 : 0.0002, fundingIntervalHours: 8, ...extra };
}
const ratio = (quote, observedAt) => ({ exchange: quote.exchange, symbol: quote.symbol,
  longRatio: 0.6, shortRatio: 0.4, kind: 'accounts', scope: '合约全体持仓账户（5 分钟）',
  source: 'https://example.invalid/official-series', observedAt });
const cexQuotes = (base = 'BTC') => [
  quote('binance', base), quote('bybit', base),
  quote('okx', base, { symbol: `${base}-USDT-SWAP` }), quote('bitget', base),
  quote('gate', base, { symbol: `${base}_USDT` }),
];
function fixture(options = {}) {
  let now = START, snapshotReads = 0, refreshes = 0, fetches = 0, saves = 0;
  const quotes = options.quotes ?? [quote(), quote('bybit')];
  const assets = new Map();
  const fundamentals = {
    get: base => assets.get(base) ?? null,
    describe: () => ({ status: 'pending' }),
    refresh: async (...args) => { refreshes++; return options.refresh?.(...args); },
  };
  const store = options.store ?? { loadQualitySamples: () => [], saveQualitySample() { saves++; } };
  const getSnapshot = () => {
    snapshotReads++;
    return { schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000,
      exchanges: [...new Set(quotes.map(row => row.exchange))].map(id => ({ id, kind: ['lighter', 'hyperliquid', 'aster', 'entropy', 'rh-lighter'].includes(id) ? 'dex' : 'cex', status: 'live' })),
      quotes: quotes.map(row => ({ bidAskAt: now, fundingAt: now, receivedAt: now, ...row })),
    };
  };
  const service = createPerpetualQualityService({ getSnapshot, store, fundamentals, clock: () => now,
    shouldDeferAuxiliary: options.shouldDeferAuxiliary,
    positioningFetch: async (...args) => { fetches++; return options.fetch ? options.fetch(...args) : ratio(args[0], now - 300_000); },
  });
  return { service, quotes, assets, fundamentals, getSnapshot, setNow: value => { now = value; }, advance: ms => { now += ms; },
    now: () => now, counts: () => ({ snapshotReads, refreshes, fetches, saves }),
    watch: (rows = [pair(quotes[0], quotes[1])]) => service.read({ pairs: rows }),
    async start(t) { t.after(() => service.stop()); service.start(); await nextTurn(); },
  };
}

test('quality reads inspect cached data only and cannot fetch or write history', async () => {
  const f = fixture();
  const cached = { base: 'BTC', marketCapUsd: 123, fdvUsd: 150, observedAt: START - 60_000 };
  f.assets.set('BTC', cached);
  for (let i = 0; i < 10; i++) {
    const data = f.watch();
    assert.deepEqual(data.assets.BTC, cached);
    assert.equal(Object.keys(data.positioning).length, 0);
    assert.match(data.positioningErrors['binance:BTCUSDT'], /等待/);
  }
  await f.service.collectPositioning(); await f.service.collectFundamentals(); f.service.collectSample();
  assert.deepEqual(f.counts(), { snapshotReads: 10, refreshes: 0, fetches: 0, saves: 0 });
});

test('detail series are opt-in for at most one pair without extra collection or writes', async t => {
  const f = fixture({ quotes: [quote(), quote('bybit'), quote('okx')] });
  await f.start(t);
  const first = pair(f.quotes[0], f.quotes[1]), second = pair(f.quotes[0], f.quotes[2]);
  const before = f.counts();
  const result = f.service.read({ pairs: [{ ...first, includeSeries: true }, { ...second, includeSeries: true }] });
  assert.ok(Array.isArray(result.pairs[pairId(first)].priceSeries));
  assert.equal(result.pairs[pairId(second)].priceSeries, undefined);
  assert.equal(f.counts().saves, before.saves);
  assert.equal(f.counts().fetches, before.fetches);
  assert.equal(f.counts().refreshes, before.refreshes);
  assert.equal(f.service.read({ pairs: [first] }).pairs[pairId(first)].priceSeries, undefined);
});

test('load shedding defers auxiliary requests while price history continues and resumes', async t => {
  let overloaded = true;
  const f = fixture({ shouldDeferAuxiliary: () => overloaded });
  await f.start(t);
  f.watch();
  await f.service.collectFundamentals(); await f.service.collectPositioning();
  assert.equal(f.counts().refreshes, 0);
  assert.equal(f.counts().fetches, 0);
  const saved = f.counts().saves;
  f.advance(60_000); f.service.collectSample();
  assert.ok(f.counts().saves > saved);
  assert.ok(f.service.metrics().auxiliaryDeferredAt);
  overloaded = false;
  await f.service.collectFundamentals(); await f.service.collectPositioning();
  assert.equal(f.counts().refreshes, 1);
  assert.equal(f.counts().fetches, 1);
});

test('request validation limits input to 30 and ignores mismatched or same-venue pairs', () => {
  const f = fixture(), valid = pair(f.quotes[0], f.quotes[1]);
  assert.throws(() => f.service.read({ pairs: Array(31).fill(valid) }), /最多/);
  for (const input of [undefined, {}, { pairs: null }, { pairs: [null] }, { pairs: [{ ...valid, base: 'X'.repeat(161) }] }]) {
    assert.throws(() => f.service.read(input));
  }
  for (const row of [{ ...valid, base: 'ETH' }, { ...valid, longKey: 'unknown:BTCUSDT' }, { ...valid, shortKey: valid.longKey }]) {
    assert.equal(Object.keys(f.service.read({ pairs: [row] }).pairs).length, 0);
  }
  assert.equal(f.service.metrics().watchedPairs, 0);
  assert.equal(Object.keys(f.service.read({ pairs: Array(30).fill(valid) }).pairs).length, 1);
});

test('watched pairs stay bounded at 60 and inactive watches expire without a snapshot scan', async t => {
  const quotes = Array.from({ length: 70 }, (_, i) => [quote('binance', `C${i}`), quote('bybit', `C${i}`)]).flat();
  const f = fixture({ quotes }); await f.start(t);
  for (let i = 0; i < quotes.length; i += 2) { f.advance(1); f.watch([pair(quotes[i], quotes[i + 1])]); }
  assert.equal(f.service.metrics().watchedPairs, 60);
  f.advance(180_001);
  const before = f.counts().snapshotReads;
  await f.service.collectPositioning();
  assert.equal(f.service.metrics().watchedPairs, 0);
  assert.equal(f.counts().snapshotReads, before);
  assert.equal(f.counts().fetches, 0);
});

test('empty and unsupported-only watches do not scan every quote or request external ratios', async t => {
  const f = fixture({ quotes: [quote('lighter'), quote('hyperliquid')] }); await f.start(t);
  let before = f.counts().snapshotReads;
  await f.service.collectPositioning();
  assert.equal(f.counts().snapshotReads, before);
  const data = f.watch();
  assert.match(data.positioningErrors['lighter:BTCUSDT'], /未接入/);
  before = f.counts().snapshotReads;
  await f.service.collectPositioning();
  assert.equal(f.counts().snapshotReads, before);
  assert.equal(f.counts().fetches, 0);
});

test('a visible DEX pair queues all five same-asset CEX representatives while reads stay cache-only', async t => {
  const dex = [quote('lighter'), quote('hyperliquid')], cex = cexQuotes();
  const called = [];
  const f = fixture({ quotes: [...dex, ...cex], fetch: async (quote, { now }) => { called.push(key(quote)); return ratio(quote, now); } });
  const initial = f.watch();
  assert.equal(initial.positioningOverview.BTC.totalExchanges, 5);
  assert.equal(initial.positioningOverview.BTC.eligibleExchanges, 5);
  assert.equal(initial.positioningOverview.BTC.availableExchanges, 0);
  assert.equal(initial.positioningOverview.BTC.longRatio, null);
  assert.ok(initial.positioningOverview.BTC.constituents.every(item => item.status === 'pending'));
  assert.deepEqual(f.counts(), { snapshotReads: 1, refreshes: 0, fetches: 0, saves: 0 });
  await f.start(t);
  for (let index = 0; index < 5; index++) await f.service.collectPositioning();
  assert.deepEqual(new Set(called), new Set(cex.map(key)));
  const before = f.counts();
  const result = f.watch();
  assert.deepEqual({ ...f.counts(), snapshotReads: before.snapshotReads }, before);
  assert.equal(result.positioningOverview.BTC.availableExchanges, 5);
  assert.equal(result.positioningOverview.BTC.method, 'equal-exchange');
  assert.equal(result.positioningOverview.BTC.kind, 'accounts');
  assert.ok(Math.abs(result.positioningOverview.BTC.longRatio - 0.6) < 1e-12);
  assert.ok(Math.abs(result.positioningOverview.BTC.shortRatio - 0.4) < 1e-12);
  assert.ok(result.positioningOverview.BTC.constituents.every(item => item.status === 'fresh'));
  assert.deepEqual(Object.keys(result.positioning).sort(), cex.map(key).sort());
  assert.match(result.positioningErrors[key(dex[0])], /未接入/);
  await f.service.collectPositioning();
  assert.equal(called.length, 5, 'Reading the overview does not reset the five-minute query cache');
});

test('duplicate visible pairs and multiple USDT specifications share one representative request per exchange', async t => {
  const dex = [quote('lighter'), quote('hyperliquid')], cex = cexQuotes();
  const variants = cex.map(item => ({ ...item, symbol: item.exchange === 'gate' ? '1000BTC_USDT' : `1000${item.symbol}`, multiplier: 1000 }));
  const called = [];
  const f = fixture({ quotes: [...dex, ...variants, ...cex], fetch: async (quote, { now }) => { called.push(key(quote)); return ratio(quote, now); } });
  await f.start(t);
  const rows = [pair(dex[0], dex[1]), pair(dex[0], dex[1]), pair(dex[1], dex[0]), pair(cex[0], cex[1]), pair(cex[0], cex[2])];
  f.watch(rows);
  for (let index = 0; index < 12; index++) await f.service.collectPositioning();
  assert.equal(called.length, 5);
  assert.equal(new Set(called).size, 5);
  assert.deepEqual(called.map(value => value.split(':')[0]).sort(), ['binance', 'bitget', 'bybit', 'gate', 'okx']);
  const result = f.watch(rows);
  assert.deepEqual(Object.keys(result.pairs).sort(), [...new Set(rows.map(pairId))].sort());
  assert.equal(f.service.metrics().watchedPairs, 4, 'Distinct same-asset combinations are watched independently');
  assert.equal(Object.keys(result.positioningOverview).length, 1);
  assert.equal(result.positioningOverview.BTC.availableExchanges, 5);
});

test('unsupported USDC trade legs explain their limits while the overview collects those venues USDT contracts', async t => {
  const legs = [quote('bybit', 'BTC', { symbol: 'BTCPERP', quoteCurrency: 'USDC' }), quote('bitget', 'BTC', { symbol: 'BTCPERP', quoteCurrency: 'USDC' })];
  const cex = cexQuotes(), called = [];
  const f = fixture({ quotes: [...legs, ...cex], fetch: async (quote, { now }) => { called.push(key(quote)); return ratio(quote, now); } });
  await f.start(t); f.watch();
  for (let index = 0; index < 7; index++) await f.service.collectPositioning();
  assert.deepEqual(new Set(called), new Set(cex.map(key)));
  const result = f.watch();
  for (const leg of legs) {
    assert.equal(result.positioning[key(leg)], undefined);
    assert.match(result.positioningErrors[key(leg)], /USDT.*计价类别/);
    const item = result.positioningOverview.BTC.constituents.find(item => item.exchange === leg.exchange);
    assert.equal(item.key, `${leg.exchange}:BTCUSDT`);
    assert.equal(item.status, 'fresh');
  }
  assert.equal(result.positioningOverview.BTC.availableExchanges, 5);
});

test('only one positioning request can be in flight, and queued contracts rotate', async t => {
  let release;
  const calls = [];
  const f = fixture({ fetch: (quote, { now }) => { calls.push(key(quote)); return new Promise(resolve => { release = () => resolve(ratio(quote, now)); }); } });
  await f.start(t); f.watch();
  const first = f.service.collectPositioning();
  await f.service.collectPositioning(); await f.service.collectPositioning();
  assert.deepEqual(calls, ['binance:BTCUSDT']);
  release(); await first;
  const second = f.service.collectPositioning();
  assert.deepEqual(calls, ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  release(); await second;
  await f.service.collectPositioning();
  assert.equal(calls.length, 2);
});

test('successful, missing, and failed series all wait at least five minutes before retry', async t => {
  for (const result of ['success', 'missing', 'failure']) {
    const f = fixture({ quotes: [quote(), quote('lighter')], fetch: async quote => {
      if (result === 'failure') throw new Error('upstream unavailable');
      return result === 'missing' ? null : ratio(quote, START - 60_000);
    } });
    await f.start(t); f.watch(); await f.service.collectPositioning();
    f.advance(299_999); f.watch(); await f.service.collectPositioning();
    assert.equal(f.counts().fetches, 1, result);
    f.advance(1); f.watch(); await f.service.collectPositioning();
    assert.equal(f.counts().fetches, 2, result);
    await f.service.stop();
  }
});

test('failed and empty refreshes retain the published ratio and its original source time', async t => {
  let mode = 'success';
  const originalAt = START - 180_000;
  const f = fixture({ quotes: [quote(), quote('lighter')], fetch: async quote => {
    if (mode === 'failure') throw new Error('temporary outage');
    return mode === 'empty' ? null : ratio(quote, originalAt);
  } });
  await f.start(t); f.watch(); await f.service.collectPositioning();
  const original = f.watch().positioning['binance:BTCUSDT'];
  for (mode of ['failure', 'empty']) {
    f.advance(300_000); f.watch(); await f.service.collectPositioning();
    const data = f.watch();
    assert.deepEqual(data.positioning['binance:BTCUSDT'], original);
    assert.equal(data.positioning['binance:BTCUSDT'].observedAt, originalAt);
    assert.ok(data.generatedAt > originalAt + 300_000);
    assert.match(data.positioningErrors['binance:BTCUSDT'], mode === 'failure' ? /不可用/ : /未返回/);
    const constituent = data.positioningOverview.BTC.constituents.find(item => item.exchange === 'binance');
    assert.equal(constituent.status, 'fresh', 'A still-fresh cached observation retains its original source time');
    assert.match(constituent.reason, mode === 'failure' ? /不可用/ : /未返回/, 'The latest refresh failure must remain visible beside cached data');
  }
});

test('429 backs off the venue using Retry-After without blocking other exchanges', async t => {
  const quotes = [quote('binance', 'BTC'), quote('bybit', 'BTC'), quote('binance', 'ETH'), quote('bybit', 'ETH')];
  const called = [];
  const f = fixture({ quotes, fetch: async (quote, { now }) => {
    called.push(key(quote));
    if (quote.exchange === 'binance') { const error = new Error('rate limit'); error.status = 429; error.retryAfterMs = 600_000; throw error; }
    return ratio(quote, now);
  } });
  await f.start(t);
  const rows = [pair(quotes[0], quotes[1]), pair(quotes[2], quotes[3])]; f.watch(rows);
  for (let i = 0; i < 4; i++) await f.service.collectPositioning();
  assert.deepEqual(called, ['binance:BTCUSDT', 'bybit:BTCUSDT', 'bybit:ETHUSDT']);
  const limited = f.watch(rows);
  assert.equal(limited.positioning['binance:ETHUSDT'], undefined);
  assert.match(limited.positioningErrors['binance:ETHUSDT'], /限流/);
  const unrequested = limited.positioningOverview.ETH.constituents.find(item => item.exchange === 'binance');
  assert.equal(unrequested.status, 'rate-limited');
  assert.match(unrequested.reason, /限流/);
  f.advance(599_999); f.watch(rows);
  for (let i = 0; i < 3; i++) await f.service.collectPositioning();
  assert.equal(called.filter(value => value.startsWith('binance:')).length, 1);
  f.advance(1); f.watch(rows); await f.service.collectPositioning();
  assert.equal(called.at(-1), 'binance:ETHUSDT');
});

test('ratio cache cannot grow beyond 500 when users rotate more than 500 contracts', async t => {
  const quotes = Array.from({ length: 505 }, (_, i) => [quote('binance', `C${i}`), quote('lighter', `C${i}`)]).flat();
  const f = fixture({ quotes }); await f.start(t);
  for (let i = 0; i < quotes.length; i += 2) {
    f.advance(1_000); f.watch([pair(quotes[i], quotes[i + 1])]);
    await f.service.collectPositioning();
    assert.ok(f.service.metrics().positioningCache <= 500);
  }
  assert.equal(f.service.metrics().positioningCache, 500);
  assert.equal(f.service.metrics().watchedPairs, 60);
  assert.equal(f.watch([pair(quotes[0], quotes[1])]).positioning[key(quotes[0])], undefined);
  assert.ok(f.watch([pair(quotes.at(-2), quotes.at(-1))]).positioning[key(quotes.at(-2))]);
});

test('sixty visible bases retain all 300 CEX representatives plus 120 supported alternate-currency legs', async t => {
  const groups = Array.from({ length: 60 }, (_, index) => {
    const base = `C${index}`;
    const legs = [quote('binance', base, { symbol: `${base}USDC`, quoteCurrency: 'USDC' }), quote('okx', base, { symbol: `${base}-USDC-SWAP`, quoteCurrency: 'USDC' })];
    return { base, legs, cex: cexQuotes(base) };
  });
  const called = [];
  const f = fixture({ quotes: groups.flatMap(group => [...group.legs, ...group.cex]), fetch: async (quote, { now }) => { called.push(key(quote)); return ratio(quote, now); } });
  await f.start(t);
  const rows = groups.map(group => pair(...group.legs));
  f.watch(rows.slice(0, 30)); f.watch(rows.slice(30));
  assert.equal(f.service.metrics().watchedPairs, 60);
  for (let index = 0; index < 420; index++) await f.service.collectPositioning();
  assert.equal(called.length, 420);
  assert.equal(new Set(called).size, 420);
  assert.equal(f.service.metrics().positioningCache, 420);
  for (const batch of [rows.slice(0, 30), rows.slice(30)]) {
    const result = f.watch(batch);
    assert.equal(Object.keys(result.positioning).length, 210);
    assert.ok(Object.values(result.positioningOverview).every(item => item.availableExchanges === 5));
  }
  for (let index = 0; index < 10; index++) await f.service.collectPositioning();
  assert.equal(called.length, 420, 'All active observations fit in cache and remain cached after overview reads');
});

test('fundamental collection deduplicates comparable crypto bases and permits one refresh at a time', async t => {
  let release;
  const calls = [];
  const f = fixture({ quotes: [quote(), quote('bybit'), quote('gate', 'EQUITY:NVDA'), quote('okx', 'UNKNOWN', { comparable: false })],
    refresh: bases => { calls.push(bases); return new Promise(resolve => { release = resolve; }); },
  });
  await f.start(t);
  await f.service.collectFundamentals(); await f.service.collectFundamentals();
  assert.deepEqual(calls, [['BTC']]);
  release(); await nextTurn();
  const next = f.service.collectFundamentals();
  assert.equal(calls.length, 2);
  release(); await next;
});

test('fundamental failure retains cached data and waits for retry instead of busy looping', async t => {
  const f = fixture({ refresh: async () => { throw new Error('offline'); } });
  const original = { base: 'BTC', marketCapUsd: 123, fdvUsd: 150, observedAt: START - 3_600_000 };
  f.assets.set('BTC', original); await f.start(t);
  const retryAt = f.service.metrics().metadataRetryAt;
  assert.ok(retryAt > START);
  await f.service.collectFundamentals();
  assert.equal(f.counts().refreshes, 1);
  f.setNow(retryAt - 1); await f.service.collectFundamentals();
  assert.equal(f.counts().refreshes, 1);
  assert.deepEqual(f.watch().assets.BTC, original);
  f.setNow(retryAt); await f.service.collectFundamentals();
  assert.equal(f.counts().refreshes, 2);
  assert.deepEqual(f.watch().assets.BTC, original);
});

test('stop aborts both external collectors and prevents all later collection', async t => {
  const signals = [];
  const abortable = (_input, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const f = fixture({ refresh: abortable, fetch: abortable }); await f.start(t); f.watch();
  const request = f.service.collectPositioning();
  assert.equal(signals.length, 2);
  await f.service.stop(); await request;
  assert.ok(signals.every(signal => signal.aborted));
  const previous = f.counts();
  await f.service.collectPositioning(); await f.service.collectFundamentals(); f.service.collectSample();
  assert.deepEqual(f.counts(), previous);
});

test('sample storage failures preserve in-memory evidence and leave the source snapshot unchanged', async t => {
  let fail = true, saves = 0;
  const f = fixture({ store: { loadQualitySamples: () => [], saveQualitySample() { saves++; if (fail) throw new Error('disk full'); } } });
  const before = f.getSnapshot();
  await f.start(t);
  assert.match(f.service.metrics().error, /保存失败/);
  assert.deepEqual(f.getSnapshot(), before);
  let evidence = f.watch().pairs[pairId(pair(f.quotes[0], f.quotes[1]))];
  assert.equal(evidence.spread.samples, 1);
  f.service.collectSample(); assert.equal(saves, 1, 'same minute is never sampled twice');
  fail = false; f.advance(60_000); f.service.collectSample();
  assert.equal(f.service.metrics().error, null);
  evidence = f.watch().pairs[pairId(pair(f.quotes[0], f.quotes[1]))];
  assert.equal(evidence.spread.samples, 2);
});

test('history restoration preserves sample times and a corrupt store does not disable new samples', async t => {
  const records = [];
  const first = fixture({ store: { loadQualitySamples: () => [], saveQualitySample(bucket, rows) { records.push({ bucket, rows }); } } });
  await first.start(t); first.advance(60_000); first.service.collectSample(); await first.service.stop();
  const restored = fixture({ store: { loadQualitySamples: () => records, saveQualitySample() {} } });
  restored.setNow(START + 120_000); await restored.start(t);
  const evidence = restored.watch().pairs[pairId(pair(restored.quotes[0], restored.quotes[1]))];
  assert.equal(evidence.spread.samples, 3);
  assert.equal(evidence.spread.firstAt, Math.floor(START / 60_000) * 60_000);
  const corrupt = fixture({ store: { loadQualitySamples() { throw new Error('corrupt history'); }, saveQualitySample() {} } });
  await corrupt.start(t);
  assert.equal(corrupt.service.metrics().restoring, false);
  assert.equal(corrupt.watch().pairs[pairId(pair(corrupt.quotes[0], corrupt.quotes[1]))].spread.samples, 1);
});

test('quality history persists independently of latest quotes and prunes beyond one day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-quality-test-'));
  let store;
  try {
    store = await openPerpetualStore(join(directory, 'perpetual.sqlite'));
    const bucket = Math.floor(START / 60_000) * 60_000;
    const quoteRow = { ...quote(), bidAskAt: START, receivedAt: START };
    store.save([quoteRow]);
    store.saveQualitySample(bucket - 86_400_000, [['expired']]);
    store.saveQualitySample(bucket - 60_000, [['prior']]);
    store.saveQualitySample(bucket, [['current']]);
    store.saveQualitySample(bucket, [['should not overwrite']]);
    assert.deepEqual([...store.loadQualitySamples(bucket)], [
      { bucket: bucket - 60_000, rows: [['prior']] }, { bucket, rows: [['current']] },
    ]);
    assert.deepEqual(store.load(), [quoteRow]);
    store.close(); store = await openPerpetualStore(join(directory, 'perpetual.sqlite'));
    assert.equal([...store.loadQualitySamples(bucket)].length, 2);
    assert.deepEqual(store.load(), [quoteRow]);
  } finally {
    store?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes('perpetual-quality-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality POST retains shared HTTP authentication, origin, JSON, and request-size guards', async t => {
  let fetches = 0, writes = 0;
  const backend = createPerpetualService({ exchanges: [], store: { load: () => [], saveQualitySample() { writes++; }, close() {} },
    qualityOptions: { fundamentals: { get: () => null, describe: () => ({ status: 'pending' }), refresh: async () => { fetches++; } }, positioningFetch: async () => { fetches++; } },
  });
  const server = createServer(createHandler({ services: new Map([['perpetual', backend]]), username: 'test', password: 'test-password',
    nextHandler(_request, response) { response.writeHead(404); response.end(); },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await backend.stop(); });
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/monitors/perpetual/quality`;
  const headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}`, 'Content-Type': 'application/json' };
  const request = { method: 'POST', headers, body: '{"pairs":[]}' };
  assert.equal((await fetch(url, { ...request, headers: {} })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { ...request, headers: { ...headers, Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await fetch(url, { ...request, headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(url, { ...request, headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(url, { ...request, body: JSON.stringify({ pairs: [], padding: 'x'.repeat(65_536) }) })).status, 400);
  const response = await fetch(url, { ...request, headers: { ...headers, Origin: origin } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).positioning, {});
  assert.equal(fetches, 0); assert.equal(writes, 0);
});

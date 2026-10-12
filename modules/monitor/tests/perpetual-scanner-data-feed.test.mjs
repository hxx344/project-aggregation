import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createPerpetualScannerDataCache, isPerpetualScannerDataReport, startPerpetualScannerDataFeed } from '../lib/perpetual-scanner-data-feed.ts';
import { scannerDataPairKey, scannerDataHistoryForPair } from '../lib/perpetual-scanner-data.ts';
import { createPerpetualScannerDataService } from '../server/perpetual-scanner-data.mjs';
import { createPerpetualFundingHistoryService } from '../server/perpetual-funding-history.mjs';
import { createPerpetualMarketMetricsService } from '../server/perpetual-market-metrics.mjs';

const NOW = Date.UTC(2026, 9, 8), HOUR = 3600000;
const pair = index => ({ base: `C${index}`, longKey: `a:C${index}`, shortKey: `b:C${index}`, identity: `C${index}:v1` });
const all = { metrics: true, historyHours: [24, 168, 720] };
const amount = (value, at = NOW) => ({ value, currency: value === null ? null : 'USDT', observedAt: value === null ? null : at, source: 'fixture', error: '' });
const total = (hours, status = 'ready', count = hours) => ({ hours, asOf: status === 'pending' ? null : NOW, longPercent: status === 'ready' ? 1 : null, shortPercent: status === 'ready' ? 2 : null, netPercent: status === 'ready' ? 1 : null, longCount: count, shortCount: count, status, reason: status === 'pending' ? '正在回补' : '' });
function response(request, status = 'ready', count) {
  return { schemaVersion: 1, generatedAt: NOW,
    metrics: request.metrics ? Object.fromEntries(request.pairs.flatMap(pair => [pair.longKey, pair.shortKey]).map(key => {
      const [exchange, symbol] = key.split(':');
      return [key, { key, exchange, symbol, identity: `${key}:v1`, status, fetchedAt: status === 'ready' ? NOW : null,
        volume24h: amount(status === 'ready' ? 0 : null), openInterest: amount(status === 'ready' ? 100 : null), error: '' }];
    })) : {},
    history: Object.fromEntries(request.pairs.map(pair => [scannerDataPairKey(pair), Object.fromEntries(request.historyHours.map(hours => [hours, total(hours, status, count)]))])),
  };
}
function runtime() {
  let now = NOW, sequence = 0;
  const timers = new Map();
  const environment = { now: () => now, schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; }, cancel: timer => timers.delete(timer) };
  async function advance(ms) {
    const end = now + ms; let turns = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      assert.ok(++turns < 20000, 'timer queue failed to make progress');
      now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
    }
    now = end; await settle();
  }
  return { ...environment, timers, advance };
}
function fixture(load = async request => response(request), options = {}) {
  const time = options.time ?? runtime(), requests = [], reports = [], errors = [], loading = [];
  const feed = startPerpetualScannerDataFeed({ ...time, ...options,
    load: (request, signal) => { requests.push({ request: structuredClone(request), signal }); return load(request, signal); },
    onData: report => reports.push(report), onError: error => errors.push(error), onLoading: value => loading.push(value),
  });
  return { feed, time, requests, reports, errors, loading };
}

test('scanner report validation rejects malformed windows and supports actual zero metric values', () => {
  const report = response({ pairs: [pair(0)], ...all });
  assert.equal(isPerpetualScannerDataReport(report), true);
  report.history[scannerDataPairKey(pair(0))][24].netPercent = NaN;
  assert.equal(isPerpetualScannerDataReport(report), false);
});

test('all candidates beyond thirty pairs and five hundred contracts remain available, including the only last-row match', async () => {
  const pairs = Array.from({ length: 320 }, (_, index) => pair(index));
  const f = fixture(async request => {
    const report = response(request);
    for (const pair of request.pairs) report.history[scannerDataPairKey(pair)][720].netPercent = pair.base === 'C319' ? 99 : 1;
    return report;
  });
  f.feed.setSelection(pairs, { metrics: true, historyHours: [720] }); f.feed.setActive(true); await settle();
  const result = f.reports.at(-1);
  assert.equal(f.requests.length, 11); assert.ok(f.requests.every(item => item.request.pairs.length <= 30));
  assert.equal(Object.keys(result.metrics).length, 640); assert.equal(Object.keys(result.history).length, 320);
  assert.equal(result.progress.completed, 320); assert.equal(result.progress.pending, 0);
  assert.deepEqual(pairs.filter(pair => scannerDataHistoryForPair(result, pair, 720)?.netPercent > 90), [pairs[319]]);
  f.feed.stop(); assert.equal(f.time.timers.size, 0);
});

test('completed positions refill immediately while a pending item keeps its place and remaining requirements', async () => {
  let ready = false;
  const f = fixture(async request => {
    const report = response(request);
    if (!ready && request.pairs.some(pair => pair.base === 'C0')) report.history[scannerDataPairKey(pair(0))][720] = total(720, 'pending', 20);
    return report;
  });
  const pairs = Array.from({ length: 31 }, (_, index) => pair(index));
  f.feed.setSelection(pairs, { metrics: true, historyHours: [720] }); f.feed.setActive(true); await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].request.pairs.length, 2); assert.equal(f.requests[1].request.metrics, true);
  assert.equal(f.reports.at(-1).progress.completed, 30);
  await f.time.advance(6000);
  assert.equal(f.requests.length, 4); assert.equal(f.requests[2].request.pairs.length, 1); assert.equal(f.requests[2].request.metrics, false);
  assert.deepEqual(f.requests[2].request.historyHours, [720]);
  assert.equal(new Set(f.requests.flatMap(({ request }) => request.pairs.map(pair => pair.base))).size, 31);
  ready = true; await f.time.advance(3000);
  assert.equal(f.reports.at(-1).progress.completed, 31); assert.equal(f.requests.length, 5);
  f.feed.stop();
});

test('one slow 30-day history cannot hide a later candidate matching at least 0.5 percent', async () => {
  let active = 0, maxActive = 0;
  const pairs = Array.from({ length: 91 }, (_, index) => pair(index));
  const f = fixture(async request => {
    maxActive = Math.max(maxActive, ++active); await Promise.resolve();
    const report = response(request);
    for (const candidate of request.pairs) report.history[scannerDataPairKey(candidate)][720] = candidate.base === 'C0'
      ? total(720, 'pending', 20) : { ...total(720), netPercent: candidate.base === 'C90' ? 0.75 : 0.1 };
    active--; return report;
  });
  f.feed.setSelection(pairs, { metrics: false, historyHours: [720] }); f.feed.setActive(true); await settle();
  const report = f.reports.at(-1);
  assert.deepEqual(pairs.filter(candidate => {
    const value = scannerDataHistoryForPair(report, candidate, 720);
    return value?.status === 'ready' && value.netPercent >= 0.5;
  }), [pair(90)]);
  assert.equal(report.progress.completed, 90); assert.equal(report.progress.pending, 1);
  assert.equal(maxActive, 1); assert.ok(f.requests.every(({ request }) => request.pairs.length <= 30));
  assert.ok(f.requests.every(({ request }) => request.pairs.some(candidate => candidate.base === 'C0')));
  f.feed.stop();
});

test('membership changes and refilled metrics do not restart an existing history no-progress deadline', async () => {
  const f = fixture(async request => {
    const report = response(request);
    if (request.pairs.some(candidate => candidate.base === 'C0')) report.history[scannerDataPairKey(pair(0))][720] = total(720, 'pending', 20);
    return report;
  }, { noProgressMs: 90_000 });
  const requirements = { metrics: true, historyHours: [720] };
  f.feed.setSelection([pair(0), pair(1)], requirements); f.feed.setActive(true); await settle();
  for (let index = 2; index <= 3; index++) {
    await f.time.advance(30_000);
    f.feed.setSelection([pair(index), pair(0)], requirements); await settle();
    assert.equal(f.requests.at(-1).request.metrics, true);
    assert.equal(f.reports.at(-1).progress.deferred, 0);
  }
  await f.time.advance(30_000);
  assert.equal(f.reports.at(-1).progress.deferred, 1);
  assert.equal(f.reports.at(-1).history[scannerDataPairKey(pair(0))][720].status, 'pending');
  f.feed.stop();
});

test('pending history polls do not renew completed metrics and thirty-second observations survive a history no-progress delay', async () => {
  const time = runtime(), seen = [];
  const f = fixture(async request => {
    seen.push({ at: time.now(), request });
    const report = response(request);
    for (const leg of Object.values(report.metrics)) { leg.fetchedAt = time.now(); leg.volume24h.observedAt = time.now(); leg.openInterest.observedAt = time.now(); }
    if (request.historyHours.includes(720)) report.history[scannerDataPairKey(pair(0))][720] = total(720, 'pending', 20);
    return report;
  }, { time, noProgressMs: 90_000 });
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [720] }); f.feed.setActive(true); await settle();
  await time.advance(90_000);
  assert.deepEqual(seen.filter(row => row.request.metrics).map(row => row.at - NOW), [0, 30_000, 60_000, 90_000]);
  assert.equal(f.reports.at(-1).progress.deferred, 1);
  await time.advance(30_000);
  assert.equal(f.reports.at(-1).metrics[pair(0).longKey].volume24h.observedAt, NOW + 120_000);
  assert.equal(seen.at(-1).request.metrics, true); assert.deepEqual(seen.at(-1).request.historyHours, []);
  assert.equal(f.reports.at(-1).progress.deferred, 1); f.feed.stop();
});

test('completed funding windows retain a five-minute cadence while another window is backfilling and metrics refresh every thirty seconds', async () => {
  const f = fixture(async request => {
    const report = response(request);
    if (request.historyHours.includes(720)) report.history[scannerDataPairKey(pair(0))][720] = total(720, 'pending', 20);
    return report;
  });
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24, 720] }); f.feed.setActive(true); await settle();
  await f.time.advance(299_999);
  assert.equal(f.requests.filter(({ request }) => request.historyHours.includes(24)).length, 1);
  assert.equal(f.requests.filter(({ request }) => request.metrics).length, 10);
  await f.time.advance(1);
  assert.equal(f.requests.filter(({ request }) => request.historyHours.includes(24)).length, 2);
  assert.equal(f.requests.filter(({ request }) => request.metrics).length, 11); f.feed.stop();
});

test('upstream error or busy pending entries yield to later batches instead of blocking the queue', async () => {
  const f = fixture(async request => {
    const report = response(request);
    if (request.pairs.some(pair => pair.base === 'C0')) {
      for (const leg of Object.values(report.metrics)) { leg.status = 'pending'; leg.error = '指标缓存队列繁忙'; }
      for (const windows of Object.values(report.history)) windows[720] = { ...total(720, 'error'), reason: '历史读取失败' };
    }
    return report;
  });
  f.feed.setSelection(Array.from({ length: 31 }, (_, index) => pair(index)), { metrics: true, historyHours: [720] }); f.feed.setActive(true); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.reports.at(-1).progress.completed, 31);
  f.feed.stop();
});

test('a stalled batch yields after the explicit no-progress budget and keeps its missing state visible', async () => {
  const f = fixture(async request => response(request, request.pairs.some(pair => pair.base === 'C0') ? 'pending' : 'ready'));
  f.feed.setSelection(Array.from({ length: 31 }, (_, index) => pair(index)), { metrics: false, historyHours: [720] }); f.feed.setActive(true); await settle();
  await f.time.advance(19 * 60_000); assert.equal(new Set(f.requests.flatMap(({ request }) => request.pairs.map(pair => pair.base))).size, 30);
  await f.time.advance(60_000);
  const report = f.reports.at(-1);
  assert.equal(report.progress.completed, 1); assert.equal(report.progress.pending, 30); assert.equal(report.progress.deferred, 30);
  assert.equal(report.history[scannerDataPairKey(pair(0))][720].status, 'pending'); assert.match(f.errors.at(-1), /缺失/);
  f.feed.stop();
});

test('steady backfill progress has no arbitrary total deadline', async () => {
  const time = runtime();
  const f = fixture(async request => response(request, 'pending', Math.floor((time.now() - NOW) / 600_000)), { time });
  f.feed.setSelection(Array.from({ length: 31 }, (_, index) => pair(index)), { metrics: false, historyHours: [720] }); f.feed.setActive(true); await settle();
  await time.advance(31 * 60_000);
  assert.equal(new Set(f.requests.flatMap(({ request }) => request.pairs.map(pair => pair.base))).size, 30);
  assert.equal(f.reports.at(-1).progress.deferred, 0); f.feed.stop();
});

test('a newer tail cutoff without additional history cannot indefinitely block the remaining candidates', async () => {
  const time = runtime();
  const f = fixture(async request => {
    const report = response(request);
    for (const candidate of request.pairs) if (candidate.base !== 'C9') report.history[scannerDataPairKey(candidate)][720] = {
      ...total(720, 'pending', 96), asOf: NOW + Math.floor((time.now() - NOW) / 300_000) * 300_000,
    };
    return report;
  }, { time });
  // Canonical ordering puts C9 after the first thirty candidates.
  f.feed.setSelection(Array.from({ length: 31 }, (_, index) => pair(index)), { metrics: false, historyHours: [720] });
  f.feed.setActive(true); await settle();
  await time.advance(19 * 60_000);
  assert.equal(new Set(f.requests.flatMap(({ request }) => request.pairs.map(candidate => candidate.base))).size, 30);
  await time.advance(46 * 60_000);
  assert.equal(new Set(f.requests.flatMap(({ request }) => request.pairs.map(candidate => candidate.base))).size, 31);
  assert.equal(f.reports.at(-1).progress.completed, 1);
  assert.equal(f.reports.at(-1).history[scannerDataPairKey(pair(0))][720].status, 'pending');
  assert.ok(f.reports.some(report => report.progress.deferred > 0)); f.feed.stop();
});

test('sorting, reversing direction and fresh hide/show or remount do not restart completed work', async () => {
  const cache = createPerpetualScannerDataCache(), time = runtime(), pairs = [pair(2), pair(1)];
  const f = fixture(undefined, { cache, time }); f.feed.setSelection(pairs, all); f.feed.setActive(true); await settle();
  f.feed.setSelection(pairs.toReversed().map(pair => ({ ...pair, longKey: pair.shortKey, shortKey: pair.longKey })), all); await settle();
  f.feed.setActive(false); await time.advance(10000); f.feed.setActive(true); await settle(); assert.equal(f.requests.length, 1);
  f.feed.stop();
  const next = fixture(undefined, { cache, time }); next.feed.setSelection(pairs, all); next.feed.setActive(true); await settle();
  assert.equal(next.requests.length, 0); assert.equal(next.reports.at(-1).progress.completed, 2);
  await time.advance(19999); assert.equal(next.requests.length, 0);
  await time.advance(1); assert.equal(next.requests.length, 1); assert.equal(next.requests[0].request.metrics, true); assert.deepEqual(next.requests[0].request.historyHours, []);
  await time.advance(270000); assert.equal(next.requests.length, 10);
  assert.ok(next.requests.slice(0, 9).every(({ request }) => request.historyHours.length === 0));
  assert.deepEqual(next.requests.at(-1).request.historyHours, all.historyHours); next.feed.stop();
});

test('adding a window reads only the new requirement, removing a pending window releases the batch, and identity changes invalidate amounts', async () => {
  const f = fixture(async request => {
    const report = response(request);
    if (request.historyHours.includes(720)) report.history[scannerDataPairKey(pair(0))][720] = total(720, 'pending');
    return report;
  });
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24] }); f.feed.setActive(true); await settle();
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24, 720] }); await settle();
  assert.equal(f.requests[1].request.metrics, false); assert.deepEqual(f.requests[1].request.historyHours, [720]);
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24] }); await f.time.advance(5000); assert.equal(f.requests.length, 2);
  f.feed.setSelection([{ ...pair(0), identity: 'relisted' }], { metrics: true, historyHours: [24] }); await settle(); assert.equal(f.requests.length, 3);
  f.feed.stop();
});

test('multiple hooks share a single in-flight request and only the last subscriber aborts it', async () => {
  const cache = createPerpetualScannerDataCache(), time = runtime(); let release;
  const first = fixture(request => new Promise(resolve => { release = () => resolve(response(request)); }), { cache, time });
  const second = fixture(undefined, { cache, time });
  for (const f of [first, second]) { f.feed.setSelection([pair(0)], all); f.feed.setActive(true); }
  await settle(); assert.equal(first.requests.length, 1); assert.equal(second.requests.length, 0);
  first.feed.stop(); assert.equal(first.requests[0].signal.aborted, false); release(); await settle();
  assert.equal(second.reports.at(-1).progress.completed, 1);
  await time.advance(30000); assert.equal(second.requests.length, 1); second.feed.stop();
  const stalled = fixture(() => new Promise(() => {}), { cache: createPerpetualScannerDataCache() });
  stalled.feed.setSelection([pair(1)], all); stalled.feed.setActive(true); await settle(); stalled.feed.stop();
  assert.equal(stalled.requests[0].signal.aborted, true); assert.equal(stalled.time.timers.size, 0);
});

test('failed reads preserve prior values, let unvisited candidates proceed and retry later', async () => {
  const f = fixture(async request => { if (request.pairs.some(pair => pair.base === 'C0')) throw Error('HTTP unavailable'); return response(request); });
  f.feed.setSelection(Array.from({ length: 31 }, (_, index) => pair(index)), all); f.feed.setActive(true); await settle();
  assert.equal(f.requests.length, 2); assert.equal(f.reports.at(-1).progress.completed, 31);
  await f.time.advance(59999); assert.equal(f.requests.filter(({ request }) => request.pairs.some(pair => pair.base === 'C0')).length, 1);
  await f.time.advance(1); assert.equal(f.requests.filter(({ request }) => request.pairs.some(pair => pair.base === 'C0')).length, 2); f.feed.stop();
});

test('missing response legs and windows become terminal errors with visible reasons', async () => {
  const f = fixture(async request => { const report = response(request); delete report.metrics[pair(0).longKey]; delete report.history[scannerDataPairKey(pair(0))][24]; return report; });
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24] }); f.feed.setActive(true); await settle();
  const report = f.reports.at(-1), leg = report.metrics[pair(0).longKey], window = report.history[scannerDataPairKey(pair(0))][24];
  assert.equal(leg.status, 'error'); assert.equal(leg.volume24h.value, null); assert.match(leg.error, /未返回/);
  assert.equal(window.status, 'error'); assert.equal(window.netPercent, null); assert.equal(report.progress.completed, 1); f.feed.stop();
});

test('failed refresh keeps numeric evidence and original timestamps but marks it ineligible as an error', async () => {
  let fail = false;
  const f = fixture(async request => { if (fail) throw Error('network'); return response(request); });
  f.feed.setSelection([pair(0)], { metrics: true, historyHours: [24] }); f.feed.setActive(true); await settle();
  fail = true; await f.time.advance(300000);
  const report = f.reports.at(-1), leg = report.metrics[pair(0).longKey], window = report.history[scannerDataPairKey(pair(0))][24];
  assert.equal(leg.openInterest.value, 100); assert.equal(leg.openInterest.observedAt, NOW); assert.equal(leg.status, 'error'); assert.match(leg.openInterest.error, /失败/);
  assert.equal(window.netPercent, 1); assert.equal(window.asOf, NOW); assert.equal(window.status, 'error'); f.feed.stop();
});

test('refilling with real bounded collectors preserves unfinished legs and persists completed contracts', async t => {
  const time = runtime(), pairs = Array.from({ length: 61 }, (_, index) => pair(index));
  const markets = pairs.flatMap(pair => [pair.longKey, pair.shortKey].map(key => {
    const [exchange, symbol] = key.split(':'); return { exchange, symbol, base: pair.base, quoteCurrency: 'USDT', comparable: true };
  }));
  const catalog = new Map(markets.map(market => [`${market.exchange}:${market.symbol}`, market]));
  const historyDisk = new Map(), metricsDisk = new Map();
  const store = {
    loadFundingHistory: key => key === undefined ? [] : historyDisk.has(key) ? [structuredClone(historyDisk.get(key))] : [],
    saveFundingHistory: entry => historyDisk.set(entry.key, structuredClone(entry)),
    loadContractMetrics: key => key === undefined ? [] : metricsDisk.has(key) ? [structuredClone(metricsDisk.get(key))] : [],
    saveContractMetrics: entry => metricsDisk.set(entry.key, structuredClone(entry)),
  };
  const getSnapshot = () => ({ quotes: markets }), getMarket = (exchange, symbol) => catalog.get(`${exchange}:${symbol}`);
  const fundingHistory = createPerpetualFundingHistoryService({ clock: time.now, getSnapshot, getMarket, store, cacheLimit: 60, hostSpacingMs: 0,
    reader: async (_market, range) => { const rows = []; for (let at = Math.ceil(range.from / HOUR) * HOUR; at <= range.to; at += HOUR) rows.push({ time: at, rate: 0.0001 }); return rows; } });
  const marketMetrics = createPerpetualMarketMetricsService({ clock: time.now, getSnapshot, getMarket, store, cacheLimit: 60, hostSpacingMs: 0, intervalMs: 1000000,
    reader: async () => ({ volume24h: amount(5, time.now()), openInterest: amount(10, time.now()) }) });
  const service = createPerpetualScannerDataService({ clock: time.now, getSnapshot, getMarket, fundingHistory, marketMetrics });
  fundingHistory.start(); marketMetrics.start(); t.after(async () => { await fundingHistory.stop(); await marketMetrics.stop(); });
  const visited = new Set();
  const f = fixture(async request => {
    const newlySeen = request.pairs.filter(pair => !visited.has(scannerDataPairKey(pair)));
    if (newlySeen.length && visited.size) {
      const previous = f.reports.at(-1), protectedPairs = new Set(request.pairs.map(scannerDataPairKey));
      for (const key of visited) if (previous.history[key]?.[720]?.status === 'pending') {
        assert.ok(protectedPairs.has(key), 'new registration must retain unfinished backfill in the protected request');
      }
    }
    assert.ok(request.pairs.length <= 30);
    for (const pair of request.pairs) visited.add(scannerDataPairKey(pair));
    return service.read(request);
  }, { time });
  t.after(() => f.feed.stop()); f.feed.setSelection(pairs, { metrics: true, historyHours: [720] }); f.feed.setActive(true); await settle();
  for (let second = 0; second < 1400 && f.reports.at(-1).progress.completed < pairs.length; second++) {
    await Promise.all([fundingHistory.collect(), marketMetrics.collect()]); await time.advance(1000);
  }
  const report = f.reports.at(-1);
  assert.equal(report.progress.completed, 61); assert.equal(report.progress.deferred, 0);
  assert.equal(Object.keys(report.metrics).length, 122); assert.equal(Object.keys(report.history).length, 61);
  assert.ok([...historyDisk.values()].length > 60); assert.ok(fundingHistory.metrics().cached <= 60); assert.ok(marketMetrics.metrics().cached <= 60);
  assert.ok(pairs.every(pair => report.history[scannerDataPairKey(pair)][720].netPercent === 0));
});

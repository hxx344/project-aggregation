import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createPerpetualPriceHistoryService } from '../server/perpetual-price-history.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';
import { createHandler } from '../server/http.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';
import { validatePerpetualPriceHistory, priceHistoryIsStale, perpetualPriceIdentity } from '../lib/perpetual-price-history.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 11, 12), quote = exchange => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1 });
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'aster:BTCUSDT' };
const points = (range, close = 100) => Array.from({ length: (range.to - range.from) / HOUR }, (_, i) => ({ time: range.from + (i + 1) * HOUR, close }));
function setup(t, options = {}) {
  let now = NOW, calls = [];
  const quotes = [quote('binance'), quote('aster')], markets = new Map(quotes.map(row => [`${row.exchange}:${row.symbol}`, row]));
  const service = createPerpetualPriceHistoryService({ getSnapshot: () => ({ quotes }), getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => now, hostSpacingMs: 0, reader: async (market, range, control) => { calls.push({ market, range }); return options.reader ? options.reader(market, range, control) : points(range); }, ...options.service });
  service.start(); t.after(() => service.stop());
  return { service, quotes, markets, calls, advance: ms => { now += ms; }, read: (days = 7) => service.read({ pair, days }) };
}
async function finish(f) { for (let i = 0; i < 6; i++) { await f.service.collect(); await turn(); } }

test('selected pair caches full 30d; window/direction changes reuse it and refresh only new closed hours', async t => {
  const f = setup(t);
  assert.equal(f.read().legs[pair.longKey].status, 'pending'); assert.equal(f.calls.length, 0);
  await finish(f);
  const report = f.read(30), leg = report.legs[pair.longKey];
  assert.equal(leg.points.length, 720); assert.equal(leg.backfillComplete, true); assert.equal(leg.status, 'ready'); assert.ok(validatePerpetualPriceHistory(report, NOW));
  const count = f.calls.length;
  for (const days of [3, 7, 30]) { f.read(days); await f.service.collect(); }
  f.service.read({ pair: { ...pair, longKey: pair.shortKey, shortKey: pair.longKey }, days: 3 }); await f.service.collect();
  assert.equal(f.calls.length, count);
  f.advance(HOUR + 1000); f.read(); await f.service.collect();
  assert.equal(f.calls.length, count + 2); assert.equal(f.calls.at(-1).range.to - f.calls.at(-1).range.from, 2 * HOUR);
  assert.equal(f.read().legs[pair.longKey].points.length, 720);
});
test('gaps remain gaps; conflicting duplicates within one response retain old values and stale state', async t => {
  let fail = false;
  const f = setup(t, { reader: async (_market, range) => fail ? [...points(range, 101), { time: range.to, close: 102 }] : points(range).filter(row => row.time !== NOW - HOUR) });
  f.read(); await finish(f); const prior = f.read().legs[pair.longKey];
  assert.equal(prior.points.length, 719); fail = true; f.advance(HOUR + 1000); f.read(); await f.service.collect();
  const report = f.read(); assert.equal(report.legs[pair.longKey].status, 'error'); assert.deepEqual(report.legs[pair.longKey].points, prior.points); assert.equal(priceHistoryIsStale(report, NOW + HOUR), true);
});
test('a later official revision replaces the overlapping cached close and keeps adding new hours', async t => {
  let revised = false;
  const f = setup(t, { reader: async (_market, range) => points(range, revised ? 101 : 100) });
  f.read(); await finish(f); revised = true; f.advance(HOUR + 1000); f.read(); await f.service.collect();
  const updated = f.read().legs[pair.longKey];
  assert.equal(updated.status, 'ready'); assert.equal(updated.error, ''); assert.equal(updated.points.length, 720);
  assert.equal(updated.points.find(point => point.time === NOW - HOUR).close, 100, 'outside the refreshed range remains unchanged');
  assert.equal(updated.points.find(point => point.time === NOW).close, 101, 'the overlapping official close may be revised');
  assert.deepEqual(updated.points.at(-1), { time: NOW + HOUR, close: 101 });
  f.advance(HOUR); f.read(); await f.service.collect();
  const latest = f.read().legs[pair.longKey];
  assert.equal(latest.status, 'ready'); assert.equal(latest.to, NOW + 2 * HOUR); assert.deepEqual(latest.points.at(-1), { time: NOW + 2 * HOUR, close: 101 });
});
test('current directory validation rejects unknown/obsolete/mismatched pair atomically', async t => {
  const f = setup(t);
  for (const input of [{ pair: { ...pair, longKey: 'evil:https://localhost' }, days: 7 }, { pair, days: 2 }, { pair: { ...pair, base: 'ETH' }, days: 7 }, { pairs: [pair], days: 7 }]) assert.throws(() => f.service.read(input), { status: 400 });
  f.markets.delete(pair.shortKey); assert.throws(() => f.read(), { status: 400 });
  assert.equal(f.service.metrics().cached, 0); assert.equal(f.calls.length, 0);
});
test('directory identity changes during in-flight load cannot write old data', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = setup(t, { reader: async () => pending });
  f.read(); const collecting = f.service.collect(); await turn();
  f.quotes[0] = { ...f.quotes[0], multiplier: 1000 }; f.markets.set(pair.longKey, f.quotes[0]);
  f.read(); resolve([{ time: NOW, close: 999 }]); await collecting; await turn();
  const leg = f.read().legs[pair.longKey];
  assert.equal(leg.identity, perpetualPriceIdentity(f.quotes[0])); assert.equal(leg.points.some(point => point.close === 999), false);
});
test('stop aborts a noncooperative reader and prevents late writes', async t => {
  let resolve;
  const f = setup(t, { reader: () => new Promise(done => { resolve = done; }), service: { maxConcurrent: 1 } });
  f.read(); const collecting = f.service.collect(); await turn();
  await f.service.stop(); await collecting; resolve([{ time: NOW, close: 999 }]); await turn();
  assert.equal(f.read().legs[pair.longKey].points.length, 0); assert.equal(f.service.metrics().inFlight, 0);
});
test('two concurrent readers maximum and identical selections deduplicate jobs', async t => {
  const pending = [];
  const f = setup(t, { reader: (_market, range) => new Promise(resolve => pending.push(() => resolve(points(range)))), service: { maxConcurrent: 9 } });
  f.read(); const one = f.service.collect(); f.read(); const two = f.service.collect(); await turn();
  assert.equal(pending.length, 2); assert.equal(f.service.metrics().inFlight, 2);
  pending.forEach(resolve => resolve()); await Promise.all([one, two]);
});
test('durable cache survives restart and rejects changed identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-price-')), store = await openPerpetualStore(join(dir, 'test.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const f = setup(t, { service: { store } }); f.read(); await finish(f); await f.service.stop();
  const f2 = setup(t, { service: { store } });
  assert.equal(f2.read().legs[pair.longKey].points.length, 720); await f2.service.collect(); assert.equal(f2.calls.length, 0);
  f2.quotes[0] = { ...f2.quotes[0], multiplier: 1000 }; f2.markets.set(pair.longKey, f2.quotes[0]);
  assert.equal(f2.read().legs[pair.longKey].points.length, 0);
});
test('unsupported leg is explicit and does not retry each poll', async t => {
  const f = setup(t, { reader: async () => { throw Object.assign(Error('未接入'), { code: 'UNSUPPORTED' }); } });
  f.read(); await f.service.collect(); assert.equal(f.read().legs[pair.longKey].status, 'unsupported');
  const count = f.calls.length; f.read(); await f.service.collect(); assert.equal(f.calls.length, count);
});
test('dormant selections stop upstream refresh until read again', async t => {
  const f = setup(t, { service: { activeLeaseMs: 5000 } }); f.read(); await finish(f);
  const count = f.calls.length; f.advance(2 * HOUR); await f.service.collect(); assert.equal(f.calls.length, count);
  f.read(); await f.service.collect(); assert.equal(f.calls.length, count + 2);
});
test('price action uses existing HTTP authentication and rejects unknown key with 400', async t => {
  const rows = [quote('binance'), quote('aster')];
  const service = createPerpetualService({ exchanges: rows.map(row => ({ id: row.exchange, name: row.exchange })), clock: () => NOW,
    discover: async exchange => rows.filter(row => row.exchange === exchange), subscriptions: () => [{ url: 'wss://unused.example', startDelayMs: 60_000 }], fxIntervalMs: 0,
    store: { load: () => rows, save() {}, prune() {}, close() {} }, priceHistoryOptions: { reader: async (_market, range) => points(range), hostSpacingMs: 0 } });
  service.start(); await turn();
  const server = createServer(createHandler({ services: new Map([['perpetual', service]]), username: 'test', password: 'test-password', nextHandler: (_request, response) => { response.writeHead(404); response.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/price-history`, headers = { Authorization: `Basic ${Buffer.from('test:test-password').toString('base64')}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ pair, days: 7 }) })).status, 401);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ pair: { ...pair, longKey: 'binance:UNKNOWN' }, days: 7 }) })).status, 400);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ pair, days: 7 }) });
  assert.equal(response.status, 200); assert.ok(validatePerpetualPriceHistory(await response.json(), NOW));
});

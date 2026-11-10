import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';
import { readTradingCache, readTradingPage, warmTradingCache } from '../src/trading-read.ts';
import { createTradingCache } from '../src/trading-cache.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const url = '/api/trading?days=7&page=0&pair=binance,bybit';

for (const failure of ['network', 'timeout', 408, 502, 503, 504]) {
  test(`transient ${failure} retries one cache GET without changing source time`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const snapshot = { fetchedAt: '2026-11-10T14:02:37.000Z' };
    t.mock.method(globalThis, 'fetch', async (target, options) => {
      calls++;
      assert.equal(target, url); assert.equal(options.method, 'GET');
      if (calls > 1) return Response.json(snapshot);
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'timeout') return new Promise(() => {});
      return Response.json({ error: 'temporary failure' }, { status: failure });
    });
    const result = readTradingCache(api, url, new AbortController().signal);
    await flush();
    if (failure === 'timeout') { t.mock.timers.tick(12_000); await flush(); }
    assert.equal(calls, 1);
    t.mock.timers.tick(999); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(1); assert.deepEqual(await result, snapshot); assert.equal(calls, 2);
  });
}

test('continued mixed failures share two attempts and return the last error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ error: 'still unavailable' }, { status: 503 });
  });
  const rejected = assert.rejects(readTradingCache(api, url, new AbortController().signal), error => error instanceof ApiError && error.status === 503 && error.message === 'still unavailable');
  await flush(); t.mock.timers.tick(1000); await rejected;
  t.mock.timers.tick(60_000); await flush(); assert.equal(calls, 2);
});

test('two hung reads stop within 25 seconds, including bodies ignoring cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signals.push(options.signal);
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  const rejected = assert.rejects(readTradingCache(api, url, new AbortController().signal), error => error.name === 'TimeoutError');
  await flush(); t.mock.timers.tick(12_000); await flush();
  assert.equal(signals[0].aborted, true);
  t.mock.timers.tick(1000); await flush(); assert.equal(signals.length, 2);
  t.mock.timers.tick(12_000); await rejected;
  assert.equal(signals[1].aborted, true);
});

for (const status of [200, 400, 401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is not immediately retried`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('<html>unavailable</html>', { status }); });
    await assert.rejects(readTradingCache(api, url, new AbortController().signal), error => error instanceof ApiError && error.status === status);
    assert.equal(calls, 1);
  });
}

for (const retryAfter of ['30', 'Wed, 11 Nov 2026 00:00:00 GMT', '', 'invalid']) {
  test(`a Retry-After header (${JSON.stringify(retryAfter)}) suppresses the immediate retry`, async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unavailable', { status: 503, headers: { 'Retry-After': retryAfter } }); });
    await assert.rejects(readTradingCache(api, url, new AbortController().signal), error => error instanceof ApiError && error.retryAfter === retryAfter);
    assert.equal(calls, 1);
  });
}

for (const phase of ['before', 'read', 'delay', 'retry']) {
  test(`cancelling ${phase} releases the read and cannot start another request`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController(), signals = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signals.push(options.signal);
      if (phase === 'read' || signals.length > 1) return new Promise(() => {});
      throw new TypeError('Failed to fetch');
    });
    if (phase === 'before') controller.abort();
    const rejected = assert.rejects(readTradingCache(api, url, controller.signal), error => error.name === 'AbortError');
    await flush();
    if (phase === 'retry') { t.mock.timers.tick(1000); await flush(); }
    controller.abort(); await rejected;
    t.mock.timers.tick(60_000); await flush();
    assert.equal(signals.length, phase === 'before' ? 0 : phase === 'retry' ? 2 : 1);
    if (phase === 'read' || phase === 'retry') assert.equal(signals.at(-1).aborted, true);
  });
}

const snapshot = (days = 30, pair = 'binance,okx') => ({
  exchanges: pair.split(','), period: { days }, accounts: [], funding: { pagination: { page: 0 } },
  cache: { servedAt: '2026-11-10T14:02:37.000Z', builtAt: '2026-11-10T14:02:30.000Z' },
});

test('warmup reads only the selected landing page and shares a page opened before it finishes', async () => {
  const cache = createTradingCache(), calls = []; let release;
  const request = (url, options) => { calls.push({ url, options }); return new Promise(resolve => { release = resolve; }); };
  const warmed = warmTradingCache(cache, request, { days: 30, pair: 'binance,okx' }, () => assert.fail('unexpected session expiry'));
  const page = readTradingPage(cache, request, 30, 0, 'binance,okx');
  await flush(); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/trading?days=30&page=0&pair=binance,okx');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.timeoutMs, 12_000);
  const data = snapshot(); release(data); await warmed; assert.equal(await page.promise, data);
  assert.equal(cache.get(30, 0, 'binance,okx').data, data);
  await warmTradingCache(cache, request, { days: 30, pair: 'binance,okx' }, () => {});
  assert.equal(calls.length, 1, 'a completed page is not warmed again');
});

test('warmup failure permits normal page recovery, while 401 clears the session cache', async () => {
  const cache = createTradingCache(); let expired = 0;
  await warmTradingCache(cache, async () => { throw new ApiError('unavailable', 500); }, { days: 30, pair: 'binance,okx' }, () => { expired++; });
  assert.equal(cache.latest('binance,okx'), null); assert.equal(expired, 0);
  await readTradingPage(cache, async () => snapshot(), 30, 0, 'binance,okx').promise;
  await warmTradingCache(cache, async () => { throw new ApiError('expired', 401); }, { days: 7, pair: 'binance,bybit' }, () => { expired++; });
  assert.equal(expired, 1); assert.equal(cache.latest('binance,okx'), null);
});

test('logout discards a late warmup 401 without expiring a new session', async () => {
  const cache = createTradingCache(); let reject, expired = 0;
  const pending = warmTradingCache(cache, () => new Promise((_resolve, fail) => { reject = fail; }), { days: 30, pair: 'binance,okx' }, () => { expired++; });
  await flush(); cache.clear();
  await readTradingPage(cache, async () => snapshot(), 30, 0, 'binance,okx').promise;
  reject(new ApiError('old session expired', 401)); await pending;
  assert.equal(expired, 0); assert.ok(cache.latest('binance,okx'));
});

test('warmup does not start while an account mutation owns the cache', async () => {
  const cache = createTradingCache(), mutation = cache.beginMutation('binance'); let calls = 0;
  await warmTradingCache(cache, async () => { calls++; return snapshot(); }, { days: 30, pair: 'binance,okx' }, () => {});
  assert.equal(calls, 0); cache.finish(mutation);
});

test('going offline discards an unmounted warmup response and keeps previous evidence stale', async () => {
  const cache = createTradingCache(); let release, signal;
  const previous = snapshot(7);
  await readTradingPage(cache, async () => previous, 7, 0, 'binance,okx').promise;
  const pending = warmTradingCache(cache, (_url, options) => {
    signal = options.signal; return new Promise(resolve => { release = resolve; });
  }, { days: 30, pair: 'binance,okx' }, () => assert.fail('unexpected session expiry'));
  await flush(); cache.markUnavailable();
  release(snapshot()); await pending;
  assert.equal(signal.aborted, true);
  assert.equal(cache.get(30, 0, 'binance,okx'), null, 'a late response cannot publish fresh evidence after disconnect');
  assert.equal(cache.latest('binance,okx').data, previous); assert.equal(cache.latest('binance,okx').failed, true);
  const next = snapshot(); await readTradingPage(cache, async () => next, 30, 0, 'binance,okx').promise;
  assert.equal(cache.get(30, 0, 'binance,okx').data, next); assert.equal(cache.get(30, 0, 'binance,okx').failed, false);
});

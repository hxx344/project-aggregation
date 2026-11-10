import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';
import { readTradingCache } from '../src/trading-read.ts';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBinanceClock } from '../server/trading-binance-clock.mjs';
import { createTradingExchangeClient } from '../server/trading-exchanges.mjs';
import { formatTradingDiagnostic } from '../server/trading-diagnostics.mjs';

const NOW = Date.parse('2026-11-07T00:00:00Z');
const credentials = { apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const permissions = () => ({ enableReading: true, ...Object.fromEntries(['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'].map(key => [key, false])) });

test('Binance clock shares forced sync, uses the RTT midpoint and independently cancels callers', async () => {
  let wall = NOW, mono = 0, count = 0, requestSignal;
  const gate = deferred();
  const clock = createBinanceClock({ now: () => wall, monotonicNow: () => mono, fetchImpl: async (url, init) => {
    count++; requestSignal = init.signal;
    assert.equal(url, 'https://fapi.binance.com/fapi/v1/time');
    assert.equal(init.method, 'GET'); assert.equal(init.headers, undefined); assert.equal(init.redirect, 'error');
    await gate.promise; wall += 200; mono += 200; return json({ serverTime: NOW + 5100 });
  } });
  const controller = new AbortController();
  const first = clock.sync({ signal: controller.signal, force: true });
  const second = clock.sync({ force: true });
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, false);
  gate.resolve();
  assert.deepEqual(await second, { offset: 5000, rtt: 200, syncedAt: NOW + 200 });
  assert.equal(clock.timestamp(), NOW + 5200); assert.equal(clock.serverNow(), NOW + 5200);
  assert.equal(count, 1); await clock.sync(); assert.equal(count, 1);
  clock.forget(); assert.equal(clock.timestamp(), wall);
});

test('Binance clock expires and invalidates wall-clock corrections instead of reusing a stale offset', async () => {
  let wall = NOW, mono = 0, count = 0;
  const clock = createBinanceClock({ now: () => wall, monotonicNow: () => mono, ttlMs: 10000, fetchImpl: async () => { count++; return json({ serverTime: wall - 4000 }); } });
  await clock.sync(); assert.equal(clock.timestamp(), NOW - 4000);
  wall += 9999; mono += 9999; assert.equal(clock.timestamp(), wall - 4000);
  wall++; mono++; assert.equal(clock.timestamp(), wall);
  await clock.sync(); assert.equal(count, 2);
  wall -= 1; assert.equal(clock.timestamp(), wall, 'a backward clock jump discards the sample');
  await clock.sync(); wall += 2000; assert.equal(clock.timestamp(), wall, 'a forward NTP correction is detected against monotonic time');
});

test('Binance clock bounds an uncooperative transport and cancels the last pending reader', async () => {
  let signal;
  const clock = createBinanceClock({ now: () => NOW, timeoutMs: 10, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  await assert.rejects(clock.sync(), { code: 'timeout' }); assert.equal(signal.aborted, true);
  const controller = new AbortController(), pending = clock.sync({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(signal.aborted, true);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(clock.sync({ signal: alreadyAborted.signal }), { name: 'AbortError' });
});

test('Binance clock rejects malformed, oversized and implausible time samples', async () => {
  for (const response of [json({ serverTime: NOW + 300001 }), json({ serverTime: String(NOW) }), json({ serverTime: -1 }), json({ serverTime: NOW }, 500), json({ serverTime: NOW, padding: 'x'.repeat(5000) })]) {
    const clock = createBinanceClock({ now: () => NOW, fetchImpl: async () => response });
    await assert.rejects(clock.sync(), { code: 'clock' }); assert.equal(clock.timestamp(), NOW);
  }
});

for (const accountMode of ['standard', 'portfolio-margin']) for (const offset of [-30_000, 30_000]) {
  test(`Binance ${accountMode} re-signs all reads after -1021 with offset ${offset}`, async () => {
    const calls = [];
    const client = createTradingExchangeClient('binance', { now: () => NOW, fetchImpl: async (url, init) => {
      const parsed = new URL(url); calls.push(parsed);
      if (parsed.pathname === '/fapi/v1/time') { assert.equal(init.headers, undefined); return json({ serverTime: NOW + offset }); }
      const signature = parsed.searchParams.get('signature'); parsed.searchParams.delete('signature');
      assert.equal(signature, createHmac('sha256', credentials.apiSecret).update(parsed.searchParams.toString()).digest('hex'));
      assert.equal(parsed.searchParams.get('recvWindow'), '5000');
      if (Number(parsed.searchParams.get('timestamp')) !== NOW + offset) return json({ code: -1021, msg: 'not copied' }, 400);
      if (parsed.pathname.endsWith('apiRestrictions')) return json(permissions());
      assert.equal(parsed.hostname, accountMode === 'standard' ? 'fapi.binance.com' : 'papi.binance.com');
      return json([]);
    } });
    try {
      assert.deepEqual((await client.anthropicPositions(credentials, { accountMode })).positions, []);
      const funding = await client.funding(credentials, { accountMode, start: NOW - 1000, end: NOW });
      assert.equal(funding.complete, true);
      assert.equal(calls.filter(url => url.pathname === '/fapi/v1/time').length, 1);
      assert.equal(calls[0].pathname, '/sapi/v1/account/apiRestrictions');
      assert.equal(calls[2].pathname, '/sapi/v1/account/apiRestrictions');
    } finally { client.close(); }
  });
}

test('Binance timestamp recovery stops after the second rejection and does not broaden read-only permission', async () => {
  for (const failure of [-1021, -2015]) {
    const calls = [];
    const client = createTradingExchangeClient('binance', { now: () => NOW, fetchImpl: async url => {
      const path = new URL(url).pathname; calls.push(path);
      return path === '/fapi/v1/time' ? json({ serverTime: NOW - 1000 }) : json({ code: failure }, 400);
    } });
    try {
      await assert.rejects(client.positions(credentials), error => error.diagnostic.providerCode === failure);
      assert.equal(calls.length, failure === -1021 ? 3 : 1);
    } finally { client.close(); }
  }
  let reads = 0;
  const client = createTradingExchangeClient('binance', { now: () => NOW, fetchImpl: async url => {
    if (new URL(url).pathname === '/fapi/v1/time') return json({ serverTime: NOW - 1000 });
    if (++reads === 1) return json({ code: -1021 }, 400);
    return json({ ...permissions(), enableFutures: true });
  } });
  try { await assert.rejects(client.positions(credentials), { code: 'permissions' }); assert.equal(reads, 2); }
  finally { client.close(); }
  const message = formatTradingDiagnostic({ version: 1, exchange: 'binance', accountMode: 'portfolio-margin', operation: 'positions', code: 'http', httpStatus: 400, providerCode: -1021 });
  assert.match(message, /请求时间.*服务器时间不一致/); assert.doesNotMatch(message, /限流|权限|白名单/);
});

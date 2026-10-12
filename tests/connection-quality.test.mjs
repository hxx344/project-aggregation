import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';
import { checkConnectionHealth, createConnectionMonitor, latencyQuality } from '../src/connection-quality.ts';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

function monitorFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const states = [], requests = [];
  const monitor = createConnectionMonitor({
    now: () => Date.now(),
    probe: signal => {
      const request = { ...deferred(), signal };
      requests.push(request);
      return request.promise;
    },
    onChange: state => states.push(state),
  });
  t.after(() => monitor.dispose());
  return { monitor, states, requests, latest: () => states.at(-1) };
}

test('latency bands include 150 ms and 500 ms at their documented boundaries', () => {
  for (const [latency, expected] of [[0, 'good'], [150, 'good'], [150.01, 'fair'], [500, 'fair'], [500.01, 'slow'], [3000, 'slow']]) {
    assert.equal(latencyQuality(latency), expected, `${latency} ms`);
  }
});

test('displayed latency agrees with the quality band just above each threshold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [elapsed, latencyMs, quality] of [[150.1, 151, 'fair'], [500.1, 501, 'slow']]) {
    let now = 0;
    const states = [];
    const monitor = createConnectionMonitor({ now: () => now, probe: async () => {}, onChange: state => states.push(state) });
    t.after(() => monitor.dispose());
    monitor.sync({ online: true, visible: true });
    now = elapsed;
    await flush();
    assert.equal(states.at(-1).latencyMs, latencyMs);
    assert.equal(states.at(-1).quality, quality);
    assert.equal(latencyQuality(states.at(-1).latencyMs), states.at(-1).quality);
  }
});

test('health probes require a valid status and request a fresh, non-redirected response with a 3 s deadline', async () => {
  const controller = new AbortController();
  const calls = [];
  await checkConnectionHealth(async (url, options) => {
    calls.push({ url, options });
    return { status: 'ok', uptime: 30 };
  }, controller.signal);
  assert.deepEqual(calls, [{ url: '/api/health', options: {
    signal: controller.signal, timeoutMs: 3000, cache: 'no-store', redirect: 'error',
  } }]);
  for (const response of [undefined, null, true, 'ok', [], {}, { status: null }, { status: 'OK' }, { status: 'degraded' }]) {
    await assert.rejects(checkConnectionHealth(async () => response, controller.signal), /Invalid health response/);
  }
});

test('health probes preserve API and transport failures and reject malformed or empty success bodies', async t => {
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok', error: 'Unavailable' }, { status: 503 }));
  await assert.rejects(checkConnectionHealth(api, signal), error => error instanceof ApiError && error.status === 503);
  const networkError = new TypeError('Network disconnected');
  globalThis.fetch.mock.mockImplementation(async () => { throw networkError; });
  await assert.rejects(checkConnectionHealth(api, signal), error => error === networkError);
  for (const response of [new Response('<html>Login</html>'), new Response(null, { status: 204 })]) {
    globalThis.fetch.mock.mockImplementation(async () => response);
    await assert.rejects(checkConnectionHealth(api, signal), /Invalid health response/);
  }
});

for (const bodyHangs of [false, true]) {
  test(`health deadline aborts a hanging ${bodyHangs ? 'response body' : 'transport'} at 3 s without retry`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    let signal, calls = 0, settled = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++; signal = options.signal;
      return bodyHangs ? { ok: true, status: 200, json: () => pending.promise } : pending.promise;
    });
    const result = checkConnectionHealth(api, new AbortController().signal);
    result.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(result, { name: 'TimeoutError' });
    await flush();
    t.mock.timers.tick(2999); await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1); await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    pending.resolve(bodyHangs ? { status: 'ok' } : Response.json({ status: 'ok' }));
    await flush();
  });
}

test('monitor measures RTT and discards the last latency when a later probe fails or goes offline', async t => {
  const { monitor, requests, latest } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  assert.deepEqual(latest(), { quality: 'checking', latencyMs: null, checkedAt: null });
  t.mock.timers.tick(150); requests[0].resolve(); await flush();
  assert.deepEqual(latest(), { quality: 'good', latencyMs: 150, checkedAt: Date.now() });
  t.mock.timers.tick(10000);
  requests[1].reject(new Error('Service unavailable')); await flush();
  assert.deepEqual(latest(), { quality: 'unreachable', latencyMs: null, checkedAt: Date.now() });
  t.mock.timers.tick(10000);
  t.mock.timers.tick(501); requests[2].resolve(); await flush();
  assert.equal(latest().quality, 'slow');
  monitor.sync({ online: false, visible: true });
  assert.deepEqual(latest(), { quality: 'offline', latencyMs: null, checkedAt: null });
  t.mock.timers.tick(60000);
  assert.equal(requests.length, 3);
});

test('probes stay serial and the next interval begins after the previous probe settles', async t => {
  const { monitor, requests } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  monitor.sync({ online: true, visible: true });
  t.mock.timers.tick(30000);
  assert.equal(requests.length, 1);
  requests[0].resolve(); await flush();
  t.mock.timers.tick(9999);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 2);
  t.mock.timers.tick(30000);
  assert.equal(requests.length, 2);
});

test('hidden pages cancel probes, resume with fresh checking state, and ignore stale completions', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  monitor.sync({ online: true, visible: false });
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(latest(), { quality: 'paused', latencyMs: null, checkedAt: null });
  t.mock.timers.tick(60000);
  assert.equal(requests.length, 1);
  monitor.sync({ online: true, visible: true });
  assert.equal(latest().quality, 'checking');
  assert.equal(requests.length, 2);
  const beforeStaleResult = states.length;
  requests[0].resolve(); await flush();
  assert.equal(states.length, beforeStaleResult);
  t.mock.timers.tick(300); requests[1].resolve(); await flush();
  assert.deepEqual(latest(), { quality: 'fair', latencyMs: 300, checkedAt: Date.now() });
  t.mock.timers.tick(10000);
  assert.equal(requests.length, 3);
});

test('late failure from an offline request cannot overwrite the recovered connection or add a timer', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  monitor.sync({ online: false, visible: false });
  assert.equal(latest().quality, 'offline');
  assert.equal(requests[0].signal.aborted, true);
  monitor.sync({ online: true, visible: false });
  assert.equal(latest().quality, 'paused');
  assert.equal(requests.length, 1);
  monitor.sync({ online: true, visible: true });
  assert.equal(latest().quality, 'checking');
  t.mock.timers.tick(20); requests[1].resolve(); await flush();
  const recovered = latest(), count = states.length;
  t.mock.timers.tick(5000); requests[0].reject(new Error('Late failure')); await flush();
  assert.equal(states.length, count);
  assert.equal(latest(), recovered);
  t.mock.timers.tick(5000);
  assert.equal(requests.length, 3);
  t.mock.timers.tick(5000);
  assert.equal(requests.length, 3);
});

test('pausing clears a scheduled probe and disposing prevents rescheduling or further publications', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  requests[0].resolve(); await flush();
  monitor.sync({ online: true, visible: false });
  assert.equal(latest().quality, 'paused');
  t.mock.timers.tick(30000);
  assert.equal(requests.length, 1);
  monitor.sync({ online: true, visible: true });
  assert.equal(requests.length, 2);
  monitor.dispose();
  assert.equal(requests[1].signal.aborted, true);
  const count = states.length;
  requests[1].resolve(); await flush();
  monitor.sync({ online: true, visible: true });
  monitor.sync({ online: false, visible: false });
  t.mock.timers.tick(60000);
  assert.equal(states.length, count);
  assert.equal(requests.length, 2);
});

test('disposing an idle monitor clears its scheduled next probe', async t => {
  const { monitor, requests, states } = monitorFixture(t);
  monitor.sync({ online: true, visible: true });
  requests[0].resolve(); await flush();
  const count = states.length;
  monitor.dispose();
  t.mock.timers.tick(60000);
  assert.equal(requests.length, 1);
  assert.equal(states.length, count);
});

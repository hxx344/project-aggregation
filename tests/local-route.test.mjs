import test from 'node:test';
import assert from 'node:assert/strict';
import { setCsrfToken } from '../src/api.ts';
import { createLocalRouteMonitor, decodeLocalRoute, readLocalRoute } from '../src/local-route.ts';

const now = 1_700_000_000_000;
const active = { supported: true, online: true, visible: true };
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (overrides = {}) => ({
  service: 'project-aggregation-local-route', schema: 1, state: 'direct', reason: 'verified-direct',
  server: '203.0.113.7', sshPort: 22, checkedAt: new Date(now).toISOString(), ...overrides,
});
const direct = () => decodeLocalRoute(response({ checkedAt: new Date(Date.now()).toISOString() }));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

function monitorFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const requests = [], states = [];
  const monitor = createLocalRouteMonitor({
    read: signal => {
      const request = { ...deferred(), signal };
      requests.push(request);
      return request.promise;
    },
    onChange: state => states.push(state),
  });
  t.after(() => monitor.dispose());
  return { monitor, requests, states, latest: () => states.at(-1) };
}

test('route protocol accepts verified direct and explicit unknown results with fresh timestamps', () => {
  assert.deepEqual(decodeLocalRoute(response(), now), {
    state: 'direct', reason: 'verified-direct', server: '203.0.113.7', sshPort: 22, checkedAt: now,
  });
  assert.deepEqual(decodeLocalRoute(response({ state: 'unknown', reason: 'proxy-detected', server: '2001:db8::1', sshPort: 65535 }), now), {
    state: 'unknown', reason: 'proxy-detected', server: '2001:db8::1', sshPort: 65535, checkedAt: now,
  });
  for (const age of [-15000, 2000]) {
    assert.equal(decodeLocalRoute(response({ checkedAt: new Date(now + age).toISOString() }), now).checkedAt, now + age);
  }
  for (const age of [-15001, 2001]) {
    assert.throws(() => decodeLocalRoute(response({ checkedAt: new Date(now + age).toISOString() }), now), /Invalid or stale/);
  }
});

test('route protocol rejects malformed responses and never upgrades an unverified reason to direct', () => {
  for (const value of [null, true, 'direct', [], {},
    ...[
      { service: 'another-service' }, { schema: '1' }, { schema: 2 }, { state: 'connected' },
      { state: ['direct'], reason: 'proxy-detected' }, { state: ['unknown'] },
      { reason: 'proxy-detected' }, { reason: null }, { reason: 'x'.repeat(101) },
      { server: 'https://example.com' }, { server: '127.0.0.1/path' }, { server: null },
      { sshPort: '22' }, { sshPort: 0 }, { sshPort: 65536 }, { sshPort: 22.5 },
      { checkedAt: now }, { checkedAt: 'not-a-date' },
    ].map(overrides => response(overrides)),
  ]) {
    assert.throws(() => decodeLocalRoute(value, now), /Invalid/, JSON.stringify(value));
  }
});

test('local fetch is a fresh loopback GET without hub credentials, CSRF, referrer or redirects', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  setCsrfToken('hub-token-must-stay-on-hub');
  t.after(() => setCsrfToken(''));
  const controller = new AbortController(), calls = [];
  const result = await readLocalRoute(controller.signal, async (url, options) => {
    calls.push({ url, options });
    return Response.json(response());
  });
  assert.equal(result.state, 'direct');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:3101/route', options: {
    signal: controller.signal, method: 'GET', mode: 'cors', credentials: 'omit',
    cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
  } }]);
});

test('local reads reject HTTP errors, invalid JSON and stale helper responses', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const signal = new AbortController().signal;
  await assert.rejects(readLocalRoute(signal, async () => Response.json(response(), { status: 503 })), /unavailable/);
  await assert.rejects(readLocalRoute(signal, async () => new Response('<html>Not a route helper</html>')), SyntaxError);
  await assert.rejects(readLocalRoute(signal, async () => Response.json(response({ checkedAt: new Date(now - 15001).toISOString() }))), /stale/);
});

test('caller cancellation releases a hanging body and an already cancelled request never fetches', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const pending = deferred(), controller = new AbortController();
  let calls = 0, bodyReads = 0;
  const fetcher = async () => { calls++; return { ok: true, json: () => { bodyReads++; return pending.promise; } }; };
  const result = readLocalRoute(controller.signal, fetcher);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await flush();
  assert.equal(bodyReads, 1);
  controller.abort();
  await rejected;
  await assert.rejects(readLocalRoute(controller.signal, fetcher), { name: 'AbortError' });
  assert.equal(calls, 1);
  pending.resolve(response()); await flush();
});

test('unsupported origins never probe and clear an earlier verified direct result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const states = [];
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json(response({ checkedAt: new Date(Date.now()).toISOString() })));
  const monitor = createLocalRouteMonitor({ onChange: state => states.push(state) });
  const latest = () => states.at(-1);
  t.after(() => monitor.dispose());
  monitor.sync({ ...active, supported: false });
  assert.deepEqual(latest(), { state: 'unknown', reason: 'unsupported-origin' });
  t.mock.timers.tick(60000); await flush();
  assert.equal(fetcher.mock.callCount(), 0);
  monitor.sync(active);
  await flush();
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(latest().state, 'direct');
  monitor.sync({ ...active, supported: false });
  assert.deepEqual(latest(), { state: 'unknown', reason: 'unsupported-origin' });
  t.mock.timers.tick(60000); await flush();
  assert.equal(fetcher.mock.callCount(), 1);
});

test('periodic probes clear old direct status immediately and stay serial until they settle', async t => {
  const { monitor, requests, latest } = monitorFixture(t);
  monitor.sync(active);
  monitor.sync(active);
  assert.equal(requests.length, 1);
  requests[0].resolve(direct()); await flush();
  t.mock.timers.tick(9999);
  assert.equal(latest().state, 'direct');
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(latest(), { state: 'checking', reason: 'checking' });
  assert.equal(requests.length, 2);
  monitor.sync(active);
  t.mock.timers.tick(1000);
  assert.equal(requests.length, 2);
  requests[1].reject(new Error('Helper stopped')); await flush();
  assert.deepEqual(latest(), { state: 'unknown', reason: 'not-connected' });
});

test('deadline clears verified state even when the reader ignores abort, then permits a fresh retry', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync(active);
  requests[0].resolve(direct()); await flush();
  t.mock.timers.tick(10000);
  t.mock.timers.tick(14999); await flush();
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(latest().state, 'checking');
  t.mock.timers.tick(1); await flush();
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(requests[1].signal.reason.name, 'TimeoutError');
  assert.deepEqual(latest(), { state: 'unknown', reason: 'not-connected' });
  t.mock.timers.tick(9999);
  assert.equal(requests.length, 2);
  t.mock.timers.tick(1);
  assert.equal(requests.length, 3);
  const count = states.length;
  requests[1].resolve(direct()); await flush();
  assert.equal(states.length, count);
  assert.equal(latest().state, 'checking');
  requests[2].resolve(direct()); await flush();
  assert.equal(latest().state, 'direct');
});

test('background pages cancel the active probe and resume in checking without accepting stale results', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync(active);
  monitor.sync({ ...active, visible: false });
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(latest(), { state: 'paused', reason: 'paused' });
  await flush(); t.mock.timers.tick(60000); await flush();
  assert.equal(requests.length, 1);
  monitor.sync(active);
  assert.deepEqual(latest(), { state: 'checking', reason: 'checking' });
  assert.equal(requests.length, 2);
  const recovered = { ...direct(), server: '203.0.113.9', sshPort: 2222 };
  requests[1].resolve(recovered); await flush();
  assert.deepEqual(latest(), recovered);
  const count = states.length;
  requests[0].resolve(direct()); await flush();
  assert.equal(states.length, count);
  assert.deepEqual(latest(), recovered);
});

test('offline transitions cancel scheduled work and old failures cannot overwrite a recovered result', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync(active);
  monitor.sync({ ...active, online: false });
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(latest(), { state: 'offline', reason: 'offline' });
  await flush(); t.mock.timers.tick(60000); await flush();
  assert.equal(requests.length, 1);
  monitor.sync(active);
  requests[1].resolve(direct()); await flush();
  const recovered = latest(), count = states.length;
  requests[0].reject(new Error('Old helper failed')); await flush();
  assert.equal(states.length, count);
  assert.equal(latest(), recovered);
  monitor.sync({ ...active, online: false });
  assert.deepEqual(latest(), { state: 'offline', reason: 'offline' });
  t.mock.timers.tick(60000);
  assert.equal(requests.length, 2);
});

test('disposing aborts the active read and prevents late results, timeouts or sync from publishing', async t => {
  const { monitor, requests, states } = monitorFixture(t);
  monitor.sync(active);
  const count = states.length;
  monitor.dispose();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(direct()); await flush();
  monitor.sync(active);
  monitor.sync({ ...active, online: false });
  t.mock.timers.tick(60000); await flush();
  assert.equal(states.length, count);
  assert.equal(requests.length, 1);
});

test('hiding and disposing clear the scheduled next probe', async t => {
  const { monitor, requests, states, latest } = monitorFixture(t);
  monitor.sync(active);
  requests[0].resolve(direct()); await flush();
  monitor.sync({ ...active, visible: false });
  assert.deepEqual(latest(), { state: 'paused', reason: 'paused' });
  t.mock.timers.tick(60000);
  assert.equal(requests.length, 1);
  monitor.sync(active);
  requests[1].resolve(direct()); await flush();
  const count = states.length;
  monitor.dispose();
  t.mock.timers.tick(60000); await flush();
  assert.equal(states.length, count);
  assert.equal(requests.length, 2);
});

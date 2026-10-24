import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeError } from '../server/runtime/protocol.mjs';
import { createInProcessDataClient } from '../server/runtime/data-client.mjs';

const revision = 'a'.repeat(64);
const generatedAt = '2026-10-24T00:00:00.000Z';
const request = (extra = {}) => ({ method: 'GET', target: '/api/trading?days=7', sessionId: 'session', contentType: undefined, body: [], ...extra });
// A data plane that records calls and answers with scripted values.
function plane(overrides = {}) {
  const calls = [];
  return { calls, overview: () => ({ projects: [], generatedAt }),
    subscribeOverview: subscriber => { calls.push(['subscribe', subscriber]); return () => calls.push(['unsubscribe']); },
    projectChanged: (id, change) => calls.push(['changed', id, change]),
    coordinateAssetSync: async (id, value) => { calls.push(['sync', id, value]); return { state: 'success', message: '' }; },
    handle: async value => { calls.push(['handle', value]); return { status: 202, body: { ok: true }, extra: 1 }; },
    observeSlowConsumer: () => calls.push(['slow']), ...overrides };
}
const clientFor = (fake, log = { error() {} }) => createInProcessDataClient(fake, { log });

test('forwarded requests are validated before they reach the data plane and replies are limited to status and body', async () => {
  const fake = plane(), client = clientFor(fake);
  assert.deepEqual(await client.forward(request()), { status: 202, body: { ok: true } });
  // Any method Node accepts still reaches the data plane, which answers it as before.
  for (const method of ['PROPFIND', 'M-SEARCH']) assert.deepEqual(await client.forward(request({ method, deadline: Date.now() + 1000 })), { status: 202, body: { ok: true } });
  for (const invalid of [request({ target: '/internal/v1/status' }), request({ method: 'get' }), request({ method: '-GET' }), request({ deadline: 1.5 }), request({ sessionId: '' }), request({ body: null }), request({ contentType: 1 })]) {
    await assert.rejects(client.forward(invalid), error => error instanceof RuntimeError && error.status === 400);
  }
  assert.equal(fake.calls.filter(([name]) => name === 'handle').length, 3);
});

test('a reply or overview outside the contract is reported as unavailable, and internal failures keep their cause only in the log', async () => {
  for (const reply of [{ status: 99, body: {} }, { status: 200, body: [] }, { status: 200, body: null }, null]) {
    await assert.rejects(clientFor(plane({ handle: async () => reply })).forward(request()), error => error instanceof RuntimeError && error.status === 503 && error.origin === 'transport');
  }
  await assert.rejects(clientFor(plane({ overview: () => ({ projects: {} }) })).overview(), error => error.status === 503 && error.origin === 'transport');
  const logged = [];
  await assert.rejects(clientFor(plane({ handle: async () => { throw new Error('secret path /data'); } }), { error: (fields, message) => logged.push({ fields, message }) }).forward(request()),
    error => error instanceof RuntimeError && error.status === 503 && error.message === '运行时内部错误');
  assert.equal(logged.length, 1); assert.equal(logged[0].fields.operation, 'forward'); assert.equal(logged[0].fields.err.message, 'secret path /data');
});

test('project change notices accept only the known reasons, and only an update may clear the snapshot', async () => {
  const fake = plane(), client = clientFor(fake);
  assert.deepEqual(await client.projectChanged('asset', { reason: 'updated', clearSnapshot: true }), { accepted: true });
  await client.projectChanged('asset', { reason: 'preferences' });
  for (const [id, change] of [['asset', { reason: 'renamed' }], ['asset', { reason: 'deleted', clearSnapshot: true }], ['../asset', { reason: 'deleted' }], ['asset', { reason: 'updated', clearSnapshot: 'yes' }]]) {
    await assert.rejects(client.projectChanged(id, change), error => error instanceof RuntimeError && error.status === 400);
  }
  assert.deepEqual(fake.calls, [['changed', 'asset', { reason: 'updated', clearSnapshot: true }], ['changed', 'asset', { reason: 'preferences', clearSnapshot: false }]]);
});

test('asset sync coordination checks the revision shape and passes a null result through', async () => {
  const fake = plane(), client = clientFor(fake);
  assert.deepEqual(await client.coordinateAssetSync('asset', revision), { state: 'success', message: '' });
  assert.equal(await clientFor(plane({ coordinateAssetSync: async () => null })).coordinateAssetSync('asset', revision), null);
  await assert.rejects(client.coordinateAssetSync('asset', 'stale'), error => error.status === 400);
  assert.deepEqual(fake.calls, [['sync', 'asset', revision]]);
});

test('overview subscribers receive only events within the contract', () => {
  const fake = plane(), client = clientFor(fake);
  assert.throws(() => client.subscribeOverview({ deliver() {} }), TypeError);
  const delivered = [];
  const stop = client.subscribeOverview({ wants: () => true, deliver: event => delivered.push(event) });
  const registered = fake.calls[0][1];
  assert.equal(registered.wants(), true);
  registered.deliver({ revision: 1, overview: { projects: [], generatedAt }, extra: true });
  assert.throws(() => registered.deliver({ revision: 0, overview: { projects: [], generatedAt } }), error => error.origin === 'transport');
  assert.throws(() => registered.deliver({ revision: 2, overview: null }), error => error.origin === 'transport');
  assert.deepEqual(delivered, [{ revision: 1, overview: { projects: [], generatedAt } }]);
  stop();
  assert.deepEqual(fake.calls.map(([name]) => name), ['subscribe', 'unsubscribe']);
});

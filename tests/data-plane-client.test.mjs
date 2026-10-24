import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonBody, MAX_BODY_BYTES } from '../server/http-common.mjs';
import { createRuntimeService } from '../server/runtime/service.mjs';
import { startInternalServer } from '../server/runtime/internal-server.mjs';
import { createRuntimeConnection } from '../server/runtime/connection.mjs';
import { RuntimeError } from '../server/runtime/protocol.mjs';
import { createInProcessDataClient, createSocketDataClient } from '../server/runtime/data-client.mjs';

const windows = process.platform === 'win32';
const revision = 'a'.repeat(64);
const generatedAt = '2026-10-24T00:00:00.000Z';
const request = (extra = {}) => ({ method: 'GET', target: '/api/trading?days=7', sessionId: 'session', contentType: undefined, body: [], ...extra });
// A data plane that records calls and answers with scripted values.
function plane(overrides = {}) {
  const calls = [], subscribers = new Set();
  let revisions = 0;
  const fake = { calls, subscribers, overview: () => ({ projects: [], generatedAt }),
    subscribeOverview: subscriber => { calls.push(['subscribe']); subscribers.add(subscriber); return () => { calls.push(['unsubscribe']); subscribers.delete(subscriber); }; },
    overviewEvent: () => ({ revision: ++revisions, overview: fake.overview() }),
    projectChanged: (id, change) => calls.push(['changed', id, change]),
    coordinateAssetSync: async (id, value) => { calls.push(['sync', id, value]); return { state: 'success', message: '' }; },
    handle: async value => { calls.push(['handle', { ...value, body: undefined }]); return { status: 202, body: { ok: true }, extra: 1 }; },
    reportApiStats: stats => calls.push(['stats', stats]), ...overrides };
  return fake;
}
const quiet = { error() {}, warn() {} };
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'dp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function serve(t, fake, dir) {
  dir ??= await directory(t);
  const service = createRuntimeService({ readMaintenance: () => false });
  const server = await startInternalServer({ service, dataPlane: fake, dir, logger: quiet });
  t.after(() => server.close());
  return { dir, server, service };
}
const implementations = {
  'in-process': async (_t, fake) => createInProcessDataClient(fake, { log: quiet }),
  socket: async (t, fake) => createSocketDataClient({ dir: (await serve(t, fake)).dir, backoffMs: [20] }),
};
const forwarded = fake => fake.calls.filter(([name]) => name === 'handle');
const until = async (predicate, ms = 3000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };

for (const [name, connect] of Object.entries(implementations)) {
  const options = { skip: name === 'socket' && windows };
  test(`${name}: forwarded requests are validated before they reach the data plane and replies are limited to status and body`, options, async t => {
    const fake = plane(), client = await connect(t, fake);
    assert.deepEqual(await client.forward(request()), { status: 202, body: { ok: true } });
    // Any method Node accepts still reaches the data plane, which answers it as before; HEAD keeps its reply too.
    for (const method of ['HEAD', 'PROPFIND', 'M-SEARCH']) assert.deepEqual(await client.forward(request({ method, deadline: Date.now() + 1000 })), { status: 202, body: { ok: true } });
    for (const invalid of [request({ target: '/internal/v1/status' }), request({ method: 'get' }), request({ method: '-GET' }), request({ deadline: 1.5 }), request({ sessionId: '' }), request({ body: null }), request({ contentType: 1 })]) {
      await assert.rejects(client.forward(invalid), error => error instanceof RuntimeError && error.status === 400);
    }
    assert.equal(forwarded(fake).length, 4);
    assert.deepEqual(forwarded(fake).map(([, value]) => value.method), ['GET', 'HEAD', 'PROPFIND', 'M-SEARCH']);
    assert.equal(forwarded(fake)[0][1].target, '/api/trading?days=7');
  });

  test(`${name}: a reply or overview outside the contract is reported as unavailable, and a write's as unconfirmed`, options, async t => {
    for (const reply of [{ status: 99, body: {} }, { status: 200, body: [] }, { status: 200, body: null }, null]) {
      const client = await connect(t, plane({ handle: async () => reply }));
      await assert.rejects(client.forward(request()), error => error instanceof RuntimeError && error.status === 503 && error.origin === 'transport' && error.message === '运行时不可用');
      await assert.rejects(client.forward(request({ method: 'POST' })), error => error.status === 503 && error.uncertain && error.message === '结果未确认，请刷新后核对');
    }
    await assert.rejects((await connect(t, plane({ overview: () => ({ projects: {} }) }))).overview(), error => error.status === 503 && error.origin === 'transport');
    await assert.rejects((await connect(t, plane({ coordinateAssetSync: async () => [] }))).coordinateAssetSync('asset', revision), error => error.status === 503 && error.uncertain);
  });

  test(`${name}: project change notices accept only the known reasons, and only an update may clear the snapshot`, options, async t => {
    const fake = plane(), client = await connect(t, fake);
    assert.deepEqual(await client.projectChanged('asset', { reason: 'updated', clearSnapshot: true }), { accepted: true });
    await client.projectChanged('asset', { reason: 'preferences' });
    for (const [id, change] of [['asset', { reason: 'renamed' }], ['asset', { reason: 'deleted', clearSnapshot: true }], ['../asset', { reason: 'deleted' }], ['asset', { reason: 'updated', clearSnapshot: 'yes' }]]) {
      await assert.rejects(client.projectChanged(id, change), error => error instanceof RuntimeError && error.status === 400);
    }
    assert.deepEqual(fake.calls.filter(([call]) => call === 'changed'), [['changed', 'asset', { reason: 'updated', clearSnapshot: true }], ['changed', 'asset', { reason: 'preferences', clearSnapshot: false }]]);
  });

  test(`${name}: asset sync coordination checks the revision shape and passes a null result through`, options, async t => {
    const fake = plane(), client = await connect(t, fake);
    assert.deepEqual(await client.coordinateAssetSync('asset', revision), { state: 'success', message: '' });
    assert.equal(await (await connect(t, plane({ coordinateAssetSync: async () => null }))).coordinateAssetSync('asset', revision), null);
    await assert.rejects(client.coordinateAssetSync('asset', 'stale'), error => error.status === 400);
    assert.deepEqual(fake.calls.filter(([call]) => call === 'sync'), [['sync', 'asset', revision]]);
  });

  test(`${name}: overview subscribers receive only events within the contract`, options, async t => {
    const fake = plane(), client = await connect(t, fake);
    assert.throws(() => client.subscribeOverview({ deliver() {} }), TypeError);
    const delivered = [];
    const stop = client.subscribeOverview({ wants: () => true, deliver: event => delivered.push(event) });
    t.after(stop);
    await until(() => fake.subscribers.size === 1);
    const [registered] = fake.subscribers;
    assert.equal(registered.wants(), true);
    registered.deliver({ revision: 7, overview: { projects: [], generatedAt }, extra: true });
    await until(() => delivered.some(event => event.revision === 7));
    assert.deepEqual(delivered.at(-1), { revision: 7, overview: { projects: [], generatedAt } });
    stop();
    await until(() => fake.subscribers.size === 0);
  });

  test(`${name}: the API's stream counts are reported as one checked record`, options, async t => {
    const fake = plane(), client = await connect(t, fake);
    const stats = { instanceId: '00000000-0000-4000-8000-000000000001', sequence: 1, activeConnections: 3, slowConsumerDisconnects: 2 };
    assert.deepEqual(await client.reportApiStats({ ...stats, extra: true }), { accepted: true });
    assert.deepEqual(fake.calls.filter(([call]) => call === 'stats'), [['stats', stats]]);
    for (const invalid of [null, { ...stats, instanceId: 'api' }, { ...stats, activeConnections: -1 }, { ...stats, activeConnections: 10_001 }, { ...stats, slowConsumerDisconnects: 1.5 }, { ...stats, activeConnections: undefined }, { ...stats, sequence: 0 }, { ...stats, sequence: undefined }]) {
      await assert.rejects(client.reportApiStats(invalid), error => error instanceof RuntimeError && error.status === 400);
    }
    assert.equal(fake.calls.filter(([call]) => call === 'stats').length, 1);
  });
}

test('in-process: invalid events are refused and internal failures keep their cause only in the log', async () => {
  const fake = plane(), client = createInProcessDataClient(fake, { log: quiet });
  client.subscribeOverview({ wants: () => true, deliver() {} });
  const [registered] = fake.subscribers;
  assert.throws(() => registered.deliver({ revision: 0, overview: { projects: [], generatedAt } }), error => error.origin === 'transport');
  assert.throws(() => registered.deliver({ revision: 2, overview: null }), error => error.origin === 'transport');
  const logged = [];
  await assert.rejects(createInProcessDataClient(plane({ handle: async () => { throw new Error('secret path /data'); } }), { log: { error: (fields, message) => logged.push({ fields, message }) } }).forward(request()),
    error => error instanceof RuntimeError && error.status === 503 && error.message === '运行时内部错误');
  assert.equal(logged.length, 1); assert.equal(logged[0].fields.operation, 'forward'); assert.equal(logged[0].fields.err.message, 'secret path /data');
});

test('socket: a forwarded body keeps its bytes, type, session and deadline, and one byte past the limit still yields 413', { skip: windows }, async t => {
  const seen = [];
  const fake = plane({ handle: async value => {
    seen.push({ method: value.method, target: value.target, sessionId: value.sessionId, contentType: value.contentType, deadline: value.deadline });
    try { return { status: 200, body: { echo: (await readJsonBody(value.contentType, value.body)).body } }; }
    catch (error) { return { status: error.status, body: { error: error.message } }; }
  } });
  const { dir } = await serve(t, fake);
  const client = createSocketDataClient({ dir });
  const deadline = Date.now() + 5000;
  const reply = await client.forward(request({ method: 'POST', target: '/api/trading/execution/preview?x=1', contentType: 'application/json', deadline, body: [Buffer.from('{"a":'), Buffer.from('"中文"}')] }));
  assert.deepEqual(reply, { status: 200, body: { echo: { a: '中文' } } });
  assert.deepEqual(seen[0], { method: 'POST', target: '/api/trading/execution/preview?x=1', sessionId: 'session', contentType: 'application/json', deadline });
  const large = Buffer.from(JSON.stringify({ value: 'x'.repeat(MAX_BODY_BYTES) }));
  assert.deepEqual(await client.forward(request({ method: 'POST', contentType: 'application/json', body: [large] })), { status: 413, body: { error: '请求内容过大' } });
  assert.deepEqual(await client.forward(request({ method: 'POST', contentType: 'text/plain', body: [Buffer.from('{}')] })), { status: 415, body: { error: '请求需使用 JSON' } });
});

test('socket: a forwarded write whose runtime vanishes is unconfirmed, while a missing runtime is plainly unavailable', { skip: windows }, async t => {
  let release = null; const fake = plane({ handle: () => new Promise(resolve => { release = resolve; }) });
  const { dir, server } = await serve(t, fake);
  const client = createSocketDataClient({ dir });
  const write = client.forward(request({ method: 'POST', contentType: 'application/json', body: [Buffer.from('{}')] }));
  await until(() => release);
  await server.close();
  await assert.rejects(write, error => error.status === 503 && error.uncertain && error.message === '结果未确认，请刷新后核对');
  await assert.rejects(client.forward(request({ method: 'POST', body: [] })), error => error.status === 503 && !error.uncertain && error.message === '运行时不可用');
  await assert.rejects(client.forward(request()), error => error.status === 503 && error.message === '运行时不可用');
  release({ status: 200, body: {} });
});

test('socket: a forwarded call is bounded by the deadline it carries', { skip: windows }, async t => {
  const { dir } = await serve(t, plane({ handle: () => new Promise(() => {}) }));
  const started = Date.now();
  await assert.rejects(createSocketDataClient({ dir }).forward(request({ deadline: Date.now() + 200 })), error => error.status === 503);
  assert.ok(Date.now() - started < 2000);
});

test('socket: the internal server checks forwarded requests and project notices again', { skip: windows }, async t => {
  const fake = plane();
  const { dir, server } = await serve(t, fake);
  const connection = createRuntimeConnection({ dir });
  const target = await connection.resolve(Date.now() + 5000);
  const send = (method, route, headers = {}, body = null) => connection.exchange(target, { method, route, headers, body, deadline: Date.now() + 5000 });
  assert.equal((await send('GET', '/internal/v1/forward/api/trading')).status, 400, 'no session');
  assert.equal((await send('GET', '/internal/v1/forward/internal/v1/status', { 'x-workspace-session': 's' })).status, 400, 'outside /api/');
  assert.equal((await send('GET', '/internal/v1/forward/api/trading', { 'x-workspace-session': 's', 'x-workspace-deadline': 'soon' })).status, 400);
  assert.equal((await send('POST', '/internal/v1/projects/asset/changed', { 'Content-Type': 'application/json' }, Buffer.from('{"reason":"renamed"}'))).status, 400);
  const json = { 'Content-Type': 'application/json' }, instanceId = '00000000-0000-4000-8000-000000000001';
  for (const stats of [{ instanceId: 'api', sequence: 1, activeConnections: 0, slowConsumerDisconnects: 0 }, { instanceId, sequence: 1, activeConnections: 10_001, slowConsumerDisconnects: 0 },
    { instanceId, sequence: 1, activeConnections: 0, slowConsumerDisconnects: -1 }, { instanceId, sequence: 0, activeConnections: 0, slowConsumerDisconnects: 0 }]) {
    assert.equal((await send('POST', '/internal/v1/api-stats', json, Buffer.from(JSON.stringify(stats)))).status, 400, JSON.stringify(stats));
  }
  assert.equal((await send('GET', '/internal/v1/overview/events?x=1')).status, 400);
  assert.equal((await send('POST', '/internal/v1/overview/events')).status, 405);
  // Only a GET may stand in for HEAD.
  assert.equal((await send('POST', '/internal/v1/forward/api/trading', { 'x-workspace-session': 's', 'x-workspace-method': 'HEAD' })).status, 400);
  assert.equal((await send('GET', '/internal/v1/forward/api/trading', { 'x-workspace-session': 's', 'x-workspace-method': 'DELETE' })).status, 400);
  assert.equal(forwarded(fake).length, 0); assert.equal(fake.calls.filter(([call]) => call === 'changed' || call === 'stats').length, 0);
  // A runtime without a data plane does not offer these routes.
  await server.close();
  const bare = await startInternalServer({ service: createRuntimeService({ readMaintenance: () => false }), dir, logger: quiet });
  t.after(() => bare.close());
  await assert.rejects(createSocketDataClient({ dir }).overview(), error => error.status === 404 && error.origin === 'runtime');
});

test('socket: overview events reconnect after the runtime is replaced and after a silent stream', { skip: windows }, async t => {
  const dir = await directory(t);
  const a = await serve(t, plane(), dir);
  const delivered = [];
  const client = createSocketDataClient({ dir, backoffMs: [20], idleMs: 300 });
  const stop = client.subscribeOverview({ wants: () => true, deliver: event => delivered.push(event.revision) });
  t.after(stop);
  await until(() => delivered.length === 1);
  await a.server.close();
  const second = plane({ overviewEvent: () => ({ revision: 100, overview: { projects: [], generatedAt } }) });
  await serve(t, second, dir);
  await until(() => delivered.includes(100));
  // The replacement goes quiet: the client gives up on the stream and opens a new one.
  await until(() => second.calls.filter(([call]) => call === 'subscribe').length >= 2);
  stop();
  await until(() => second.subscribers.size === 0);
});

test('socket: an events stream whose reader falls behind is dropped by the runtime', { skip: windows }, async t => {
  const fake = plane({ overview: () => ({ projects: [{ padding: 'x'.repeat(1024 * 1024) }], generatedAt }) });
  const { dir } = await serve(t, fake);
  const target = await createRuntimeConnection({ dir }).resolve(Date.now() + 5000);
  // A raw request that never reads its response.
  const req = http.request({ socketPath: target.socketPath, path: '/internal/v1/overview/events', headers: { 'x-workspace-runtime-key': target.secret } });
  req.on('response', res => res.pause()); req.on('error', () => {}); req.end();
  t.after(() => req.destroy());
  await until(() => fake.subscribers.size === 1);
  const [registered] = fake.subscribers;
  for (let index = 0; index < 64 && fake.subscribers.size; index += 1) { registered.deliver(fake.overviewEvent()); await new Promise(resolve => setImmediate(resolve)); }
  await until(() => fake.subscribers.size === 0, 5000);
});

test('socket: concurrent calls share one identity probe', { skip: windows }, async t => {
  const { dir, server } = await serve(t, plane());
  let probes = 0;
  server.server.prependListener('request', req => { if (req.url === '/internal/v1/status') probes += 1; });
  const client = createSocketDataClient({ dir });
  await Promise.all([client.overview(), client.overview(), client.projectChanged('asset', { reason: 'preferences' })]);
  assert.equal(probes, 1);
});

test('socket: an event the API refuses backs off instead of reconnecting at once, and keeps the shared record', { skip: windows }, async t => {
  const fake = plane({ overviewEvent: () => ({ revision: 1, overview: { projects: {}, generatedAt } }) });
  const { dir, server } = await serve(t, fake);
  let probes = 0;
  server.server.prependListener('request', req => { if (req.url === '/internal/v1/status') probes += 1; });
  const warnings = [];
  const client = createSocketDataClient({ dir, backoffMs: [20, 400], log: { warn: (fields, message) => warnings.push(message) } });
  const stop = client.subscribeOverview({ wants: () => true, deliver: () => assert.fail('an invalid event was delivered') });
  t.after(stop);
  const opened = () => fake.calls.filter(([call]) => call === 'subscribe').length;
  // The second stream follows after 20 ms; the third would wait the grown 400 ms.
  await until(() => opened() >= 2);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(opened(), 2);
  assert.equal(probes, 1);
  assert.equal(warnings[0], '概览推送处理失败');
});

test('socket: callers sharing an identity probe each keep their own deadline, and the probe has its own budget', { skip: windows }, async t => {
  const { dir, server } = await serve(t, plane());
  // Every internal request is answered 300 ms late.
  const [handler] = server.server.listeners('request');
  server.server.removeAllListeners('request');
  server.server.on('request', (req, res) => setTimeout(() => handler(req, res), 300));
  const connection = createRuntimeConnection({ dir });
  const started = Date.now();
  const short = connection.resolve(Date.now() + 50), long = connection.resolve(Date.now() + 5000);
  await assert.rejects(short, error => error.status === 503);
  assert.ok(Date.now() - started < 250, 'the short caller fails at its own deadline');
  assert.ok((await long).socketPath);
  await assert.rejects(createRuntimeConnection({ dir, probeMs: 100 }).resolve(Date.now() + 5000), error => error.status === 503);
});

test('socket: callers that give up before the shared probe fails leave no unhandled rejection', { skip: windows }, async t => {
  const rejections = [], record = reason => rejections.push(reason);
  process.on('unhandledRejection', record); t.after(() => process.off('unhandledRejection', record));
  const { dir, server } = await serve(t, plane());
  await assert.rejects(createRuntimeConnection({ dir: path.join(dir, 'missing') }).resolve(Date.now() - 1), error => error.status === 503);
  const [handler] = server.server.listeners('request');
  server.server.removeAllListeners('request');
  server.server.on('request', (req, res) => setTimeout(() => handler(req, res), 300));
  // The caller leaves at 20 ms; the probe fails on its own 100 ms budget afterwards.
  await assert.rejects(createRuntimeConnection({ dir, probeMs: 100 }).resolve(Date.now() + 20), error => error.status === 503);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(rejections, []);
});

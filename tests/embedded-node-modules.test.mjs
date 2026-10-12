import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../modules/crossex/server/app.mjs';
import { createPublicClients } from '../modules/crossex/server/clients.mjs';
import { createEmbeddedRequest, MONITOR_ORIGIN } from '../modules/crossex/server/embedded-request.mjs';
import { createModule as createMonitorModule } from '../server/modules/monitor.mjs';
import { createModule as createCrossExModule } from '../server/modules/crossex.mjs';
import { standardSummary } from '../server/adapters.mjs';

const secret = 'workspace-test-secret-with-enough-entropy';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pipe = () => process.platform === 'win32' ? `\\\\.\\pipe\\workspace-embedded-test-${randomUUID()}` : join(tmpdir(), `workspace-${randomUUID()}.sock`);
const listen = (server, socketPath) => new Promise((accept, reject) => { server.once('error', reject); server.listen(socketPath, accept); });
const close = server => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
function request(socketPath, path, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((accept, reject) => {
    const pending = http.request({ socketPath, path, method, headers: { Host: 'crossex.workspace.internal', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => accept({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    pending.once('error', reject); pending.end(body);
  });
}
async function directory(t, prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return path;
}
async function removeDirectory(path) {
  assert.ok(resolve(path).startsWith(resolve(tmpdir()) + '\\') || resolve(path).startsWith(resolve(tmpdir()) + '/'));
  await rm(path, { recursive: true, force: true });
}

test('embedded CrossEx authorization preserves saved login and enforces Origin/CSRF over a private pipe', async t => {
  const dataDir = await directory(t, 'embedded-crossex-');
  const standalone = createApp({ dataDir, initialPassword: 'existing-standalone-password', intervalMs: 0 });
  const password = standalone.store.get('password');
  await standalone.close();
  const app = createApp({ dataDir, intervalMs: 0, authorizeRequest: req => req.headers['x-workspace-key'] === secret });
  const socketPath = pipe(); await listen(app.server, socketPath);
  t.after(async () => { await app.close(); await removeDirectory(dataDir); });
  assert.equal(app.server.address(), socketPath);
  assert.equal(app.store.get('password'), password);
  assert.equal((await request(socketPath, '/api/bootstrap')).status, 401);
  const headers = { 'x-workspace-key': secret };
  const bootstrap = await request(socketPath, '/api/bootstrap', { headers });
  assert.equal(bootstrap.status, 200);
  const csrf = JSON.parse(bootstrap.body).csrfToken;
  const body = JSON.stringify({ config: { entryPaused: true } });
  const writes = { ...headers, Origin: 'http://crossex.workspace.internal', 'Content-Type': 'application/json', 'x-csrf-token': csrf };
  assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: { ...writes, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: { ...writes, 'x-csrf-token': '' } })).status, 403);
  assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: writes })).status, 200);
  assert.equal(app.store.get('password'), password);
  assert.equal((await request(socketPath, '/__workspace/update-status')).status, 401);
  assert.deepEqual(JSON.parse((await request(socketPath, '/__workspace/update-status', { headers })).body), { busy: false });
  app.store.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run('pending', 'execution', 'order-text', 1, 'UNKNOWN', Date.now(), JSON.stringify({ id: 'pending', status: 'UNKNOWN' }));
  assert.equal(JSON.parse((await request(socketPath, '/__workspace/update-status', { headers })).body).busy, true);
  app.store.prepare('UPDATE live_orders SET state=?,json=? WHERE id=?').run('FILLED', JSON.stringify({ id: 'pending', status: 'FILLED' }), 'pending');
  assert.deepEqual(app.live.updateStatus(), { busy: false });
  const control = { ...headers, 'Content-Type': 'application/json' };
  assert.equal((await request(socketPath, '/__workspace/maintenance', { method: 'POST', body: '{"active":true}', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await request(socketPath, '/__workspace/maintenance', { method: 'POST', body: '{"active":true}', headers: control })).status, 200);
  assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: writes })).status, 503);
  assert.equal((await request(socketPath, '/api/bootstrap', { headers })).status, 200);
  assert.equal((await request(socketPath, '/__workspace/maintenance', { method: 'POST', body: '{"active":false}', headers: control })).status, 200);
  assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: writes })).status, 200);
});

test('embedded CrossEx does not initialize a second login or print a password', async t => {
  const dataDir = await directory(t, 'embedded-crossex-new-'), logs = [];
  const app = createApp({ dataDir, intervalMs: 0, authorizeRequest: () => true, logger: value => logs.push(value) });
  t.after(async () => { await app.close(); await removeDirectory(dataDir); });
  assert.equal(app.store.get('password'), null);
  assert.deepEqual(logs, []);
});

test('CrossEx HTTP summaries satisfy the Hub protocol across offline, online, stale and failed reads', async t => {
  const dataDir = await directory(t, 'embedded-crossex-summary-');
  let now = Date.now();
  const client = {
    async getAccount() { return { user_id: '123', position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX' }; },
    async getPositions() { return []; }, async getOpenOrders() { return []; },
  };
  const app = createApp({ dataDir, intervalMs: 0, authorizeRequest: req => req.headers['x-workspace-key'] === secret,
    liveOptions: { clock: () => now, clientFactory: () => client } });
  const socketPath = pipe(); await listen(app.server, socketPath);
  t.after(async () => { await app.close(); await removeDirectory(dataDir); });
  const headers = { 'x-workspace-key': secret };
  async function readSummary(expected) {
    const response = await request(socketPath, '/api/hub/summary?schemaVersion=2', { headers });
    assert.equal(response.status, 200);
    const parsed = standardSummary(JSON.parse(response.body));
    assert.equal(parsed.state, expected);
    return parsed;
  }
  assert.equal((await readSummary('offline')).updatedAt, null);
  await app.live.connection({ apiKey: 'summary-fixture-key', apiSecret: 'summary-fixture-secret' });
  const online = await readSummary('online'); assert.ok(online.updatedAt);
  now += 16000;
  assert.equal((await readSummary('stale')).updatedAt, online.updatedAt);
  client.getOpenOrders = async () => { throw new Error('fixture orders unavailable'); };
  await app.live.refresh({ includeView: false });
  const failed = await readSummary('partial'); assert.match(failed.message, /同步未完成/);
  const legacy = await request(socketPath, '/api/hub/summary', { headers });
  assert.ok(standardSummary(JSON.parse(legacy.body)).metrics.length);
});

test('CrossEx adapter starts in the supplied maintenance state until the supervisor releases it', async t => {
  const temporary = await directory(t, 'embedded-crossex-maintenance-');
  const fixtureRoot = join(temporary, 'module');
  await mkdir(join(fixtureRoot, 'server'), { recursive: true });
  // Keep the real app and adapter while disabling only automatic external reads.
  await writeFile(join(fixtureRoot, 'server/app.mjs'), `import { createApp as actual } from ${JSON.stringify(pathToFileURL(join(root, 'modules/crossex/server/app.mjs')).href)}; export const createApp = options => actual({ ...options, intervalMs: 0 });`);
  await writeFile(join(fixtureRoot, 'server/clients.mjs'), `export { createPublicClients } from ${JSON.stringify(pathToFileURL(join(root, 'modules/crossex/server/clients.mjs')).href)};`);
  t.after(() => removeDirectory(temporary));
  for (const setting of ['1', '0', undefined]) {
    const app = await createCrossExModule({ root: fixtureRoot, dataDir: join(temporary, `data-${setting}`), secret,
      environment: { WORKSPACE_MAINTENANCE: setting }, transports: { monitor: { socketPath: pipe(), secret } } });
    try {
      const socketPath = pipe(); await listen(app.server, socketPath);
      const headers = { 'x-workspace-key': secret };
      const bootstrap = JSON.parse((await request(socketPath, '/api/bootstrap', { headers })).body);
      const writes = { ...headers, Origin: 'http://crossex.workspace.internal', 'Content-Type': 'application/json', 'x-csrf-token': bootstrap.csrfToken };
      const body = JSON.stringify({ config: { entryPaused: true } });
      assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: writes })).status, setting === '1' ? 503 : 200);
      assert.equal((await request(socketPath, '/__workspace/maintenance', { method: 'POST', body: '{"active":false}', headers: writes })).status, 200);
      assert.equal((await request(socketPath, '/api/settings', { method: 'PUT', body, headers: writes })).status, 200);
    } finally { await app.close(); }
  }
});

test('CrossEx Monitor reads use only the configured private pipe and keep old credentials off the wire', async t => {
  const socketPath = pipe(), seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.setHeader('Content-Type', 'application/json'); res.end('{"schemaVersion":2}'); });
  await listen(server, socketPath); t.after(() => close(server));
  const transport = { socketPath, secret }, clients = createPublicClients({ monitorTransport: transport });
  assert.deepEqual(await clients.loadFeed({ monitorUrl: 'http://127.0.0.1:3000', monitorUsername: 'old-admin' }, 'old-private-password'), { schemaVersion: 2 });
  assert.equal(server.address(), socketPath);
  assert.equal(seen[0].url, '/api/monitors/perpetual/opportunities-v2');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].headers.host, 'monitor.workspace.internal');
  assert.equal(seen[0].headers['x-workspace-key'], secret);
  assert.equal(seen[0].headers.authorization, undefined);
  const internal = createEmbeddedRequest(transport);
  await assert.rejects(internal('http://external.example/api'), /Unsupported/);
  await assert.rejects(internal(`${MONITOR_ORIGIN}/api`, { method: 'POST' }), /Unsupported/);
});

test('private Monitor request rejects redirects and honors the existing deadline', async t => {
  const socketPath = pipe(); let hang = false;
  const server = http.createServer((_req, res) => { if (hang) return; res.writeHead(302, { Location: 'https://external.example' }); res.end(); });
  await listen(server, socketPath); t.after(() => close(server));
  const client = createPublicClients({ monitorTransport: { socketPath, secret }, timeoutMs: 50 });
  await assert.rejects(client.loadFeed({}), /302/);
  hang = true;
  await assert.rejects(client.loadFeed({}), { name: 'AbortError' });
});

test('Monitor factory serves built SSR without a TCP listener and releases its real data locks', { skip: process.platform === 'linux' ? 'Kernel flock is covered by the Linux supervisor integration' : false }, async t => {
  const dataDir = await directory(t, 'embedded-monitor-');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'monitor-control.json'), JSON.stringify({ version: 1, monitors: Object.fromEntries(['cl-xau', 'hynix', 'oil', 'perpetual'].map(id => [id, { enabled: false, revision: 0 }])) }));
  const options = { root: join(root, 'modules/monitor'), dataDir, secret };
  const module = await createMonitorModule(options);
  t.after(async () => { await module.close(); await removeDirectory(dataDir); });
  assert.equal(module.server.listening, false);
  assert.ok((await stat(join(dataDir, 'oil/monitor.lock'))).isFile());
  await assert.rejects(createMonitorModule(options), /锁定/);
  const socketPath = pipe(); await listen(module.server, socketPath);
  assert.equal(module.server.address(), socketPath);
  assert.equal((await request(socketPath, '/')).status, 401);
  const response = await request(socketPath, '/', { headers: { 'x-workspace-key': secret } });
  assert.equal(response.status, 200);
  assert.match(response.body, /<!doctype html>/i);
  assert.match(response.body, /assets\/index-/);
  await module.close();
  await assert.rejects(stat(join(dataDir, 'oil/monitor.lock')), { code: 'ENOENT' });
  const reopened = await createMonitorModule(options); await reopened.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, fork } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { slotOptions, startApi } from '../server/api/main.mjs';
import { unavailableUpdateState } from '../server/updates.mjs';
import { openHubDatabase, seedComplete, seedProjects } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { acceptProxyHeader, clientAddress, encodeProxyHeader, localPortOf, parseProxyLine, readSlotRecord, recordNames, slotSockets } from '../server/slot-protocol.mjs';

// The API side of the dual-slot units (design doc api-dual-slot 3.2–3.4): the
// PROXY header, the slot record, and a candidate slot promoted beside a
// serving one over their private sockets. POSIX only, like process-split.
const skip = process.platform === 'win32' ? 'POSIX sockets only' : false;
const password = 'api-slot-test-password';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const proxy = { remoteAddress: '203.0.113.7', remotePort: 51000, localAddress: '127.0.0.1', localPort: 3100 };

test('PROXY v1 lines parse only with a valid family, addresses and ports', () => {
  assert.deepEqual(parseProxyLine('PROXY TCP4 203.0.113.7 127.0.0.1 51000 3100'), proxy);
  assert.deepEqual(parseProxyLine('PROXY TCP6 2001:db8::1 ::1 1 65535'), { remoteAddress: '2001:db8::1', localAddress: '::1', remotePort: 1, localPort: 65535 });
  for (const line of ['PROXY TCP4 ::1 127.0.0.1 1 2', 'PROXY TCP6 1.2.3.4 ::1 1 2', 'PROXY TCP4 1.2.3.4 1.2.3.4 1 65536', 'PROXY UNKNOWN', 'PROXY TCP4 1.2.3.4 1.2.3.4 1 2 ', 'GET / HTTP/1.1'])
    assert.equal(parseProxyLine(line), null, line);
  assert.equal(encodeProxyHeader(proxy), 'PROXY TCP4 203.0.113.7 127.0.0.1 51000 3100\r\n');
  assert.match(encodeProxyHeader({ ...proxy, remoteAddress: '::ffff:203.0.113.7', localAddress: '::1' }), /^PROXY TCP6 /);
  assert.throws(() => encodeProxyHeader({ ...proxy, remoteAddress: 'example.com' }), TypeError);
});

// An HTTP server behind acceptProxyHeader() on a UNIX socket, answering with the addresses it saw.
async function proxied(t, options) {
  const dir = await mkdtemp('/tmp/slot-proxy-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 's.sock'), rejected = [];
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: req.url, client: clientAddress(req), port: localPortOf(req) })); });
  server.on('upgrade', (_req, socket, head) => { socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n${head}`); });
  acceptProxyHeader(server, { onReject: reason => rejected.push(reason), ...options });
  await new Promise(resolve => server.listen(file, resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  // Writes the chunks in turn, then collects everything until the server ends the connection.
  const exchange = (...chunks) => new Promise((resolve, reject) => {
    const socket = net.connect(file); let data = '';
    socket.on('data', chunk => { data += chunk; }); socket.on('error', reject); socket.on('close', () => resolve(data));
    socket.once('connect', async () => { for (const chunk of chunks) { socket.write(chunk); await new Promise(next => setTimeout(next, 20)); } });
  });
  return { file, exchange, rejected };
}
const bodies = text => [...text.matchAll(/\r\n\r\n(\{[^}]*\})/g)].map(match => JSON.parse(match[1]));

test('a private connection takes its addresses from the PROXY line, whether split, pipelined or upgraded', { skip }, async t => {
  const { file, exchange, rejected } = await proxied(t);
  const header = encodeProxyHeader(proxy);
  const get = (url, close) => `GET ${url} HTTP/1.1\r\nHost: hub.localhost:3100${close ? '\r\nConnection: close' : ''}\r\n\r\n`;
  assert.deepEqual(bodies(await exchange(header + get('/one') + get('/two', true))), [{ url: '/one', client: proxy.remoteAddress, port: 3100 }, { url: '/two', client: proxy.remoteAddress, port: 3100 }]);
  assert.deepEqual(bodies(await exchange(header.slice(0, 9), header.slice(9) + get('/split').slice(0, 7), get('/split', true).slice(7))), [{ url: '/split', client: proxy.remoteAddress, port: 3100 }]);
  const upgraded = new Promise((resolve, reject) => {
    const socket = net.connect(file); socket.on('error', reject);
    let data = ''; socket.on('data', chunk => { data += chunk; if (data.includes('head-bytes')) { socket.destroy(); resolve(data); } });
    socket.write(`${header}GET /ws HTTP/1.1\r\nHost: hub.localhost:3100\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nhead-bytes`);
  });
  assert.match(await upgraded, /^HTTP\/1\.1 101[\s\S]*head-bytes$/);
  assert.deepEqual(rejected, []);
});

test('a private connection without a valid PROXY line is closed unanswered', { skip }, async t => {
  const { exchange, rejected } = await proxied(t, { timeoutMs: 200 });
  assert.equal(await exchange('GET / HTTP/1.1\r\nHost: hub.localhost\r\n\r\n'), '');
  assert.equal(await exchange(`PROXY TCP4 ${'1'.repeat(120)}`), '');
  assert.equal(await exchange('PROXY TCP4 1.2.3.4'), '');
  assert.deepEqual(rejected, ['malformed', 'too-long', 'timeout']);
});

test('a slot record names a slot only with its own release directory', { skip }, async t => {
  const dir = await mkdtemp('/tmp/slot-record-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, 'r1'), link = path.join(dir, 'current'), file = path.join(dir, '.api-slot');
  mkdirSync(release); symlinkSync(release, link);
  assert.equal(readSlotRecord(file), null);
  for (const value of ['{', '{"slot":"c","release":"/x"}', '{"slot":"a","release":"relative"}']) { writeFileSync(file, value); assert.equal(readSlotRecord(file), null, value); }
  writeFileSync(file, JSON.stringify({ slot: 'a', release: link }));
  assert.equal(recordNames(readSlotRecord(file), { slot: 'a', release: realpathSync(release) }), true);
  assert.equal(recordNames(readSlotRecord(file), { slot: 'b', release: realpathSync(release) }), false);
  assert.equal(recordNames(readSlotRecord(file), { slot: 'a', release: path.join(dir, 'r2') }), false);
  assert.throws(() => readSlotRecord(dir), { code: 'EISDIR' }, 'an unreadable record is not a missing one');
  writeFileSync(file, JSON.stringify({ slot: 'a', release: path.join(dir, 'gone') }));
  assert.equal(recordNames(readSlotRecord(file), { slot: 'a', release: realpathSync(release) }), false);

  assert.equal(slotOptions({}), null);
  assert.throws(() => slotOptions({ WORKBENCH_API_SLOT: 'c', WORKBENCH_API_SLOT_DIR: dir, WORKBENCH_API_SLOT_RECORD: file }), /a 或 b/);
  assert.throws(() => slotOptions({ WORKBENCH_API_SLOT: 'a', WORKBENCH_API_SLOT_DIR: 'run', WORKBENCH_API_SLOT_RECORD: file }), /绝对路径/);
  assert.throws(() => slotOptions({ WORKBENCH_API_SLOT: 'a', WORKBENCH_API_SLOT_DIR: dir }), /绝对路径/);
  assert.deepEqual(slotOptions({ WORKBENCH_API_SLOT: 'b', WORKBENCH_API_SLOT_DIR: dir, WORKBENCH_API_SLOT_RECORD: file }, '/r'), { slot: 'b', dir, record: file, release: '/r' });
});

// Requests over a slot socket, each connection opened with the entry's PROXY line.
function slotClient(file, session = {}) {
  const host = 'hub.localhost:3100';
  function request(route, { method = 'GET', body, host: target = host, headers = {}, auth = true, header = encodeProxyHeader(proxy) } = {}) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ method, path: route,
        createConnection: () => { const socket = net.connect(file); if (header) socket.write(header); return socket; },
        headers: { Host: target, Origin: `http://${target}`, ...(auth && session.cookie ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => { const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch { data = null; } resolve({ status: res.statusCode, headers: res.headers, text, data }); });
      }); req.on('error', reject); req.end(encoded);
    });
  }
  return { session, request,
    async login() {
      const result = await request('/api/login', { method: 'POST', body: { password } }); assert.equal(result.status, 200, result.text);
      session.cookie = result.headers['set-cookie'][0].split(';')[0]; session.csrf = result.data.csrfToken;
    },
    async launch(id) {
      const result = await request(`/api/projects/${id}/launch`, { method: 'POST' }); assert.equal(result.status, 200, result.text);
      const url = new URL(result.data.url);
      const authorized = await request(url.pathname + url.search, { host: url.host, auth: false, headers: { Origin: `http://${host}` } });
      assert.equal(authorized.status, 302, authorized.text);
      return { host: url.host, cookie: authorized.headers['set-cookie'][0].split(';')[0] };
    } };
}
// The control socket carries no PROXY line.
const control = (file, method, route) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath: file, method, path: route, agent: false }, res => {
    let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
  }); req.on('error', reject); req.end();
});

async function runtimeFixture(t) {
  const dataDir = await mkdtemp('/tmp/slot-'); t.after(() => rm(dataDir, { recursive: true, force: true }));
  mkdirSync(path.join(dataDir, 'modules'), { mode: 0o700 });
  const { WORKBENCH_RUNTIME_DIR: _ignored, WORKBENCH_API_SLOT: _slot, ...inherited } = process.env;
  const env = { ...inherited, DATA_DIR: dataDir, INITIAL_PASSWORD: password, MODULE_SOCKET_DIR: path.join(dataDir, 'modules'), NODE_ENV: 'test' };
  const child = fork(fileURLToPath(new URL('./fixtures/split-runtime.mjs', import.meta.url)), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime not ready: ${stderr}`)), 30_000);
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(); } });
    exited.then(() => reject(new Error(`runtime exited: ${stderr}`)));
  });
  return { dataDir, env };
}

test('a candidate slot answers only the probe reads without writing, and serves once the record names it', { skip, timeout: 90_000 }, async t => {
  const { dataDir, env } = await runtimeFixture(t);
  const record = path.join(dataDir, '.api-slot'), releases = {}, slots = {};
  for (const name of ['a', 'b']) {
    releases[name] = path.join(dataDir, `release-${name}`); mkdirSync(releases[name]);
    const dir = path.join(dataDir, `slot-${name}`); mkdirSync(dir, { mode: 0o700 });
    slots[name] = { slot: name, dir, record, release: realpathSync(releases[name]) };
  }
  const start = (name, failures = []) => startApi({ dataDir, logger: quiet, env, distDir: path.join(dataDir, 'dist'), slot: slots[name], fail: error => failures.push(error),
    updatesClient: { status: async () => unavailableUpdateState() } });
  const sockets = { a: slotSockets(slots.a.dir), b: slotSockets(slots.b.dir) };

  // A slot the record names starts serving.
  writeFileSync(record, JSON.stringify({ slot: 'a', release: releases.a }));
  const failures = [], a = await start('a', failures);
  t.after(() => a.close());
  assert.deepEqual(a.ready, { slot: 'a', mode: 'serving' });
  assert.ok(existsSync(sockets.a.http));
  const served = slotClient(sockets.a.http);
  await served.login();
  const crossex = await served.launch('crossex');
  const probeA = slotClient(sockets.a.probe, served.session);
  assert.equal((await probeA.request('/api/health')).status, 200);
  assert.equal((await probeA.request('/api/session')).data.authenticated, true);
  const write = await probeA.request('/api/logout', { method: 'POST' });
  assert.equal(write.status, 405, write.text);
  assert.equal((await probeA.request('/api/session')).data.authenticated, true, 'the probe did not log out');
  assert.equal((await probeA.request('/', { host: crossex.host, auth: false, headers: { Cookie: crossex.cookie, Connection: 'Upgrade', Upgrade: 'websocket' } })).status, 404, 'no upgrades on the probe');
  const identityA = await control(sockets.a.ctl, 'GET', '/identity');
  assert.equal(identityA.status, 200);
  assert.deepEqual({ ...identityA.data, instanceId: typeof identityA.data.instanceId, pid: typeof identityA.data.pid },
    { protocol: 1, slot: 'a', instanceId: 'string', pid: 'number', release: slots.a.release, mode: 'serving' });

  // The other slot starts as a candidate beside it: no traffic socket, no writes.
  const database = new DatabaseSync(path.join(dataDir, 'hub.sqlite'), { readOnly: true });
  t.after(() => database.close());
  // Every table, rows and all: sessions, login checks, Portal tickets and grants, settings.
  const settings = () => database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
  const before = settings();
  const bFailures = [], b = await start('b', bFailures);
  t.after(() => b.close());
  assert.deepEqual(b.ready, { slot: 'b', mode: 'candidate' });
  assert.equal(existsSync(sockets.b.http), false);
  assert.ok(existsSync(sockets.b.probe) && existsSync(sockets.b.ctl));
  const probeB = slotClient(sockets.b.probe, served.session);
  assert.equal((await probeB.request('/api/health')).status, 200);
  assert.equal((await probeB.request('/api/ready')).status, 200);
  assert.equal((await probeB.request('/api/session')).data.authenticated, true);
  for (const [route, method] of [['/api/projects', 'GET'], ['/api/system/updates', 'GET'], ['/api/logout', 'POST'], ['/api/login', 'POST'], ['/api/projects/crossex/launch', 'POST']]) {
    const reply = await probeB.request(route, { method, body: method === 'POST' ? { password } : undefined });
    assert.equal(reply.status, 503, `${method} ${route}: ${reply.text}`); assert.equal(reply.data.error, '候选实例尚未接管服务');
  }
  // Portal: no grant is still refused as such; a valid grant is not consumed by a candidate.
  assert.equal((await probeB.request('/', { host: crossex.host, auth: false })).status, 401);
  assert.equal((await probeB.request('/', { host: crossex.host, auth: false, headers: { Cookie: crossex.cookie } })).status, 503);
  await assert.rejects(probeB.request('/api/health', { header: '' }), { code: 'ECONNRESET' }, 'no PROXY line, no answer');
  assert.deepEqual(settings(), before);
  assert.equal((await control(sockets.b.ctl, 'GET', '/identity')).data.mode, 'candidate');
  assert.equal((await control(sockets.b.ctl, 'GET', '/other')).status, 404);

  // Promotion follows the record only.
  const refused = await control(sockets.b.ctl, 'POST', '/promote');
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(existsSync(sockets.b.http), false);
  writeFileSync(record, JSON.stringify({ slot: 'b', release: releases.b }));
  const [promoted, again] = await Promise.all([control(sockets.b.ctl, 'POST', '/promote'), control(sockets.b.ctl, 'POST', '/promote')]);
  assert.equal(promoted.status, 200); assert.equal(promoted.data.mode, 'serving'); assert.equal(again.status, 200);
  assert.ok(existsSync(sockets.b.http));
  // The PROXY line's local port passes Portal's port check; the session and grant carry over.
  const next = slotClient(sockets.b.http, served.session);
  assert.equal((await next.request('/api/projects')).status, 200);
  assert.equal((await next.request('/', { host: crossex.host, auth: false, headers: { Cookie: crossex.cookie } })).status, 200);
  await next.launch('crossex');
  const wrongPort = await next.request('/', { host: crossex.host, auth: false, headers: { Cookie: crossex.cookie }, header: encodeProxyHeader({ ...proxy, localPort: 3200 }) });
  assert.equal(wrongPort.status, 421, wrongPort.text);
  assert.equal((await slotClient(sockets.b.probe).request('/api/logout', { method: 'POST' })).status, 405);
  assert.equal((await control(sockets.b.ctl, 'POST', '/promote')).status, 200);

  // A kept-alive connection on the traffic socket does not hold up the drain.
  const idle = net.connect(sockets.b.http), answered = new Promise(resolve => idle.once('data', resolve)), ended = new Promise(resolve => idle.once('close', resolve));
  idle.write(`${encodeProxyHeader(proxy)}GET /api/health HTTP/1.1\r\nHost: hub.localhost:3100\r\n\r\n`); await answered;
  const closing = Date.now(), closed = b.close(); await ended;
  assert.ok(Date.now() - closing < 15_000, 'the idle connection did not wait for the drain deadline');
  await closed;
  assert.equal(existsSync(sockets.b.http) || existsSync(sockets.b.probe) || existsSync(sockets.b.ctl), false);
  await a.close();
  assert.deepEqual([...failures, ...bFailures], []);
});

test('a query-only hub database must have every table and column, and the seeds must be complete', { skip }, async t => {
  const dir = await mkdtemp('/tmp/slot-db-'); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hub.sqlite');
  assert.throws(() => openHubDatabase(file, { create: false }), /尚未创建/);
  const created = openHubDatabase(file), store = createControlStore(created);
  assert.equal(seedComplete(store, { embeddedModules: true }), false);
  seedProjects(store, { embeddedModules: true });
  assert.equal(seedComplete(store, { embeddedModules: true }), true);
  created.close();
  const readOnly = openHubDatabase(file, { create: false });
  assert.equal(seedComplete(createControlStore(readOnly), { embeddedModules: true }), true);
  assert.throws(() => readOnly.exec("UPDATE settings SET value='x' WHERE key='seeded'"), /readonly|read-only/i);
  readOnly.close();
  const raw = new DatabaseSync(file);
  raw.exec("DELETE FROM settings WHERE key='seeded-crossex-v1'");
  const missing = openHubDatabase(file, { create: false });
  assert.equal(seedComplete(createControlStore(missing), { embeddedModules: true }), false);
  missing.close();
  const [table] = raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='settings'").all();
  assert.ok(table);
  raw.exec('ALTER TABLE settings RENAME TO settings_old; CREATE TABLE settings(key TEXT PRIMARY KEY)');
  assert.throws(() => openHubDatabase(file, { create: false }), /缺少 settings\.value/);
  raw.exec('DROP TABLE settings; ALTER TABLE settings_old RENAME TO settings; PRAGMA journal_mode=DELETE');
  raw.close();
  assert.throws(() => openHubDatabase(file, { create: false }), /WAL/);
});

test('a slot refuses an open directory or a socket in use, replaces a stale one, and ends when promotion fails', { skip, timeout: 90_000 }, async t => {
  const { dataDir, env } = await runtimeFixture(t);
  const record = path.join(dataDir, '.api-slot'), release = path.join(dataDir, 'release'); mkdirSync(release);
  const options = name => ({ slot: name, dir: path.join(dataDir, `slot-${name}`), record, release: realpathSync(release) });
  const start = (name, failures = []) => startApi({ dataDir, logger: quiet, env, distDir: path.join(dataDir, 'dist'), slot: options(name), fail: error => failures.push(error),
    updatesClient: { status: async () => unavailableUpdateState() } });
  // A candidate before any serving slot seeded the runtime's database refuses to start.
  mkdirSync(options('b').dir, { mode: 0o700 });
  await assert.rejects(start('b'), /管理员密码或项目种子尚未初始化/);
  writeFileSync(record, JSON.stringify({ slot: 'a', release }));
  mkdirSync(options('a').dir, { mode: 0o700 });
  const a = await start('a'); t.after(() => a.close());

  const sockets = slotSockets(options('b').dir);
  chmodSync(options('b').dir, 0o750);
  await assert.rejects(start('b'), /0700/);
  chmodSync(options('b').dir, 0o700);
  // A socket nobody listens on is stale; one that answers is another process's.
  execFileSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', sockets.probe]);
  execFileSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', sockets.http]);
  const other = net.createServer(); await new Promise(resolve => other.listen(sockets.ctl, resolve));
  await assert.rejects(start('b'), { code: 'EADDRINUSE', message: /正被另一个进程使用/ });
  await new Promise(resolve => other.close(resolve));
  if (!existsSync(sockets.http)) execFileSync('python3', ['-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', sockets.http]);
  const failures = [], b = await start('b', failures); t.after(() => b.close());
  assert.equal(b.ready.mode, 'candidate');
  assert.equal(existsSync(sockets.http), false, 'the stale traffic socket is gone');
  for (const file of [sockets.probe, sockets.ctl]) assert.equal(statSync(file).mode & 0o777, 0o600, file);

  // Something that is not a socket stays where http.sock goes: promotion fails and the process ends.
  writeFileSync(sockets.http, 'not a socket');
  writeFileSync(record, JSON.stringify({ slot: 'b', release }));
  const failed = await control(sockets.ctl, 'POST', '/promote');
  assert.equal(failed.status, 500, JSON.stringify(failed.data));
  assert.equal(failures.length, 1);
  assert.equal((await control(sockets.ctl, 'GET', '/identity')).data.mode, 'candidate');
  assert.equal((await control(sockets.ctl, 'POST', '/promote')).status, 503);
  assert.equal(existsSync(sockets.http) && statSync(sockets.http).isFile(), true, 'the file was not removed');
});

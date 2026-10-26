import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { entryOptions, startEntry } from '../server/entry/main.mjs';
import { acceptProxyHeader, clientAddress, controlRequest, entrySockets, localPortOf, slotDirectory, slotSockets } from '../server/slot-protocol.mjs';

// The stable entry (design doc api-dual-slot 3.2, 3.7) in front of fake slots:
// each slot is a control socket answering identity and a traffic socket.
// POSIX only, like the slots themselves.
const skip = process.platform === 'win32' ? 'POSIX sockets only' : false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function recorder() {
  const warnings = [];
  return { warnings, logger: { info() {}, debug() {}, error() {}, warn: (fields, message) => warnings.push({ ...fields, message }) } };
}

async function fixture(t) {
  const root = await mkdtemp('/tmp/entry-'); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'entry'); mkdirSync(dir, { mode: 0o700 });
  const releases = {};
  for (const slot of ['a', 'b']) { mkdirSync(slotDirectory(root, slot), { mode: 0o700 }); releases[slot] = path.join(root, `release-${slot}`); mkdirSync(releases[slot]); }
  const record = path.join(root, '.api-slot');
  const writeRecord = slot => writeFileSync(record, JSON.stringify({ slot, release: releases[slot] }));
  const { logger, warnings } = recorder();
  const start = async (options = {}) => {
    const entry = await startEntry({ host: '127.0.0.1', port: 0, dir, record, slotRoot: root, logger, retryMs: 50, budgetMs: 2000, closeGraceMs: 500, ...options });
    t.after(() => entry.close());
    return entry;
  };
  // The fake slots' own connections, upgraded ones included, end with the test.
  const listening = [], open = new Set();
  t.after(() => { for (const socket of open) socket.destroy(); return Promise.all(listening.map(server => new Promise(resolve => server.close(() => resolve())))); });
  const listen = async (server, file) => {
    server.on('connection', socket => { open.add(socket); socket.once('close', () => open.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); }); listening.push(server); return server;
  };
  // A slot's control socket; identity can be changed in place.
  async function control(slot, overrides = {}) {
    const identity = { protocol: 1, slot, instanceId: `instance-${slot}`, pid: 1, release: realpathSync(releases[slot]), mode: 'serving', ...overrides };
    await listen(http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(identity)); }), slotSockets(slotDirectory(root, slot)).ctl);
    return identity;
  }
  // A traffic socket echoing every byte, the entry's PROXY line included,
  // that answers `bye` and ends only after the client's FIN.
  async function echo(slot) {
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      socket.on('data', chunk => socket.write(chunk));
      socket.on('end', () => setTimeout(() => socket.end('bye'), 30));
      socket.on('error', () => {});
    });
    return listen(server, slotSockets(slotDirectory(root, slot)).http);
  }
  return { root, dir, record, writeRecord, warnings, start, control, echo, listen, open };
}

// A TCP client: writes, optionally half-closes, and collects what comes back
// until the entry closes it (a reset included: unread bytes make a close one).
function connect(port) {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  let data = '';
  socket.on('data', chunk => { data += chunk; });
  socket.on('error', () => {});
  // Half-open only in the client's own direction: the entry's FIN ends it too.
  socket.on('end', () => socket.end());
  const closed = new Promise(resolve => socket.on('close', () => resolve(data)));
  const until = text => new Promise((resolve, reject) => {
    const check = () => { if (data.includes(text)) { socket.off('data', check); resolve(data); } };
    socket.on('data', check); check(); closed.then(() => reject(new Error(`closed before ${JSON.stringify(text)}: ${JSON.stringify(data)}`)));
  });
  const ready = new Promise(resolve => socket.once('connect', resolve));
  return { socket, closed, until, ready };
}

test('the entry needs absolute paths and a valid port', () => {
  const env = { WORKBENCH_ENTRY_DIR: '/run/e', WORKBENCH_API_SLOT_RECORD: '/opt/app/.api-slot', WORKBENCH_ENTRY_SLOT_ROOT: '/run' };
  assert.deepEqual(entryOptions({ ...env, HOST: '0.0.0.0', PORT: '3200' }), { host: '0.0.0.0', port: 3200, dir: '/run/e', record: '/opt/app/.api-slot', slotRoot: '/run' });
  assert.equal(entryOptions(env).port, 3100);
  assert.throws(() => entryOptions({ ...env, PORT: '70000' }), /PORT/);
  assert.throws(() => entryOptions({ ...env, WORKBENCH_ENTRY_SLOT_ROOT: 'run' }), /绝对路径/);
  assert.throws(() => entryOptions({ WORKBENCH_ENTRY_DIR: '/run/e' }), /绝对路径/);
  assert.equal(slotDirectory('/run', 'b'), '/run/project-aggregation-api-b');
});

test('a connection reaches the recorded slot after a PROXY line with its addresses, and half-closes', { skip }, async t => {
  const f = await fixture(t);
  f.writeRecord('a'); await f.echo('a');
  const entry = await f.start();
  assert.equal(entry.ready.target, 'a');
  const client = connect(entry.ready.port); await client.ready;
  const clientPort = client.socket.localPort;
  client.socket.write('hello');
  await client.until('hello');
  // The client's FIN goes through, and the slot's answer after it still comes back.
  client.socket.end();
  const received = await client.closed;
  assert.equal(received, `PROXY TCP4 127.0.0.1 127.0.0.1 ${clientPort} ${entry.ready.port}\r\nhellobye`);
  assert.equal(entry.status().connections.a, 0);
  // A client that never sends its FIN is closed once the slot has ended its side.
  const lingering = connect(entry.ready.port); await lingering.ready;
  lingering.socket.removeAllListeners('end');
  lingering.socket.write('end-me'); await lingering.until('end-me');
  const [server] = [...f.open].filter(socket => !socket.destroyed);
  const ended = new Promise(resolve => lingering.socket.once('end', resolve));
  server.end();
  await ended;
  // The entry let go of both sides without waiting for the client's FIN.
  await wait(50);
  assert.equal(entry.status().connections.a, 0);
  lingering.socket.destroy();
});

test('a connection waits for its slot within the budget, and is closed when the slot stays away', { skip }, async t => {
  const f = await fixture(t);
  f.writeRecord('a');
  const entry = await f.start({ budgetMs: 600 });
  // Nothing is listening: the connection waits, then gives up without an answer.
  const lost = connect(entry.ready.port); await lost.ready;
  lost.socket.write('early');
  const began = Date.now();
  assert.equal(await lost.closed, '');
  assert.ok(Date.now() - began >= 400, 'the budget was spent before giving up');
  assert.equal(f.warnings.filter(item => item.message.includes('重试预算')).length, 1);
  // The slot comes up while a connection waits; its early bytes were kept.
  const late = connect(entry.ready.port); await late.ready;
  late.socket.write('kept');
  await wait(200);
  assert.equal(entry.status().waiting, 1);
  await f.echo('a');
  await late.until('kept');
  late.socket.end(); assert.match(await late.closed, /^PROXY TCP4 [^\r]+\r\nkeptbye$/);
});

test('without a valid record the entry forwards nothing, and follows a record written later', { skip }, async t => {
  const f = await fixture(t);
  await f.echo('b');
  const entry = await f.start();
  assert.equal(entry.ready.target, null);
  const refused = connect(entry.ready.port);
  assert.equal(await refused.closed, '');
  assert.ok(f.warnings.some(item => item.message.includes('槽记录不存在或无效')));
  f.writeRecord('b');
  const client = connect(entry.ready.port); await client.ready;
  client.socket.end('x');
  assert.match(await client.closed, /\r\nxbye$/);
  assert.deepEqual({ target: entry.status().target, generation: entry.status().generation }, { target: 'b', generation: 0 });
});

test('a switch needs the record and the slot serving as the expected instance, and moves only new connections', { skip }, async t => {
  const f = await fixture(t);
  f.writeRecord('a'); await f.echo('a'); await f.control('a');
  const identity = await f.control('b', { mode: 'candidate' });
  // Slot b's traffic socket is an HTTP server behind the PROXY line, with upgrades.
  const web = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ slot: 'b', client: clientAddress(req), port: localPortOf(req) })); });
  web.on('upgrade', (_req, socket, head) => { socket.on('data', chunk => socket.write(chunk)); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n${head}`); });
  acceptProxyHeader(web);
  await f.listen(web, slotSockets(slotDirectory(f.root, 'b')).http);
  const entry = await f.start();
  const ctl = entrySockets(f.dir).ctl;
  const switchTo = body => controlRequest(ctl, 'POST', '/switch', { body });

  // A long-lived connection on slot a.
  const kept = connect(entry.ready.port); await kept.ready;
  kept.socket.write('one'); await kept.until('one');
  assert.deepEqual((await controlRequest(ctl, 'GET', '/status')).data.connections, { a: 1, b: 0 });

  assert.equal((await switchTo({ slot: 'b' })).status, 400);
  assert.equal((await switchTo({ slot: 'b', instanceId: identity.instanceId })).status, 409, 'the record still names a');
  f.writeRecord('b');
  assert.equal((await switchTo({ slot: 'b', instanceId: identity.instanceId })).status, 409, 'b is a candidate');
  identity.mode = 'serving';
  assert.equal((await switchTo({ slot: 'b', instanceId: 'another' })).status, 409, 'another instance');
  identity.release = '/elsewhere';
  assert.equal((await switchTo({ slot: 'b', instanceId: identity.instanceId })).status, 409, 'another release');
  identity.release = realpathSync(path.join(f.root, 'release-b'));
  const [done, again] = await Promise.all([switchTo({ slot: 'b', instanceId: identity.instanceId }), switchTo({ slot: 'b', instanceId: identity.instanceId })]);
  assert.deepEqual([done.status, done.data, again.data], [200, { target: 'b', generation: 1 }, { target: 'b', generation: 1 }]);

  // New connections go to b, with the client's address and the public port; upgrades pass through.
  const reply = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: entry.ready.port, path: '/', agent: false }, res => {
    let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
  }).on('error', reject));
  assert.deepEqual(reply, { slot: 'b', client: '127.0.0.1', port: entry.ready.port });
  const upgraded = connect(entry.ready.port); await upgraded.ready;
  upgraded.socket.write('GET /ws HTTP/1.1\r\nHost: hub.localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nhead');
  await upgraded.until('head');
  upgraded.socket.write('-ping'); await upgraded.until('head-ping');
  // The connection accepted before the switch stays on a.
  kept.socket.write('two'); await kept.until('onetwo');
  const counts = (await controlRequest(ctl, 'GET', '/status')).data;
  assert.deepEqual({ target: counts.target, generation: counts.generation, connections: counts.connections }, { target: 'b', generation: 1, connections: { a: 1, b: 1 } });
  upgraded.socket.destroy(); kept.socket.end(); await kept.closed;

  // A slot whose control socket does not answer cannot be switched to.
  f.writeRecord('a');
  await rm(slotSockets(slotDirectory(f.root, 'a')).ctl);
  assert.equal((await switchTo({ slot: 'a', instanceId: 'instance-a' })).status, 503);
  assert.equal((await controlRequest(ctl, 'GET', '/other')).status, 404);
});

test('closing the entry stops listening and ends waiting and forwarded connections', { skip }, async t => {
  const f = await fixture(t);
  f.writeRecord('a');
  const slot = await f.echo('a');
  const entry = await f.start({ budgetMs: 30_000, closeGraceMs: 200 });
  const forwarded = connect(entry.ready.port); await forwarded.ready;
  forwarded.socket.write('x'); await forwarded.until('x');
  // The slot stops accepting; its open connection stays, a new one waits.
  await new Promise(resolve => { slot.close(); setImmediate(resolve); });
  const waiting = connect(entry.ready.port); await waiting.ready;
  await wait(100);
  assert.deepEqual([entry.status().connections.a, entry.status().waiting], [1, 1]);
  const began = Date.now();
  await entry.close();
  assert.equal(await waiting.closed, '');
  assert.match(await forwarded.closed, /\r\nx$/);
  assert.ok(Date.now() - began >= 150, 'the forwarded connection had its grace');
  assert.ok(f.warnings.some(item => item.message.includes('强制断开')));
  await assert.rejects(new Promise((resolve, reject) => net.connect(entry.ready.port, '127.0.0.1').once('connect', resolve).once('error', reject)), { code: 'ECONNREFUSED' });
});

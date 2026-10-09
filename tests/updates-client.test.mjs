import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUpdateClient, publicUpdateState, unavailableUpdateState, UpdateError } from '../server/updates.mjs';

const planId = 'a'.repeat(64);
const now = '2026-10-09T12:00:00.000Z';
const state = () => ({ enabled: true, checking: false, checkedAt: now, checkError: null, planId, expiresAt: now,
  modules: [{ id: 'hub', name: '统一工作台', state: 'available', currentVersion: null, latestVersion: '0.2.0', currentCommit: 'b'.repeat(40), latestCommit: 'a'.repeat(40) }], job: null });
const socketPath = () => process.platform === 'win32' ? `\\\\.\\pipe\\hub-updates-${randomUUID()}` : path.join(os.tmpdir(), `hub-updates-${randomUUID()}.sock`);
async function fixture(t, handler, timeoutMs = 1000) {
  const socket = socketPath(), server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return createUpdateClient({ socketPath: socket, timeoutMs });
}

test('updater client uses only fixed HTTP actions and removes every non-public field', async t => {
  const calls = [];
  const client = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
    const value = state();
    value.credentials = 'private-root-secret'; value.command = 'private-command';
    value.modules[0].path = '/private/path';
    value.job = { id: randomUUID(), status: 'running', startedAt: now, finishedAt: null, activeModule: 'hub', message: '正在更新',
      log: 'private-command-output', steps: [{ id: 'hub', name: '更新工作台', status: 'running', stdout: 'private-output' }] };
    res.end(JSON.stringify(value));
  });
  for (const value of [await client.status(), await client.check(), await client.apply(planId)]) {
    assert.equal(value.enabled, true); assert.equal(value.job.status, 'running');
    assert.equal(JSON.stringify(value).includes('private-'), false);
    assert.deepEqual(Object.keys(value.modules[0]), ['id', 'name', 'state', 'currentVersion', 'latestVersion', 'currentCommit', 'latestCommit']);
  }
  assert.deepEqual(calls, [
    { method: 'GET', url: '/status', body: '' }, { method: 'POST', url: '/check', body: '{}' },
    { method: 'POST', url: '/apply', body: JSON.stringify({ planId }) },
  ]);
  assert.throws(() => client.apply('file:///etc/passwd'), error => error.status === 400);
});

test('updater client bounds response bytes and never exposes unexpected service output', async t => {
  const client = await fixture(t, (req, res) => res.end('sensitive-raw-log'.repeat(100000)));
  assert.deepEqual(await client.status(), unavailableUpdateState());
  await assert.rejects(client.apply(planId), error => error instanceof UpdateError && error.status === 503 && error.uncertain && !error.message.includes('sensitive'));
});

test('updater client bounds total request time including a trickling response', async t => {
  const client = await fixture(t, (req, res) => {
    res.write('{'); const timer = setInterval(() => res.write(' '), 10);
    res.on('close', () => clearInterval(timer));
  }, 70);
  const started = Date.now();
  await assert.rejects(client.check(), error => error.status === 503 && error.uncertain);
  assert.ok(Date.now() - started < 1000);
});

test('missing updater socket has a disabled status and safe POST failures', async () => {
  const client = createUpdateClient({ socketPath: socketPath(), timeoutMs: 100 });
  assert.deepEqual(await client.status(), unavailableUpdateState());
  await assert.rejects(client.check(), error => error.status === 503 && !error.uncertain);
});

test('non-success updater responses have bounded public errors', async t => {
  const client = await fixture(t, (req, res) => { res.writeHead(409); res.end(JSON.stringify({ error: 'credential_should_not_leak', command: 'arbitrary-output' })); });
  await assert.rejects(client.apply(planId), error => error.status === 409 && !error.uncertain && !error.message.includes('credential'));
  assert.deepEqual(await client.status(), unavailableUpdateState());
});

test('updater state rejects malformed schemas, unsafe types and oversized fields', () => {
  const invalid = [null, [], {}, { ...state(), enabled: 'true' }, { ...state(), checkedAt: 'yesterday' }, { ...state(), checkError: { secret: 'private' } },
    { ...state(), planId: '../path' }, { ...state(), modules: [{ ...state().modules[0], reason: 'x'.repeat(501) }] },
    { ...state(), job: { id: '1', status: 'arbitrary', startedAt: now, finishedAt: null, activeModule: null, steps: [], message: 'x' } }];
  for (const value of invalid) assert.throws(() => publicUpdateState(value), error => error.status === 503);
});

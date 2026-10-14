import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUpdateClient, publicUpdateState, unavailableUpdateState, validateUpdateBody, UpdateError } from '../server/updates.mjs';

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

test('job progress crosses the local client only through its optional display schema', async t => {
  const sample = { stage: 'download', progress: 0.5, downloaded: 50, total: 100, speed: 10, eta: 5, timestamp: Date.parse(now) };
  let progress = sample, status = 'running';
  const client = await fixture(t, (_req, res) => res.end(JSON.stringify({ ...state(), job: {
    id: 'current-job', status, startedAt: now, finishedAt: null, activeModule: 'hub', message: '正在更新', steps: [],
    progress: { ...progress, log: 'private-command-output', token: 'private-token', path: '/private/path' },
  } })));
  assert.deepEqual((await client.status()).job.progress, sample);
  progress = { stage: 'build', timestamp: Date.parse(now), speed: 10, eta: 5 };
  assert.deepEqual((await client.status()).job.progress, { stage: 'build', timestamp: Date.parse(now) });
  for (const invalid of [null, {}, { ...sample, stage: 'unknown' }, { ...sample, timestamp: Date.parse(now) - 1 },
    { ...sample, progress: -0.1 }, { ...sample, progress: 1.1 }, { ...sample, progress: '0.5' },
    { ...sample, speed: -1 }, { ...sample, downloaded: 101 }, { ...sample, eta: true }]) {
    progress = invalid;
    const value = await client.status();
    assert.equal(value.enabled, true, 'optional progress cannot break control status');
    assert.equal(value.job.progress, undefined);
  }
  progress = sample;
  for (const final of ['queued', 'succeeded', 'failed', 'interrupted']) {
    status = final;
    assert.equal((await client.status()).job.progress, undefined);
  }
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

test('release notes cross the public client as bounded multiline Unicode text', async t => {
  const notes = '改进系统更新 📝\n- 显示具体变更\n\t<img src=x onerror=alert(1)> 按文本显示';
  const client = await fixture(t, (req, res) => {
    const value = state();
    value.modules[0].releaseNotes = notes;
    value.modules[0].installer = 'private-command';
    res.end(JSON.stringify(value));
  });
  for (const value of [await client.status(), await client.check(), await client.apply(planId)]) {
    assert.equal(value.modules[0].releaseNotes, notes);
    assert.equal(value.modules[0].installer, undefined);
  }
  const value = state();
  value.modules[0].releaseNotes = '😀'.repeat(1500);
  assert.equal(publicUpdateState(value).modules[0].releaseNotes, value.modules[0].releaseNotes, '6000 UTF-8 bytes are accepted');
});

test('missing or malformed optional release notes do not disable an otherwise valid update', () => {
  for (const notes of [undefined, null, {}, 123, true, '', ' \t\n ', '😀'.repeat(1500) + 'x', '中'.repeat(2001),
    'bad\u0000text', 'bad\u001btext', 'bad\u007ftext', 'bad\u0085text', 'bad\u061ctext', 'bad\u200etext',
    'bad\u202etext', 'bad\u2066text', 'bad\ud800text']) {
    const value = state();
    value.modules[0].releaseNotes = notes;
    const result = publicUpdateState(value);
    assert.equal(result.enabled, true);
    assert.equal(result.planId, planId);
    assert.equal(result.modules[0].state, 'available');
    assert.equal(result.modules[0].releaseNotes, undefined);
  }
  const value = state();
  value.modules[0].reason = '仍不允许\n多行错误信息';
  assert.throws(() => publicUpdateState(value), error => error.status === 503, 'existing message validation is unchanged');
});

test('recovery status crosses the local client without broadening public metadata', async t => {
  const client = await fixture(t, (_req, res) => {
    const value = state();
    value.modules[0] = { ...value.modules[0], recovery: true, installedIdentity: 'private-identity', installerHash: 'private-hash' };
    res.end(JSON.stringify(value));
  });
  for (const value of [await client.status(), await client.check(), await client.apply(planId)]) {
    assert.equal(value.modules[0].recovery, true);
    assert.equal(JSON.stringify(value).includes('private-'), false);
  }
  const value = state();
  assert.equal(publicUpdateState(value).modules[0].recovery, undefined);
  value.modules[0].recovery = false;
  assert.equal(publicUpdateState(value).modules[0].recovery, false);
  for (const recovery of [null, 'true', 1, {}, []]) {
    value.modules[0].recovery = recovery;
    assert.throws(() => publicUpdateState(value), error => error.status === 503);
  }
});

test('token settings expose only capability and configured status, including legacy compatibility', async t => {
  const secret = 'github_pat_' + 'fixture'.repeat(6), calls = [];
  const client = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ method: req.method, url: req.url, body });
    res.end(JSON.stringify({ ...state(), token: secret, credentials: { token: secret },
      githubToken: { configured: !!body.token, token: secret, suffix: secret.slice(-4), path: '/private/file' } }));
  });
  for (const token of [secret, 'ghp_' + 'replacement'.repeat(4), '']) {
    const result = await client.token(token);
    assert.deepEqual(result.githubToken, { configured: !!token });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.deepEqual(calls.at(-1), { method: 'POST', url: '/token', body: { token } });
  }
  assert.equal(publicUpdateState(state()).githubToken, undefined, 'older helpers remain compatible');
  for (const githubToken of [null, [], true, {}, { configured: 'true' }]) {
    assert.throws(() => publicUpdateState({ ...state(), githubToken }), error => error.status === 503);
  }
});

test('token requests reject malformed values and flexible configuration before opening the socket', async t => {
  let calls = 0;
  const client = await fixture(t, (req, res) => { calls++; res.end(JSON.stringify(state())); });
  for (const token of [null, true, {}, [], 123, 'short', 'a'.repeat(256), 'a'.repeat(20) + '\n',
    'a'.repeat(20) + '\r', 'a'.repeat(20) + '\u2028', 'a'.repeat(20) + ' ', 'a'.repeat(20) + '\0', 'a'.repeat(20) + '/']) {
    assert.throws(() => client.token(token), error => error.status === 400 && error.message === 'GitHub Token 格式无效，请粘贴完整 Token，且不要包含空格或换行');
  }
  for (const body of [{}, { token: '', path: '/tmp/other' }, { token: '', url: 'https://other.example' }, { token: '', command: 'id' }]) {
    assert.throws(() => validateUpdateBody('token', body), error => error.status === 400);
  }
  assert.equal(calls, 0);
});

test('token failures use fixed configuration errors and never forward upstream secrets', async t => {
  let code = 400;
  const client = await fixture(t, (req, res) => { res.writeHead(code); res.end(JSON.stringify({ error: 'private-token-secret' })); });
  for (const [status, message] of [[400, /Token 格式/], [409, /检查版本或执行更新/], [503, /保存结果尚未确认/]]) {
    code = status;
    await assert.rejects(client.token('a'.repeat(20)), error => error.status === status && message.test(error.message)
      && !error.message.includes('private') && error.uncertain === (status === 503));
  }
  const legacy = await fixture(t, (req, res) => res.end(JSON.stringify(state())));
  await assert.rejects(legacy.token('a'.repeat(20)), error => error.status === 503 && error.uncertain, 'missing confirmation cannot claim a saved token');
});

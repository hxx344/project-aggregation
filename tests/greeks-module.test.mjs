import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGreeksModule } from '../server/modules/greeks.mjs';

const secret = 'a-private-workspace-secret';
async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'workspace-greeks-'));
  const module = await createGreeksModule({ root: fileURLToPath(new URL('./fixtures', import.meta.url)), dataDir, secret, application: 'workspace_greeks:app', ...options });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\greeks-test-${randomUUID()}` : join(dataDir, 'app.sock');
  module.server.on('error', () => {});
  await new Promise(resolve => module.server.listen(socketPath, resolve));
  t.after(async () => { await module.close(); await new Promise(resolve => module.server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }); });
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: options.method || 'GET', agent: false,
      headers: { 'x-workspace-key': secret, host: 'greeks.workspace.internal', ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(options.body); options.onRequest?.(req);
  });
  return { ...module, request, events: () => readFileSync(join(dataDir, 'engine_state.json.lifecycle'), 'utf8').replaceAll('\r\n', '\n') };
}

test('Greeks stdio handles lifecycle, authentication, concurrent HTTP and body limits', async t => {
  const module = await fixture(t);
  assert.equal(module.events(), 'startup\n');
  assert.equal((await module.request('/', { headers: { 'x-workspace-key': 'wrong' } })).status, 403);
  const result = await module.request('/inspect?q=a%20b', { method: 'POST', body: 'request body', headers: { origin: 'https://greeks.example', 'x-forwarded-proto': 'https', authorization: 'Basic forged' } });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ready: true, authenticated: true, origin: 'https://greeks.example', scheme: 'https', body: 'request body', query: 'q=a%20b', private_key_forwarded: false });
  const responses = await Promise.all(Array.from({ length: 8 }, () => module.request('/concurrent')));
  assert.ok(responses.every(value => value.status === 200));
  assert.equal((await module.request('/', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  await module.close(); assert.match(module.events(), /shutdown\n$/);
});

test('Greeks timeout cancels ASGI work and leaves subsequent requests usable', async t => {
  const module = await fixture(t, { requestTimeout: 80 });
  assert.equal((await module.request('/slow')).status, 504);
  assert.equal((await module.request('/')).status, 200);
  assert.match(module.events(), /cancel\n/);
});

test('Greeks child death fails pending and subsequent requests closed', async t => {
  const module = await fixture(t);
  assert.equal((await module.request('/crash')).status, 503);
  assert.equal((await module.request('/')).status, 503);
});

test('Greeks cancels ASGI when its HTTP caller disconnects', async t => {
  const module = await fixture(t);
  await assert.rejects(module.request('/slow', { onRequest: request => setTimeout(() => request.destroy(new Error('caller cancelled')), 30) }), /caller cancelled/);
  assert.equal((await module.request('/')).status, 200);
  assert.match(module.events(), /cancel\n/);
});

test('Greeks startup failure never exposes a ready HTTP server', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'workspace-greeks-failed-'));
  try {
    await assert.rejects(createGreeksModule({ root: fileURLToPath(new URL('./fixtures', import.meta.url)), dataDir, secret, application: 'missing_workspace_fixture:app', startupTimeout: 2000 }), /bridge unavailable/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createAsterModule } from '../server/modules/aster.mjs';

const secret = 'aster-private-workspace-test-secret';
const root = fileURLToPath(new URL('../modules/aster', import.meta.url));
async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'workspace-aster-'));
  const module = await createAsterModule({ root, dataDir, secret, application: 'tests.workspace_fixture:app',
    environment: { WORKSPACE_MAINTENANCE: '1', ASTER_PUBLIC_ORIGIN: 'https://old.invalid',
      ASTER_TRADING_RUNTIME: 'must-never-use-this-path', ASTER_DASHBOARD_DIR: 'must-never-use-this-path' }, ...options });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aster-test-${randomUUID()}` : join(dataDir, 'app.sock');
  module.server.on('error', () => {});
  await new Promise(resolve => module.server.listen(socketPath, resolve));
  t.after(async () => {
    await module.close();
    await new Promise(resolve => module.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: options.method || 'GET', agent: false,
      headers: { 'x-workspace-key': secret, host: 'aster.workspace.internal', ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(options.body); options.onRequest?.(req);
  });
  return { ...module, request, dataDir, events: () => readFileSync(join(dataDir, 'lifecycle'), 'utf8').replaceAll('\r\n', '\n') };
}

test('ASTER private pipe uses hub identity and validates origin without independent login', async t => {
  const module = await fixture(t);
  assert.equal(module.events(), 'startup\n');
  assert.equal((await module.request('/api/state', { headers: { 'x-workspace-key': 'forged' } })).status, 403);
  assert.equal((await module.request('/__workspace/update-status', { headers: { 'x-workspace-key': '' } })).status, 403);
  const state = await module.request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).workspaceManaged, true);
  assert.equal(state.headers['x-frame-options'], 'SAMEORIGIN');
  const inspect = JSON.parse((await module.request('/__fixture/inspect', { headers: { authorization: 'Basic forged' } })).body);
  assert.equal(inspect.authorization, null);
  assert.equal(inspect.publicOrigin, null);
  assert.equal(resolve(inspect.runtime), resolve(module.dataDir));
  assert.equal(resolve(inspect.dashboard), resolve(root, 'dashboard/dist/client'));
  const headers = { origin: 'http://aster.workspace.internal', 'content-type': 'application/json' };
  for (const path of ['/api/login', '/api/logout']) {
    assert.equal((await module.request(path, { method: 'POST', headers, body: path.endsWith('login') ? '{"password":"ignored"}' : undefined })).status, 409);
  }
  assert.equal((await module.request('/api/accounts', { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
  assert.equal(JSON.parse((await module.request('/__workspace/update-status')).body).busy, false);
  const maintenance = await module.request('/__workspace/maintenance', { method: 'POST', headers, body: '{"active":false}' });
  assert.equal(maintenance.status, 200);
  assert.equal(JSON.parse(maintenance.body).active, false);
  assert.equal(JSON.parse((await module.request('/__workspace/update-status')).body).busy, true);
  await module.close();
  assert.match(module.events(), /shutdown\n$/);
});

test('ASTER stdio EOF and invalid protocol stop the real engine and release process ownership', async t => {
  for (const invalid of [false, true]) {
    const module = await fixture(t);
    const closed = once(module.child, 'close');
    if (invalid) module.child.stdin.write('{"type":"invalid"}\n');
    else module.child.stdin.end();
    await closed;
    assert.match(module.events(), /shutdown\n$/);
    assert.equal((await module.request('/api/state')).status, 503);
  }
});

test('ASTER timeout cancels ASGI requests and unexpected child death fails closed', async t => {
  const module = await fixture(t, { requestTimeout: 80 });
  assert.equal((await module.request('/__fixture/slow')).status, 504);
  assert.equal((await module.request('/__fixture/inspect')).status, 200);
  assert.match(module.events(), /cancel\n/);
  assert.equal((await module.request('/__fixture/crash')).status, 503);
  assert.equal((await module.request('/api/state')).status, 503);
});

test('ASTER closes trading admission before waiting for synchronous HTTP requests', async t => {
  const module = await fixture(t);
  const pending = module.request('/__fixture/wait-shutdown');
  const deadline = Date.now() + 3000;
  while (!module.events().includes('waiting') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(module.events(), /waiting/);
  const started = Date.now();
  await module.close();
  assert.ok(Date.now() - started < 3000, 'shutdown must wake the synchronous request before its own timeout');
  assert.equal((await pending).status, 503);
  assert.match(module.events(), /shutdown\n$/);
});

test('ASTER child observes abrupt parent death and exits without a listening TCP service', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'workspace-aster-parent-'));
  const adapter = new URL('../server/modules/aster.mjs', import.meta.url).href;
  const program = `import { createAsterModule } from ${JSON.stringify(adapter)};
    const module = await createAsterModule({ root: ${JSON.stringify(root)}, dataDir: ${JSON.stringify(dataDir)},
      secret: ${JSON.stringify(secret)}, application: 'tests.workspace_fixture:app', environment: { WORKSPACE_MAINTENANCE: '1' } });
    console.log(module.child.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let pid;
  try {
    const output = await new Promise((resolve, reject) => {
      parent.stdout.once('data', data => resolve(data.toString()));
      parent.once('error', reject);
      parent.once('exit', code => reject(new Error(`fixture parent exited ${code}`)));
    });
    pid = Number(output.trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    parent.kill('SIGKILL');
    await once(parent, 'close');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.throws(() => process.kill(pid, 0));
    // Windows may reap the parent's entire process job immediately. On Unix
    // EOF performs the engine shutdown; in both cases no child may survive.
    if (process.platform !== 'win32') assert.match(readFileSync(join(dataDir, 'lifecycle'), 'utf8'), /shutdown\r?\n$/);
  } finally {
    parent.kill('SIGKILL');
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createModule } from '../server/modules/asset.mjs';
import { configure } from '../modules/asset/scripts/configure.mjs';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../modules/asset/', import.meta.url));
const dataDir = process.env.ASSET_SMOKE_DATA || mkdtempSync(join(tmpdir(), 'asset-managed-smoke-'));
if (!process.env.ASSET_SMOKE_DATA) {
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ASSET_SMOKE_DATA: dataDir }, stdio: 'inherit', windowsHide: true });
    assert.equal(result.status, 0, 'Asset production smoke child failed');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
  process.exit(0);
}
const previousCwd = process.cwd();
configure(dataDir);
const config = readFileSync(join(dataDir, 'config.json'), 'utf8');
const secret = randomUUID();
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\asset-smoke-${randomUUID()}` : join(dataDir, 'app.sock');
process.chdir(root);
let module;
function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method, agent: false,
      headers: { host: 'asset.workspace.internal', 'x-workspace-key': secret, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}
try {
  module = await createModule({ root, dataDir, secret });
  await new Promise(resolve => module.server.listen(socketPath, resolve));
  assert.equal((await request('/', { headers: { 'x-workspace-key': 'forged' } })).status, 403);
  const page = await request('/');
  assert.equal(page.status, 200); assert.match(page.body, /资产/);
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await request('/api/ledger')).status, 200);
  assert.equal((await request('/api/ledger', { method: 'PATCH', headers: { origin: 'http://hostile.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/ledger', { method: 'PATCH', headers: { origin: 'http://asset.workspace.internal', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/hub/trading-connections/export', { method: 'POST', headers: { origin: 'http://asset.workspace.internal', 'content-type': 'application/json' }, body: JSON.stringify({ exchange: 'bybit', revision: 'a'.repeat(64) }) })).status, 409);
  assert.equal(readFileSync(join(dataDir, 'config.json'), 'utf8'), config);
  console.log('Asset production smoke passed: named pipe, authenticated page/API, CSRF, internal export, preserved config');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (module) { await new Promise(resolve => module.server.close(resolve)); await module.close(); }
  process.chdir(previousCwd);
}

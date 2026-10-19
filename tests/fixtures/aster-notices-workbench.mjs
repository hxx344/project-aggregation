// Windows-native fixture for the real server/index.mjs and embedded ASTER UI.
// Run: node --import ./tests/fixtures/aster-notices-workbench.mjs server/index.mjs
// Only module workers are replaced. Hub login, launch, proxy and bridge stay real.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { registerModuleTransport } from '../../server/modules/transport.mjs';
import { moduleCatalog } from '../../server/modules/catalog.mjs';
import { createStaticResponder } from '../../server/static-response.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = path.join(root, 'modules/aster/dashboard/dist/client');
const directory = mkdtempSync(path.join(tmpdir(), 'aster-notices-browser-'));
if (process.platform === 'win32') {
  const secure = spawnSync(process.env.PYTHON || 'python', ['-I', path.join(root, 'tests/test_lifecycle_lock.py'), '--secure-dir', directory],
    { windowsHide: true, timeout: 5000 });
  if (secure.status !== 0) throw new Error('Cannot protect the isolated browser fixture data directory');
}
process.env.DATA_DIR = directory;
process.env.PORT = '39152';
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_ORIGIN = '';
process.env.COOKIE_SECURE = 'false';
process.env.WARMUP_ENABLED = 'false';
process.env.INITIAL_PASSWORD = 'aster-notices-browser-fixture';

const runtimeUrl = new URL('../../server/modules/runtime.mjs', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url === runtimeUrl) return { format: 'module', shortCircuit: true,
      source: `export { startFixtureModules as startModules } from ${JSON.stringify(import.meta.url)};` };
    return nextLoad(url, context);
  },
});

export async function startFixtureModules() {
  if (!existsSync(path.join(dist, 'index.html'))) throw new Error('Build the embedded ASTER dashboard first');
  const secret = randomUUID(), remove = [], serve = createStaticResponder();
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\aster-notices-browser-${randomUUID()}` : path.join(directory, 'modules.sock');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
  const server = http.createServer(async (req, res) => {
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers['x-workspace-key'] !== secret) return send({ error: 'Unauthorized fixture request' }, 403);
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
    if (pathname === '/__workspace/maintenance' && req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      return send({ active: JSON.parse(Buffer.concat(chunks).toString()).active, busy: false });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send({ error: 'Trading writes are forbidden' }, 405);
    if (pathname === '/__workspace/update-status') return send({ busy: false });
    if (pathname.startsWith('/api/')) return send({ ready: true, demo: true, status: 'ok', accounts: [], pairs: [],
      markets: {}, events: [], updated_at: Date.now() / 1000, notification: { configured: false, pending: 0 } });
    if (req.headers.host !== 'aster.workspace.internal') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>Idle module fixture</title><p>Inactive browser fixture module</p>');
    }
    const filename = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(dist + path.sep) || !existsSync(filename)) return send({ error: 'Fixture asset missing' }, 404);
    try { await serve(req, res, filename, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); }
    catch { if (!res.headersSent) send({ error: 'Fixture asset failed' }, 500); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  for (const { id } of moduleCatalog) remove.push(registerModuleTransport(id, { socketPath, secret }));
  console.log('ASTER notices fixture: real Hub entry http://hub.localhost:39152/?view=project&id=aster; no trading workers');
  return { close: async () => {
    for (const unregister of remove) unregister();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } };
}

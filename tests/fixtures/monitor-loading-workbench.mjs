// Windows-native fixture using the real Hub login, launch, proxy and bridge.
// Run from the repository root:
// node --import ./tests/fixtures/monitor-loading-workbench.mjs server/index.mjs
// Production monitor SSR/assets with seeded data; no collectors or trading workers.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { registerModuleTransport } from '../../server/modules/transport.mjs';
import { moduleCatalog } from '../../server/modules/catalog.mjs';
import { createPageHandler } from '../../modules/monitor/server/page-handler.mjs';
import { readHubSummary } from '../../modules/monitor/server/hub-summary.mjs';
import { monitors } from '../../modules/monitor/lib/monitors.ts';
import { parseGoldOilAction } from '../../modules/monitor/lib/gold-oil.ts';
import { createGoldOilLoadingFixture } from '../../modules/monitor/tests/gold-oil-loading-server.mjs';

const monitorRoot = fileURLToPath(new URL('../../modules/monitor/', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'monitor-loading-browser-'));
process.env.DATA_DIR = directory;
process.env.PORT = '39154';
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_ORIGIN = '';
process.env.COOKIE_SECURE = 'false';
process.env.WARMUP_ENABLED = 'false';
process.env.INITIAL_PASSWORD = 'monitor-loading-browser-fixture';

const runtimeUrl = new URL('../../server/modules/runtime.mjs', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url === runtimeUrl) return { format: 'module', shortCircuit: true,
      source: `export { startFixtureModules as startModules } from ${JSON.stringify(import.meta.url)};` };
    return nextLoad(url, context);
  },
});

export async function startFixtureModules() {
  const { snapshots, services } = createGoldOilLoadingFixture();
  const runtime = Object.fromEntries(monitors.map(({ id }) => [id, {
    monitorId: id, available: false, enabled: id === 'cl-xau', running: false,
    revision: 0, reason: 'Read-only seeded browser fixture',
  }]));
  services.controls = { view: () => runtime };
  for (const { id } of monitors) {
    if (!services.has(id)) services.set(id, { handle() { throw Error('Inactive fixture market'); } });
    services.get(id).runtime = () => runtime[id];
  }
  let pages, server;
  const remove = [], secret = randomUUID();
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\monitor-loading-browser-${randomUUID()}` : path.join(directory, 'modules.sock');
  const cleanup = async () => {
    for (const unregister of remove.splice(0)) unregister();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pages?.close();
    const prefix = path.resolve(tmpdir()) + path.sep + 'monitor-loading-browser-';
    if (!path.resolve(directory).startsWith(prefix)) throw Error('Fixture cleanup path escaped its temporary directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  };
  try {
    pages = await createPageHandler({ services, root: monitorRoot });
    server = http.createServer(async (request, response) => {
      const send = (value, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value));
      };
      try {
        if (request.headers['x-workspace-key'] !== secret) return send({ error: 'Unauthorized fixture request' }, 403);
        const url = new URL(request.url, 'http://fixture.invalid'), pathname = url.pathname;
        if (pathname === '/__workspace/maintenance' && request.method === 'POST') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          return send({ active: JSON.parse(Buffer.concat(chunks).toString()).active, busy: false });
        }
        if (!['GET', 'HEAD'].includes(request.method)) return send({ error: 'Business writes are forbidden in this fixture' }, 405);
        if (pathname === '/__workspace/update-status') return send({ busy: false });
        if (request.headers.host !== 'monitor.workspace.internal') {
          if (pathname.startsWith('/api/')) return send({ available: false, ready: true, demo: true, status: 'idle',
            accounts: [], pairs: [], markets: {}, events: [], updated_at: Date.now() / 1000 });
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return response.end(request.method === 'HEAD' ? undefined : '<!doctype html><title>Idle module fixture</title><p>Inactive browser fixture module</p>');
        }
        if (pathname === '/__fixture') return send(snapshots);
        if (pathname === '/api/monitors') return send({ schemaVersion: 1, monitors: monitors.map(monitor => ({ ...monitor, runtime: runtime[monitor.id] })) });
        if (pathname === '/api/hub/summary') {
          const summary = await readHubSummary(services, Date.now(), url.searchParams.get('monitor') || 'oil', url.searchParams.get('goldOil') || 'cl', url.searchParams.get('goldOilExchange') || 'binance');
          return send(url.searchParams.get('schemaVersion') === '2' ? { schemaVersion: 2, data: summary }
            : { schemaVersion: 1, data: { updatedAt: summary.updatedAt || new Date(0).toISOString(), metrics: summary.metrics } });
        }
        if (pathname === '/api/notifications/feishu') return send({ available: false, revision: 0, webhookConfigured: false,
          signingSecretConfigured: false, candidates: [], migratedFrom: [], lastTestAt: null, testResult: null, error: '', reason: 'Fixture notifications disabled' });
        if (pathname.startsWith('/api/monitors/cl-xau/')) {
          const action = pathname.slice('/api/monitors/cl-xau/'.length), parsed = parseGoldOilAction(action);
          if (!parsed) return send({ error: 'Unknown fixture action' }, 404);
          if (['quote', 'history', 'funding'].includes(parsed.action)) return send(services.get('cl-xau').handle(action, 'GET'));
          const identity = { oilType: parsed.oilType, exchange: parsed.exchange, source: parsed.exchange === 'bybit' ? 'Bybit' : 'Binance' };
          if (parsed.action === 'status') return send({ ...identity, available: false, reason: 'Fixture alerts disabled', webhookConfigured: false,
            lastAttemptAt: null, lastSuccessAt: null, stale: false, error: '' });
          if (parsed.action === 'config') return send({ ...identity, revision: 0, config: { enabled: false, rules: [] } });
          if (parsed.action === 'events') return send({ ...identity, events: [] });
        }
        if (pathname.startsWith('/api/')) return send({ error: 'Inactive fixture API' }, 404);
        await pages.handle(request, response);
      } catch (error) {
        console.error('Monitor loading fixture request failed:', error);
        if (!response.headersSent) send({ error: 'Fixture request failed' }, 500);
        else response.destroy(error);
      }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    for (const { id } of moduleCatalog) remove.push(registerModuleTransport(id, { socketPath, secret }));
    console.log('Monitor loading fixture: http://hub.localhost:39154/?view=project&id=monitor; seeded read-only data, no collectors or trading workers');
    return { close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}

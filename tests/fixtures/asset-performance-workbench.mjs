// Windows-native fixture for the real Hub and production Asset Next application.
// Build Hub + Asset first, then run from the repository root:
// node --import ./tests/fixtures/asset-performance-workbench.mjs server/workbench.mjs
// Open http://hub.localhost:39153/?view=project&id=asset
// Password: asset-performance-browser-fixture
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleCatalog } from '../../server/modules/catalog.mjs';
import { registerModuleTransport } from '../../server/modules/transport.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const assetRoot = path.join(root, 'modules', 'asset');
const worker = process.argv[2] === '--asset-worker';
const temporaryRoot = realpathSync(tmpdir());
const directory = worker ? path.resolve(process.argv[3]) : mkdtempSync(path.join(temporaryRoot, 'asset-performance-browser-'));
const nativeFetch = globalThis.fetch;

// Both processes reject non-local fetches; there is no live provider fallback.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) {
    return nativeFetch(input, init);
  }
  return new Response('External requests are disabled in the Asset browser fixture', { status: 503 });
};

if (!worker) {
  Object.assign(process.env, {
    DATA_DIR: directory, PORT: '39153', HOST: '127.0.0.1', PUBLIC_ORIGIN: '',
    COOKIE_SECURE: 'false', WARMUP_ENABLED: 'false',
    INITIAL_PASSWORD: 'asset-performance-browser-fixture', NEXT_TELEMETRY_DISABLED: '1',
  });
  const runtimeUrl = new URL('../../server/modules/runtime.mjs', import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      if (url === runtimeUrl) return {
        format: 'module', shortCircuit: true,
        source: `export { startFixtureModules as startModules } from ${JSON.stringify(import.meta.url)};`,
      };
      return nextLoad(url, context);
    },
  });
} else {
  await runAssetWorker();
}

function pipe(name) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\asset-performance-${name}-${randomUUID()}`
    : path.join(directory, `${name}.sock`);
}

export async function startFixtureModules({ logger = console, onFailure = () => {} } = {}) {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Build the Hub before running the Asset browser fixture');
  assert.ok(existsSync(path.join(assetRoot, '.next', 'required-server-files.json')), 'Build modules/asset before running the Asset browser fixture');
  const asset = { socketPath: pipe('asset'), secret: randomUUID() };
  const idle = { socketPath: pipe('idle'), secret: randomUUID() };
  const unregister = [];
  let child, closing, stopping = false;
  const server = http.createServer(async (req, res) => {
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-workspace-key'] !== idle.secret) return send({ error: 'Unauthorized fixture request' }, 403);
    const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
    if (pathname === '/__workspace/maintenance' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { return send({ active: JSON.parse(Buffer.concat(chunks).toString()).active, busy: false }); }
      catch { return send({ error: 'Invalid maintenance request' }, 400); }
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send({ error: 'Inactive fixture modules are read-only' }, 405);
    if (pathname === '/__workspace/update-status') return send({ busy: false });
    if (pathname.startsWith('/api/')) return send({
      ready: true, demo: true, status: 'ok', accounts: [], pairs: [], markets: {}, events: [],
      updated_at: Date.now() / 1000, notification: { configured: false, pending: 0 },
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Idle module fixture</title><p>Inactive browser fixture module</p>');
  });
  function close() {
    if (closing) return closing;
    stopping = true;
    for (const remove of unregister) remove();
    closing = (async () => {
      await Promise.all([
        new Promise(resolve => {
          if (!server.listening) return resolve();
          server.close(resolve);
          server.closeAllConnections();
        }),
        new Promise(resolve => {
          if (!child?.pid || child.exitCode !== null || child.signalCode) return resolve();
          const timer = setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
          child.once('close', () => { clearTimeout(timer); resolve(); });
          if (child.connected) child.send({ type: 'shutdown' }, () => {});
          else child.kill();
        }),
      ]);
      const resolved = realpathSync(directory), location = path.relative(temporaryRoot, resolved);
      assert.ok(location && !location.startsWith('..') && !path.isAbsolute(location)
        && path.basename(resolved).startsWith('asset-performance-browser-'), 'Cleanup must remain inside the fixture temporary directory');
      await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(idle.socketPath, resolve); });
    // Exclude inherited credentials, NODE_OPTIONS and existing Asset settings.
    const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'localappdata', 'appdata', 'comspec', 'pathext', 'number_of_processors', 'processor_architecture', 'lang', 'lc_all']);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--asset-worker', directory], {
      cwd: assetRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...environment, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout.on('data', data => logger.info(`[asset fixture] ${String(data).trimEnd()}`));
    child.stderr.on('data', data => logger.warn(`[asset fixture] ${String(data).trimEnd()}`));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Asset fixture startup timed out')), 120_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      const exited = code => fail(new Error(`Asset fixture exited during startup (${code})`));
      child.once('error', fail);
      child.once('exit', exited);
      child.on('message', message => {
        if (message?.type === 'failed') return fail(new Error(message.message));
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        child.removeListener('exit', exited);
        child.once('exit', (code, signal) => {
          if (!stopping) void close().finally(() => onFailure(new Error(`Asset fixture stopped (${signal || code})`)));
        });
        unregister.push(registerModuleTransport('asset', asset));
        for (const { id } of moduleCatalog) if (id !== 'asset') unregister.push(registerModuleTransport(id, idle));
        logger.info(`Asset performance fixture: http://hub.localhost:39153/?view=project&id=asset; password: asset-performance-browser-fixture`);
        logger.info(`Asset fixture samples: ${JSON.stringify(message.samples)}`);
        resolve();
      });
      child.send({ type: 'start', ...asset }, error => { if (error) fail(error); });
    });
    return { markStarted() {}, status: () => [], restart: () => false, projects: moduleCatalog, close };
  } catch (error) { await close(); throw error; }
}

async function seedAsset(dataDir) {
  const { configure } = await import('../../modules/asset/scripts/configure.mjs');
  const { openDatabase } = await import('../../modules/asset/lib/sqlite.ts');
  configure(dataDir);
  const database = openDatabase(path.join(dataDir, 'ledger.sqlite'), path.join(assetRoot, 'drizzle'));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const [year, month] = today.split('-').map(Number);
  const date = (offset, day) => new Date(Date.UTC(year, month - 1 + offset, day)).toISOString().slice(0, 10);
  const fx = 7;
  const fxStatus = { source: 'manual', fetchedAt: new Date().toISOString(), rateDate: null, error: null };
  const asset = (value, day) => ({
    id: 'row-2', project: '月度表现示例资产', kind: '资产', quantity: value, price: 1, value,
    cell: 'E2', mode: 'manual', updatedAt: `${day}T00:00:00+08:00`, status: '手动估值',
  });
  const samples = [
    { date: date(-2, 1), total: 10000 },
    { date: date(-1, 0), total: 9500 },
    { date: date(-1, 1), total: 10000 },
    { date: date(-1, 15), total: 10400, partial: true },
    { date: date(0, 0), total: 11000 },
    ...(today !== date(0, 1) ? [{ date: date(0, 1), total: 11000 }] : []),
    { date: today, total: 12600 },
  ];
  const first = samples[0];
  const source = {
    source: '示例数据（非真实资产）', sheet: 'Browser fixture', startedAt: first.date,
    baselineId: 'E1', baselineDate: first.date, fx,
    periods: [{ id: 'E1', date: first.date, total: first.total, fx, cny: first.total * fx,
      future: false, difference: 0, rowSum: first.total, rows: [asset(first.total, first.date)] }],
  };
  try {
    const settings = {
      initialized: '1', fx: String(fx), 'fx-status': JSON.stringify(fxStatus),
      'source-ledger': JSON.stringify(source), withdrawals: '[]',
      // The production /api/sync route stays real but returns this cached ledger.
      // No market row or connection is seeded, and provider calls remain blocked.
      'last-attempt': String(Number.MAX_SAFE_INTEGER),
    };
    await database.batch([
      database.prepare('INSERT INTO assets(owner,id,data) VALUES(?,?,?)').bind('owner', 'row-2', JSON.stringify(asset(12600, today))),
      ...Object.entries(settings).map(([key, value]) => database.prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?)').bind('owner', key, value)),
      ...samples.slice(1).map(sample => database.prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)').bind('owner', sample.date, JSON.stringify({
        id: `daily-${sample.date}`, ...sample, fx, cny: sample.total * fx, future: false,
        difference: 0, withdrawn: 0, fxStatus, assets: [asset(sample.total, sample.date)],
      }))),
    ]);
  } finally { database.close(); }
  return samples;
}

async function runAssetWorker() {
  let application, stopping = false, started = false;
  async function close(code = 0) {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 8_000).unref();
    try {
      if (application) {
        await new Promise(resolve => { application.server.close(resolve); application.server.closeAllConnections(); });
        await application.close();
      }
    } finally { clearTimeout(timer); process.exit(code); }
  }
  process.on('message', async message => {
    if (message?.type === 'shutdown') return void close();
    if (message?.type !== 'start' || started || stopping) return;
    started = true;
    try {
      const dataDir = path.join(directory, 'modules', 'asset');
      const samples = await seedAsset(dataDir);
      const { createModule } = await import('../../server/modules/asset.mjs');
      application = await createModule({ root: assetRoot, dataDir, secret: message.secret });
      await new Promise((resolve, reject) => {
        application.server.once('error', reject);
        application.server.listen(message.socketPath, resolve);
      });
      process.send?.({ type: 'ready', samples });
    } catch (error) {
      console.error(error.stack || error.message);
      process.send?.({ type: 'failed', message: error.message });
      await close(1);
    }
  });
  process.once('disconnect', () => void close());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBinanceLighterCost } from '../server/research/binance-lighter-cost.mjs';
import { CostLabEngine, DEFAULT_COST_CONFIG } from '../server/research/binance-lighter-core.mjs';
import { createApp } from '../server/app.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const clone = value => structuredClone(value);
const base = Date.parse('2026-11-05T06:00:00Z');
const config = () => clone(DEFAULT_COST_CONFIG);
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  throw new Error('研究状态未按预期完成');
}
function fakeEngine(settings, { sessionId, emit }) {
  const view = { schema: 1, sessionId, sessionConfig: clone(settings), mode: 'paper', startedAt: base, updatedAt: base,
    stopped: false, interrupted: false, markets: [], books: [], scenarios: [], assumptions: [] };
  return {
    setMarkets(value) { view.markets = value; },
    onBook(value) { view.books = [value]; },
    onTrade() {
      view.scenarios = [{ id: 'BTC-buy-300', status: 'hedge_entry', task: { id: 'task', binanceQuantity: 0.01, lighterQuantity: 0, residualQuantity: 0.01 },
        stats: { completed: 0, unresolved: 0, binanceTurnover: 800, fees: 0, tradingPnl: 0, tradingCost: 0, closedBinanceTurnover: 0 } }];
      emit({ type: 'fill' });
    },
    invalidate() {}, onStatus() {}, tick() {},
    stop() { view.stopped = true; for (const row of view.scenarios) { row.status = 'unresolved'; row.stats.unresolved = 1; } },
    report(options = {}) {
      const selected = options.scenarioId ? view.scenarios.filter(row => row.id === options.scenarioId) : view.scenarios;
      return clone({ ...view, detailLevel: options.summary ? 'summary' : options.scenarioId ? 'scenario' : 'full',
        scenarios: options.summary ? selected.map(row => ({ ...row, recentRounds: [], history: [] })) : selected });
    },
  };
}
function fixture(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'binance-lighter-workbench-'));
  const sources = [];
  let reads = 0;
  const create = overrides => createBinanceLighterCost({ dataDir, log: silent, now: () => base, mono: () => 100,
    tickMs: 60_000, snapshotMs: 60_000, metadataMs: 60_000,
    engineFactory: fakeEngine,
    discover: async () => { reads += 1; return []; },
    connect(callbacks) {
      let finish;
      const source = { callbacks, stops: 0, done: new Promise(resolve => { finish = resolve; }), async stop() { this.stops += 1; finish(); } };
      sources.push(source); return source;
    }, ...options, ...overrides });
  return { dataDir, sources, create, reads: () => reads, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test('default is stopped, public only, and simultaneous starts create one session', async () => {
  const f = fixture(); const manager = f.create();
  try {
    await manager.initialize();
    assert.equal(f.reads(), 0); assert.equal(manager.state().state, 'stopped');
    assert.deepEqual(manager.state().execution, { mode: 'paper', liveAvailable: false, version: 1 });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    assert.equal(a.report.sessionId, b.report.sessionId);
    await until(() => f.sources.length === 1);
    assert.equal(f.reads(), 1);
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'session.json'))).clean, false);
    await manager.stop();
    const stopped = manager.state();
    f.sources[0].callbacks.onTrade({});
    assert.deepEqual(manager.state().report, stopped.report, 'late old-generation events cannot change a stopped report');
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'session.json'))).clean, true);
  } finally { await manager.close(); f.cleanup(); }
});

test('partial simulated exposure persists immediately, stop preserves it, archive is explicit', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({});
    const persisted = JSON.parse(readFileSync(join(manager.directory, 'session.json'))).report;
    assert.equal(persisted.scenarios[0].task.binanceQuantity, 0.01);
    assert.equal(persisted.scenarios[0].stats.binanceTurnover, 800);
    await manager.stop();
    assert.equal(manager.state().report.scenarios[0].task.residualQuantity, 0.01);
    await manager.close(); manager = f.create(); await manager.initialize();
    assert.equal(manager.state().report.scenarios[0].stats.binanceTurnover, 800);
    await assert.rejects(manager.start(), error => error.status === 409);
    const original = manager.report().report;
    await manager.archive();
    assert.equal(manager.state().report, null);
    assert.equal(manager.state().archives.length, 1);
    assert.deepEqual(manager.report(original.sessionId).report, original);
    await manager.start();
    assert.notEqual(manager.state().report.sessionId, original.sessionId);
    assert.equal(manager.state().archives[0].unresolved, 1);
  } finally { await manager.close(); f.cleanup(); }
});

test('archive interruption is separate from unresolved scenario count', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({}); await manager.stop(); await manager.close();
    const file = join(manager.directory, 'session.json');
    const saved = JSON.parse(readFileSync(file)); saved.report.interrupted = true; writeFileSync(file, JSON.stringify(saved));
    manager = f.create(); await manager.initialize(); await manager.archive();
    assert.equal(manager.state().archives[0].unresolved, 1);
    assert.equal(manager.state().archives[0].interrupted, true);
  } finally { await manager.close(); f.cleanup(); }
});

test('unclean crash before first fill remains interrupted across repeated restarts', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start();
    const dirty = readFileSync(join(manager.directory, 'session.json'));
    await manager.close();
    writeFileSync(join(manager.directory, 'session.json'), dirty);
    for (let attempt = 0; attempt < 2; attempt++) {
      manager = f.create(); await manager.initialize();
      assert.equal(manager.state().report.interrupted, true);
      assert.match(manager.state().error, /未正常结束/);
      await assert.rejects(manager.start(), error => error.status === 409);
      await manager.close();
    }
    assert.equal(f.reads(), 1, 'restarts do not auto-start collection or invent zero-risk sessions');
  } finally { await manager.close(); f.cleanup(); }
});

test('failed durable start or save cannot change runtime intent or saved config', async () => {
  let denied = '';
  const f = fixture({ write(file, value) { if (file.endsWith(denied) && denied) throw new Error('fixture_disk_full'); writeFileSync(file, JSON.stringify(value)); } });
  const manager = f.create();
  try {
    await manager.initialize();
    denied = 'session.json';
    await assert.rejects(manager.start(), /fixture_disk_full/);
    assert.equal(f.reads(), 0); assert.equal(manager.state().enabled, false); assert.equal(manager.state().report, null);
    denied = 'config.json';
    await assert.rejects(manager.save({ ...config(), notionalPerLeg: 2000 }), /fixture_disk_full/);
    assert.equal(manager.state().config.notionalPerLeg, config().notionalPerLeg);
    denied = ''; await manager.start(); await until(() => f.sources.length === 1);
    denied = 'session.json'; f.sources[0].callbacks.onTrade({});
    assert.equal(manager.state().enabled, false); assert.equal(manager.state().state, 'fault');
    assert.equal(manager.state().report.scenarios[0].task.residualQuantity, 0.01);
  } finally { denied = ''; await manager.close(); f.cleanup(); }
});

test('stop during discovery fences stale results from a new session', async () => {
  const pending = [];
  const f = fixture({ discover: () => new Promise(resolve => pending.push(resolve)) });
  const manager = f.create();
  try {
    await manager.initialize(); await manager.start();
    const previous = manager.state().report.sessionId;
    await manager.stop(); await manager.start();
    pending[0]([]); await delay(10);
    assert.equal(f.sources.length, 0);
    pending[1]([]); await until(() => f.sources.length === 1);
    assert.notEqual(manager.state().report.sessionId, previous);
    assert.equal(manager.state().archives.length, 1);
  } finally { for (const resolve of pending) resolve([]); await manager.close(); f.cleanup(); }
});

test('invalid reports are retained, and live/config path overrides are rejected', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize();
    await assert.rejects(manager.save({ ...config(), mode: 'live' }), error => error.status === 400);
    await assert.rejects(manager.save({ ...config(), url: 'https://example.invalid' }), error => error.status === 400);
    assert.throws(() => manager.report('../config'), error => error.status === 404);
    await manager.close();
    const damaged = '{invalid-file';
    writeFileSync(join(manager.directory, 'session.json'), damaged);
    manager = f.create(); await manager.initialize();
    assert.equal(manager.state().state, 'fault');
    await assert.rejects(manager.start(), error => error.status === 409);
    await assert.rejects(manager.stop(), error => error.status === 409);
    await assert.rejects(manager.archive(), error => error.status === 409);
    assert.equal(readFileSync(join(manager.directory, 'session.json'), 'utf8'), damaged);
  } finally { await manager.close(); f.cleanup(); }
});

test('venue cooldown is durable and passed into later collection attempts', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onDiagnostic({ venue: 'binance', event: 'cooldown', details: { retryNotBefore: base + 60_000 } });
    await manager.stop(); await manager.close();
    let observed;
    manager = f.create({ discover: async ({ cooldowns }) => { observed = cooldowns.binance; return []; } });
    await manager.initialize(); await manager.start(); await until(() => observed !== undefined);
    assert.equal(observed, base + 60_000);
  } finally { await manager.close(); f.cleanup(); }
});

test('actual workbench route enforces session, origin, CSRF and exact paper config', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'binance-lighter-api-'));
  let app;
  try {
    app = await createApp({ dataDir, initialPassword: 'cost-research-fixture', refreshInterval: 0, assetSyncIntervalMs: 0,
      tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, root = '/api/research/binance-lighter-cost';
    assert.equal((await fetch(origin + root)).status, 401);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'cost-research-fixture' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
    const request = (suffix = '', method = 'GET', body, extra = {}) => fetch(origin + root + suffix, { method,
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const initial = await request(); assert.equal(initial.status, 200);
    assert.equal((await initial.json()).execution.liveAvailable, false);
    assert.equal((await request('/start', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('', 'GET', undefined, { Origin: 'https://other.invalid' })).status, 403);
    assert.equal((await request('', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request('?mode=live')).status, 400);
    assert.equal((await request('/start', 'POST', { mode: 'live' })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: { ...config(), mode: 'live' } })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: { ...config(), notionalPerLeg: '' } })).status, 400);
    const updated = await request('/config', 'PUT', { config: { ...config(), notionalPerLeg: 500 } });
    assert.equal(updated.status, 200); assert.equal((await updated.json()).config.notionalPerLeg, 500);
    assert.equal((await request('/stop', 'POST', {})).status, 200);
    assert.equal((await request('/report')).status, 200);
    assert.equal((await request('/report/00000000-0000-4000-8000-000000000000')).status, 404);
    await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken } });
    assert.equal((await request()).status, 401);
  } finally { await app?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test('actual status stays small while per-scenario details and full exports negotiate gzip', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'binance-lighter-payload-'));
  let app;
  try {
    const engine = new CostLabEngine(config(), { now: () => base, mono: () => 100 });
    engine.stop(); const report = engine.report();
    for (const scenario of report.scenarios) {
      scenario.stats.completed = 20;
      scenario.history = Array.from({ length: 300 }, (_, i) => ({ at: base + i, costPer10000: 1.5, modeledCostPer10000: null }));
      scenario.recentRounds = Array.from({ length: 20 }, (_, round) => ({ id: `${report.sessionId}:${scenario.id}:${round}`,
        startedAt: base, endedAt: base + 1000, outcome: 'completed', reason: null, quantity: 0.001,
        binanceTurnover: 160, fees: 0, tradingPnl: -0.024, tradingCost: 0.024, costPer10000: 1.5,
        fundingScenarioCost: null, modeledCostPer10000: null,
        fills: Array.from({ length: 48 }, (_, i) => ({ id: `${report.sessionId}:${scenario.id}:${round}:${i}`,
          clientOrderId: `${report.sessionId}:${scenario.id}:${round}:order-${i}`,
          venue: i % 2 ? 'lighter' : 'binance', symbol: scenario.symbol, side: i % 4 < 2 ? 'buy' : 'sell',
          phase: i < 24 ? 'entry' : 'exit', quantity: 0.00001, price: 80000.1, notional: 0.800001,
          fee: 0, at: base + i, sourceAt: base + i, model: 'delayed_visible_depth_ioc' })) }));
    }
    const fullBytes = Buffer.byteLength(JSON.stringify(report));
    assert.ok(fullBytes > 3_000_000 && fullBytes < 8 * 1024 * 1024, `expected realistic bounded report, got ${fullBytes}`);
    const directory = join(dataDir, 'binance-lighter-cost'); mkdirSync(directory);
    writeFileSync(join(directory, 'session.json'), JSON.stringify({ schema: 1, clean: true, report }));
    app = await createApp({ dataDir, initialPassword: 'cost-research-payload-fixture', refreshInterval: 0, assetSyncIntervalMs: 0,
      tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, root = '/api/research/binance-lighter-cost';
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'cost-research-payload-fixture' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const request = (suffix, encoding = 'gzip') => fetch(origin + root + suffix, { headers: { Cookie: cookie, Origin: origin, 'Accept-Encoding': encoding } });
    const summary = await request('');
    assert.equal(summary.status, 200); assert.equal(summary.headers.get('content-encoding'), 'gzip');
    assert.equal(summary.headers.get('cache-control'), 'no-store'); assert.match(summary.headers.get('vary'), /Accept-Encoding/);
    const summaryText = await summary.text(); assert.ok(Buffer.byteLength(summaryText) < 64 * 1024);
    const summaryView = JSON.parse(summaryText);
    assert.equal(summaryView.report.detailLevel, 'summary');
    assert.equal(summaryView.report.scenarios.length, 12);
    assert.ok(summaryView.report.scenarios.every(row => row.history.length === 0 && row.recentRounds.length === 0));
    const id = report.scenarios[0].id;
    const detail = await request(`/scenario/${report.sessionId}/${id}`);
    assert.equal(detail.status, 200); assert.equal(detail.headers.get('content-encoding'), 'gzip');
    const detailText = await detail.text(); assert.ok(Buffer.byteLength(detailText) < 600 * 1024);
    const detailView = JSON.parse(detailText);
    assert.equal(detailView.sessionId, report.sessionId);
    assert.equal(detailView.scenario.recentRounds.length, 20); assert.equal(detailView.scenario.history.length, 300);
    assert.equal(detailView.scenario.recentRounds[0].fills.length, 48);
    assert.equal((await request(`/scenario/${randomUUID()}/${id}`)).status, 409);
    assert.equal((await request(`/scenario/${report.sessionId}/BTC-buy-9999`)).status, 404);
    const exported = await request('/report'); assert.equal(exported.headers.get('content-encoding'), 'gzip');
    const exportedView = await exported.json();
    assert.deepEqual(exportedView.report, report, 'full export retains every recorded round and fill');
    const plain = await request('', 'gzip;q=0, identity');
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.deepEqual((await plain.json()).report, summaryView.report);
  } finally { await app?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

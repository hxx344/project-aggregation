import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createBinanceLighterCost, hasUnresolvedCostReport } from '../server/research/binance-lighter-cost.mjs';
import { CostLabEngine, DEFAULT_COST_CONFIG } from '../server/research/binance-lighter-core.mjs';
import { createApp } from '../server/app.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const clone = value => structuredClone(value);
const base = Date.parse('2026-11-05T06:00:00Z');
const config = () => clone(DEFAULT_COST_CONFIG);
const legacyConfig = () => ({ schema: 1, symbols: ['BTC', 'ETH'], notionalPerLeg: 1500, latencyScenarios: [300, 600, 1000],
  makerWaitMs: 15000, holdMs: 5000, hedgeWaitMs: 2000, cooldownMs: 3000, maxBookAgeMs: 1000,
  maxSourceAgeMs: 2000, maxPairSkewMs: 750, maxHedgeSlippageBps: 5, queueMultiplier: 1,
  binanceMakerFeeBps: 0.1, lighterTakerFeeBps: 0.2, fundingCostBpsPerHour: null });
function legacyReport(sessionId = randomUUID()) {
  return { schema: 1, sessionId, sessionConfig: legacyConfig(), mode: 'paper', startedAt: base - 5000, updatedAt: base - 1000,
    stopped: false, interrupted: false, markets: [], books: [], assumptions: [],
    scenarios: [{ id: 'BTC-buy-300', symbol: 'BTC', direction: 'buy', latencyMs: 300, status: 'hedge_entry', reason: null,
      task: { id: 'legacy-task', binanceQuantity: 0.01, lighterQuantity: -0.006, residualQuantity: 0.004 },
      stats: { completed: 2, unresolved: 0, binanceTurnover: 1000, fees: 0.16, tradingPnl: -2, tradingCost: 2.16 },
      recentRounds: [], history: [] }] };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  throw new Error('研究状态未按预期完成');
}
function fakeEngine(settings, { sessionId, emit }) {
  const view = { schema: 2, strategy: 'inventory_quotes', sessionId, sessionConfig: clone(settings), mode: 'paper', startedAt: base, updatedAt: base,
    stopped: false, interrupted: false, markets: [], books: [], scenarios: [], assumptions: [] };
  return {
    setMarkets(value) { view.markets = value; },
    onBook(value) { view.books = [value]; },
    onTrade() {
      view.scenarios = [{ id: 'BTC-inventory-300', symbol: 'BTC', latencyMs: 300, status: 'hedging', reason: null,
        inventory: { binanceQuantity: 0.01, lighterQuantity: 0, residualQuantity: 0.01, projectedResidualQuantity: 0,
          binanceAveragePrice: 80000, lighterAveragePrice: null, binanceNotional: 800, utilization: 0.16, limitNotional: 5000 },
        quotes: { buy: null, sell: null }, hedge: { id: 'hedge', side: 'sell', quantity: 0.01, dueAt: base + 300, attempt: 1 },
        stats: { quoteUpdates: 1, makerFills: 1, hedgeFills: 0, hedgeFailures: 0, binanceTurnover: 800, lighterTurnover: 0,
          fees: 0.08, realizedPnl: 0, unrealizedPnl: null, netPnl: null, markedCost: null, costPer10000: null,
          fundingScenarioCost: null, modeledCostPer10000: null },
        valuation: { at: base, valid: false, reason: 'book_unavailable', binanceMark: null, lighterMark: null },
        recentFills: [], history: [], events: [] }];
      emit({ type: 'fill' });
    },
    invalidate() {}, onStatus() {}, tick() {},
    stop() { view.stopped = true; for (const row of view.scenarios) row.status = 'stopped'; },
    report(options = {}) {
      const selected = options.scenarioId ? view.scenarios.filter(row => row.id === options.scenarioId) : view.scenarios;
      return clone({ ...view, detailLevel: options.summary ? 'summary' : options.scenarioId ? 'scenario' : 'full',
        scenarios: options.summary ? selected.map(row => ({ ...row, recentFills: [], history: [], events: [] })) : selected });
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
    assert.deepEqual(manager.state().execution, { mode: 'paper', liveAvailable: false, version: 2 });
    const [a, b] = await Promise.all([manager.start(), manager.start()]);
    assert.equal(a.report.sessionId, b.report.sessionId);
    await until(() => f.sources.length === 1);
    assert.equal(f.reads(), 1);
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'session-v2.json'))).clean, false);
    await manager.stop();
    const stopped = manager.state();
    f.sources[0].callbacks.onTrade({});
    assert.deepEqual(manager.state().report, stopped.report, 'late old-generation events cannot change a stopped report');
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'session-v2.json'))).clean, true);
  } finally { await manager.close(); f.cleanup(); }
});

test('partial simulated exposure persists immediately, stop preserves it, archive is explicit', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({});
    const persisted = JSON.parse(readFileSync(join(manager.directory, 'session-v2.json'))).report;
    assert.equal(persisted.scenarios[0].inventory.binanceQuantity, 0.01);
    assert.equal(persisted.scenarios[0].stats.binanceTurnover, 800);
    await manager.stop();
    assert.equal(manager.state().report.scenarios[0].inventory.residualQuantity, 0.01);
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
    assert.equal(manager.state().archives[0].hasExposure, true);
    assert.equal(manager.state().archives[0].makerFills, 1);
  } finally { await manager.close(); f.cleanup(); }
});

test('archive interruption is separate from inventory exposure and fill count', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({}); await manager.stop(); await manager.close();
    const file = join(manager.directory, 'session-v2.json');
    const saved = JSON.parse(readFileSync(file)); saved.report.interrupted = true; writeFileSync(file, JSON.stringify(saved));
    manager = f.create(); await manager.initialize(); await manager.archive();
    assert.equal(manager.state().archives[0].hasExposure, true);
    assert.equal(manager.state().archives[0].makerFills, 1);
    assert.equal(manager.state().archives[0].interrupted, true);
  } finally { await manager.close(); f.cleanup(); }
});

test('unclean crash before first fill remains interrupted across repeated restarts', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start();
    const dirty = readFileSync(join(manager.directory, 'session-v2.json'));
    await manager.close();
    writeFileSync(join(manager.directory, 'session-v2.json'), dirty);
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
    denied = 'session-v2.json';
    await assert.rejects(manager.start(), /fixture_disk_full/);
    assert.equal(f.reads(), 0); assert.equal(manager.state().enabled, false); assert.equal(manager.state().report, null);
    denied = 'config-v2.json';
    await assert.rejects(manager.save({ ...config(), orderNotional: 2000 }), /fixture_disk_full/);
    assert.equal(manager.state().config.orderNotional, config().orderNotional);
    denied = ''; await manager.start(); await until(() => f.sources.length === 1);
    denied = 'session-v2.json'; f.sources[0].callbacks.onTrade({});
    assert.equal(manager.state().enabled, false); assert.equal(manager.state().state, 'fault');
    assert.equal(manager.state().report.scenarios[0].inventory.residualQuantity, 0.01);
  } finally { denied = ''; await manager.close(); f.cleanup(); }
});

test('real filesystem rejection cannot start feeds before the initial marker is durable', async () => {
  const f = fixture(); const manager = f.create();
  try {
    await manager.initialize();
    const obstruction = join(manager.directory, 'session-v2.json'); mkdirSync(obstruction);
    await assert.rejects(manager.start(), /invalid_research_file/);
    assert.equal(manager.state().enabled, false); assert.equal(manager.state().report, null);
    assert.equal(f.reads(), 0); assert.equal(f.sources.length, 0);
    rmSync(obstruction, { recursive: true });
    await manager.start(); await until(() => f.sources.length === 1);
    assert.equal(JSON.parse(readFileSync(obstruction)).schema, 2);
    assert.equal(JSON.parse(readFileSync(obstruction)).clean, false);
  } finally { await manager.close(); f.cleanup(); }
});

test('failed archive publication or session clearing retains inventory and supports idempotent retry', async () => {
  let failAt = '';
  const f = fixture({ write(file, value) {
    if (failAt === 'index' && file.endsWith('archives-v2.json')
      || failAt === 'clear' && file.endsWith('session-v2.json') && value.report === null) throw new Error('fixture_archive_failure');
    writeFileSync(file, JSON.stringify(value));
  } });
  let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({}); await manager.stop();
    const original = manager.report().report;
    failAt = 'index'; await assert.rejects(manager.archive(), /fixture_archive_failure/);
    assert.deepEqual(manager.report().report, original); assert.equal(manager.state().archives.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(manager.directory, 'session-v2.json'))).report, original);
    failAt = 'clear'; await assert.rejects(manager.archive(), /fixture_archive_failure/);
    assert.deepEqual(manager.report().report, original); assert.equal(manager.state().archives.length, 1);
    await manager.close(); failAt = ''; manager = f.create(); await manager.initialize();
    await assert.rejects(manager.start(), error => error.status === 409);
    await manager.archive();
    assert.equal(manager.state().report, null); assert.equal(manager.state().archives.length, 1);
    assert.deepEqual(manager.report(original.sessionId).report, original);
  } finally { failAt = ''; await manager.close(); f.cleanup(); }
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
    writeFileSync(join(manager.directory, 'session-v2.json'), damaged);
    manager = f.create(); await manager.initialize();
    assert.equal(manager.state().state, 'fault');
    await assert.rejects(manager.start(), error => error.status === 409);
    await assert.rejects(manager.stop(), error => error.status === 409);
    await assert.rejects(manager.archive(), error => error.status === 409);
    assert.equal(readFileSync(join(manager.directory, 'session-v2.json'), 'utf8'), damaged);
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

test('legacy config migration is idempotent and every legacy file remains byte-identical', async () => {
  const f = fixture(); let manager = f.create();
  try {
    mkdirSync(join(manager.directory, 'archives'), { recursive: true });
    const oldCurrent = legacyReport(), oldArchive = { ...legacyReport(), stopped: true };
    const legacyFiles = new Map([
      ['config.json', JSON.stringify(legacyConfig(), null, 2) + '\n'],
      ['session.json', JSON.stringify({ schema: 1, clean: false, report: oldCurrent }, null, 2) + '\n'],
      ['archives.json', JSON.stringify({ schema: 1, sessions: [{ sessionId: oldArchive.sessionId, startedAt: oldArchive.startedAt,
        endedAt: oldArchive.updatedAt, completed: 2, unresolved: 1, interrupted: false }] })],
      [join('archives', `${oldArchive.sessionId}.json`), JSON.stringify(oldArchive, null, 2)],
    ]);
    for (const [file, body] of legacyFiles) writeFileSync(join(manager.directory, file), body);
    await manager.initialize();
    assert.equal(manager.state().schema, 2); assert.equal(manager.state().report, null);
    assert.equal(manager.state().config.orderNotional, 1500);
    assert.equal(manager.state().config.binanceMakerFeeBps, 0.1);
    for (const key of ['notionalPerLeg', 'makerWaitMs', 'holdMs', 'cooldownMs']) assert.equal(Object.hasOwn(manager.state().config, key), false);
    assert.equal(manager.state().legacySession.interrupted, true);
    assert.equal(manager.state().legacySession.completed, 2);
    assert.equal(manager.state().legacySession.unresolved, 1);
    assert.deepEqual(manager.state().legacySession.exposures, [{ id: 'BTC-buy-300', symbol: 'BTC', binanceQuantity: 0.01, lighterQuantity: -0.006, residualQuantity: 0.004 }]);
    assert.deepEqual(manager.report(oldCurrent.sessionId).report, oldCurrent);
    assert.deepEqual(manager.report(oldArchive.sessionId).report, oldArchive);
    assert.equal(manager.state().archives[0].schema, 1);
    await manager.save({ ...manager.state().config, orderNotional: 700, inventorySkewBps: 3 });
    await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({}); await manager.stop(); await manager.archive();
    assert.deepEqual(manager.state().archives.map(row => row.schema), [1, 2]);
    const newer = manager.state().archives[1];
    assert.equal(manager.report(newer.sessionId).report.schema, 2);
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'archives-v2.json'))).sessions.length, 1);
    await manager.close(); manager = f.create(); await manager.initialize();
    assert.equal(manager.state().config.orderNotional, 700); assert.equal(manager.state().config.inventorySkewBps, 3);
    assert.equal(manager.state().legacySession.updatedAt, oldCurrent.updatedAt);
    assert.deepEqual(manager.report(oldCurrent.sessionId).report, oldCurrent);
    for (const [file, body] of legacyFiles) assert.equal(readFileSync(join(manager.directory, file), 'utf8'), body, file);
  } finally { await manager.close(); f.cleanup(); }
});

test('legacy corruption blocks migration before publishing v2 config and never overwrites evidence', async () => {
  for (const [file, body] of [['config.json', '{broken-legacy'], ['session.json', '{broken-legacy'], ['archives.json', '{broken-legacy'],
    ['config.json', 'null'], ['session.json', 'false'], ['archives.json', 'null']]) {
    const f = fixture(); const manager = f.create();
    try {
      mkdirSync(manager.directory, { recursive: true });
      if (file !== 'config.json') writeFileSync(join(manager.directory, 'config.json'), JSON.stringify(legacyConfig()));
      writeFileSync(join(manager.directory, file), body);
      await manager.initialize();
      assert.equal(manager.state().state, 'fault'); assert.match(manager.state().error, /旧版记录/);
      assert.equal(existsSync(join(manager.directory, 'config-v2.json')), false);
      await assert.rejects(manager.start(), error => error.status === 409);
      await assert.rejects(manager.archive(), error => error.status === 409);
      await manager.close();
      assert.equal(readFileSync(join(manager.directory, file), 'utf8'), body);
    } finally { await manager.close(); f.cleanup(); }
  }
});

test('stopped inventory, hedge, blocked and interrupted states all require explicit archival', () => {
  const report = { schema: 2, stopped: true, interrupted: false, scenarios: [{ status: 'stopped', hedge: null,
    inventory: { binanceQuantity: 0, lighterQuantity: 0, residualQuantity: 0, projectedResidualQuantity: 0 } }] };
  assert.equal(hasUnresolvedCostReport(report), false);
  for (const name of ['binanceQuantity', 'lighterQuantity', 'residualQuantity', 'projectedResidualQuantity']) {
    const exposed = clone(report); exposed.scenarios[0].inventory[name] = 1e-13;
    assert.equal(hasUnresolvedCostReport(exposed), true, `small ${name} is still retained inventory`);
  }
  const hedging = clone(report); hedging.scenarios[0].hedge = { id: 'pending' }; assert.equal(hasUnresolvedCostReport(hedging), true);
  const blocked = clone(report); blocked.scenarios[0].status = 'blocked'; assert.equal(hasUnresolvedCostReport(blocked), true);
  assert.equal(hasUnresolvedCostReport({ ...report, interrupted: true }), true);
  assert.equal(hasUnresolvedCostReport(legacyReport()), true);
});

test('v2 schema corruption and archive identity mismatch cannot produce another session report', async () => {
  const f = fixture(); let manager = f.create();
  try {
    await manager.initialize(); await manager.start(); await until(() => f.sources.length === 1);
    f.sources[0].callbacks.onTrade({}); await manager.stop(); await manager.archive();
    const archive = manager.state().archives[0];
    const archiveFile = join(manager.directory, 'archives-v2', `${archive.sessionId}.json`);
    const original = JSON.parse(readFileSync(archiveFile));
    writeFileSync(archiveFile, JSON.stringify({ ...original, sessionId: randomUUID() }));
    assert.throws(() => manager.report(archive.sessionId), error => error.status === 503);
    await manager.close();
    const malformed = clone(original); malformed.scenarios[0].inventory.binanceQuantity = '0';
    const file = join(manager.directory, 'session-v2.json'), body = JSON.stringify({ schema: 2, clean: true, report: malformed });
    writeFileSync(file, body);
    manager = f.create(); await manager.initialize();
    assert.equal(manager.state().state, 'fault'); await assert.rejects(manager.start(), error => error.status === 409);
    assert.equal(readFileSync(file, 'utf8'), body);
  } finally { await manager.close(); f.cleanup(); }
});

test('real inventory fills persist mid-hedge and dirty restart preserves original evidence without resuming', async () => {
  let time = 0, sequence = 0;
  const markets = ['binance', 'lighter'].map(venue => ({ venue, symbol: 'BTC', nativeSymbol: venue === 'binance' ? 'BTCUSDC' : 'BTC',
    marketId: venue === 'lighter' ? 1 : null, quote: 'USDC', priceUnit: venue === 'binance' ? 'USDC' : 'USD', settlement: 'USDC',
    status: 'active', multiplier: 1, tickSize: 0.01, quantityStep: 0.01, minQuantity: 0.01, minNotional: 1, observedAt: base }));
  const f = fixture({ now: () => base + time, mono: () => time, discover: async () => markets,
    engineFactory: (settings, options) => new CostLabEngine(settings, options) });
  let manager = f.create();
  try {
    await manager.initialize();
    await manager.save({ ...config(), symbols: ['BTC'], latencyScenarios: [300], orderNotional: 100, maxInventoryNotional: 500,
      maxUnhedgedNotional: 500, binanceMakerFeeBps: 1 });
    await manager.start(); await until(() => f.sources.length === 1);
    const source = f.sources[0].callbacks;
    for (const venue of ['binance', 'lighter']) source.onBook({ venue, symbol: 'BTC', nativeSymbol: venue === 'binance' ? 'BTCUSDC' : 'BTC',
      bids: [[100, 0.1], [99, 10]], asks: [[101, 0.1], [102, 10]],
      sourceAt: base + time, receivedAt: base + time, receivedMono: time, sequence: String(++sequence) });
    const trade = quantity => source.onTrade({ venue: 'binance', symbol: 'BTC', price: 100, quantity, buyerMaker: true,
      sourceAt: base + time, receivedAt: base + time, receivedMono: time, sequence: String(++sequence) });
    trade(0);
    assert.ok(manager.state().report.scenarios[0].quotes.buy); assert.ok(manager.state().report.scenarios[0].quotes.sell);
    time = 1; trade(0.6);
    const file = join(manager.directory, 'session-v2.json'), bytes = readFileSync(file);
    const beforeCrash = JSON.parse(bytes).report, row = beforeCrash.scenarios[0];
    assert.equal(row.inventory.binanceQuantity, 0.5); assert.equal(row.inventory.lighterQuantity, 0);
    assert.equal(row.inventory.residualQuantity, 0.5); assert.equal(row.hedge.quantity, 0.5);
    assert.equal(row.stats.binanceTurnover, 50); assert.equal(row.stats.fees, 0.005); assert.equal(row.recentFills.length, 1);
    await manager.close(); writeFileSync(file, bytes);
    time = 10000;
    for (let restart = 0; restart < 2; restart++) {
      manager = f.create(); await manager.initialize();
      const recovered = manager.report().report, restored = recovered.scenarios[0];
      assert.equal(manager.state().enabled, false); assert.equal(recovered.stopped, true); assert.equal(recovered.interrupted, true);
      assert.equal(recovered.updatedAt, beforeCrash.updatedAt); assert.equal(restored.valuation.at, row.valuation.at);
      assert.deepEqual(restored.inventory, row.inventory); assert.deepEqual(restored.stats, row.stats);
      assert.deepEqual(restored.hedge, row.hedge); assert.deepEqual(restored.recentFills, row.recentFills);
      assert.deepEqual(restored.quotes, { buy: null, sell: null });
      await assert.rejects(manager.start(), error => error.status === 409);
      await manager.close(); assert.deepEqual(readFileSync(file), bytes);
    }
    assert.equal(f.sources.length, 1);
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
    assert.equal((await request('/config', 'PUT', { config: { ...config(), orderNotional: '' } })).status, 400);
    const updated = await request('/config', 'PUT', { config: { ...config(), orderNotional: 500 } });
    assert.equal(updated.status, 200); assert.equal((await updated.json()).config.orderNotional, 500);
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
      scenario.stats.makerFills = 100;
      scenario.history = Array.from({ length: 300 }, (_, i) => ({ at: base + i, costPer10000: i % 3 ? 1.5 : null,
        modeledCostPer10000: null, binanceQuantity: 0.001, residualQuantity: 0 }));
      scenario.recentFills = Array.from({ length: 200 }, (_, i) => ({ id: `${report.sessionId}:${scenario.id}:${i}`,
          clientOrderId: `${report.sessionId}:${scenario.id}:order-${i}`,
          venue: i % 2 ? 'lighter' : 'binance', symbol: scenario.symbol, side: i % 4 < 2 ? 'buy' : 'sell',
          phase: i % 2 ? 'hedge' : 'quote', quantity: 0.00001, price: 80000.1, notional: 0.800001,
          fee: 0, at: base + i, sourceAt: base + i, model: 'delayed_visible_depth_ioc' }));
      scenario.events = Array.from({ length: 30 }, (_, i) => ({ at: base + i, type: 'quote', reason: 'inventory_refresh' }));
    }
    const fullBytes = Buffer.byteLength(JSON.stringify(report));
    assert.ok(fullBytes > 500_000 && fullBytes < 8 * 1024 * 1024, `expected realistic bounded report, got ${fullBytes}`);
    const directory = join(dataDir, 'binance-lighter-cost'); mkdirSync(directory);
    writeFileSync(join(directory, 'session-v2.json'), JSON.stringify({ schema: 2, clean: true, report }));
    const legacy = legacyReport(), archivedLegacy = { ...legacyReport(), stopped: true };
    const archivedNew = { ...clone(report), sessionId: randomUUID() };
    mkdirSync(join(directory, 'archives')); mkdirSync(join(directory, 'archives-v2'));
    writeFileSync(join(directory, 'session.json'), JSON.stringify({ schema: 1, clean: false, report: legacy }));
    writeFileSync(join(directory, 'archives.json'), JSON.stringify({ schema: 1, sessions: [{ sessionId: archivedLegacy.sessionId,
      startedAt: archivedLegacy.startedAt, endedAt: archivedLegacy.updatedAt, completed: 2, unresolved: 1, interrupted: false }] }));
    writeFileSync(join(directory, 'archives', `${archivedLegacy.sessionId}.json`), JSON.stringify(archivedLegacy));
    writeFileSync(join(directory, 'archives-v2.json'), JSON.stringify({ schema: 2, sessions: [{ schema: 2, sessionId: archivedNew.sessionId,
      startedAt: archivedNew.startedAt, endedAt: archivedNew.updatedAt, makerFills: 600, hasExposure: false, interrupted: false }] }));
    writeFileSync(join(directory, 'archives-v2', `${archivedNew.sessionId}.json`), JSON.stringify(archivedNew));
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
    assert.equal(summaryView.error, null);
    assert.equal(summaryView.report.detailLevel, 'summary');
    assert.equal(summaryView.report.scenarios.length, 6);
    assert.deepEqual(summaryView.archives.map(row => row.schema), [1, 2]);
    assert.equal(summaryView.legacySession.sessionId, legacy.sessionId);
    assert.ok(summaryView.report.scenarios.every(row => row.history.length === 0 && row.recentFills.length === 0 && row.events.length === 0));
    const id = report.scenarios[0].id;
    const detail = await request(`/scenario/${report.sessionId}/${id}`);
    assert.equal(detail.status, 200); assert.equal(detail.headers.get('content-encoding'), 'gzip');
    const detailText = await detail.text(); assert.ok(Buffer.byteLength(detailText) < 600 * 1024);
    const detailView = JSON.parse(detailText);
    assert.equal(detailView.sessionId, report.sessionId);
    assert.equal(detailView.scenario.recentFills.length, 200); assert.equal(detailView.scenario.history.length, 300);
    assert.equal(detailView.scenario.events.length, 30);
    assert.equal(detailView.scenario.history[0].costPer10000, null);
    assert.equal((await request(`/scenario/${randomUUID()}/${id}`)).status, 409);
    assert.equal((await request(`/scenario/${archivedNew.sessionId}/${id}`)).status, 409);
    assert.equal((await request(`/scenario/${legacy.sessionId}/${id}`)).status, 409);
    assert.equal((await request(`/scenario/${report.sessionId}/BTC-inventory-9999`)).status, 404);
    assert.equal((await request(`/scenario/${report.sessionId}/BTC-buy-300`)).status, 404);
    const exported = await request('/report'); assert.equal(exported.headers.get('content-encoding'), 'gzip');
    const exportedView = await exported.json();
    assert.deepEqual(exportedView.report, report, 'full export retains every recorded fill, history gap and event');
    for (const source of [legacy, archivedLegacy, archivedNew]) {
      const downloaded = await request(`/report/${source.sessionId}`);
      assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await downloaded.json()).report, source);
    }
    const plain = await request('', 'gzip;q=0, identity');
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.deepEqual((await plain.json()).report, summaryView.report);
  } finally { await app?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

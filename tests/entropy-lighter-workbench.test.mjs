import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createEntropyLighterResearch, strictLabConfig } from '../server/research/entropy-lighter.mjs';
import { createApp } from '../server/app.mjs';
import { HttpError } from '../server/http-common.mjs';

const config = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const fixtureDir = () => mkdtempSync(join(tmpdir(), 'entropy-workbench-'));
async function until(predicate) {
  for (let i = 0; i < 150; i++) { const value = predicate(); if (value) return value; await delay(20); }
  throw new Error('Expected research state did not arrive');
}
function fakeWorker({ ignoreTerm = false } = {}) {
  const worker = new EventEmitter(); worker.pid = 12345; worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  worker.signals = [];
  worker.kill = (signal) => { worker.signals.push(signal); if (!(signal === 'SIGTERM' && ignoreTerm)) setTimeout(() => worker.emit('close', 0), 10); return true; };
  return worker;
}

test('HTTP configuration accepts only known data fields and never process/path overrides', () => {
  assert.deepEqual(strictLabConfig(config), config);
  assert.throws(() => strictLabConfig({ ...config, command: 'node' }), /不支持/);
  assert.throws(() => strictLabConfig({ ...config, simulation: { ...config.simulation, privateKey: 'example' } }), /不支持/);
  const bad = structuredClone(config); bad.simulation.latencyScenarios[0].cwd = '/tmp';
  assert.throws(() => strictLabConfig(bad), /不支持/);
});

test('managed real CLI merges concurrent starts, publishes heartbeat and persists stop across runtime restart', async () => {
  const directory = fixtureDir(); let manager;
  try {
    manager = createEntropyLighterResearch({ dataDir: directory, log: silent }); await manager.initialize();
    writeFileSync(join(manager.directory, 'cooldowns.json'), JSON.stringify(Object.fromEntries(['entropy', 'lighter', 'binance'].map((v) => [v, Date.now() + 600000]))));
    await Promise.all([manager.start(), manager.start()]);
    await until(() => manager.state().state === 'running');
    const first = manager.state(); assert.equal(first.enabled, true); assert.equal(first.report.mode, 'research'); assert.equal(first.stale, false);
    assert.equal(first.report.sessionConfig.region, 'Tokyo');
    assert.equal(Object.hasOwn(first.report, 'pid'), false);
    await assert.rejects(manager.save(config), /先停止/);
    await manager.stop(); assert.equal(manager.state().state, 'stopped');
    assert.equal(manager.state().report.stopped, true);
    await manager.close();
    manager = createEntropyLighterResearch({ dataDir: directory, enabledByDefault: true, log: silent }); await manager.initialize();
    assert.equal(manager.state().enabled, false); assert.equal(manager.state().state, 'stopped');
    const next = structuredClone(config); next.region = 'Tokyo test'; await manager.save(next);
    assert.equal(JSON.parse(readFileSync(join(manager.directory, 'config.json'))).region, 'Tokyo test');
    assert.equal(manager.state().report.sessionConfig.region, 'Tokyo', 'old reports retain their original session parameters after configuration edits');
  } finally { await manager?.close(); rmSync(directory, { recursive: true }); }
});

test('crash retries have a finite budget and a manual start resets the failed cycle', async () => {
  const directory = fixtureDir(); let launches = 0;
  const manager = createEntropyLighterResearch({ dataDir: directory, log: silent, retryDelays: [5, 10], launch() {
    launches++; const worker = fakeWorker(); setTimeout(() => worker.emit('close', 1), 2); return worker;
  } });
  try {
    await manager.initialize(); await manager.start();
    await until(() => manager.state().state === 'fault'); assert.equal(launches, 3);
    await delay(30); assert.equal(launches, 3);
    await manager.start(); await until(() => launches > 3); await manager.stop();
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('stop escalates an unresponsive child, and queued writes recheck session authorization', async () => {
  const directory = fixtureDir(), workers = [];
  const manager = createEntropyLighterResearch({ dataDir: directory, log: silent, stopGraceMs: 20, killWaitMs: 20, launch() { const worker = fakeWorker({ ignoreTerm: true }); workers.push(worker); return worker; } });
  try {
    await manager.initialize(); await manager.start();
    const stopping = manager.stop(); let active = true;
    const restarting = manager.start(() => { if (!active) throw new HttpError(401, 'expired'); }); active = false;
    await stopping; await assert.rejects(restarting, /expired/);
    assert.deepEqual(workers[0].signals, ['SIGTERM', 'SIGKILL']); assert.equal(workers.length, 1);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('oversized or corrupt snapshots fail visibly without exposing raw paths or overwriting evidence', async () => {
  const directory = fixtureDir(); const manager = createEntropyLighterResearch({ dataDir: directory, log: silent });
  try {
    await manager.initialize();
    writeFileSync(join(manager.directory, 'report.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
    assert.equal(manager.state().report, null); assert.match(manager.state().error, /无法读取/);
    writeFileSync(join(manager.directory, 'report.json'), JSON.stringify({ session: 'history', counts: {}, heartbeatAt: new Date(0).toISOString(), pid: 99, path: '/private', mode: 'research' }));
    const snapshot = manager.state(); assert.equal(snapshot.stale, true); assert.equal(snapshot.report.session, 'history');
    assert.equal(snapshot.report.pid, undefined); assert.equal(snapshot.report.path, undefined);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('invalid persisted configuration is preserved and cannot start until repaired', async () => {
  const directory = fixtureDir(); mkdirSync(join(directory, 'entropy-lighter')); writeFileSync(join(directory, 'entropy-lighter/config.json'), '{invalid');
  const manager = createEntropyLighterResearch({ dataDir: directory, enabledByDefault: true, log: silent });
  try {
    await manager.initialize(); assert.equal(manager.state().state, 'fault');
    await assert.rejects(manager.start(), /有效研究配置/); assert.equal(readFileSync(join(manager.directory, 'config.json'), 'utf8'), '{invalid');
    await manager.save(config); assert.equal(manager.state().state, 'stopped');
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('saving a valid stopped configuration also repairs invalid persisted wanted state', async () => {
  const directory = fixtureDir(); mkdirSync(join(directory, 'entropy-lighter'));
  writeFileSync(join(directory, 'entropy-lighter/control.json'), JSON.stringify({ schema: 1, enabled: 'invalid' }));
  let manager = createEntropyLighterResearch({ dataDir: directory, log: silent });
  try {
    await manager.initialize(); assert.equal(manager.state().state, 'fault');
    await manager.save(config); await manager.close();
    manager = createEntropyLighterResearch({ dataDir: directory, enabledByDefault: true, log: silent }); await manager.initialize();
    assert.equal(manager.state().state, 'stopped'); assert.equal(manager.state().enabled, false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('actual workbench research API requires login, same origin and CSRF and controls the real collector', async () => {
  const directory = fixtureDir(); let app;
  try {
    app = await createApp({ dataDir: directory, initialPassword: 'research-fixture-password', refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/research/entropy-lighter';
    for (const suffix of ['', '/report', '/config', '/start', '/stop']) assert.equal((await fetch(origin + route + suffix)).status, 401);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'research-fixture-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
    const request = (suffix = '', method = 'GET', body, overrides = {}) => fetch(origin + route + suffix, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...overrides }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('/start', 'POST', {}, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/start', 'POST', {}, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request('', 'GET', undefined, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request('?file=/tmp')).status, 400);
    assert.equal((await request('/start', 'POST', { command: 'node' })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: { ...config, dataDir: '/tmp' } })).status, 400);
    assert.equal((await request('/config', 'PUT', { config })).status, 200);
    writeFileSync(join(directory, 'entropy-lighter/cooldowns.json'), JSON.stringify(Object.fromEntries(['entropy', 'lighter', 'binance'].map((v) => [v, Date.now() + 600000]))));
    assert.equal((await request('/start', 'POST', {})).status, 200);
    let running;
    for (let i = 0; i < 100; i++) { running = await (await request()).json(); if (running.state === 'running') break; await delay(25); }
    assert.equal(running.state, 'running'); assert.equal(running.report.mode, 'research');
    assert.equal((await request('/config', 'PUT', { config })).status, 409);
    assert.equal((await request('/report')).status, 200);
    assert.equal((await request('/stop', 'POST', {})).status, 200);
    await fetch(origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken } });
    assert.equal((await request()).status, 401);
  } finally { await app?.close(); rmSync(directory, { recursive: true }); }
});

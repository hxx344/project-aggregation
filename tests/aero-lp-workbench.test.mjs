import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Wallet } from 'ethers';
import { AERO_LP_DEFAULTS, createAeroLp, strictAeroLpConfig } from '../server/automation/aero-lp.mjs';
import { loadCredentialCipher } from '../server/runtime/credentials.mjs';
import { createApp } from '../server/app.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const KEY = '0x' + '11'.repeat(32);
const ADDRESS = new Wallet(KEY).address;
const fixtureDir = () => mkdtempSync(join(tmpdir(), 'aero-lp-workbench-'));
async function until(predicate, message = 'Expected LP state did not arrive', rounds = 150) {
  for (let i = 0; i < rounds; i++) { const value = predicate(); if (value) return value; await delay(20); }
  throw new Error(message);
}
// A child that answers the stop message like cli.mjs does, unless told to hang.
function fakeWorker({ ignoreStop = false } = {}) {
  const worker = new EventEmitter(); worker.pid = 4242; worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  worker.connected = true; worker.sent = []; worker.signals = [];
  const exit = () => { worker.connected = false; setTimeout(() => worker.emit('close', 0), 5); };
  worker.send = (message, callback) => { worker.sent.push(message); if (message.type === 'aero-lp-stop' && !ignoreStop) exit(); callback?.(null); return true; };
  worker.kill = (signal) => { worker.signals.push(signal); if (signal === 'SIGKILL' || !ignoreStop) exit(); return true; };
  return worker;
}
function managerWith(directory, options = {}) {
  const workers = [], launches = [];
  const manager = createAeroLp({ dataDir: directory, ...loadCredentialCipher(directory, silent), log: silent, maintenancePollMs: 20,
    launch: (command, args, spawnOptions) => { launches.push({ command, args, options: spawnOptions }); const worker = fakeWorker(options.worker); workers.push(worker); return worker; },
    ...options.manager });
  return { manager, workers, launches };
}

test('LP configuration accepts only the page parameters with their ranges', () => {
  assert.deepEqual(strictAeroLpConfig(AERO_LP_DEFAULTS), AERO_LP_DEFAULTS);
  for (const extra of [{ keyFile: '/tmp/key' }, { dataDir: '/tmp' }, { privateKey: KEY }, { command: 'node' }]) {
    assert.throws(() => strictAeroLpConfig({ ...AERO_LP_DEFAULTS, ...extra }), /不支持|not supported/);
  }
  for (const bad of [{ rpcUrl: 'http://mainnet.base.org' }, { pool: 'pool' }, { intervalSec: 30 }, { twapSec: 7200 }, { slippageBps: 0 }, { gapBps: 1.5 }, { minDeploy: '1e3' }, { upperPrice: -1 }]) {
    assert.throws(() => strictAeroLpConfig({ ...AERO_LP_DEFAULTS, ...bad }), /LP 参数无效/, JSON.stringify(bad));
  }
  const pool = AERO_LP_DEFAULTS.pool.toLowerCase();
  assert.equal(strictAeroLpConfig({ ...AERO_LP_DEFAULTS, pool }).pool, pool);
  const badChecksum = '0x' + pool.slice(2).replace(/[a-f]/, (c) => c.toUpperCase());
  assert.throws(() => strictAeroLpConfig({ ...AERO_LP_DEFAULTS, pool: badChecksum }), /校验和/);
  const { rpcUrl, ...missing } = AERO_LP_DEFAULTS;
  assert.throws(() => strictAeroLpConfig(missing), /rpcUrl/);
});

test('private key is stored encrypted, handed over IPC only, and never returned', async () => {
  const directory = fixtureDir();
  const { manager, workers, launches } = managerWith(directory);
  try {
    await manager.initialize();
    assert.equal(manager.state().state, 'stopped'); assert.equal(manager.state().enabled, false);
    await assert.rejects(manager.start(), { status: 409 });
    await assert.rejects(manager.setKey('0x1234'), { status: 400 });
    const saved = await manager.setKey(`  ${KEY}\n`);
    assert.equal(saved.wallet, ADDRESS);
    const file = readFileSync(join(directory, 'aero-lp/wallet.json'), 'utf8');
    assert.ok(!file.includes(KEY.slice(2)), 'wallet file holds only ciphertext');
    assert.equal(JSON.parse(file).address, ADDRESS);
    await manager.start();
    assert.equal(launches.length, 1);
    const { args, options } = launches[0];
    assert.deepEqual(args.slice(1), ['run', '--managed', '--config', join(directory, 'aero-lp/config.json'), '--data', join(directory, 'aero-lp')]);
    assert.ok(!JSON.stringify(args).includes(KEY.slice(2)) && !JSON.stringify(options.env).includes(KEY.slice(2)), 'key is not in argv or env');
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
    const worker = workers[0];
    worker.emit('message', { type: 'aero-lp-ready' });
    assert.deepEqual(worker.sent[0], { type: 'aero-lp-key', key: KEY, paused: false });
    worker.emit('message', { type: 'aero-lp-phase', phase: 'sleeping', nextAt: '2026-10-29T00:10:00.000Z' });
    worker.emit('message', { type: 'aero-lp-event', entry: { at: '2026-10-29T00:00:00.000Z', event: 'cycle', price: 0.0025, actions: [] } });
    worker.emit('message', { type: 'aero-lp-event', entry: { at: '2026-10-29T00:00:01.000Z', event: 'skip', reason: 'test' } });
    const running = manager.state();
    assert.equal(running.state, 'running'); assert.equal(running.phase.name, 'sleeping'); assert.equal(running.lastCycle.price, 0.0025);
    assert.deepEqual(running.events.map((e) => e.event), ['skip']);
    assert.ok(!JSON.stringify(running).includes(KEY.slice(2)), 'state never carries the key');
    // A second ready from the same child does not resend the key.
    worker.emit('message', { type: 'aero-lp-ready' });
    assert.equal(worker.sent.filter((m) => m.type === 'aero-lp-key').length, 1);
    await assert.rejects(manager.setKey(KEY), { status: 409 });
    await assert.rejects(manager.clearKey(), { status: 409 });
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('saving parameters while running takes effect at once through a reload', async () => {
  const directory = fixtureDir();
  const { manager, workers } = managerWith(directory);
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    await assert.rejects(manager.save({ ...AERO_LP_DEFAULTS, gapBps: -1 }), { status: 400 });
    assert.equal(workers[0].sent.length, 0);
    const state = await manager.save({ ...AERO_LP_DEFAULTS, gapBps: 120, upperPrice: 0.006 });
    assert.equal(state.config.gapBps, 120);
    assert.deepEqual(workers[0].sent.at(-1), { type: 'aero-lp-reload' });
    assert.equal(JSON.parse(readFileSync(join(directory, 'aero-lp/config.json'), 'utf8')).upperPrice, 0.006);
    await manager.close();
    // The saved parameters and the running choice survive a workbench restart.
    const again = managerWith(directory);
    await again.manager.initialize();
    assert.equal(again.manager.state().config.gapBps, 120); assert.equal(again.manager.state().enabled, true); assert.equal(again.launches.length, 1);
    await again.manager.close();
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('stop is graceful, returns at once and allows replacing then clearing the key', async () => {
  const directory = fixtureDir();
  const { manager, workers } = managerWith(directory);
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    const stopping = await manager.stop();
    assert.equal(stopping.state, 'stopping'); assert.equal(stopping.enabled, false);
    assert.deepEqual(workers[0].sent.at(-1), { type: 'aero-lp-stop' });
    await until(() => manager.state().state === 'stopped');
    const other = '0x' + '22'.repeat(32);
    assert.equal((await manager.setKey(other)).wallet, new Wallet(other).address);
    const cleared = await manager.clearKey();
    assert.equal(cleared.wallet, null); assert.ok(!existsSync(join(directory, 'aero-lp/wallet.json')));
    assert.equal(JSON.parse(readFileSync(join(directory, 'aero-lp/control.json'), 'utf8')).enabled, false);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('stop still halts the child when the run setting cannot be saved', async () => {
  const directory = fixtureDir();
  const { manager, workers } = managerWith(directory);
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    const control = join(directory, 'aero-lp/control.json');
    rmSync(control); mkdirSync(control);
    const stopping = await manager.stop();
    assert.equal(stopping.state, 'stopping'); assert.match(stopping.error, /启停设置保存失败/);
    assert.deepEqual(workers[0].sent.at(-1), { type: 'aero-lp-stop' });
    // The child is gone; the unsaved run setting stays visible as a fault.
    await until(() => manager.state().state === 'fault');
    assert.equal(workers.length, 1);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a hung child is killed after the grace period and is never replaced before it exits', async () => {
  const directory = fixtureDir();
  const { manager, workers } = managerWith(directory, { worker: { ignoreStop: true }, manager: { stopGraceMs: 50, killWaitMs: 20 } });
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    await manager.stop();
    await assert.rejects(manager.start(), { status: 409 });
    await until(() => manager.state().state === 'stopped');
    assert.deepEqual(workers[0].signals, ['SIGKILL']);
    assert.equal(workers.length, 1);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('unexpected exits restart with backoff, then fault', async () => {
  const directory = fixtureDir();
  const { manager, workers } = managerWith(directory, { manager: { retryDelays: [5, 5] } });
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    workers[0].emit('close', 1);
    await until(() => workers.length === 2);
    workers[1].emit('close', 1);
    await until(() => workers.length === 3);
    workers[2].emit('close', 1);
    await until(() => manager.state().state === 'fault');
    assert.match(manager.state().error, /多次退出/);
    await delay(30); assert.equal(workers.length, 3);
    // Replacing the key after a fault leaves the bot stopped instead of a phantom 'starting'.
    const replaced = await manager.setKey('0x' + '22'.repeat(32));
    assert.equal(replaced.state, 'stopped'); assert.equal(replaced.enabled, false); assert.equal(replaced.lastCycle, null);
    assert.equal(JSON.parse(readFileSync(join(directory, 'aero-lp/control.json'), 'utf8')).enabled, false);
    assert.equal(workers.length, 3);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('workbench maintenance pauses transactions in the running child', async () => {
  const directory = fixtureDir(); let maintenance = false;
  const { manager, workers } = managerWith(directory, { manager: { readMaintenance: () => maintenance } });
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    maintenance = true;
    await until(() => workers[0].sent.some((m) => m.type === 'aero-lp-pause' && m.paused === true));
    assert.equal(manager.state().paused, true);
    workers[0].emit('message', { type: 'aero-lp-ready' });
    assert.equal(workers[0].sent.find((m) => m.type === 'aero-lp-key').paused, true);
    maintenance = false;
    await until(() => workers[0].sent.some((m) => m.type === 'aero-lp-pause' && m.paused === false));
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('workbench LP API requires login, same origin and CSRF, and accepts only strict bodies', async () => {
  const directory = fixtureDir(); let app;
  try {
    app = await createApp({ dataDir: directory, initialPassword: 'aero-lp-fixture-password', refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, warmupEnabled: false, logger: silent });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/automation/aero-lp';
    for (const suffix of ['', '/config', '/wallet', '/start', '/stop']) assert.equal((await fetch(origin + route + suffix)).status, 401);
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'aero-lp-fixture-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
    const request = (suffix = '', method = 'GET', body, overrides = {}) => fetch(origin + route + suffix, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...overrides }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('/wallet', 'PUT', { privateKey: KEY }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/wallet', 'PUT', { privateKey: KEY }, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request('', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request('?file=/tmp')).status, 400);
    assert.equal((await request('/start', 'POST', { command: 'node' })).status, 400);
    assert.equal((await request('/start', 'POST', {})).status, 409);
    assert.equal((await request('/config', 'PUT', { config: { ...AERO_LP_DEFAULTS, dataDir: '/tmp' } })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: { ...AERO_LP_DEFAULTS, gapBps: 80 } })).status, 200);
    assert.equal((await request('/wallet', 'PUT', { privateKey: 'not-a-key' })).status, 400);
    assert.equal((await request('/wallet', 'PUT', { privateKey: KEY, address: ADDRESS })).status, 400);
    const stored = await request('/wallet', 'PUT', { privateKey: KEY });
    assert.equal(stored.status, 200);
    const storedText = await stored.text();
    assert.ok(!storedText.includes(KEY.slice(2))); assert.equal(JSON.parse(storedText).wallet, ADDRESS);
    const state = await (await request()).text();
    assert.ok(!state.includes(KEY.slice(2))); assert.equal(JSON.parse(state).config.gapBps, 80);
    assert.equal((await request('/wallet/clear', 'POST', {})).status, 200);
    assert.equal((await request('/nope', 'POST', {})).status, 404);
  } finally { await app?.close(); rmSync(directory, { recursive: true }); }
});

// The real CLI in managed mode, without network: the RPC points at a closed local port.
function managedCli(directory, settings = AERO_LP_DEFAULTS) {
  const data = join(directory, 'aero-lp'), config = join(data, 'config.json');
  mkdirSync(data, { recursive: true });
  writeFileSync(config, JSON.stringify(settings));
  const child = fork(fileURLToPath(new URL('../tools/aero-lp/cli.mjs', import.meta.url)), ['run', '--managed', '--config', config, '--data', data], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const messages = []; child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, messages, exited, stderr: () => stderr, data };
}

test('managed CLI exits cleanly when stopped before it receives a key', async () => {
  const directory = fixtureDir();
  try {
    const cli = managedCli(directory);
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-ready'));
    cli.child.send({ type: 'aero-lp-stop' });
    assert.equal(await cli.exited, 0);
  } finally { rmSync(directory, { recursive: true }); }
});

test('managed CLI rejects a malformed key without echoing it', async () => {
  const directory = fixtureDir();
  try {
    const cli = managedCli(directory);
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-ready'));
    cli.child.send({ type: 'aero-lp-key', key: 'zz-secret-material-zz', paused: false });
    assert.equal(await cli.exited, 1);
    assert.match(cli.stderr(), /64 hex characters/); assert.ok(!cli.stderr().includes('secret-material'));
  } finally { rmSync(directory, { recursive: true }); }
});

test('managed CLI reports connection failures as cycle errors, keeps running and releases the lock on stop', async () => {
  const directory = fixtureDir();
  try {
    const cli = managedCli(directory, { ...AERO_LP_DEFAULTS, rpcUrl: 'https://127.0.0.1:9' });
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-ready'));
    cli.child.send({ type: 'aero-lp-key', key: KEY, paused: false });
    const failure = await until(() => cli.messages.find((m) => m.type === 'aero-lp-event' && m.entry.event === 'cycle_error'), 'no cycle_error', 600);
    assert.ok(!JSON.stringify(failure).includes(KEY.slice(2)));
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-phase' && m.phase === 'sleeping'));
    assert.ok(existsSync(join(cli.data, `run-${ADDRESS.toLowerCase()}.lock`)));
    cli.child.send({ type: 'aero-lp-stop' });
    assert.equal(await cli.exited, 0);
    assert.ok(!existsSync(join(cli.data, `run-${ADDRESS.toLowerCase()}.lock`)));
    const log = readFileSync(join(cli.data, 'events.jsonl'), 'utf8');
    assert.match(log, /cycle_error/); assert.ok(!log.includes(KEY.slice(2)));
  } finally { rmSync(directory, { recursive: true }); }
});

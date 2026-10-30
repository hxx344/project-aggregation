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
function fakeWorker({ ignoreStop = false, ackHold = false } = {}) {
  const worker = new EventEmitter(); worker.pid = 4242; worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  worker.connected = true; worker.sent = []; worker.signals = [];
  const exit = () => { worker.connected = false; setTimeout(() => worker.emit('close', 0), 5); };
  // ackHold: confirm the key's and every pause message's hold like cli.mjs does.
  worker.ackHold = ackHold;
  worker.send = (message, callback) => {
    worker.sent.push(message);
    if (message.type === 'aero-lp-stop' && !ignoreStop) exit();
    if (worker.ackHold && (message.type === 'aero-lp-key' || message.type === 'aero-lp-pause')) setImmediate(() => worker.emit('message', { type: 'aero-lp-hold', paused: message.paused, seq: message.seq }));
    callback?.(null); return true;
  };
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
  for (const bad of [{ rpcUrl: 'http://mainnet.base.org' }, { pool: 'pool' }, { gauge: 'gauge' }, { token1: 'usdc' }, { tickSpacing: 0 }, { tickSpacing: 1.5 }, { intervalSec: 9 }, { twapSec: 7200 }, { slippageBps: 0 }, { gapBps: 1.5 }, { minDeploy: '1e3' }, { upperPrice: -1 }]) {
    assert.throws(() => strictAeroLpConfig({ ...AERO_LP_DEFAULTS, ...bad }), /LP 参数无效/, JSON.stringify(bad));
  }
  const pool = AERO_LP_DEFAULTS.pool.toLowerCase();
  assert.equal(strictAeroLpConfig({ ...AERO_LP_DEFAULTS, pool }).pool, pool);
  const badChecksum = '0x' + pool.slice(2).replace(/[a-f]/, (c) => c.toUpperCase());
  assert.throws(() => strictAeroLpConfig({ ...AERO_LP_DEFAULTS, pool: badChecksum }), /校验和/);
  assert.equal(strictAeroLpConfig({ ...AERO_LP_DEFAULTS, intervalSec: 10 }).intervalSec, 10);
  const { rpcUrl, ...missing } = AERO_LP_DEFAULTS;
  assert.throws(() => strictAeroLpConfig(missing), /rpcUrl/);
});

test('the wallet counts as known only once its file was read, so Asset is never told "no wallet" by mistake', async () => {
  const blank = fixtureDir(), broken = fixtureDir();
  try {
    const fresh = managerWith(blank).manager;
    assert.equal(fresh.walletKnown(), false);
    await fresh.initialize();
    assert.equal(fresh.walletKnown(), true);
    await fresh.close();
    mkdirSync(join(broken, 'aero-lp'), { recursive: true });
    writeFileSync(join(broken, 'aero-lp', 'wallet.json'), '{"schema":1,"addr');
    const corrupt = managerWith(broken).manager;
    await corrupt.initialize();
    assert.equal(corrupt.state().wallet, null);
    assert.equal(corrupt.walletKnown(), false);
    await corrupt.setKey(KEY);
    assert.equal(corrupt.walletKnown(), true, 'saving a key replaces the unreadable file');
    await corrupt.close();
    writeFileSync(join(broken, 'aero-lp', 'wallet.json'), '{"schema":1}');
    const empty = managerWith(broken).manager;
    await empty.initialize();
    assert.equal(empty.walletKnown(), false, 'a wallet file without an address is damaged too');
    await empty.close();
  } finally { rmSync(blank, { recursive: true, force: true }); rmSync(broken, { recursive: true, force: true }); }
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
    assert.deepEqual(worker.sent[0], { type: 'aero-lp-key', key: KEY, paused: false, seq: 1 });
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

test('gas and reward totals come from the child ledger for the current wallet only', async () => {
  const directory = fixtureDir();
  const { manager } = managerWith(directory);
  try {
    await manager.initialize();
    assert.equal(manager.state().ledger, null, 'no wallet, no totals');
    await manager.setKey(KEY);
    assert.deepEqual(manager.state().ledger, { txs: 0, failed: 0, gasEth: '0', reward: '0', since: null });
    const line = (n, over) => JSON.stringify({ hash: '0x' + n.toString(16).padStart(64, '0'), wallet: ADDRESS, status: 'ok', fee: '1000000000000000', reward: '0', at: `2026-10-29T0${n}:00:00.000Z`, ...over }) + '\n';
    const ledger = join(directory, 'aero-lp/txs.jsonl');
    writeFileSync(ledger, line(1) + line(2, { status: 'reverted', reward: '2500000000000000000' }) + line(3, { wallet: '0x00000000000000000000000000000000000000AA' }));
    assert.deepEqual(manager.state().ledger, { txs: 2, failed: 1, gasEth: '0.002', reward: '2.5', since: '2026-10-29T01:00:00.000Z' });
    writeFileSync(ledger, line(4), { flag: 'a' });
    assert.equal(manager.state().ledger.txs, 3, 'appended lines are picked up');
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

test('account recovery quarantine refuses start and holds a running child like maintenance', async () => {
  const directory = fixtureDir(); let admitted = true;
  const { manager, workers, launches } = managerWith(directory, { manager: { readAdmission: () => admitted } });
  try {
    await manager.initialize(); await manager.setKey(KEY);
    admitted = false;
    await assert.rejects(manager.start(), (error) => error.status === 409 && /隔离恢复/.test(error.message));
    assert.equal(launches.length, 0); assert.equal(manager.state().enabled, false);
    admitted = true; await manager.start(); assert.equal(launches.length, 1);
    admitted = false;
    await until(() => workers[0].sent.some((m) => m.type === 'aero-lp-pause' && m.paused === true));
    assert.equal(manager.state().pauseReason, 'recovery');
    workers[0].emit('message', { type: 'aero-lp-ready' });
    assert.equal(workers[0].sent.find((m) => m.type === 'aero-lp-key').paused, true);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a restart during quarantine starts the signer only after admission returns', async () => {
  const directory = fixtureDir(); let admitted = true;
  const first = managerWith(directory);
  try { await first.manager.initialize(); await first.manager.setKey(KEY); await first.manager.start(); }
  finally { await first.manager.close(); }
  admitted = false;
  const { manager, launches } = managerWith(directory, { manager: { readAdmission: () => { if (admitted === null) throw new Error('writer closed'); return admitted; } } });
  try {
    await manager.initialize();
    assert.equal(launches.length, 0);
    assert.match(manager.state().error, /隔离恢复/);
    admitted = null; await delay(60);
    assert.equal(launches.length, 0, 'an unreadable recovery state holds the signer');
    admitted = true;
    await until(() => launches.length === 1);
    assert.equal(manager.state().error, null);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('a recovery hold that clears during maintenance waits for maintenance to end', async () => {
  const directory = fixtureDir(); let admitted = true, maintenance = false;
  const first = managerWith(directory);
  try { await first.manager.initialize(); await first.manager.setKey(KEY); await first.manager.start(); }
  finally { await first.manager.close(); }
  admitted = false;
  const { manager, launches } = managerWith(directory, { manager: { readAdmission: () => admitted, readMaintenance: () => maintenance } });
  try {
    await manager.initialize();
    maintenance = true; admitted = true;
    await manager.prepareStop(); await delay(60);
    assert.equal(launches.length, 0, 'neither the poll nor the update stop check starts a signer during maintenance');
    maintenance = false;
    await until(() => launches.length === 1);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('update stop check waits for the child to confirm the hold and refuses mid-transaction', async () => {
  const directory = fixtureDir(); let maintenance = false;
  const { manager, workers } = managerWith(directory, { worker: { ackHold: true }, manager: { readMaintenance: () => maintenance, maintenancePollMs: 60_000 } });
  try {
    await manager.initialize(); await manager.setKey(KEY); await manager.start();
    // The key handoff reads the hold itself: no poll ran since maintenance began.
    maintenance = true;
    workers[0].emit('message', { type: 'aero-lp-ready' });
    assert.equal(workers[0].sent.find((m) => m.type === 'aero-lp-key').paused, true);
    await manager.prepareStop();
    workers[0].emit('message', { type: 'aero-lp-phase', phase: 'executing' });
    await assert.rejects(manager.prepareStop(), (error) => error.status === 409 && /执行链上交易/.test(error.message));
    workers[0].emit('message', { type: 'aero-lp-phase', phase: 'sleeping' });
    await manager.prepareStop();
    // Release and re-hold before the release is confirmed: the earlier confirmation must not count.
    workers[0].ackHold = false;
    maintenance = false; await assert.rejects(manager.prepareStop(), (error) => error.status === 503);
    maintenance = true;
    await assert.rejects(manager.prepareStop({ confirmMs: 50, stepMs: 10 }), (error) => error.status === 503 && /无法确认/.test(error.message));
    workers[0].ackHold = true;
    // Outside maintenance the stop check never reports ready.
    maintenance = false;
    await assert.rejects(manager.prepareStop(), (error) => error.status === 503);
    await until(() => !manager.state().paused);
    await delay(20);
    // A child that never confirms the new hold is not trusted to have stopped signing.
    workers[0].ackHold = false; maintenance = true;
    await assert.rejects(manager.prepareStop({ confirmMs: 100, stepMs: 10 }), (error) => error.status === 503 && /无法确认/.test(error.message));
    const latest = workers[0].sent.at(-1);
    assert.equal(latest.type, 'aero-lp-pause');
    // A late echo of an older hold does not confirm the latest one.
    workers[0].emit('message', { type: 'aero-lp-hold', paused: true, seq: latest.seq - 2 });
    await assert.rejects(manager.prepareStop({ confirmMs: 50, stepMs: 10 }), (error) => error.status === 503);
    workers[0].emit('message', { type: 'aero-lp-hold', paused: true, seq: latest.seq });
    await manager.prepareStop();
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
});

test('settings saved before the pinned keys existed get them only for the default pool, keeping saved values', async () => {
  const { gauge, token1, tickSpacing, ...legacy } = AERO_LP_DEFAULTS;
  const directory = fixtureDir();
  mkdirSync(join(directory, 'aero-lp'), { recursive: true });
  writeFileSync(join(directory, 'aero-lp', 'config.json'), JSON.stringify({ ...legacy, intervalSec: 30, tickSpacing: 200 }));
  const { manager } = managerWith(directory);
  try {
    await manager.initialize();
    assert.deepEqual([manager.state().config.gauge, manager.state().config.token1, manager.state().config.tickSpacing], [gauge, token1, 200]);
    assert.equal(manager.state().config.intervalSec, 30);
    const saved = JSON.parse(readFileSync(join(directory, 'aero-lp', 'config.json'), 'utf8'));
    assert.deepEqual([saved.gauge, saved.token1, saved.tickSpacing], [gauge, token1, 200]);
    assert.notEqual(tickSpacing, 200);
  } finally { await manager.close(); rmSync(directory, { recursive: true }); }
  const other = fixtureDir();
  mkdirSync(join(other, 'aero-lp'), { recursive: true });
  writeFileSync(join(other, 'aero-lp', 'config.json'), JSON.stringify({ ...legacy, pool: '0x' + '22'.repeat(20) }));
  const second = managerWith(other);
  try {
    await second.manager.initialize();
    assert.match(second.manager.state().error, /配置/);
    await assert.rejects(second.manager.start(), (error) => error.status === 409);
  } finally { await second.manager.close(); rmSync(other, { recursive: true }); }
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
    cli.child.send({ type: 'aero-lp-key', key: KEY, paused: false, seq: 1 });
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-hold' && m.paused === false && m.seq === 1));
    cli.child.send({ type: 'aero-lp-pause', paused: true, seq: 2 });
    await until(() => cli.messages.some((m) => m.type === 'aero-lp-hold' && m.paused === true && m.seq === 2));
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

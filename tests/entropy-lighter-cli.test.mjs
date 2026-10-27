import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'tools/entropy-lighter-lab/cli.mjs');
const base = JSON.parse(readFileSync(join(root, 'tools/entropy-lighter-lab/config.example.json'), 'utf8'));
function child(args) {
  const processChild = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', (d) => { stdout += d; }); processChild.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { processChild, done };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'entropy-cli-'));
  // Offline startup uses real cooldown logic, without mocking the application.
  writeFileSync(join(directory, 'cooldowns.json'), JSON.stringify(Object.fromEntries(['entropy', 'lighter', 'binance'].map((v) => [v, Date.now() + 3600000]))));
  return directory;
}
async function waitStatus(directory, pid) {
  for (let i = 0; i < 100; i++) {
    try { const status = JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8')); if (status.pid === pid) return status; } catch {}
    await delay(30);
  }
  throw new Error('No heartbeat from actual CLI entry');
}

test('real current symlink entry runs configuration check', async () => {
  const dir = mkdtempSync(join(root, '.data-entropy-entry-'));
  try {
    symlinkSync(join(root, 'tools/entropy-lighter-lab'), join(dir, 'current'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await child([join(dir, 'current/cli.mjs'), 'check']).done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Configuration valid/);
  } finally {
    if (process.platform === 'win32') rmdirSync(join(dir, 'current'));
    else unlinkSync(join(dir, 'current'));
    rmSync(dir, { recursive: true });
  }
});

test('offline run emits actual service heartbeat, bounded shutdown and readable report', async () => {
  const dir = fixture();
  try {
    const c = child([entry, 'run', '--data', dir, '--duration', '1']);
    const status = await waitStatus(dir, c.processChild.pid);
    assert.equal(status.mode, 'research'); assert.equal(status.stopped, false);
    const result = await c.done; assert.equal(result.code, 0, result.stderr);
    const report = await child([entry, 'report', '--data', dir]).done;
    assert.equal(JSON.parse(report.stdout).stopped, true);
    assert.equal(JSON.parse(report.stdout).counts.books, 0);
    assert.equal(JSON.parse(report.stdout).automaticFees.mode, 'auto');
    assert.deepEqual(JSON.parse(report.stdout).automaticFees.rebateRatios, [1.1, 1.2]);
    assert.equal(JSON.parse(report.stdout).sessionConfig.simulation.entropyTakerFeeBps, null);
    assert.equal(JSON.parse(report.stdout).binanceScalper.enabled, true);
    assert.equal(JSON.parse(report.stdout).binanceScalper.suspendedReason, null);
  } finally { rmSync(dir, { recursive: true }); }
});

test('competing recovery starts cannot both own a dead collector lock', async () => {
  const dir = fixture();
  try {
    const exited = child(['-e', 'process.exit(0)']); await exited.done;
    mkdirSync(join(dir, 'run.lock'));
    writeFileSync(join(dir, 'run.lock/owner.json'), JSON.stringify({ pid: exited.processChild.pid, token: 'old' }));
    const a = child([entry, 'run', '--data', dir, '--duration', '2']);
    const b = child([entry, 'run', '--data', dir, '--duration', '2']);
    const results = await Promise.all([a.done, b.done]);
    assert.equal(results.filter((r) => r.code === 0).length, 1);
    assert.match(results.find((r) => r.code !== 0).stderr, /collector|claim/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('unclean paper session suspends paper on restart even before first five-second snapshot', async () => {
  const dir = fixture();
  try {
    const c = structuredClone(base); Object.assign(c.simulation, { enabled: true, entropyTakerFeeBps: 1, verifiedSymbols: ['SNDK'] });
    const configFile = join(dir, 'config.json'); writeFileSync(configFile, JSON.stringify(c));
    const first = child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '30']);
    const status = await waitStatus(dir, first.processChild.pid); assert.equal(status.mode, 'paper');
    first.processChild.kill('SIGKILL'); await first.done;
    const second = await child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '1']).done;
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.mode, 'research'); assert.match(report.paperSuspendedReason, /previous_session/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-paper.json'), 'utf8')).mode, 'paper');
    const third = await child([entry, 'run', '--data', dir, '--config', configFile, '--duration', '1']).done;
    assert.equal(third.code, 0, third.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-paper.json'), 'utf8')).session, status.session);
  } finally { rmSync(dir, { recursive: true }); }
});

test('a managed collector exits when its parent IPC disconnects and preserves the final snapshot', async () => {
  const dir = fixture(); let worker;
  try {
    worker = spawn(process.execPath, [entry, 'run', '--data', dir], { windowsHide: true, env: { ...process.env, ENTROPY_LAB_MANAGED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    worker.stdout.resume(); worker.stderr.resume();
    const exited = new Promise((resolve) => worker.once('exit', (code) => resolve(code)));
    await waitStatus(dir, worker.pid); worker.disconnect();
    const deadline = delay(3000).then(() => { throw new Error('Orphan collector did not exit'); });
    assert.equal(await Promise.race([exited, deadline]), 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).stopped, true);
    assert.equal(existsSync(join(dir, 'run.lock')), false);
  } finally {
    if (worker?.exitCode === null) worker.kill('SIGKILL');
    worker?.stdout.destroy(); worker?.stderr.destroy();
    rmSync(dir, { recursive: true });
  }
});

test('unclean research session suspends the directional study even before its first trade snapshot', async () => {
  const dir = fixture(); let first;
  try {
    first = child([entry, 'run', '--data', dir, '--duration', '30']);
    const status = await waitStatus(dir, first.processChild.pid);
    assert.equal(status.mode, 'research');
    first.processChild.kill('SIGKILL'); await first.done;
    const second = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(second.code, 0, second.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.equal(report.mode, 'research'); assert.equal(report.paperSuspendedReason, null);
    assert.match(report.binanceScalper.suspendedReason, /previous_session/);
    assert.equal(report.binanceScalper.openTasks.length, 0);
    assert.equal(report.binanceScalper.enabled, false);
    assert.equal(report.binanceScalper.previousSession.session, status.session);
    for (const symbol of Object.values(report.binanceScalper.bySymbol)) for (const scenario of Object.values(symbol.scenarios)) {
      assert.equal(scenario.stats.netBeforeRebate, null);
      assert.ok(scenario.stats.rebateScenarios.every(value => value.net === null));
    }
    const original = JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8'));
    assert.equal(original.session, status.session); assert.equal(original.stopped, false);
    const third = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(third.code, 0, third.stderr);
    assert.match(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).binanceScalper.suspendedReason, /previous_session/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8')).session, status.session);
  } finally {
    if (first?.processChild.exitCode === null) { first.processChild.kill('SIGKILL'); await first.done; }
    rmSync(dir, { recursive: true });
  }
});

test('a cleanly stopped research report with a pending directional exit keeps its original evidence', async () => {
  const dir = fixture();
  try {
    const original = { session: 'stopped-with-position', mode: 'research', observedAt: 1793000000000, stopped: true, counts: {}, binanceScalper: {
      enabled: true, suspendedReason: null, observedAt: 1793000000000,
      openTasks: [{ symbol: 'SNDK', state: 'exit_pending', entry: { cash: 100, fee: 0.05 } }],
      bySymbol: { SNDK: { scenarios: { base: { state: 'exit_pending', position: { direction: 'long', entryPrice: 100 },
        stats: { completed: 2, lossesBeforeRebate: 1, fees: 0.15, turnover: 300, settledNetBeforeRebate: -3,
          netBeforeRebate: null, grossPnl: null, rebateScenarios: [{ ratio: 1.1, contingentRebate: 0.165, net: null }] },
        recentTrades: [{ id: 'prior-loss', netBeforeRebate: -3 }] } } } },
    } };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(original));
    const result = await child([entry, 'run', '--data', dir, '--duration', '1']).done;
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.match(report.binanceScalper.suspendedReason, /previous_session/);
    assert.deepEqual(report.binanceScalper.openTasks, original.binanceScalper.openTasks);
    assert.deepEqual(report.binanceScalper.bySymbol, original.binanceScalper.bySymbol);
    assert.equal(report.binanceScalper.observedAt, original.observedAt);
    assert.equal(report.binanceScalper.previousSession.session, original.session);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'unresolved-scalper.json'), 'utf8')), original);
  } finally { rmSync(dir, { recursive: true }); }
});

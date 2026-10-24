import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireLifecycleLock, acquireRecoveryLocks, acquireRuntimeLock, assertRuntimeLock, assertLifecycleLock } from '../server/recovery/lifecycle-lock.mjs';

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const fixtureHelper = fileURLToPath(new URL('./test_lifecycle_lock.py', import.meta.url));
const helper = fileURLToPath(new URL('../server/recovery/lifecycle_lock.py', import.meta.url));
const code = (expected) => (error) => error.code === expected;
function permissions(directory, unsafe = false) {
  const result = spawnSync(python, ['-I', fixtureHelper, unsafe ? '--unsafe-dir' : '--secure-dir', directory], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lock-node-'));
  permissions(directory);
  const held = [];
  t.after(async () => { for (const lock of held) await lock.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const take = acquire => async (options = {}) => { const lock = await acquire({ dataDir: directory, timeoutMs: 100, ...options }); held.push(lock); return lock; };
  return { directory, held, acquire: take(acquireRuntimeLock), lifecycle: take(acquireLifecycleLock), recovery: take(acquireRecoveryLocks) };
}

test('runtime lock accepts only a branded live token for exactly its directory', async (t) => {
  const f = fixture(t); const lock = await f.acquire();
  assert.equal(assertRuntimeLock(lock, f.directory), true);
  // Recovery work needs both locks; the runtime lock alone is not proof.
  assert.throws(() => assertLifecycleLock(lock, { dataDir: f.directory }), code('RUNTIME_LOCK_LOST'));
  assert.equal(lock.assertHeld(), true);
  assert.throws(() => assertRuntimeLock({ assertHeld: () => true }, f.directory), code('RUNTIME_LOCK_LOST'));
  assert.throws(() => assertRuntimeLock(lock, path.dirname(f.directory)), code('RUNTIME_LOCK_LOST'));
  const info = fs.statSync(path.join(f.directory, '.runtime.lock'));
  await assert.rejects(f.acquire(), code('RUNTIME_LOCK_BUSY'));
  await lock.close();
  assert.throws(() => lock.assertHeld(), code('RUNTIME_LOCK_LOST'));
  const next = await f.acquire();
  assert.equal(next.assertHeld(), true);
  assert.equal(fs.statSync(path.join(f.directory, '.runtime.lock')).ino, info.ino);
});

test('recovery locks refuse a live runtime or API process and hold both locks until closed', async (t) => {
  const f = fixture(t);
  const api = await f.lifecycle({ name: 'api', mode: 'shared' }), second = await f.lifecycle({ name: 'api', mode: 'shared' });
  assert.equal(api.assertHeld() && second.assertHeld(), true, 'API processes share their lock');
  await assert.rejects(f.recovery(), code('RUNTIME_LOCK_BUSY'));
  // The runtime lock taken first is released again when the API lock is busy.
  assert.equal((await f.acquire()).assertHeld(), true);
  await Promise.all(f.held.splice(-1).map(lock => lock.close()));
  await api.close(); await second.close();
  const runtime = await f.acquire();
  await assert.rejects(f.recovery(), code('RUNTIME_LOCK_BUSY'));
  assert.equal((await f.lifecycle({ name: 'api' })).assertHeld(), true, 'the API lock taken after a busy runtime lock was not kept');
  await Promise.all(f.held.splice(-1).map(lock => lock.close()));
  await runtime.close();
  const recovery = await f.recovery();
  assert.equal(assertLifecycleLock(recovery, { dataDir: f.directory }), true);
  assert.equal(recovery.assertHeld(), true);
  assert.throws(() => assertLifecycleLock(recovery, { dataDir: path.dirname(f.directory) }), code('RUNTIME_LOCK_LOST'));
  await assert.rejects(f.acquire(), code('RUNTIME_LOCK_BUSY'));
  await assert.rejects(f.lifecycle({ name: 'api', mode: 'shared' }), code('RUNTIME_LOCK_BUSY'));
  await recovery.close();
  assert.throws(() => recovery.assertHeld(), code('RUNTIME_LOCK_LOST'));
  assert.equal((await f.lifecycle({ name: 'api', mode: 'shared' })).assertHeld(), true);
  await assert.rejects(f.lifecycle({ name: 'other' }), code('INVALID_RUNTIME_LOCK_OPTIONS'));
  await assert.rejects(f.lifecycle({ mode: 'read' }), code('INVALID_RUNTIME_LOCK_OPTIONS'));
  await assert.rejects(f.lifecycle({ name: 'runtime', mode: 'shared' }), code('INVALID_RUNTIME_LOCK_OPTIONS'), 'two runtimes must never share');
});

test('a recovery lock group reports the loss of either member once and stops counting as held', async (t) => {
  const f = fixture(t);
  const seen = []; let notify;
  const lost = new Promise((resolve) => { notify = resolve; });
  const group = await f.recovery({ onLost: (error) => { seen.push(error); notify(); } });
  permissions(f.directory, true);
  await Promise.race([lost, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('group loss callback timed out')), 3000); timer.unref(); })]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(seen.length, 1, 'both helpers fail, the group reports once');
  assert.equal(group.lost, true); assert.equal(group.error, seen[0]);
  assert.throws(() => assertLifecycleLock(group, { dataDir: f.directory }), code('RUNTIME_LOCK_LOST'));
  const late = await new Promise((resolve) => group.onLost(resolve));
  assert.equal(late, seen[0], 'a callback added after the loss still hears of it');
  await group.close(); permissions(f.directory);
  assert.equal((await f.recovery()).assertHeld(), true);
});

test('native independent Python process holds the OS lock until stdin closes', async (t) => {
  const f = fixture(t);
  const child = spawn(python, ['-I', helper, f.directory, '100'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('native lock fixture timed out')), 3000); lines.once('line', (line) => { clearTimeout(timer); resolve(JSON.parse(line)); }); child.once('error', reject); });
  assert.equal(first.ready, true);
  await assert.rejects(f.acquire(), code('RUNTIME_LOCK_BUSY'));
  child.stdin.end(); await exited; lines.close();
  assert.equal((await f.acquire()).assertHeld(), true);
});

test('permission loss invalidates held token and invokes fail closed callback', async (t) => {
  const f = fixture(t);
  let loss;
  const lost = new Promise((resolve) => { loss = resolve; });
  const lock = await f.acquire({ onLost: loss });
  permissions(f.directory, true);
  const error = await Promise.race([lost, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('lock loss callback timed out')), 3000); timer.unref(); })]);
  assert.equal(error.code, process.platform === 'win32' ? 'UNSAFE_RUNTIME_LOCK_PATH' : 'RUNTIME_LOCK_LOST');
  assert.equal(lock.lost, true);
  assert.throws(() => lock.assertHeld(), code('RUNTIME_LOCK_LOST'));
  await lock.close(); permissions(f.directory);
  assert.equal((await f.acquire()).assertHeld(), true);
});

test('Python native lock contract and failure scenarios', () => {
  const result = spawnSync(python, ['-I', fixtureHelper], { windowsHide: true, timeout: 20_000, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

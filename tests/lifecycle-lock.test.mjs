import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireRuntimeLock, assertRuntimeLock, assertLifecycleLock } from '../server/recovery/lifecycle-lock.mjs';

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
  return { directory, async acquire(options = {}) { const lock = await acquireRuntimeLock({ dataDir: directory, timeoutMs: 100, ...options }); held.push(lock); return lock; } };
}

test('runtime lock accepts only a branded live token for exactly its directory', async (t) => {
  const f = fixture(t); const lock = await f.acquire();
  assert.equal(assertRuntimeLock(lock, f.directory), true);
  assert.equal(assertLifecycleLock(lock, { dataDir: f.directory }), true);
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

test('native independent Python process holds the OS lock until stdin closes', async (t) => {
  const f = fixture(t);
  const child = spawn(python, ['-I', helper, f.directory, '100'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
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
  assert.equal(error.code, 'UNSAFE_RUNTIME_LOCK_PATH');
  assert.equal(lock.lost, true);
  assert.throws(() => lock.assertHeld(), code('RUNTIME_LOCK_LOST'));
  await lock.close(); permissions(f.directory);
  assert.equal((await f.acquire()).assertHeld(), true);
});

test('Python native lock contract and failure scenarios', () => {
  const result = spawnSync(python, ['-I', fixtureHelper], { windowsHide: true, timeout: 20_000, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

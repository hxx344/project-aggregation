import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HELPER = fileURLToPath(new URL('./lifecycle_lock.py', import.meta.url));
const locks = new WeakMap();

export class RuntimeLockError extends Error {
  constructor(code) { super(`Runtime lifecycle control: ${code}`); this.name = 'RuntimeLockError'; this.code = code; }
}
const fail = (code) => { throw new RuntimeLockError(code); };
function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /^(?:\\\\|\/\/|\\\?\?\\)/.test(value) || (process.platform === 'win32' && value.slice(2).includes(':'))) fail('UNSAFE_RUNTIME_LOCK_PATH');
  return path.resolve(value);
}
function identity(target, directory = false) {
  const info = fs.lstatSync(target, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)) fail('RUNTIME_LOCK_LOST');
  return `${info.dev}:${info.ino}`;
}

// The WeakMap proves provenance; user supplied methods or booleans are never proof.
export function assertRuntimeLock(lock, dataDir) {
  const state = lock && locks.get(lock);
  if (!state || state.dataDir !== absoluteDirectory(dataDir) || state.closing || state.lost || state.child.exitCode !== null || state.child.signalCode !== null || state.child.stdin.destroyed || !state.child.stdin.writable) fail('RUNTIME_LOCK_LOST');
  try {
    if (identity(state.dataDir, true) !== state.directoryIdentity || identity(path.join(state.dataDir, '.runtime.lock')) !== state.fileIdentity) fail('RUNTIME_LOCK_LOST');
    if (process.platform !== 'win32') {
      for (const target of [state.dataDir, path.join(state.dataDir, '.runtime.lock')]) {
        const info = fs.lstatSync(target);
        if (info.uid !== state.ownerUid || info.mode & 0o077) fail('RUNTIME_LOCK_LOST');
      }
    }
  } catch { state.markLost(new RuntimeLockError('RUNTIME_LOCK_LOST')); fail('RUNTIME_LOCK_LOST'); }
  return true;
}
export function assertLifecycleLock(lock, { dataDir } = {}) { return assertRuntimeLock(lock, dataDir); }

export async function acquireRuntimeLock({ dataDir, timeoutMs = 5000, python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), onLost, expectedOwnerUid } = {}) {
  const resolved = absoluteDirectory(dataDir);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || typeof python !== 'string' || !python || (onLost !== undefined && typeof onLost !== 'function')) fail('INVALID_RUNTIME_LOCK_OPTIONS');
  const ownerUid = expectedOwnerUid ?? (process.platform === 'win32' ? undefined : process.getuid());
  if (process.platform === 'win32' ? expectedOwnerUid !== undefined : !Number.isSafeInteger(ownerUid) || ownerUid < 0 || (ownerUid !== process.getuid() && process.getuid() !== 0)) fail('INVALID_RUNTIME_LOCK_OPTIONS');
  let directoryIdentity;
  try { directoryIdentity = identity(resolved, true); } catch { fail('UNSAFE_RUNTIME_LOCK_PATH'); }
  const child = spawn(python, ['-I', HELPER, resolved, String(timeoutMs), ...(ownerUid === undefined ? [] : [String(ownerUid)])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const callbacks = new Set(onLost ? [onLost] : []);
  const state = { child, dataDir: resolved, directoryIdentity, ownerUid, fileIdentity: null, closing: false, lost: false, error: null };
  state.markLost = (error) => {
    if (state.lost || state.closing) return;
    state.lost = true; state.error = error;
    for (const callback of callbacks) { try { callback(error); } catch {} }
    child.stdin.end();
  };
  let release;
  const exited = new Promise((resolve) => { release = resolve; });
  child.once('exit', (code) => { release(); state.markLost(new RuntimeLockError(code === 0 ? 'RUNTIME_LOCK_LOST' : state.error?.code ?? 'RUNTIME_LOCK_LOST')); });
  child.once('error', () => { release(); state.markLost(new RuntimeLockError('RUNTIME_LOCK_UNAVAILABLE')); });
  child.stdin.on('error', () => state.markLost(new RuntimeLockError('RUNTIME_LOCK_LOST')));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new RuntimeLockError('RUNTIME_LOCK_TIMEOUT')), timeoutMs + 2000);
      child.once('exit', () => finish(state.error ?? new RuntimeLockError('RUNTIME_LOCK_UNAVAILABLE')));
      child.once('error', () => finish(new RuntimeLockError('RUNTIME_LOCK_UNAVAILABLE')));
      lines.on('line', (line) => {
        let message;
        try { if (line.length > 1024) throw new Error(); message = JSON.parse(line); } catch { state.markLost(new RuntimeLockError('RUNTIME_LOCK_PROTOCOL')); finish(state.error); return; }
        if (message.ready === true && message.schemaVersion === 1 && !state.lost) {
          try { state.fileIdentity = identity(path.join(resolved, '.runtime.lock')); finish(); }
          catch { finish(new RuntimeLockError('RUNTIME_LOCK_LOST')); }
        } else {
          const allowed = ['RUNTIME_LOCK_BUSY', 'RUNTIME_LOCK_LOST', 'UNSAFE_RUNTIME_LOCK_PATH', 'INVALID_RUNTIME_LOCK_OPTIONS', 'RUNTIME_LOCK_UNAVAILABLE'];
          state.markLost(new RuntimeLockError(allowed.includes(message.code) ? message.code : 'RUNTIME_LOCK_PROTOCOL'));
          finish(state.error);
        }
      });
    });
  } catch (error) {
    state.closing = true; child.stdin.end(); child.kill('SIGKILL'); await exited; lines.close(); throw error;
  }
  let closePromise;
  const lock = Object.freeze({
    get lost() { return state.lost; },
    get error() { return state.error; },
    assertHeld() { return assertRuntimeLock(lock, resolved); },
    onLost(callback) {
      if (typeof callback !== 'function') fail('INVALID_RUNTIME_LOCK_OPTIONS');
      callbacks.add(callback);
      if (state.lost) queueMicrotask(() => callback(state.error));
      return () => callbacks.delete(callback);
    },
    close() {
      if (!closePromise) closePromise = (async () => {
        state.closing = true; child.stdin.end();
        const terminate = setTimeout(() => child.kill('SIGKILL'), 2000);
        try { await exited; } finally { clearTimeout(terminate); lines.close(); callbacks.clear(); }
      })();
      return closePromise;
    },
  });
  locks.set(lock, state);
  assertRuntimeLock(lock, resolved);
  return lock;
}

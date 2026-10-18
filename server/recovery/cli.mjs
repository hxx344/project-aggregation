import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createBackup } from './backup.mjs';
import { restoreBackup, admitHandoff } from './restore.mjs';
import { acquireRuntimeLock } from './lifecycle-lock.mjs';
import { safePath, readLockedRegistry, openSourceDatabase } from './inventory.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const options = Object.fromEntries(['data-dir', 'destination', 'backup-dir', 'target-dir', 'data-key-file', 'secrets-key-file', 'environment-file', 'owner-uid', 'target-owner-uid', 'timeout-ms', 'max-bytes', 'max-files'].map(name => [name, { type: 'string' }]));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value)) fail('RECOVERY_ABSOLUTE_PATH_REQUIRED'); return path.resolve(value); };
function readPrivateFile(filename, limit = 1024 * 1024, { allowGroupRead = false } = {}) {
  const full = absolute(filename), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) fail('RECOVERY_UNSAFE_INPUT');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & (allowGroupRead ? 0o037 : 0o077))) fail('RECOVERY_UNSAFE_INPUT');
  const descriptor = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { const current = fs.fstatSync(descriptor); if (current.dev !== stat.dev || current.ino !== stat.ino) fail('RECOVERY_UNSAFE_INPUT'); return fs.readFileSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function positive(value, fallback) { if (value === undefined) return fallback; const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) fail('RECOVERY_OPTIONS_INVALID'); return result; }
function owner(value) { if (value === undefined) return undefined; const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) fail('RECOVERY_OPTIONS_INVALID'); return result; }
function commit() {
  for (const name of ['.release-commit', '.source-sha']) {
    const filename = path.join(repository, name);
    if (!fs.existsSync(filename)) continue;
    const value = fs.readFileSync(filename, 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(value)) return value;
  }
  fail('RECOVERY_RELEASE_IDENTITY_REQUIRED');
}
function key(filename) { const value = readPrivateFile(filename, 32); if (value.length !== 32) fail('RECOVERY_KEY_INVALID'); return value; }
function publicState(dataDir) {
  const filename = safePath(path.join(absolute(dataDir), 'execution-control.sqlite'));
  safePath(`${filename}.required`);
  const database = openSourceDatabase(filename);
  try {
    const raw = database.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get();
    if (!raw) fail('RECOVERY_SCHEMA_UNSUPPORTED');
    const state = JSON.parse(raw.value);
    return { schemaVersion: 1, state: state.state, authorityId: state.authorityId, recoveryId: state.recoveryId ?? null, checkpointId: state.checkpointId ?? null,
      unresolved: database.prepare("SELECT COUNT(*) AS count FROM aw_operations WHERE state IN ('sending','unknown')").get().count };
  } finally { database.close(); }
}

export async function runRecoveryCli(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, options, allowPositionals: true, strict: true });
  if (positionals.length !== 1 || !['keys','backup','handoff','restore','admit','inspect','check-source'].includes(positionals[0])) fail('RECOVERY_ACTION_INVALID');
  const action = positionals[0];
  if (action === 'keys') {
    const files = [absolute(values['data-key-file']), absolute(values['secrets-key-file'])];
    if (files[0] === files[1]) fail('RECOVERY_KEYS_MUST_DIFFER');
    for (const file of files) {
      if (fs.existsSync(file)) { key(file); continue; }
      fs.writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const first = key(files[0]), second = key(files[1]);
    try { if (first.equals(second)) fail('RECOVERY_KEYS_MUST_DIFFER'); }
    finally { first.fill(0); second.fill(0); }
    return { schemaVersion: 1, keysReady: true };
  }
  if (action === 'inspect') return publicState(values['data-dir']);
  if (action === 'check-source') {
    const dataDir = absolute(values['data-dir']);
    const lock = await acquireRuntimeLock({ dataDir, expectedOwnerUid: owner(values['owner-uid']), timeoutMs: 5000 });
    try { const registry = readLockedRegistry(dataDir, lock); return { schemaVersion: 1, state: registry.state.state, authorityId: registry.state.authorityId }; }
    finally { await lock.close(); }
  }
  const dataKey = key(values['data-key-file']), secretsKey = key(values['secrets-key-file']), locks = [];
  const timeoutMs = positive(values['timeout-ms'], 600_000);
  const bounds = { timeoutMs, maxBytes: positive(values['max-bytes'], 10 * 1024 ** 3), maxFiles: positive(values['max-files'], 10_000) };
  const hold = async (dataDir, expectedOwnerUid) => {
    const held = await acquireRuntimeLock({ dataDir, expectedOwnerUid, timeoutMs: 5000 }); locks.push(held); return held;
  };
  try {
    if (action === 'backup' || action === 'handoff') {
      const dataDir = absolute(values['data-dir']), lock = await hold(dataDir, owner(values['owner-uid']));
      const content = values['environment-file'] ? readPrivateFile(values['environment-file'], 1024 * 1024, { allowGroupRead: true }) : null;
      return await createBackup({ dataDir, destination: absolute(values.destination), dataKey, secretsKey, lock, commit: commit(), kind: action, ...bounds,
        ...(content ? { rootEnvironment: { content, relativeName: 'root.env' }, environment: parseEnv(content.toString('utf8')) } : {}) });
    }
    if (action === 'restore') {
      const targetDir = absolute(values['target-dir']);
      if (fs.existsSync(targetDir)) fail('RECOVERY_TARGET_EXISTS');
      fs.mkdirSync(targetDir, { mode: 0o700 });
      const lock = await hold(targetDir, owner(values['target-owner-uid']));
      return await restoreBackup({ backupDir: absolute(values['backup-dir']), targetDir, dataKey, secretsKey, lock, ...bounds });
    }
    const sourceDir = absolute(values['data-dir']), targetDir = absolute(values['target-dir']);
    if (sourceDir === targetDir) fail('RECOVERY_SOURCE_TARGET_EQUAL');
    const requests = [{ dir: sourceDir, uid: owner(values['owner-uid']), source: true }, { dir: targetDir, uid: owner(values['target-owner-uid']) }].sort((a,b) => a.dir.localeCompare(b.dir));
    let sourceLock, targetLock;
    for (const request of requests) { const held = await hold(request.dir, request.uid); if (request.source) sourceLock = held; else targetLock = held; }
    const environment = values['environment-file'] ? parseEnv(readPrivateFile(values['environment-file'], 1024 * 1024, { allowGroupRead: true }).toString('utf8')) : {};
    return await admitHandoff({ sourceDir, targetDir, sourceLock, targetLock, dataKey, secretsKey, environment, ...bounds });
  } finally {
    const closed = await Promise.allSettled(locks.reverse().map(held => held.close())); dataKey.fill(0); secretsKey.fill(0);
    if (closed.some(result => result.status === 'rejected')) fail('RUNTIME_LOCK_CLOSE_FAILED');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runRecoveryCli()) + '\n'); }
  catch (error) {
    const candidate = error.code || error.message;
    const code = /^(?:RECOVERY_|RUNTIME_|UNSAFE_RUNTIME_)[A-Z_]+$/.test(candidate || '') ? candidate : 'RECOVERY_FAILED';
    process.stderr.write(JSON.stringify({ error: code }) + '\n'); process.exitCode = 1;
  }
}

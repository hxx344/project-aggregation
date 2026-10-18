import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { authenticate, canonical, encryptFile, fileHash, hash, keys, verify } from './crypto.mjs';
import { assertLifecycleLock } from './lifecycle-lock.mjs';
import { ASTER_ENV, budget, checkpointEvidence, checkpointSourceDatabase, databaseEvidence, discoverPathBindings, identity, inventory, openLockedSourceDatabase, readLockedRegistry, readRegistry, REGISTRY, safePath, syncDirectory, within, writeJson } from './inventory.mjs';

export function registryTransaction(dataDir, action) {
  const db = new DatabaseSync(path.join(dataDir, REGISTRY));
  try { db.exec('PRAGMA busy_timeout=750; PRAGMA synchronous=FULL; BEGIN IMMEDIATE'); const result = action(db); db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
export const setMeta = (db, key, value) => db.prepare('INSERT INTO aw_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
// The caller has stopped the complete service cgroup; the non-forgeable OS lock
// prevents all supported runtime entry points from reopening the cold authority.
export async function createBackup(options) {
  const { dataDir, destination, dataKey, secretsKey, lock, commit, kind = 'backup', rootEnvironment, environment = {} } = options;
  const materialKeys = keys(dataKey, secretsKey);
  if (!['backup', 'handoff'].includes(kind) || typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error('RECOVERY_OPTIONS_INVALID');
  const source = safePath(dataDir, { directory: true }); const target = safePath(destination, { missing: true });
  if (within(source, target) || within(target, source)) throw new Error('RECOVERY_TARGET_EXISTS_OR_OVERLAP');
  safePath(path.dirname(target), { directory: true });
  const checkHeld = () => assertLifecycleLock(lock, { dataDir: source }); const limits = budget(options, checkHeld); limits.check();
  const checkpointId = randomUUID(), handoffId = kind === 'handoff' ? randomUUID() : null, startedAt = new Date().toISOString();
  const registry = readLockedRegistry(source, lock);
  // All ciphertext and the authenticated manifest are durable before retirement.
  // If the final directory rename fails or power is lost, only this same sealed
  // handoff/destination may resume publication; retirement is never rolled back.
  if (kind === 'handoff' && registry.state.state === 'retired' && registry.handoff?.sealed && registry.handoff.destinationHash === hash(target)) {
    const record = registry.handoff;
    if (!/^[a-f0-9-]{36}$/.test(record.checkpointId ?? '') || record.sourceAuthorityId !== registry.state.authorityId || canonical(record.sourceIdentity) !== canonical(registry.identity)) throw new Error('RECOVERY_HANDOFF_SOURCE_MISMATCH');
    const pending = path.join(path.dirname(target), '.' + path.basename(target) + '.incomplete-' + record.checkpointId);
    const directory = fs.existsSync(target) ? target : pending; safePath(directory, { directory: true });
    const manifestFile = safePath(path.join(directory, 'manifest.json'));
    if (fs.statSync(manifestFile).size > 8 * 1024 * 1024) throw new Error('RECOVERY_MANIFEST_INVALID');
    const document = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); const body = verify(document, dataKey, secretsKey);
    if (hash(canonical(document)) !== record.manifestHash || body.checkpointId !== record.checkpointId || body.handoffId !== record.handoffId || !Array.isArray(body.entries) || body.entries.length > limits.maxFiles) throw new Error('RECOVERY_HANDOFF_SOURCE_MISMATCH');
    for (let i = 0; i < body.entries.length; i++) { const entry = body.entries[i]; limits.add(entry.size); if (!['data','secrets'].includes(entry.category) || await fileHash(safePath(path.join(directory, entry.category, i + '.gcm')), limits.check) !== entry.payloadSha256) throw new Error('RECOVERY_HASH_MISMATCH'); }
    limits.check(); if (directory === pending) { fs.renameSync(pending, target); syncDirectory(path.dirname(target)); }
    return { checkpointId: body.checkpointId, handoffId: body.handoffId, kind, destination: target, files: body.entries.length, bytes: body.entries.reduce((n,e) => n + e.size, 0), sourceState: 'retired', resumed: true, restorable: null, unresolvedDependencyCount: 0, unresolvedDependencies: [] };
  }
  if (fs.existsSync(target)) throw new Error('RECOVERY_TARGET_EXISTS_OR_OVERLAP');
  if (kind === 'handoff' && registry.state.state !== 'normal') throw new Error('RECOVERY_SOURCE_NOT_NORMAL');
  const files = inventory(source, limits).filter(entry => !(rootEnvironment && entry.path === '_recovery/root.env'));
  const dependencies = discoverPathBindings(source, files, environment);
  if (kind === 'handoff' && dependencies.unresolvedDependencies.length) throw new Error('RECOVERY_DEPENDENCY_NOT_INCLUDED');
  const workspace = path.join(path.dirname(target), '.' + path.basename(target) + '.incomplete-' + checkpointId);
  fs.mkdirSync(workspace, { mode: 0o700 }); const plain = path.join(workspace, '.plaintext'); fs.mkdirSync(plain, { mode: 0o700 });
  for (const category of ['data', 'secrets']) fs.mkdirSync(path.join(workspace, category), { mode: 0o700 });
  try {
    limits.space(workspace, files.reduce((n, f) => n + f.size * 2 + 1024, 0));
    let safety = null;
    if (kind === 'handoff') {
      for (const file of files.filter(entry => entry.sqlite)) {
        limits.check(); checkpointSourceDatabase(file.source, { lock, dataDir: source });
      }
      limits.check(); safety = await checkpointEvidence(source, limits, environment);
      if (safety?.safeForHandoff !== true) throw new Error('RECOVERY_HANDOFF_UNSAFE');
    }
    const entries = []; let actualBytes = 0, manifestBytes = 0;
    for (const file of files) {
      limits.check(); safePath(file.source); const staged = path.join(plain, String(entries.length));
      let database = null; const before = identity(file.source); const info = fs.statSync(file.source, { bigint: true });
      if (file.sqlite) {
        const db = openLockedSourceDatabase(file.source, { lock, dataDir: source });
        try { db.exec('PRAGMA busy_timeout=750'); const pageSize = Object.values(db.prepare('PRAGMA page_size').get())[0]; await backup(db, staged, { rate: 128, progress({ totalPages }) { limits.check(); if (actualBytes + totalPages * pageSize > limits.maxBytes) throw new Error('RECOVERY_LIMIT_EXCEEDED'); } }); }
        finally { db.close(); }
        database = await databaseEvidence(staged, limits);
      } else {
        fs.copyFileSync(file.source, staged, fs.constants.COPYFILE_EXCL); fs.chmodSync(staged, 0o600);
        const after = fs.statSync(file.source, { bigint: true });
        if (before.dev !== String(after.dev) || before.ino !== String(after.ino) || info.size !== after.size || info.mtimeNs !== after.mtimeNs) throw new Error('RECOVERY_SOURCE_CHANGED');
      }
      const size = fs.statSync(staged).size;
      if ((actualBytes += size) > limits.maxBytes) throw new Error('RECOVERY_LIMIT_EXCEEDED');
      const entry = { path: file.path, size, sha256: await fileHash(staged, limits.check), category: file.category, ...(database ? { database, checkpointedAt: new Date().toISOString() } : {}) };
      const payload = path.join(workspace, entry.category, String(entries.length) + '.gcm');
      await encryptFile(staged, payload, materialKeys[entry.category], checkpointId, entry, limits.check); entry.payloadSha256 = await fileHash(payload, limits.check);
      if ((manifestBytes += Buffer.byteLength(JSON.stringify(entry))) > 7 * 1024 * 1024) throw new Error('RECOVERY_MANIFEST_TOO_LARGE');
      fs.rmSync(staged); entries.push(entry);
    }
    if (rootEnvironment !== undefined) {
      if (!Buffer.isBuffer(rootEnvironment.content) || rootEnvironment.relativeName !== 'root.env') throw new Error('RECOVERY_ENVIRONMENT_INVALID');
      if (actualBytes + rootEnvironment.content.length > limits.maxBytes) throw new Error('RECOVERY_LIMIT_EXCEEDED');
      limits.add(rootEnvironment.content.length); const staged = path.join(plain, 'root.env'); fs.writeFileSync(staged, rootEnvironment.content, { flag: 'wx', mode: 0o600 });
      const entry = { path: '_recovery/root.env', size: rootEnvironment.content.length, sha256: hash(rootEnvironment.content), category: 'secrets' };
      const payload = path.join(workspace, 'secrets', String(entries.length) + '.gcm');
      await encryptFile(staged, payload, secretsKey, checkpointId, entry, limits.check); entry.payloadSha256 = await fileHash(payload, limits.check); fs.rmSync(staged); entries.push(entry);
    }
    if (dependencies.syntheticEnv) {
      limits.add(0); const staged = path.join(plain, 'aster.env'); fs.writeFileSync(staged, '', { flag: 'wx', mode: 0o600 });
      const entry = { path: ASTER_ENV, size: 0, sha256: hash(''), category: 'secrets' }; const payload = path.join(workspace, 'secrets', entries.length + '.gcm');
      await encryptFile(staged, payload, secretsKey, checkpointId, entry, limits.check); entry.payloadSha256 = await fileHash(payload, limits.check); fs.rmSync(staged); entries.push(entry);
    }
    limits.check();
    const body = { schemaVersion: 1, protocol: 'cold-checkpoint-v1', checkpointId, kind, ...(handoffId ? { handoffId } : {}), sourceAuthorityId: registry.state.authorityId, registryId: registry.registryId, sourceIdentity: registry.identity, sourceMarker: registry.marker, commit, startedAt, completedAt: new Date().toISOString(), modules: ['monitor','asset','crossex','greeks','aster'], safety, pathBindings: dependencies.pathBindings, unresolvedDependencies: dependencies.unresolvedDependencies, entries };
    const manifest = authenticate(body, dataKey, secretsKey);
    fs.rmSync(plain, { recursive: true });
    for (const category of ['data','secrets']) syncDirectory(path.join(workspace, category));
    writeJson(path.join(workspace, 'manifest.json'), manifest); limits.check();
    if (kind === 'handoff') {
      if ((await checkpointEvidence(source, limits, environment)).safeForHandoff !== true) throw new Error('RECOVERY_HANDOFF_UNSAFE');
      registryTransaction(source, db => {
        limits.check(); const current = JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value);
        if (current.state !== 'normal' || current.authorityId !== registry.state.authorityId) throw new Error('RECOVERY_SOURCE_CHANGED');
        setMeta(db, 'recovery_state', { ...current, state: 'retired', checkpointId, handoffId });
        setMeta(db, 'recovery_handoff', { schemaVersion: 1, checkpointId, handoffId, sourceAuthorityId: current.authorityId, registryId: registry.registryId, sourceIdentity: registry.identity, destinationHash: hash(target), sealed: true, manifestHash: hash(canonical(manifest)), admittedTarget: null });
        db.exec("UPDATE aw_owners SET status='closed'; UPDATE aw_accounts SET lease_until=0,fence=fence+1;");
      });
    }
    if (fs.existsSync(target)) throw new Error('RECOVERY_TARGET_EXISTS'); fs.renameSync(workspace, target); syncDirectory(path.dirname(target));
    // Dependency closure is not a successful independent restore or credential
    // decryption check. Only a known missing dependency yields definitive false.
    return { checkpointId, kind, destination: target, files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), restorable: dependencies.unresolvedDependencies.length ? false : null, unresolvedDependencyCount: dependencies.unresolvedDependencies.length, unresolvedDependencies: dependencies.unresolvedDependencies, ...(handoffId ? { handoffId, sourceState: 'retired' } : {}) };
  } catch (error) {
    // Never delete the only complete sealed payload after retirement.
    if (kind !== 'handoff' || readRegistry(source).handoff?.checkpointId !== checkpointId) fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { authenticate, canonical, decryptFile, fileHash, hash, keys, verify } from './crypto.mjs';
import { assertLifecycleLock } from './lifecycle-lock.mjs';
import { registryTransaction, setMeta } from './backup.mjs';
import { ASTER_CA, ASTER_ENV, budget, category, checkpointEvidence, CONTROL, databaseEvidence, identity, MODULES, readLockedRegistry, readRegistry, REGISTRY, safePath, safeRelative, syncDirectory, syncTreeDirectories, tables, within, writeJson } from './inventory.mjs';

// These represent structurally readable business journals that must survive a
// quarantined restore. Schema/JSON/enum failures and all future unknown reasons
// are rejected before publication instead of being treated as pending work.
const QUARANTINE_REASONS = new Set([
  'HUB_JOB_UNRESOLVED', 'HUB_ORDER_UNRESOLVED', 'HUB_WRITE_UNRESOLVED', 'HUB_EXECUTION_LOCK_REMAINS', 'HUB_CANCEL_UNRESOLVED',
  'WRITER_OPERATION_UNRESOLVED', 'CROSSEX_ORDER_UNRESOLVED', 'CROSSEX_EXECUTION_WITHOUT_ORDERS', 'CROSSEX_EXTERNAL_ORDER_UNRESOLVED',
  'GREEKS_AUTO_OPEN_ENABLED', 'GREEKS_ORDER_UNRESOLVED', 'GREEKS_TASK_UNRESOLVED', 'GREEKS_RFQ_UNRESOLVED',
  'GREEKS_STATE_MISSING',
  'ASTER_ACCOUNT_AUTOMATION_ENABLED', 'ASTER_PAIR_AUTOMATION_ENABLED', 'ASTER_INTENT_UNRESOLVED', 'ASTER_INTENT_OUTCOME_UNKNOWN',
  'ASTER_RECOVERY_OWNER_UNKNOWN', 'ASTER_CYCLE_UNRESOLVED', 'ASTER_POST_FILL_UNRESOLVED', 'ASTER_AUTO_RESUME_REMAINS',
  'ASTER_PAIR_UNRESOLVED', 'ASTER_TRANSFER_UNRESOLVED', 'ASTER_ADL_UNRESOLVED', 'ASTER_ADL_EVENT_UNRESOLVED',
]);

function loadJson(filename, max = 8 * 1024 * 1024) { safePath(filename); if (fs.statSync(filename).size > max) throw new Error('RECOVERY_DOCUMENT_TOO_LARGE'); try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('RECOVERY_JSON_INVALID'); } }
function manifestBody(document, dataKey, secretsKey, limits) {
  const body = verify(document, dataKey, secretsKey);
  if (body.schemaVersion !== 1 || body.protocol !== 'cold-checkpoint-v1' || !['backup', 'handoff'].includes(body.kind) || !/^[a-f0-9-]{36}$/.test(body.checkpointId ?? '') || canonical(body.modules) !== canonical(MODULES) || !Array.isArray(body.entries) || body.entries.length > limits.maxFiles) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
  const seen = new Set();
  for (const entry of body.entries) {
    safeRelative(entry.path); limits.add(entry.size);
    if (seen.has(entry.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(entry.payloadSha256 ?? '') || !['data','secrets'].includes(entry.category) || entry.category !== category(entry.path) || (/\.(?:sqlite|sqlite3|db)$/i.test(entry.path) && !entry.database)) throw new Error('RECOVERY_MANIFEST_INVALID');
    if (entry.path === CONTROL || entry.path === '.runtime.lock' || entry.path.startsWith('.recovery-stage-') || (entry.path.startsWith('_recovery/') && entry.path !== '_recovery/root.env')) throw new Error('RECOVERY_UNSAFE_PATH');
    seen.add(entry.path.toLowerCase());
  }
  for (const required of [REGISTRY, REGISTRY + '.required', 'hub.sqlite', 'credentials.key']) if (!seen.has(required)) throw new Error('RECOVERY_REQUIRED_MATERIAL_MISSING');
  validateBindings(body);
  return body;
}
function validateBindings(body) {
  const bindings = body.pathBindings ?? [], unresolved = body.unresolvedDependencies ?? [];
  if (!Array.isArray(bindings) || bindings.length > 1 || !Array.isArray(unresolved)) throw new Error('RECOVERY_DEPENDENCY_INVALID');
  if (unresolved.length) throw new Error('RECOVERY_DEPENDENCY_NOT_INCLUDED');
  for (const binding of bindings) {
    if (!binding || binding.envEntry !== ASTER_ENV || binding.key !== ASTER_CA || typeof binding.inherited !== 'boolean' || !/^[a-f0-9]{64}$/.test(binding.sourceValueHash ?? '') || Object.keys(binding).some(key => !['envEntry','key','relativeEntry','sourceValueHash','inherited'].includes(key))) throw new Error('RECOVERY_DEPENDENCY_INVALID');
    safeRelative(binding.relativeEntry);
    const dependency = body.entries.find(entry => entry.path === binding.relativeEntry);
    if (!body.entries.some(entry => entry.path === ASTER_ENV) || !dependency || dependency.database || dependency.path === ASTER_ENV || dependency.category !== 'secrets') throw new Error('RECOVERY_DEPENDENCY_NOT_INCLUDED');
  }
  return bindings;
}
function moduleEnvironment(directory) {
  const filename = path.join(directory, ASTER_ENV);
  if (!fs.existsSync(filename)) return { content: '', values: {} };
  safePath(filename); if (fs.statSync(filename).size > 8 * 1024 * 1024) throw new Error('RECOVERY_ENVIRONMENT_INVALID');
  const content = fs.readFileSync(filename, 'utf8'); return { content, values: parseEnv(content) };
}
function rebindEmbeddedPaths(stage, target, body) {
  const bindings = validateBindings(body), env = moduleEnvironment(stage);
  if (!bindings.length && env.values[ASTER_CA]?.trim()) throw new Error('RECOVERY_DEPENDENCY_BINDING_MISSING');
  for (const binding of bindings) {
    const oldValue = env.values[ASTER_CA];
    if (binding.inherited ? oldValue !== undefined : typeof oldValue !== 'string' || hash(oldValue) !== binding.sourceValueHash) throw new Error('RECOVERY_DEPENDENCY_INVALID');
    const destination = path.join(target, ...binding.relativeEntry.split('/'));
    const quote = destination.includes("'") ? '"' : "'";
    const assignment = `${ASTER_CA}=${quote}${destination}${quote}`;
    if (/[\r\n\0]/.test(destination) || parseEnv(assignment)[ASTER_CA] !== destination) throw new Error('RECOVERY_ENV_PATH_UNREPRESENTABLE');
    const content = env.content.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?ASTER_CAPACITY_RELAY_CA_FILE\s*=/.test(line)).join('\n').replace(/\n*$/, '') + '\n' + assignment + '\n';
    const filename = path.join(stage, ASTER_ENV), temporary = filename + '.tmp-' + randomUUID(); const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename); syncDirectory(path.dirname(filename));
  }
}
async function verifyEmbeddedPaths(directory, body, limits, { source = false, environment = {} } = {}) {
  const bindings = validateBindings(body), env = moduleEnvironment(directory);
  const effective = Object.hasOwn(env.values, ASTER_CA) ? env.values[ASTER_CA] : environment[ASTER_CA];
  if (!bindings.length && effective?.trim()) throw new Error('RECOVERY_DEPENDENCY_BINDING_MISSING');
  for (const binding of bindings) {
    const value = source && binding.inherited ? environment[ASTER_CA] : env.values[ASTER_CA];
    const expected = path.join(directory, ...binding.relativeEntry.split('/'));
    if (typeof value !== 'string' || (source ? hash(value) !== binding.sourceValueHash : value !== expected)) throw new Error('RECOVERY_DEPENDENCY_INVALID');
    const dependency = body.entries.find(entry => entry.path === binding.relativeEntry);
    if (await fileHash(safePath(expected), limits.check) !== dependency.sha256) throw new Error('RECOVERY_DEPENDENCY_INVALID');
  }
}
function validateCipher(value, key, { tagFirst = false, additionalData, asset = false } = {}) {
  if (!value) return;
  try {
    if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) throw new Error();
    let iv, encrypted, tag;
    if (asset) { const data = JSON.parse(value); iv = Buffer.from(data.iv); const all = Buffer.from(data.cipher); encrypted = all.subarray(0, -16); tag = all.subarray(-16); }
    else { const data = Buffer.from(value, 'base64'); iv = data.subarray(0,12); tag = tagFirst ? data.subarray(12,28) : data.subarray(-16); encrypted = tagFirst ? data.subarray(28) : data.subarray(12,-16); }
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag); if (additionalData !== undefined) cipher.setAAD(Buffer.from(additionalData));
    const plaintext = Buffer.concat([cipher.update(encrypted), cipher.final()]);
    if (asset || tagFirst) JSON.parse(plaintext.toString('utf8')); plaintext.fill(0);
  } catch { throw new Error('RECOVERY_CREDENTIAL_VALIDATION_FAILED'); }
}
function withDb(filename, action) { safePath(filename); const db = new DatabaseSync(filename); try { db.exec('PRAGMA busy_timeout=750; PRAGMA synchronous=FULL'); return action(db, tables(db)); } finally { db.close(); } }
function keyFile(filename) { safePath(filename); if (fs.statSync(filename).size !== 32) throw new Error('RECOVERY_CREDENTIAL_KEY_INVALID'); return fs.readFileSync(filename); }
function validateAndRevoke(directory) {
  const hubKey = keyFile(path.join(directory, 'credentials.key'));
  withDb(path.join(directory, 'hub.sqlite'), (db, present) => {
    for (const table of ['settings', 'projects', 'sessions']) if (!present.has(table)) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
    for (const table of ['projects','trading_accounts','execution_accounts']) if (present.has(table)) for (const row of db.prepare('SELECT credentials FROM ' + table + ' WHERE credentials IS NOT NULL').iterate()) validateCipher(row.credentials, hubKey, { tagFirst: true });
    for (const table of ['sessions','execution_previews','execution_lease','execution_entries']) if (present.has(table)) db.exec('DELETE FROM ' + table);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  });
  const cross = path.join(directory, 'modules/crossex/crossex.sqlite');
  if (fs.existsSync(cross)) {
    const crossKey = keyFile(path.join(directory, 'modules/crossex/credentials.key'));
    withDb(cross, (db, present) => {
      if (!present.has('settings')) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
      const password = db.prepare("SELECT value FROM settings WHERE key='monitorPassword'").get(); if (password) validateCipher(JSON.parse(password.value), crossKey);
      if (present.has('live_connection')) for (const row of db.prepare('SELECT json FROM live_connection').iterate()) { const value = JSON.parse(row.json); for (const k of ['apiKey','apiSecret']) validateCipher(value[k], crossKey); }
      for (const table of ['live_previews','live_owner']) if (present.has(table)) db.exec('DELETE FROM ' + table);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
  }
  const asset = path.join(directory, 'modules/asset/ledger.sqlite');
  const configFile = path.join(directory, 'modules/asset/config.json');
  if (fs.existsSync(asset) || fs.existsSync(configFile)) {
    const config = loadJson(configFile);
    if (!/^[a-f0-9]{64}$/i.test(config.credentialKey ?? '') || !/^[a-f0-9]{64}$/i.test(config.sessionSecret ?? '') || !/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(config.passwordHash ?? '')) throw new Error('RECOVERY_CREDENTIAL_KEY_INVALID');
    if (fs.existsSync(asset)) withDb(asset, (db, present) => {
      if (!present.has('connections') || !present.has('_schema_migrations')) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
      for (const row of db.prepare('SELECT owner,exchange,encrypted FROM connections').iterate()) validateCipher(row.encrypted, Buffer.from(config.credentialKey, 'hex'), { asset: true, additionalData: row.owner + ':' + row.exchange });
    });
    writeJson(configFile, { ...config, sessionSecret: randomBytes(32).toString('hex') }, { replace: true });
  }
}
function quarantineRegistry(directory, body, recoveryId, authorityId) {
  const registry = readRegistry(directory, { marker: false });
  if (registry.registryId !== body.registryId || registry.state.authorityId !== body.sourceAuthorityId) throw new Error('RECOVERY_REGISTRY_MISMATCH');
  registryTransaction(directory, db => {
    if (db.prepare('SELECT 1 FROM aw_accounts WHERE fence >= 9007199254740990 LIMIT 1').get() || db.prepare('SELECT 1 FROM aw_bindings WHERE generation >= 9007199254740990 LIMIT 1').get()) throw new Error('RECOVERY_FENCE_EXHAUSTED');
    setMeta(db, 'recovery_state', { schemaVersion: 1, state: 'quarantine', authorityId, recoveryId, checkpointId: body.checkpointId, sourceAuthorityId: body.sourceAuthorityId, ...(body.handoffId ? { handoffId: body.handoffId } : {}) });
    setMeta(db, 'recovery_epoch', randomUUID());
    db.exec("UPDATE aw_owners SET status='closed'; UPDATE aw_accounts SET lease_until=0,fence=fence+1; UPDATE aw_bindings SET generation=generation+1; UPDATE aw_operations SET state='unknown' WHERE state='sending';");
    // A restored copy is never allowed to consume its ancestor's authority record.
    db.prepare("DELETE FROM aw_meta WHERE key='recovery_handoff'").run();
  });
  writeJson(path.join(directory, REGISTRY + '.required'), { schema: 1, registryId: registry.registryId, ...identity(path.join(directory, REGISTRY)) }, { replace: true });
}
export async function restoreBackup(options) {
  const { backupDir, targetDir, dataKey, secretsKey, lock } = options; const materialKeys = keys(dataKey, secretsKey);
  const source = safePath(backupDir, { directory: true }), target = safePath(targetDir, { directory: true });
  if (within(source, target) || within(target, source)) throw new Error('RECOVERY_TARGET_OVERLAP');
  const limits = budget(options, () => assertLifecycleLock(lock, { dataDir: target })); limits.check();
  if (fs.readdirSync(target).some(name => name !== '.runtime.lock')) throw new Error('RECOVERY_TARGET_NOT_EMPTY');
  const manifest = loadJson(path.join(source, 'manifest.json')), body = manifestBody(manifest, dataKey, secretsKey, limits);
  limits.space(target, body.entries.reduce((n, e) => n + e.size + 1024, 0));
  const recoveryId = randomUUID(), authorityId = randomUUID(); const stage = path.join(target, '.recovery-stage-' + recoveryId);
  const baseControl = { schemaVersion: 1, state: 'quarantine', status: 'restoring', recoveryId, authorityId, manifest };
  writeJson(path.join(target, CONTROL), authenticate(baseControl, dataKey, secretsKey)); fs.mkdirSync(stage, { mode: 0o700 });
  for (const moduleId of MODULES) fs.mkdirSync(path.join(stage, 'modules', moduleId), { recursive: true, mode: 0o700 });
  try {
    for (let i = 0; i < body.entries.length; i++) {
      limits.check(); const entry = body.entries[i]; const filename = path.join(stage, ...entry.path.split('/')); fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const payload = safePath(path.join(source, entry.category, String(i) + '.gcm'));
      if (await fileHash(payload, limits.check) !== entry.payloadSha256) throw new Error('RECOVERY_HASH_MISMATCH');
      await decryptFile(payload, filename, materialKeys[entry.category], body.checkpointId, entry, limits.check);
      if (entry.database && canonical(await databaseEvidence(filename, limits)) !== canonical(entry.database)) throw new Error('RECOVERY_DATABASE_WATERMARK_MISMATCH');
      if (entry.path.endsWith('.json')) loadJson(filename, 64 * 1024 * 1024);
    }
    limits.check();
    rebindEmbeddedPaths(stage, target, body);
    const compatibility = await checkpointEvidence(stage, limits);
    if (compatibility.reasons.some(reason => !QUARANTINE_REASONS.has(reason.code))) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
    validateAndRevoke(stage);
    quarantineRegistry(stage, body, recoveryId, authorityId); syncTreeDirectories(stage); limits.check();
    // Publish the quarantined registry first. Interrupted publication cannot create
    // a normal empty registry; recovery-control remains incomplete until the end.
    for (const name of [REGISTRY, REGISTRY + '.required', ...fs.readdirSync(stage).filter(n => n !== REGISTRY && n !== REGISTRY + '.required')]) {
      limits.check(); if (fs.existsSync(path.join(target, name))) throw new Error('RECOVERY_TARGET_EXISTS'); fs.renameSync(path.join(stage, name), path.join(target, name));
    }
    fs.rmdirSync(stage); syncDirectory(target);
    const control = { ...baseControl, status: 'complete', targetIdentity: identity(path.join(target, REGISTRY)), completedAt: new Date().toISOString() };
    writeJson(path.join(target, CONTROL), authenticate(control, dataKey, secretsKey), { replace: true });
    return { recoveryId, authorityId, checkpointId: body.checkpointId, state: 'quarantine', targetDir: target };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true }); writeJson(path.join(target, CONTROL), authenticate({ ...baseControl, status: 'failed' }, dataKey, secretsKey), { replace: true }); throw error;
  }
}
export async function admitHandoff(options) {
  const { sourceDir, targetDir, sourceLock, targetLock, dataKey, secretsKey, environment = {} } = options;
  keys(dataKey, secretsKey); const source = safePath(sourceDir, { directory: true }), target = safePath(targetDir, { directory: true });
  if (within(source, target) || within(target, source)) throw new Error('RECOVERY_TARGET_OVERLAP');
  const held = () => { assertLifecycleLock(sourceLock, { dataDir: source }); assertLifecycleLock(targetLock, { dataDir: target }); }; const limits = budget(options, held); limits.check();
  const control = verify(loadJson(path.join(target, CONTROL)), dataKey, secretsKey); const body = verify(control.manifest, dataKey, secretsKey);
  if (control.status !== 'complete' || body.kind !== 'handoff' || body.schemaVersion !== 1) throw new Error('RECOVERY_HANDOFF_REQUIRED');
  await verifyEmbeddedPaths(source, body, limits, { source: true, environment });
  await verifyEmbeddedPaths(target, body, limits, { environment });
  const old = readLockedRegistry(source, sourceLock), restored = readLockedRegistry(target, targetLock); const record = old.handoff;
  if (old.state.state !== 'retired' || !record?.sealed || record.sourceAuthorityId !== old.state.authorityId || record.sourceAuthorityId !== body.sourceAuthorityId || record.checkpointId !== body.checkpointId || record.handoffId !== body.handoffId || record.registryId !== restored.registryId || body.registryId !== old.registryId || canonical(record.sourceIdentity) !== canonical(old.identity) || canonical(body.sourceIdentity) !== canonical(old.identity) || hash(canonical(control.manifest)) !== record.manifestHash) throw new Error('RECOVERY_HANDOFF_SOURCE_MISMATCH');
  if (restored.state.recoveryId !== control.recoveryId || restored.state.authorityId !== control.authorityId || restored.state.sourceAuthorityId !== body.sourceAuthorityId || restored.state.checkpointId !== body.checkpointId || restored.state.handoffId !== body.handoffId || canonical(restored.identity) !== canonical(control.targetIdentity) || !['quarantine','normal'].includes(restored.state.state)) throw new Error('RECOVERY_HANDOFF_TARGET_MISMATCH');
  const admittedTarget = { recoveryId: control.recoveryId, authorityId: control.authorityId, ...restored.identity };
  if (record.admittedTarget && canonical(record.admittedTarget) !== canonical(admittedTarget)) throw new Error('RECOVERY_HANDOFF_ALREADY_CONSUMED');
  // The live root-owned service environment is authoritative at admission.
  // An archived .env can be restored as material, but never grants admission.
  if ((await checkpointEvidence(source, limits, environment)).safeForHandoff !== true || (await checkpointEvidence(target, limits, environment)).safeForHandoff !== true) throw new Error('RECOVERY_HANDOFF_UNSAFE');
  registryTransaction(source, db => {
    limits.check(); const current = JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_handoff'").get().value);
    if (current.manifestHash !== record.manifestHash || (current.admittedTarget && canonical(current.admittedTarget) !== canonical(admittedTarget))) throw new Error('RECOVERY_HANDOFF_ALREADY_CONSUMED');
    setMeta(db, 'recovery_handoff', { ...current, admittedTarget });
    setMeta(db, 'recovery_state', { ...old.state, admittedTarget });
  });
  // Source consumption is durable before target activation. A crash can retry
  // this same DB inode and recovery ID; a second clone cannot consume it.
  registryTransaction(target, db => { limits.check(); const current = JSON.parse(db.prepare("SELECT value FROM aw_meta WHERE key='recovery_state'").get().value); if (current.authorityId !== control.authorityId || current.recoveryId !== control.recoveryId) throw new Error('RECOVERY_HANDOFF_TARGET_MISMATCH'); setMeta(db, 'recovery_state', { ...current, state: 'normal' }); });
  writeJson(path.join(target, CONTROL), authenticate({ ...control, state: 'normal', admittedAt: new Date().toISOString() }, dataKey, secretsKey), { replace: true });
  return { recoveryId: control.recoveryId, authorityId: control.authorityId, state: 'normal', sourceState: 'retired' };
}

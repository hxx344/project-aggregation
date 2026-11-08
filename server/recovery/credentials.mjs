import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { credentialKey, DATA_CATALOG } from './data-catalog.mjs';
import { safePath } from './inventory.mjs';

// Read-only checks that the material declared as `key` in data-catalog.mjs
// decrypts the credentials stored next to it. A handoff runs them on the source
// before retiring it, and a restore runs them on the staged copy before
// publishing: the archive is a snapshot of the source, so a source that passes
// here restores past these checks, and one that fails would never restore.
// For a handoff that equivalence rests on the lifecycle lock keeping the source
// unchanged between this check and the copy.

// A declared database that is present needs its key material present.
export function checkCredentialMaterial(root) {
  for (const entry of DATA_CATALOG) {
    if (entry.key && fs.existsSync(path.join(root, entry.path)) && !fs.existsSync(path.join(root, entry.key))) throw new Error('RECOVERY_CREDENTIAL_KEY_MISSING');
  }
}
// The Asset configuration holds the key of its stored credentials and the session secret.
export function readCredentialConfig(filename, max = 8 * 1024 * 1024) {
  safePath(filename); if (fs.statSync(filename).size > max) throw new Error('RECOVERY_DOCUMENT_TOO_LARGE');
  let config; try { config = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('RECOVERY_JSON_INVALID'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !/^[a-f0-9]{64}$/i.test(config.credentialKey ?? '') || !/^[a-f0-9]{64}$/i.test(config.sessionSecret ?? '') || !/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(config.passwordHash ?? '')) throw new Error('RECOVERY_CREDENTIAL_KEY_INVALID');
  return config;
}
// A stored record that is not JSON cannot hold credentials that decrypt.
function storedJson(text) { try { return JSON.parse(text); } catch { throw new Error('RECOVERY_CREDENTIAL_VALIDATION_FAILED'); } }
function keyFile(filename) { safePath(filename); if (fs.statSync(filename).size !== 32) throw new Error('RECOVERY_CREDENTIAL_KEY_INVALID'); return fs.readFileSync(filename); }
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

/**
 * Checks every declared database's credentials against its key material.
 * `open(filename, action)` opens the database read-only for the source or
 * writable for a staged copy and calls action(db, tableNames). Returns the
 * Asset configuration when one is present.
 */
export function validateCredentials(root, open) {
  checkCredentialMaterial(root);
  const hubKey = keyFile(path.join(root, credentialKey('hub.sqlite')));
  open(path.join(root, 'hub.sqlite'), (db, present) => {
    for (const table of ['settings', 'projects', 'sessions']) if (!present.has(table)) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
    for (const table of ['projects','trading_accounts','execution_accounts']) if (present.has(table)) for (const row of db.prepare('SELECT credentials FROM ' + table + ' WHERE credentials IS NOT NULL').iterate()) validateCipher(row.credentials, hubKey, { tagFirst: true });
  });
  const cross = path.join(root, 'modules/crossex/crossex.sqlite');
  if (fs.existsSync(cross)) {
    const crossKey = keyFile(path.join(root, credentialKey('modules/crossex/crossex.sqlite')));
    open(cross, (db, present) => {
      if (!present.has('settings')) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
      const password = db.prepare("SELECT value FROM settings WHERE key='monitorPassword'").get(); if (password) validateCipher(storedJson(password.value), crossKey);
      if (present.has('live_connection')) for (const row of db.prepare('SELECT json FROM live_connection').iterate()) { const value = storedJson(row.json); for (const k of ['apiKey','apiSecret']) validateCipher(value?.[k], crossKey); }
    });
  }
  const asset = path.join(root, 'modules/asset/ledger.sqlite');
  const configFile = path.join(root, credentialKey('modules/asset/ledger.sqlite'));
  if (!fs.existsSync(asset) && !fs.existsSync(configFile)) return null;
  const config = readCredentialConfig(configFile);
  if (fs.existsSync(asset)) open(asset, (db, present) => {
    if (!present.has('connections') || !present.has('_schema_migrations')) throw new Error('RECOVERY_SCHEMA_UNSUPPORTED');
    for (const row of db.prepare('SELECT owner,exchange,encrypted FROM connections').iterate()) validateCipher(row.encrypted, Buffer.from(config.credentialKey, 'hex'), { asset: true, additionalData: row.owner + ':' + row.exchange });
  });
  return { configFile, config };
}

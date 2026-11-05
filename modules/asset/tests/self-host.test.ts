import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../lib/sqlite.ts';
import { createSession, validSession, verifyPassword, SESSION_SECONDS } from '../lib/auth-core.ts';
import { configure } from '../scripts/configure.mjs';

test('SQLite upgrades preserve data, drop removed Aero LP rows, isolate owners and roll back a failed batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-database-'));
  let database;
  try {
    const filename = join(dir, 'ledger.sqlite'), previous = join(dir, 'previous-migrations');
    // Start from the schema before fill_cache, lock tokens and the Aero LP cleanup existed, as an installed ledger would.
    cpSync(resolve('drizzle'), previous, { recursive: true, filter: source => !['0002_fill_cache.sql', '0003_sync_lock_token.sql', '0004_remove_aero_lp.sql'].some(name => source.endsWith(name)) });
    database = openDatabase(filename, previous);
    await database.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'row-1', '{"value":123}').run();
    await database.prepare('INSERT INTO sync_locks(owner,expires) VALUES (?,?)').bind('owner', 1).run();
    await database.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'row-9', '{"mode":"aero","value":5}').run();
    await database.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'row-8', 'not json').run();
    await database.prepare('INSERT INTO settings VALUES (?,?,?)').bind('owner', 'aero-lp', 'null').run();
    await database.prepare('INSERT INTO settings VALUES (?,?,?)').bind('owner', 'last-attempt', '1').run();
    await assert.rejects(database.batch([
      database.prepare('INSERT INTO assets VALUES (?,?,?)').bind('other', 'row-2', '{}'),
      database.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'row-1', '{}'),
    ]));
    assert.equal(await database.prepare('SELECT data FROM assets WHERE owner=?').bind('other').first(), null);
    database.close(); database = openDatabase(filename, resolve('drizzle'));
    assert.deepEqual((await database.prepare('SELECT id FROM assets WHERE owner=? ORDER BY id').bind('owner').all()).results.map(row => row.id), ['row-1', 'row-8'], 'Only the synced Aero LP row is removed');
    assert.deepEqual((await database.prepare('SELECT key FROM settings WHERE owner=?').bind('owner').all()).results.map(row => row.key), ['last-attempt']);
    assert.equal((await database.prepare('SELECT * FROM _schema_migrations').all()).results.length, 5);
    assert.deepEqual({ ...await database.prepare('SELECT * FROM sync_locks').first() }, { owner: 'owner', expires: 1, token: '' }, 'A lock left by the old version expires normally');
    assert.deepEqual((await database.prepare('SELECT * FROM fill_cache').all()).results, []);
  } finally { database?.close(); rmSync(dir, { recursive: true }); }
});

test('Repeated setup preserves config; password reset preserves exchange encryption but invalidates sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-config-'));
  try {
    configure(dir, { password: 'a-test-password-123' });
    const original = readFileSync(join(dir, 'config.json'), 'utf8');
    assert.equal(configure(dir).created, false);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), original);
    const before = JSON.parse(original);
    assert.equal(await verifyPassword('a-test-password-123', before.passwordHash), true);
    assert.equal(await verifyPassword('wrong-test-password', before.passwordHash), false);
    const session = createSession(before.sessionSecret);
    configure(dir, { password: 'new-test-password-123', reset: true });
    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(before.credentialKey, after.credentialKey);
    assert.equal(validSession(session, after.sessionSecret), false);
    assert.equal(await verifyPassword('new-test-password-123', after.passwordHash), true);
  } finally { rmSync(dir, { recursive: true }); }
});

test('Sessions reject tampering, wrong keys, expiration and arbitrary identity headers', () => {
  const secret = 'fixture-session-secret', now = 1000000000;
  const session = createSession(secret, now);
  assert.equal(validSession(session, secret, now), true);
  assert.equal(validSession(session + '.extra', secret, now), false);
  assert.equal(validSession('forged.' + session.split('.')[1], secret, now), false);
  assert.equal(validSession(session, 'another-key', now), false);
  assert.equal(validSession(session, secret, now + SESSION_SECONDS * 1000), false);
  assert.equal(validSession('oai-authenticated-user-id:owner', secret, now), false);
});

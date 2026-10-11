import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager } from '../server/session-manager.mjs';
import { DatabaseSync } from 'node:sqlite';

describe('Session Manager', () => {
  it('creates and retrieves valid sessions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL)');
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const manager = createSessionManager(db, logger);

    const raw = 'test-session-raw-token-value-here-43chars';
    const csrf = 'csrf-token';
    const now = Date.now();

    manager.create(raw, csrf, now);

    const req = { headers: { cookie: `hub_session=${raw}` } };
    const session = manager.get(req);

    assert.ok(session);
    assert.equal(session.csrf, csrf);
    assert.ok(session.expires > now);

    db.close();
  });

  it('rejects expired sessions', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL)');
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const manager = createSessionManager(db, logger);

    const raw = 'expired-session-raw-token-value-here-43ch';
    const csrf = 'csrf-token';
    const now = Date.now();
    const expired = now - 10000; // 10 seconds ago

    // Manually insert expired session
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(raw).digest('hex');
    db.prepare('INSERT INTO sessions(id,csrf,expires) VALUES (?,?,?)').run(hash, csrf, expired);

    const req = { headers: { cookie: `hub_session=${raw}` } };
    const session = manager.get(req);

    assert.equal(session, null);

    db.close();
  });

  it('destroys sessions correctly', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL)');
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const manager = createSessionManager(db, logger);

    const raw = 'destroy-session-raw-token-value-here-43ch';
    const csrf = 'csrf-token';
    const now = Date.now();

    manager.create(raw, csrf, now);

    const req = { headers: { cookie: `hub_session=${raw}` } };
    const session = manager.get(req);
    assert.ok(session);

    manager.destroy(session.id);

    const sessionAfterDestroy = manager.get(req);
    assert.equal(sessionAfterDestroy, null);

    db.close();
  });
});

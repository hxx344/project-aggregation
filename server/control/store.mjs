import { createStatementCache } from '../db-cache.mjs';

// Control-plane rows of hub.sqlite: settings, sessions and project configuration.
// Snapshots and the trading tables belong to the data plane and stay with their owners.
export function createControlStore(db) {
  const stmt = createStatementCache(db);
  const getSetting = key => stmt.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const setSetting = (key, value) => stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  return {
    db, stmt, getSetting, setSetting,
    sessions: {
      find: id => stmt.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(id, Date.now()) || null,
      isActive: id => !!stmt.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(id, Date.now()),
      create: (id, csrf, expires) => stmt.prepare('INSERT INTO sessions(id,csrf,expires) VALUES (?,?,?)').run(id, csrf, expires),
      delete: id => stmt.prepare('DELETE FROM sessions WHERE id=?').run(id),
      deleteExpired: now => stmt.prepare('DELETE FROM sessions WHERE expires<=?').run(now),
      clear: () => db.exec('DELETE FROM sessions'),
    },
    projects: {
      all: () => stmt.prepare('SELECT * FROM projects').all(),
      get: id => stmt.prepare('SELECT * FROM projects WHERE id=?').get(id),
      exists: id => !!stmt.prepare('SELECT id FROM projects WHERE id=?').get(id),
      insert: (id, json, credentials) => stmt.prepare('INSERT INTO projects(id,json,credentials) VALUES (?,?,?)').run(id, json, credentials),
      update: (id, json, credentials) => stmt.prepare('UPDATE projects SET json=?,credentials=? WHERE id=?').run(json, credentials, id),
      delete: id => stmt.prepare('DELETE FROM projects WHERE id=?').run(id),
    },
  };
}

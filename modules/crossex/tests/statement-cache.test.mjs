import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStatementCache } from '../server/statement-cache.mjs';
import { fixture } from './fixtures.mjs';

test('cached statements rebind parameters and read current data after writes and rollback', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE amounts (id TEXT PRIMARY KEY, amount INTEGER)');
  const prepare = db.prepare.bind(db), counts = new Map();
  db.prepare = sql => { counts.set(sql, (counts.get(sql) || 0) + 1); return prepare(sql); };
  const cache = createStatementCache(db);
  const select = 'SELECT amount FROM amounts WHERE id=?';
  const insert = 'INSERT INTO amounts VALUES (?,?)';
  cache.prepare(insert).run('first', 1);
  cache.prepare(insert).run('second', 2);
  assert.equal(cache.prepare(select).get('first').amount, 1);
  assert.equal(cache.prepare(select).get('second').amount, 2);
  db.prepare('UPDATE amounts SET amount=? WHERE id=?').run(3, 'first');
  assert.equal(cache.prepare(select).get('first').amount, 3);
  db.exec('BEGIN');
  cache.prepare('UPDATE amounts SET amount=? WHERE id=?').run(9, 'first');
  assert.equal(cache.prepare(select).get('first').amount, 9);
  db.exec('ROLLBACK');
  assert.equal(cache.prepare(select).get('first').amount, 3);
  assert.equal(cache.prepare(select).get('missing'), undefined);
  assert.equal(counts.get(select), 1);
  assert.equal(counts.get(insert), 1);
});

test('cache is bounded, releases entries on clear and does not retain failed prepares', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const cache = createStatementCache(db, 2);
  const first = cache.prepare('SELECT 1');
  assert.equal(cache.prepare('SELECT 1'), first);
  cache.prepare('SELECT 2');
  cache.prepare('SELECT 3');
  assert.notEqual(cache.prepare('SELECT 1'), first);
  const third = cache.prepare('SELECT 3');
  cache.clear();
  assert.notEqual(cache.prepare('SELECT 3'), third);
  assert.throws(() => cache.prepare('SELECT * FROM created_later'));
  db.exec('CREATE TABLE created_later (value INTEGER)');
  assert.deepEqual(cache.prepare('SELECT * FROM created_later').all(), []);
});

test('independent connections never share statements', t => {
  const a = new DatabaseSync(':memory:'), b = new DatabaseSync(':memory:');
  t.after(() => { a.close(); b.close(); });
  const first = createStatementCache(a), second = createStatementCache(b);
  for (const db of [a, b]) db.exec('CREATE TABLE values_by_connection (value INTEGER)');
  a.prepare('INSERT INTO values_by_connection VALUES (?)').run(1);
  b.prepare('INSERT INTO values_by_connection VALUES (?)').run(2);
  const sql = 'SELECT value FROM values_by_connection';
  assert.notEqual(first.prepare(sql), second.prepare(sql));
  assert.equal(first.prepare(sql).get().value, 1);
  assert.equal(second.prepare(sql).get().value, 2);
});

test('store preserves the raw database API and creates fresh statements after reopen', async t => {
  const f = fixture(t), sql = 'SELECT value FROM settings WHERE key=?';
  f.store.set('cached-test', 1);
  const closedStore = f.store, statement = closedStore.prepare(sql);
  assert.equal(closedStore.prepare(sql), statement);
  closedStore.db.prepare('UPDATE settings SET value=? WHERE key=?').run('2', 'cached-test');
  assert.equal(closedStore.get('cached-test'), 2);
  await f.reopen();
  assert.throws(() => closedStore.prepare(sql));
  assert.throws(() => statement.get('cached-test'));
  assert.notEqual(f.store.prepare(sql), statement);
  assert.equal(f.store.get('cached-test'), 2);
});

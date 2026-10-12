import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/sqlite.ts';

test('compiled SQL is reused while interleaved owner bindings and current rows stay independent', async t => {
  const sql = 'SELECT data FROM assets WHERE owner=? AND id=?';
  const original = DatabaseSync.prototype.prepare;
  let compilations = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, query: string) {
    if (query === sql) compilations++;
    return original.call(this, query);
  });
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const insert = database.prepare('INSERT INTO assets VALUES (?,?,?)');
  await database.batch([
    insert.bind('alice', 'row', '{"value":1}'),
    insert.bind('bob', 'row', '{"value":2}'),
  ]);
  const query = database.prepare(sql);
  const alice = query.bind('alice', 'row'), bob = query.bind('bob', 'row');
  const [first, second] = await Promise.all([alice.first<{ data: string }>(), bob.all<{ data: string }>()]);
  assert.equal(first?.data, '{"value":1}');
  assert.equal(second.results[0].data, '{"value":2}');
  await database.prepare('UPDATE assets SET data=? WHERE owner=?').bind('{"value":3}', 'alice').run();
  assert.equal((await alice.first<{ data: string }>())?.data, '{"value":3}');
  assert.equal((await bob.first<{ data: string }>())?.data, '{"value":2}');
  assert.equal(compilations, 1);

  await assert.rejects(database.batch([
    insert.bind('alice', 'rolled-back', '{}'),
    insert.bind('alice', 'row', '{}'),
  ]));
  assert.equal(await query.bind('alice', 'rolled-back').first(), null);
  await insert.bind('alice', 'after-rollback', '{}').run();
  assert.equal((await query.bind('alice', 'after-rollback').first<{ data: string }>())?.data, '{}');
  assert.equal(compilations, 1);
});

test('compiled statements stay scoped to an open connection, including retained wrappers after close', async () => {
  const first = openDatabase(':memory:'), second = openDatabase(':memory:');
  const sql = 'SELECT data FROM assets WHERE owner=?';
  let firstClosed = false;
  try {
    await first.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'a', 'first').run();
    await second.prepare('INSERT INTO assets VALUES (?,?,?)').bind('owner', 'a', 'second').run();
    const query = first.prepare(sql).bind('owner');
    assert.equal((await query.first<{ data: string }>())?.data, 'first');
    assert.equal((await second.prepare(sql).bind('owner').first<{ data: string }>())?.data, 'second');
    first.close(); firstClosed = true;
    await assert.rejects(query.first());
    await assert.rejects(first.prepare(sql).bind('owner').all());
    assert.equal((await second.prepare(sql).bind('owner').first<{ data: string }>())?.data, 'second');
  } finally { if (!firstClosed) first.close(); second.close(); }
});

test('dynamic query churn evicts compiled SQL without invalidating a previously bound wrapper', async t => {
  const sql = 'SELECT ? AS value';
  const original = DatabaseSync.prototype.prepare;
  let compilations = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, query: string) {
    if (query === sql) compilations++;
    return original.call(this, query);
  });
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const retained = database.prepare(sql).bind('retained');
  assert.equal((await retained.first<{ value: string }>())?.value, 'retained');
  for (let index = 0; index < 256; index++) {
    assert.equal((await database.prepare(`SELECT ${index} AS value`).first<{ value: number }>())?.value, index);
  }
  assert.equal((await retained.first<{ value: string }>())?.value, 'retained');
  assert.equal(compilations, 2);
  assert.equal((await database.prepare(sql).bind('new binding').first<{ value: string }>())?.value, 'new binding');
  assert.equal(compilations, 2);
});

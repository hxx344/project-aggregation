import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, StoreError, openStore } from '../src/store.ts';

function withDir(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-store-'));
  try { run(join(dir, 'executor.sqlite')); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const storeCode = (expected: string) => (error: unknown) => error instanceof StoreError && error.code === expected;

test('存储：WAL、完整同步、外键与迁移记录', () => withDir(file => {
  const store = openStore(file);
  try {
    assert.equal((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((store.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
    assert.equal((store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)!.version);
  } finally { store.close(); }
  const again = openStore(file);
  assert.equal(again.schemaVersion(), MIGRATIONS.at(-1)!.version);
  again.close();
}));

test('存储：迁移定义漂移或数据库版本更新时拒绝打开', () => withDir(file => {
  openStore(file).close();
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE schema_migrations SET sql_sha256 = 'x' WHERE version = 1").run();
  raw.close();
  assert.throws(() => openStore(file), storeCode('schema_drift'));
  const fix = new DatabaseSync(file);
  fix.prepare('DELETE FROM schema_migrations').run();
  fix.close();
}));

test('存储：数据库版本比程序新时拒绝打开', () => withDir(file => {
  openStore(file).close();
  const raw = new DatabaseSync(file);
  raw.prepare("INSERT INTO schema_migrations(version, name, sql_sha256, applied_at) VALUES (99, 'future', 'x', 0)").run();
  raw.close();
  assert.throws(() => openStore(file), storeCode('newer_schema'));
}));

test('存储：事务不可嵌套、不可异步，失败回滚，并记录等待与持锁样本', () => withDir(file => {
  const store = openStore(file);
  try {
    const before = store.stats();
    assert.throws(() => store.tx(() => store.tx(() => 1)), storeCode('nested_transaction'));
    assert.throws(() => store.tx(() => Promise.resolve(1)), storeCode('async_transaction'));
    assert.throws(() => store.tx(() => { store.db.prepare("INSERT INTO events(job_id, type, at, json) VALUES (NULL, 'x', 0, '{}')").run(); throw new Error('boom'); }), /boom/);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0);
    assert.equal(store.db.isTransaction, false);
    const stats = store.stats();
    assert.equal(stats.transactions - before.transactions, 3);
    assert.equal(stats.holds.length - before.holds.length, 3);
  } finally { store.close(); }
}));

test('存储：另一连接持有写锁时，等待超时计为 busy', () => withDir(file => {
  const store = openStore(file, { busyTimeoutMs: 20 });
  const other = new DatabaseSync(file);
  try {
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => store.tx(() => 1));
    assert.equal(store.stats().busy, 1);
  } finally { other.exec('ROLLBACK'); other.close(); store.close(); }
}));

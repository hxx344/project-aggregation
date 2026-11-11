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

const KIB = 1024;
function fillWal(store: ReturnType<typeof openStore>, bytes: number) {
  const insert = store.db.prepare("INSERT INTO events(job_id, type, at, json) VALUES (NULL, 'fill', 0, ?)");
  store.tx(() => { for (let written = 0; written < bytes; written += 4 * KIB) insert.run('x'.repeat(4 * KIB)); });
}

test('存储：WAL 超过阈值且没有读取方占用时截断，未超过时不动', () => withDir(file => {
  const store = openStore(file, { walResetBytes: 64 * KIB });
  try {
    // The migrations of a new database already exceed this small threshold.
    store.maintainWal();
    fillWal(store, 8 * KIB);
    const small = store.walBytes();
    assert.ok(small > 0 && small <= 64 * KIB);
    assert.equal(store.maintainWal().action, 'idle');
    assert.equal(store.walBytes(), small);
    fillWal(store, 256 * KIB);
    assert.ok(store.walBytes() > 64 * KIB);
    const result = store.maintainWal();
    assert.equal(result.action, 'reset');
    assert.equal(result.walBytes, 0);
    assert.equal(store.walBytes(), 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 66);
  } finally { store.close(); }
}));

test('存储：读取方占着旧快照时 WAL 截断有界放弃并延后重试，读取结束后恢复', () => withDir(file => {
  const store = openStore(file, { busyTimeoutMs: 4321, walResetBytes: 64 * KIB, walResetWaitMs: 20 });
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM events').get();
    fillWal(store, 256 * KIB);
    const started = Date.now();
    const blocked = store.maintainWal(1_000);
    assert.equal(blocked.action, 'busy');
    assert.ok(Date.now() - started < 2_000, '放弃前的等待有界');
    assert.ok(blocked.walBytes > 64 * KIB);
    assert.equal((store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 4321);
    // The write path still works while the reader pins the WAL.
    fillWal(store, 8 * KIB);
    reader.exec('COMMIT');
    assert.equal(store.maintainWal(1_500).action, 'waiting', '延后期内不重试');
    assert.equal(store.maintainWal(2_000).action, 'reset');
    assert.equal(store.walBytes(), 0);
    // A second failure waits twice as long.
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM events').get();
    fillWal(store, 256 * KIB);
    assert.equal(store.maintainWal(10_000).action, 'busy');
    assert.equal(store.maintainWal(10_999).action, 'waiting');
    assert.equal(store.maintainWal(11_000).action, 'busy');
    assert.equal(store.maintainWal(12_999).action, 'waiting');
    reader.exec('COMMIT');
    assert.equal(store.maintainWal(13_000).action, 'reset');
  } finally { reader.close(); store.close(); }
}));

test('存储：事务中不做 WAL 截断；连续放弃后的重试间隔最长 60 秒', () => withDir(file => {
  const store = openStore(file, { walResetBytes: 64 * KIB, walResetWaitMs: 20 });
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    fillWal(store, 256 * KIB);
    store.tx(() => {
      assert.equal(store.maintainWal(0).action, 'waiting');
      assert.ok(store.walBytes() > 64 * KIB);
    });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM events').get();
    fillWal(store, 8 * KIB);
    // Delays after each failure: 1, 2, 4, 8, 16, 32, then 60 seconds for good.
    let now = 0;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      assert.equal(store.maintainWal(now).action, 'busy');
      assert.equal(store.maintainWal(now + delay - 1).action, 'waiting');
      now += delay;
    }
    reader.exec('COMMIT');
    assert.equal(store.maintainWal(now).action, 'reset');
  } finally { reader.close(); store.close(); }
}));

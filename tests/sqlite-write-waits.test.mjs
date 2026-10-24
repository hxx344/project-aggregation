import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openHubDatabase, immediate, isSqliteBusy, writeWaitStats, logWriteWaits, WRITE_WAIT_BUCKETS_MS } from '../server/control/schema.mjs';
import { errorResponder, HttpError, DATABASE_BUSY, INTERNAL_ERROR } from '../server/http-common.mjs';

// The write lock statistics and the busy mapping of design doc 5.6. The
// statistics are per process, so each test compares against its own start.
async function hub(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'write-waits-'));
  const file = path.join(dir, 'hub.sqlite'), db = openHubDatabase(file);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  return { db, file };
}
const diff = (after, before) => ({ transactions: after.transactions - before.transactions, busy: after.busy - before.busy, waitBuckets: after.waitBuckets.map((count, index) => count - before.waitBuckets[index]) });

test('a write that waited for another connection lands in its wait bucket; one that ran out of busy_timeout counts as busy', async t => {
  const { db, file } = await hub(t);
  // Another thread holds the write lock for 150 ms, so this thread's BEGIN IMMEDIATE waits 100 ms to 1 s.
  const lock = new SharedArrayBuffer(4), held = new Int32Array(lock);
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.file), held = new Int32Array(workerData.lock);
    db.exec('BEGIN IMMEDIATE'); Atomics.store(held, 0, 1); Atomics.notify(held, 0);
    Atomics.wait(held, 0, 1, 150); db.exec('COMMIT'); db.close();
  `, { eval: true, workerData: { file, lock } });
  t.after(() => worker.terminate());
  Atomics.wait(held, 0, 0, 5000);
  let before = writeWaitStats();
  assert.equal(immediate(db, () => 'written'), 'written');
  let change = diff(writeWaitStats(), before);
  assert.deepEqual(change, { transactions: 1, busy: 0, waitBuckets: [0, 0, 0, 1, 0, 0] });
  assert.ok(writeWaitStats().maxWaitMs >= 100);
  assert.deepEqual(WRITE_WAIT_BUCKETS_MS, [1, 10, 100, 1000, 5000]);

  const holder = new DatabaseSync(file);
  t.after(() => holder.close());
  holder.exec('BEGIN IMMEDIATE');
  db.exec('PRAGMA busy_timeout=20');
  before = writeWaitStats();
  try { assert.throws(() => immediate(db, () => assert.fail('the transaction body ran without the lock')), error => isSqliteBusy(error)); }
  finally { holder.exec('ROLLBACK'); }
  change = diff(writeWaitStats(), before);
  assert.deepEqual(change, { transactions: 0, busy: 1, waitBuckets: [0, 0, 0, 0, 0, 0] });
});

test('a failing transaction body rolls back and still counts its wait and hold time', async t => {
  const { db } = await hub(t);
  const before = writeWaitStats();
  assert.throws(() => immediate(db, () => {
    db.prepare("INSERT INTO settings(key,value) VALUES ('probe','1')").run();
    const until = performance.now() + 30; while (performance.now() < until);
    throw new Error('body failed');
  }), /body failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key='probe'").get().count, 0);
  assert.equal(diff(writeWaitStats(), before).transactions, 1);
  assert.ok(writeWaitStats().maxHoldMs >= 30);
  assert.equal(isSqliteBusy(new Error('database is locked')), false, 'only node:sqlite errors with the busy code');
  assert.equal(isSqliteBusy(Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errcode: 517 })), true, 'an extended busy code');
  assert.equal(isSqliteBusy(Object.assign(new Error('full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })), false);
});

test('busy writes are a 503 with their own message; other unexpected errors stay a 500', () => {
  const respond = errorResponder([HttpError]);
  assert.deepEqual(respond(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })), { status: 503, body: { error: DATABASE_BUSY } });
  assert.deepEqual(respond(Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })), { status: 500, body: { error: INTERNAL_ERROR } });
  assert.deepEqual(respond(new HttpError(409, 'conflict')), { status: 409, body: { error: 'conflict' } });
});

test('the statistics are logged only when they changed, also when logging stops', async t => {
  const { db } = await hub(t);
  const lines = [], logger = { info: fields => lines.push(fields) };
  const stop = logWriteWaits({ logger, role: 'runtime', intervalMs: 20 });
  immediate(db, () => {});
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(lines.length, 1, 'one line for the change, none for the unchanged intervals after it');
  assert.equal(lines[0].type, 'sqlite_write_waits'); assert.equal(lines[0].role, 'runtime');
  assert.deepEqual(lines[0].bucketsMs, WRITE_WAIT_BUCKETS_MS);
  assert.equal(lines[0].transactions, writeWaitStats().transactions);
  stop();
  assert.equal(lines.length, 1, 'nothing changed since the last line');
  const again = logWriteWaits({ logger, role: 'api', intervalMs: 60_000 });
  immediate(db, () => {});
  again();
  assert.equal(lines.length, 2); assert.equal(lines[1].role, 'api');
});

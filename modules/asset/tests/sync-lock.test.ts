import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/sqlite.ts';
import { acquireSyncLock, LOCK_BUSY, LOCK_LOST } from '../lib/sync-lock.ts';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const database = openDatabase(':memory:');
  t.after(() => database.close());
  const clock = { at: 1_000_000 };
  const acquire = () => acquireSyncLock(database, 'owner', { now: () => clock.at });
  const lockToken = () => database.prepare('SELECT token FROM sync_locks WHERE owner = ?').bind('owner').get<{ token: string }>()?.token ?? null;
  const writes = () => database.prepare("SELECT value FROM settings WHERE owner = 'owner' AND key = 'probe'").rows<{ value: string }>().map(row => row.value);
  const probe = (value: string) => () => { database.prepare("INSERT INTO settings(owner,key,value) VALUES('owner','probe',?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value").bind(value).execute(); };
  return { database, clock, acquire, lockToken, writes, probe };
}

test('a stalled task past its TTL cannot release the next lock or write over it', async t => {
  const f = fixture(t);
  const stale = await f.acquire();
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  // The stale task's renewals never run (stalled), so its lease lapses.
  f.clock.at += 120_001;
  const next = await f.acquire();
  assert.equal(f.lockToken(), next.token);
  assert.throws(() => stale.write(f.probe('stale')), { message: LOCK_LOST });
  await stale.release();
  assert.equal(f.lockToken(), next.token, 'The old finally must not delete the newer lock');
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  next.write(f.probe('next'));
  assert.deepEqual(f.writes(), ['next']);
  await next.release();
  assert.equal(f.lockToken(), null);
});

test('an expired lease cannot write even when nobody took the lock over', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  f.clock.at += 120_001;
  assert.throws(() => lease.write(f.probe('late')), { message: LOCK_LOST });
  assert.deepEqual(f.writes(), []);
});

test('a failing write rolls back and keeps the lease usable', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  assert.throws(() => lease.write(() => { f.probe('partial')(); throw new Error('boom'); }), { message: 'boom' });
  assert.deepEqual(f.writes(), []);
  lease.write(f.probe('ok'));
  assert.deepEqual(f.writes(), ['ok']);
});

test('a live task renews its lease, but only until the overall hold limit', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  for (let elapsed = 0; elapsed < 570_000; elapsed += 30_000) { f.clock.at += 30_000; t.mock.timers.tick(30_000); }
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  lease.write(f.probe('renewed'));
  // Renewal never extends past ten minutes from acquisition, so a stuck task is bounded.
  f.clock.at += 30_000; t.mock.timers.tick(30_000);
  f.clock.at += 1;
  assert.throws(() => lease.write(f.probe('overdue')), { message: LOCK_LOST });
  const next = await f.acquire();
  await lease.release();
  assert.equal(f.lockToken(), next.token);
  assert.deepEqual(f.writes(), ['renewed']);
});

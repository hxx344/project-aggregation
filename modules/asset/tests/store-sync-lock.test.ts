import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the real lib/store.ts: resolve its extensionless imports and swap only the modules with
// external effects (exchanges, vault, positions cache, database file) for tests/fixtures/store-fakes.ts.
const fakes = new URL('./fixtures/store-fakes.ts', import.meta.url).href;
const faked = new Set(['./exchanges', './okx', './gate', './variational', './fx', './vault', './hub-positions', './sqlite']);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/lib/store.ts') && faked.has(specifier)) return { url: fakes, shortCircuit: true };
    if (specifier.startsWith('./') && !/\.\w+$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    if (specifier.endsWith('.json')) return { ...nextResolve(specifier, context), importAttributes: { type: 'json' } };
    return nextResolve(specifier, context);
  },
});
const dataDir = mkdtempSync(join(tmpdir(), 'asset-store-lock-'));
process.env.ASSET_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const store = await import('../lib/store.ts');
const { control, db } = await import('./fixtures/store-fakes.ts');
const { LOCK_BUSY, LOCK_LOST } = await import('../lib/sync-lock.ts');

const wallet = (id: string) => '0x' + id;
const input = (id: string, walletAddress = wallet(id)) => ({ id, name: id.toUpperCase(), walletAddress, privateKey: 'k', includeSpot: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await settle();
  assert.ok(condition(), 'fixture did not reach the expected state');
}
function answer(match: (wallet: string) => boolean, total: number | Error) {
  const ready = control.pending.filter(p => match(p.wallet));
  control.pending = control.pending.filter(p => !match(p.wallet));
  for (const p of ready) if (total instanceof Error) p.reject(total); else p.resolve(total);
}
/** Answer outstanding reads in waves (the refresh keeps three in flight) until `task` settles. */
async function drain(task: Promise<unknown>, match: (wallet: string) => boolean, total: number | ((wallet: string) => number | Error)) {
  let done = false;
  task.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 500 && !done; i++) {
    for (const p of control.pending.filter(p => match(p.wallet))) answer(w => w === p.wallet, typeof total === 'function' ? total(p.wallet) : total);
    await settle();
  }
  assert.ok(done, 'task did not settle');
}
async function seedAccounts(owner: string, ids: string[]) {
  for (const id of ids) { control.values.set(wallet(id), 100); await store.connectAsterAccount(owner, input(id), false); }
  for (const id of ids) control.held.add(wallet(id));
}
const lockRow = (owner: string) => db().prepare('SELECT token FROM sync_locks WHERE owner = ?').bind(owner).get<{ token: string }>();

test('a refresh that outlives its lease cannot restore a removed account, overwrite newer credentials or release the newer lock', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-10-30T02:00:00Z') });
  const owner = 'stale-owner', ids = Array.from({ length: 10 }, (_, i) => 'a' + i);
  await seedAccounts(owner, ids);
  const stale = store.refresh(owner);
  stale.catch(() => {});
  await until(() => control.pending.length === 3);
  // The exchange reads outlast the ten-minute hold limit, so the lease lapses despite renewals.
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 30_000) t.mock.timers.tick(30_000);

  await store.deleteAsterAccount(owner, 'a9', 'remove');
  control.values.set(wallet('b0'), 50);
  await store.connectAsterAccount(owner, input('b0'), false);
  control.held.add('0xc1');
  const rekey = store.connectAsterAccount(owner, input('a1', '0xc1'), true);
  await until(() => control.pending.some(p => p.wallet === '0xc1'));
  const newerLock = lockRow(owner);
  assert.ok(newerLock);

  await drain(stale, w => w !== '0xc1', 200);
  await assert.rejects(stale, { message: LOCK_LOST });
  assert.deepEqual(lockRow(owner), newerLock, 'The old refresh must not release the lock held by the credential update');
  await assert.rejects(store.deleteAsterAccount(owner, 'a2', 'remove'), { message: LOCK_BUSY });

  answer(w => w === '0xc1', 300);
  await rekey;
  assert.equal(lockRow(owner), null);
  const ledger = await store.getLedger(owner);
  assert.deepEqual(ledger.asterAccounts.map(a => [a.id, a.walletAddress, a.value]), [
    ['a0', '0xa0', 100], ['a1', '0xc1', 300], ...ids.slice(2, 9).map(id => [id, wallet(id), 100]), ['b0', '0xb0', 50],
  ]);
  assert.equal(ledger.assets.find(a => a.mode === 'aster')!.value, 1150);
  const latest = db().prepare('SELECT data FROM snapshots WHERE owner = ?').bind(owner).rows<{ data: string }>().map(row => JSON.parse(row.data)).at(-1);
  assert.equal(latest.assets.find((a: { mode: string }) => a.mode === 'aster').value, 1150, 'Snapshots keep the newer ledger too');
  // Sources finished while the lease was valid stay saved.
  assert.equal(ledger.fx, 7.25);
  assert.match(ledger.assets.find(a => a.mode === 'market')!.status, /^test · /);
});

test('a live refresh renews its lease past the TTL, keeps edits out and releases only on completion', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse('2026-10-30T03:00:00Z') });
  const owner = 'live-owner', ids = ['d0', 'd1', 'd2', 'd3'];
  await seedAccounts(owner, ids);
  const running = store.refresh(owner);
  running.catch(() => {});
  await until(() => control.pending.length === 3);
  for (let elapsed = 0; elapsed < 132_000; elapsed += 30_000) t.mock.timers.tick(30_000);
  await assert.rejects(store.deleteAsterAccount(owner, 'd3', 'remove'), { message: LOCK_BUSY });

  await drain(running, w => ids.map(wallet).includes(w), w => w === '0xd2' ? new Error('Aster 请求超时') : 200);
  const ledger = await running;
  assert.equal(lockRow(owner), null);
  assert.deepEqual(ledger.asterAccounts.map(a => [a.id, a.value, a.error]), [['d0', 200, null], ['d1', 200, null], ['d2', 100, 'Aster 请求超时'], ['d3', 200, null]]);
  await store.deleteAsterAccount(owner, 'd3', 'remove');
  assert.deepEqual((await store.getLedger(owner)).asterAccounts.map(a => a.id), ['d0', 'd1', 'd2']);
});

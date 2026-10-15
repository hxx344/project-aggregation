import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { feed, book, catalog, epoch } from './fixtures.mjs';

async function accountApp(t, { blockCatalog = false } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let now = epoch, activeReads = 0, maxActiveReads = 0, closed = false, closePromise;
  t.mock.method(performance, 'now', () => now - epoch);
  const starts = [], completions = [], pending = new Set();
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  const remote = { delayMs: 0, fail: false, balance: '1000', positions: [], orders: [] };
  const client = {
    async getAccount() {
      const startedAt = now;
      starts.push(startedAt); activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        if (remote.delayMs) await new Promise(resolve => {
          const read = { due: now + remote.delayMs, resolve() { pending.delete(read); resolve(); } };
          pending.add(read);
        });
        if (remote.fail) throw new Error('simulated account read failure');
        completions.push({ startedAt, completedAt: now });
        return { user_id: '12345', position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE',
          assets: [{ coin: 'USDT', balance: remote.balance }], available_margin: remote.balance };
      } finally { activeReads--; }
    },
    async getPositions() { return structuredClone(remote.positions); },
    async getOpenOrders() { return structuredClone(remote.orders); },
    async getFees() { return []; }, async getTrades() { return []; },
    async getAccountBook() { return []; }, async getAdlRanks() { return []; },
  };
  const directory = mkdtempSync(join(tmpdir(), 'crossex-account-cadence-'));
  const app = createApp({ dataDir: directory, initialPassword: 'account-cadence-test-password', logger() {},
    engineOptions: { clock: () => now, feedReader: async () => feed(now),
      catalogReader: async () => { if (blockCatalog) await catalogGate; return catalog; },
      depthReader: async q => book(q, now),
    }, liveOptions: { clock: () => now, clientFactory: () => client },
  });
  const close = () => closePromise ??= app.close().then(() => { closed = true; });
  t.after(async () => {
    const closing = close();
    releaseCatalog();
    for (const read of pending) read.resolve();
    await closing;
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    assert.ok(child.startsWith('crossex-account-cadence-') && !child.startsWith('..') && !isAbsolute(child));
    rmSync(target, { recursive: true, force: true });
  });
  await turn();
  return { app, remote, starts, completions, close,
    get now() { return now; }, get closed() { return closed; },
    get activeReads() { return activeReads; }, get maxActiveReads() { return maxActiveReads; },
    snapshot: () => app.live.view({ includeOpportunities: false }).live,
    connect: () => app.live.connection({ apiKey: 'cadence-test-key', apiSecret: 'cadence-test-secret' }),
    async advance(ms, sample = () => {}) {
      for (let remaining = ms; remaining > 0;) {
        const step = Math.min(100, remaining); remaining -= step; now += step;
        for (const read of pending) if (read.due <= now) read.resolve();
        t.mock.timers.tick(step); await turn(); sample();
      }
    },
  };
}

test('account polling stays fresh while the catalog is pending for more than fifteen seconds', async t => {
  const f = await accountApp(t, { blockCatalog: true });
  await f.connect();
  for (let elapsed = 5000; elapsed <= 25000; elapsed += 5000) {
    f.remote.balance = String(1000 + elapsed);
    await f.advance(5000);
    const state = f.snapshot();
    assert.equal(state.asOf, epoch + elapsed, 'the account refresh must not wait for the catalog');
    assert.equal(state.balances[0].balance, f.remote.balance);
    assert.equal(state.status, 'live'); assert.equal(state.tradingAllowed, true);
  }
  assert.equal(f.maxActiveReads, 1);
});

test('six-second successful account reads preserve the fifteen-second freshness bound without a backlog', async t => {
  const f = await accountApp(t); await f.connect();
  f.remote.delayMs = 6000;
  await f.advance(40000, () => {
    const state = f.snapshot(), age = f.now - state.asOf;
    assert.ok(age <= 15000, `successful account reads left a ${age} ms old snapshot at ${f.now - epoch} ms`);
    assert.equal(state.status, 'live'); assert.equal(state.tradingAllowed, true);
    assert.equal(f.maxActiveReads, 1, 'only one account read may be in flight');
  });
  assert.ok(f.completions.length >= 6, 'slow reads must continue completing throughout the replay');
  for (let i = 2; i < f.starts.length; i++) {
    assert.ok(f.starts[i] - f.starts[i - 1] <= 6100, 'a slow read must be followed immediately, within one clock step');
  }
  const final = f.completions.at(-1);
  assert.equal(f.snapshot().asOf, final.startedAt, 'freshness must retain the actual read start time');
  assert.notEqual(f.snapshot().asOf, final.completedAt, 'completion time must not extend the snapshot lifetime');
});

test('failed core account reads retain the old values and timestamp, pause trading, and recover automatically', async t => {
  const f = await accountApp(t); await f.connect();
  const original = f.snapshot();
  f.remote.balance = '9000'; f.remote.fail = true;
  await f.advance(5000);
  const failed = f.snapshot();
  assert.equal(failed.asOf, original.asOf);
  assert.deepEqual(failed.balances, original.balances);
  assert.deepEqual(failed.positions, original.positions);
  assert.deepEqual(failed.orders, original.orders);
  assert.equal(failed.status, 'partial'); assert.equal(failed.tradingAllowed, false);
  assert.match(failed.connection.error, /同步未完成.*保留上次结果.*暂停交易/);
  await f.advance(11000);
  assert.equal(f.snapshot().asOf, original.asOf);
  assert.equal(f.snapshot().stale, true); assert.equal(f.snapshot().tradingAllowed, false);
  f.remote.fail = false;
  await f.advance(4000);
  const recovered = f.snapshot();
  assert.equal(recovered.asOf, epoch + 20000);
  assert.equal(recovered.balances[0].balance, '9000');
  assert.equal(recovered.connection.error, null);
  assert.equal(recovered.status, 'live'); assert.equal(recovered.tradingAllowed, true);
});

test('closing the app waits for the active account read and never schedules another one', async t => {
  const f = await accountApp(t); await f.connect();
  f.remote.delayMs = 6000;
  await f.advance(5000); assert.equal(f.activeReads, 1);
  const closing = f.close(); await turn();
  assert.equal(f.closed, false, 'shutdown must wait for the in-flight account read');
  await f.advance(5000);
  assert.equal(f.closed, false); assert.equal(f.starts.length, 2);
  await f.advance(1000); await closing;
  assert.equal(f.closed, true); assert.equal(f.activeReads, 0);
  const readCount = f.starts.length;
  await f.advance(20000);
  assert.equal(f.starts.length, readCount, 'shutdown must clear the pending account refresh');
});

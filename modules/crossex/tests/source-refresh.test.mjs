import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { AppError } from '../server/model.mjs';
import { fixture, feed, book, catalog, epoch } from './fixtures.mjs';
import { STATE_POLL_MS, sourceIsStale } from '../src/freshness.ts';

function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t?.after(() => resolve());
  return { promise, resolve, reject };
}

test('default source cadence keeps discovery quotes fresh across out-of-phase five-second upstream snapshots', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  async function replay(pageIntervalMs, sourceIntervalMs) {
    let now = epoch;
    const directory = mkdtempSync(join(tmpdir(), 'crossex-refresh-test-'));
    const app = createApp({ dataDir: directory, initialPassword: 'cadence-test-password',
      ...(sourceIntervalMs ? { sourceIntervalMs } : {}), logger() {},
      engineOptions: { clock: () => now, catalogReader: async () => catalog,
        feedReader: async () => {
          // Snapshot arrives 100 ms after a five-second poll would have run.
          const at = epoch + Math.floor((now - epoch - 100) / 5000) * 5000 + 100;
          return { ...feed(at), generatedAt: now };
        }, depthReader: async q => book(q, now),
      },
    });
    try {
      await turn();
      let displayed = app.market.view().source, oldSamples = 0;
      for (let elapsed = 100; elapsed <= 30000; elapsed += 100) {
        now = epoch + elapsed; t.mock.timers.tick(100); await turn();
        // The browser reads just before the next backend poll; include 200 ms
        // of transit time in the display's conservative age calculation.
        if (elapsed % pageIntervalMs === pageIntervalMs - 100) displayed = app.market.view().source;
        if (elapsed >= 5000 && sourceIsStale(displayed, now + 200, true)) oldSamples++;
      }
      return oldSamples;
    } finally {
      await app.close();
      if (!directory.startsWith(tmpdir()) || !directory.includes('crossex-refresh-test-')) throw new Error('unsafe path');
      rmSync(directory, { recursive: true, force: true });
    }
  }
  assert.ok(await replay(5000, 5000) > 0, 'old cadence reproduces recurring stale valuations');
  assert.equal(await replay(STATE_POLL_MS), 0, 'new defaults remain fresh for six upstream cycles');
});

test('overlapping source refreshes share one read and preserve actual quote timestamps', async t => {
  const gate = deferred(t); let reads = 0;
  const f = fixture(t, { feedReader: async () => { reads++; return gate.promise; } });
  const first = f.engine.refreshSource(), second = f.engine.refreshSource();
  assert.equal(reads, 1); assert.equal(first, second);
  f.advance(20000); gate.resolve({ ...feed(epoch), generatedAt: f.now() });
  await Promise.all([first, second]);
  assert.equal(f.engine.summary().health.state, 'stale');
  assert.equal(f.engine.view().source.updatedAt, epoch);
  assert.equal(f.engine.view().source.checkedAt, epoch);
});

for (const failure of [false, true]) {
  for (const change of [
    { config: { monitorUrl: 'http://127.0.0.1:3101' } },
    { config: { monitorUsername: 'replacement' } },
    { config: {}, monitorPassword: 'replacement-test-password' },
    { config: {}, clearMonitorPassword: true },
  ]) {
    const kind = Object.keys(change.config)[0] || Object.keys(change)[1];
    test(`connection ${kind} discards obsolete ${failure ? 'failure' : 'success'} and uses new settings`, async t => {
      const gate = deferred(t), calls = [];
      const f = fixture(t, { feedReader: async (config, password) => {
        calls.push({ config, password }); return calls.length === 1 ? gate.promise : feed(f.now());
      } });
      await f.engine.settings({ config: {}, monitorPassword: 'original-test-password' });
      const first = f.engine.refreshSource();
      await f.engine.settings(change);
      assert.equal(f.engine.refreshSource(), first, 'settings changes do not overlap requests');
      if (failure) gate.reject(new AppError('obsolete source failure')); else gate.resolve(feed());
      await first;
      assert.equal(f.engine.view().source.quoteCount, 0);
      assert.equal(f.engine.view().source.checkedAt, null);
      assert.match(f.engine.view().source.error, /连接设置已更改/);
      f.advance(5000); await f.engine.refreshSource();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].password, 'original-test-password');
      assert.equal(calls[1].config.monitorUrl, f.store.config().monitorUrl);
      assert.equal(calls[1].config.monitorUsername, f.store.config().monitorUsername);
      assert.equal(calls[1].password, change.monitorPassword || '');
      assert.equal(f.engine.view().source.state, 'live');
      assert.equal(f.engine.view().source.checkedAt, f.now());
    });
  }
}

for (const failure of [false, true]) test(`stop waits for an active source ${failure ? 'failure' : 'success'} without publishing it`, async t => {
  const gate = deferred(t); let reads = 0;
  const f = fixture(t, { feedReader: async () => { reads++; return gate.promise; } });
  const refresh = f.engine.refreshSource(); let stopped = false;
  const stop = f.engine.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false);
  await f.engine.refreshSource(); assert.equal(reads, 1);
  if (failure) gate.reject(new AppError('closing failure')); else gate.resolve(feed());
  await Promise.all([refresh, stop]);
  assert.equal(stopped, true); assert.equal(f.engine.view().source.quoteCount, 0);
  assert.equal(f.engine.view().source.error, '等待首次读取价差服务');
});

for (const update of ['identity', 'delisting', 'stale', 'failure', 'normal']) test(`open rechecks ${update} source update while reading depth`, async t => {
  const gate = deferred(t), entered = deferred(); const f = fixture(t);
  await f.engine.tick();
  f.setDepth(async q => { entered.resolve(); await gate.promise; return book(q, f.now()); });
  const opening = f.engine.open(`signal-${epoch}`, `source-${update}-open`);
  await entered.promise; f.advance(1000);
  const next = feed(f.now());
  if (update === 'identity') next.quotes[0].settlementCurrency = 'USD';
  if (update === 'delisting') next.quotes[0].delisting = true;
  if (update === 'stale') next.quotes[0].bidAskAt = f.now() - 10001;
  if (update === 'failure') f.offline(true);
  f.setFeed(next); await f.engine.refreshSource();
  gate.resolve();
  if (update === 'normal') assert.equal((await opening).status, 'open');
  else { await assert.rejects(opening, /过期/); assert.equal(f.store.positions().length, 0); }
});

for (const update of ['identity', 'normal', 'offline']) test(`close rechecks identity after ${update} source update without requiring the signal source`, async t => {
  const gate = deferred(t), entered = deferred(); const f = fixture(t);
  await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, `before-${update}-close`);
  f.setDepth(async q => { entered.resolve(); await gate.promise; return book(q, f.now()); });
  const closing = f.engine.closePosition(p.id, `source-${update}-close`);
  await entered.promise; f.advance(1000);
  const next = feed(f.now());
  if (update === 'identity') next.quotes[0].settlementCurrency = 'USD';
  if (update === 'offline') f.offline(true);
  f.setFeed(next); await f.engine.refreshSource(); gate.resolve();
  if (update === 'identity') { await assert.rejects(closing, /身份/); assert.equal(f.store.positions('open').length, 1); }
  else assert.equal((await closing).status, 'closed');
});

for (const blocked of ['catalog', 'account read']) test(`app keeps refreshing every interval while ${blocked} is blocked`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(t), entered = deferred(); let now = epoch, reads = 0, closed = false;
  const directory = mkdtempSync(join(tmpdir(), 'crossex-refresh-test-'));
  const app = createApp({ dataDir: directory, initialPassword: 'source-refresh-test-password', intervalMs: 5000,
    engineOptions: {
      clock: () => now,
      feedReader: async () => { reads++; return feed(now); },
      catalogReader: async () => { if (blocked === 'catalog') { entered.resolve(); await gate.promise; } return catalog; },
      depthReader: async q => book(q, now),
    }, liveOptions: { clock: () => now, clientFactory: () => ({
      async getAccount() { if (blocked === 'account read') { entered.resolve(); await gate.promise; } return { user_id: '12345', position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE', assets: [] }; },
      async getPositions() { return []; }, async getOpenOrders() { return []; },
    }) }, logger() {},
  });
  t.after(async () => {
    if (!closed) await app.close();
    if (!directory.startsWith(tmpdir()) || !directory.includes('crossex-refresh-test-')) throw new Error('unsafe path');
    rmSync(directory, { recursive: true, force: true });
  });
  await turn();
  const connecting = blocked === 'account read' ? app.live.connection({ apiKey: 'isolated-key', apiSecret: 'isolated-secret' }) : Promise.resolve();
  await entered.promise;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const bootstrap = await fetch(`http://127.0.0.1:${app.server.address().port}/api/bootstrap`, {
    headers: { Authorization: `Basic ${Buffer.from('admin:source-refresh-test-password').toString('base64')}` }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(bootstrap.status, 200, 'connection controls must load while an external source is pending');
  const initial = await bootstrap.json();
  assert.ok(initial.csrfToken); assert.equal(initial.connection.configured, false);
  const initialReads = reads;
  for (let i = 1; i <= 3; i++) {
    now += 5000; t.mock.timers.tick(5000); await turn();
    assert.equal(reads, initialReads + i);
    assert.equal(app.market.view().source.checkedAt, now);
    assert.equal(app.market.view().source.updatedAt, now);
    assert.equal(app.market.view().source.state, 'live');
  }
  gate.resolve(); await connecting; await turn();
  const beforeClose = reads; await app.close(); closed = true;
  t.mock.timers.tick(5000); await turn();
  assert.equal(reads, beforeClose, 'shutdown clears the refresh timer');
});

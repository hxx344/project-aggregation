import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { standardSummary } from '../server/adapters.mjs';
import { ageSnapshot } from '../src/hub-state.ts';

test('CrossEx partial availability survives the full summary path without extending source or valuation time', async t => {
  const sourceAt = Date.now(); let now = sourceAt;
  t.mock.method(Date, 'now', () => now);
  let raw = { schemaVersion: 2, data: {
    updatedAt: new Date(sourceAt).toISOString(),
    health: { state: 'partial', message: '1 条盘口过期；其余行情有效', staleAfterSeconds: 10 },
    metrics: [{ key: 'unrealized', label: '模拟浮动盈亏', value: null, unit: 'USDT' }],
  } };
  const dataDir = await mkdtemp(join(tmpdir(), 'hub-crossex-summary-'));
  const app = await createApp({ dataDir, initialPassword: 'fixture-password-only', refreshInterval: 0,
    assetSyncIntervalMs: 0, summaryReader: async () => standardSummary(raw), logger() {} });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const snapshot = await app.check('crossex');
  assert.equal(snapshot.state, 'partial'); assert.match(snapshot.message, /1 条盘口过期/);
  assert.equal(snapshot.metrics[0].value, null); assert.equal(snapshot.staleAfterSeconds, 10);
  assert.equal(ageSnapshot(snapshot, sourceAt + 5000).state, 'partial');
  assert.equal(ageSnapshot(snapshot, sourceAt + 10001).state, 'stale');
  now += 11000;
  const unchanged = await app.check('crossex');
  assert.equal(unchanged.state, 'stale'); assert.equal(unchanged.updatedAt, snapshot.updatedAt);

  // Fresh unrelated quotes cannot make the finite held-position PnL newer.
  raw.data.updatedAt = new Date(now - 9000).toISOString();
  raw.data.metrics[0].value = 3;
  const held = await app.check('crossex');
  assert.equal(held.state, 'partial'); assert.equal(held.metrics[0].value, 3);
  assert.equal(ageSnapshot(held, now + 1001).state, 'stale');

  raw.data.health.state = 'offline'; raw.data.health.message = '价差来源读取失败';
  const offline = await app.check('crossex');
  assert.equal(offline.state, 'offline'); assert.equal(ageSnapshot(offline, now + 60000).state, 'offline');
});

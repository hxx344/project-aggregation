import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openMarketStore } from '../server/market-store.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';

test('market failures and counts reuse SQL while retaining per-dataset state and connection isolation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'market-statements-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'market-statements-'));
    await rm(directory, { recursive: true, force: true });
  });
  const original = DatabaseSync.prototype.prepare;
  let preparations = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) { preparations++; return original.call(this, sql); });
  let now = 1000;
  const store = await openMarketStore(join(directory, 'one.sqlite'), { clock: () => now }); stores.push(store);
  const isolated = await openMarketStore(join(directory, 'two.sqlite')); stores.push(isolated);
  const prepared = preparations;
  for (let index = 0; index < 3; index++) {
    now++;
    store.fail('hynix', 'quote', `failure ${index}`);
    store.fail('oil', 'quote', 'oil failure');
    assert.equal(store.count('hynix', 'quote'), 0);
    assert.equal(store.count('oil', 'quote'), 0);
    const rows = store.status();
    assert.equal(rows.find(row => row.key === 'hynix/quote').error, `failure ${index}`);
    assert.equal(rows.find(row => row.key === 'hynix/quote').attempt_ms, now);
    assert.equal(rows.find(row => row.key === 'oil/quote').error, 'oil failure');
    assert.equal(isolated.status().find(row => row.key === 'hynix/quote').error, null);
  }
  assert.equal(preparations, prepared);
});

test('quote reads and catalog pruning reuse SQL without stale results or crossing exchange boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quote-statements-'));
  const store = await openPerpetualStore(join(directory, 'quotes.sqlite'));
  t.after(async () => {
    store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'quote-statements-'));
    await rm(directory, { recursive: true, force: true });
  });
  const original = DatabaseSync.prototype.prepare;
  let preparations = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) { preparations++; return original.call(this, sql); });
  const kept = { exchange: 'binance', symbol: 'BTCUSDT', sourceTime: 1000 };
  const other = { exchange: 'bybit', symbol: 'BTCUSDT', sourceTime: 1000 };
  for (let index = 0; index < 3; index++) {
    store.save([{ ...kept, sourceTime: 1000 + index }, { exchange: 'binance', symbol: 'ETHUSDT' }, other]);
    assert.equal(store.load().length, 3);
    store.prune('binance', new Set(['BTCUSDT']));
    assert.deepEqual(store.load(), [{ ...kept, sourceTime: 1000 + index }, other]);
  }
  assert.equal(preparations, 0);
});

test('quality history generators keep independent cursors when reads are interleaved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-statements-'));
  const store = await openPerpetualStore(join(directory, 'quotes.sqlite'));
  t.after(async () => {
    store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'quality-statements-'));
    await rm(directory, { recursive: true, force: true });
  });
  for (const bucket of [60_000, 120_000, 180_000]) store.saveQualitySample(bucket, [{ bucket }]);
  const first = store.loadQualitySamples(180_000), second = store.loadQualitySamples(120_000);
  try {
    assert.equal(first.next().value.bucket, 60_000);
    assert.equal(second.next().value.bucket, 60_000);
    assert.equal(first.next().value.bucket, 120_000);
    assert.deepEqual([...second].map(row => row.bucket), [120_000]);
    assert.deepEqual([...first].map(row => row.bucket), [180_000]);
  } finally { first.return(); second.return(); }
});

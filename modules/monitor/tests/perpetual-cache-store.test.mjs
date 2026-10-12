import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openPerpetualStore } from '../server/perpetual-store.mjs';

test('history and metric caches persist independently, tolerate corrupt rows and preserve old schema/quotes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-cache-')), filename = join(directory, 'market.sqlite');
  let store, inspection;
  try {
    store = await openPerpetualStore(filename);
    const quote = { exchange: 'binance', symbol: 'BTCUSDT', sourceTime: 123 };
    store.save([quote]);
    const funding = { key: 'binance:BTCUSDT', lastAccessAt: 1000, value: { coverage: { from: 1, to: 2 }, records: [{ time: 2, rate: 0 }] } };
    const metric = { key: 'binance:BTCUSDT', lastAccessAt: 2000, value: { volume24h: { value: 0, currency: 'USDT' } }, readerState: { candles: [[1, 10]] } };
    store.saveFundingHistory(funding); store.saveContractMetrics(metric);
    store.close(); store = await openPerpetualStore(filename);
    assert.deepEqual(store.load(), [quote]);
    assert.deepEqual(store.loadFundingHistory('binance:BTCUSDT'), [funding]);
    assert.deepEqual(store.loadContractMetrics('binance:BTCUSDT'), [metric]);
    assert.deepEqual(store.loadFundingHistory('missing'), []);
    inspection = new DatabaseSync(filename);
    assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 1);
    inspection.prepare('UPDATE funding_history_cache SET payload=?').run(Buffer.from('corrupt'));
    assert.deepEqual(store.loadFundingHistory(), []);
    assert.deepEqual(store.loadContractMetrics(), [metric]);
    store.saveFundingHistory(funding);
    assert.deepEqual(store.loadFundingHistory(), [funding]);
    assert.throws(() => store.saveFundingHistory({ ...funding, lastAccessAt: NaN }), /Invalid/);
    assert.throws(() => store.saveContractMetrics({ ...metric, payload: 'x'.repeat(1_000_001) }), /size limit/);
  } finally {
    inspection?.close(); store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-cache-'));
    await rm(directory, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getQuoteStaleAfterMs } from '../lib/market-freshness.ts';
import { validateGoldOilQuote } from '../lib/gold-oil.ts';

test('quote freshness accepts bounded server budgets and falls back for absent or malformed metadata', () => {
  for (const maxAgeMs of [35_000, 75_000, 7_215_000]) assert.equal(getQuoteStaleAfterMs({ collection: { maxAgeMs } }, 1000), maxAgeMs);
  for (const quote of [null, undefined, {}, { collection: null }, { collection: {} }, ...[0, -1, NaN, Infinity, '75000', 7_215_001].map(maxAgeMs => ({ collection: { maxAgeMs } }))]) {
    assert.equal(getQuoteStaleAfterMs(quote, 35_000), 35_000);
  }
});

test('gold/oil validation explicitly preserves only valid freshness metadata and keeps the source time and snapshot status', () => {
  const fetchedAt = '2026-09-11T07:00:00.000Z';
  const input = { source: 'Binance', currency: 'USDT', priceBasis: 'mark', fetchedAt, status: 'snapshot', oil: { symbol: 'CLUSDT', price: 80, updatedAt: fetchedAt }, xau: { symbol: 'XAUUSDT', price: 4000, updatedAt: fetchedAt }, funding: null };
  const validated = validateGoldOilQuote({ ...input, collection: { maxAgeMs: 75_000, lastSuccessAt: '2026-09-11T07:00:49.000Z', unknown: 'discard' }, unknown: 'discard' });
  assert.deepEqual(validated.collection, { maxAgeMs: 75_000 });
  assert.equal(validated.unknown, undefined);
  assert.equal(validated.fetchedAt, fetchedAt);
  assert.equal(validated.status, 'snapshot');
  for (const maxAgeMs of [undefined, 0, -1, NaN, Infinity, '75000', 7_215_001]) {
    const quote = validateGoldOilQuote({ ...input, collection: { maxAgeMs } });
    assert.equal(quote.collection, undefined);
    assert.equal(getQuoteStaleAfterMs(quote, 75_000), 75_000);
  }
});

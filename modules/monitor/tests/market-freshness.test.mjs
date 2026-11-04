import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getQuoteStaleAfterMs } from '../lib/market-freshness.ts';

test('quote freshness accepts bounded server budgets and falls back for absent or malformed metadata', () => {
  for (const maxAgeMs of [35_000, 75_000, 7_215_000]) assert.equal(getQuoteStaleAfterMs({ collection: { maxAgeMs } }, 1000), maxAgeMs);
  for (const quote of [null, undefined, {}, { collection: null }, { collection: {} }, ...[0, -1, NaN, Infinity, '75000', 7_215_001].map(maxAgeMs => ({ collection: { maxAgeMs } }))]) {
    assert.equal(getQuoteStaleAfterMs(quote, 35_000), 35_000);
  }
});

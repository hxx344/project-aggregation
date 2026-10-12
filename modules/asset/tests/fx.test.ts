import test from 'node:test';
import assert from 'node:assert/strict';
import { yuanQuote } from '../lib/fx.ts';

const now = Date.parse('2026-09-19T12:00:00Z');
const mock = (handler: (url: URL, init: RequestInit) => unknown) => (async (input: RequestInfo | URL, init: RequestInit = {}) => Response.json(handler(new URL(String(input)), init))) as typeof fetch;
const reference = { base: 'USD', quote: 'CNY', date: '2026-09-18', rate: 6.7 };

test('USD/CNY uses units of yuan per dollar without inversion and labels fetch time', async () => {
  const quote = await yuanQuote(mock((url, init) => {
    assert.equal(url.hostname, 'api.coinbase.com');
    assert.equal(url.searchParams.get('currency'), 'USD');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'manual');
    return { data: { currency: 'USD', rates: { CNY: '7.1234' } } };
  }), now);
  assert.equal(quote.rate, 7.1234);
  assert.deepEqual(quote.status, { source: 'Coinbase', fetchedAt: new Date(now).toISOString(), rateDate: null, error: null });
});

test('FX falls back to a dated ECB reference instead of claiming an intraday quote', async () => {
  const quote = await yuanQuote(mock(url => {
    if (url.hostname === 'api.coinbase.com') throw new Error('offline');
    assert.equal(url.hostname, 'api.frankfurter.dev');
    assert.equal(url.pathname, '/v2/rate/USD/CNY');
    assert.equal(url.searchParams.get('providers'), 'ecb');
    return reference;
  }), now);
  assert.equal(quote.rate, 6.7);
  assert.equal(quote.status.source, 'Frankfurter');
  assert.equal(quote.status.rateDate, '2026-09-18');
});

test('invalid base, missing, non-finite and non-positive rates cannot replace the saved rate', async () => {
  for (const data of [{}, { data: { currency: 'CNY', rates: { CNY: '7' } } }, ...[null, '', false, 0, -1, 'Infinity', 1001].map(CNY => ({ data: { currency: 'USD', rates: { CNY } } }))]) {
    await assert.rejects(yuanQuote(mock(url => url.hostname === 'api.coinbase.com' ? data : {}), now), /保留上次汇率/);
  }
});

test('reference rates reject stale/future/invalid dates and wrong currency pairs', async () => {
  for (const changes of [{ date: '2026-09-01' }, { date: '2026-09-20' }, { date: '2026-02-30' }, { base: 'CNY' }, { quote: 'CNH' }, { rate: 0 }, { rate: null }]) {
    await assert.rejects(yuanQuote(mock(url => url.hostname === 'api.coinbase.com' ? {} : { ...reference, ...changes }), now), /保留上次汇率/);
  }
});

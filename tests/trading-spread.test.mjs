import test from 'node:test';
import assert from 'node:assert/strict';
import { crossEdge, crossSpread, formatPercent, formatSigned, readBook, venueSpread } from '../src/trading-spread.ts';

const AT = '2026-11-05T08:00:00.000Z';
const quotes = (books, generatedAt = AT) => ({ generatedAt, maxAgeMs: 10_000, books });
const row = (exchange, symbol, bid, ask, at = AT) => ({ exchange, symbol, bid, ask, at });

test('oil spread is BZ minus CL on mid price, percent of CL', () => {
  const q = quotes([row('binance', 'CLUSDT', '60.00', '60.02'), row('binance', 'BZUSDT', '64.20', '64.22')]);
  const cl = readBook(q, 'binance', 'CLUSDT').book, bz = readBook(q, 'binance', 'BZUSDT').book;
  const spread = venueSpread('oil', cl, bz);
  assert.equal(formatSigned(spread.value, spread.digits), '+4.200');
  assert.equal(formatPercent(spread.percent), '+6.999%');
  assert.equal(spread.stale, false);
});

test('hynix premium compares the ADR with one tenth of the ordinary share', () => {
  const q = quotes([row('okx', 'SKHYNIXUSDT', '399.9', '400.1'), row('okx', 'SKHYUSDT', '41.99', '42.01')]);
  const spread = venueSpread('hynix', readBook(q, 'okx', 'SKHYNIXUSDT').book, readBook(q, 'okx', 'SKHYUSDT').book);
  assert.equal(formatSigned(spread.value, spread.digits), '+2.000');
  assert.equal(formatPercent(spread.percent), '+5.000%');
});

test('cross-venue spread uses mid prices and the executable edge picks the better direction', () => {
  const q = quotes([row('binance', 'CLUSDT', '60.00', '60.02'), row('okx', 'CLUSDT', '60.05', '60.07')]);
  const a = readBook(q, 'binance', 'CLUSDT').book, b = readBook(q, 'okx', 'CLUSDT').book;
  const spread = crossSpread(a, b);
  assert.equal(formatSigned(spread.value, spread.digits), '-0.050');
  const edge = crossEdge(['binance', 'okx'], a, b);
  assert.deepEqual([edge.sell, edge.buy, formatSigned(edge.value, edge.digits)], ['okx', 'binance', '+0.03']);
  assert.equal(formatPercent(edge.percent), '+0.050%');
  const none = crossEdge(['binance', 'okx'], a, a);
  assert.ok(none.value < 0, 'a locked market has no immediate edge');
});

test('failed, incomplete, crossed and old legs are not shown as fresh numbers', () => {
  const q = quotes([
    { exchange: 'okx', symbol: 'SKHYUSDT', error: '合约当前不支持所需的限价交易' },
    row('binance', 'CLUSDT', '60.02', '60.00'),
    row('binance', 'BZUSDT', '64.20', ''),
    row('okx', 'CLUSDT', '60.00', '60.02', '2026-11-05T07:59:49.000Z'),
  ]);
  assert.deepEqual(readBook(q, 'okx', 'SKHYUSDT'), { book: null, error: '合约当前不支持所需的限价交易' });
  assert.equal(readBook(q, 'binance', 'CLUSDT').book, null);
  assert.equal(readBook(q, 'binance', 'BZUSDT').book, null);
  assert.equal(readBook(q, 'bybit', 'CLUSDT').error, '未取得盘口');
  assert.equal(readBook(q, 'okx', 'CLUSDT').book.stale, true);
  assert.equal(venueSpread('oil', readBook(q, 'okx', 'CLUSDT').book, null), null);
  assert.equal(formatSigned(-0.0001, 3), '0.000');
});

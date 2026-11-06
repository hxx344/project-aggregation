import test from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_CONTRACTS, DEFAULT_SHARES, bestPairs, findContract, shareBooks as convert, sharesPerUnit, sharesProblem } from '../src/trading-anthropic.ts';
import { readBook } from '../src/trading-spread.ts';

const AT = '2026-11-07T08:00:00.000Z';
const shareBooks = (quotes, shares) => convert(contract => readBook(quotes, contract.exchange, contract.symbol), shares);
const close = (actual, expected, digits = 6) => assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} ≈ ${expected}`);
// Per-share books chosen by hand: io 8.9 / 9, Binance 10 / 10.1, OKX 10.2 / 10.3, xyz 9.5 / 9.6,
// quoted in each venue's unit at 12.7B outstanding and 16.7B fully diluted shares.
const quotes = { generatedAt: AT, maxAgeMs: 10_000, books: [
  { exchange: 'hyperliquid', symbol: 'io:ANTH', bid: '148.63', ask: '150.3', at: AT },
  { exchange: 'binance', symbol: 'ANTHROPICUSDT', bid: '127', ask: '128.27', at: AT },
  { exchange: 'okx', symbol: 'ANTHROPICUSDT', bid: '12.954', ask: '13.081', at: AT },
  { exchange: 'hyperliquid', symbol: 'xyz:ANT', bid: '9.5', ask: '9.6', at: AT },
] };

test('each contract unit stands for the shares its venue quotes', () => {
  const units = Object.fromEntries(ANTHROPIC_CONTRACTS.map(contract => [`${contract.exchange}:${contract.symbol}`, sharesPerUnit(contract, DEFAULT_SHARES)]));
  assert.deepEqual(units, { 'hyperliquid:io:ANTH': 16.7, 'hyperliquid:xyz:ANT': 1, 'binance:ANTHROPICUSDT': 12.7, 'okx:ANTHROPICUSDT': 1.27 });
  assert.equal(sharesPerUnit(findContract('hyperliquid:io:ANTH'), { outstanding: '12.7', diluted: '20' }), 20);
  assert.equal(findContract('bybit:ANTHROPICUSDT'), null);
});

test('share assumptions follow the server bounds', () => {
  assert.equal(sharesProblem(DEFAULT_SHARES), null);
  assert.equal(sharesProblem({ outstanding: ' 12.7 ', diluted: '12.7' }), null);
  for (const shares of [{ outstanding: '17', diluted: '16.7' }, { outstanding: '0.5', diluted: '16.7' }, { outstanding: '12.7', diluted: '101' }, { outstanding: '1e1', diluted: '16.7' }, { outstanding: '', diluted: '16.7' }]) {
    assert.ok(sharesProblem(shares), JSON.stringify(shares));
    assert.equal(sharesPerUnit(ANTHROPIC_CONTRACTS[0], shares), null);
  }
});

test('books convert to per-share prices and pairs rank by the executable gap', () => {
  const books = shareBooks(quotes, DEFAULT_SHARES);
  const io = books.find(book => book.contract.symbol === 'io:ANTH'), okx = books.find(book => book.contract.exchange === 'okx');
  close(io.bid, 8.9); close(io.ask, 9); close(okx.bid, 10.2); close(okx.ask, 10.3);
  const pairs = bestPairs(books);
  assert.equal(pairs.length, 6, 'each of the four contracts pairs once with every other');
  const [best] = pairs;
  assert.deepEqual([best.long.contract.symbol, best.short.contract.exchange], ['io:ANTH', 'okx']);
  close(best.gap, 1.2 / 9 * 100);
  close(best.ratio, 16.7 / 1.27);
  const binance = pairs.find(pair => pair.long.contract.symbol === 'io:ANTH' && pair.short.contract.exchange === 'binance');
  close(binance.gap, 1 / 9 * 100); close(binance.ratio, 16.7 / 12.7);
  for (let index = 1; index < pairs.length; index += 1) assert.ok(pairs[index - 1].gap >= pairs[index].gap);
  // Each pair keeps its better direction: buying Binance and selling io loses on both books.
  assert.equal(pairs.some(pair => pair.long.contract.exchange === 'binance' && pair.short.contract.symbol === 'io:ANTH'), false);
});

test('a missing or failed book leaves its pairs out instead of showing a number', () => {
  const partial = { ...quotes, books: [quotes.books[0], { exchange: 'binance', symbol: 'ANTHROPICUSDT', error: '暂不可用' }] };
  const books = shareBooks(partial, DEFAULT_SHARES);
  assert.equal(books.find(book => book.contract.exchange === 'binance').bid, null);
  assert.deepEqual(bestPairs(books), []);
  const stale = shareBooks({ ...quotes, generatedAt: '2026-11-07T08:00:30.000Z' }, DEFAULT_SHARES);
  assert.ok(bestPairs(stale).every(pair => pair.stale));
});

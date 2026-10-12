import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualPriceReader, normalizePerpetualPriceCandles } from '../server/perpetual-price-reader.mjs';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 11, 12), RANGE = { from: NOW - 720 * HOUR, to: NOW };
const market = (exchange, extra = {}) => ({ exchange, symbol: exchange === 'gate' ? 'BTC_USDT' : exchange === 'okx' ? 'BTC-USDT-SWAP' : exchange === 'hyperliquid' ? 'BTC' : exchange === 'entropy' ? 'io:BTC' : 'BTCUSDT', base: 'BTC', quoteCurrency: ['hyperliquid', 'entropy'].includes(exchange) ? 'USDC' : 'USDT', multiplier: 1, ...extra });
const arrayRow = (open, close = '123') => [open, '123', '124', '122', close, '10', open + HOUR - 1, '1230', '1'];
function fixture(exchange) {
  const contract = market(exchange), urls = [], body = [];
  const read = createPerpetualPriceReader({ clock: () => NOW + HOUR / 2, requestSpacingMs: 0, fetchImpl: async (input, init) => {
    const url = new URL(input); urls.push(url); if (init.body) body.push(JSON.parse(init.body));
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    let from = Number(url.searchParams.get('startTime') ?? url.searchParams.get('start')), end = Number(url.searchParams.get('endTime') ?? url.searchParams.get('end'));
    if (exchange === 'gate') { from = Number(url.searchParams.get('from')) * 1000; end = Number(url.searchParams.get('to')) * 1000; assert.equal(url.searchParams.has('limit'), false); }
    if (exchange === 'okx') { from = Number(url.searchParams.get('before')) + 1; end = Number(url.searchParams.get('after')) - 1; }
    if (exchange === 'bitget') { from += HOUR; end -= 1; assert.equal(url.searchParams.get('productType'), 'USDT-FUTURES'); assert.equal(end + 1 - from <= 168 * HOUR, true); }
    if (['hyperliquid', 'entropy'].includes(exchange)) { from = body.at(-1).req.startTime; end = body.at(-1).req.endTime; assert.equal(body.at(-1).type, 'candleSnapshot'); }
    const rows = [];
    for (let open = from; open <= end; open += HOUR) {
      if (exchange === 'gate') rows.push({ t: open / 1000, c: '123' });
      else if (['hyperliquid', 'entropy'].includes(exchange)) rows.push({ t: open, T: open + HOUR - 1, c: '123', i: '1h', s: contract.symbol });
      else rows.push(arrayRow(open));
    }
    if (exchange === 'bybit' || exchange === 'okx') rows.reverse();
    const result = exchange === 'bybit' ? { retCode: 0, result: { category: 'linear', symbol: contract.symbol, list: rows } } : ['okx', 'bitget'].includes(exchange) ? { code: exchange === 'okx' ? '0' : '00000', data: rows } : rows;
    return { ok: true, json: async () => result };
  } });
  return { read, contract, urls };
}
for (const exchange of ['binance', 'aster', 'bybit', 'gate', 'okx', 'bitget', 'hyperliquid', 'entropy']) {
  test(`${exchange}: 30d closes paginate without boundary loss or market/mark mixing`, async () => {
    const f = fixture(exchange), points = await f.read(f.contract, RANGE);
    assert.equal(points.length, 720); assert.equal(points[0].time, RANGE.from + HOUR); assert.equal(points.at(-1).time, NOW);
    assert.ok(points.every((point, i) => point.close === 123 && (!i || point.time - points[i - 1].time === HOUR)));
    assert.equal(f.urls.length, 5); assert.ok(f.urls.every(url => !/mark[-P]|index[-P]/i.test(url.pathname)));
  });
}
test('closed candles only, multiplier normalized once, missing hours stay missing', () => {
  const rows = [arrayRow(NOW - 3 * HOUR, '2000'), arrayRow(NOW - HOUR, '1000'), arrayRow(NOW, '9999')];
  const result = normalizePerpetualPriceCandles('binance', rows, market('binance', { multiplier: 1000 }), { from: NOW - 3 * HOUR, to: NOW }, NOW + HOUR / 2);
  assert.deepEqual(result, [{ time: NOW - 2 * HOUR, close: 2 }, { time: NOW, close: 1 }]);
  assert.deepEqual(normalizePerpetualPriceCandles('okx', [[NOW - HOUR, 1, 1, 1, 1, 1, 1, 1, '0']], market('okx'), RANGE, NOW), []);
});
test('malformed timestamps, prices, periods and conflicting duplicates fail closed', () => {
  for (const rows of [[arrayRow(NOW - HOUR, null)], [arrayRow(NOW - HOUR, '0')], [arrayRow(NOW - HOUR + 1)], [arrayRow(NOW + HOUR)], [arrayRow(NOW - HOUR, '1'), arrayRow(NOW - HOUR, '2')], [[NOW - HOUR, 1, 1, 1, 1, 1, NOW]]]) {
    assert.throws(() => normalizePerpetualPriceCandles('binance', rows, market('binance'), RANGE, NOW));
  }
  assert.throws(() => normalizePerpetualPriceCandles('hyperliquid', [{ t: NOW - HOUR, T: NOW - 1, c: 1, i: '1h', s: 'ETH' }], market('hyperliquid'), RANGE, NOW));
});
test('same closed timestamp conflict across time pages is rejected', async () => {
  let calls = 0;
  const read = createPerpetualPriceReader({ clock: () => NOW, requestSpacingMs: 0, fetchImpl: async () => ({ ok: true, json: async () => [arrayRow(NOW - HOUR, String(++calls))] }) });
  await assert.rejects(read(market('binance'), RANGE), /冲突/);
});
test('unsupported venues, invalid metadata and aborted requests never fetch arbitrary URLs', async () => {
  let count = 0;
  const read = createPerpetualPriceReader({ clock: () => NOW, fetchImpl: () => { count++; throw Error('must not fetch'); } });
  await assert.rejects(read(market('kraken'), RANGE), { code: 'UNSUPPORTED' });
  await assert.rejects(read(market('binance', { symbol: 'https://evil.example/x' }), RANGE));
  await assert.rejects(read(market('bybit', { quoteCurrency: 'USD1' }), RANGE), { code: 'UNSUPPORTED' });
  await assert.rejects(read(market('binance'), RANGE, { signal: AbortSignal.abort() }));
  assert.equal(count, 0);
});

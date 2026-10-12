import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualFundingReader } from '../server/perpetual-funding-reader.mjs';
import { createCexFundingHistoryReader, parseCexFundingHistory } from '../lib/exchange-funding-cex.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 6, 10), FROM = NOW - 4 * 24 * HOUR;
const RANGE = { from: FROM, to: NOW };
const cexIds = ['binance', 'bybit', 'okx', 'bitget', 'aster'];
const pageSizes = { binance: 1000, bybit: 200, okx: 400, bitget: 100, aster: 1000 };
const cexHosts = { binance: 'fapi.binance.com', bybit: 'api.bybit.com', okx: 'www.okx.com', bitget: 'api.bitget.com', aster: 'fapi.asterdex.com' };
const market = (exchange, overrides = {}) => ({ exchange, symbol: exchange === 'okx' ? 'BTC-USDT-SWAP' : exchange === 'gate' ? 'BTC_USDT' : exchange === 'entropy' ? 'io:SNDK' : ['lighter', 'rh-lighter', 'hyperliquid'].includes(exchange) ? 'BTC' : 'BTCUSDT', quoteCurrency: exchange === 'rh-lighter' ? 'USDG' : exchange === 'entropy' ? 'USDC' : 'USDT', marketId: exchange === 'rh-lighter' ? 101 : 1, ...overrides });
const response = data => ({ ok: true, status: 200, json: async () => data });
function cexRow(exchange, time, rate = '-0.000125', symbol = market(exchange).symbol) {
  if (exchange === 'bybit') return { symbol, fundingRateTimestamp: String(time), fundingRate: rate };
  if (exchange === 'okx') return { instId: symbol, instType: 'SWAP', fundingTime: String(time), fundingRate: '0.99', realizedRate: rate };
  return { symbol, fundingTime: time, fundingRate: rate };
}
function cexEnvelope(exchange, rows) {
  if (exchange === 'binance' || exchange === 'aster') return rows;
  if (exchange === 'bybit') return { retCode: 0, result: { category: 'linear', list: rows } };
  return { code: exchange === 'okx' ? '0' : '00000', data: rows };
}
const reader = fetchImpl => createPerpetualFundingReader({ clock: () => NOW, fetchImpl });
const makeLighter = rows => ({ code: 200, resolution: '1h', fundings: rows });
const lighterRow = (time, rate = '0.0125', direction = 'long') => ({ timestamp: time / 1000, rate, direction, value: '9999.9' });

for (const exchange of cexIds) {
  test(`${exchange}: verified contracts use the correct public host and actual decimal settlements`, async () => {
    const calls = [];
    const read = reader(async (url, init) => {
      calls.push({ url: new URL(url), init });
      return response(cexEnvelope(exchange, [cexRow(exchange, NOW - HOUR + 7), cexRow(exchange, NOW, '0')]));
    });
    assert.deepEqual(await read(market(exchange), RANGE), [{ time: NOW - HOUR + 7, rate: -0.000125 }, { time: NOW, rate: 0 }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.host, cexHosts[exchange]);
    assert.equal(calls[0].url.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol'), market(exchange).symbol);
    assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
    assert.ok(calls[0].init.signal instanceof AbortSignal); assert.equal(calls[0].init.signal.aborted, false);
    if (exchange === 'okx') assert.equal(calls[0].url.searchParams.get('after'), String(NOW + 1));
  });

  test(`${exchange}: walks every full page and propagates later failures instead of returning partial records`, async () => {
    const forward = exchange === 'binance' || exchange === 'aster', size = pageSizes[exchange];
    const source = Array.from({ length: size + 3 }, (_, index) => cexRow(exchange, FROM + index * 1000, index % 2 ? '0' : '0.0001'));
    const calls = [];
    const fetchPage = url => {
      const query = new URL(url).searchParams;
      const time = item => Number(item.fundingRateTimestamp ?? item.fundingTime);
      let rows = source.filter(item => !query.has('startTime') || time(item) >= Number(query.get('startTime')));
      rows = rows.filter(item => !query.has('endTime') || time(item) <= Number(query.get('endTime')));
      rows = rows.filter(item => !query.has('after') || time(item) < Number(query.get('after')));
      rows.sort((a, b) => forward ? time(a) - time(b) : time(b) - time(a));
      const offset = exchange === 'bitget' ? (Number(query.get('pageNo')) - 1) * size : 0;
      return response(cexEnvelope(exchange, rows.slice(offset, offset + size)));
    };
    const read = reader(async url => { calls.push(url); return fetchPage(url); });
    const rows = await read(market(exchange), RANGE);
    assert.equal(calls.length, 2); assert.equal(rows.length, source.length);
    assert.equal(rows[0].time, FROM); assert.equal(rows.at(-1).time, FROM + (source.length - 1) * 1000);
    let failedCalls = 0;
    const failed = reader(async url => { if (++failedCalls === 2) throw Error('upstream disconnected'); return fetchPage(url); });
    await assert.rejects(failed(market(exchange), RANGE), /disconnected/);
    assert.equal(failedCalls, 2);
  });
}

test('generic CEX reuse leaves oil entry points on their original fixed contracts', async () => {
  for (const exchange of cexIds) {
    const calls = [];
    const readOil = createCexFundingHistoryReader({ clock: () => NOW, request: async url => { calls.push(url); return []; } });
    await assert.rejects(readOil(exchange, market(exchange).symbol, RANGE), /Unsupported/);
    assert.throws(() => parseCexFundingHistory(exchange, market(exchange).symbol, cexEnvelope(exchange, []), NOW), /Unsupported/);
    assert.deepEqual(calls, []);
  }
});

test('Bitget selects the USDC product from directory metadata and rejects a mismatched product', async () => {
  let requested;
  const read = reader(async url => { requested = new URL(url); return response(cexEnvelope('bitget', [cexRow('bitget', NOW, '0.0001', 'BTCUSDC')])); });
  const target = market('bitget', { symbol: 'BTCUSDC', quoteCurrency: 'USDC', productType: 'USDC-FUTURES' });
  assert.deepEqual(await read(target, RANGE), [{ time: NOW, rate: 0.0001 }]);
  assert.equal(requested.searchParams.get('productType'), 'USDC-FUTURES');
  assert.equal(requested.searchParams.get('symbol'), 'BTCUSDC');
  await assert.rejects(read({ ...target, productType: 'USDT-FUTURES' }, RANGE), /类型不匹配/);
});

test('Binance and Aster preserve directory-verified USD1 symbols on their USD-margined endpoints', async () => {
  for (const exchange of ['binance', 'aster']) {
    let requested;
    const read = reader(async url => { requested = new URL(url); return response(cexEnvelope(exchange, [cexRow(exchange, NOW, '0.0001', 'BTCUSD1')])); });
    assert.deepEqual(await read(market(exchange, { symbol: 'BTCUSD1', quoteCurrency: 'USD1' }), RANGE), [{ time: NOW, rate: 0.0001 }]);
    assert.equal(requested.host, cexHosts[exchange]); assert.equal(requested.searchParams.get('symbol'), 'BTCUSD1');
  }
});

test('Gate includes exact end settlements through its exclusive seconds cursor, with stable backward pagination', async () => {
  const calls = [];
  const source = Array.from({ length: 130 }, (_, index) => ({ t: (NOW - index * 60_000) / 1000, r: index % 2 ? '-0.0001' : '0' }));
  const read = reader(async url => {
    const parsed = new URL(url); calls.push(parsed);
    const query = parsed.searchParams;
    return response(source.filter(row => row.t >= Number(query.get('from')) && row.t < Number(query.get('to'))).slice(0, Number(query.get('limit'))));
  });
  const rows = await read(market('gate'), { from: NOW - 129 * 60_000, to: NOW });
  assert.equal(rows.length, 130); assert.equal(rows[0].time, NOW - 129 * 60_000); assert.equal(rows.at(-1).time, NOW);
  assert.equal(calls[0].host, 'api.gateio.ws'); assert.equal(calls[0].pathname, '/api/v4/futures/usdt/funding_rate');
  assert.equal(calls[0].searchParams.get('to'), String(NOW / 1000 + 1));
  assert.equal(calls[1].searchParams.get('to'), String(source[99].t));
  assert.deepEqual(await read(market('gate'), { from: NOW, to: NOW }), [{ time: NOW, rate: 0 }]);
});

for (const exchange of ['hyperliquid', 'entropy']) {
  test(`${exchange}: preserves HIP-3 coin names and exact milliseconds across the 500-row limit`, async () => {
    const target = market(exchange, { symbol: exchange === 'entropy' ? 'io:SNDK' : 'xyz:BRENTOIL' });
    const source = Array.from({ length: 501 }, (_, index) => ({ coin: target.symbol, time: FROM + 7 + index * 1000, fundingRate: index % 2 ? '0' : '-0.0001', premium: '0.999' }));
    const calls = [];
    const read = reader(async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      return response(source.filter(row => row.time >= body.startTime && row.time <= body.endTime).slice(0, 500));
    });
    const rows = await read(target, RANGE);
    assert.equal(rows.length, 501); assert.equal(rows[0].time, FROM + 7); assert.equal(rows[0].rate, -0.0001);
    assert.equal(calls.length, 2); assert.equal(calls[0].url, 'https://api.hyperliquid.xyz/info');
    assert.equal(calls[0].body.type, 'fundingHistory'); assert.equal(calls[0].body.coin, target.symbol);
    assert.equal(calls[1].body.startTime, source[499].time + 1);
  });
}

for (const exchange of ['lighter', 'rh-lighter']) {
  test(`${exchange}: uses its own deployment/id and settled payer-signed percentages, not USD value or forecasts`, async () => {
    const target = market(exchange), calls = [];
    const start = NOW - 3 * HOUR + 137;
    const read = reader(async url => {
      calls.push(new URL(url));
      return response(makeLighter([lighterRow(NOW - 4 * HOUR), lighterRow(NOW - 2 * HOUR, '0.0125', 'short'), lighterRow(NOW - HOUR, '0', 'short'), lighterRow(NOW, '0.02', 'long')]));
    });
    assert.deepEqual(await read(target, { from: start, to: NOW }), [{ time: NOW - 2 * HOUR, rate: -0.000125 }, { time: NOW - HOUR, rate: 0 }, { time: NOW, rate: 0.0002 }]);
    assert.equal(calls[0].host, exchange === 'lighter' ? 'mainnet.zklighter.elliot.ai' : 'api.rh.lighter.xyz');
    assert.equal(calls[0].pathname, '/api/v1/fundings');
    assert.equal(calls[0].searchParams.get('market_id'), String(target.marketId));
    assert.equal(calls[0].searchParams.get('count_back'), '0'); assert.equal(calls[0].searchParams.get('resolution'), '1h');
    assert.equal(calls[0].searchParams.get('start_timestamp'), String((NOW - 4 * HOUR) / 1000));
  });
}

test('history parsers reject bad identities, rate units, timestamps and conflicting duplicates', async () => {
  const cases = [
    [market('gate'), [{ t: NOW / 1000, r: '0x1' }]],
    [market('gate'), [{ t: NOW, r: '0' }]],
    [market('gate'), [{ t: NOW / 1000, r: '0', contract: 'ETH_USDT' }]],
    [market('gate'), [{ t: NOW / 1000, r: '0' }, { t: NOW / 1000, r: '0.1' }]],
    [market('hyperliquid'), [{ coin: 'ETH', time: NOW, fundingRate: '0' }]],
    [market('hyperliquid'), [{ coin: 'BTC', time: NOW / 1000, fundingRate: '0' }]],
    [market('hyperliquid'), [{ coin: 'BTC', time: NOW + 1, fundingRate: '0' }]],
    [market('hyperliquid'), [{ coin: 'BTC', time: NOW, fundingRate: '1.01' }]],
    [market('hyperliquid'), [{ coin: 'BTC', time: NOW, fundingRate: null }]],
    [market('hyperliquid'), [{ coin: 'BTC', time: NOW, fundingRate: '0' }, { coin: 'BTC', time: NOW, fundingRate: '0.01' }]],
    [market('lighter'), makeLighter([lighterRow(NOW, '0.01', 'buy')])],
    [market('lighter'), makeLighter([lighterRow(NOW, '-0.01')])],
    [market('lighter'), makeLighter([lighterRow(NOW, '0x1')])],
    [market('lighter'), makeLighter([lighterRow(NOW + HOUR)])],
    [market('lighter'), { ...makeLighter([]), market_id: 99 }],
    [market('lighter'), { ...makeLighter([]), code: '200' }],
    [market('lighter'), { ...makeLighter([]), resolution: '1d' }],
    [market('rh-lighter'), makeLighter([{ ...lighterRow(NOW), market_id: 1 }])],
  ];
  for (const [target, input] of cases) await assert.rejects(reader(async () => response(input))(target, RANGE));
  for (const exchange of cexIds) {
    await assert.rejects(reader(async () => response(cexEnvelope(exchange, [cexRow(exchange, NOW, null)])))(market(exchange), RANGE));
    await assert.rejects(reader(async () => response(cexEnvelope(exchange, [cexRow(exchange, NOW, '0', 'OTHER')])))(market(exchange), RANGE));
  }
});

test('caps, stale pages and later network failures never return truncated histories', async () => {
  const oversize = [
    [market('gate'), Array.from({ length: 101 }, () => ({ t: NOW / 1000, r: '0' }))],
    [market('hyperliquid'), Array.from({ length: 501 }, () => ({ coin: 'BTC', time: NOW, fundingRate: '0' }))],
    [market('lighter'), makeLighter(Array.from({ length: 750 }, () => lighterRow(NOW)))],
  ];
  for (const [target, input] of oversize) await assert.rejects(reader(async () => response(input))(target, RANGE));
  for (const exchange of ['gate', 'hyperliquid']) {
    const first = Array.from({ length: exchange === 'gate' ? 100 : 500 }, (_, index) => exchange === 'gate' ? { t: NOW / 1000 - index * 60, r: '0' } : { coin: 'BTC', time: FROM + index * 1000, fundingRate: '0' });
    let calls = 0;
    await assert.rejects(reader(async () => { calls++; return response(first); })(market(exchange), RANGE));
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(reader(async () => { if (++calls === 2) throw Error('gone'); return response(first); })(market(exchange), RANGE), /gone/);
    assert.equal(calls, 2);
  }
});

test('HTTP rate limits preserve status and numeric/date Retry-After for host-wide backoff', async () => {
  for (const [status, header, expected] of [[429, '1.5', 1500], [418, new Date(NOW + 30_000).toUTCString(), 30_000], [429, 'invalid', undefined]]) {
    const read = reader(async () => ({ ok: false, status, headers: new Headers({ 'Retry-After': header }), json: async () => { throw Error('must not parse error body'); } }));
    await assert.rejects(read(market('gate'), RANGE), error => error.status === status && error.retryAfterMs === expected);
  }
});

test('abort signals cancel active requests and prevent subsequent pages', async () => {
  const controller = new AbortController(); let calls = 0;
  const read = reader(async (_url, init) => {
    calls++;
    const pending = new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    controller.abort(new Error('cancelled'));
    return pending;
  });
  await assert.rejects(read(market('gate'), RANGE, { signal: controller.signal }), /cancelled/);
  await assert.rejects(read(market('gate'), RANGE, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
  const between = new AbortController(); calls = 0;
  const pageAbort = reader(async () => {
    calls++; between.abort(new Error('stopped'));
    return response(Array.from({ length: 100 }, (_, index) => ({ t: NOW / 1000 - index * 60, r: '0' })));
  });
  await assert.rejects(pageAbort(market('gate'), RANGE, { signal: between.signal }), /stopped/);
  assert.equal(calls, 1);
});

test('unsupported venues, Kraken accrual semantics and invalid inputs are rejected before network access', async () => {
  let calls = 0;
  const read = reader(async () => { calls++; throw Error('unexpected request'); });
  for (const target of [market('unknown'), market('kraken', { symbol: 'PF_XBTUSD', quoteCurrency: 'USD' }), market('gate', { quoteCurrency: 'BTC' }), market('binance', { quoteCurrency: 'BTC' })]) {
    await assert.rejects(read(target, RANGE), error => error.code === 'UNSUPPORTED' && /[\u4e00-\u9fff]/.test(error.message));
  }
  for (const target of [market('gate', { symbol: 'BTC_USDT?url=evil' }), market('lighter', { marketId: -1 }), market('entropy', { symbol: 'xyz:SNDK' })]) await assert.rejects(read(target, RANGE));
  for (const range of [{ from: FROM - 1, to: NOW }, { from: NOW, to: NOW + 1 }, { from: NOW, to: NOW - 1 }, { from: NaN, to: NOW }, { from: FROM / 1000, to: NOW }]) await assert.rejects(read(market('gate'), range));
  assert.equal(calls, 0);
});

test('Bitget 32-day backfill reads each page once and publishes only verified contiguous progress', async () => {
  const rows = Array.from({ length: 769 }, (_, index) => cexRow('bitget', NOW - index * HOUR, '0.0001'));
  const pages = [], progress = [];
  const read = reader(async url => {
    const page = Number(new URL(url).searchParams.get('pageNo')); pages.push(page);
    return response(cexEnvelope('bitget', rows.slice((page - 1) * 100, page * 100)));
  });
  const range = { from: NOW - 32 * 24 * HOUR, to: NOW };
  const result = await read(market('bitget'), range, { onProgress: value => progress.push(value) });
  assert.equal(result.length, 769); assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(progress[0].records.length, 100); assert.equal(progress[0].coverage.from, NOW - 99 * HOUR);
  assert.deepEqual(progress.at(-1).coverage, range);
  const partial = [];
  const fail = reader(async url => {
    const page = Number(new URL(url).searchParams.get('pageNo'));
    if (page === 3) throw Error('disconnected');
    return response(cexEnvelope('bitget', rows.slice((page - 1) * 100, page * 100)));
  });
  await assert.rejects(fail(market('bitget'), range, { onProgress: value => partial.push(value) }), /disconnected/);
  assert.equal(partial.length, 2); assert.equal(partial.at(-1).coverage.from, NOW - 199 * HOUR);
  await assert.rejects(read(market('bitget'), { ...range, from: range.from - 1 }));
});

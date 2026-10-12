import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCexFundingHistoryReader, parseCexFundingHistory } from '../lib/exchange-funding-cex.ts';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000;
const exchanges = ['binance', 'bybit', 'okx', 'bitget'];
const contract = (exchange, base = 'BZ') => exchange === 'okx' ? `${base}-USDT-SWAP` : `${base}USDT`;
function row(exchange, time = NOW - HOUR, rate = '-0.000118', base = 'BZ') {
  const symbol = contract(exchange, base);
  if (exchange === 'bybit') return { symbol, fundingRateTimestamp: String(time), fundingRate: rate };
  if (exchange === 'okx') return { instId: symbol, instType: 'SWAP', method: 'current_period', fundingTime: String(time), fundingRate: '0.9', realizedRate: rate };
  return { symbol, fundingTime: exchange === 'binance' ? time : String(time), fundingRate: rate, ...(exchange === 'binance' ? { rateType: 'Regular' } : {}) };
}
function envelope(exchange, records) {
  if (exchange === 'binance') return records;
  if (exchange === 'bybit') return { retCode: 0, result: { category: 'linear', list: records } };
  return { code: exchange === 'okx' ? '0' : '00000', data: records };
}
const parse = (exchange, records) => parseCexFundingHistory(exchange, contract(exchange), envelope(exchange, records), NOW);

for (const exchange of exchanges) {
  test(`${exchange}: preserves decimal rates and exact source milliseconds, sorts, deduplicates and removes future records`, () => {
    const early = NOW - 5 * HOUR + 137, recent = NOW - HOUR + 987;
    const records = [row(exchange, recent, '0'), row(exchange, NOW + HOUR, '0.0004'), row(exchange, early), row(exchange, recent, 0)];
    assert.deepEqual(parse(exchange, records), [{ time: early, rate: -0.000118 }, { time: recent, rate: 0 }]);
    assert.deepEqual(parse(exchange, []), []);
    assert.deepEqual(parse(exchange, [row(exchange, NOW, '0.0001')]), [{ time: NOW, rate: 0.0001 }]);
    assert.deepEqual(parseCexFundingHistory(exchange, contract(exchange, 'CL'), envelope(exchange, [row(exchange, recent, '0', 'CL')]), NOW), [{ time: recent, rate: 0 }]);
  });

  test(`${exchange}: rejects malformed rates, time units, contract identities and conflicting settlements`, () => {
    const rateField = exchange === 'okx' ? 'realizedRate' : 'fundingRate';
    const timeField = exchange === 'bybit' ? 'fundingRateTimestamp' : 'fundingTime';
    for (const value of [undefined, null, '', ' ', false, {}, [], 'NaN', NaN, Infinity, 'Infinity', '0x10', '1.01']) {
      assert.throws(() => parse(exchange, [{ ...row(exchange), [rateField]: value }]), /Invalid CEX funding/);
    }
    for (const value of [undefined, null, '', 0, NOW / 1000, NOW - 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => parse(exchange, [{ ...row(exchange), [timeField]: value }]), /Invalid CEX funding/);
    }
    assert.throws(() => parse(exchange, [row(exchange), row(exchange, NOW - HOUR, '0.0002')]), /Conflicting/);
    assert.throws(() => parse(exchange, [row(exchange, NOW - HOUR, '0', 'CL')]), /mismatch/);
    assert.throws(() => parse(exchange, [null]), /Invalid/);
    assert.throws(() => parseCexFundingHistory(exchange, 'BTCUSDT', envelope(exchange, []), NOW), /Unsupported/);
    const withoutIdentity = row(exchange);
    delete withoutIdentity[exchange === 'okx' ? 'instId' : 'symbol'];
    assert.equal(parse(exchange, [withoutIdentity]).length, 1);
  });
}

test('official success envelopes are required; API error objects cannot become empty successful history', () => {
  for (const exchange of exchanges) {
    for (const input of [null, {}, { code: '0' }, { code: 'error', data: [] }, { retCode: 10001, result: { list: [] } }]) {
      assert.throws(() => parseCexFundingHistory(exchange, contract(exchange), input, NOW));
    }
  }
  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: '0', result: { list: [] } }, NOW));
  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: 0, result: { category: 'inverse', list: [] } }, NOW));
  assert.throws(() => parseCexFundingHistory('okx', 'BZ-USDT-SWAP', { code: 0, data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('bitget', 'BZUSDT', { code: '0', data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('other', 'BZUSDT', [], NOW), /Unsupported/);
});

test('OKX uses only actual realized rates, including zero and historical next_period; Binance rejects dividend entries', () => {
  assert.deepEqual(parse('okx', [{ ...row('okx'), realizedRate: '0', method: 'next_period' }]), [{ time: NOW - HOUR, rate: 0 }]);
  assert.throws(() => parse('okx', [{ ...row('okx'), realizedRate: undefined }]), /Invalid/);
  assert.throws(() => parse('okx', [{ ...row('okx'), instType: 'FUTURES' }]), /instrument/);
  assert.throws(() => parse('binance', [{ ...row('binance'), rateType: 'Special' }]), /rate type/);
});

const pageSizes = { binance: 1000, bybit: 200, okx: 400, bitget: 100 };
const WINDOW = 60 * 24 * HOUR;
function servePage(exchange, url, records) {
  const params = new URL(url).searchParams;
  const time = record => Number(record[exchange === 'bybit' ? 'fundingRateTimestamp' : 'fundingTime']);
  const size = Number(params.get(exchange === 'bitget' ? 'pageSize' : 'limit'));
  let selected = records;
  if (params.has('startTime')) selected = selected.filter(record => time(record) >= Number(params.get('startTime')));
  if (params.has('endTime')) selected = selected.filter(record => time(record) <= Number(params.get('endTime')));
  if (params.has('after')) selected = selected.filter(record => time(record) < Number(params.get('after')));
  selected = selected.toSorted((a, b) => exchange === 'binance' ? time(a) - time(b) : time(b) - time(a));
  const offset = exchange === 'bitget' ? (Number(params.get('pageNo')) - 1) * size : 0;
  return envelope(exchange, selected.slice(offset, offset + size));
}

test('reader requests each official maximum page size and defaults to a complete 60-day interval', async () => {
  const requested = [];
  const expected = {
    binance: ['fapi.binance.com', '/fapi/v1/fundingRate'],
    bybit: ['api.bybit.com', '/v5/market/funding/history'],
    okx: ['www.okx.com', '/api/v5/public/funding-rate-history'],
    bitget: ['api.bitget.com', '/api/v2/mix/market/history-fund-rate'],
  };
  for (const exchange of exchanges) {
    const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
      const parsed = new URL(url); requested.push(parsed);
      const base = parsed.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol').startsWith('BZ') ? 'BZ' : 'CL';
      return envelope(exchange, [row(exchange, NOW - HOUR, '0.0001', base)]);
    } });
    for (const base of ['BZ', 'CL']) {
      const result = await reader(exchange, contract(exchange, base));
      assert.equal(result.length, 1);
      const url = requested.at(-1);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.host, expected[exchange][0]);
      assert.equal(url.pathname, expected[exchange][1]);
      assert.equal(url.searchParams.get(exchange === 'okx' ? 'instId' : 'symbol'), contract(exchange, base));
      assert.equal(url.searchParams.get(exchange === 'bitget' ? 'pageSize' : 'limit'), String(pageSizes[exchange]));
      if (exchange === 'binance') assert.equal(url.searchParams.get('startTime'), String(NOW - WINDOW));
      else assert.equal(url.searchParams.has('startTime'), false);
      if (exchange === 'binance' || exchange === 'bybit') assert.equal(url.searchParams.get('endTime'), String(NOW));
      if (exchange === 'bybit') assert.equal(url.searchParams.get('category'), 'linear');
      if (exchange === 'okx') assert.equal(url.searchParams.get('after'), String(NOW + 1));
      if (exchange === 'bitget') {
        assert.equal(url.searchParams.get('productType'), 'USDT-FUTURES');
        assert.equal(url.searchParams.get('pageNo'), '1');
      }
    }
    await assert.rejects(reader(exchange, 'BTCUSDT'), /Unsupported/);
  }
  assert.equal(requested.length, 8);
});

for (const exchange of exchanges) {
  test(`${exchange}: paginates all hourly settlements over 60 days without a 200-record cutoff`, async () => {
    const source = Array.from({ length: 1450 }, (_, index) => row(exchange, NOW - index * HOUR, String(index / 1_000_000)));
    const requested = [];
    const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
      requested.push(new URL(url));
      return servePage(exchange, url, source);
    } });
    const result = await reader(exchange, contract(exchange));
    assert.equal(result.length, 1441);
    assert.deepEqual(result[0], { time: NOW - WINDOW, rate: 0.00144 });
    assert.deepEqual(result.at(-1), { time: NOW, rate: 0 });
    assert.ok(result.every((record, index) => !index || record.time === result[index - 1].time + HOUR));
    assert.equal(requested.length, Math.ceil(1441 / pageSizes[exchange]));
    if (exchange === 'binance') assert.equal(requested[1].searchParams.get('startTime'), String(NOW - WINDOW + 999 * HOUR + 1));
    if (exchange === 'bybit') assert.equal(requested[1].searchParams.get('endTime'), String(NOW - 199 * HOUR - 1));
    if (exchange === 'okx') assert.equal(requested[1].searchParams.get('after'), String(NOW - 399 * HOUR));
    if (exchange === 'bitget') assert.equal(requested[1].searchParams.get('pageNo'), '2');
  });

  test(`${exchange}: honors both inclusive custom bounds, including an older range and a single settlement`, async () => {
    const source = Array.from({ length: 400 }, (_, index) => row(exchange, NOW - index * HOUR));
    let calls = 0;
    const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
      calls++;
      return servePage(exchange, url, source);
    } });
    const result = await reader(exchange, contract(exchange), { from: NOW - 350 * HOUR, to: NOW - 250 * HOUR });
    assert.equal(result.length, 101);
    assert.equal(result[0].time, NOW - 350 * HOUR);
    assert.equal(result.at(-1).time, NOW - 250 * HOUR);
    assert.equal(calls, exchange === 'bitget' ? 4 : 1);
    assert.deepEqual(await reader(exchange, contract(exchange), { from: NOW - HOUR, to: NOW - HOUR }), [{ time: NOW - HOUR, rate: -0.000118 }]);
    const beforeInvalid = calls;
    for (const range of [{ from: NOW, to: NOW - 1 }, { from: NOW, to: NOW + 1 }, { from: NaN, to: NOW }, { from: NOW / 1000, to: NOW }]) {
      await assert.rejects(reader(exchange, contract(exchange), range), /Invalid CEX funding/);
    }
    assert.equal(calls, beforeInvalid);
  });

  test(`${exchange}: deduplicates matching boundary overlap but rejects cross-page rate conflicts`, async () => {
    const first = Array.from({ length: pageSizes[exchange] }, (_, index) => row(exchange, exchange === 'binance' ? NOW - WINDOW + index * HOUR : NOW - index * HOUR, '0.0001'));
    const boundary = exchange === 'binance' ? NOW - WINDOW + (first.length - 1) * HOUR : NOW - (first.length - 1) * HOUR;
    const nextTime = boundary + (exchange === 'binance' ? HOUR : -HOUR);
    const readWithOverlap = async conflict => {
      let calls = 0;
      const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async () => envelope(exchange, ++calls === 1 ? first : [row(exchange, boundary, conflict ? '0.0002' : '0.0001'), row(exchange, nextTime, '0.0001')]) });
      return reader(exchange, contract(exchange));
    };
    const records = await readWithOverlap(false);
    assert.equal(records.length, first.length + 1);
    assert.equal(records.filter(record => record.time === boundary).length, 1);
    await assert.rejects(readWithOverlap(true), /Conflicting/);
  });

  test(`${exchange}: rejects a repeated page and a later transport failure without returning partial history`, async () => {
    const first = Array.from({ length: pageSizes[exchange] }, (_, index) => row(exchange, exchange === 'binance' ? NOW - WINDOW + index * HOUR : NOW - index * HOUR));
    let repeats = 0;
    const stuck = createCexFundingHistoryReader({ clock: () => NOW, request: async () => { repeats++; return envelope(exchange, first); } });
    await assert.rejects(stuck(exchange, contract(exchange)), /pagination did not advance/);
    assert.equal(repeats, 2);
    let calls = 0;
    const failed = createCexFundingHistoryReader({ clock: () => NOW, request: async () => {
      if (++calls === 2) throw new Error('HTTP 429');
      return envelope(exchange, first);
    } });
    await assert.rejects(failed(exchange, contract(exchange)), /HTTP 429/);
    assert.equal(calls, 2);
  });

  test(`${exchange}: fails at the page safety limit instead of silently truncating dense data`, async () => {
    let calls = 0;
    const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async () => {
      const offset = calls++ * pageSizes[exchange];
      return envelope(exchange, Array.from({ length: pageSizes[exchange] }, (_, index) => row(exchange, exchange === 'binance' ? NOW - WINDOW + offset + index : NOW - offset - index)));
    } });
    await assert.rejects(reader(exchange, contract(exchange)), /exceeded page limit/);
    assert.equal(calls, 32);
  });
}

test('empty history succeeds; malformed oversized pages cannot masquerade as a completed interval', async () => {
  for (const exchange of exchanges) {
    const empty = createCexFundingHistoryReader({ clock: () => NOW, request: async () => envelope(exchange, []) });
    assert.deepEqual(await empty(exchange, contract(exchange)), []);
    const oversized = createCexFundingHistoryReader({ clock: () => NOW, request: async () => envelope(exchange, Array.from({ length: pageSizes[exchange] + 1 }, () => row(exchange))) });
    await assert.rejects(oversized(exchange, contract(exchange)), /page size/);
  }
});

test('reader propagates request and parsing failures so the caller can preserve each leg independently', async () => {
  const reader = createCexFundingHistoryReader({ clock: () => NOW, request: async url => {
    if (new URL(url).searchParams.get('symbol') === 'CLUSDT') throw new Error('HTTP 451');
    return envelope('binance', [row('binance')]);
  } });
  assert.equal((await reader('binance', 'BZUSDT')).length, 1);
  await assert.rejects(reader('binance', 'CLUSDT'), /HTTP 451/);
  const failedApi = createCexFundingHistoryReader({ clock: () => NOW, request: async () => ({ retCode: 10006, result: { list: [] } }) });
  await assert.rejects(failedApi('bybit', 'BZUSDT'), /response failed/);
});

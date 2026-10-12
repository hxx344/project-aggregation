import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPositioning, positioningUnavailableReason } from '../server/perpetual-positioning.mjs';

const now = 1_790_000_000_000;
const ts = now - 300_000;
const quotes = {
  binance: { exchange: 'binance', symbol: '1000PEPEUSDT', base: 'PEPE', quoteCurrency: 'USDT' },
  bybit: { exchange: 'bybit', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT' },
  okx: { exchange: 'okx', symbol: 'BTC-USDT-SWAP', base: 'BTC', quoteCurrency: 'USDT' },
  bitget: { exchange: 'bitget', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT' },
  gate: { exchange: 'gate', symbol: 'BTC_USDT', base: 'BTC', quoteCurrency: 'USDT' },
};
function fixture(body, options = {}) {
  const calls = [];
  return { calls, fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify(body), options); } };
}
const fetchData = (exchange, body, options = {}) => fetchPositioning(quotes[exchange], { ...fixture(body), now, ...options });

test('Binance retains the actual multiplied contract symbol and uses global account shares', async () => {
  const mock = fixture([{ symbol: '1000PEPEUSDT', longAccount: '0.6', shortAccount: '0.4', longShortRatio: '999', timestamp: ts }]);
  const data = await fetchPositioning(quotes.binance, { ...mock, now });
  assert.equal(data.longRatio, 0.6);
  assert.equal(data.shortRatio, 0.4);
  assert.equal(data.kind, 'accounts');
  assert.equal(data.observedAt, ts);
  assert.match(data.scope, /全体/);
  const url = new URL(mock.calls[0][0]);
  assert.equal(url.pathname, '/futures/data/globalLongShortAccountRatio');
  assert.equal(url.searchParams.get('symbol'), '1000PEPEUSDT');
  assert.equal(url.searchParams.get('period'), '5m');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(data.source, url.href);
  assert.equal(mock.calls.length, 1);
});

test('Bybit uses holder-account fractions, row time, and its 5min period spelling', async () => {
  const mock = fixture({ retCode: 0, time: now, result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.5245', sellRatio: '0.4755', timestamp: String(ts) }] } });
  const data = await fetchPositioning(quotes.bybit, { ...mock, now });
  assert.equal(data.longRatio, 0.5245);
  assert.equal(data.observedAt, ts);
  const url = new URL(data.source);
  assert.equal(url.searchParams.get('category'), 'linear');
  assert.equal(url.searchParams.get('period'), '5min');
});

test('OKX uses the exact contract rather than currency-wide or top-trader statistics', async () => {
  const data = await fetchData('okx', { code: '0', data: [[String(ts), '3']] });
  assert.equal(data.longRatio, 0.75);
  assert.equal(data.shortRatio, 0.25);
  const url = new URL(data.source);
  assert.equal(url.pathname, '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract');
  assert.equal(url.searchParams.get('instId'), 'BTC-USDT-SWAP');
  assert.equal(url.searchParams.has('ccy'), false);
  assert.equal(data.observedAt, ts);
});

test('Bitget selects the latest interval regardless of response order and ignores receipt time', async () => {
  const data = await fetchData('bitget', { code: '00000', requestTime: now, data: [
    { longRatio: '0.7', shortRatio: '0.3', ts: String(ts) },
    { longRatio: '0.1', shortRatio: '0.9', ts: String(ts - 300_000) },
  ] });
  assert.equal(data.longRatio, 0.7);
  assert.equal(data.observedAt, ts);
  assert.equal(new URL(data.source).pathname, '/api/v2/mix/market/long-short');
});

test('Gate converts seconds and all-holder counts; taker and top-holder ratios cannot leak in', async () => {
  const data = await fetchData('gate', [{ time: ts / 1_000, long_users: 3, short_users: 1, lsr_taker: 9, top_lsr_account: 99, top_lsr_size: 999 }]);
  assert.equal(data.longRatio, 0.75);
  assert.equal(data.shortRatio, 0.25);
  assert.equal(data.observedAt, ts);
  const olderSchema = await fetchData('gate', [{ time: ts / 1_000, lsr_account: '3' }]);
  assert.equal(olderSchema.longRatio, 0.75);
});

test('zero is a valid published side, while zero total accounts is unavailable', async () => {
  const bybit = await fetchData('bybit', { retCode: 0, result: { list: [{ buyRatio: '0', sellRatio: '1', timestamp: ts }] } });
  assert.equal(bybit.longRatio, 0);
  assert.equal(bybit.shortRatio, 1);
  const okx = await fetchData('okx', { code: '0', data: [[ts, '0']] });
  assert.equal(okx.longRatio, 0);
  assert.equal(okx.shortRatio, 1);
  const gate = await fetchData('gate', [{ time: ts / 1_000, long_users: 10, short_users: 0 }]);
  assert.equal(gate.longRatio, 1);
  assert.equal(gate.shortRatio, 0);
  assert.equal(await fetchData('gate', [{ time: ts / 1_000, long_users: 0, short_users: 0, lsr_account: 0 }]), null);
});

test('missing, invalid, percentage-scaled and inconsistent fraction fields remain unavailable', async () => {
  for (const [long, short] of [[null, 1], ['', 1], [' ', 1], [true, 0], [undefined, 1], [0, 0], [60, 40], [-0.1, 1.1], [0.01, 0.12], ['NaN', 1], ['Infinity', 0]]) {
    assert.equal(await fetchData('bitget', { code: '00000', data: [{ longRatio: long, shortRatio: short, ts }] }), null);
  }
  for (const value of [null, '', ' ', -1, 'NaN', 'Infinity', true]) {
    assert.equal(await fetchData('okx', { code: '0', data: [[ts, value]] }), null);
  }
  assert.equal(await fetchData('gate', [{ time: ts / 1_000, long_users: 0, lsr_account: 1 }]), null);
  assert.equal(await fetchData('gate', [{ time: ts / 1_000, long_users: -1, short_users: 2 }]), null);
  assert.equal(await fetchData('gate', [{ time: ts / 1_000, lsr_taker: 1, top_lsr_account: 1 }]), null);
});

test('published rounding is normalized and a very large L/S value does not overflow', async () => {
  const rounded = await fetchData('bitget', { code: '00000', data: [{ longRatio: '0.6667', shortRatio: '0.3334', ts }] });
  assert.ok(Math.abs(rounded.longRatio + rounded.shortRatio - 1) < 1e-15);
  const large = await fetchData('okx', { code: '0', data: [[ts, '1e308']] });
  assert.equal(large.longRatio, 1);
  assert.ok(large.shortRatio > 0);
});

test('source time is required, units are explicit, and stale data keeps its original time', async () => {
  for (const value of [undefined, null, '', 0, -1, ts / 1_000, ts * 1_000, now + 5_001]) {
    assert.equal(await fetchData('okx', { code: '0', data: [[value, 1]] }), null);
  }
  assert.equal(await fetchData('gate', [{ time: ts, lsr_account: 1 }]), null);
  const old = ts - 86_400_000;
  assert.equal((await fetchData('okx', { code: '0', data: [[old, 1]] })).observedAt, old);
});

test('empty series, missing ratio, and mismatching symbols do not fabricate an even split', async () => {
  assert.equal(await fetchData('okx', { code: '0', data: [] }), null);
  assert.equal(await fetchData('bybit', { retCode: 0, result: { list: [] } }), null);
  assert.equal(await fetchData('binance', [{ symbol: 'BTCUSDT', longAccount: 0.5, shortAccount: 0.5, timestamp: ts }]), null);
  assert.equal(await fetchData('bybit', { retCode: 0, result: { list: [{ timestamp: ts }] } }), null);
});

test('DEX and undocumented quote types make no requests', async () => {
  const mock = fixture([]);
  for (const exchange of ['hyperliquid', 'lighter', 'rh-lighter', 'aster', 'entropy', 'unknown']) {
    assert.equal(await fetchPositioning({ ...quotes.bybit, exchange }, { ...mock, now }), null);
  }
  assert.equal(await fetchPositioning({ ...quotes.bybit, quoteCurrency: 'USDC', symbol: 'BTCPERP' }, { ...mock, now }), null);
  assert.equal(await fetchPositioning({ ...quotes.gate, quoteCurrency: 'USD' }, { ...mock, now }), null);
  assert.equal(await fetchPositioning({ ...quotes.bitget, quoteCurrency: 'USDC' }, { ...mock, now }), null);
  assert.equal(mock.calls.length, 0);
});

test('positioning unavailability explains the shared routing decision without claiming a DEX has no official data', async () => {
  const mock = fixture([]);
  for (const quote of Object.values(quotes)) assert.equal(positioningUnavailableReason(quote), null);
  for (const [exchange, quoteCurrency, symbol, reason] of [
    ['bybit', 'USDC', 'BTCPERP', /Bybit.*USDT.*计价类别/],
    ['bitget', 'USDC', 'BTCPERP', /Bitget.*USDT.*计价类别/],
    ['gate', 'USD', 'BTC_USD', /Gate.*USDT.*_USDT/],
    ['gate', 'USDT', 'BTCUSDT', /Gate.*_USDT/],
    ['unknown', 'USDT', 'BTCUSDT', /当前未接入该平台/],
  ]) {
    const quote = { exchange, quoteCurrency, symbol };
    assert.match(positioningUnavailableReason(quote), reason);
    assert.equal(await fetchPositioning(quote, { ...mock, now }), null);
  }
  for (const exchange of ['hyperliquid', 'lighter', 'rh-lighter', 'aster', 'entropy']) {
    const quote = { exchange, symbol: 'BTC', quoteCurrency: 'USDT' };
    const reason = positioningUnavailableReason(quote);
    assert.match(reason, /当前未接入.*DEX.*官方多空账户比/);
    assert.doesNotMatch(reason, /不存在|不提供|没有/);
    assert.equal(await fetchPositioning(quote, { ...mock, now }), null);
  }
  assert.match(positioningUnavailableReason({ exchange: 'entropy', symbol: 'io:SNDK', quoteCurrency: 'USDC' }), /当前未接入.*DEX/);
  assert.equal(mock.calls.length, 0);
});

test('positioning invalid symbols have a distinct reason and never reach the network', async () => {
  const mock = fixture([]);
  for (const quote of [null, {}, { ...quotes.binance, symbol: '' }, { ...quotes.binance, symbol: 'BTC/USDT' }, { ...quotes.binance, symbol: 'A'.repeat(81) }, { ...quotes.binance, symbol: 123 }]) {
    assert.match(positioningUnavailableReason(quote), /合约代码格式无效/);
    assert.equal(await fetchPositioning(quote, { ...mock, now }), null);
  }
  assert.equal(mock.calls.length, 0);
});

test('HTTP and vendor rate limits propagate status for the shared scheduler', async () => {
  const http = fixture({}, { status: 429, headers: { 'retry-after': '12' } });
  await assert.rejects(fetchPositioning(quotes.binance, { ...http, now }), error => error.status === 429 && error.retryAfterMs === 12_000);
  for (const [exchange, body] of [
    ['bybit', { retCode: 10006, retMsg: 'Too many visits' }],
    ['okx', { code: '50011', msg: 'Rate limit reached' }],
    ['binance', { code: -1003, msg: 'Too many requests' }],
  ]) await assert.rejects(fetchData(exchange, body), error => error.status === 429);
  await assert.rejects(fetchData('bybit', { retCode: 10001, retMsg: 'Invalid symbol' }), error => error.status === 502 && error.code === 10001);
  await assert.rejects(fetchData('bitget', { code: '40020', msg: 'Parameter error' }), error => error.status === 502);
});

test('transport/protocol errors reject, and cancellation reaches the one request', async () => {
  await assert.rejects(fetchPositioning(quotes.okx, { now, fetchImpl: async () => new Response('not json') }), error => error.status === 502);
  await assert.rejects(fetchData('okx', { code: '0', data: {} }), error => error.status === 502);
  const failure = new Error('network unavailable');
  await assert.rejects(fetchPositioning(quotes.okx, { now, fetchImpl: async () => { throw failure; } }), error => error === failure);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchPositioning(quotes.okx, { now, signal: controller.signal, fetchImpl: async (_url, { signal }) => {
    calls++; signal.throwIfAborted();
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

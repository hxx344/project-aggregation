import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTradingExchangeClient, TradingExchangeError, MAX_FUNDING_EVENTS } from '../server/trading-exchanges.mjs';
import { decimal, addDecimals, negateDecimal, compareDecimals } from '../server/trading-decimal.mjs';
import { normalizeTradingDiagnostic, formatTradingDiagnostic } from '../server/trading-diagnostics.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const DAY = 86_400_000;
const credentials = { apiKey: 'fixture-key', apiSecret: 'fixture-secret' };
const core = ['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const permission = () => ({ enableReading: true, ...Object.fromEntries(core.map(key => [key, false])), enableFixApiTrade: false, enablePortfolioMarginTrading: false, enableFixReadOnly: true });
const binancePosition = (symbol, extra = {}) => ({ symbol, positionSide: 'BOTH', positionAmt: '2.500', entryPrice: '70.20', markPrice: '71.1', notional: '177.750', unRealizedProfit: '2.25', marginAsset: 'USDT', liquidationPrice: '0', updateTime: NOW - DAY, ...extra });
const bybitPosition = (symbol, extra = {}) => ({ symbol, positionIdx: 0, side: 'Sell', size: '2.500', avgPrice: '75.20', markPrice: '71.1', positionValue: '177.750', unrealisedPnl: '10.25', leverage: '2', liqPrice: '', updatedTime: String(NOW - DAY), ...extra });
const income = (symbol, time, extra = {}) => ({ symbol, incomeType: 'FUNDING_FEE', income: '0.1', asset: 'USDT', time, tranId: String(time), ...extra });
const settlement = (symbol, time, extra = {}) => ({ symbol, type: 'SETTLEMENT', category: 'linear', funding: '0.1', fee: '1000', cashFlow: '9000', change: '8000.1', currency: 'USDT', transactionTime: String(time), id: `${symbol}_${time}`, ...extra });
function json(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers }); }
function harness(exchange, handler, options = {}) {
  const calls = [];
  const client = createTradingExchangeClient(exchange, {
    now: () => NOW, ...options,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url); calls.push({ url: parsed, init });
      assert.equal(init.method, 'GET'); assert.equal(parsed.protocol, 'https:');
      assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
      assert.equal(init.body, undefined);
      const allowed = exchange === 'binance'
        ? { '/sapi/v1/account/apiRestrictions': 'api.binance.com', '/fapi/v3/positionRisk': 'fapi.binance.com', '/fapi/v1/income': 'fapi.binance.com', '/papi/v1/um/positionRisk': 'papi.binance.com', '/papi/v1/um/income': 'papi.binance.com' }
        : { '/v5/user/query-api': 'api.bybit.com', '/v5/account/info': 'api.bybit.com', '/v5/position/list': 'api.bybit.com', '/v5/account/transaction-log': 'api.bybit.com' };
      assert.equal(parsed.host, allowed[parsed.pathname]);
      if (exchange === 'binance') {
        const signature = parsed.searchParams.get('signature');
        parsed.searchParams.delete('signature');
        assert.equal(signature, createHmac('sha256', credentials.apiSecret).update(parsed.searchParams.toString()).digest('hex'));
        assert.equal(init.headers['X-MBX-APIKEY'], credentials.apiKey);
        assert.equal(parsed.searchParams.get('timestamp'), String(NOW));
      } else {
        assert.equal(init.headers['X-BAPI-API-KEY'], credentials.apiKey);
        assert.equal(init.headers['X-BAPI-SIGN'], createHmac('sha256', credentials.apiSecret).update(String(NOW) + credentials.apiKey + '5000' + parsed.searchParams.toString()).digest('hex'));
        if (parsed.pathname.endsWith('transaction-log')) {
          assert.ok(['CL', 'BZ'].includes(parsed.searchParams.get('baseCoin')));
          assert.equal(parsed.searchParams.has('symbol'), false);
        }
      }
      const result = await handler(parsed, init, calls);
      if (result instanceof Response) return result;
      if (result !== undefined) return exchange === 'bybit' ? json({ retCode: 0, result }) : json(result);
      if (parsed.pathname.endsWith('apiRestrictions')) return json(permission());
      if (parsed.pathname.endsWith('query-api')) return json({ retCode: 0, result: { readOnly: 1, apiKey: 'never-return-this', secret: '' } });
      if (parsed.pathname.endsWith('/info')) return json({ retCode: 0, result: { unifiedMarginStatus: 6 } });
      throw new Error('Unexpected fixture path');
    },
  });
  return { client, calls };
}
function healthy(exchange) {
  return harness(exchange, url => {
    const symbol = url.searchParams.get('symbol');
    if (url.pathname.endsWith('positionRisk')) return [binancePosition(symbol)];
    if (url.pathname.endsWith('position/list')) return { category: 'linear', list: [bybitPosition(symbol)], nextPageCursor: '' };
    if (url.pathname.endsWith('/income')) return [];
    if (url.pathname.endsWith('transaction-log')) return { list: [], nextPageCursor: '' };
  });
}

test('decimal arithmetic is exact, normalizes zeros, and bounds unsafe input', () => {
  assert.equal(addDecimals(['0.1', '0.2', '-0.05']), '0.25');
  assert.equal(addDecimals(['900719925474099312345.123456789012345678', '0.000000000000000001']), '900719925474099312345.123456789012345679');
  assert.equal(decimal('-000.000'), '0'); assert.equal(decimal('0001.2000'), '1.2');
  assert.equal(negateDecimal('-0'), '0'); assert.equal(negateDecimal('2.50'), '-2.5');
  assert.equal(compareDecimals('10.000', '9.99'), 1); assert.equal(compareDecimals('-1', '0'), -1); assert.equal(compareDecimals('1.00', '1'), 0);
  for (const value of ['', null, undefined, true, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1, '1e3', '+1', ' 1', '1.', '.1', '0.0000000000000000001', '1'.repeat(61)]) assert.throws(() => decimal(value));
  assert.throws(() => decimal('0', { positive: true })); assert.throws(() => decimal('-1', { nonnegative: true }));
});

for (const exchange of ['binance', 'bybit']) {
  test(`${exchange} verify checks read-only permission and probes both symbols plus ledger`, async () => {
    const { client, calls } = healthy(exchange);
    const result = await client.verify(credentials);
    assert.equal(result.fetchedAt, new Date(NOW).toISOString()); assert.equal(result.positions.length, 2);
    assert.deepEqual(result.positions.map(row => row.symbol), ['CLUSDT', 'BZUSDT']);
    assert.deepEqual(result.positions.map(row => row.quantity), ['2.5', '2.5']);
    assert.equal(result.positions[0].notional, '177.75'); assert.equal(result.positions[0].liquidationPrice, null);
    assert.equal(result.positions[0].sourceUpdatedAt, new Date(NOW - DAY).toISOString());
    assert.ok(calls.some(call => call.url.pathname.endsWith(exchange === 'binance' ? '/income' : 'transaction-log')));
    assert.ok(!JSON.stringify(result).includes('never-return-this'));
    assert.ok(calls.filter(call => call.url.pathname.endsWith(exchange === 'binance' ? '/income' : 'transaction-log')).every(call => call.url.searchParams.get('limit') === '1'));
    if (exchange === 'bybit') assert.deepEqual(calls.filter(call => call.url.pathname.endsWith('transaction-log')).map(call => call.url.searchParams.get('baseCoin')), ['CL', 'BZ']);
  });
}

test('Binance rejects missing, malformed, or enabled write permissions before business reads', async () => {
  const cases = [{ ...permission(), enableReading: 'true' }, { ...permission(), enableReading: undefined }];
  for (const field of core) for (const value of [true, undefined, 'false', 0]) cases.push({ ...permission(), [field]: value });
  for (const field of ['enableFixApiTrade', 'enablePortfolioMarginTrading']) cases.push({ ...permission(), [field]: true });
  for (const info of cases) {
    const { client, calls } = harness('binance', () => info);
    await assert.rejects(client.verify(credentials), error => error instanceof TradingExchangeError && error.code === 'permissions');
    assert.equal(calls.length, 1);
  }
  const { client } = harness('binance', url => {
    if (url.pathname.endsWith('apiRestrictions')) { const info = permission(); delete info.enableFixApiTrade; delete info.enablePortfolioMarginTrading; return info; }
    if (url.pathname.endsWith('positionRisk')) return [];
  });
  assert.deepEqual((await client.positions(credentials)).positions, []);
});

test('Bybit requires numeric readOnly 1 and an explicitly unified account', async () => {
  for (const readOnly of [undefined, 0, true, '1', null]) {
    const { client, calls } = harness('bybit', () => ({ readOnly }));
    await assert.rejects(client.verify(credentials), /只读/); assert.equal(calls.length, 1);
  }
  for (const unifiedMarginStatus of [1, undefined, '6', 7]) {
    const { client, calls } = harness('bybit', url => url.pathname.endsWith('/info') ? { unifiedMarginStatus } : undefined);
    await assert.rejects(client.verify(credentials), /统一交易账户/); assert.equal(calls.length, 2);
  }
});

test('permissions are rechecked on later position and funding refreshes', async () => {
  const { client, calls } = harness('binance', () => ({ ...permission(), enableFutures: true }));
  await assert.rejects(client.positions(credentials), /只读/);
  const funding = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(funding.complete, false); assert.match(funding.error, /只读/); assert.deepEqual(funding.events, []); assert.deepEqual(funding.coverage, []); assert.equal(calls.length, 2);
});

test('Binance preserves hedge sides and signed position direction while using absolute notional', async () => {
  const { client } = harness('binance', url => url.pathname.endsWith('positionRisk') ? (url.searchParams.get('symbol') === 'CLUSDT' ? [binancePosition('CLUSDT', { positionSide: 'LONG', positionAmt: '1', notional: '71.1' }), binancePosition('CLUSDT', { positionSide: 'SHORT', positionAmt: '-2', notional: '-142.2' })] : [binancePosition('BZUSDT', { positionAmt: '0' })]) : undefined);
  const rows = (await client.positions(credentials)).positions;
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.side), ['long', 'short']); assert.deepEqual(rows.map(row => row.mode), ['hedge', 'hedge']); assert.equal(rows[1].quantity, '2'); assert.equal(rows[1].notional, '142.2');
});

test('Bybit symbol requests paginate with exact encoded signatures and keep both hedge sides', async () => {
  const { client, calls } = harness('bybit', url => {
    if (!url.pathname.endsWith('position/list')) return;
    assert.equal(url.searchParams.get('category'), 'linear');
    const symbol = url.searchParams.get('symbol');
    if (symbol === 'BZUSDT') return { category: 'linear', list: [bybitPosition(symbol, { size: '0', side: '' })], nextPageCursor: '' };
    if (!url.searchParams.get('cursor')) return { category: 'linear', list: [bybitPosition(symbol, { positionIdx: 1, side: 'Buy' })], nextPageCursor: 'opaque%3A1,2/+=' };
    assert.equal(url.searchParams.get('cursor'), 'opaque%3A1,2/+=');
    return { category: 'linear', list: [bybitPosition(symbol, { positionIdx: 2, side: 'Sell' })], nextPageCursor: '' };
  });
  const rows = (await client.positions(credentials)).positions;
  assert.deepEqual(rows.map(row => row.side), ['long', 'short']); assert.deepEqual(rows.map(row => row.mode), ['hedge', 'hedge']); assert.equal(calls.filter(call => call.url.pathname.endsWith('position/list')).length, 3);
});

test('wrong position identities, modes, currencies, malformed amounts and missing second symbol reject snapshot', async () => {
  const cases = [binancePosition('BTCUSDT'), binancePosition('CLUSDT', { positionSide: 'SHORT' }), binancePosition('CLUSDT', { marginAsset: 'USDC' }), binancePosition('CLUSDT', { positionAmt: '' }), binancePosition('CLUSDT', { entryPrice: 'NaN' })];
  for (const row of cases) {
    const { client } = harness('binance', url => url.pathname.endsWith('positionRisk') ? [row] : undefined);
    await assert.rejects(client.positions(credentials), TradingExchangeError);
  }
  for (const extra of [{ positionIdx: 2, side: 'Buy' }, { positionIdx: '0' }, { size: '-1' }, { symbol: 'BTCUSDT' }]) {
    const { client } = harness('bybit', url => url.pathname.endsWith('position/list') ? { category: 'linear', list: [bybitPosition('CLUSDT', extra)] } : undefined);
    await assert.rejects(client.positions(credentials), TradingExchangeError);
  }
  const { client } = harness('binance', url => url.pathname.endsWith('positionRisk') ? (url.searchParams.get('symbol') === 'CLUSDT' ? [binancePosition('CLUSDT')] : json({}, 503)) : undefined);
  await assert.rejects(client.positions(credentials), /503/);
});

test('Bybit uses funding sign unchanged and ignores cashFlow, fee, change and other symbols', async () => {
  const { client, calls } = harness('bybit', url => {
    if (!url.pathname.endsWith('transaction-log')) return;
    const row = url.searchParams.get('baseCoin') === 'CL' ? settlement('CLUSDT', NOW - 100, { funding: '0.125' }) : settlement('BZUSDT', NOW - 99, { funding: '-0.025' });
    return { list: [row, settlement('BTCUSDT', NOW - 98, { funding: '9999' })], nextPageCursor: '' };
  });
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(result.complete, true); assert.equal(addDecimals(result.events.map(row => row.amount)), '0.1');
  assert.deepEqual(result.events.map(row => row.amount), ['0.125', '-0.025']); assert.deepEqual(result.coverage, [{ start: NOW - DAY, end: NOW }]);
  const query = calls.find(call => call.url.pathname.endsWith('transaction-log')).url.searchParams;
  assert.equal(query.get('type'), 'SETTLEMENT'); assert.equal(query.get('symbol'), null); assert.equal(query.get('endTime'), String(NOW - 1));
  assert.deepEqual(calls.filter(call => call.url.pathname.endsWith('transaction-log')).map(call => call.url.searchParams.get('baseCoin')), ['CL', 'BZ']);
});

test('Binance keeps large int64 ids losslessly and separates symbol identities', async () => {
  const id = '9223372036854775806';
  const { client } = harness('binance', url => {
    if (!url.pathname.endsWith('/income')) return;
    return new Response(`[{"symbol":"${url.searchParams.get('symbol')}","incomeType":"FUNDING_FEE","income":"-0.001234567890123456","asset":"USDT","time":${NOW - 1},"tranId":${id}}]`);
  });
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(result.complete, true); assert.equal(result.events.length, 2); assert.ok(result.events.every(row => row.id.endsWith(id))); assert.equal(addDecimals(result.events.map(row => row.amount)), '-0.002469135780246912');
});

test('Binance reads every full page and deduplicates overlap without losing later records', async () => {
  const start = NOW - DAY;
  const rows = Array.from({ length: 1000 }, (_, index) => income('CLUSDT', start + index, { tranId: String(index) }));
  const { client, calls } = harness('binance', url => {
    if (!url.pathname.endsWith('/income')) return;
    if (url.searchParams.get('symbol') === 'BZUSDT') return [];
    return url.searchParams.get('page') === '1' ? rows : [rows.at(-1), income('CLUSDT', start + 1000, { tranId: '1000' })];
  });
  const result = await client.funding(credentials, { start, end: NOW });
  assert.equal(result.complete, true); assert.equal(result.events.length, 1001); assert.equal(addDecimals(result.events.map(row => row.amount)), '100.1'); assert.equal(calls.filter(call => call.url.pathname.endsWith('/income')).length, 3);
});

test('Bybit funding follows cursor, deduplicates in-window records and separates adjacent boundaries', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  const first = settlement('CLUSDT', start, { funding: '0.5' });
  const second = settlement('BZUSDT', boundary - 1, { funding: '-0.2' });
  const third = settlement('CLUSDT', boundary, { funding: '0.1' });
  const { client, calls } = harness('bybit', url => {
    if (!url.pathname.endsWith('transaction-log')) return;
    assert.ok(Number(url.searchParams.get('endTime')) - Number(url.searchParams.get('startTime')) < 7 * DAY);
    if (url.searchParams.get('baseCoin') === 'BZ') return { list: Number(url.searchParams.get('startTime')) === boundary ? [] : [second], nextPageCursor: '' };
    if (Number(url.searchParams.get('startTime')) === boundary) return { list: [third, third], nextPageCursor: '' };
    return url.searchParams.has('cursor') ? { list: [first, first], nextPageCursor: '' } : { list: [first], nextPageCursor: 'abc%3A/+=1' };
  });
  const result = await client.funding(credentials, { start, end: NOW });
  assert.equal(result.complete, true); assert.equal(result.events.length, 3); assert.equal(addDecimals(result.events.map(row => row.amount)), '0.4'); assert.deepEqual(result.coverage, [{ start, end: boundary }, { start: boundary, end: NOW }]); assert.equal(calls.filter(call => call.url.pathname.endsWith('transaction-log')).length, 5);
});

test('ledger records from the next window cannot establish current-window coverage', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  for (const exchange of ['binance', 'bybit']) {
    for (const time of [boundary, boundary + 1, NOW]) {
      const { client } = harness(exchange, url => {
        if (url.pathname.endsWith('/income')) return [income(url.searchParams.get('symbol'), time)];
        if (url.pathname.endsWith('transaction-log')) return { list: [settlement('CLUSDT', time)], nextPageCursor: '' };
      });
      const result = await client.funding(credentials, { start, end: NOW });
      assert.equal(result.complete, false); assert.match(result.error, /超出请求时间范围/);
      assert.deepEqual(result.coverage, []); assert.deepEqual(result.events, []);
    }
  }
});

test('old boundary duplicates reject the later window while preserving prior complete coverage', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  for (const exchange of ['binance', 'bybit']) {
    const { client } = harness(exchange, url => {
      if (url.pathname.endsWith('/income')) return [income(url.searchParams.get('symbol'), boundary - 1)];
      if (url.pathname.endsWith('transaction-log')) return { list: url.searchParams.get('baseCoin') === 'CL' ? [settlement('CLUSDT', boundary - 1)] : [], nextPageCursor: '' };
    });
    const result = await client.funding(credentials, { start, end: NOW });
    assert.equal(result.complete, false); assert.match(result.error, /超出请求时间范围/);
    assert.deepEqual(result.coverage, [{ start, end: boundary }]);
    assert.equal(result.events.length, exchange === 'binance' ? 2 : 1);
  }
});

test('Bybit checks window timestamps before excluding unrelated symbols', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  for (const time of [start - 1, boundary, NOW]) {
    const { client } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [settlement('BTCUSDT', time)], nextPageCursor: '' } : undefined);
    const result = await client.funding(credentials, { start, end: NOW });
    assert.equal(result.complete, false); assert.match(result.error, /超出请求时间范围/); assert.deepEqual(result.coverage, []); assert.deepEqual(result.events, []);
  }
});

test('ledger failures retain collected receipts but only cover fully completed windows', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  const { client } = harness('binance', url => {
    if (!url.pathname.endsWith('/income')) return;
    const time = Number(url.searchParams.get('startTime')), symbol = url.searchParams.get('symbol');
    if (time === boundary && symbol === 'BZUSDT') return json({ privateMessage: credentials.apiSecret }, 503);
    return [income(symbol, time, { tranId: `${symbol}_${time}` })];
  });
  const result = await client.funding(credentials, { start, end: NOW });
  assert.equal(result.complete, false); assert.equal(result.events.length, 3); assert.deepEqual(result.coverage, [{ start, end: boundary }]); assert.match(result.error, /503/); assert.ok(!result.error.includes(credentials.apiSecret));
});

test('conflicting duplicate ledger ids and unexpected oil currencies prevent completeness', async () => {
  for (const rows of [[settlement('CLUSDT', NOW - 1), settlement('CLUSDT', NOW - 1, { funding: '99' })], [settlement('CLUSDT', NOW - 1, { currency: 'USDC' })], [settlement('CLUSDT', NOW - 1, { funding: '' })], [settlement('CLUSDT', NOW - 1, { type: 'TRADE' })]]) {
    const { client } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: rows, nextPageCursor: '' } : undefined);
    const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
    assert.equal(result.complete, false); assert.deepEqual(result.coverage, []); assert.ok(result.error);
  }
});

test('repeated cursor and repeated full page terminate with partial state', async () => {
  let page = 0;
  const { client, calls } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [settlement('CLUSDT', NOW - ++page)], nextPageCursor: 'same' } : undefined);
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(result.complete, false); assert.match(result.error, /分页/); assert.equal(calls.length, 4);
  const rows = Array.from({ length: 1000 }, (_, index) => income('CLUSDT', NOW - DAY + index, { tranId: String(index) }));
  const second = harness('binance', url => url.pathname.endsWith('/income') ? rows : undefined);
  const repeated = await second.client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(repeated.complete, false); assert.equal(second.calls.length, 3);
});

test('request budget bounds changing Bybit pages without inventing completeness', async () => {
  let page = 0;
  const { client, calls } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [settlement('CLUSDT', NOW - ++page)], nextPageCursor: `page-${page}` } : undefined);
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(result.complete, false); assert.match(result.error, /上限/); assert.equal(calls.length, 240); assert.deepEqual(result.coverage, []);
});

test('empty ledgers and flat positions are valid only after successful reads', async () => {
  for (const exchange of ['binance', 'bybit']) {
    const { client } = harness(exchange, url => {
      if (url.pathname.endsWith('positionRisk')) return [];
      if (url.pathname.endsWith('position/list')) return { category: 'linear', list: [], nextPageCursor: '' };
      if (url.pathname.endsWith('/income')) return [];
      if (url.pathname.endsWith('transaction-log')) return { list: [], nextPageCursor: '' };
    });
    assert.deepEqual((await client.verify(credentials)).positions, []);
    const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
    assert.equal(result.complete, true); assert.deepEqual(result.events, []); assert.equal(result.coverage.length, 1);
  }
});

test('no arbitrary host, path, method or secret-bearing upstream errors escape', async () => {
  assert.throws(() => createTradingExchangeClient('https://evil.example'), TradingExchangeError);
  assert.throws(() => createTradingExchangeClient('constructor'), TradingExchangeError);
  const sensitive = `${credentials.apiKey} ${credentials.apiSecret} https://api.binance.com/?signature=private`;
  for (const response of [() => { throw new Error(sensitive); }, () => new Response(sensitive), () => json({ code: -2015, msg: sensitive }), () => new Response('', { status: 302, headers: { location: 'https://evil.example' } })]) {
    const { client, calls } = harness('binance', response);
    await assert.rejects(client.verify(credentials), error => error instanceof TradingExchangeError && !error.message.includes('fixture') && !error.message.includes('signature=') && !error.message.includes('evil.example'));
    assert.equal(calls.length, 1);
  }
});

test('response body bounds apply with and without content-length', async () => {
  for (const response of [() => new Response('{}', { headers: { 'content-length': '9999999' } }), () => new Response(' '.repeat(2 * 1024 * 1024 + 1))]) {
    const { client } = harness('binance', response);
    await assert.rejects(client.verify(credentials), /大小限制/);
  }
});

test('abort propagates AbortError while timeout is a sanitized exchange error', async () => {
  const aborted = new AbortController(); aborted.abort(new Error(credentials.apiSecret));
  const { client, calls } = healthy('binance');
  await assert.rejects(client.verify(credentials, { signal: aborted.signal }), error => error.name === 'AbortError' && !error.message.includes(credentials.apiSecret));
  await assert.rejects(client.funding(credentials, { start: NOW - DAY, end: NOW, signal: aborted.signal }), { name: 'AbortError' }); assert.equal(calls.length, 0);
  const slow = createTradingExchangeClient('binance', { now: () => NOW, timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(credentials.apiSecret)), { once: true })) });
  await assert.rejects(slow.verify(credentials), error => error instanceof TradingExchangeError && error.code === 'timeout' && !error.message.includes(credentials.apiSecret));
  const controller = new AbortController();
  const midway = harness('bybit', (url, _init) => {
    if (url.pathname.endsWith('transaction-log')) { controller.abort(); return { list: [], nextPageCursor: '' }; }
  });
  await assert.rejects(midway.client.funding(credentials, { start: NOW - DAY, end: NOW, signal: controller.signal }), { name: 'AbortError' });
});

test('deadline bounds uncooperative transports and hanging response bodies', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), () => Promise.resolve(new Response(new ReadableStream({ start() {} })))]) {
    const client = createTradingExchangeClient('binance', { now: () => NOW, timeoutMs: 10, fetchImpl });
    const start = Date.now();
    await assert.rejects(client.verify(credentials), error => error instanceof TradingExchangeError && error.code === 'timeout');
    assert.ok(Date.now() - start < 500);
  }
});

test('missing ledger symbol and inconsistent position modes cannot produce a complete snapshot', async () => {
  const malformed = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [settlement(undefined, NOW - 1)], nextPageCursor: '' } : undefined);
  const ledger = await malformed.client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(ledger.complete, false); assert.deepEqual(ledger.coverage, []);
  const mixed = harness('binance', url => url.pathname.endsWith('positionRisk') ? [binancePosition('CLUSDT'), binancePosition('CLUSDT', { positionSide: 'LONG' })] : undefined);
  await assert.rejects(mixed.client.positions(credentials), /模式存在冲突/);
});

test('invalid credentials and out-of-policy ranges never send an HTTP request', async () => {
  let calls = 0;
  const client = createTradingExchangeClient('binance', { now: () => NOW, fetchImpl: () => { calls++; throw new Error('must not run'); } });
  for (const invalid of [{ apiKey: '', apiSecret: 'a' }, { apiKey: 'key\nvalue', apiSecret: 'a' }, { apiKey: 'a', apiSecret: '' }, null]) await assert.rejects(client.verify(invalid), /无效或为空/);
  for (const interval of [{ start: NOW, end: NOW }, { start: NOW - 31 * DAY, end: NOW }, { start: -1, end: 1 }, { start: NOW - DAY, end: Infinity }]) await assert.rejects(client.funding(credentials, interval), /时间范围/);
  assert.equal(calls, 0);
});

test('Portfolio Margin verifies and refreshes using only signed PAPI UM reads after the SAPI permission check', async () => {
  const options = { accountMode: 'portfolio-margin' };
  const { client, calls } = harness('binance', url => {
    const symbol = url.searchParams.get('symbol');
    if (url.pathname === '/papi/v1/um/positionRisk') {
      const row = binancePosition(symbol, { positionSide: 'SHORT', positionAmt: '-2.5', leverage: '10' });
      delete row.marginAsset;
      return [row];
    }
    if (url.pathname === '/papi/v1/um/income') return [income(symbol, Number(url.searchParams.get('endTime')), { income: '-0.0123' })];
  });
  const verified = await client.verify(credentials, options);
  assert.equal(verified.positions.length, 2);
  assert.equal(verified.positions[0].side, 'short'); assert.equal(verified.positions[0].quantity, '2.5');
  assert.equal(verified.positions[0].leverage, '10'); assert.equal(verified.positions[0].notional, '177.75');
  assert.deepEqual((await client.positions(credentials, options)).positions, verified.positions);
  const ledger = await client.funding(credentials, { ...options, start: NOW - DAY, end: NOW });
  assert.equal(ledger.complete, true); assert.equal(ledger.events.length, 2);
  assert.ok(ledger.events.every(row => row.amount === '-0.0123' && row.currency === 'USDT'));
  assert.equal(ledger.coverage.length, 1);
  assert.ok(calls.every(({ url }) => url.hostname === 'api.binance.com' || url.hostname === 'papi.binance.com'));
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith('apiRestrictions')).length, 3);
});

test('Portfolio Margin preserves ordinary USDT validation and rejects a conflicting explicit asset', async () => {
  for (const [accountMode, marginAsset] of [['standard', undefined], ['portfolio-margin', 'USDC']]) {
    const { client } = harness('binance', url => url.pathname.endsWith('positionRisk') ? [binancePosition(url.searchParams.get('symbol'), { marginAsset })] : undefined);
    await assert.rejects(client.positions(credentials, { accountMode }), { code: 'invalid_data' });
  }
  const { client } = harness('binance', url => url.pathname.endsWith('positionRisk') ? [binancePosition(url.searchParams.get('symbol'), { marginAsset: undefined, notional: undefined, liquidationPrice: undefined })] : undefined);
  const result = await client.positions(credentials, { accountMode: 'portfolio-margin' });
  assert.equal(result.positions[0].notional, null); assert.equal(result.positions[0].liquidationPrice, null);
});

test('Portfolio Margin funding pages and seven-day windows keep one API family and exact transaction IDs', async () => {
  const { client, calls } = harness('binance', url => {
    if (url.pathname !== '/papi/v1/um/income') return;
    const symbol = url.searchParams.get('symbol'), start = Number(url.searchParams.get('startTime'));
    const page = Number(url.searchParams.get('page'));
    if (symbol === 'CLUSDT' && start === NOW - 8 * DAY && page === 1) return Array.from({ length: 1000 }, (_, index) => income(symbol, start + index, { tranId: String(9007199254740993000n + BigInt(index)) }));
    return [income(symbol, start + 1001, { tranId: `${symbol}-${start}-${page}` })];
  });
  const result = await client.funding(credentials, { accountMode: 'portfolio-margin', start: NOW - 8 * DAY, end: NOW });
  assert.equal(result.complete, true); assert.equal(result.coverage.length, 2); assert.equal(result.events.length, 1004);
  assert.ok(result.events.some(row => row.id.endsWith('9007199254740993001')));
  assert.ok(calls.some(({ url }) => url.searchParams.get('page') === '2'));
  assert.ok(calls.every(({ url }) => !url.pathname.startsWith('/fapi')));
});

test('Portfolio Margin rejects write-enabled keys before any PAPI request and never falls back after a 401', async () => {
  for (const field of [...core, 'enablePortfolioMarginTrading', 'enableFixApiTrade']) {
    const { client, calls } = harness('binance', () => ({ ...permission(), [field]: true }));
    await assert.rejects(client.verify(credentials, { accountMode: 'portfolio-margin' }), { code: 'permissions' });
    assert.equal(calls.length, 1);
  }
  for (const operation of ['positions', 'funding']) {
    const { client, calls } = harness('binance', url => url.hostname === 'papi.binance.com' ? json({ code: -2015, msg: 'fixture-secret signature=private' }, 401) : undefined);
    const options = { accountMode: 'portfolio-margin', start: NOW - DAY, end: NOW };
    const expected = /Binance 组合保证金(?:仓位|资金费)读取失败（HTTP 401，Binance -2015）/;
    if (operation === 'positions') await assert.rejects(client.positions(credentials, options), error => expected.test(error.message) && !error.message.includes('private'));
    else {
      const result = await client.funding(credentials, options);
      assert.equal(result.complete, false); assert.deepEqual(result.coverage, []); assert.match(result.error, expected);
    }
    assert.equal(calls.length, 2); assert.ok(calls.every(({ url }) => url.hostname !== 'fapi.binance.com'));
  }
});

test('HTTP diagnostics retain only safe numeric codes and operation labels, with bounded error bodies', async () => {
  const secret = 'fixture-secret signature=private https://private.invalid';
  for (const data of [{ code: -2015, msg: secret }, { code: secret, msg: secret }, { code: Number.MAX_SAFE_INTEGER + 1 }, { code: { value: secret } }]) {
    const { client } = harness('binance', () => json(data, 401));
    await assert.rejects(client.verify(credentials), error => error.code === 'http' && error.message.includes('只读权限检查失败（HTTP 401') && error.message.includes('Binance -2015') === (data.code === -2015) && !/fixture|signature|private/.test(error.message));
  }
  const html = harness('binance', () => new Response(secret, { status: 502 }));
  await assert.rejects(html.client.verify(credentials), error => error.code === 'http' && error.message.includes('HTTP 502') && !error.message.includes(secret));
  for (const headers of [{ 'content-length': '99999999' }, {}]) {
    const large = harness('binance', () => new Response(' '.repeat(2 * 1024 * 1024 + 1), { status: 401, headers }));
    await assert.rejects(large.client.verify(credentials), { code: 'response_limit' });
  }
  const hanging = createTradingExchangeClient('binance', { now: () => NOW, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 401 }) });
  await assert.rejects(hanging.verify(credentials), { code: 'timeout' });
});

test('account mode is validated before HTTP and remains request-local on a shared client', async () => {
  const { client, calls } = healthy('binance');
  for (const accountMode of [null, '', 'unified', 'https://evil.invalid', {}, 'constructor']) {
    for (const operation of ['verify', 'positions', 'funding']) await assert.rejects(client[operation](credentials, { accountMode, start: NOW - DAY, end: NOW }), { code: 'account_mode' });
  }
  assert.equal(calls.length, 0);
  await Promise.all([client.positions(credentials, { accountMode: 'portfolio-margin' }), client.positions(credentials, { accountMode: 'standard' })]);
  assert.equal(calls.filter(({ url }) => url.hostname === 'papi.binance.com').length, 2);
  assert.equal(calls.filter(({ url }) => url.hostname === 'fapi.binance.com').length, 2);
});

test('Bybit verification requires successful funding probes for both base coins', async () => {
  const { client, calls } = harness('bybit', url => {
    if (url.pathname.endsWith('position/list')) return { category: 'linear', list: [], nextPageCursor: '' };
    if (!url.pathname.endsWith('transaction-log')) return;
    assert.equal(url.searchParams.get('limit'), '1');
    return url.searchParams.get('baseCoin') === 'CL' ? { list: [], nextPageCursor: '' } : json({ retCode: 10005, retMsg: credentials.apiSecret }, 403);
  });
  await assert.rejects(client.verify(credentials), error => {
    assert.deepEqual(error.diagnostic, { version: 1, exchange: 'bybit', operation: 'funding', accountMode: 'unified', code: 'http', httpStatus: 403, providerCode: 10005 });
    assert.equal(error.message, formatTradingDiagnostic(error.diagnostic));
    assert.ok(!JSON.stringify(error).includes(credentials.apiSecret));
    return true;
  });
  assert.deepEqual(calls.filter(call => call.url.pathname.endsWith('transaction-log')).map(call => call.url.searchParams.get('baseCoin')), ['CL', 'BZ']);
});

test('Bybit does not cover a window until both base coins finish every page', async () => {
  const progress = [];
  const { client, calls } = harness('bybit', url => {
    if (!url.pathname.endsWith('transaction-log')) return;
    assert.equal(url.searchParams.get('limit'), '50');
    const baseCoin = url.searchParams.get('baseCoin');
    if (url.searchParams.has('cursor')) return json({ retCode: 10006, retMsg: `${credentials.apiSecret} signed-url` }, 429);
    return { list: [settlement(baseCoin + 'USDT', NOW - 1)], nextPageCursor: baseCoin === 'BZ' ? 'BZ/next%+' : '' };
  });
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW, onProgress: value => progress.push(value) });
  assert.equal(result.complete, false); assert.equal(result.events.length, 2);
  assert.deepEqual(result.coverage, []); assert.deepEqual(progress, []);
  assert.deepEqual(calls.filter(call => call.url.pathname.endsWith('transaction-log')).map(call => [call.url.searchParams.get('baseCoin'), call.url.searchParams.get('cursor')]), [['CL', null], ['BZ', null], ['BZ', 'BZ/next%+']]);
  assert.deepEqual(result.diagnostic, { version: 1, exchange: 'bybit', operation: 'funding', accountMode: 'unified', code: 'http', httpStatus: 429, providerCode: 10006 });
  assert.equal(result.error, formatTradingDiagnostic(result.diagnostic));
  assert.ok(!JSON.stringify(result).includes(credentials.apiSecret));
});

test('Bybit rejects another oil symbol returned for the selected base coin', async () => {
  const { client } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [settlement('BZUSDT', NOW - 1)], nextPageCursor: '' } : undefined);
  const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
  assert.equal(result.complete, false); assert.deepEqual(result.coverage, []); assert.deepEqual(result.events, []);
  assert.equal(result.diagnostic.code, 'invalid_data');
});

test('funding awaits cumulative completed-window progress and isolates callback snapshots', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY;
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const firstProgress = new Promise(resolve => { reached = resolve; });
  const progress = [];
  const { client, calls } = harness('bybit', url => {
    if (!url.pathname.endsWith('transaction-log')) return;
    const from = Number(url.searchParams.get('startTime'));
    return { list: [settlement(url.searchParams.get('baseCoin') + 'USDT', from)], nextPageCursor: '' };
  });
  const pending = client.funding(credentials, { start, end: NOW, onProgress: async snapshot => {
    progress.push(structuredClone(snapshot));
    if (progress.length === 1) {
      snapshot.events[0].amount = '999'; snapshot.coverage[0].start = start - 1;
      reached(); await gate;
    }
  } });
  await firstProgress;
  assert.deepEqual(calls.filter(call => call.url.pathname.endsWith('transaction-log')).map(call => Number(call.url.searchParams.get('startTime'))), [start, start]);
  assert.equal(progress[0].events.length, 2);
  assert.deepEqual(progress[0].coverage, [{ start, end: boundary }]);
  assert.equal(progress[0].complete, false); assert.equal(progress[0].error, null); assert.equal(progress[0].diagnostic, null);
  release();
  const result = await pending;
  assert.equal(progress.length, 2); assert.equal(progress[1].events.length, 4);
  assert.deepEqual(progress[1].coverage, [{ start, end: boundary }, { start: boundary, end: NOW }]);
  assert.equal(result.complete, true); assert.equal(result.diagnostic, null);
  assert.equal(addDecimals(result.events.map(row => row.amount)), '0.4');
  assert.deepEqual(result.coverage, progress[1].coverage);
});

test('completed-window progress survives a later failure without marking the next window complete', async () => {
  const start = NOW - 8 * DAY, boundary = start + 7 * DAY, progress = [];
  const { client } = harness('bybit', url => {
    if (!url.pathname.endsWith('transaction-log')) return;
    const from = Number(url.searchParams.get('startTime'));
    if (from === boundary && url.searchParams.get('baseCoin') === 'BZ') return json({ retCode: 10016, retMsg: credentials.apiSecret }, 503);
    return { list: [settlement(url.searchParams.get('baseCoin') + 'USDT', from)], nextPageCursor: '' };
  });
  const result = await client.funding(credentials, { start, end: NOW, onProgress: snapshot => progress.push(snapshot) });
  assert.equal(progress.length, 1); assert.equal(progress[0].events.length, 2);
  assert.equal(result.complete, false); assert.equal(result.events.length, 3);
  assert.deepEqual(result.coverage, [{ start, end: boundary }]);
  assert.deepEqual(result.diagnostic, { version: 1, exchange: 'bybit', operation: 'funding', accountMode: 'unified', code: 'http', httpStatus: 503, providerCode: 10016 });
  assert.ok(!JSON.stringify(result).includes(credentials.apiSecret));
});

test('abort during an awaited funding progress callback prevents further requests', async () => {
  const controller = new AbortController();
  let reached, release;
  const reachedProgress = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { client, calls } = harness('bybit', url => url.pathname.endsWith('transaction-log') ? { list: [], nextPageCursor: '' } : undefined);
  const pending = client.funding(credentials, { start: NOW - 8 * DAY, end: NOW, signal: controller.signal, onProgress: async () => { reached(); await gate; } });
  await reachedProgress;
  controller.abort(new Error(credentials.apiSecret)); release();
  await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes(credentials.apiSecret));
  assert.equal(calls.filter(call => call.url.pathname.endsWith('transaction-log')).length, 2);
});

test('trading diagnostics persist only enumerated metadata and numeric provider codes', () => {
  const valid = { version: 1, exchange: 'bybit', operation: 'funding', accountMode: 'unified', code: 'http', httpStatus: 401, providerCode: 10005 };
  const tainted = { ...valid, message: credentials.apiSecret, url: 'https://private.invalid?signature=private', headers: { key: credentials.apiKey } };
  assert.deepEqual(normalizeTradingDiagnostic(tainted), valid);
  assert.equal(formatTradingDiagnostic(JSON.parse(JSON.stringify(tainted))), 'Bybit 资金费读取失败（HTTP 401，Bybit 10005），请检查账户模式、API 读取权限、IP 白名单与服务器时间');
  for (const invalid of [null, [], {}, { ...valid, version: 2 }, { ...valid, exchange: 'constructor' }, { ...valid, operation: { toString: 0 } }, { ...valid, operation: credentials.apiSecret }, { ...valid, accountMode: 'portfolio-margin' }, { ...valid, code: credentials.apiSecret }]) {
    assert.equal(normalizeTradingDiagnostic(invalid), null); assert.equal(formatTradingDiagnostic(invalid), null);
  }
  for (const optional of [{ httpStatus: 99, providerCode: credentials.apiSecret }, { httpStatus: 600, providerCode: Number.MAX_SAFE_INTEGER + 1 }, { httpStatus: '401', providerCode: {} }]) {
    assert.deepEqual(normalizeTradingDiagnostic({ ...valid, ...optional }), { version: 1, exchange: 'bybit', operation: 'funding', accountMode: 'unified', code: 'http' });
  }
});

test('funding diagnostics retain permission, currency, range and pagination failure categories', async () => {
  const cases = [
    { code: 'permissions', operation: 'permissions', handler: () => ({ readOnly: 0 }) },
    { code: 'currency', operation: 'funding', handler: url => url.pathname.endsWith('transaction-log') ? { list: [settlement('CLUSDT', NOW - 1, { currency: 'USDC' })], nextPageCursor: '' } : undefined },
    { code: 'window_range', operation: 'funding', handler: url => url.pathname.endsWith('transaction-log') ? { list: [settlement('CLUSDT', NOW)], nextPageCursor: '' } : undefined },
    { code: 'pagination', operation: 'funding', handler: url => url.pathname.endsWith('transaction-log') ? { list: [settlement('CLUSDT', NOW - 1)], nextPageCursor: 'repeat' } : undefined },
  ];
  for (const { code, operation, handler } of cases) {
    const { client } = harness('bybit', handler);
    const result = await client.funding(credentials, { start: NOW - DAY, end: NOW });
    assert.equal(result.complete, false); assert.deepEqual(result.coverage, []);
    assert.deepEqual(result.diagnostic, { version: 1, exchange: 'bybit', operation, accountMode: 'unified', code });
    assert.equal(result.error, formatTradingDiagnostic(result.diagnostic));
  }
});

test('funding uses the exported record cap and never marks a capped window complete', async () => {
  const start = NOW - DAY;
  const { client } = harness('binance', url => {
    if (!url.pathname.endsWith('/income')) return;
    const page = Number(url.searchParams.get('page'));
    return Array.from({ length: 1000 }, (_, index) => income('CLUSDT', start + (page - 1) * 1000 + index));
  });
  const result = await client.funding(credentials, { start, end: NOW });
  assert.equal(MAX_FUNDING_EVENTS, 50_000); assert.equal(result.events.length, MAX_FUNDING_EVENTS);
  assert.equal(result.complete, false); assert.deepEqual(result.coverage, []); assert.equal(result.diagnostic.code, 'record_limit');
});

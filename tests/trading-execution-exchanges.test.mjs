import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createExecutionExchangeClient, ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const credentials = Object.freeze({ apiKey: 'fixture-execution-key', apiSecret: 'fixture-execution-secret' });
const STRATEGY = '119b6211-2611-461b-be5e-5ac557099e82';
const CHILD = 'd67e97b1-7a6e-4a89-b9d7-098756e8b86f';
const ORDER = '9223372036854775806';
const spec = Object.freeze({ symbol: 'CLUSDT', side: 'buy', positionSide: 'BOTH', quantity: '2', reduceOnly: false, clientId: 'execution_fixture_001', stopPrice: '90' });
const binancePermission = (portfolio = false) => ({ enableReading: true, enableWithdrawals: false, enableInternalTransfer: false,
  permitsUniversalTransfer: false, enableMargin: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false,
  enableFutures: !portfolio, enablePortfolioMarginTrading: portfolio, enableFixApiTrade: false });
const bybitPermission = () => ({ readOnly: 0, userID: '1234567890123456789', apiKey: 'must-not-be-returned', secret: '',
  permissions: { ContractTrade: ['Order', 'Position'], Derivatives: ['DerivativesTrade'], Wallet: [], Spot: [], Options: [], Earn: [] } });
const binanceOrder = (overrides = {}) => ({ orderId: ORDER, symbol: 'CLUSDT', clientOrderId: spec.clientId,
  side: 'BUY', positionSide: 'BOTH', origQty: '2', executedQty: '0', price: '80', avgPrice: '0', reduceOnly: false,
  status: 'NEW', type: 'LIMIT', timeInForce: 'GTX', time: NOW, ...overrides });
const strategy = (overrides = {}) => ({ strategyId: STRATEGY, category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Buy',
  size: '2', executedSize: '0', strategyType: 'chaseOrder', status: 2, reduceOnly: false, createdTimeE3: String(NOW),
  updatedTimeE3: String(NOW), chaseOrderPrice: '80', executedAvgPrice: '0', ...overrides });
const child = (overrides = {}) => ({ strategyId: STRATEGY, orderId: CHILD, symbol: 'CLUSDT', side: 'Buy', category: 'UTA_USDT',
  size: '2', executedSize: '0', status: '2', orderType: 2, positionIdx: 0, parentOrderId: '', ...overrides });
const bybitRule = symbol => ({ symbol, status: 'Trading', contractType: 'LinearPerpetual', quoteCoin: 'USDT', settleCoin: 'USDT', unifiedMarginTrade: true,
  priceFilter: { tickSize: '0.01', minPrice: '0.01', maxPrice: '10000' },
  lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '1', minNotionalValue: '5' } });
const binanceRule = symbol => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT',
  pricePrecision: 9, quantityPrecision: 6, orderTypes: ['LIMIT', 'MARKET'], timeInForce: ['GTC', 'GTX'],
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '10000' },
    { filterType: 'LOT_SIZE', minQty: '0.001', maxQty: '100', stepSize: '0.001' },
    { filterType: 'MARKET_LOT_SIZE', minQty: '1', maxQty: '1', stepSize: '1' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] });
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
function harness(exchange, handler = () => undefined, options = {}) {
  const calls = [];
  const client = createExecutionExchangeClient(exchange, { now: () => NOW, ...options, fetchImpl: async (url, init) => {
    const parsed = new URL(url), parameters = init.body === undefined ? Object.fromEntries(parsed.searchParams) : JSON.parse(init.body);
    const call = { url: parsed, init, parameters }; calls.push(call);
    let value = await handler(call, calls);
    if (value instanceof Response) return value;
    if (value === undefined) {
      const path = parsed.pathname, symbol = parsed.searchParams.get('symbol');
      if (path.endsWith('/apiRestrictions')) value = binancePermission();
      else if (path.endsWith('/query-api')) value = bybitPermission();
      else if (path.endsWith('/accountConfig')) value = { canTrade: true, dualSidePosition: false };
      else if (path === '/v5/account/info') value = { unifiedMarginStatus: 6 };
      else if (path.endsWith('/positionRisk') || path.endsWith('/openOrders') || path.endsWith('/openAlgoOrders')) value = [];
      else if (path === '/v5/position/list') value = { category: 'linear', list: [{ symbol, positionIdx: 0, side: '', size: '0' }], nextPageCursor: '' };
      else if (path === '/v5/order/realtime') value = { category: 'linear', list: [], nextPageCursor: '' };
      else if (path === '/v5/strategy/list') value = { list: parsed.searchParams.has('strategyId') ? [strategy()] : [], nextCursor: '' };
      else if (path === '/v5/strategy/order-list') value = { list: [child()], nextCursor: '' };
      else if (path === '/v5/strategy/create') value = { strategyId: STRATEGY, result: null };
      else if (path === '/v5/strategy/stop') value = { strategyId: STRATEGY };
      else if (path.endsWith('/order')) value = binanceOrder();
      else if (path === '/fapi/v1/exchangeInfo') value = { symbols: ['CLUSDT', 'BZUSDT'].map(binanceRule) };
      else if (path === '/v5/market/instruments-info') value = { category: 'linear', list: [bybitRule(symbol)], nextPageCursor: '' };
      else if (path === '/fapi/v1/ticker/bookTicker') value = { symbol, bidPrice: '80', askPrice: '80.1', bidQty: '10', askQty: '12', time: NOW };
      else if (path === '/v5/market/orderbook') value = { s: symbol, b: [['80', '10']], a: [['80.1', '12']], ts: NOW };
      else if (path === '/fapi/v1/time') value = { serverTime: NOW + 2000 };
      else if (path === '/v5/market/time') value = { timeSecond: String(NOW / 1000 + 2), timeNano: String(BigInt(NOW + 2000) * 1_000_000n) };
      else throw new Error('Unhandled fixture route');
    }
    return exchange === 'bybit' ? json({ retCode: 0, result: value }) : json(value);
  } });
  return { client, calls };
}
const isError = (code, uncertain = false) => error => error instanceof ExecutionExchangeError && error.code === code && error.uncertain === uncertain;
function authenticatedSignature(exchange, call) {
  const { url, init } = call;
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.equal(url.protocol, 'https:');
  if (exchange === 'binance') {
    assert.ok(['api.binance.com', 'fapi.binance.com', 'papi.binance.com'].includes(url.host));
    const params = new URLSearchParams(url.search), signature = params.get('signature'); params.delete('signature');
    assert.equal(signature, createHmac('sha256', credentials.apiSecret).update(params.toString()).digest('hex'));
    assert.equal(init.headers['X-MBX-APIKEY'], credentials.apiKey);
    assert.equal(init.body, undefined);
  } else {
    assert.equal(url.host, 'api.bybit.com');
    const signed = init.headers['X-BAPI-TIMESTAMP'] + credentials.apiKey + '5000' + (init.body ?? url.search.slice(1));
    assert.equal(init.headers['X-BAPI-SIGN'], createHmac('sha256', credentials.apiSecret).update(signed).digest('hex'));
    assert.equal(init.headers['X-BAPI-API-KEY'], credentials.apiKey);
  }
}

for (const mode of ['standard', 'portfolio-margin']) {
  test(`Binance ${mode} signs only LIMIT GTX QUEUE and omits price`, async () => {
    const { client, calls } = harness('binance');
    assert.deepEqual(await client.create(credentials, { ...spec, url: 'https://untrusted.invalid', price: '1', type: 'MARKET' }, { accountMode: mode }), { id: ORDER, kind: 'order' });
    assert.equal(calls.length, 1);
    const call = calls[0], p = call.parameters;
    authenticatedSignature('binance', call);
    assert.equal(call.url.host, mode === 'standard' ? 'fapi.binance.com' : 'papi.binance.com');
    assert.equal(call.url.pathname, mode === 'standard' ? '/fapi/v1/order' : '/papi/v1/um/order');
    assert.equal(call.init.method, 'POST'); assert.equal(p.type, 'LIMIT'); assert.equal(p.timeInForce, 'GTX'); assert.equal(p.priceMatch, 'QUEUE');
    assert.equal(p.reduceOnly, 'false'); assert.equal(p.newClientOrderId, spec.clientId);
    assert.equal(p.quantity, '2'); assert.equal(p.positionSide, 'BOTH');
    for (const key of ['price', 'stopPrice', 'closePosition', 'url']) assert.equal(Object.hasOwn(p, key), false);
  });

  test(`Binance ${mode} permission and account config establish empty-position mode`, async () => {
    const { client, calls } = harness('binance', call => {
      if (call.url.pathname.endsWith('apiRestrictions')) return binancePermission(mode === 'portfolio-margin');
      if (call.url.pathname.endsWith('accountConfig')) return { canTrade: true, dualSidePosition: true };
    });
    const result = await client.account(credentials, { accountMode: mode });
    assert.deepEqual(result, { identity: null, modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] });
    assert.ok(calls.some(call => call.url.pathname === (mode === 'standard' ? '/fapi/v1/accountConfig' : '/papi/v1/um/accountConfig')));
    for (const call of calls) authenticatedSignature('binance', call);
  });

  test(`Binance ${mode} amends the original order with native QUEUE and its original total quantity`, async () => {
    const { client, calls } = harness('binance', () => binanceOrder({ status: 'PARTIALLY_FILLED', executedQty: '0.75', price: '80.03', avgPrice: '80.02' }));
    const result = await client.amend(credentials, { ...spec, id: ORDER, remainingQuantity: '1.25', price: '1', type: 'MARKET', timeInForce: 'IOC', newClientOrderId: 'foreign' }, { accountMode: mode });
    assert.deepEqual(result, { id: ORDER, kind: 'order', status: 'working', quantity: '2', filledQuantity: '0.75',
      price: '80.03', averagePrice: '80.02', terminal: false, childrenSettled: false, symbol: 'CLUSDT', side: 'buy',
      reduceOnly: false, positionSide: 'BOTH', createdAt: new Date(NOW).toISOString() });
    assert.equal(calls.length, 1); authenticatedSignature('binance', calls[0]);
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].url.host, mode === 'standard' ? 'fapi.binance.com' : 'papi.binance.com');
    assert.equal(calls[0].url.pathname, mode === 'standard' ? '/fapi/v1/order' : '/papi/v1/um/order');
    assert.deepEqual(calls[0].parameters, { symbol: 'CLUSDT', side: 'BUY', orderId: ORDER, quantity: '2', priceMatch: 'QUEUE',
      timestamp: String(NOW), recvWindow: '5000', signature: calls[0].parameters.signature });
  });

  test(`Binance ${mode} amendment preserves explicit and implicit reduce-only directions`, async () => {
    for (const [positionSide, side] of [['BOTH', 'sell'], ['LONG', 'sell'], ['SHORT', 'buy']]) {
      const { client, calls } = harness('binance', () => binanceOrder({ positionSide, side: side.toUpperCase(), reduceOnly: positionSide === 'BOTH' }));
      const result = await client.amend(credentials, { ...spec, id: ORDER, positionSide, side, reduceOnly: true }, { accountMode: mode });
      assert.equal(result.reduceOnly, true); assert.equal(result.positionSide, positionSide); assert.equal(result.side, side);
      assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'PUT');
      assert.equal(calls[0].parameters.reduceOnly, mode === 'standard' && positionSide === 'BOTH' ? 'true' : undefined);
      for (const key of ['positionSide', 'timeInForce', 'type', 'price', 'origClientOrderId', 'newClientOrderId']) assert.equal(Object.hasOwn(calls[0].parameters, key), false);
    }
  });

  test(`Binance ${mode} GTX cancellation and a fill racing an amendment return terminal fills without replacement`, async () => {
    for (const [status, executedQty] of [['CANCELED', '0.75'], ['FILLED', '2']]) {
      const { client, calls } = harness('binance', () => binanceOrder({ status, executedQty, avgPrice: '80.02' }));
      const result = await client.amend(credentials, { ...spec, id: ORDER }, { accountMode: mode });
      assert.equal(result.id, ORDER); assert.equal(result.quantity, '2'); assert.equal(result.filledQuantity, executedQty);
      assert.equal(result.status, 'terminal'); assert.equal(result.terminal, true); assert.equal(result.childrenSettled, true);
      assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'PUT');
    }
  });

  test(`Binance ${mode} malformed or mismatched amendment acknowledgements are uncertain`, async () => {
    for (const override of [{ orderId: '123' }, { clientOrderId: 'foreign' }, { symbol: 'BZUSDT' }, { side: 'SELL' },
      { positionSide: 'LONG' }, { reduceOnly: true }, { origQty: '1.25' }, { type: 'MARKET' }, { timeInForce: 'GTC' },
      { executedQty: undefined }, { executedQty: '3' }, { status: 'UNKNOWN' }, { status: 'FILLED', executedQty: '1' }]) {
      const { client, calls } = harness('binance', () => binanceOrder(override));
      await assert.rejects(client.amend(credentials, { ...spec, id: ORDER }, { accountMode: mode }), isError('invalid_data', true));
      assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'PUT');
    }
  });

  test(`Binance ${mode} amendment clock correction retries only the same PUT and rechecks its lease`, async () => {
    let writes = 0, guards = 0;
    const { client, calls } = harness('binance', call => {
      if (call.init.method === 'PUT' && ++writes === 1) return json({ code: -1021 }, 400);
    });
    await client.amend(credentials, { ...spec, id: ORDER }, { accountMode: mode, beforeMutation: () => { guards += 1; } });
    assert.equal(calls.length, 3); assert.equal(writes, 2); assert.equal(guards, 2);
    assert.deepEqual(calls.map(call => call.init.method), ['PUT', 'GET', 'PUT']);
    assert.equal(calls[1].url.pathname, '/fapi/v1/time');
    assert.deepEqual(calls[1].init.headers, {});
    for (const call of [calls[0], calls[2]]) {
      authenticatedSignature('binance', call);
      assert.equal(call.parameters.orderId, ORDER); assert.equal(call.parameters.quantity, '2'); assert.equal(call.parameters.priceMatch, 'QUEUE');
    }
    assert.equal(calls[0].parameters.timestamp, String(NOW)); assert.equal(calls[2].parameters.timestamp, String(NOW + 2000));
  });
}

test('native Binance amendment requires an explicit valid order id; Bybit refuses amendment without HTTP', async () => {
  const binance = harness('binance');
  for (const id of [undefined, null, '', 'foreign-id', '-1', '1'.repeat(31)]) {
    await assert.rejects(binance.client.amend(credentials, { ...spec, id }), isError('input'));
  }
  await assert.rejects(binance.client.amend(credentials, { ...spec, id: ORDER, quantity: '0' }), isError('input'));
  await assert.rejects(binance.client.amend(credentials, { ...spec, id: ORDER }, { accountMode: 'unified' }), isError('account_mode'));
  assert.equal(binance.calls.length, 0);
  const bybit = harness('bybit'); let guards = 0;
  await assert.rejects(bybit.client.amend(credentials, { ...spec, id: STRATEGY }, { beforeMutation: () => { guards += 1; } }), isError('input'));
  assert.equal(bybit.calls.length, 0); assert.equal(guards, 0);
});

test('Binance ambiguous amendment errors never retry, recreate, or cancel the original order', async () => {
  for (const mode of ['standard', 'portfolio-margin']) {
    for (const code of [-1000, -1006, -1007, -1199, -2010, -2013, -4116, -4999, -5026, -5047, -9999]) {
      const { client, calls } = harness('binance', () => json({ code }, 400));
      await assert.rejects(client.amend(credentials, { ...spec, id: ORDER }, { accountMode: mode }), error =>
        error instanceof ExecutionExchangeError && error.providerCode === code && error.uncertain);
      assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'PUT');
    }
    const rejected = harness('binance', () => json({ code: -5022 }, 400));
    await assert.rejects(rejected.client.amend(credentials, { ...spec, id: ORDER }, { accountMode: mode }), isError('rejected'));
    assert.equal(rejected.calls.length, 1); assert.equal(rejected.calls[0].init.method, 'PUT');
  }
});

test('Binance amendment network failures, malformed responses and timeouts remain uncertain', async () => {
  for (const response of [() => { throw new Error('private exchange payload'); }, () => new Response('{'),
    () => json({}), () => json({ code: -5022 }, 503), () => new Promise(() => {})]) {
    const { client, calls } = harness('binance', response, { timeoutMs: 10 });
    await assert.rejects(client.amend(credentials, { ...spec, id: ORDER }), error => {
      assert.ok(error instanceof ExecutionExchangeError); assert.equal(error.uncertain, true);
      assert.equal(error.message.includes('private'), false); return true;
    });
    assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'PUT');
  }
});

test('hedge closes omit Binance reduceOnly but use explicit position side; one-way closes set it', async () => {
  const { client, calls } = harness('binance');
  await client.create(credentials, { ...spec, side: 'sell', positionSide: 'LONG', reduceOnly: true });
  await client.create(credentials, { ...spec, side: 'buy', positionSide: 'SHORT', reduceOnly: true });
  await client.create(credentials, { ...spec, side: 'sell', positionSide: 'BOTH', reduceOnly: true });
  assert.equal(calls[0].parameters.positionSide, 'LONG'); assert.equal(calls[1].parameters.positionSide, 'SHORT');
  assert.equal(Object.hasOwn(calls[0].parameters, 'reduceOnly'), false); assert.equal(Object.hasOwn(calls[1].parameters, 'reduceOnly'), false);
  assert.equal(calls[2].parameters.reduceOnly, 'true');
  await assert.rejects(client.create(credentials, { ...spec, side: 'sell', positionSide: 'LONG', reduceOnly: false }), isError('input'));
  assert.equal(calls.length, 3);
});

test('Bybit creates only a native chase strategy and signs its exact JSON body', async () => {
  const { client, calls } = harness('bybit');
  const close = { ...spec, side: 'sell', positionSide: 'LONG', reduceOnly: true, stopPrice: '70' };
  assert.deepEqual(await client.create(credentials, { ...close, orderType: 'Market', url: 'https://untrusted.invalid' }), { id: STRATEGY, kind: 'strategy' });
  assert.equal(calls.length, 1); authenticatedSignature('bybit', calls[0]);
  assert.equal(calls[0].url.pathname, '/v5/strategy/create'); assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].parameters, { category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Sell', size: '2', strategyType: 'chaseOrder', positionIdx: 1, reduceOnly: true, chaseDistance: '0', maxChasePrice: '70' });
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

for (const exchange of ['binance', 'bybit']) {
  test(`${exchange} rejects malformed specs before any network request`, async () => {
    const { client, calls } = harness(exchange);
    for (const changes of [{ symbol: 'BTCUSDT' }, { quantity: '0' }, { quantity: '1e3' }, { quantity: 1 }, { quantity: '-1' },
      { stopPrice: '' }, { stopPrice: 'NaN' }, { side: 'BUY' }, { positionSide: 'UNKNOWN' }, { reduceOnly: 'true' }, { clientId: 'x'.repeat(33) }, { clientId: '' }]) {
      await assert.rejects(client.create(credentials, { ...spec, ...changes }), isError('input'));
    }
    await assert.rejects(client.create(credentials, spec, { accountMode: 'unsupported' }), isError('account_mode'));
    await assert.rejects(client.create({ apiKey: '\nkey', apiSecret: 'secret' }, spec), isError('credentials'));
    assert.equal(calls.length, 0);
  });

  test(`${exchange} mutation network failures and malformed ACKs are uncertain and never retried`, async () => {
    for (const response of [() => { throw new Error('private token and signed URL'); }, () => json({}, 200), () => new Response('private non-JSON body', { status: 503 }),
      () => exchange === 'bybit' ? json({ retCode: 10000, retMsg: 'private payload' }) : json({ code: -1007, msg: 'private payload' }),
      () => exchange === 'bybit' ? json({ retCode: 60071, retMsg: 'private payload' }) : json({ code: -1006, msg: 'private payload' }),
      () => exchange === 'bybit' ? json({ retCode: 60080, retMsg: 'private payload' }) : json({ code: -4116, msg: 'private payload' }),
      () => exchange === 'bybit' ? json({ retCode: 10002 }, 503) : json({ code: -1021 }, 503)]) {
      const { client, calls } = harness(exchange, response);
      await assert.rejects(client.create(credentials, spec), error => {
        assert.ok(error instanceof ExecutionExchangeError); assert.equal(error.uncertain, true);
        assert.ok(!JSON.stringify(error).includes('private')); assert.ok(!error.message.includes('private')); return true;
      });
      assert.equal(calls.length, 1);
    }
  });

  test(`${exchange} processing, duplicate, terminal and unrecognized mutation errors stay uncertain without retries`, async () => {
    const codes = exchange === 'binance'
      ? [-1000, -1006, -1007, -1199, -2000, -2010, -2011, -2013, -2099, -4000, -4111, -4116, -4999, -5026, -5047, -9999]
      : [10000, 10014, 10016, 110008, 110010, 110030, 110072, 110079, 110114, 110199,
        60061, 60062, 60065, 60068, 60071, 60072, 60073, 60074, 60080, 60081, 60099];
    for (const code of codes) for (const operation of ['create', 'stop']) {
      const { client, calls } = harness(exchange, () => exchange === 'binance' ? json({ code }, 400) : json({ retCode: code }));
      const input = operation === 'create' ? spec : { ...spec, id: exchange === 'binance' ? ORDER : STRATEGY };
      await assert.rejects(client[operation](credentials, input), error => {
        assert.ok(error instanceof ExecutionExchangeError);
        assert.equal(error.providerCode, code); assert.equal(error.uncertain, true);
        assert.notEqual(error.code, 'rejected'); return true;
      }, `${operation} code ${code}`);
      assert.equal(calls.length, 1); assert.notEqual(calls[0].init.method, 'GET');
    }
  });

  test(`${exchange} explicit permission, parameter, balance and limit errors remain certain only below HTTP 500`, async () => {
    const codes = exchange === 'binance' ? [-1022, -1102, -2015, -2019, -4004, -4164, -5022] : [10001, 10005, 110004, 110094, 60063, 60066];
    for (const code of codes) for (const status of [exchange === 'binance' ? 400 : 200, 503]) {
      const { client, calls } = harness(exchange, () => json(exchange === 'binance' ? { code } : { retCode: code }, status));
      await assert.rejects(client.create(credentials, spec), isError(status < 500 ? 'rejected' : 'upstream', status >= 500));
      assert.equal(calls.length, 1);
    }
  });

  test(`${exchange} whole-request timeout includes a stalled body and ignores non-aborting transports`, async () => {
    for (const stalled of [() => new Promise(() => {}), () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }))]) {
      const { client, calls } = harness(exchange, stalled, { timeoutMs: 10 });
      await assert.rejects(client.create(credentials, spec), isError('timeout', true));
      assert.equal(calls.length, 1);
    }
  });

  test(`${exchange} pre-abort is certain, cancellation after dispatch is uncertain`, async () => {
    const before = new AbortController(); before.abort();
    const ready = harness(exchange);
    await assert.rejects(ready.client.create(credentials, spec, { signal: before.signal }), isError('aborted'));
    assert.equal(ready.calls.length, 0);
    const during = new AbortController();
    const active = harness(exchange, () => { during.abort(); return new Promise(() => {}); });
    await assert.rejects(active.client.create(credentials, spec, { signal: during.signal }), isError('aborted', true));
    assert.equal(active.calls.length, 1);
  });

  test(`${exchange} only an explicit time rejection allows one clock-adjusted retry`, async () => {
    let submissions = 0;
    const { client, calls } = harness(exchange, call => {
      if (call.init.method !== 'GET' && ++submissions === 1) return exchange === 'binance' ? json({ code: -1021 }, 400) : json({ retCode: 10002 });
    });
    await client.create(credentials, spec);
    assert.equal(calls.length, 3); assert.equal(submissions, 2);
    const first = calls[0], retried = calls[2];
    assert.equal(first.url.pathname, retried.url.pathname);
    assert.equal(calls[1].url.pathname, exchange === 'binance' ? '/fapi/v1/time' : '/v5/market/time');
    assert.deepEqual(calls[1].init.headers, {});
    if (exchange === 'binance') {
      assert.equal(first.parameters.timestamp, String(NOW)); assert.equal(retried.parameters.timestamp, String(NOW + 2000));
      assert.equal(first.parameters.newClientOrderId, retried.parameters.newClientOrderId);
    } else {
      assert.equal(first.init.headers['X-BAPI-TIMESTAMP'], String(NOW)); assert.equal(retried.init.headers['X-BAPI-TIMESTAMP'], String(NOW + 2000));
      assert.equal(first.init.body, retried.init.body);
    }
    authenticatedSignature(exchange, first); authenticatedSignature(exchange, retried);
  });

  test(`${exchange} checks the execution lease before each mutation, including clock-adjusted retries`, async () => {
    const leaseError = new Error('execution lease lost');
    const stopSpec = { ...spec, id: exchange === 'binance' ? ORDER : STRATEGY };
    for (const operation of ['create', 'stop', ...(exchange === 'binance' ? ['amend'] : [])]) {
      const input = operation === 'create' ? spec : stopSpec;
      const blocked = harness(exchange);
      let checks = 0;
      const beforeMutation = () => { checks += 1; throw leaseError; };
      await assert.rejects(blocked.client[operation](credentials, input, { beforeMutation }), error => error === leaseError);
      assert.equal(checks, 1); assert.equal(blocked.calls.length, 0);

      await blocked.client.verify(credentials, { beforeMutation });
      await blocked.client.account(credentials, { beforeMutation });
      await blocked.client.inspect(credentials, stopSpec, { beforeMutation });
      await blocked.client.market(spec.symbol, { beforeMutation });
      assert.equal(checks, 1);
      assert.ok(blocked.calls.every(call => call.init.method === 'GET'));

      let leaseOwned = true, retryChecks = 0;
      const retry = harness(exchange, call => {
        if (call.init.method !== 'GET') {
          assert.equal(retryChecks, 1);
          assert.equal(Object.hasOwn(call.parameters, 'beforeMutation'), false);
          return exchange === 'binance' ? json({ code: -1021 }, 400) : json({ retCode: 10002 });
        }
        leaseOwned = false;
      });
      await assert.rejects(retry.client[operation](credentials, input, { beforeMutation: () => {
        retryChecks += 1;
        if (!leaseOwned) throw leaseError;
      } }), error => error === leaseError);
      assert.equal(retryChecks, 2);
      assert.equal(retry.calls.length, 2);
      assert.equal(retry.calls.filter(call => call.init.method !== 'GET').length, 1);
      assert.equal(retry.calls[1].url.pathname, exchange === 'binance' ? '/fapi/v1/time' : '/v5/market/time');
    }
  });

  test(`${exchange} repeated timestamp rejection, excessive clock offset, and validation errors never loop`, async () => {
    const timeFailure = exchange === 'binance' ? () => json({ code: -1021 }, 400) : () => json({ retCode: 10002 });
    const repeated = harness(exchange, call => call.init.method !== 'GET' ? timeFailure() : undefined);
    await assert.rejects(repeated.client.create(credentials, spec), isError('timestamp'));
    assert.equal(repeated.calls.length, 3);
    const huge = harness(exchange, call => {
      if (call.init.method !== 'GET') return timeFailure();
      return exchange === 'binance' ? { serverTime: NOW + 1_000_000 } : { timeNano: String(BigInt(NOW + 1_000_000) * 1_000_000n) };
    });
    await assert.rejects(huge.client.create(credentials, spec), isError('clock'));
    assert.equal(huge.calls.length, 2);
    const rejected = harness(exchange, () => exchange === 'binance' ? json({ code: -5022 }, 400) : json({ retCode: 10001 }));
    await assert.rejects(rejected.client.create(credentials, spec), isError('rejected'));
    assert.equal(rejected.calls.length, 1);
  });

  test(`${exchange} rejects redirects and oversized mutation responses without revealing upstream text`, async () => {
    for (const result of [new Response('', { status: 302, headers: { location: 'https://untrusted.invalid/private' } }),
      new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
      const { client, calls } = harness(exchange, () => result);
      await assert.rejects(client.create(credentials, spec), error => error instanceof ExecutionExchangeError && error.uncertain && !error.message.includes('untrusted'));
      assert.equal(calls.length, 1);
    }
  });

  test(`${exchange} market uses LIMIT quantity filters and venue timestamps; public requests contain no credentials`, async () => {
    const { client, calls } = harness(exchange);
    const result = await client.market('CLUSDT');
    assert.deepEqual(result, { symbol: 'CLUSDT', bid: '80', ask: '80.1', at: new Date(NOW).toISOString(),
      rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } });
    for (const call of calls) { assert.deepEqual(call.init.headers, {}); assert.equal(call.init.method, 'GET'); assert.equal(call.url.searchParams.has('signature'), false); }
    await client.market('CLUSDT');
    assert.equal(calls.filter(call => call.url.pathname.endsWith('exchangeInfo') || call.url.pathname.endsWith('instruments-info')).length, 1);
    assert.equal(calls.filter(call => call.url.pathname.endsWith('bookTicker') || call.url.pathname.endsWith('orderbook')).length, 2);
  });

  test(`${exchange} malformed or crossed market data cannot authorize a trade`, async () => {
    for (const change of ['missing-rule', 'crossed', 'timestamp']) {
      const { client } = harness(exchange, call => {
        if (change === 'missing-rule' && call.url.pathname.endsWith('exchangeInfo')) return { symbols: [{ ...binanceRule('CLUSDT'), filters: [] }] };
        if (change === 'missing-rule' && call.url.pathname.endsWith('instruments-info')) return { category: 'linear', list: [{ ...bybitRule('CLUSDT'), lotSizeFilter: {} }] };
        if (call.url.pathname.endsWith('bookTicker')) return { symbol: 'CLUSDT', bidPrice: '81', askPrice: change === 'crossed' ? '80' : '82', bidQty: '1', askQty: '1', ...(change === 'timestamp' ? {} : { time: NOW }) };
        if (call.url.pathname.endsWith('orderbook')) return { s: 'CLUSDT', b: [['81', '1']], a: [[change === 'crossed' ? '80' : '82', '1']], ...(change === 'timestamp' ? {} : { ts: NOW }) };
      });
      await assert.rejects(client.market('CLUSDT'), isError('invalid_data'));
    }
  });
}

test('Binance permission checks fail closed for missing fields, extra financial permissions, and a locked account', async () => {
  const good = binancePermission();
  const bad = ['enableReading', 'enableFutures', 'enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableMargin', 'enableVanillaOptions', 'enableSpotAndMarginTrading']
    .map(key => ({ ...good, [key]: undefined }));
  bad.push({ ...good, enableWithdrawals: true }, { ...good, enableFixApiTrade: true }, { ...good, enablePortfolioMarginTrading: true }, { ...good, enableFutures: 'true' }, { ...good, enableFutureUnknownFinancialScope: true });
  for (const permissions of bad) {
    const { client, calls } = harness('binance', call => call.url.pathname.endsWith('apiRestrictions') ? permissions : undefined);
    await assert.rejects(client.verify(credentials), isError('permissions')); assert.equal(calls.length, 1);
  }
  const locked = harness('binance', call => call.url.pathname.endsWith('accountConfig') ? { canTrade: false, dualSidePosition: false } : undefined);
  await assert.rejects(locked.client.verify(credentials), isError('permissions'));
  const unknownMode = harness('binance', call => call.url.pathname.endsWith('accountConfig') ? { canTrade: true } : undefined);
  await assert.rejects(unknownMode.client.account(credentials), isError('account_mode'));
});

test('Binance preflight independently checks conditional orders and never cancels an external order', async () => {
  for (const mode of ['standard', 'portfolio-margin']) {
    const { client, calls } = harness('binance', call => {
      if (call.url.pathname.endsWith('/apiRestrictions')) return binancePermission(mode === 'portfolio-margin');
      if (call.url.pathname.endsWith('/openAlgoOrders')) return [{ symbol: 'CLUSDT', algoId: '7812345', algoStatus: 'NEW', closePosition: true }];
    });
    await assert.rejects(client.account(credentials, { accountMode: mode }), isError('external_orders'));
    assert.equal(calls.at(-1).url.pathname, mode === 'standard' ? '/fapi/v1/openAlgoOrders' : '/papi/v1/um/algo/openAlgoOrders');
    assert.ok(calls.every(call => call.init.method === 'GET'));
  }
});

test('Bybit permission checks reject read-only, missing Wallet, withdrawal, transfer, and other trading scopes', async () => {
  const base = bybitPermission();
  const bad = [{ ...base, readOnly: 1 }, { ...base, readOnly: '0' }, { ...base, permissions: { ...base.permissions, Wallet: undefined } },
    { ...base, permissions: { ...base.permissions, Wallet: ['Withdraw'] } }, { ...base, permissions: { ...base.permissions, Wallet: ['AccountTransfer'] } },
    { ...base, permissions: { ...base.permissions, Spot: ['SpotTrade'] } }, { ...base, permissions: { ...base.permissions, ContractTrade: [] } },
    { ...base, permissions: { ...base.permissions, FutureUnknownScope: ['Write'] } }];
  for (const permissions of bad) {
    const { client, calls } = harness('bybit', call => call.url.pathname.endsWith('query-api') ? permissions : undefined);
    await assert.rejects(client.verify(credentials), isError('permissions')); assert.equal(calls.length, 1);
  }
  const good = harness('bybit');
  assert.deepEqual(await good.client.verify(credentials), { identity: base.userID });
  assert.ok(!(JSON.stringify(await good.client.verify(credentials))).includes('must-not-be-returned'));
  const classic = harness('bybit', call => call.url.pathname === '/v5/account/info' ? { unifiedMarginStatus: 1 } : undefined);
  await assert.rejects(classic.client.verify(credentials), isError('account_mode'));
});

test('Bybit account preserves zero-position mode and refuses empty or incomplete hedge-mode evidence', async () => {
  const healthy = harness('bybit', call => call.url.pathname.endsWith('position/list') ? { category: 'linear',
    list: [{ symbol: call.parameters.symbol, positionIdx: 1, side: '', size: '0' }, { symbol: call.parameters.symbol, positionIdx: 2, side: 'Sell', size: '3' }], nextPageCursor: '' } : undefined);
  const snapshot = await healthy.client.account(credentials);
  assert.deepEqual(snapshot.modes, { CLUSDT: 'hedge', BZUSDT: 'hedge' });
  assert.deepEqual(snapshot.positions, [{ symbol: 'CLUSDT', side: 'short', quantity: '3' }, { symbol: 'BZUSDT', side: 'short', quantity: '3' }]);
  for (const list of [[], [{ symbol: 'CLUSDT', positionIdx: 1, side: '', size: '0' }], [{ symbol: 'CLUSDT', positionIdx: 0, side: '', size: '0' }, { symbol: 'CLUSDT', positionIdx: 1, side: '', size: '0' }]]) {
    const incomplete = harness('bybit', call => call.url.pathname.endsWith('position/list') ? { category: 'linear', list, nextPageCursor: '' } : undefined);
    await assert.rejects(incomplete.client.account(credentials), isError('account_mode'));
  }
});

test('Binance exact client-id reconciliation preserves int64 order ids and distinguishes not-found', async () => {
  const huge = harness('binance', () => new Response(`{"orderId":${ORDER},"symbol":"CLUSDT","clientOrderId":"${spec.clientId}"}`));
  assert.deepEqual(await huge.client.create(credentials, spec), { id: ORDER, kind: 'order' });
  const { client, calls } = harness('binance', () => binanceOrder({ status: 'CANCELED', executedQty: '0.75', avgPrice: '80.02' }));
  const observed = await client.inspect(credentials, { ...spec, id: null });
  assert.equal(calls[0].parameters.origClientOrderId, spec.clientId); assert.equal(Object.hasOwn(calls[0].parameters, 'orderId'), false);
  assert.equal(observed.filledQuantity, '0.75'); assert.equal(observed.quantity, '2'); assert.equal(observed.terminal, true); assert.equal(observed.childrenSettled, true);
  const missing = harness('binance', () => json({ code: -2013, msg: 'private text' }, 400));
  await assert.rejects(missing.client.inspect(credentials, { ...spec, id: null }), error => isError('not_found')(error) && error.notFound === true);
});

test('Binance reconciliation rejects foreign targets, wrong order attributes, impossible fills, and unknown statuses', async () => {
  for (const override of [{ symbol: 'BZUSDT' }, { clientOrderId: 'foreign' }, { side: 'SELL' }, { positionSide: 'LONG' }, { type: 'MARKET' },
    { timeInForce: 'GTC' }, { executedQty: '3' }, { status: 'FILLED', executedQty: '1' }, { status: 'FUTURE_UNKNOWN' }, { reduceOnly: true }]) {
    const { client } = harness('binance', () => binanceOrder(override));
    await assert.rejects(client.inspect(credentials, { ...spec, id: ORDER }), isError('invalid_data'));
  }
  const effectiveClose = harness('binance', () => binanceOrder({ positionSide: 'LONG', side: 'SELL', reduceOnly: false }));
  assert.equal((await effectiveClose.client.inspect(credentials, { ...spec, id: ORDER, positionSide: 'LONG', side: 'sell', reduceOnly: true })).reduceOnly, true);
});

test('Bybit refuses unknown strategy ids, never guesses a candidate, and treats absent exact matches as not-found', async () => {
  const { client, calls } = harness('bybit');
  await assert.rejects(client.inspect(credentials, { ...spec, id: null }), isError('strategy_id_required'));
  await assert.rejects(client.stop(credentials, { ...spec, id: null }), isError('strategy_id_required'));
  assert.equal(calls.length, 0);
  const missing = harness('bybit', () => ({ list: [], nextCursor: '' }));
  await assert.rejects(missing.client.inspect(credentials, { ...spec, id: STRATEGY }), error => isError('not_found')(error) && error.notFound);
  assert.equal(missing.calls.length, 1); assert.equal(missing.calls[0].parameters.strategyId, STRATEGY);
});

test('Bybit terminal status alone cannot settle a child with open or missing fills', async () => {
  for (const status of [3, 4]) {
    const working = harness('bybit', call => call.url.pathname.endsWith('/strategy/list') ? { list: [strategy({ status, executedSize: '1' })], nextCursor: '' }
      : call.url.pathname.endsWith('/order-list') ? { list: [child({ status: '4', executedSize: '1' })], nextCursor: '' } : undefined);
    const result = await working.client.inspect(credentials, { ...spec, id: STRATEGY });
    assert.equal(result.terminal, true); assert.equal(result.childrenSettled, false); assert.equal(result.filledQuantity, '1');
    assert.equal(result.positionSide, 'BOTH');
  }
  const lagged = harness('bybit', call => call.url.pathname.endsWith('/strategy/list') ? { list: [strategy({ status: 3, executedSize: '2' })], nextCursor: '' }
    : call.url.pathname.endsWith('/order-list') ? { list: [], nextCursor: '' } : undefined);
  const result = await lagged.client.inspect(credentials, { ...spec, id: STRATEGY });
  assert.equal(result.childrenSettled, false); assert.equal(result.positionSide, null);
});

test('Bybit inspects every child page, deduplicates exact repeated orders, and counts partial cancellation correctly', async () => {
  const other = 'ef862a28-4611-4d4d-afd6-094a130ce720';
  const { client, calls } = harness('bybit', call => {
    if (call.url.pathname.endsWith('/strategy/list')) return { list: [strategy({ status: 3, executedSize: '1.25', executedAvgPrice: '80.05' })], nextCursor: '' };
    if (call.url.pathname.endsWith('/order-list')) return call.parameters.cursor
      ? { list: [child({ orderId: other, size: '1', status: '7', executedSize: '0.25' })], nextCursor: '' }
      : { list: [child({ size: '1', status: '5', executedSize: '1' }), child({ size: '1', status: '5', executedSize: '1' })], nextCursor: 'page-2' };
  });
  const result = await client.inspect(credentials, { ...spec, id: STRATEGY });
  assert.equal(result.childrenSettled, true); assert.equal(result.filledQuantity, '1.25'); assert.equal(result.quantity, '2');
  assert.equal(result.averagePrice, '80.05'); assert.equal(result.positionSide, 'BOTH');
  assert.equal(calls.length, 3); assert.equal(calls[2].parameters.cursor, 'page-2');
});

test('Bybit refuses missing cursors, cursor cycles, and inconsistent or foreign child records', async () => {
  const variants = [() => ({ list: [child()] }), () => ({ list: [child()], nextCursor: 'same-cursor' }),
    () => ({ list: [child({ positionIdx: 2 })], nextCursor: '' }), () => ({ list: [child({ orderType: 1 })], nextCursor: '' }),
    () => ({ list: [child({ strategyId: '7b13f550-b4b3-463d-a90e-4b2652604825' })], nextCursor: '' }),
    () => ({ list: [child({ executedSize: '3' })], nextCursor: '' }),
    () => ({ list: [child(), child({ executedSize: '1' })], nextCursor: '' })];
  for (const make of variants) {
    const { client, calls } = harness('bybit', call => call.url.pathname.endsWith('/order-list') ? make() : undefined);
    await assert.rejects(client.inspect(credentials, { ...spec, id: STRATEGY }), error => error instanceof ExecutionExchangeError && ['pagination', 'invalid_data'].includes(error.code) && !error.uncertain);
    assert.ok(calls.length <= 3);
  }
});

test('Bybit paused and untriggered strategies remain unresolved even with no child orders', async () => {
  for (const status of [5, 6]) {
    const { client } = harness('bybit', call => call.url.pathname.endsWith('/strategy/list') ? { list: [strategy({ status })], nextCursor: '' }
      : call.url.pathname.endsWith('/order-list') ? { list: [], nextCursor: '' } : undefined);
    const result = await client.inspect(credentials, { ...spec, id: STRATEGY });
    assert.equal(result.status, 'paused'); assert.equal(result.terminal, false); assert.equal(result.childrenSettled, false);
  }
});

test('stop targets only the supplied order or native strategy; its ACK never implies no fills', async () => {
  for (const exchange of ['binance', 'bybit']) {
    const { client, calls } = harness(exchange);
    assert.equal(await client.stop(credentials, { ...spec, id: exchange === 'binance' ? ORDER : STRATEGY }), undefined);
    assert.equal(calls.length, 1); authenticatedSignature(exchange, calls[0]);
    assert.equal(calls[0].url.pathname, exchange === 'binance' ? '/fapi/v1/order' : '/v5/strategy/stop');
    assert.equal(calls[0].init.method, exchange === 'binance' ? 'DELETE' : 'POST');
    if (exchange === 'bybit') assert.deepEqual(calls[0].parameters, { strategyId: STRATEGY });
    else assert.equal(calls[0].parameters.orderId, ORDER);
  }
  const mismatched = harness('bybit', () => ({ strategyId: '7b13f550-b4b3-463d-a90e-4b2652604825' }));
  await assert.rejects(mismatched.client.stop(credentials, { ...spec, id: STRATEGY }), isError('invalid_data', true));
});

test('native strategy success with missing id or non-null result remains uncertain', async () => {
  for (const ack of [{ strategyId: STRATEGY }, { strategyId: STRATEGY, result: 'Failed' }, { result: null }, { strategyId: 'not-a-uuid', result: null }]) {
    const { client, calls } = harness('bybit', () => ack);
    await assert.rejects(client.create(credentials, spec), isError('invalid_data', true));
    assert.equal(calls.length, 1);
  }
});

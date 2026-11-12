// Real Binance connector against a stand-in fetch: request shapes, signatures, the not-sent / rejected / uncertain /
// read-failed split, the single timestamp retry and the account snapshot. No network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBinanceConnector } from '../src/live/binance.ts';
import { parseOrderReport } from '../src/connector.ts';
import { ContractError, parseAccountSnapshot, parseInstrument, parseQuote } from '../src/contracts.ts';
import { createExecutor } from '../src/executor.ts';
import { createHarness } from './harness.ts';

import { KEY, json, binding, order, kind, signal, send, symbolInfo, FakeBinance, SECRET, NOW, type Call } from './live-fake-binance.ts';

function setup(options: { timeoutMs?: number } = {}) {
  const venue = new FakeBinance();
  const credentials: { value: { apiKey: string; apiSecret: string } | null } = { value: { apiKey: KEY, apiSecret: SECRET } };
  const connector = createBinanceConnector({
    credentials: () => { if (!credentials.value) throw new Error('未配置'); return credentials.value; },
    fetchImpl: venue.fetch, now: () => venue.clock, ...options,
  });
  return { venue, connector, credentials };
}

test('Binance 连接器：合约规则按目录解析（TRADIFI 永续、市价数量上限、取较大的最小数量），60 秒内复用；规则不完整时读取失败', async () => {
  const { venue, connector } = setup();
  const instrument = parseInstrument(await connector.instrument('CLUSDT', { signal: signal() }), 'binance', 'CLUSDT');
  assert.deepEqual({ ...instrument, catalogVersion: undefined }, { venue: 'binance', symbol: 'CLUSDT', kind: 'linear-perpetual', settleAsset: 'USDT', contractSize: '1', tickSize: '0.01', quantityStep: '0.1', minQuantity: '0.1', maxQuantity: '10000', maxMarketQuantity: '500', minNotional: '5', catalogVersion: undefined });
  assert.match(instrument.catalogVersion, /^bn-[0-9a-f]{16}$/);
  await connector.instrument('CLUSDT', { signal: signal() });
  assert.equal(venue.count('GET /fapi/v1/exchangeInfo'), 1);

  for (const broken of [
    symbolInfo({ symbol: 'BZUSDT', status: 'SETTLING' }),
    symbolInfo({ symbol: 'BZUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1', maxQty: '10' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '1', minQty: '1', maxQty: '10' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }),
    symbolInfo({ symbol: 'BZUSDT', timeInForce: ['GTC'] }),
  ]) {
    const fresh = setup();
    fresh.venue.info = [broken];
    await assert.rejects(fresh.connector.instrument('BZUSDT', { signal: signal() }), kind('read-failed'));
  }
  await assert.rejects(connector.instrument('BTCUSDT', { signal: signal() }), kind('read-failed'));
});

test('Binance 连接器：盘口的接收时刻是本机收到应答的时刻，来源时间保留交易所时间', async () => {
  const { venue, connector } = setup();
  const quote = parseQuote(await connector.quote('CLUSDT', { signal: signal() }), 'binance', 'CLUSDT');
  assert.deepEqual(quote, { venue: 'binance', symbol: 'CLUSDT', bid: '70.1', ask: '70.12', sourceTime: NOW - 250, receivedAt: NOW, connectionGeneration: 0, sequence: null, complete: true });
  venue.script('GET /fapi/v1/ticker/bookTicker', () => json({ symbol: 'BZUSDT', bidPrice: '1', bidQty: '1', askPrice: '2', askQty: '1', time: NOW }));
  await assert.rejects(connector.quote('CLUSDT', { signal: signal() }), kind('read-failed'));
});

test('Binance 连接器：账户快照带 UID、持仓模式、两向持仓与全部活动委托（条件单算外来委托），先读委托后读持仓；身份 60 秒内复用', async () => {
  const { venue, connector } = setup();
  venue.positions = [{ symbol: 'CLUSDT', positionSide: 'BOTH', positionAmt: '-3.500', marginAsset: 'USDT', entryPrice: '70', markPrice: '70.1' }];
  venue.openOrders = [{ symbol: 'CLUSDT', orderId: 18446744073709551615n, clientOrderId: 'pa1-0123456789abcdef01234567-0', status: 'NEW' }, { symbol: 'CLUSDT', orderId: 7, clientOrderId: 'web_X1', status: 'NEW' }];
  venue.algoOrders = [{ symbol: 'CLUSDT', algoId: 55, clientAlgoId: 'x' }];
  const snapshot = parseAccountSnapshot(await connector.account(binding(), ['CLUSDT'], { signal: signal() }), 'binance');
  assert.deepEqual(snapshot, {
    venue: 'binance', accountId: '123456789', positionModes: { CLUSDT: 'one-way' }, positions: [{ symbol: 'CLUSDT', side: 'short', quantity: '3.5' }],
    openOrders: [{ symbol: 'CLUSDT', clientOrderId: 'pa1-0123456789abcdef01234567-0', remoteId: '18446744073709551615' }, { symbol: 'CLUSDT', clientOrderId: 'web_X1', remoteId: '7' }, { symbol: 'CLUSDT', clientOrderId: null, remoteId: 'algo-55' }],
    receivedAt: NOW,
  });
  const paths = venue.calls.map(call => call.path);
  assert.ok(paths.indexOf('/fapi/v1/openOrders') < paths.indexOf('/fapi/v3/positionRisk') && paths.indexOf('/fapi/v1/openAlgoOrders') < paths.indexOf('/fapi/v3/positionRisk'));
  assert.ok(venue.calls.every(call => call.path === '/fapi/v1/time' || call.apiKey === KEY));

  venue.mode = 'hedge';
  venue.positions = [{ symbol: 'CLUSDT', positionSide: 'LONG', positionAmt: '2', marginAsset: 'USDT' }, { symbol: 'CLUSDT', positionSide: 'SHORT', positionAmt: '-1', marginAsset: 'USDT' }];
  venue.openOrders = []; venue.algoOrders = [];
  const hedge = await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  assert.deepEqual([hedge.positionModes, hedge.positions], [{ CLUSDT: 'hedge' }, [{ symbol: 'CLUSDT', side: 'long', quantity: '2' }, { symbol: 'CLUSDT', side: 'short', quantity: '1' }]]);
  assert.equal(venue.count('GET /api/v3/account'), 1);

  // Rows that disagree with the account's position mode, a long row with a short amount, or a foreign symbol are unreadable.
  for (const rows of [[{ symbol: 'CLUSDT', positionSide: 'BOTH', positionAmt: '1', marginAsset: 'USDT' }], [{ symbol: 'CLUSDT', positionSide: 'LONG', positionAmt: '-1', marginAsset: 'USDT' }], [{ symbol: 'BZUSDT', positionSide: 'LONG', positionAmt: '1', marginAsset: 'USDT' }]]) {
    venue.positions = rows;
    await assert.rejects(connector.account(binding(), ['CLUSDT'], { signal: signal() }), kind('read-failed'));
  }
  // Portfolio margin uses its own host and paths.
  venue.positions = [];
  await connector.account(binding({ accountMode: 'portfolio-margin' }), ['CLUSDT'], { signal: signal() });
  assert.ok(['/papi/v1/um/openOrders', '/papi/v1/um/algo/openAlgoOrders', '/papi/v1/um/positionRisk', '/papi/v1/um/accountConfig'].every(path => venue.calls.some(call => call.path === path && call.host === 'https://papi.binance.com')));
  // Only mainnet Binance bindings are served, and a missing key never reaches the network.
  const before = venue.calls.length;
  await assert.rejects(connector.account(binding({ environment: 'simulated' }), ['CLUSDT'], { signal: signal() }), kind('read-failed'));
  await assert.rejects(connector.account(binding(), ['ANTHROPIC'], { signal: signal() }), kind('read-failed'));
  assert.equal(venue.calls.length, before);
});

test('Binance 连接器：单向持仓的限价 IOC 首腿带 BOTH 与 reduceOnly，按客户订单号下单并用 RESULT 回报；发送前守卫恰在请求前调用一次', async () => {
  const { venue, connector } = setup();
  const sent: number[] = [];
  const report = parseOrderReport(await connector.place(binding(), order(), send(() => sent.push(venue.calls.length))), order());
  assert.deepEqual(report, { clientOrderId: order().clientOrderId, remoteId: '9007199254740993', symbol: 'CLUSDT', side: 'buy', quantity: '2', filledQuantity: '1', averagePrice: '70.11', status: 'expired', terminal: true, updatedAt: NOW });
  const post = venue.calls.find(call => call.method === 'POST')!;
  assert.deepEqual(sent, [venue.calls.indexOf(post)]);
  assert.deepEqual(Object.fromEntries([...post.params].filter(([name]) => !['timestamp', 'recvWindow', 'signature'].includes(name))), {
    symbol: 'CLUSDT', side: 'BUY', type: 'LIMIT', quantity: '2', price: '70.5', timeInForce: 'IOC', positionSide: 'BOTH', reduceOnly: 'false', newClientOrderId: order().clientOrderId, newOrderRespType: 'RESULT',
  });
  // The mode came from a fresh read; within 60 s a recent account read is reused instead.
  assert.equal(venue.count('GET /fapi/v1/accountConfig'), 1);
  const market = order({ clientOrderId: 'pa1-0123456789abcdef01234567-1', side: 'sell', positionSide: 'long', type: 'market', limitPrice: null, reduceOnly: true });
  const filled = parseOrderReport(await connector.place(binding(), market, send()), market);
  assert.equal(filled.status, 'filled');
  const params = venue.calls.filter(call => call.method === 'POST')[1].params;
  assert.deepEqual([params.get('type'), params.get('price'), params.get('timeInForce'), params.get('reduceOnly')], ['MARKET', null, null, 'true']);
  assert.equal(venue.count('GET /fapi/v1/accountConfig'), 1);
});

test('Binance 连接器：双向持仓用 positionSide 表达开平且不带 reduceOnly；方向与只减仓不符时不发送', async () => {
  const { venue, connector } = setup();
  venue.mode = 'hedge';
  const close = order({ side: 'sell', positionSide: 'long', reduceOnly: true });
  await connector.place(binding(), close, send());
  const params = venue.calls.find(call => call.method === 'POST')!.params;
  assert.deepEqual([params.get('positionSide'), params.has('reduceOnly')], ['LONG', false]);
  const openShort = order({ clientOrderId: 'pa1-0123456789abcdef01234567-2', side: 'sell', positionSide: 'short', reduceOnly: false });
  await connector.place(binding(), openShort, send());
  assert.equal(venue.calls.filter(call => call.method === 'POST')[1].params.get('positionSide'), 'SHORT');
  const posts = venue.count('POST /fapi/v1/order');
  // A close that would open the other side in hedge mode is refused locally.
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-3', side: 'buy', positionSide: 'long', reduceOnly: true }), send()), kind('not-sent'));
  // A mode read that fails before sending is not-sent.
  const fresh = setup();
  fresh.venue.script('GET /fapi/v1/accountConfig', () => json({ code: -1001, msg: 'Internal error' }, 500));
  await assert.rejects(fresh.connector.place(binding(), order(), send()), kind('not-sent'));
  assert.equal(fresh.venue.count('POST /fapi/v1/order'), 0);
  assert.equal(venue.count('POST /fapi/v1/order'), posts);
});

test('Binance 连接器：只有清单内的拒绝码算明确拒绝；其余错误码、5xx、坏应答、断线、超时与发送后中止都按结果未知', async () => {
  const cases: [string, (call: Call) => Response | Promise<Response>, string][] = [
    ['保证金不足', () => json({ code: -2019, msg: 'Margin is insufficient.' }, 400), 'rejected'],
    ['限流', () => json({ code: -1003, msg: 'Too many requests' }, 429), 'rejected'],
    ['清单外错误码', () => json({ code: -1007, msg: 'Timeout waiting for response from backend server.' }, 408), 'uncertain'],
    ['重复客户订单号', () => json({ code: -4116, msg: 'ClientOrderId is duplicated.' }, 400), 'uncertain'],
    ['服务端错误', () => json({ code: -1001, msg: 'Internal error' }, 503), 'uncertain'],
    ['5xx 带拒绝码', () => json({ code: -2019, msg: 'x' }, 502), 'uncertain'],
    ['无错误码的 4xx', () => new Response('<html>blocked</html>', { status: 403 }), 'uncertain'],
    ['成功码但不是委托', () => json({ ok: true }), 'uncertain'],
    ['回报客户订单号不同', call => json({ orderId: 1, symbol: 'CLUSDT', status: 'NEW', clientOrderId: 'other', price: '70.5', avgPrice: '0', origQty: '2', executedQty: '0', timeInForce: 'IOC', type: 'LIMIT', reduceOnly: false, side: 'BUY', positionSide: 'BOTH', updateTime: NOW, x: call.path }), 'uncertain'],
    ['断线', () => { throw new TypeError('fetch failed'); }, 'uncertain'],
    ['重定向', () => new Response(null, { status: 302, headers: { location: 'https://example.invalid' } }), 'uncertain'],
  ];
  for (const [label, reply, expected] of cases) {
    const { venue, connector } = setup();
    venue.script('POST /fapi/v1/order', reply);
    await assert.rejects(connector.place(binding(), order(), send()), kind(expected), label);
  }
  // Cancel of an order the venue no longer knows (already filled) is not a refusal: it stays uncertain and is re-read.
  const { connector } = setup();
  await assert.rejects(connector.cancel(binding(), order(), send()), kind('uncertain'));
});

test('Binance 连接器：发送前守卫拒绝或已取消时不发出请求，报未发送；超时与发送后中止报结果未知；读请求的任何失败只是读取失败', async () => {
  const { venue, connector, credentials } = setup({ timeoutMs: 150 });
  await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  const posts = () => venue.count('POST /fapi/v1/order');
  await assert.rejects(connector.place(binding(), order(), send(() => { throw new Error('租约已丢失'); })), kind('not-sent'));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(connector.place(binding(), order(), { signal: aborted.signal, beforeSend: () => undefined }), kind('not-sent'));
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'bad id' }), send()), kind('not-sent'));
  await assert.rejects(connector.place(binding(), order({ symbol: 'BTCUSDT' }), send()), kind('not-sent'));
  await assert.rejects(connector.place(binding(), order({ type: 'market', limitPrice: null, timeInForce: 'gtc' }), send()), kind('not-sent'));
  credentials.value = null;
  await assert.rejects(connector.place(binding({ credentialVersion: 2 }), order(), send()), kind('not-sent'));
  // A key that cannot be a header value is refused before anything leaves.
  for (const value of [{ apiKey: 'bad key', apiSecret: SECRET }, { apiKey: KEY, apiSecret: 'two\nlines' }]) {
    credentials.value = value;
    const before = venue.calls.length;
    await assert.rejects(connector.place(binding({ credentialVersion: 3 }), order(), send()), kind('not-sent'));
    assert.equal(venue.calls.length, before, '连持仓模式也不读');
  }
  credentials.value = { apiKey: KEY, apiSecret: SECRET };
  assert.equal(posts(), 0);

  // A request that never answers times out as uncertain, and so does an abort after it left.
  venue.script('POST /fapi/v1/order', () => new Promise<Response>(() => undefined));
  await assert.rejects(connector.place(binding(), order(), send()), kind('uncertain'));
  const controller = new AbortController();
  venue.script('POST /fapi/v1/order', () => { setTimeout(() => controller.abort(), 5); return new Promise<Response>(() => undefined); });
  await assert.rejects(connector.place(binding(), order(), { signal: controller.signal, beforeSend: () => undefined }), kind('uncertain'));
  venue.script('DELETE /fapi/v1/order', () => new Promise<Response>(() => undefined));
  await assert.rejects(connector.cancel(binding(), order(), send()), kind('uncertain'));
  assert.equal(posts(), 2);

  for (const reply of [() => json({ code: -2019, msg: 'x' }, 400), () => json({ code: -1001, msg: 'x' }, 500), () => new Promise<Response>(() => undefined)]) {
    venue.script('GET /fapi/v1/order', reply);
    await assert.rejects(connector.query(binding(), order(), { signal: signal() }), kind('read-failed'));
  }
});

test('Binance 连接器：时间戳被拒时同步一次时钟后用同一客户订单号重发一次，重发前再过一次守卫；再被拒或同步失败按明确拒绝', async () => {
  const { venue, connector } = setup();
  await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  venue.serverSkew = 20_000;
  let guards = 0;
  const report = await connector.place(binding(), order(), send(() => { guards++; }));
  assert.equal(report.clientOrderId, order().clientOrderId);
  const posts = venue.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(guards, 2);
  assert.equal(posts[0].params.get('newClientOrderId'), posts[1].params.get('newClientOrderId'));
  assert.equal(venue.count('GET /fapi/v1/time'), 1);
  // Later requests use the synced offset without another refusal.
  await connector.query(binding(), order(), { signal: signal() });
  assert.equal(venue.count('GET /fapi/v1/time'), 1);

  const twice = setup();
  await twice.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  const refuse = () => json({ code: -1021, msg: 'Timestamp outside recvWindow' }, 400);
  twice.venue.script('POST /fapi/v1/order', refuse, refuse);
  await assert.rejects(twice.connector.place(binding(), order(), send()), kind('rejected'));
  assert.equal(twice.venue.count('POST /fapi/v1/order'), 2);

  const noClock = setup();
  await noClock.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  noClock.venue.script('POST /fapi/v1/order', refuse);
  noClock.venue.script('GET /fapi/v1/time', () => json({ code: -1001, msg: 'x' }, 500));
  await assert.rejects(noClock.connector.place(binding(), order(), send()), kind('rejected'));
  // A guard that refuses the resend leaves the first refusal as the answer.
  const guarded = setup();
  await guarded.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  guarded.venue.script('POST /fapi/v1/order', refuse);
  let calls = 0;
  await assert.rejects(guarded.connector.place(binding(), order(), send(() => { if (++calls > 1) throw new Error('租约已丢失'); })), kind('rejected'));
  assert.equal(guarded.venue.count('POST /fapi/v1/order'), 1);
});

test('Binance 连接器：按客户订单号查单与撤单；查无返回 null；回报与请求身份不符时读取失败', async () => {
  const { venue, connector } = setup();
  assert.equal(await connector.query(binding(), order(), { signal: signal() }), null);
  const resting = order({ timeInForce: 'gtc' });
  await connector.place(binding(), resting, send());
  venue.orders.get(resting.clientOrderId)!.status = 'NEW';
  venue.orders.get(resting.clientOrderId)!.executedQty = '0';
  venue.orders.get(resting.clientOrderId)!.avgPrice = '0.00';
  const open = parseOrderReport(await connector.query(binding(), resting, { signal: signal() }), resting);
  assert.deepEqual([open.status, open.terminal, open.averagePrice, open.filledQuantity], ['new', false, null, '0']);
  const query = venue.calls.filter(call => call.path === '/fapi/v1/order' && call.method === 'GET').at(-1)!;
  assert.deepEqual([query.params.get('symbol'), query.params.get('origClientOrderId')], ['CLUSDT', resting.clientOrderId]);
  const canceled = parseOrderReport(await connector.cancel(binding(), resting, send()), resting);
  assert.deepEqual([canceled.status, canceled.terminal], ['canceled', true]);
  // The same client id with another price, side or time in force is not this order.
  for (const other of [order({ timeInForce: 'gtc', limitPrice: '70.6' }), order({ timeInForce: 'ioc' }), order({ timeInForce: 'gtc', quantity: '3' })]) {
    await assert.rejects(connector.query(binding(), other, { signal: signal() }), kind('read-failed'));
  }
  venue.orders.get(resting.clientOrderId)!.executedQty = '1';
  venue.orders.get(resting.clientOrderId)!.avgPrice = '0';
  await assert.rejects(connector.query(binding(), resting, { signal: signal() }), kind('read-failed'));
});

test('Binance 连接器：执行器不混用真实与模拟传输：实盘里的模拟连接器、模拟环境里的真实连接器都拒绝', () => {
  const h = createHarness();
  try {
    const { connector } = setup();
    assert.equal(connector.capabilities.transport, 'live');
    assert.throws(() => createExecutor({ store: h.store, connectors: [connector, h.bybit], environment: 'mainnet', notionalLimits: { perJob: '100', totalOpen: '500' } }),
      (error: unknown) => error instanceof ContractError && error.code === 'live_transport_refused');
    assert.throws(() => createExecutor({ store: h.store, connectors: [connector] }),
      (error: unknown) => error instanceof ContractError && error.code === 'live_transport_refused');
  } finally { h.dispose(); }
});

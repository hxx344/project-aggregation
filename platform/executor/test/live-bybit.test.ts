// Real Bybit connector against a stand-in fetch: request shapes, signatures, the not-sent / rejected / uncertain /
// read-failed split, the single timestamp retry, pagination and the native chase lifecycle as observed on a real account
// (docs/unified-platform-phase0-inventory.md item 47). No network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBybitConnector } from '../src/live/bybit.ts';
import { VenueError, parseOrderReport, parseStrategyReport, type OrderRequest, type StrategyRequest } from '../src/connector.ts';
import { ContractError, parseAccountSnapshot, parseInstrument, parseQuote, type AccountBinding } from '../src/contracts.ts';
import { createExecutor } from '../src/executor.ts';
import { createHarness } from './harness.ts';

const KEY = 'test-key', SECRET = 'test-secret', NOW = 1_800_000_000_000;
const STRATEGY_A = '3f1c2a9e-6b7d-4c58-9a0e-1d2b3c4d5e6f';
type Row = Record<string, unknown>;
interface Call { method: string; path: string; params: URLSearchParams; body: Row | null; apiKey: string | null }
// BigInt values are written as bare JSON numbers, like the venue's 64-bit ids.
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? `__big${value}__` : value).replace(/"__big(\d+)__"/g, '$1'), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown): Response => json({ retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: NOW });
const fail = (retCode: number, retMsg = 'refused', status = 200): Response => json({ retCode, retMsg, result: {}, retExtInfo: {}, time: NOW }, status);
const binding = (overrides: Partial<AccountBinding> = {}): AccountBinding => ({ venue: 'bybit', environment: 'mainnet', accountId: '9007199254740993', accountMode: 'unified', credentialVersion: 1, ...overrides });
const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: 'pa1-0123456789abcdef01234567-0', symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '2', type: 'limit', limitPrice: '70.5', timeInForce: 'ioc', reduceOnly: false, ...overrides,
});
const chase = (overrides: Partial<StrategyRequest> = {}): StrategyRequest => ({ symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '2', maxChasePrice: '71', reduceOnly: false, ...overrides });
const kind = (expected: string) => (error: unknown) => error instanceof VenueError && error.kind === expected;
const signal = () => new AbortController().signal;
const send = (beforeSend: () => void = () => undefined) => ({ signal: signal(), beforeSend });

const instrumentRow = (overrides: Row = {}): Row => ({
  symbol: 'CLUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'CL', quoteCoin: 'USDT', settleCoin: 'USDT', unifiedMarginTrade: true,
  priceFilter: { minPrice: '0.01', maxPrice: '1999.98', tickSize: '0.01' },
  lotSizeFilter: { maxOrderQty: '10000', minOrderQty: '0.1', qtyStep: '0.1', maxMktOrderQty: '500', minNotionalValue: '5', postOnlyMaxOrderQty: '10000' },
  ...overrides,
});
/** Strategy record with the fields seen on the real account (no positionIdx, numeric status, empty average before a fill). */
const strategyRow = (overrides: Row = {}): Row => ({
  strategyId: STRATEGY_A, category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Buy', size: '2', strategyType: 'chaseOrder', status: 2, reduceOnly: false,
  executedSize: '0', executedAvgPrice: '', maxChasePrice: '71', chasePercentE4: '0', chaseDistance: '0', chasePrice: 'Bid1', postOnly: 0, chaseOrderPrice: '70.1',
  createdTimeE3: String(NOW - 10_000), updatedTimeE3: String(NOW - 5_000), ...overrides,
});
const childRow = (overrides: Row = {}): Row => ({ strategyId: STRATEGY_A, symbol: 'CLUSDT', side: 'Buy', orderId: 'c1a2b3c4-0000-4000-8000-000000000001', positionIdx: 0, status: '5', orderType: 'UNKNOWN', size: '2', executedSize: '2', ...overrides });

/** Stateful stand-in: verifies every signature and recv window against its own clock, keeps orders by orderLinkId. */
class FakeBybit {
  clock = NOW;
  serverSkew = 0;
  mode: 'one-way' | 'hedge' = 'one-way';
  calls: Call[] = [];
  orders: Row[] = [];
  history: Row[] = [];
  positions: Row[] | null = null;
  strategies: Row[] = [];
  children: Row[] = [];
  instruments: Row[] = [instrumentRow()];
  /** One-shot replies by "METHOD path", consumed in order. */
  scripted = new Map<string, ((call: Call) => Response | Promise<Response>)[]>();
  nextOrder = 1;

  script(route: string, ...replies: ((call: Call) => Response | Promise<Response>)[]): void { this.scripted.set(route, [...(this.scripted.get(route) ?? []), ...replies]); }
  count(route: string): number { return this.calls.filter(call => `${call.method} ${call.path}` === route).length; }
  last(route: string): Call { return this.calls.filter(call => `${call.method} ${call.path}` === route).at(-1)!; }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url), headers = new Headers(init.headers), body = typeof init.body === 'string' ? init.body : null;
    assert.equal(parsed.origin, 'https://api.bybit.com');
    assert.equal(init.redirect, 'error');
    const call: Call = { method: init.method ?? 'GET', path: parsed.pathname, params: parsed.searchParams, body: body === null ? null : JSON.parse(body), apiKey: headers.get('X-BAPI-API-KEY') };
    this.calls.push(call);
    const route = `${call.method} ${call.path}`, queue = this.scripted.get(route);
    if (call.path.startsWith('/v5/market/')) {
      if (queue?.length) return queue.shift()!(call);
      if (call.path === '/v5/market/time') { const at = this.clock + this.serverSkew; return ok({ timeSecond: String(Math.floor(at / 1000)), timeNano: `${at}000000` }); }
      if (call.path === '/v5/market/instruments-info') return ok({ category: 'linear', list: this.instruments.filter(row => row.symbol === call.params.get('symbol')), nextPageCursor: '' });
      if (call.path === '/v5/market/orderbook') return ok({ s: call.params.get('symbol'), b: [['70.10', '31']], a: [['70.12', '12.5']], ts: this.clock - 250, u: 1, seq: 2, cts: this.clock - 260 });
    }
    const refused = this.checkSignature(headers, call.method === 'POST' ? body ?? '' : parsed.search.slice(1));
    if (refused) return refused;
    if (call.method === 'POST') assert.equal(headers.get('Content-Type'), 'application/json');
    if (queue?.length) return queue.shift()!(call);
    const p = call.params;
    switch (route) {
      case 'GET /v5/user/query-api': return ok({ id: '1', apiKey: KEY, readOnly: 0, userID: 9_007_199_254_740_993n, permissions: {} });
      case 'GET /v5/position/list': return ok({ category: 'linear', list: this.positions ?? this.flat(p.get('symbol')!), nextPageCursor: '' });
      case 'GET /v5/order/realtime': return ok({ category: 'linear', list: this.matching(this.orders, p), nextPageCursor: '' });
      case 'GET /v5/order/history': return ok({ category: 'linear', list: this.matching(this.history, p), nextPageCursor: '' });
      case 'POST /v5/order/create': return this.create(call.body!);
      case 'POST /v5/order/cancel': {
        const row = this.orders.find(item => item.orderLinkId === call.body!.orderLinkId);
        if (!row || !['New', 'PartiallyFilled'].includes(row.orderStatus as string)) return fail(110001, 'order not exists or too late to cancel');
        row.orderStatus = 'Cancelled';
        return ok({ orderId: row.orderId, orderLinkId: row.orderLinkId });
      }
      case 'POST /v5/strategy/create': {
        const b = call.body!;
        if (this.strategies.some(row => [2, 5, 6].includes(row.status as number) && row.symbol === b.symbol && row.side === b.side)) return fail(60081, "can't create same sides order");
        this.strategies.push(strategyRow({ symbol: b.symbol, side: b.side, size: b.size, reduceOnly: b.reduceOnly, maxChasePrice: b.maxChasePrice, createdTimeE3: String(this.clock), updatedTimeE3: String(this.clock) }));
        return ok({ strategyId: STRATEGY_A, result: null });
      }
      case 'POST /v5/strategy/stop': {
        const row = this.strategies.find(item => item.strategyId === call.body!.strategyId);
        if (!row || [3, 4].includes(row.status as number)) return fail(60062, 'Strategy has been terminated');
        row.status = 3;
        return ok({ strategyId: row.strategyId });
      }
      case 'GET /v5/strategy/list': {
        assert.deepEqual([p.get('category'), p.get('strategyType'), p.get('pageSize')], ['UTA_USDT', 'chaseOrder', '50']);
        const begin = p.get('beginTimeE0'), end = p.get('endTimeE0');
        const list = this.strategies.filter(row => row.symbol === p.get('symbol') && (!p.has('strategyId') || row.strategyId === p.get('strategyId')) && (!p.has('status') || String(row.status) === p.get('status'))
          && (begin === null || Number(row.createdTimeE3) >= Number(begin) * 1000) && (end === null || Number(row.createdTimeE3) < Number(end) * 1000));
        return ok({ list, nextCursor: '', prevCursor: '' });
      }
      case 'GET /v5/strategy/order-list': return ok({ list: this.children.filter(row => row.strategyId === p.get('strategyId') && row.symbol === p.get('symbol')), nextCursor: '' });
    }
    return fail(10001, `unknown path ${route}`, 404);
  };

  checkSignature(headers: Headers, payload: string): Response | null {
    const timestamp = headers.get('X-BAPI-TIMESTAMP')!, recvWindow = headers.get('X-BAPI-RECV-WINDOW')!;
    assert.equal(headers.get('X-BAPI-API-KEY'), KEY);
    assert.equal(recvWindow, '5000');
    assert.equal(headers.get('X-BAPI-SIGN'), createHmac('sha256', SECRET).update(timestamp + KEY + recvWindow + payload).digest('hex'));
    const server = this.clock + this.serverSkew;
    if (Number(timestamp) >= server + 1000 || server - Number(timestamp) > 5000) return fail(10002, 'invalid request, please check your server timestamp or recv_window param');
    return null;
  }

  flat(symbol: string): Row[] {
    const base = { symbol, size: '0', side: '', avgPrice: '0' };
    return this.mode === 'one-way' ? [{ ...base, positionIdx: 0 }] : [{ ...base, positionIdx: 1 }, { ...base, positionIdx: 2 }];
  }
  matching(rows: Row[], p: URLSearchParams): Row[] {
    return rows.filter(row => row.symbol === p.get('symbol') && (!p.has('orderLinkId') || row.orderLinkId === p.get('orderLinkId')));
  }
  create(b: Row): Response {
    if (this.orders.some(row => row.orderLinkId === b.orderLinkId)) return fail(110072, 'OrderLinkedID is duplicate');
    const market = b.orderType === 'Market';
    this.orders.push({
      orderId: `0000-${this.nextOrder++}`, orderLinkId: b.orderLinkId, symbol: b.symbol, side: b.side, orderType: b.orderType, price: market ? '73.5' : b.price, qty: b.qty,
      timeInForce: market ? 'IOC' : b.timeInForce, orderStatus: market ? 'Filled' : 'PartiallyFilledCanceled', cumExecQty: market ? b.qty : '1', avgPrice: '70.11',
      positionIdx: b.positionIdx, reduceOnly: b.reduceOnly, createType: 'CreateByUser', createdTime: String(this.clock), updatedTime: String(this.clock),
    });
    return ok({ orderId: `0000-${this.nextOrder - 1}`, orderLinkId: b.orderLinkId });
  }
}

function setup(options: { timeoutMs?: number } = {}) {
  const venue = new FakeBybit();
  const connector = createBybitConnector({ credentials: () => ({ apiKey: KEY, apiSecret: SECRET }), fetchImpl: venue.fetch, now: () => venue.clock, ...options });
  return { venue, connector };
}

test('Bybit 连接器：合约规则与盘口按 V5 字段解析，规则 60 秒内复用；不可交易或规则缺字段时读取失败', async () => {
  const { venue, connector } = setup();
  const instrument = parseInstrument(await connector.instrument('CLUSDT', { signal: signal() }), 'bybit', 'CLUSDT');
  assert.deepEqual([instrument.tickSize, instrument.quantityStep, instrument.minQuantity, instrument.maxMarketQuantity, instrument.minNotional], ['0.01', '0.1', '0.1', '500', '5']);
  assert.match(instrument.catalogVersion, /^by-[0-9a-f]{16}$/);
  await connector.instrument('CLUSDT', { signal: signal() });
  assert.equal(venue.count('GET /v5/market/instruments-info'), 1);
  const quote = parseQuote(await connector.quote('CLUSDT', { signal: signal() }), 'bybit', 'CLUSDT');
  assert.deepEqual([quote.bid, quote.ask, quote.sourceTime, quote.receivedAt], ['70.1', '70.12', NOW - 250, NOW]);
  const lot = instrumentRow().lotSizeFilter as Row;
  for (const broken of [instrumentRow({ status: 'Settling' }), instrumentRow({ contractType: 'LinearFutures' }), instrumentRow({ unifiedMarginTrade: false }), instrumentRow({ lotSizeFilter: { ...lot, maxMktOrderQty: undefined } })]) {
    const fresh = setup();
    fresh.venue.instruments = [broken];
    await assert.rejects(fresh.connector.instrument('CLUSDT', { signal: signal() }), kind('read-failed'));
  }
  await assert.rejects(connector.instrument('BTCUSDT', { signal: signal() }), kind('read-failed'));
});

test('Bybit 连接器：账户快照先读委托与追价策略、后读持仓；追价挂单与运行中策略都算外部委托；用户编号保留全部位数', async () => {
  const { venue, connector } = setup();
  venue.orders.push(
    { orderId: 'own-1', orderLinkId: 'pa1-own', symbol: 'CLUSDT', orderStatus: 'New' },
    { orderId: 'chase-child', orderLinkId: '', symbol: 'CLUSDT', orderStatus: 'New', createType: 'CreateByChaseOrder' },
    { orderId: 'done-1', orderLinkId: 'pa1-done', symbol: 'CLUSDT', orderStatus: 'Filled' },
  );
  venue.strategies.push(strategyRow(), strategyRow({ strategyId: 'paused-1', status: 5 }), strategyRow({ strategyId: 'ended-1', status: 3 }));
  venue.positions = [{ symbol: 'CLUSDT', positionIdx: 0, side: 'Buy', size: '3' }];
  const snapshot = parseAccountSnapshot(await connector.account(binding(), ['CLUSDT'], { signal: signal() }), 'bybit');
  assert.equal(snapshot.accountId, '9007199254740993');
  assert.deepEqual(snapshot.positionModes, { CLUSDT: 'one-way' });
  assert.deepEqual(snapshot.positions, [{ symbol: 'CLUSDT', side: 'long', quantity: '3' }]);
  assert.deepEqual(snapshot.openOrders.map(item => [item.clientOrderId, item.remoteId]), [['pa1-own', 'own-1'], [null, 'chase-child'], [null, `chase-${STRATEGY_A}`], [null, 'chase-paused-1']]);
  const paths = venue.calls.map(call => `${call.path}${call.params.get('status') ? `:${call.params.get('status')}` : ''}`);
  assert.deepEqual(paths.slice(1), ['/v5/order/realtime', '/v5/strategy/list:2', '/v5/strategy/list:4', '/v5/strategy/list:5', '/v5/strategy/list:6', '/v5/position/list']);
  assert.equal(venue.last('GET /v5/order/realtime').params.get('openOnly'), '0');

  // Hedge mode: both position rows, sides fixed by the index; an incomplete set is a read failure.
  venue.mode = 'hedge';
  venue.positions = [{ symbol: 'CLUSDT', positionIdx: 1, side: 'Buy', size: '1' }, { symbol: 'CLUSDT', positionIdx: 2, side: 'Sell', size: '2' }];
  const hedge = parseAccountSnapshot(await connector.account(binding(), ['CLUSDT'], { signal: signal() }), 'bybit');
  assert.deepEqual(hedge.positionModes, { CLUSDT: 'hedge' });
  assert.deepEqual(hedge.positions.map(item => [item.side, item.quantity]), [['long', '1'], ['short', '2']]);
  assert.equal(venue.count('GET /v5/user/query-api'), 1, '用户编号 60 秒内复用');
  for (const broken of [[{ symbol: 'CLUSDT', positionIdx: 1, side: 'Buy', size: '1' }], [{ symbol: 'CLUSDT', positionIdx: 0, side: '', size: '0' }, { symbol: 'CLUSDT', positionIdx: 1, side: '', size: '0' }], [{ symbol: 'CLUSDT', positionIdx: 1, side: 'Sell', size: '1' }, { symbol: 'CLUSDT', positionIdx: 2, side: '', size: '0' }]]) {
    venue.positions = broken;
    await assert.rejects(connector.account(binding(), ['CLUSDT'], { signal: signal() }), kind('read-failed'));
  }
  await assert.rejects(connector.account(binding({ environment: 'simulated' }), ['CLUSDT'], { signal: signal() }), kind('read-failed'));
  await assert.rejects(connector.account(binding(), ['ANTHROPICUSDT'], { signal: signal() }), kind('read-failed'));
});

test('Bybit 连接器：下单参数按持仓模式带 positionIdx；回执后读一次委托取首个状态，读不到时按已受理未成交报告', async () => {
  const { venue, connector } = setup();
  let guard = 0;
  const filled = parseOrderReport(await connector.place(binding(), order(), send(() => { guard++; })), order());
  assert.equal(guard, 1);
  assert.deepEqual(venue.last('POST /v5/order/create').body, { category: 'linear', symbol: 'CLUSDT', side: 'Buy', orderType: 'Limit', qty: '2', price: '70.5', timeInForce: 'IOC', positionIdx: 0, reduceOnly: false, orderLinkId: order().clientOrderId });
  assert.deepEqual([filled.status, filled.terminal, filled.filledQuantity, filled.averagePrice, filled.remoteId], ['canceled', true, '1', '70.11', '0000-1']);
  const market = order({ clientOrderId: 'pa1-market', type: 'market', limitPrice: null, side: 'sell', positionSide: 'long', reduceOnly: true });
  const sold = parseOrderReport(await connector.place(binding(), market, send()), market);
  assert.deepEqual(venue.last('POST /v5/order/create').body, { category: 'linear', symbol: 'CLUSDT', side: 'Sell', orderType: 'Market', qty: '2', positionIdx: 0, reduceOnly: true, orderLinkId: 'pa1-market' });
  assert.deepEqual([sold.status, sold.filledQuantity], ['filled', '2']);

  // The follow-up read failing leaves the acknowledgement as a working order with nothing filled.
  venue.script('GET /v5/order/realtime', () => fail(10016, 'server error', 500));
  const acked = parseOrderReport(await connector.place(binding(), order({ clientOrderId: 'pa1-acked' }), send()), order({ clientOrderId: 'pa1-acked' }));
  assert.deepEqual([acked.status, acked.terminal, acked.filledQuantity, acked.remoteId], ['new', false, '0', '0000-3']);
  // An acknowledgement for another client id is not this order.
  venue.script('POST /v5/order/create', () => ok({ orderId: 'x', orderLinkId: 'someone-else' }));
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-other' }), send()), kind('uncertain'));

  // Hedge mode: positionIdx follows the position side; reduceOnly must agree with it before anything is sent.
  const hedge = setup();
  hedge.venue.mode = 'hedge';
  await hedge.connector.place(binding(), order({ side: 'sell', positionSide: 'short' }), send());
  assert.equal(hedge.venue.last('POST /v5/order/create').body!.positionIdx, 2);
  await assert.rejects(hedge.connector.place(binding(), order({ clientOrderId: 'pa1-bad', side: 'sell', positionSide: 'long', reduceOnly: false }), send()), kind('not-sent'));
  // One-way: the position side must follow from side and reduceOnly.
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-bad', side: 'buy', positionSide: 'short' }), send()), kind('not-sent'));
  assert.equal(hedge.venue.count('POST /v5/order/create'), 1);
  assert.equal(venue.count('POST /v5/order/create'), 4);
});

test('Bybit 连接器：只有明确拒绝码才算已拒绝；5xx、未知码、超时与发出后中止都算结果未知；发送前拒绝算未发送', async () => {
  const cases: [Response, string][] = [
    [fail(110007, 'ab not enough for new order'), 'rejected'],
    [fail(10001, 'params error'), 'rejected'],
    [fail(110072, 'OrderLinkedID is duplicate'), 'uncertain'],
    [fail(10016, 'server error', 500), 'uncertain'],
    [json({ retMsg: 'no code' }), 'uncertain'],
    [json({ retCode: 0, retMsg: 'OK', result: [] }), 'uncertain'],
  ];
  for (const [reply, expected] of cases) {
    const { venue, connector } = setup();
    venue.script('POST /v5/order/create', () => reply.clone());
    await assert.rejects(connector.place(binding(), order(), send()), kind(expected), `${expected}`);
    const read = setup();
    read.venue.script('GET /v5/order/realtime', () => reply.clone());
    await assert.rejects(read.connector.query(binding(), order(), { signal: signal() }), kind('read-failed'));
  }
  const guarded = setup();
  await assert.rejects(guarded.connector.place(binding(), order(), send(() => { throw new Error('租约已丢失'); })), kind('not-sent'));
  assert.equal(guarded.venue.count('POST /v5/order/create'), 0);
  const noKey = createBybitConnector({ credentials: () => { throw new Error('未配置'); }, fetchImpl: setup().venue.fetch, now: () => NOW });
  await assert.rejects(noKey.place(binding(), order(), send()), kind('not-sent'));
  const slow = setup({ timeoutMs: 100 });
  await slow.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  slow.venue.script('POST /v5/order/create', () => new Promise<Response>(() => undefined));
  await assert.rejects(slow.connector.place(binding(), order(), send()), kind('uncertain'));
  const aborted = setup();
  await aborted.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  const controller = new AbortController();
  aborted.venue.script('POST /v5/order/create', () => { controller.abort(); return new Promise<Response>(() => undefined); });
  await assert.rejects(aborted.connector.place(binding(), order(), { signal: controller.signal, beforeSend: () => undefined }), kind('uncertain'));
});

test('Bybit 连接器：时间戳被拒（10002）后同步时钟重发一次；再被拒、同步失败或守卫拒绝重发都算已拒绝', async () => {
  const { venue, connector } = setup();
  await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  venue.serverSkew = 20_000;
  let guard = 0;
  await connector.place(binding(), order(), send(() => { guard++; }));
  assert.deepEqual([venue.count('POST /v5/order/create'), guard, venue.count('GET /v5/market/time')], [2, 2, 1]);
  const first = venue.calls.filter(call => call.path === '/v5/order/create');
  assert.deepEqual(first[0].body, first[1].body, '重发同一请求体');
  // A read after the sync is signed with the corrected clock.
  await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  assert.equal(venue.count('GET /v5/market/time'), 1);

  const refuse = () => fail(10002, 'timestamp');
  const twice = setup();
  await twice.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  twice.venue.script('POST /v5/order/create', refuse, refuse);
  await assert.rejects(twice.connector.place(binding(), order(), send()), kind('rejected'));
  const noClock = setup();
  await noClock.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  noClock.venue.script('POST /v5/order/create', refuse);
  noClock.venue.script('GET /v5/market/time', () => fail(10016, 'x', 500));
  await assert.rejects(noClock.connector.place(binding(), order(), send()), kind('rejected'));
  const guarded = setup();
  await guarded.connector.account(binding(), ['CLUSDT'], { signal: signal() });
  guarded.venue.script('POST /v5/order/create', refuse);
  let calls = 0;
  await assert.rejects(guarded.connector.place(binding(), order(), send(() => { if (++calls > 1) throw new Error('租约已丢失'); })), kind('rejected'));
  assert.equal(guarded.venue.count('POST /v5/order/create'), 1);
});

test('Bybit 连接器：查单先查实时再查历史，查无返回 null，多笔同号读取失败；撤单回执后读委托，读不到时结果未知', async () => {
  const { venue, connector } = setup();
  assert.equal(await connector.query(binding(), order(), { signal: signal() }), null);
  assert.deepEqual([venue.count('GET /v5/order/realtime'), venue.count('GET /v5/order/history')], [1, 1]);
  const resting = order({ timeInForce: 'gtc' });
  await connector.place(binding(), resting, send());
  Object.assign(venue.orders[0], { orderStatus: 'New', cumExecQty: '0', avgPrice: '' });
  const open = parseOrderReport(await connector.query(binding(), resting, { signal: signal() }), resting);
  assert.deepEqual([open.status, open.terminal, open.averagePrice], ['new', false, null]);
  const canceled = parseOrderReport(await connector.cancel(binding(), resting, send()), resting);
  assert.deepEqual([canceled.status, canceled.terminal], ['canceled', true]);
  assert.deepEqual(venue.last('POST /v5/order/cancel').body, { category: 'linear', symbol: 'CLUSDT', orderLinkId: resting.clientOrderId });
  // Moved to history.
  venue.history.push(venue.orders.pop()!);
  assert.equal(parseOrderReport(await connector.query(binding(), resting, { signal: signal() }), resting).status, 'canceled');
  for (const other of [order({ timeInForce: 'gtc', limitPrice: '70.6' }), order({ timeInForce: 'ioc' }), order({ timeInForce: 'gtc', quantity: '3' }), order({ timeInForce: 'gtc', reduceOnly: true })]) {
    await assert.rejects(connector.query(binding(), other, { signal: signal() }), kind('read-failed'));
  }
  venue.history[0].positionIdx = 2;
  await assert.rejects(connector.query(binding(), resting, { signal: signal() }), kind('read-failed'));
  venue.history[0].positionIdx = 0;
  venue.history.push({ ...venue.history[0], orderId: 'dup' });
  await assert.rejects(connector.query(binding(), resting, { signal: signal() }), kind('read-failed'));
  // Cancel acknowledged but the order cannot be read: the outcome stays open.
  const lost = setup();
  lost.venue.script('POST /v5/order/cancel', call => ok({ orderId: 'x', orderLinkId: call.body!.orderLinkId }));
  await assert.rejects(lost.connector.cancel(binding(), resting, send()), kind('uncertain'));
  // 110001 (not found or too late) is not a proof either way.
  await assert.rejects(lost.connector.cancel(binding(), resting, send()), kind('uncertain'));
});

test('Bybit 连接器：分页按游标读完；重复游标、满页无游标、超过页数都算读取失败；短页无游标视为读完', async () => {
  const page = (list: Row[], cursor?: string) => () => ok({ category: 'linear', list, ...(cursor === undefined ? {} : { nextPageCursor: cursor }) });
  const row = (id: number): Row => ({ orderId: `o-${id}`, orderLinkId: `ext-${id}`, symbol: 'CLUSDT', orderStatus: 'New' });
  const full = Array.from({ length: 50 }, (_item, i) => row(i));
  const { venue, connector } = setup();
  venue.script('GET /v5/order/realtime', page(full, 'c1'), page([row(50)], ''));
  const snapshot = await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  assert.equal(snapshot.openOrders.length, 51);
  assert.equal(venue.calls.filter(call => call.path === '/v5/order/realtime')[1].params.get('cursor'), 'c1');
  for (const replies of [[page(full, 'c1'), page([row(60)], 'c1')], [page(full)], [page([row(1)], 7 as unknown as string)]]) {
    const broken = setup();
    broken.venue.script('GET /v5/order/realtime', ...replies);
    await assert.rejects(broken.connector.account(binding(), ['CLUSDT'], { signal: signal() }), kind('read-failed'));
  }
  const short = setup();
  short.venue.script('GET /v5/order/realtime', page([row(1)]));
  assert.equal((await short.connector.account(binding(), ['CLUSDT'], { signal: signal() })).openOrders.length, 1);
});

test('Bybit 连接器：原生追价按真实账户的形状走完一生：挂单时子单为空、子单先于策略结束出现且类型为 UNKNOWN、结束且合计一致才结清', async () => {
  const { venue, connector } = setup();
  let guard = 0;
  const ack = await connector.placeChase(binding(), chase(), send(() => { guard++; }));
  assert.deepEqual([ack, guard], [{ strategyId: STRATEGY_A }, 1]);
  assert.deepEqual(venue.last('POST /v5/strategy/create').body, { category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Buy', size: '2', strategyType: 'chaseOrder', positionIdx: 0, reduceOnly: false, chasePercentE4: 0, maxChasePrice: '71' });
  const identity = { strategyId: STRATEGY_A, symbol: 'CLUSDT', side: 'buy' as const, positionSide: 'long' as const, reduceOnly: false, quantity: '2', maxChasePrice: '71' };

  // Resting: the child list is empty; the resting order shows only in realtime.
  const resting = parseStrategyReport(await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }), identity);
  assert.deepEqual([resting.status, resting.filledQuantity, resting.averagePrice, resting.childrenSettled, resting.createdAt], ['working', '0', null, false, NOW]);
  assert.equal(venue.count('GET /v5/strategy/list'), 1, '本进程创建的策略只查它的合约');
  assert.equal(venue.last('GET /v5/strategy/order-list').params.get('strategyId'), STRATEGY_A);
  // Filled child appears about 6 s before the strategy record ends.
  venue.children.push(childRow());
  const lagging = parseStrategyReport(await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }), identity);
  assert.deepEqual([lagging.status, lagging.filledQuantity, lagging.childrenSettled], ['working', '0', false]);
  Object.assign(venue.strategies[0], { status: 3, executedSize: '2', executedAvgPrice: '70.12', chaseOrderPrice: '' });
  const done = parseStrategyReport(await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }), identity);
  assert.deepEqual([done.status, done.filledQuantity, done.averagePrice, done.childrenSettled], ['terminal', '2', '70.12', true]);
  // The reverse order (strategy ended, child not yet listed) waits instead of failing.
  venue.children = [];
  assert.equal((await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.childrenSettled, false);
  // An ended strategy with nothing filled and no children is settled.
  Object.assign(venue.strategies[0], { executedSize: '0', executedAvgPrice: '' });
  assert.equal((await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.childrenSettled, true);
  // A child still open, or a child that disagrees with the strategy, is not settled or is unreadable.
  venue.children = [childRow({ status: '2', executedSize: '0' })];
  assert.equal((await connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.childrenSettled, false);
  for (const broken of [childRow({ side: 'Sell' }), childRow({ positionIdx: 2 }), childRow({ orderType: 1 }), childRow({ status: '5', executedSize: '1' }), childRow({ executedSize: '3', size: '3' })]) {
    venue.children = [broken];
    await assert.rejects(connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }), kind('read-failed'));
  }
  venue.children = [];

  // A same-side duplicate is a definite refusal; stopping an ended strategy (60062) is not a proof.
  venue.strategies[0].status = 2;
  await assert.rejects(connector.placeChase(binding(), chase(), send()), kind('rejected'));
  assert.deepEqual(await connector.stopStrategy(binding(), STRATEGY_A, send()), { strategyId: STRATEGY_A });
  assert.deepEqual(venue.last('POST /v5/strategy/stop').body, { strategyId: STRATEGY_A });
  await assert.rejects(connector.stopStrategy(binding(), STRATEGY_A, send()), kind('uncertain'));
  venue.script('POST /v5/strategy/stop', () => ok({ strategyId: 'other' }));
  await assert.rejects(connector.stopStrategy(binding(), STRATEGY_A, send()), kind('uncertain'));

  // A strategy id this process did not create is searched on every execution symbol; an unknown id answers an empty list.
  const fresh = setup();
  fresh.venue.strategies.push(strategyRow({ symbol: 'BZUSDT' }));
  assert.equal((await fresh.connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.symbol, 'BZUSDT');
  assert.deepEqual(fresh.venue.calls.filter(call => call.path === '/v5/strategy/list').map(call => call.params.get('symbol')), ['CLUSDT', 'BZUSDT']);
  assert.equal(await fresh.connector.queryStrategy(binding(), 'aaaaaaaa-0000-4000-8000-000000000000', { signal: signal() }), null);
  // A strategy created here is read on its own symbol only.
  fresh.venue.strategies = [];
  await fresh.connector.placeChase(binding(), chase({ symbol: 'BZUSDT' }), send());
  const before = fresh.venue.count('GET /v5/strategy/list');
  assert.equal((await fresh.connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.symbol, 'BZUSDT');
  assert.deepEqual(fresh.venue.calls.filter(call => call.path === '/v5/strategy/list').slice(before).map(call => call.params.get('symbol')), ['BZUSDT']);
  // A sell that closes a long is reported on the long side (the record has no positionIdx).
  fresh.venue.strategies[0] = strategyRow({ symbol: 'BZUSDT', side: 'Sell', reduceOnly: true });
  assert.equal((await fresh.connector.queryStrategy(binding(), STRATEGY_A, { signal: signal() }))!.positionSide, 'long');
  // Hedge mode: positionIdx follows the position side; a create answer of another shape is uncertain.
  const hedge = setup();
  hedge.venue.mode = 'hedge';
  await hedge.connector.placeChase(binding(), chase({ side: 'sell', positionSide: 'short' }), send());
  assert.equal(hedge.venue.last('POST /v5/strategy/create').body!.positionIdx, 2);
  hedge.venue.script('POST /v5/strategy/create', () => ok({ strategyId: STRATEGY_A, result: 'x' }));
  await assert.rejects(hedge.connector.placeChase(binding(), chase(), send()), kind('uncertain'));
});

test('Bybit 连接器：策略列表含全部运行中、暂停与结束中的策略，已结束的只读时间窗内创建的；超过 7 天的时间窗读取失败', async () => {
  const { venue, connector } = setup();
  const from = NOW - 60_500, to = NOW - 500;
  venue.strategies.push(
    strategyRow({ strategyId: 'running-old', status: 2, createdTimeE3: String(NOW - 30 * 86_400_000) }),
    strategyRow({ strategyId: 'paused-1', status: 6 }),
    strategyRow({ strategyId: 'ending-in', status: 4, createdTimeE3: String(from + 1) }),
    strategyRow({ strategyId: 'ending-old', status: 4, createdTimeE3: String(from - 5_000) }),
    strategyRow({ strategyId: 'ended-in', status: 3, createdTimeE3: String(to) }),
    strategyRow({ strategyId: 'ended-early', status: 3, createdTimeE3: String(from - 200) }),
    strategyRow({ strategyId: 'ended-late', status: 3, createdTimeE3: String(to + 400) }),
  );
  const listed = await connector.listStrategies(binding(), 'CLUSDT', { from, to }, { signal: signal() });
  for (const report of listed) parseStrategyReport(report);
  assert.deepEqual(listed.map(report => [report.strategyId, report.status, report.childrenSettled]).sort(), [
    ['ended-in', 'terminal', false], ['ending-in', 'terminal', false], ['paused-1', 'paused', false], ['running-old', 'working', false],
  ]);
  const ended = venue.calls.find(call => call.path === '/v5/strategy/list' && call.params.get('status') === '3')!;
  assert.deepEqual([ended.params.get('beginTimeE0'), ended.params.get('endTimeE0')], [String(Math.floor(from / 1000) - 1), String(Math.ceil(to / 1000))]);
  assert.ok(venue.calls.filter(call => call.path === '/v5/strategy/list' && call.params.get('status') !== '3').every(call => !call.params.has('beginTimeE0')));
  await assert.rejects(connector.listStrategies(binding(), 'CLUSDT', { from: NOW - 8 * 86_400_000, to: NOW }, { signal: signal() }), kind('read-failed'));
  await assert.rejects(connector.listStrategies(binding(), 'CLUSDT', { from: NOW, to: NOW - 1 }, { signal: signal() }), kind('read-failed'));
});

test('Bybit 连接器：执行器在实盘接线（3.0c）之前仍拒绝真实传输', () => {
  const h = createHarness();
  try {
    const { connector } = setup();
    assert.deepEqual([connector.capabilities.transport, connector.capabilities.chase], ['live', true]);
    assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, connector], environment: 'mainnet', notionalLimits: { perJob: '100', totalOpen: '500' } }),
      (error: unknown) => error instanceof ContractError && error.code === 'live_transport_refused');
  } finally { h.dispose(); }
});

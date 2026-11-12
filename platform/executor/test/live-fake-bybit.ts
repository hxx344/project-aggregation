// Stateful Bybit stand-in shared by the connector tests and the executor end-to-end test. No network is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { VenueError, type OrderRequest, type StrategyRequest } from '../src/connector.ts';
import type { AccountBinding } from '../src/contracts.ts';

export const KEY = 'test-key', SECRET = 'test-secret', NOW = 1_800_000_000_000;
export const STRATEGY_A = '3f1c2a9e-6b7d-4c58-9a0e-1d2b3c4d5e6f';
export type Row = Record<string, unknown>;
export interface Call { method: string; path: string; params: URLSearchParams; body: Row | null; apiKey: string | null }
// BigInt values are written as bare JSON numbers, like the venue's 64-bit ids.
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? `__big${value}__` : value).replace(/"__big(\d+)__"/g, '$1'), { status, headers: { 'content-type': 'application/json' } });
export const ok = (result: unknown): Response => json({ retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: NOW });
export const fail = (retCode: number, retMsg = 'refused', status = 200): Response => json({ retCode, retMsg, result: {}, retExtInfo: {}, time: NOW }, status);
export const binding = (overrides: Partial<AccountBinding> = {}): AccountBinding => ({ venue: 'bybit', environment: 'mainnet', accountId: '9007199254740993', accountMode: 'unified', credentialVersion: 1, ...overrides });
export const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: 'pa1-0123456789abcdef01234567-0', symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '2', type: 'limit', limitPrice: '70.5', timeInForce: 'ioc', reduceOnly: false, ...overrides,
});
export const chase = (overrides: Partial<StrategyRequest> = {}): StrategyRequest => ({ symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '2', maxChasePrice: '71', reduceOnly: false, ...overrides });
export const kind = (expected: string) => (error: unknown) => error instanceof VenueError && error.kind === expected;
export const signal = () => new AbortController().signal;
export const send = (beforeSend: () => void = () => undefined) => ({ signal: signal(), beforeSend });

export const instrumentRow = (overrides: Row = {}): Row => ({
  symbol: 'CLUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'CL', quoteCoin: 'USDT', settleCoin: 'USDT', unifiedMarginTrade: true,
  priceFilter: { minPrice: '0.01', maxPrice: '1999.98', tickSize: '0.01' },
  lotSizeFilter: { maxOrderQty: '10000', minOrderQty: '0.1', qtyStep: '0.1', maxMktOrderQty: '500', minNotionalValue: '5', postOnlyMaxOrderQty: '10000' },
  ...overrides,
});
/** Strategy record with the fields seen on the real account (no positionIdx, numeric status, empty average before a fill). */
export const strategyRow = (overrides: Row = {}): Row => ({
  strategyId: STRATEGY_A, category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Buy', size: '2', strategyType: 'chaseOrder', status: 2, reduceOnly: false,
  executedSize: '0', executedAvgPrice: '', maxChasePrice: '71', chasePercentE4: '0', chaseDistance: '0', chasePrice: 'Bid1', postOnly: 0, chaseOrderPrice: '70.1',
  createdTimeE3: String(NOW - 10_000), updatedTimeE3: String(NOW - 5_000), ...overrides,
});
export const childRow = (overrides: Row = {}): Row => ({ strategyId: STRATEGY_A, symbol: 'CLUSDT', side: 'Buy', orderId: 'c1a2b3c4-0000-4000-8000-000000000001', positionIdx: 0, status: '5', orderType: 'UNKNOWN', size: '2', executedSize: '2', ...overrides });

/** Stateful stand-in: verifies every signature and recv window against its own clock, keeps orders by orderLinkId. */
export class FakeBybit {
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
  /** query-api answer of a key that may trade contracts only. */
  apiInfo: Row = {
    id: '1', apiKey: KEY, readOnly: 0, userID: 9_007_199_254_740_993n, ips: ['*'], type: 1,
    permissions: { ContractTrade: ['Order', 'Position'], Derivatives: ['DerivativesTrade'], Wallet: [], Spot: [], Options: [], Exchange: [], CopyTrading: [], BlockTrade: [], NFT: [], Affiliate: [], Earn: [] },
  };
  unifiedMarginStatus: unknown = 5;
  /**
   * Exchange mode for the executor end-to-end test: every order fills in full at once, a chase runs until finishChases,
   * and a one-way position is kept per symbol, which position/list then reports instead of `positions`.
   */
  fillAll = false;
  net = new Map<string, number>();

  move(symbol: string, side: unknown, quantity: number): void { this.net.set(symbol, (this.net.get(symbol) ?? 0) + (side === 'Buy' ? quantity : -quantity)); }
  /** Every running chase fills in full through one child order and ends. */
  finishChases(): void {
    for (const row of this.strategies.filter(item => item.status === 2)) {
      row.status = 3; row.executedSize = row.size; row.executedAvgPrice = '70.2'; row.updatedTimeE3 = String(this.clock);
      this.children.push(childRow({ strategyId: row.strategyId, symbol: row.symbol, side: row.side, size: row.size, executedSize: row.size, orderId: `c1a2b3c4-0000-4000-8000-${String(this.children.length + 1).padStart(12, '0')}` }));
      this.move(row.symbol as string, row.side, Number(row.size));
    }
  }

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
      case 'GET /v5/user/query-api': return ok(this.apiInfo);
      case 'GET /v5/account/info': return ok({ unifiedMarginStatus: this.unifiedMarginStatus, marginMode: 'REGULAR_MARGIN', isMasterTrader: false, spotHedgingStatus: 'OFF', updatedTime: String(NOW) });
      case 'GET /v5/position/list': {
        const symbol = p.get('symbol')!, size = this.net.get(symbol) ?? 0;
        if (this.fillAll) return ok({ category: 'linear', list: [{ symbol, positionIdx: 0, side: size > 0 ? 'Buy' : size < 0 ? 'Sell' : '', size: Math.abs(size).toFixed(1), avgPrice: '70.11' }], nextPageCursor: '' });
        return ok({ category: 'linear', list: this.positions ?? this.flat(symbol), nextPageCursor: '' });
      }
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
    const market = b.orderType === 'Market', full = market || this.fillAll;
    if (this.fillAll) this.move(b.symbol as string, b.side, Number(b.qty));
    this.orders.push({
      orderId: `0000-${this.nextOrder++}`, orderLinkId: b.orderLinkId, symbol: b.symbol, side: b.side, orderType: b.orderType, price: market ? '73.5' : b.price, qty: b.qty,
      timeInForce: market ? 'IOC' : b.timeInForce, orderStatus: full ? 'Filled' : 'PartiallyFilledCanceled', cumExecQty: full ? b.qty : '1', avgPrice: '70.11',
      positionIdx: b.positionIdx, reduceOnly: b.reduceOnly, createType: 'CreateByUser', createdTime: String(this.clock), updatedTime: String(this.clock),
    });
    return ok({ orderId: `0000-${this.nextOrder - 1}`, orderLinkId: b.orderLinkId });
  }
}

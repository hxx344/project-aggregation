// Stateful Binance stand-in shared by the connector tests and the executor end-to-end test. No network is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { VenueError, type OrderRequest } from '../src/connector.ts';
import type { AccountBinding } from '../src/contracts.ts';

export const KEY = 'test-key', SECRET = 'test-secret', NOW = 1_800_000_000_000;
export type Row = Record<string, unknown>;
export interface Call { method: string; host: string; path: string; params: URLSearchParams; apiKey: string | null }
// BigInt values are written as bare JSON numbers, like the venue's 64-bit ids.
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? `__big${value}__` : value).replace(/"__big(\d+)__"/g, '$1'), { status, headers: { 'content-type': 'application/json' } });
export const binding = (overrides: Partial<AccountBinding> = {}): AccountBinding => ({ venue: 'binance', environment: 'mainnet', accountId: '123456789', accountMode: 'standard', credentialVersion: 1, ...overrides });
export const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: 'pa1-0123456789abcdef01234567-0', symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '2', type: 'limit', limitPrice: '70.5', timeInForce: 'ioc', reduceOnly: false, ...overrides,
});
export const kind = (expected: string) => (error: unknown) => error instanceof VenueError && error.kind === expected;
export const signal = () => new AbortController().signal;
export const send = (beforeSend: () => void = () => undefined) => ({ signal: signal(), beforeSend });

export const symbolInfo = (overrides: Row = {}): Row => ({
  symbol: 'CLUSDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT',
  orderTypes: ['LIMIT', 'MARKET', 'STOP'], timeInForce: ['GTC', 'IOC', 'FOK', 'GTX'],
  filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '1000' },
    { filterType: 'LOT_SIZE', stepSize: '0.1', minQty: '0.1', maxQty: '10000' },
    { filterType: 'MARKET_LOT_SIZE', stepSize: '0.1', minQty: '0.1', maxQty: '500' },
    { filterType: 'MIN_NOTIONAL', notional: '5' },
  ],
  ...overrides,
});

/** Stateful stand-in: verifies every signature and recvWindow against its own clock, keeps orders by client id. */
export class FakeBinance {
  clock = NOW;
  serverSkew = 0;
  mode: 'one-way' | 'hedge' = 'one-way';
  calls: Call[] = [];
  orders = new Map<string, Row>();
  positions: Row[] = [];
  openOrders: Row[] = [];
  algoOrders: Row[] = [];
  info: Row[] = [symbolInfo()];
  /** One-shot replies by "METHOD path", consumed in order; a function may also hang or throw. */
  scripted = new Map<string, ((call: Call) => Response | Promise<Response>)[]>();
  nextOrderId = 9_007_199_254_740_993n;
  /** apiRestrictions answer of a key that may read and trade standard futures only. */
  restrictions: Row = {
    ipRestrict: true, createTime: NOW - 86_400_000, enableReading: true, enableFutures: true, enablePortfolioMarginTrading: false, enableFixReadOnly: false, enableFixApiTrade: false,
    enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false, enableMargin: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false,
  };
  canTrade = true;
  uid: number | bigint = 123456789;
  /**
   * Exchange mode for the executor end-to-end test: every order fills in full at once and moves a one-way position kept
   * per symbol, which positionRisk then reports instead of `positions`.
   */
  fillAll = false;
  net = new Map<string, number>();

  script(route: string, ...replies: ((call: Call) => Response | Promise<Response>)[]): void { this.scripted.set(route, [...(this.scripted.get(route) ?? []), ...replies]); }
  count(route: string): number { return this.calls.filter(call => `${call.method} ${call.path}` === route).length; }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url), headers = new Headers(init.headers);
    const call: Call = { method: init.method ?? 'GET', host: parsed.origin, path: parsed.pathname, params: parsed.searchParams, apiKey: headers.get('X-MBX-APIKEY') };
    this.calls.push(call);
    assert.equal(init.redirect, 'error');
    const route = `${call.method} ${call.path}`, queue = this.scripted.get(route);
    if (queue?.length) return queue.shift()!(call);
    if (call.path === '/fapi/v1/time') return json({ serverTime: this.clock + this.serverSkew });
    if (call.path === '/fapi/v1/exchangeInfo') return json({ timezone: 'UTC', symbols: this.info });
    if (call.path === '/fapi/v1/ticker/bookTicker') return json({ lastUpdateId: 1027024, symbol: call.params.get('symbol'), bidPrice: '70.10', bidQty: '31.0', askPrice: '70.12', askQty: '12.5', time: this.clock - 250 });
    const refused = this.checkSignature(parsed);
    if (refused) return refused;
    if (call.path === '/sapi/v1/account/apiRestrictions') return json(this.restrictions);
    if (call.path === '/api/v3/account') return json({ uid: this.uid, canTrade: true, balances: [] });
    if (call.path.endsWith('/accountConfig')) return json({ canTrade: this.canTrade, dualSidePosition: this.mode === 'hedge', multiAssetsMargin: false });
    if (call.path.endsWith('/openOrders')) return json(this.openOrders);
    if (call.path.endsWith('openAlgoOrders')) return json(this.algoOrders);
    if (call.path.endsWith('/positionRisk')) {
      if (!this.fillAll) return json(this.positions);
      const symbol = call.params.get('symbol')!, size = this.net.get(symbol) ?? 0;
      return json([{ symbol, positionSide: 'BOTH', positionAmt: size.toFixed(3), marginAsset: 'USDT', entryPrice: size === 0 ? '0' : '70.11' }]);
    }
    if (call.path.endsWith('/order')) return this.order(call);
    return json({ code: -1100, msg: 'unknown path' }, 404);
  };

  checkSignature(url: URL): Response | null {
    const raw = url.search.slice(1), at = raw.lastIndexOf('&signature=');
    assert.ok(at > 0, '签名必须是最后一个参数');
    assert.equal(raw.slice(at + 11), createHmac('sha256', SECRET).update(raw.slice(0, at)).digest('hex'));
    const timestamp = Number(url.searchParams.get('timestamp')), server = this.clock + this.serverSkew;
    assert.equal(url.searchParams.get('recvWindow'), '5000');
    if (timestamp > server + 1000 || server - timestamp > 5000) return json({ code: -1021, msg: 'Timestamp for this request is outside of the recvWindow.' }, 400);
    return null;
  }

  order(call: Call): Response {
    const p = call.params;
    if (call.method === 'POST') {
      const id = p.get('newClientOrderId')!;
      if (this.orders.has(id)) return json({ code: -4116, msg: 'ClientOrderId is duplicated.' }, 400);
      const market = p.get('type') === 'MARKET', full = market || this.fillAll, quantity = Number(p.get('quantity'));
      if (this.fillAll) this.net.set(p.get('symbol')!, (this.net.get(p.get('symbol')!) ?? 0) + (p.get('side') === 'BUY' ? quantity : -quantity));
      const row: Row = {
        orderId: this.nextOrderId++, symbol: p.get('symbol'), status: full ? 'FILLED' : 'EXPIRED', clientOrderId: id, price: market ? '0' : p.get('price'), avgPrice: '70.11',
        origQty: quantity.toFixed(3), executedQty: full ? quantity.toFixed(3) : '1.000', cumQuote: this.fillAll ? (70.11 * quantity).toFixed(4) : '70.11', timeInForce: market ? 'GTC' : p.get('timeInForce'), type: p.get('type'), origType: p.get('type'),
        reduceOnly: p.get('reduceOnly') === 'true', closePosition: false, side: p.get('side'), positionSide: p.get('positionSide') ?? 'BOTH', updateTime: this.clock,
      };
      this.orders.set(id, row);
      return json(row);
    }
    const row = this.orders.get(p.get('origClientOrderId')!);
    if (call.method === 'GET') return row ? json(row) : json({ code: -2013, msg: 'Order does not exist.' }, 400);
    if (!row || row.status !== 'NEW') return json({ code: -2011, msg: 'Unknown order sent.' }, 400);
    row.status = 'CANCELED';
    return json(row);
  }
}

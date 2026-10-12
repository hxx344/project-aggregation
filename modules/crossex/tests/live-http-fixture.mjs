import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import { createApp } from '../server/app.mjs';
import { createGateClient } from '../server/live-client.mjs';
import { pairKey } from '../server/model.mjs';

const ACTIVE = new Set(['NEW', 'OPEN', 'PARTIALLY_FILLED']);
const clone = value => JSON.parse(JSON.stringify(value));
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
class FixtureSocket extends EventEmitter {
  readyState = 1;
  constructor() { super(); queueMicrotask(() => this.emit('open')); }
  send() {}
  ping() {}
  close() { this.readyState = 3; this.emit('close'); }
}

function quote(exchange, at, base = 'BTC', currency = 'USDT') {
  const reference = base === 'BTC' ? 100 : 20;
  return { exchange, symbol: exchange === 'bybit' && currency === 'USDC' ? `${base}PERP` : `${base}${currency}`, crossexSymbol: `${exchange.toUpperCase()}_FUTURE_${base}_${currency}`,
    base, quoteCurrency: currency, collateralCurrency: currency, settlementCurrency: currency, counterCurrency: currency,
    contractKind: 'linear', multiplier: 1, assetClass: 'crypto', identitySource: 'isolated-http-fixture', identityVerified: true,
    bid: reference + (exchange === 'binance' ? -1 : 2), ask: reference + (exchange === 'binance' ? 0 : 3), bidAskAt: at, receivedAt: at };
}
function feed() {
  const at = Date.now(), long = quote('binance', at), short = quote('bybit', at);
  const signal = { id: 'fixture-btc', base: 'BTC', quoteCurrency: 'USDT', long, short, observedAt: at, expiresAt: at + 10000 };
  return { schemaVersion: 1, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual', generatedAt: at, status: 'live',
    exchanges: [{ id: 'binance', status: 'live' }, { id: 'bybit', status: 'live' }], quotes: [long, short], signals: [{ ...signal, pairKey: pairKey(signal) }] };
}
function position(symbol, side, quantity, id) {
  return { user_id: '12345', position_id: id, symbol, position_side: side, position_qty: quantity,
    entry_price: symbol.includes('_BTC_') ? '100' : '20', mark_price: symbol.includes('_BTC_') ? '101' : '21',
    initial_margin: '10', upnl: '1.25', liq_price: '1', margin_mode: 'CROSS', update_time: String(Date.now()) };
}

/** Real HTTP/app/runtime/market/client; every remote read and write is isolated here. */
export async function createLiveHttpFixture({ dataDir, distDir, intervalMs = 0 } = {}) {
  const tempRoot = realpathSync(tmpdir()), owned = dataDir === undefined;
  const directory = owned ? mkdtempSync(join(tempRoot, 'crossex-live-http-')) : resolve(dataDir);
  const credentials = { apiKey: 'fixture-only-key', apiSecret: 'fixture-only-secret' };
  const password = 'isolated-http-fixture-password';
  const calls = [], reads = new Map(), applied = new Map();
  let orderSequence = 0, positionSequence = 0, csrfToken = '', closed = false;
  const remote = {
    account: { user_id: '12345', position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX',
      available_margin: '9876.50', margin_balance: '10000', initial_margin: '123.50', maintenance_margin: '30', initial_margin_rate: '0.01235', maintenance_margin_rate: '0.003',
      assets: [{ coin: 'USDT', exchange_type: 'CROSSEX', balance: '10000', equity: '10000', available_balance: '9876.50', upnl: '0' },
        { coin: 'USDC', exchange_type: 'BYBIT', balance: '250', equity: '252.50', available_balance: '240', upnl: '2.50' }] },
    positions: [], orders: [], trades: [], accountBook: [], nextCreate: 'fill', fillAfterReads: 2, marketOffline: false, depthDelta: 0,
  };
  function addOrder(input = {}) {
    const now = String(Date.now());
    const row = { user_id: remote.account.user_id, order_id: `fixture-order-${++orderSequence}`, text: `fixture-external-${orderSequence}`,
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'IOC', reduce_only: 'false', position_side: 'LONG',
      qty: '0.5', price: '100', state: 'OPEN', executed_qty: '0', executed_amount: '0', executed_avg_price: '0', create_time: now, update_time: now, ...input };
    remote.orders.push(row); return row;
  }
  function fill(orderOrId, quantity) {
    const row = typeof orderOrId === 'string' ? remote.orders.find(o => o.order_id === orderOrId || o.text === orderOrId) : orderOrId;
    assert.ok(row, 'Unknown isolated fixture order');
    const total = new Decimal(quantity ?? row.qty), previous = new Decimal(applied.get(row.order_id) ?? '0');
    assert.ok(total.gte(previous) && total.lte(row.qty));
    const delta = total.minus(previous), side = row.position_side === 'NONE' ? (row.side === 'BUY' ? 'LONG' : 'SHORT') : row.position_side;
    let held = remote.positions.find(p => p.symbol === row.symbol && p.position_side === row.position_side);
    if (!held && delta.gt(0)) {
      assert.notEqual(row.reduce_only, 'true', 'Reduce-only fixture order cannot open a position');
      held = position(row.symbol, row.position_side, '0', `fixture-position-${++positionSequence}`); remote.positions.push(held);
    }
    if (held) {
      const remaining = new Decimal(held.position_qty).abs().plus(row.reduce_only === 'true' ? delta.negated() : delta);
      assert.ok(remaining.gte(0), 'Reduce-only fixture order cannot cross zero');
      held.position_qty = remaining.toString(); held.entry_price = row.price; held.update_time = String(Date.now());
      if (row.position_side === 'NONE') held.fixtureDirection = side;
    }
    applied.set(row.order_id, total.toString()); row.executed_qty = total.toString();
    row.executed_amount = total.times(row.price).toString(); row.executed_avg_price = total.gt(0) ? row.price : '0';
    row.state = total.eq(row.qty) ? 'FILLED' : 'PARTIALLY_FILLED'; row.update_time = String(Date.now()); return row;
  }
  function fakeFetch(secret) {
    return async (input, init = {}) => {
      const url = new URL(input), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : undefined;
      assert.equal(url.origin, 'https://api.gateio.ws', 'No remote request can escape this fixture');
      assert.ok(url.pathname.startsWith('/api/v4/'));
      const headers = new Headers(init.headers), payload = init.body || '';
      const signed = [method, url.pathname, url.search.slice(1), createHash('sha512').update(payload).digest('hex'), headers.get('Timestamp')].join('\n');
      const route = url.pathname.replace('/api/v4', '');
      const isPublic = route === '/crossex/rule/risk_limits';
      if (isPublic) assert.equal(headers.get('SIGN'), null);
      else assert.equal(headers.get('SIGN'), createHmac('sha512', secret).update(signed).digest('hex'));
      calls.push({ method, path: url.pathname, query: url.search.slice(1), ...(body ? { body: clone(body) } : {}), signatureVerified: !isPublic, public: isPublic });
      if (method === 'GET' && route === '/account/detail') return response({ user_id: Number(remote.account.user_id) });
      if (method === 'GET' && route === '/crossex/accounts') return response(remote.account);
      if (method === 'GET' && route === '/crossex/positions/leverage') return response(Object.fromEntries(url.searchParams.get('symbols').split(',').map(s => [s, '3'])));
      if (method === 'GET' && isPublic) return response(url.searchParams.get('symbols').split(',').map(symbol => ({ symbol, tiers: [{ tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '1000000', leverage_max: '20', quick_cal_amount: '0', maintenance_rate: '0.005' }] })));
      if (method === 'GET' && route === '/crossex/fee') return response(['BINANCE', 'BYBIT'].map(exchange_type => ({ exchange_type, future_maker_fee: '0.0002', future_taker_fee: '0.0005' })));
      if (method === 'GET' && route === '/crossex/account_book') return response(remote.accountBook);
      if (method === 'GET' && route === '/crossex/adl_rank') return response([{ symbol: url.searchParams.get('symbol'), crossex_adl_rank: '1', exchange_adl_rank: '1' }]);
      if (method === 'GET' && route === '/crossex/positions') return response(remote.positions);
      if (method === 'GET' && route === '/crossex/open_orders') return response(remote.orders.filter(o => ACTIVE.has(o.state)));
      if (method === 'GET' && route === '/crossex/history_orders') {
        const rows = remote.orders.filter(o => (!url.searchParams.has('symbol') || o.symbol === url.searchParams.get('symbol'))
          && Number(o.create_time) <= Number(url.searchParams.get('to')) && (!url.searchParams.has('from') || Number(o.create_time) >= Number(url.searchParams.get('from'))));
        const offset = (Number(url.searchParams.get('page') || 1) - 1) * Number(url.searchParams.get('limit') || 100);
        return response(rows.slice(offset, offset + Number(url.searchParams.get('limit') || 100)));
      }
      if (method === 'GET' && route === '/crossex/history_trades') return response(remote.trades);
      if (method === 'POST' && route === '/crossex/orders') {
        const behavior = remote.nextCreate; remote.nextCreate = 'fill';
        const row = addOrder(body); reads.set(row.order_id, behavior === 'fill' ? 0 : null);
        if (behavior === 'unknown') throw new Error('Isolated accepted order response was lost');
        return response({ order_id: row.order_id, text: row.text });
      }
      const match = route.match(/^\/crossex\/orders\/([A-Za-z0-9_-]+)$/);
      if (match) {
        const row = remote.orders.find(o => o.order_id === match[1] || o.text === match[1]);
        if (!row) return response({ label: 'TRADE_ORDER_NOT_FOUND_ERROR' }, 404);
        if (method === 'DELETE') return response({ order_id: row.order_id, text: row.text });
        if (method === 'GET') {
          if (reads.get(row.order_id) != null && ACTIVE.has(row.state)) {
            const count = reads.get(row.order_id) + 1; reads.set(row.order_id, count);
            if (count >= remote.fillAfterReads) fill(row);
          }
          return response(row);
        }
      }
      throw new Error(`Unimplemented isolated Gate request: ${method} ${route}`);
    };
  }
  const catalog = ['BINANCE', 'BYBIT'].flatMap(exchange => ['BTC_USDT', 'ETH_USDC'].map(pair => ({
    symbol: `${exchange}_FUTURE_${pair}`, exchange_type: exchange, business_type: 'FUTURE', state: 'live', min_size: '0.001', lot_size: '0.001',
    tick_size: '0.01', min_notional: '5', max_market_size: '10000', max_limit_size: '10000', delist_time: '0',
  })));
  const app = createApp({ dataDir: directory, initialPassword: password, intervalMs, ...(distDir ? { distDir } : {}), logger: () => {},
    marketOptions: { feedReader: async () => { if (remote.marketOffline) throw new Error('Isolated Monitor offline'); return feed(); },
      catalogReader: async () => clone(catalog), depthReader: async q => ({ at: Date.now(), bids: [[q.bid + remote.depthDelta, 100]], asks: [[q.ask + remote.depthDelta, 100]] }),
      identityReader: async symbol => { const [exchange, , base, currency] = symbol.split('_'); return quote(exchange.toLowerCase(), Date.now(), base, currency); },
      fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: { USDC: { bid: 1, ask: 1, at: Date.now(), source: 'isolated-http-fixture' } } }) },
    terminalOptions: { WebSocketImpl: FixtureSocket,
      depthReader: async q => ({ at: Date.now(), bids: [[q.bid, 100], [q.bid - 0.1, 150]], asks: [[q.ask, 100], [q.ask + 0.1, 150]] }),
      candleReader: async (q, interval) => {
        const ms = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 }[interval], latest = Math.floor(Date.now() / ms) * ms;
        return Array.from({ length: 48 }, (_, i) => { const base = q.bid + Math.sin(i / 5); return { time: latest - (47 - i) * ms, open: String(base), high: String(base + 0.4), low: String(base - 0.3), close: String(base + 0.2), volume: '10' }; });
      } },
    liveOptions: { confirmationPollMs: 1000, pollIntervalMs: 2, requestTimeoutMs: 1000,
      clientFactory: options => createGateClient({ ...options, timeoutMs: 1000, fetcher: fakeFetch(options.apiSecret) }) },
  });
  await app.market.refresh();
  await new Promise((resolveListen, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolveListen); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, auth = true, csrf = true, headers = {}, raw = false } = {}) {
    if (!['GET', 'HEAD'].includes(method) && csrf && !csrfToken) await request('/api/state');
    const outgoing = { ...(auth ? { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { Origin: origin, ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
    const result = await fetch(`${origin}${path}`, { method, headers: outgoing, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (raw) return result;
    const data = await result.json(); if (data.csrfToken) csrfToken = data.csrfToken;
    return { status: result.status, data, headers: result.headers };
  }
  function seed(enabled = true) {
    remote.positions = remote.positions.filter(p => !p.position_id.startsWith('fixture-seed-'));
    if (enabled) remote.positions.push(position('BINANCE_FUTURE_ETH_USDC', 'LONG', '2', 'fixture-seed-long'), position('BYBIT_FUTURE_ETH_USDC', 'SHORT', '2', 'fixture-seed-short'));
    return remote.positions;
  }
  async function close() {
    if (closed) return; closed = true; await app.close();
    if (owned) {
      const target = realpathSync(directory), rel = relative(tempRoot, target);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('crossex-live-http-'), 'Unsafe fixture cleanup');
      rmSync(target, { recursive: true, force: true });
    }
  }
  return { app, request, origin, calls, remote, seed, fill, addOrder, close, directory, credentials, username: 'admin', password,
    connect: () => request('/api/live/connection', { method: 'PUT', body: credentials }),
    get orders() { return remote.orders; }, get positions() { return remote.positions; } };
}

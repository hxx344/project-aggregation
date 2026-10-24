import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFundingClient } from '../server/funding-client.mjs';

const HOUR = 3_600_000, SETTLED = Date.UTC(2026, 8, 23, 12), NOW = SETTLED + 600_000;
function quote(exchange) {
  const currency = exchange === 'kraken' ? 'USD' : exchange === 'lighter' ? 'USDC' : 'USDT';
  const settle = exchange === 'hyperliquid' ? 'USDC' : currency;
  return { exchange, symbol: { binance: 'BTCUSDT', bybit: 'BTCUSDT', okx: 'BTC-USDT-SWAP', gate: 'BTC_USDT', kraken: 'PF_XBTUSD', hyperliquid: 'BTC', lighter: 'BTC' }[exchange], base: 'BTC', rawBase: 'BTC', quoteCurrency: currency, settlementCurrency: settle, collateralCurrency: exchange === 'kraken' ? 'MULTI' : settle, counterCurrency: settle, contractKind: exchange === 'hyperliquid' ? 'quanto' : 'linear', crossexSymbol: `${exchange.toUpperCase()}_FUTURE_BTC_${settle}`, multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'official-fixture', marketId: 1 };
}
function fixture(venue, override = () => undefined) {
  const q = quote(venue), requests = [];
  const responses = {
    '/fapi/v1/fundingRate': [{ symbol: q.symbol, fundingTime: SETTLED, fundingRate: '0.0001', markPrice: '65000', rateType: 'Regular' }],
    '/fapi/v1/premiumIndex': { symbol: q.symbol, lastFundingRate: '0.00012', nextFundingTime: SETTLED + 8 * HOUR, markPrice: '65500', time: NOW },
    '/fapi/v1/fundingInfo': [],
    '/v5/market/funding/history': { retCode: 0, result: { category: 'linear', list: [{ symbol: q.symbol, fundingRateTimestamp: String(SETTLED), fundingRate: '-0.0002' }] } },
    '/v5/market/tickers': { retCode: 0, time: NOW, result: { category: 'linear', list: [{ symbol: q.symbol, fundingRate: '0.0003', nextFundingTime: String(SETTLED + 4 * HOUR), markPrice: '65000' }] } },
    '/v5/market/instruments-info': { retCode: 0, result: { list: [{ symbol: q.symbol, fundingInterval: 240 }] } },
    '/api/v5/public/funding-rate-history': { code: '0', data: [{ instId: q.symbol, instType: 'SWAP', fundingTime: String(SETTLED), fundingRate: '0.99', realizedRate: '-0.0004' }] },
    '/api/v5/public/funding-rate': { code: '0', data: [{ instId: q.symbol, fundingRate: '0.0001', fundingTime: String(SETTLED + 4 * HOUR), nextFundingTime: String(SETTLED + 8 * HOUR), ts: String(NOW) }] },
    '/api/v4/futures/usdt/funding_rate': [{ t: SETTLED / 1000, r: '0.0001' }],
    '/api/v4/futures/usdt/contracts/BTC_USDT': { name: 'BTC_USDT', type: 'direct', in_delisting: false, funding_rate: '0.0001', funding_interval: 14400, funding_next_apply: (SETTLED + 4 * HOUR) / 1000, mark_price: '65000' },
    '/derivatives/api/v3/historical-funding-rates': { result: 'success', serverTime: new Date(NOW).toISOString(), rates: [SETTLED - HOUR, SETTLED].map(at => ({ timestamp: new Date(at).toISOString(), fundingRate: '6.5', relativeFundingRate: '0.0001' })) },
    '/api/v1/orderBookDetails': { code: 200, order_book_details: [{ market_id: 1, symbol: 'BTC', market_type: 'perp', status: 'active', multiplier: '1', funding_premium_multiplier: 100 }] },
    '/api/v1/fundings': { code: 200, resolution: '1h', fundings: [{ timestamp: SETTLED / 1000, rate: '0.0012', direction: 'short', value: '0.78' }] },
    fundingHistory: [{ coin: 'BTC', time: SETTLED, fundingRate: '0.0000125', premium: '0' }],
    metaAndAssetCtxs: [{ collateralToken: 0, universe: [{ name: 'BTC' }] }, [{ funding: '0.000013', markPx: '65000', oraclePx: '64800' }]],
  };
  const fetcher = async (url, init) => {
    requests.push({ url, init }); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers.APIKey, undefined);
    const u = new URL(url), key = init.method === 'POST' ? JSON.parse(init.body).type : u.pathname;
    if (init.method === 'POST') { assert.equal(url, 'https://api.hyperliquid.xyz/info'); assert.ok(['fundingHistory', 'metaAndAssetCtxs'].includes(key)); } else assert.equal(init.method, 'GET');
    const replaced = override(key, responses[key], requests, u);
    if (replaced instanceof Response) return replaced;
    const value = replaced ?? responses[key]; assert.notEqual(value, undefined, key);
    return new Response(JSON.stringify(value));
  };
  return { q, requests, fetcher, client: createFundingClient({ fetcher, clock: () => NOW }) };
}
for (const venue of ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter']) test(`${venue}: native public funding schema, sign, timestamps and price quality`, async () => {
  const f = fixture(venue), value = await f.client.read(f.q, SETTLED - HOUR + 1, NOW);
  assert.equal(value.exchange, venue); assert.equal(value.complete, true, value.error); assert.ok(value.settlements.length);
  assert.equal(value.settlements[0].at, SETTLED);
  assert.equal(value.settlements[0].markPrice, venue === 'binance' ? '65000' : null);
  if (venue === 'bybit') { assert.equal(value.settlements[0].rate, '-0.0002'); assert.equal(value.current.intervalHours, 4); }
  if (venue === 'okx') assert.equal(value.settlements[0].rate, '-0.0004');
  if (venue === 'lighter') { assert.equal(value.settlements[0].rate, '-0.000012'); assert.equal(value.current, null); }
  if (venue === 'kraken') { assert.equal(value.settlements[0].unit, 'per_base'); assert.equal(value.accruals.length, 2); assert.equal(value.accruals[0].accrualStart, SETTLED - HOUR); }
});
test('identity failure performs no requests and cannot use an injected venue URL', async () => {
  const f = fixture('binance'); const value = await f.client.read({ ...f.q, symbol: 'BTCUSDT?redirect=http://evil', exchange: 'http://evil' }, SETTLED, NOW);
  assert.equal(value.complete, false); assert.equal(value.coveredTo, null); assert.equal(f.requests.length, 0);
});
test('wrong response symbol and unrealized-only OKX rows fail closed', async () => {
  for (const venue of ['binance', 'bybit', 'okx']) {
    const f = fixture(venue, (key, data) => {
      if (!/fundingRate$|funding\/history$|funding-rate-history$/.test(key)) return;
      const copy = structuredClone(data); if (venue === 'binance') copy[0].symbol = 'ETHUSDT';
      else if (venue === 'bybit') copy.result.list[0].symbol = 'ETHUSDT'; else copy.data[0].realizedRate = '';
      return copy;
    });
    assert.equal((await f.client.read(f.q, SETTLED - 1, NOW)).complete, false);
  }
});
test('missing historical rows stay unknown unless a native schedule excludes all settlements', async () => {
  const f = fixture('binance', key => key === '/fapi/v1/fundingRate' ? [] : undefined);
  assert.equal((await f.client.read(f.q, SETTLED - HOUR, NOW)).complete, false);
  const g = fixture('binance', key => key === '/fapi/v1/fundingRate' ? [] : undefined);
  assert.equal((await g.client.read(g.q, SETTLED + 1, NOW)).complete, true);
});
test('a failed current snapshot does not discard successful settled history', async () => {
  const f = fixture('binance', key => key === '/fapi/v1/premiumIndex' ? new Response('', { status: 503 }) : undefined);
  const result = await f.client.read(f.q, SETTLED - 1, NOW);
  assert.equal(result.complete, true); assert.equal(result.current, null); assert.equal(result.settlements[0].markPrice, '65000');
});
test('single-flight, cached results and per-venue cooldown bound request bursts', async () => {
  const f = fixture('binance'); const values = await Promise.all(Array.from({ length: 8 }, () => f.client.read(f.q, SETTLED - 1, NOW)));
  assert.ok(values.every(v => v.complete)); assert.equal(f.requests.length, 3);
  await f.client.read(f.q, SETTLED - 1, NOW); assert.equal(f.requests.length, 3);
  const cooldown = await f.client.read(f.q, SETTLED - HOUR, NOW); assert.match(cooldown.error, /冷却/); assert.equal(f.requests.length, 3);
});
test('pagination has a fixed three-page ceiling and reports uncovered range', async () => {
  const from = SETTLED - 100 * HOUR, f = fixture('binance', (key, data, requests, url) => {
    if (key === '/fapi/v1/fundingRate') { const start = Number(url.searchParams.get('startTime')); return Array.from({ length: 1000 }, (_, i) => ({ symbol: 'BTCUSDT', fundingTime: start + i + 1, fundingRate: '0', markPrice: '65000' })); }
  });
  const result = await f.client.read(f.q, from, NOW);
  assert.equal(result.complete, false); assert.equal(result.settlements.length, 3000); assert.ok(result.coveredTo < NOW);
  assert.equal(f.requests.filter(x => new URL(x.url).pathname === '/fapi/v1/fundingRate').length, 3);
});
test('conflicting repeated timestamps, future settlements and changed Lighter market identity reject', async () => {
  for (const change of ['duplicate', 'future']) {
    const f = fixture('binance', (key, data) => key === '/fapi/v1/fundingRate' ? change === 'duplicate' ? [data[0], { ...data[0], fundingRate: '0.3' }] : [{ ...data[0], fundingTime: NOW + HOUR }] : undefined);
    assert.equal((await f.client.read(f.q, SETTLED - 1, NOW)).complete, false);
  }
  const f = fixture('lighter', (key, data) => key === '/api/v1/orderBookDetails' ? { ...data, order_book_details: [{ ...data.order_book_details[0], symbol: 'ETH' }] } : undefined);
  assert.equal((await f.client.read(f.q, SETTLED - 1, NOW)).complete, false);
  assert.equal(f.requests.some(x => new URL(x.url).pathname === '/api/v1/fundings'), false);
});
test('oversized decoded body, redirect and HTTP errors remain unknown', async () => {
  for (const value of [new Response('x'.repeat(8 * 1024 * 1024 + 1)), new Response('', { status: 302 }), new Response('', { status: 429 })]) {
    const f = fixture('binance', key => key === '/fapi/v1/fundingRate' ? value : undefined);
    const result = await f.client.read(f.q, SETTLED - 1, NOW); assert.equal(result.complete, false); assert.equal(result.coveredTo, null);
  }
});
test('deadline aborts a stalled request and stale native current data cannot prove a zero interval', async () => {
  let aborted = 0;
  const client = createFundingClient({ clock: () => NOW, timeoutMs: 5, fetcher: async (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted++; reject(new Error('deadline')); }, { once: true })) });
  assert.equal((await client.read(quote('binance'), SETTLED - 1, NOW)).complete, false); assert.equal(aborted, 3);
  const f = fixture('binance', (key, data) => key === '/fapi/v1/fundingRate' ? [] : key === '/fapi/v1/premiumIndex' ? { ...data, time: NOW - HOUR } : undefined);
  const result = await f.client.read(f.q, SETTLED + 1, NOW); assert.equal(result.complete, false); assert.equal(result.current, null);
});
test('Kraken gaps and stale response clocks cannot confirm continuous coverage', async () => {
  const f = fixture('kraken', (key, data) => key.includes('historical-funding-rates') ? { ...data, rates: [data.rates[0]] } : undefined);
  assert.equal((await f.client.read(f.q, SETTLED - HOUR + 1, NOW)).complete, false);
  const g = fixture('kraken', (key, data) => key.includes('historical-funding-rates') ? { ...data, serverTime: new Date(SETTLED - HOUR).toISOString() } : undefined);
  assert.equal((await g.client.read(g.q, SETTLED - HOUR + 1, NOW)).coveredFrom, null);
});
class FakeStream extends EventEmitter {
  static messages = []; static sent = [];
  constructor(url) { super(); FakeStream.url = url; queueMicrotask(() => this.emit('open')); }
  send(value) { FakeStream.sent.push(JSON.parse(value)); for (const message of FakeStream.messages) queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify(message)))); }
  terminate() { this.terminated = true; }
}
const manual = q => ({ ...q, identityScope: 'manual', identitySource: 'exchange-instrument-metadata', nativeUnit: '1', comparable: true });
test('current rate accepts native held identities without a Monitor or Binance proof', async () => {
  const f = fixture('bybit');
  const value = await f.client.current(manual(f.q));
  assert.deepEqual(value, { rate: '0.0003', intervalHours: 4, nextFundingAt: SETTLED + 4 * HOUR, sourceAt: NOW, markPrice: '65000' });
  assert.deepEqual(f.requests.map(x => new URL(x.url).pathname).sort(), ['/v5/market/instruments-info', '/v5/market/tickers']);
  const okx = fixture('okx'); assert.equal((await okx.client.current(manual(okx.q))).intervalHours, 4);
});
test('current rate rejects invalid identities before IO and venues without a verified current feed', async () => {
  const f = fixture('binance');
  await assert.rejects(f.client.current({ ...f.q, exchange: 'http://evil' }), /身份无效/); assert.equal(f.requests.length, 0);
  const kraken = fixture('kraken'); await assert.rejects(kraken.client.current(kraken.q), /未提供/);
  const stale = fixture('binance', (key, data) => key === '/fapi/v1/premiumIndex' ? { ...data, time: NOW - 180_001 } : undefined);
  await assert.rejects(stale.client.current(stale.q), /新鲜来源时间/);
});
test('Bybit ticker interval overrides lagging metadata, and an invalid one never falls back', async () => {
  const ticker = hour => (key, data) => key === '/v5/market/tickers' ? { ...data, result: { ...data.result, list: [{ ...data.result.list[0], fundingIntervalHour: hour }] } }
    : key === '/v5/market/instruments-info' ? { ...data, result: { list: [{ symbol: 'BTCUSDT', fundingInterval: 480 }] } } : undefined;
  const f = fixture('bybit', ticker('1'));
  assert.equal((await f.client.current(manual(f.q))).intervalHours, 1);
  assert.deepEqual(f.requests.map(x => new URL(x.url).pathname), ['/v5/market/tickers']);
  const bad = fixture('bybit', ticker('0'));
  assert.equal((await bad.client.current(manual(bad.q))).intervalHours, null);
  assert.equal(bad.requests.length, 1);
});
test('Binance fundingInfo is shared for a minute across current reads, and 418/429 cool the venue', async () => {
  let now = NOW, limited = false;
  const f = fixture('binance', (key, data) => key !== '/fapi/v1/premiumIndex' ? undefined : limited ? new Response('', { status: 429 }) : { ...data, time: now });
  const client = createFundingClient({ fetcher: f.fetcher, clock: () => now });
  const count = path => f.requests.filter(x => new URL(x.url).pathname === path).length;
  await Promise.all([1, 2, 3].map(() => client.current(f.q)));
  assert.deepEqual([count('/fapi/v1/fundingInfo'), count('/fapi/v1/premiumIndex')], [1, 3]);
  now += 59_999; await client.current(f.q); assert.equal(count('/fapi/v1/fundingInfo'), 1);
  now += 1; await client.current(f.q); assert.equal(count('/fapi/v1/fundingInfo'), 2);
  limited = true; await assert.rejects(client.current(f.q), /429/);
  limited = false; const before = f.requests.length;
  now += 59_999; await assert.rejects(client.current(f.q), /冷却/); assert.equal(f.requests.length, before);
  now += 1; assert.equal((await client.current(f.q)).rate, '0.00012');
});
test('a 429 on one parallel Binance leg is not masked by another leg failing first', async () => {
  const f = fixture('binance', key => key === '/fapi/v1/premiumIndex' ? new Response('', { status: 503 }) : key === '/fapi/v1/fundingInfo' ? new Response('', { status: 429 }) : undefined);
  await assert.rejects(f.client.current(f.q), error => error.status === 429);
  const before = f.requests.length;
  await assert.rejects(f.client.current(f.q), /冷却/); assert.equal(f.requests.length, before);
});
test('a current cooldown voided by clock rollback is discarded', async () => {
  let now = NOW, limited = true;
  const f = fixture('okx', key => key === '/api/v5/public/funding-rate' && limited ? new Response('', { status: 429 }) : undefined);
  const client = createFundingClient({ fetcher: f.fetcher, clock: () => now });
  await assert.rejects(client.current(f.q), /429/);
  limited = false; now -= HOUR; await assert.rejects(client.current(f.q), /新鲜来源时间/);
  now = NOW + 30_000; await client.current(f.q).catch(() => {});
  assert.equal(f.requests.length, 3, 'the old deadline does not block a request after time catches up');
});
test('Lighter current rate reads one public market_stats snapshot in hourly percentage points', async () => {
  const q = quote('lighter'), client = createFundingClient({ clock: () => NOW, WebSocketImpl: FakeStream, fetcher: async () => { throw new Error('no HTTP'); } });
  FakeStream.sent = []; FakeStream.messages = [{ type: 'connected' }, { channel: 'market_stats:1', type: 'subscribed/market_stats', timestamp: NOW, market_stats: { market_id: 1, symbol: 'BTC', current_funding_rate: '0.0012' } }];
  const value = await client.current(q);
  assert.equal(FakeStream.url, 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true');
  assert.deepEqual(FakeStream.sent, [{ type: 'subscribe', channel: 'market_stats/1' }]);
  assert.deepEqual([value.rate, value.intervalHours, value.nextFundingAt, value.sourceAt], ['0.000012', 1, (Math.floor(NOW / HOUR) + 1) * HOUR, NOW]);
  FakeStream.messages = [{ channel: 'market_stats:1', timestamp: NOW, market_stats: { market_id: 1, symbol: 'ETH', current_funding_rate: '0.0012' } }];
  await assert.rejects(client.current(q), /合约不一致/);
  FakeStream.messages = [{ channel: 'market_stats:1', timestamp: NOW - 180_001, market_stats: { market_id: 1, current_funding_rate: '0.0012' } }];
  await assert.rejects(client.current(q), /新鲜来源时间/);
});

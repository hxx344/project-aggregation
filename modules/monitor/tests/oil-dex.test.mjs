import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOilDexReader, parseLighterOilMarkets, parseLighterOilObservation, parseLighterOilQuote, parseVariationalOilQuote, readLighterOilSnapshot } from '../lib/oil-dex.ts';
import { calculateExchangeSpread } from '../lib/exchange-quotes.ts';

const NOW = Date.UTC(2026, 9, 1, 10, 32), HOUR = 3_600_000;
function metadata() {
  return { code: 200, order_book_details: [
    { symbol: 'BRENTOIL', market_id: 901, market_type: 'perp', status: 'active', multiplier: '1' },
    { symbol: 'WTI', market_id: 802, market_type: 'perp', status: 'active', multiplier: '1' },
  ] };
}
function message(market, { now = NOW, rate = '-0.0009', index = '100.16' } = {}) {
  return { type: 'subscribed/market_stats', channel: `market_stats:${market.marketId}`, timestamp: now,
    market_stats: { symbol: market.symbol, market_id: market.marketId, mark_price: market.symbol === 'WTI' ? '91.8' : '100.1', index_price: index, current_funding_rate: rate, funding_rate: '0.0050', funding_timestamp: NOW - HOUR } };
}
function observations() {
  return parseLighterOilMarkets(metadata()).map(market => parseLighterOilObservation(message(market), market, NOW));
}
function stats() {
  return { listings: [
    { ticker: 'BZ', name: 'Brent Oil', mark_price: '100.05', funding_rate: '-0.235027', funding_interval_s: 14400, quotes: { updated_at: '2020-01-01T00:00:00Z' } },
    { ticker: 'CL', name: 'WTI Crude Oil', mark_price: '91.77', funding_rate: '0', funding_interval_s: 14400 },
    { ticker: 'UKOILP', name: 'Swap on Brent Crude Oil', mark_price: '1', funding_rate: '0', funding_interval_s: 0 },
    { ticker: 'USOILP', name: 'Swap on WTI Crude Oil', mark_price: '1', funding_rate: '0', funding_interval_s: 0 },
  ] };
}

test('Lighter resolves dynamic IDs and rejects duplicate, inactive, non-perp and scaled oil contracts', () => {
  assert.deepEqual(parseLighterOilMarkets(metadata()), [{ symbol: 'BRENTOIL', marketId: 901 }, { symbol: 'WTI', marketId: 802 }]);
  for (const [key, value] of [['status', 'inactive'], ['market_type', 'spot'], ['multiplier', '100'], ['multiplier', ''], ['market_id', -1], ['market_id', 802], ['is_frozen', true]]) {
    const input = metadata(); input.order_book_details[0][key] = value;
    assert.throws(() => parseLighterOilMarkets(input));
  }
  const duplicate = metadata(); duplicate.order_book_details.push(duplicate.order_book_details[0]);
  assert.throws(() => parseLighterOilMarkets(duplicate));
  const single = metadata(); single.order_book_details.pop();
  assert.throws(() => parseLighterOilMarkets(single));
});

test('Lighter mark spread uses upcoming hourly percentage funding and index-weighted cash flow', () => {
  const items = observations();
  items[1] = parseLighterOilObservation(message(parseLighterOilMarkets(metadata())[1], { rate: '0.0004', index: '91.81' }), parseLighterOilMarkets(metadata())[1], NOW);
  const q = parseLighterOilQuote(items, NOW);
  assert.equal(q.currency, 'USDC'); assert.equal(q.timestampBasis, 'source');
  assert.equal(q.fundingPriceBasis, 'index'); assert.equal(q.left.price, 100.1); assert.equal(q.left.fundingPrice, 100.16);
  assert.equal(q.left.fundingRate, -0.000009); assert.equal(q.right.fundingRate, 0.000004);
  assert.equal(q.left.fundingIntervalHours, 1); assert.equal(q.left.nextFundingEstimated, true);
  assert.equal(q.left.nextFundingAt, '2026-10-01T11:00:00.000Z');
  assert.ok(Math.abs(calculateExchangeSpread(q).shortAnnualized - ((100.16 * -0.000009 - 91.81 * 0.000004) / (100.16 + 91.81) * 8760)) < 1e-12);
});

test('Lighter missing current funding or index preserves prices without substituting last payment; zero is real zero', () => {
  const markets = parseLighterOilMarkets(metadata());
  for (const patch of [{ current_funding_rate: undefined }, { current_funding_rate: '' }, { index_price: '' }]) {
    const input = message(markets[0]); Object.assign(input.market_stats, patch);
    const q = parseLighterOilQuote([parseLighterOilObservation(input, markets[0], NOW), observations()[1]], NOW);
    assert.equal(q.left.price, 100.1); assert.equal(q.left.fundingRate, null); assert.equal(q.right.fundingRate, null);
    assert.equal(q.fundingFetchedAt, null); assert.equal(calculateExchangeSpread(q).shortAnnualized, null);
  }
  const zero = markets.map(market => parseLighterOilObservation(message(market, { rate: '0' }), market, NOW));
  assert.equal(calculateExchangeSpread(parseLighterOilQuote(zero, NOW)).shortAnnualized, 0);
});

test('Lighter rejects source time/identity errors and unsynchronized or missing legs; boundary funding is withheld', () => {
  const markets = parseLighterOilMarkets(metadata());
  for (const value of [NOW - 120001, NOW + 60001, null, '', 0]) {
    assert.throws(() => parseLighterOilObservation(message(markets[0], { now: value }), markets[0], NOW));
  }
  const wrong = message(markets[0]); wrong.market_stats.symbol = 'WTI';
  assert.throws(() => parseLighterOilObservation(wrong, markets[0], NOW));
  const items = observations(); items[1].sourceTime -= 15001;
  assert.throws(() => parseLighterOilQuote(items, NOW));
  assert.throws(() => parseLighterOilQuote(observations().slice(0, 1), NOW));
  const boundary = Date.UTC(2026, 9, 1, 11);
  const boundaryRows = markets.map((market, i) => parseLighterOilObservation(message(market, { now: boundary - (i ? 0 : 1000) }), market, boundary));
  assert.equal(parseLighterOilQuote(boundaryRows, boundary).fundingFetchedAt, null);
});

test('Variational uses exact CL/BZ marks in USDC with receipt time, never cached quote time or unproven funding', () => {
  const q = parseVariationalOilQuote(stats(), NOW);
  assert.equal(q.left.symbol, 'BZ'); assert.equal(q.right.symbol, 'CL');
  assert.equal(q.left.price, 100.05); assert.equal(q.right.price, 91.77); assert.equal(q.currency, 'USDC');
  assert.equal(q.fetchedAt, new Date(NOW).toISOString()); assert.equal(q.timestampBasis, 'received');
  assert.equal(q.left.fundingRate, null); assert.equal(q.right.fundingRate, null); assert.equal(q.left.fundingIntervalHours, 4);
  assert.equal(q.left.nextFundingAt, null); assert.equal(calculateExchangeSpread(q).shortAnnualized, null);
  const missing = stats(); missing.listings.shift(); assert.throws(() => parseVariationalOilQuote(missing, NOW));
  const duplicate = stats(); duplicate.listings.push(duplicate.listings[0]); assert.throws(() => parseVariationalOilQuote(duplicate, NOW));
  for (const value of ['', '-1', 'NaN', null]) {
    const invalid = stats(); invalid.listings[0].mark_price = value; assert.throws(() => parseVariationalOilQuote(invalid, NOW));
  }
});

function socketFixture() {
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.closed = 0; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed++; }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  return { Socket, sockets };
}

test('bounded Lighter subscription waits for both legs, responds to ping, then closes and clears handlers', async () => {
  const { Socket, sockets } = socketFixture(), markets = parseLighterOilMarkets(metadata());
  const pending = readLighterOilSnapshot(markets, { clock: () => NOW, WebSocketImpl: Socket, timeoutMs: 100 });
  const socket = sockets[0]; assert.equal(socket.url.endsWith('?readonly=true'), true);
  socket.onopen(); assert.deepEqual(socket.sent.map(row => row.channel), ['market_stats/901', 'market_stats/802']);
  socket.message({ type: 'ping' }); assert.deepEqual(socket.sent.at(-1), { type: 'pong' });
  socket.message(message(markets[0])); assert.equal(socket.closed, 0);
  socket.message(message(markets[1])); const quote = await pending;
  assert.equal(quote.left.symbol, 'BRENTOIL'); assert.equal(socket.closed, 1);
  assert.equal(socket.onmessage, null); assert.equal(socket.onclose, null); assert.equal(socket.onerror, null); assert.equal(socket.onopen, null);
});

test('Lighter timeout, close, network error and malformed target payload reject incomplete snapshots and clean up', async () => {
  for (const action of ['timeout', 'close', 'error', 'malformed']) {
    const { Socket, sockets } = socketFixture(), markets = parseLighterOilMarkets(metadata());
    const pending = readLighterOilSnapshot(markets, { clock: () => NOW, WebSocketImpl: Socket, timeoutMs: 5 });
    const socket = sockets[0]; socket.onopen(); socket.message(message(markets[0]));
    if (action === 'close') socket.onclose();
    if (action === 'error') socket.onerror();
    if (action === 'malformed') socket.message({ channel: `market_stats:${markets[1].marketId}`, type: 'update/market_stats', market_stats: {} });
    await assert.rejects(pending);
    assert.equal(socket.closed, 1); assert.equal(socket.onmessage, null);
  }
});

test('DEX reader shares public transports and preserves receipt timestamps across cache hits', async () => {
  let now = NOW, calls = 0; const cache = new Map();
  const shared = async (key, ttl, load) => {
    const prior = cache.get(key); if (prior && prior.until > now) return prior.promise;
    const promise = Promise.resolve().then(load); cache.set(key, { until: now + ttl, promise }); return promise;
  };
  const reader = createOilDexReader({ request: async url => { calls++; assert.equal(url, 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'); return stats(); }, shared, clock: () => now,
    fetcher: async (_url, options) => { assert.equal(options.headers.Cookie, undefined); return Response.json({ predicted_funding_rate: '0.1', funding_interval_s: 14400, next_funding_time: new Date(now + HOUR).toISOString() }); } });
  const quotes = await Promise.all([reader('variational'), reader('variational')]);
  assert.equal(calls, 1); assert.equal(quotes[0].fetchedAt, quotes[1].fetchedAt);
  now += 500; assert.equal((await reader('variational')).fetchedAt, new Date(NOW).toISOString());
  now += 1000; assert.equal((await reader('variational')).fetchedAt, new Date(now).toISOString()); assert.equal(calls, 2);
});

test('Lighter reader shares short subscriptions, refreshes metadata after 60 seconds and uses changed market IDs', async () => {
  let now = NOW, metadataCalls = 0; const cache = new Map(), { Socket, sockets } = socketFixture();
  let instruments = metadata();
  const shared = async (key, ttl, load) => {
    const prior = cache.get(key); if (prior && prior.until > now) return prior.promise;
    const promise = Promise.resolve().then(load); cache.set(key, { until: now + ttl, promise }); return promise;
  };
  class AutoSocket extends Socket {
    constructor(url) { super(url); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      super.send(raw); const data = JSON.parse(raw);
      if (data.type === 'subscribe') {
        const market = parseLighterOilMarkets(instruments).find(row => data.channel === `market_stats/${row.marketId}`);
        assert.ok(market); queueMicrotask(() => this.message(message(market, { now })));
      }
    }
  }
  const reader = createOilDexReader({ shared, clock: () => now, WebSocketImpl: AutoSocket, request: async url => {
    metadataCalls++; assert.equal(url, 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails'); return structuredClone(instruments);
  } });
  const first = await Promise.all([reader('lighter'), reader('lighter')]);
  assert.equal(first[0].fetchedAt, first[1].fetchedAt); assert.equal(metadataCalls, 1); assert.equal(sockets.length, 1);
  now += 1500; await reader('lighter'); assert.equal(metadataCalls, 1); assert.equal(sockets.length, 2);
  now += 60000; instruments.order_book_details.forEach((row, i) => { row.market_id = 501 + i; });
  await reader('lighter'); assert.equal(metadataCalls, 2); assert.equal(sockets.length, 3);
  assert.deepEqual(sockets[2].sent.map(row => row.channel), ['market_stats/501', 'market_stats/502']);
});

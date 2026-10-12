import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createInspectionBudget, createPerpetualExecutionService, estimateDepthPair, normalizeDepthLevels } from '../server/perpetual-depth.mjs';
import { quoteCurrencyFx } from '../lib/perpetual-fx.ts';
import { depthEstimateExpired } from '../lib/perpetual-execution.ts';

const NOW = 1_800_000_000_000;
const quote = (exchange, extra = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', ...extra });
const book = (exchange, extra = {}) => ({ ...quote(exchange), sourceTime: NOW, receivedAt: NOW, transport: 'rest', asks: [[100, 5], [110, 5]], bids: [[99, 20]], ...extra });
const response = data => ({ ok: true, json: async () => data });
const budget = () => createInspectionBudget({ spacingMs: 0, maxPerMinute: 60 });
const usdSpot = (extra = {}) => ({ error: [], result: { USDTZUSD: { bids: [['0.98', '20', NOW / 1000 - 2]], asks: [['1.02', '30', NOW / 1000 - 1]], ...extra } } });
const krakenQuote = () => quote('kraken', { symbol: 'PF_XBTUSD', quoteCurrency: 'USD', collateralCurrency: 'MULTI', settlementCurrency: 'USD', multiplier: 1, contractUnit: '每枚' });
const krakenMarket = () => ({ ...krakenQuote(), identityVerified: true, contractKind: 'linear', comparable: true });

test('depth normalizes coin multipliers and contract size without changing notional', () => {
  assert.deepEqual(normalizeDepthLevels([['1000', '2']], { multiplier: 1000, contractSize: 0.1 }), [[1, 200]]);
  assert.deepEqual(normalizeDepthLevels([{ p: '10', s: '3' }, { p: '10', s: '4' }, null, ['12', '0'], ['8', '2']], { side: 'bids' }), [[10, 7], [8, 2]]);
  assert.throws(() => normalizeDepthLevels([], { contractSize: 0 }));
});

test('depth spends target USDT through long levels then matches the same underlying quantity', () => {
  const result = estimateDepthPair(book('binance'), book('bybit', { bids: [[120, 20]], asks: [[121, 20]] }), 1050, null, NOW);
  assert.equal(result.complete, true); assert.equal(result.quantity, 10);
  assert.equal(result.long.vwap, 105); assert.equal(result.long.filledNotional, 1050);
  assert.equal(result.short.filledQuantity, 10); assert.equal(result.short.filledNotional, 1200);
  assert.ok(Math.abs(result.estimatedSpreadPct - 14.2857142857) < 1e-8);
  assert.ok(result.entrySlippagePct > 5);
});

test('insufficient depth never promotes a partial fill to a full opportunity', () => {
  const shortLimited = estimateDepthPair(book('binance'), book('bybit', { bids: [[101, 1]], asks: [[102, 1]] }), 500, null, NOW);
  assert.equal(shortLimited.complete, false); assert.equal(shortLimited.estimatedSpreadPct, null);
  assert.equal(shortLimited.short.filledQuantity, 1); assert.match(shortLimited.reasons.join(), /做空腿/);
  const longLimited = estimateDepthPair(book('binance'), book('bybit'), 5000, null, NOW);
  assert.equal(longLimited.complete, false); assert.equal(longLimited.estimatedSpreadPct, null);
  assert.equal(longLimited.long.filledNotional, 1050); assert.match(longLimited.reasons.join(), /做多腿/);
});

test('depth refuses stale, future, crossed and time-skewed books independently of recent receipt', () => {
  for (const extra of [{ sourceTime: NOW - 10_001 }, { sourceTime: null }, { sourceTime: NOW + 5_001 }, { bids: [[200, 1]] }]) {
    assert.equal(estimateDepthPair(book('binance', extra), book('bybit'), 100, null, NOW).complete, false);
  }
  assert.match(estimateDepthPair(book('binance', { sourceTime: NOW - 6000 }), book('bybit'), 100, null, NOW).reasons.join(), /相差/);
});

test('FX uses directional bid and ask; USD and stale rates are never silently one', () => {
  const fx = { baseCurrency: 'USDT', generatedAt: NOW, staleAfterMs: 180000, rates: { USDC: { bid: 0.98, ask: 1.02, at: NOW, source: 'fixture' } } };
  assert.equal(quoteCurrencyFx('USDT', null, NOW).bid, 1);
  assert.equal(quoteCurrencyFx('USD', fx, NOW), null);
  assert.equal(quoteCurrencyFx('USDC', fx, NOW + 180001), null);
  assert.equal(quoteCurrencyFx('USDC', { ...fx, rates: { USDC: { ...fx.rates.USDC, bid: 2 } } }, NOW), null);
  const result = estimateDepthPair(book('binance', { quoteCurrency: 'USDC', asks: [[100, 20]] }), book('bybit', { bids: [[110, 20]], asks: [[111, 20]] }), 1020, fx, NOW);
  assert.equal(result.quantity, 10); assert.equal(result.long.vwap, 102);
  assert.equal(estimateDepthPair(book('binance', { quoteCurrency: 'USD' }), book('bybit'), 100, fx, NOW).complete, false);
});

test('frozen browser estimates expire from the older source time', () => {
  const result = estimateDepthPair(book('binance', { sourceTime: NOW - 4000 }), book('bybit'), 100, null, NOW);
  assert.equal(depthEstimateExpired(result, NOW + 5000), false);
  assert.equal(depthEstimateExpired(result, NOW + 6001), true);
});

test('shared inspection budget limits in-flight work, queue size and minute starts', async () => {
  const limiter = createInspectionBudget({ spacingMs: 0, concurrency: 1, maxQueue: 1, maxPerMinute: 2 });
  let release; const first = limiter.run(() => new Promise(resolve => { release = resolve; }));
  const second = limiter.run(async () => 2);
  await assert.rejects(limiter.run(async () => 3), /繁忙/);
  assert.equal(limiter.metrics().inFlight, 1); release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await assert.rejects(limiter.run(async () => 4), /限额/); limiter.stop();
});

test('execution caches shared market requests, bounds active leases and validates symbols before network', async () => {
  let calls = 0, now = NOW;
  const quotes = [quote('binance'), quote('bybit'), quote('aster')], limiter = budget();
  const service = createPerpetualExecutionService({ clock: () => now, budget: limiter, maxMarkets: 2, getQuote: (exchange, symbol) => quotes.find(row => row.exchange === exchange && row.symbol === symbol), fetchImpl: async url => {
    calls++; return response(url.includes('bybit') ? { result: { s: 'BTCUSDT', ts: now, b: [['101', '20']], a: [['102', '20']] } } : { E: now, bids: [['99', '20']], asks: [['100', '20']] });
  } });
  try {
    const input = { long: quotes[0], short: quotes[1], notional: 100 };
    const results = await Promise.all([service.depth(input), service.depth(input)]);
    assert.ok(results.every(row => row.complete)); assert.equal(calls, 2);
    await service.depth({ ...input, notional: 500 }); assert.equal(calls, 2);
    const denied = await service.depth({ ...input, short: quotes[2] }); assert.equal(denied.complete, false); assert.match(denied.reasons.join(), /最多/);
    await assert.rejects(service.depth({ ...input, long: { exchange: 'binance', symbol: 'https://evil.example' } }), /有效/);
    await assert.rejects(service.depth({ ...input, notional: -1 }), /金额/); assert.equal(calls, 2);
    now += 31000; const released = await service.depth({ ...input, short: quotes[2] }); assert.equal(released.complete, true); assert.equal(calls, 4);
  } finally { service.stop(); limiter.stop(); }
});

test('Gate and OKX quantities use official contract multipliers and reject unknown units', async () => {
  const quotes = [quote('gate', { symbol: 'BTC_USDT' }), quote('okx', { symbol: 'BTC-USDT-SWAP' })], limiter = budget();
  let metadataCalls = 0;
  const service = createPerpetualExecutionService({ clock: () => NOW, budget: limiter, getQuote: exchange => quotes.find(row => row.exchange === exchange), fetchImpl: async url => {
    if (url.includes('/contracts/')) { metadataCalls++; return response({ name: 'BTC_USDT', type: 'direct', quanto_multiplier: '0.01' }); }
    if (url.includes('/instruments?')) { metadataCalls++; return response({ data: [{ instId: 'BTC-USDT-SWAP', ctValCcy: 'BTC', ctType: 'linear', ctVal: '0.1', ctMult: '1' }] }); }
    return response(url.includes('gateio') ? { current: NOW / 1000, asks: [{ p: '100', s: '100' }], bids: [{ p: '99', s: '100' }] } : { data: [{ ts: NOW, asks: [['102', '10']], bids: [['101', '10']] }] });
  } });
  try {
    const result = await service.depth({ long: quotes[0], short: quotes[1], notional: 100 });
    assert.equal(result.complete, true); assert.equal(result.quantity, 1); assert.equal(result.short.filledQuantity, 1); assert.equal(metadataCalls, 2);
  } finally { service.stop(); limiter.stop(); }
});

test('Lighter one-shot WS accepts a snapshot, ignores preceding deltas and closes after reading', async () => {
  const quotes = [quote('lighter', { symbol: 'BTC' }), quote('bybit')], limiter = budget(); let terminated = 0;
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(raw) { const request = JSON.parse(raw); if (request.type === 'subscribe') queueMicrotask(() => {
      this.emit('message', JSON.stringify({ type: 'update/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { asks: [{ price: '1', size: '100' }], bids: [{ price: '0.5', size: '100' }] } }));
      this.emit('message', JSON.stringify({ type: 'subscribed/order_book', channel: 'order_book:1', timestamp: NOW, order_book: { asks: [{ price: '100', size: '5' }], bids: [{ price: '99', size: '5' }] } }));
    }); }
    terminate() { terminated++; }
  }
  const service = createPerpetualExecutionService({ clock: () => NOW, budget: limiter, WebSocketImpl: Socket, getQuote: exchange => quotes.find(row => row.exchange === exchange), getMarket: () => ({ marketId: 1, multiplier: 1 }), fetchImpl: async () => response({ result: { s: 'BTCUSDT', ts: NOW, a: [['102', '10']], b: [['101', '10']] } }) });
  try { const result = await service.depth({ long: quotes[0], short: quotes[1], notional: 100 }); assert.equal(result.complete, true); assert.equal(result.long.vwap, 100); assert.equal(result.long.transport, 'ws'); assert.equal(terminated, 1); }
  finally { service.stop(); limiter.stop(); }
});

test('FX is one shared short cache and only publishes actual positive spot books', async () => {
  let calls = 0; const limiter = budget();
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, fetchImpl: async url => { calls++; return response(url.includes('kraken') ? usdSpot() : url.includes('USDG') ? { current: NOW, update: NOW, asks: [], bids: [] } : { current: NOW, update: NOW - 1000, bids: [['0.999', '10']], asks: [['1.001', '10']] }); } });
  try {
    assert.equal(service.peekFx(), null);
    const [a, b] = await Promise.all([service.fx(), service.fx()]); assert.deepEqual(a, b); assert.equal(calls, 4);
    assert.equal(a.rates.USDC.bid, 0.999); assert.equal(a.rates.USDC.at, NOW - 1000);
    assert.equal(a.rates.USD.bid, 1 / 1.02); assert.equal(a.rates.USD.ask, 1 / 0.98); assert.equal(a.rates.USD.at, NOW - 2000);
    assert.equal(a.rates.USDG, undefined); assert.ok(a.reasons.USDG); assert.equal(service.peekFx(), a);
    await service.fx(); assert.equal(calls, 4);
  } finally { service.stop(); limiter.stop(); }
});

test('a temporary FX failure preserves original timestamps, then drops expired values', async () => {
  let now = NOW, failing = false; const limiter = budget();
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => now, fetchImpl: async url => { if (failing) throw new Error('temporary outage'); return response(url.includes('kraken') ? usdSpot() : { current: NOW, update: NOW, bids: [['0.999', '10']], asks: [['1.001', '10']] }); } });
  try {
    assert.equal((await service.fx()).rates.USDC.at, NOW);
    now += 60001; failing = true;
    const held = await service.fx(); assert.equal(held.rates.USDC.at, NOW); assert.equal(held.rates.USD.at, NOW - 2000); assert.equal(held.generatedAt, now); assert.match(held.reasons.USDC, /沿用/);
    now += 120001;
    const expired = await service.fx(); assert.equal(expired.rates.USDC, undefined); assert.equal(expired.rates.USD1, undefined); assert.equal(expired.rates.USD, undefined);
  } finally { service.stop(); limiter.stop(); }
});

test('FX refresh never turns response generation or regressed level time into fresh prices', async () => {
  let now = NOW, phase = 0; const limiter = budget();
  const service = createPerpetualExecutionService({ budget: limiter, clock: () => now, fetchImpl: async url => {
    if (url.includes('kraken')) return response(phase ? usdSpot({ bids: [['0.5', '20', NOW / 1000 - 100]], asks: [['0.6', '20', NOW / 1000 - 99]] }) : usdSpot());
    return response({ current: now, update: phase ? NOW - 100_000 : NOW, bids: [[phase ? '2' : '0.999', '10']], asks: [[phase ? '3' : '1.001', '10']] });
  } });
  try {
    const initial = await service.fx(); phase = 1; now += 60_001;
    const regressed = await service.fx();
    assert.deepEqual(regressed.rates.USDC, initial.rates.USDC); assert.deepEqual(regressed.rates.USD, initial.rates.USD);
    assert.match(regressed.reasons.USDC, /时间回退/); assert.match(regressed.reasons.USD, /时间回退/);
    now = NOW + 180_001;
    const expired = await service.fx(); assert.equal(expired.rates.USDC, undefined); assert.equal(expired.rates.USD, undefined);
  } finally { service.stop(); limiter.stop(); }
});

test('USD FX rejects foreign pairs, missing side times, empty sizes and errors without blocking USDC', async () => {
  const variants = [
    { error: [], result: { XBTUSD: usdSpot().result.USDTZUSD } },
    { error: ['EGeneral:Invalid arguments'], result: usdSpot().result },
    { result: usdSpot().result },
    { error: [], result: { ...usdSpot().result, BTCUSD: {} } },
    usdSpot({ bids: [['0.98', '0', NOW / 1000]] }),
    usdSpot({ asks: [['1.02', '20']] }),
    usdSpot({ asks: [['1.02', '20', NOW / 1000 + 6]] }),
    usdSpot({ bids: [['0.98', '20', NOW / 1000 - 181]] }),
    usdSpot({ bids: [['2', '20', NOW / 1000]] }),
  ];
  for (const data of variants) {
    const limiter = budget(), service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, fetchImpl: async url => response(url.includes('kraken') ? data : { current: NOW, update: NOW, bids: [['0.99', '10']], asks: [['1.01', '10']] }) });
    try { const fx = await service.fx(); assert.equal(fx.rates.USD, undefined); assert.ok(fx.reasons.USD); assert.equal(fx.rates.USDC.bid, 0.99); }
    finally { service.stop(); limiter.stop(); }
  }
});

test('Gate FX requires the original update timestamp rather than the current response timestamp', async () => {
  for (const update of [undefined, NOW - 180_001]) {
    const limiter = budget(), service = createPerpetualExecutionService({ budget: limiter, clock: () => NOW, fetchImpl: async url => response(url.includes('kraken') ? usdSpot() : { current: NOW, update, bids: [['0.99', '10']], asks: [['1.01', '10']] }) });
    try { const fx = await service.fx(); assert.equal(fx.rates.USDC, undefined); assert.equal(fx.rates.USD.ask, 1 / 0.98); }
    finally { service.stop(); limiter.stop(); }
  }
});

function krakenDepthFixture({ frames, changeMarket, market: suppliedMarket } = {}) {
  const quotes = [krakenQuote(), quote('bybit')], limiter = budget(); let market = suppliedMarket === undefined ? krakenMarket() : suppliedMarket, terminated = 0, subscriptions = 0;
  class Socket extends EventEmitter {
    constructor(url) { super(); assert.equal(url, 'wss://futures.kraken.com/ws/v1'); queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const request = JSON.parse(raw); subscriptions++;
      assert.deepEqual(request, { event: 'subscribe', feed: 'book', product_ids: ['PF_XBTUSD'] });
      queueMicrotask(() => {
        if (changeMarket) market = changeMarket(market);
        for (const frame of frames ?? [
          { feed: 'book', product_id: 'PF_XBTUSD', timestamp: NOW, side: 'sell', price: 1, qty: 100 },
          { feed: 'book_snapshot', product_id: 'PF_XBTUSD', timestamp: NOW - 100, asks: [{ price: 98, qty: 5 }], bids: [{ price: 97, qty: 5 }] },
        ]) this.emit('message', JSON.stringify(frame));
      });
    }
    terminate() { terminated++; }
  }
  const service = createPerpetualExecutionService({ clock: () => NOW, budget: limiter, WebSocketImpl: Socket,
    getQuote: exchange => quotes.find(row => row.exchange === exchange), getMarket: exchange => exchange === 'kraken' ? market : null,
    fetchImpl: async url => response(url.includes('kraken') ? usdSpot() : url.includes('/spot/') ? { current: NOW, update: NOW, bids: [['0.99', '10']], asks: [['1.01', '10']] }
      : { result: { s: 'BTCUSDT', ts: NOW, a: [['103', '10']], b: [['102', '10']] } }) });
  return { service, input: { long: quotes[0], short: quotes[1], notional: 100 }, stats: () => ({ terminated, subscriptions }), setMarket: value => { market = value; }, stop: () => { service.stop(); limiter.stop(); } };
}

test('Kraken depth accepts only the full native snapshot and applies real directional USD FX', async () => {
  const fixture = krakenDepthFixture();
  try {
    const result = await fixture.service.depth(fixture.input);
    assert.equal(result.complete, true); assert.equal(result.long.transport, 'ws');
    assert.equal(result.long.sourceTime, NOW - 100); assert.equal(result.long.vwap, 100); assert.equal(result.quantity, 1);
    assert.equal(result.short.filledQuantity, 1); assert.deepEqual(fixture.stats(), { terminated: 1, subscriptions: 1 });
    await fixture.service.depth(fixture.input); assert.equal(fixture.stats().subscriptions, 1);
    await assert.rejects(fixture.service.exit({ ...fixture.input, quantity: 1, entryLongPrice: 98, entryShortPrice: 102, entryFeePaid: 0, settledFunding: 0, capital: 100 }), /USDT/);
  } finally { fixture.stop(); }
});

test('Kraken depth rejects wrong products and invalid source timestamps without freshening them', async () => {
  for (const change of [{ product_id: 'PF_ETHUSD' }, { timestamp: undefined }, { timestamp: NOW - 10_001 }, { timestamp: NOW + 5_001 }]) {
    const fixture = krakenDepthFixture({ frames: [{ feed: 'book_snapshot', product_id: 'PF_XBTUSD', timestamp: NOW, asks: [{ price: 98, qty: 5 }], bids: [{ price: 97, qty: 5 }], ...change }] });
    try { const result = await fixture.service.depth(fixture.input); assert.equal(result.complete, false); assert.ok(result.reasons.length); assert.equal(fixture.stats().terminated, 1); }
    finally { fixture.stop(); }
  }
});

test('Kraken depth subscription errors close promptly instead of accepting subsequent data', async () => {
  const fixture = krakenDepthFixture({ frames: [{ event: 'subscribed_failed', feed: 'book' }] });
  try { const result = await fixture.service.depth(fixture.input); assert.equal(result.complete, false); assert.match(result.reasons.join(), /订阅失败/); assert.equal(fixture.stats().terminated, 1); }
  finally { fixture.stop(); }
});

test('Kraken depth checks current directory evidence before opening, after receiving and before cache reuse', async () => {
  const missing = krakenDepthFixture({ market: null });
  try { const result = await missing.service.depth(missing.input); assert.equal(result.complete, false); assert.equal(missing.stats().subscriptions, 0); }
  finally { missing.stop(); }
  const changed = krakenDepthFixture({ changeMarket: market => ({ ...market, multiplier: 10 }) });
  try { const result = await changed.service.depth(changed.input); assert.equal(result.complete, false); assert.match(result.reasons.join(), /单位未确认/); }
  finally { changed.stop(); }
  const cached = krakenDepthFixture();
  try {
    assert.equal((await cached.service.depth(cached.input)).complete, true);
    cached.setMarket({ ...krakenMarket(), identityVerified: false });
    const result = await cached.service.depth(cached.input); assert.equal(result.complete, false); assert.equal(cached.stats().subscriptions, 1);
  } finally { cached.stop(); }
});

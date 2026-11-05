import test from 'node:test';
import assert from 'node:assert/strict';
import { CostLabEngine, DEFAULT_COST_CONFIG, validateCostConfig } from '../server/research/binance-lighter-core.mjs';
import { createCostExecution, EXECUTION_CONTRACT, cashUnits, units, numberOf } from '../server/research/binance-lighter-execution.mjs';
import { applyInventoryFill, createInventoryLedger, inventoryUnrealized } from '../server/research/binance-lighter-ledger.mjs';
import { createCostFeedDecoder } from '../server/research/binance-lighter-feeds.mjs';

const BASE = 1800000000000;
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function fixture(patch = {}, marketPatch = {}, readyTrades = true) {
  let time = 0, sequence = 0;
  const events = [];
  const config = { ...structuredClone(DEFAULT_COST_CONFIG), symbols: ['BTC'], latencyScenarios: [300], orderNotional: 100,
    maxInventoryNotional: 500, maxUnhedgedNotional: 300, hedgeThresholdNotional: 0, maxBookAgeMs: 5000, maxSourceAgeMs: 10000, maxPairSkewMs: 5000, ...patch };
  const markets = ['binance', 'lighter'].map(venue => ({ venue, symbol: 'BTC', nativeSymbol: venue === 'binance' ? 'BTCUSDC' : 'BTC',
    marketId: venue === 'lighter' ? 1 : null, quote: 'USDC', priceUnit: venue === 'binance' ? 'USDC' : 'USD', settlement: 'USDC',
    status: 'active', multiplier: 1, tickSize: 0.01, quantityStep: 0.01, minQuantity: 0.01, minNotional: 1, observedAt: BASE,
    ...(marketPatch[venue] || {}) }));
  const engine = new CostLabEngine(config, { now: () => BASE + time, mono: () => time, sessionId: 'test', emit: event => events.push(event) });
  const set = value => { time = value; };
  const book = (venue, patch = {}) => ({ venue, symbol: 'BTC', nativeSymbol: venue === 'binance' ? 'BTCUSDC' : 'BTC',
    bids: [[100, venue === 'binance' ? 0.1 : 10], [99, 10]], asks: [[101, venue === 'binance' ? 0.1 : 10], [102, 10]],
    sourceAt: BASE + time, receivedAt: BASE + time, receivedMono: time, sequence: String(++sequence), ...patch });
  const sendBook = (venue, patch = {}) => { const value = book(venue, patch); engine.onBook(value); return value; };
  const trade = (patch = {}) => ({ venue: 'binance', symbol: 'BTC', price: 100, quantity: 1.1, buyerMaker: true,
    sourceAt: BASE + time, receivedAt: BASE + time, receivedMono: time, sequence: String(++sequence), ...patch });
  const sendTrade = (patch = {}) => { const value = trade(patch); engine.onTrade(value); return value; };
  const scenario = (latency = 300) => engine.report().scenarios.find(row => row.latencyMs === latency);
  engine.setMarkets(markets); sendBook('binance'); sendBook('lighter');
  if (readyTrades) sendTrade({ quantity: 0 });
  return { engine, config, markets, events, set, book, sendBook, trade, sendTrade, scenario };
}
function fillBuy(f, at = 1, quantity = 1.1) { f.set(at); f.sendTrade({ quantity }); }
function freshBoth(f, at) { f.set(at); f.sendBook('binance'); f.sendBook('lighter'); }

test('schema 2 configuration is strict, cloned, and cannot enable live execution or inject transports', () => {
  const input = structuredClone(DEFAULT_COST_CONFIG), result = validateCostConfig(input);
  result.symbols.pop(); assert.equal(input.symbols.length, 1);
  for (const patch of [{ schema: 1 }, { mode: 'live' }, { url: 'https://example.com' }, { symbols: [] }, { latencyScenarios: [299] },
    { latencyScenarios: [300, 300] }, { quoteRefreshMs: 999 }, { quoteMaxAgeMs: 999 }, { orderNotional: NaN },
    { maxInventoryNotional: 999 }, { queueMultiplier: 0.9 }, { fundingCostBpsPerHour: 101 },
    { symbols: ['BTC', 'ETH'] }, { symbols: ['ETH'] }, { hedgeThresholdNotional: -1 }, { hedgeThresholdNotional: 2000.01 },
    { hedgeThresholdNotional: 1e-100 }, { hedgeThresholdNotional: 1e-79 }, { hedgeThresholdNotional: 1e-19 }]) {
    assert.throws(() => validateCostConfig({ ...input, ...patch }), /invalid_cost_config/);
  }
  assert.doesNotThrow(() => validateCostConfig({ ...input, maxUnhedgedNotional: 10, hedgeThresholdNotional: 0 }));
  const missingThreshold = { ...input }; delete missingThreshold.hedgeThresholdNotional;
  assert.throws(() => validateCostConfig(missingThreshold), /invalid_cost_config/);
  assert.throws(() => createCostExecution({ mode: 'live' }), /live_execution_unavailable/);
  assert.throws(() => createCostExecution({ request: () => {} }), /live_execution_unavailable/);
  assert.equal(EXECUTION_CONTRACT.version, 2); assert.equal(EXECUTION_CONTRACT.liveAvailable, false);
  const smallest = fixture({ hedgeThresholdNotional: 1e-18 }); fillBuy(smallest);
  assert.equal(smallest.scenario().hedge.quantity, 1, 'the smallest positive fixed-point threshold stays executable');
});

test('default three BTC accounts each quote both sides simultaneously and never create a timed exit', () => {
  assert.equal(new CostLabEngine().scenarios.length, 3);
  assert.deepEqual(DEFAULT_COST_CONFIG.symbols, ['BTC']); assert.equal(DEFAULT_COST_CONFIG.hedgeThresholdNotional, 1000);
  const f = fixture(); const first = f.scenario();
  assert.equal(first.id, 'BTC-inventory-300'); assert.equal(first.status, 'quoting');
  assert.equal(first.quotes.buy.price, 100); assert.equal(first.quotes.sell.price, 101);
  assert.equal(first.quotes.buy.quantity, 1); assert.equal(first.quotes.sell.quantity, 0.99);
  fillBuy(f); f.set(302); f.sendBook('lighter'); freshBoth(f, 5001);
  assert.equal(f.scenario().inventory.binanceQuantity, 1); assert.equal(f.scenario().inventory.lighterQuantity, -1);
  assert.ok(f.scenario().quotes.buy); assert.ok(f.scenario().quotes.sell);
  assert.ok(f.scenario().recentFills.every(fill => ['quote', 'hedge'].includes(fill.phase)));
  assert.equal(f.scenario().recentFills.length, 2);
});

test('long and short Binance inventory skew both prices and sizes in the reducing direction', () => {
  const long = fixture({ inventorySkewBps: 100 }); fillBuy(long); long.set(302); long.sendBook('lighter'); freshBoth(long, 1000);
  const l = long.scenario(); assert.ok(l.quotes.buy.price < 100); assert.ok(l.quotes.sell.price < 101);
  assert.ok(l.quotes.buy.quantity < 1); assert.ok(l.quotes.sell.quantity > 0.99);
  const short = fixture({ inventorySkewBps: 100 }); short.set(1); short.sendTrade({ buyerMaker: false, price: 101 });
  short.set(302); short.sendBook('lighter'); freshBoth(short, 1000);
  const s = short.scenario(); assert.ok(s.quotes.buy.price > 100); assert.ok(s.quotes.sell.price > 101);
  assert.ok(s.quotes.buy.quantity > 1); assert.ok(s.quotes.sell.quantity < 0.99);
  for (const row of [l, s]) for (const side of ['buy', 'sell']) {
    const q = row.quotes[side]; assert.equal(units(q.price) % units(0.01), 0n); assert.equal(units(q.quantity) % units(0.01), 0n);
    assert.ok(side === 'buy' ? q.price < 101 : q.price > 100);
  }
});

test('queue evidence is visible depth or inside spread; unknown far depth never becomes zero queue', () => {
  const outside = fixture({ quoteOffsetBps: 100, inventorySkewBps: 100 });
  assert.equal(outside.scenario().quotes.buy.price, 99); assert.equal(outside.scenario().quotes.buy.queueAhead, 10);
  assert.equal(outside.scenario().quotes.sell.price, 102); assert.equal(outside.scenario().quotes.sell.queueAhead, 10);
  const inside = fixture({ inventorySkewBps: 100 }); fillBuy(inside); inside.set(302); inside.sendBook('lighter'); freshBoth(inside, 1000);
  assert.ok(inside.scenario().quotes.sell.price > 100 && inside.scenario().quotes.sell.price < 101);
  assert.equal(inside.scenario().quotes.sell.queueAhead, 0);
});

test('book touches and cancellations cannot fill or shrink frozen queues, and duplicate trades cannot consume twice', () => {
  const f = fixture(); f.set(1); f.sendBook('binance', { bids: [[100, 0.01]], asks: [[101, 0.01]] });
  assert.equal(f.scenario().quotes.buy.queueAhead, 0.1);
  f.sendTrade({ sourceAt: BASE, quantity: 100 }); f.sendTrade({ buyerMaker: false, quantity: 100 }); f.sendTrade({ price: 100.01, quantity: 100 });
  assert.equal(f.scenario().inventory.binanceQuantity, 0);
  f.set(2); const first = f.sendTrade({ quantity: 0.06 });
  assert.equal(f.scenario().quotes.buy.queueAhead, 0.04); f.engine.onTrade(first); assert.equal(f.scenario().quotes.buy.queueAhead, 0.04);
  f.set(3); f.sendTrade({ quantity: 0.09 });
  assert.equal(f.scenario().inventory.binanceQuantity, 0.05); assert.equal(f.scenario().hedge.quantity, 0.05);
});

test('same price and remaining size preserve queue; changed price requeues and max age refresh is ordinary', () => {
  const f = fixture({ quoteMaxAgeMs: 15000 }); f.set(1); f.sendTrade({ quantity: 0.06 }); const first = f.scenario().quotes.buy;
  freshBoth(f, 1000); assert.equal(f.scenario().quotes.buy.id, first.id); assert.equal(f.scenario().quotes.buy.queueAhead, 0.04);
  f.set(2000); f.sendBook('binance', { bids: [[99.5, 2]], asks: [[100.5, 3]] });
  assert.notEqual(f.scenario().quotes.buy.id, first.id); assert.equal(f.scenario().quotes.buy.queueAhead, 2);
  const replaced = f.scenario().quotes.buy.id;
  for (let at = 3000; at <= 17000; at += 1000) {
    f.set(at); f.sendBook('binance', { bids: [[99.5, 2]], asks: [[100.5, 3]] }); f.sendBook('lighter');
  }
  assert.notEqual(f.scenario().quotes.buy.id, replaced); assert.equal(f.scenario().status, 'quoting'); assert.equal(f.scenario().reason, null);
  assert.equal(f.scenario().stats.makerFills, 0); assert.ok(f.engine.execution.orders.size <= 2);
});

test('quote lifetime is enforced before refresh throttling and before an arriving trade can consume its queue', () => {
  for (const expireWithTick of [false, true]) {
    const f = fixture({ quoteRefreshMs: 1000, quoteMaxAgeMs: 1500 });
    const original = f.scenario().quotes.buy.id;
    f.set(1000); f.engine.tick(); assert.equal(f.scenario().quotes.buy.id, original);
    if (expireWithTick) {
      f.set(1500); f.engine.tick(); assert.equal(f.scenario().quotes.buy, null); assert.equal(f.scenario().quotes.sell, null);
    }
    fillBuy(f, 1750, 100);
    assert.equal(f.scenario().inventory.binanceQuantity, 0); assert.equal(f.scenario().stats.makerFills, 0);
    assert.equal(f.scenario().quotes.buy, null);
    freshBoth(f, 2000);
    assert.notEqual(f.scenario().quotes.buy.id, original); assert.equal(f.scenario().quotes.buy.queueAhead, 0.1);
    f.sendTrade({ quantity: 100 }); assert.equal(f.scenario().stats.makerFills, 0);
    fillBuy(f, 2001); assert.equal(f.scenario().inventory.binanceQuantity, 1);
  }
});

test('real decoder accepts new sequence frames sharing a receive millisecond or source timestamp', () => {
  for (const [venue, sameSource, sameWall, sameMono] of [
    ['binance', false, true, false], ['lighter', true, false, false], ['binance', true, true, true],
  ]) {
    const f = fixture();
    const decoder = createCostFeedDecoder({ markets: f.markets, onBook: book => f.engine.onBook(book), onStatus: status => f.engine.onStatus(status) });
    const deliver = (update, at, source, mono) => {
      const payload = venue === 'binance'
        ? { e: 'depthUpdate', s: 'BTCUSDC', E: BASE + source, T: BASE + source, U: update ? 101 : 100,
          u: update ? 101 : 100, pu: update ? 100 : 99, b: [[update ? '90' : '100', '1']], a: [[update ? '91' : '101', '1']] }
        : { type: update ? 'update/order_book' : 'subscribed/order_book', channel: 'order_book:1', order_book: {
          nonce: update ? 101 : 100, ...(update ? { begin_nonce: 100 } : {}), last_updated_at: (BASE + source) * 1000,
          bids: update ? [{ price: '100', size: '0' }, { price: '90', size: '1' }] : [{ price: '100', size: '1' }],
          asks: update ? [{ price: '101', size: '0' }, { price: '91', size: '1' }] : [{ price: '101', size: '1' }],
        } };
      decoder.handle(venue, 'book', payload, { receivedAt: BASE + at, receivedMono: mono });
    };
    f.set(1000); deliver(false, 1000, 900, 1000);
    f.set(sameWall ? 1000.1 : 1001); deliver(true, sameWall ? 1000 : 1001, sameSource ? 900 : 901, sameMono ? 1000 : sameWall ? 1000.1 : 1001);
    assert.equal(f.engine.books.get(`${venue}:BTC`).sequence, '101');
    const current = f.engine.report().books.find(book => book.venue === venue);
    assert.equal(current.bid, 90); assert.equal(current.ask, 91); assert.equal(current.valid, true);
    assert.equal(f.engine.books.get(`${venue}:BTC`).sourceAt, BASE + (sameSource ? 900 : 901));
  }
});

test('orders existing before a trade execute first even at refresh time, and that trade cannot fill replacement orders', () => {
  const f = fixture({ inventorySkewBps: 100 }); const old = f.scenario().quotes.buy.id;
  fillBuy(f, 1000, 100);
  const s = f.scenario(); assert.equal(s.inventory.binanceQuantity, 1); assert.equal(s.stats.makerFills, 1);
  assert.notEqual(s.quotes.buy.id, old); assert.ok(s.quotes.buy.price < 100); assert.equal(s.quotes.buy.queueAhead, 10);
  assert.equal(s.recentFills[0].clientOrderId, old);
});

test('refresh intervals prevent immediate requeue after fills, but unsafe reservations cancel immediately', () => {
  const f = fixture({ maxUnhedgedNotional: 100 }); const initial = f.scenario().quotes;
  // Initial quantities already include the mid-price delta bound.
  assert.equal(initial.buy.quantity, 0.99);
  fillBuy(f, 1, 1.09); const s = f.scenario();
  assert.equal(s.quotes.buy, null); assert.equal(s.quotes.sell.id, initial.sell.id, 'safe opposite quote keeps its original queue');
  assert.equal(s.stats.quoteUpdates, 2); assert.ok(s.hedge);
  f.set(2); f.sendBook('binance', { bids: [[101, 1]], asks: [[102, 1]] });
  assert.equal(f.scenario().quotes.sell, null, 'unsafe crossed quote cancels inside the minimum refresh interval');
  f.set(302); f.sendBook('lighter'); assert.equal(f.scenario().quotes.buy, null);
  freshBoth(f, 1000); assert.ok(f.scenario().quotes.buy); assert.ok(f.scenario().quotes.sell);
});

test('same-side quantities reserve inventory and both current and projected net delta independently', () => {
  const f = fixture({ orderNotional: 100, maxInventoryNotional: 100, maxUnhedgedNotional: 50 });
  assert.equal(f.scenario().quotes.buy.quantity, 0.49);
  fillBuy(f, 1, 0.59); freshBoth(f, 1000);
  const s = f.scenario();
  for (const side of ['buy', 'sell']) {
    const q = s.quotes[side]; if (!q) continue;
    const signed = q.remainingQuantity * (side === 'buy' ? 1 : -1), price = Math.max(100.5, q.price);
    assert.ok(Math.abs(s.inventory.binanceQuantity + signed) * price <= 100 + 1e-10);
    assert.ok(Math.abs(s.inventory.residualQuantity + signed) * price <= 50 + 1e-10);
    assert.ok(Math.abs(s.inventory.projectedResidualQuantity + signed) * price <= 50 + 1e-10);
  }
});

test('newly readable trade stream cannot retroactively fill its newly submitted orders; nq=0 proves health only', () => {
  const f = fixture({}, {}, false); assert.equal(f.scenario().status, 'waiting');
  f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'live' }); assert.equal(f.scenario().quotes.buy, null);
  fillBuy(f); assert.equal(f.scenario().stats.makerFills, 0); assert.equal(f.scenario().stats.quoteUpdates, 2);
  f.set(2); f.sendTrade({ quantity: 0 }); assert.equal(f.scenario().quotes.buy.queueAhead, 0.1);
  f.set(3); f.sendTrade(); assert.equal(f.scenario().inventory.binanceQuantity, 1);
});

test('source and receive timestamps both have to follow quote placement evidence', () => {
  const f = fixture(); f.set(1); f.sendTrade({ receivedMono: 0, receivedAt: BASE }); f.sendTrade({ sourceAt: BASE });
  assert.equal(f.scenario().inventory.binanceQuantity, 0); f.sendTrade(); assert.equal(f.scenario().inventory.binanceQuantity, 1);
});

test('a single immutable pending hedge survives opposite Maker fills and new demand waits for its terminal result', () => {
  const f = fixture(); fillBuy(f); const hedge = f.scenario().hedge;
  f.set(2); f.sendTrade({ buyerMaker: false, price: 101, quantity: 1.09 });
  assert.deepEqual(f.scenario().hedge, hedge); near(f.scenario().inventory.residualQuantity, 0.01);
  near(f.scenario().inventory.projectedResidualQuantity, -0.99);
  assert.equal([...f.engine.execution.orders.values()].filter(order => order.type === 'ioc').length, 1);
  f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario().inventory.lighterQuantity, -1); assert.equal(f.scenario().hedge.side, 'buy'); assert.equal(f.scenario().hedge.quantity, 0.99);
  assert.equal(f.scenario().hedge.attempt, 1); assert.equal(f.scenario().stats.hedgeFills, 1);
  f.set(603); f.sendBook('lighter');
  near(f.scenario().inventory.residualQuantity, 0); assert.equal(f.scenario().hedge, null); assert.equal(f.engine.scenarios[0].hedgeAttempts, 0);
});

test('hedge execution needs a new frame after its monotonic and receive delay; tick and duplicates never execute IOC', () => {
  const f = fixture(); fillBuy(f); f.set(301); const atDue = f.sendBook('lighter'); assert.equal(f.scenario().inventory.lighterQuantity, 0);
  f.set(302); f.engine.tick(); f.engine.onBook(atDue); assert.equal(f.scenario().inventory.lighterQuantity, 0);
  f.sendBook('lighter'); assert.equal(f.scenario().inventory.lighterQuantity, -1);
  assert.equal(f.scenario().stats.hedgeFills, 1);
});

test('reconnection cannot relabel a previously seen source frame as newly executable IOC evidence', () => {
  const f = fixture(); fillBuy(f); f.set(100); const early = f.sendBook('lighter');
  f.engine.invalidate({ venue: 'lighter', channel: 'book', symbol: 'BTC', reason: 'reconnect' });
  f.set(302); f.sendBook('lighter', { ...early, receivedAt: BASE + 302, receivedMono: 302 });
  assert.equal(f.scenario().inventory.lighterQuantity, 0); assert.equal(f.scenario().valuation.valid, false);
  f.set(303); f.sendBook('lighter'); assert.equal(f.scenario().inventory.lighterQuantity, -1);
});

test('completed immutable IOC resets its retry budget while continuously arriving new inventory stays executable', () => {
  const f = fixture({ orderNotional: 1000, maxInventoryNotional: 5000, maxUnhedgedNotional: 5000, quoteRefreshMs: 60000, quoteMaxAgeMs: 60000 });
  fillBuy(f, 1, 0.2); const first = f.scenario().hedge;
  f.set(2); f.sendTrade({ buyerMaker: false, price: 101, quantity: 0.2 });
  assert.equal(f.scenario().inventory.residualQuantity, 0); assert.deepEqual(f.scenario().hedge, first);
  assert.equal(f.engine.scenarios[0].hedgeAttempts, 1, 'temporary zero delta cannot retire an in-flight order');
  for (let index = 0; index < 5; index++) {
    const at = 302 + index * 301;
    f.set(at - 1); f.sendTrade({ buyerMaker: true, quantity: 0.05 });
    f.set(at); f.sendBook('lighter');
    assert.notEqual(f.scenario().status, 'blocked');
    if (f.scenario().hedge) assert.equal(f.scenario().hedge.attempt, 1);
  }
  assert.ok(f.scenario().stats.hedgeFills > 3); assert.equal(f.scenario().stats.hedgeFailures, 0);
});

test('source clock tolerance does not shorten execution delay and stale source frames do not execute IOC', () => {
  const lead = fixture(); lead.set(1); lead.sendBook('lighter', { sourceAt: BASE + 91.5 }); lead.sendTrade();
  lead.set(300); lead.sendBook('lighter', { sourceAt: BASE + 390.5 }); assert.equal(lead.scenario().inventory.lighterQuantity, 0);
  lead.set(302); lead.sendBook('lighter', { sourceAt: BASE + 392.5 }); assert.equal(lead.scenario().inventory.lighterQuantity, -1);
  assert.equal(lead.engine.report().books.find(book => book.venue === 'lighter').sourceClockUncertain, true);
  const old = fixture(); old.set(500); old.sendBook('lighter'); fillBuy(old, 1000);
  old.set(1301); old.sendBook('lighter', { sourceAt: BASE + 700 }); assert.equal(old.scenario().inventory.lighterQuantity, 0);
  old.set(1302); old.sendBook('lighter', { sourceAt: BASE + 1049.99 }); assert.equal(old.scenario().inventory.lighterQuantity, 0);
  old.set(1303); old.sendBook('lighter', { sourceAt: BASE + 1050 }); assert.equal(old.scenario().inventory.lighterQuantity, -1);
  const far = fixture(); far.set(1); far.sendBook('lighter', { sourceAt: BASE + 252 }); assert.equal(far.scenario().valuation.valid, false);
});

test('partial IOC records actual quantities and retries only remaining demand with a finite budget', () => {
  const f = fixture(); fillBuy(f);
  for (const [attempt, at] of [[1, 302], [2, 1603], [3, 2904]]) {
    if (attempt > 1) { freshBoth(f, at - 301); assert.equal(f.scenario().hedge.attempt, attempt); }
    f.set(at); f.sendBook('lighter', { bids: [[100, 0.1]], asks: [[101, 10]] });
  }
  const s = f.scenario(); assert.equal(s.status, 'blocked'); assert.equal(s.reason, 'hedge_retries_exhausted');
  assert.equal(s.stats.hedgeFailures, 3); assert.equal(s.stats.hedgeFills, 3); assert.equal(s.inventory.lighterQuantity, -0.3);
  assert.equal(s.inventory.residualQuantity, 0.7); assert.equal(s.hedge, null); assert.equal(s.quotes.buy, null); assert.equal(f.engine.execution.orders.size, 0);
});

test('positive and negative net exposures trigger the full hedge only at or above the exact notional threshold', () => {
  for (const side of ['buy', 'sell']) for (const [threshold, expected] of [[50.250001, false], [50.25, true], [50.249999, true]]) {
    const f = fixture({ hedgeThresholdNotional: threshold });
    f.set(1); f.sendTrade({ buyerMaker: side === 'buy', price: side === 'buy' ? 100 : 101, quantity: 0.6 });
    const row = f.scenario();
    assert.equal(row.inventory.residualNotional, 50.25); assert.equal(Boolean(row.hedge), expected);
    assert.equal(row.inventory.residualQuantity, side === 'buy' ? 0.5 : -0.5);
    if (expected) { assert.equal(row.hedge.quantity, 0.5); assert.equal(row.hedge.side, side === 'buy' ? 'sell' : 'buy'); }
    else {
      assert.equal(row.status, 'quoting'); assert.equal(row.reason, 'below_hedge_threshold');
      assert.equal(row.stats.hedgeFailures, 0); assert.ok(row.quotes.buy); assert.ok(row.quotes.sell);
    }
  }
});

test('fresh hedge-venue price movement can cross the threshold without another Maker fill', () => {
  const f = fixture({ hedgeThresholdNotional: 60 }); fillBuy(f, 1, 0.6);
  assert.equal(f.scenario().hedge, null);
  f.engine.invalidate({ venue: 'binance', channel: 'book', symbol: 'BTC', reason: 'disconnected' });
  f.set(2); f.sendBook('lighter', { bids: [[119, 10]], asks: [[121, 10]] });
  assert.equal(f.scenario().inventory.residualNotional, 60);
  assert.equal(f.scenario().hedge.quantity, 0.5); assert.equal(f.scenario().stats.makerFills, 1);
});

test('below-threshold reverse fills do not cancel an immutable in-flight IOC', () => {
  const f = fixture({ hedgeThresholdNotional: 40 }); fillBuy(f, 1, 0.6); const pending = f.scenario().hedge;
  f.set(2); f.sendTrade({ buyerMaker: false, price: 101, quantity: 0.3 });
  assert.equal(f.scenario().inventory.residualQuantity, 0.3); assert.deepEqual(f.scenario().hedge, pending);
  f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario().inventory.lighterQuantity, -0.5); assert.equal(f.scenario().inventory.residualQuantity, -0.2);
  assert.equal(f.scenario().hedge, null); assert.equal(f.scenario().reason, 'below_hedge_threshold');
});

test('stale hedge valuation cannot retire a failed attempt or claim the residual is below threshold', () => {
  const f = fixture({ hedgeThresholdNotional: 40, hedgeWaitMs: 100 }); fillBuy(f, 1, 0.6);
  f.set(2); f.sendTrade({ buyerMaker: false, price: 101, quantity: 0.59 });
  assert.equal(f.scenario().inventory.residualQuantity, 0.01);
  f.engine.invalidate({ venue: 'lighter', channel: 'book', symbol: 'BTC', reason: 'disconnected' });
  f.set(402); f.engine.tick();
  assert.equal(f.scenario().hedge, null); assert.equal(f.scenario().stats.hedgeFailures, 1);
  assert.equal(f.engine.scenarios[0].hedgeAttempts, 1); assert.equal(f.scenario().inventory.residualNotional, null);
  assert.equal(f.scenario().status, 'recovering');
  f.set(403); f.sendBook('lighter');
  assert.equal(f.engine.scenarios[0].hedgeAttempts, 0); assert.equal(f.scenario().hedge, null);
  assert.equal(f.scenario().stats.hedgeFailures, 1); assert.equal(f.scenario().reason, 'below_hedge_threshold');
});

test('third partial IOC can finish below threshold without blocking and a later crossing starts a new budget', () => {
  const f = fixture({ hedgeThresholdNotional: 75 }); fillBuy(f);
  for (const [attempt, at] of [[1, 302], [2, 1603], [3, 2904]]) {
    if (attempt > 1) { freshBoth(f, at - 301); assert.equal(f.scenario().hedge.attempt, attempt); }
    f.set(at); f.sendBook('lighter', { bids: [[100, 0.1]], asks: [[101, 10]] });
  }
  const row = f.scenario();
  assert.equal(row.stats.hedgeFailures, 3); assert.equal(row.stats.hedgeFills, 3);
  assert.equal(row.inventory.residualQuantity, 0.7); assert.equal(row.inventory.residualNotional, 70.35);
  assert.equal(row.hedge, null); assert.equal(row.status, 'quoting'); assert.equal(row.reason, 'below_hedge_threshold');
  assert.equal(f.engine.scenarios[0].hedgeAttempts, 0);
  freshBoth(f, 4000); const quote = f.scenario().quotes.buy;
  f.set(4001); f.sendTrade({ price: quote.price, quantity: quote.queueAhead + 0.2 });
  assert.equal(f.scenario().hedge.attempt, 1); assert.equal(f.scenario().stats.hedgeFailures, 3);
});

test('risk and quantity limits may restrict new quotes below threshold but never authorize an early hedge', () => {
  const f = fixture({ maxUnhedgedNotional: 100, hedgeThresholdNotional: 100 }); fillBuy(f);
  assert.equal(f.scenario().inventory.residualQuantity, 0.99); assert.equal(f.scenario().hedge, null);
  freshBoth(f, 1000);
  assert.equal(f.scenario().quotes.buy, null); assert.ok(f.scenario().quotes.sell);
  assert.equal(f.scenario().reason, 'below_hedge_threshold');
  const small = fixture({ hedgeThresholdNotional: 0.5 }, { lighter: { minNotional: 10 } });
  fillBuy(small, 1, 0.11);
  assert.equal(small.scenario().inventory.residualQuantity, 0.01); assert.equal(small.scenario().hedge, null);
  assert.equal(small.scenario().stats.hedgeFailures, 0);
});

test('slippage failures never invent fill price and timeouts keep retrying while Maker data is unavailable', () => {
  const slip = fixture(); fillBuy(slip); slip.set(302); slip.sendBook('lighter', { bids: [[99, 10]], asks: [[100, 10]] });
  assert.equal(slip.scenario().inventory.lighterQuantity, 0); assert.equal(slip.scenario().stats.hedgeFailures, 1);
  const timeout = fixture({ hedgeWaitMs: 100 }); fillBuy(timeout);
  timeout.engine.invalidate({ venue: 'binance', channel: 'trades', symbol: 'BTC', reason: 'gap' });
  for (const at of [402, 1402, 1803, 2803, 3204]) { timeout.set(at); timeout.engine.tick(); }
  assert.equal(timeout.scenario().status, 'blocked'); assert.equal(timeout.scenario().stats.hedgeFailures, 3);
  assert.equal(timeout.scenario().inventory.binanceQuantity, 1); assert.equal(timeout.scenario().inventory.lighterQuantity, 0);
});

test('fresh Lighter alone can execute already submitted hedge during Binance/trade outage', () => {
  const f = fixture({ maxBookAgeMs: 1000 }); fillBuy(f);
  f.engine.invalidate({ venue: 'binance', channel: 'trades', symbol: 'BTC', reason: 'gap' });
  f.engine.invalidate({ venue: 'binance', channel: 'book', symbol: 'BTC', reason: 'gap' });
  assert.equal(f.scenario().status, 'recovering'); assert.equal(f.scenario().quotes.buy, null);
  f.set(302); f.sendBook('lighter'); assert.equal(f.scenario().inventory.lighterQuantity, -1);
  assert.equal(f.scenario().status, 'recovering'); assert.equal(f.scenario().stats.hedgeFailures, 0);
});

test('soft stale withdraws quotes but preserves inventory; fresh books cannot clear independent trade failure', () => {
  const f = fixture({ maxBookAgeMs: 1000, maxSourceAgeMs: 2000 }); fillBuy(f); f.set(302); f.sendBook('lighter');
  f.set(1303); f.engine.tick(); assert.equal(f.scenario().status, 'recovering'); assert.equal(f.scenario().quotes.sell, null);
  assert.equal(f.scenario().inventory.binanceQuantity, 1); assert.equal(f.scenario().stats.costPer10000, null);
  f.engine.invalidate({ venue: 'binance', channel: 'trades', symbol: 'BTC', reason: 'gap' }); freshBoth(f, 1400);
  assert.equal(f.scenario().reason, 'trade_channel_unavailable'); assert.equal(f.scenario().valuation.valid, true);
  f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'live' }); assert.equal(f.scenario().quotes.buy, null);
  f.set(1401); f.sendTrade({ quantity: 0 }); assert.ok(f.scenario().quotes.buy); assert.equal(f.scenario().inventory.binanceQuantity, 1);
});

test('real feed decoder requires a fresh zero-normal payload to recover after a stale trade', () => {
  const f = fixture({ maxBookAgeMs: 1000, maxSourceAgeMs: 2000 }, {}, false);
  const decoder = createCostFeedDecoder({ markets: f.markets, onStatus: status => f.engine.onStatus(status), onTrade: trade => f.engine.onTrade(trade) });
  const deliver = (at, seq, source, quantity = '0') => {
    f.set(at); decoder.handle('binance', 'trades', { e: 'aggTrade', s: 'BTCUSDC', a: seq, T: BASE + source,
      p: '100', nq: quantity, q: quantity, m: true }, { receivedAt: BASE + at, receivedMono: at });
  };
  deliver(0, 1, 0); assert.ok(f.scenario().quotes.buy);
  f.set(1); decoder.invalidate('binance', 'trades', 'BTC', 'sequence_gap'); freshBoth(f, 3001);
  deliver(3001, 2, 1); assert.equal(f.engine.tradeSequences.get('BTC'), '1'); assert.equal(f.scenario().quotes.buy, null);
  deliver(3001, 3, 3001); assert.ok(f.scenario().quotes.buy); assert.equal(f.scenario().inventory.binanceQuantity, 0);
  deliver(3002, 4, 3002, '1.1'); assert.equal(f.scenario().inventory.binanceQuantity, 1);
});

test('BigInt average cost handles increase, partial reduction, crossing zero and exact cash-flow identity', () => {
  const ledger = createInventoryLedger();
  for (const [side, quantity, price] of [['buy', '1.1', '100'], ['buy', '0.2', '103'], ['sell', '0.7', '104'],
    ['sell', '1.2', '98.13'], ['buy', '0.1', '97.33'], ['buy', '0.5', '101.000000000000000001']]) {
    applyInventoryFill(ledger, side, units(quantity), cashUnits(units(quantity), price));
    const marked = cashUnits(ledger.quantity, '102.123456789123456789');
    assert.equal(ledger.realized + inventoryUnrealized(ledger, '102.123456789123456789'), ledger.cash + marked);
    assert.ok(ledger.cost >= 0n);
  }
  assert.equal(ledger.quantity, 0n); assert.equal(ledger.cost, 0n); assert.equal(ledger.realized, ledger.cash);
  const short = createInventoryLedger(); applyInventoryFill(short, 'sell', units(2), units(200)); applyInventoryFill(short, 'buy', units(3), units(270));
  assert.equal(short.quantity, units(1)); assert.equal(short.cost, units(90)); assert.equal(short.realized, units(20));
});

test('marked PnL combines both venue ledgers and fees once, with all Binance fill turnover in denominator', () => {
  const f = fixture({ binanceMakerFeeBps: 1, lighterTakerFeeBps: 2 }); fillBuy(f); f.set(302); f.sendBook('lighter');
  let s = f.scenario(); assert.equal(s.stats.binanceTurnover, 100); assert.equal(s.stats.lighterTurnover, 100);
  assert.equal(s.stats.fees, 0.03); assert.equal(s.stats.realizedPnl, 0); assert.equal(s.stats.unrealizedPnl, 0);
  assert.equal(s.stats.netPnl, -0.03); assert.equal(s.stats.markedCost, 0.03); assert.equal(s.stats.costPer10000, 3);
  f.set(303); f.sendTrade({ buyerMaker: false, price: 101, quantity: 1.09 }); f.set(604); f.sendBook('lighter');
  s = f.scenario(); near(s.stats.binanceTurnover, 199.99); near(s.stats.lighterTurnover, 199.99);
  near(s.stats.realizedPnl, 0); near(s.stats.unrealizedPnl, 0); near(s.stats.fees, 0.059997);
  near(s.stats.costPer10000, 3); near(s.stats.netPnl, s.stats.realizedPnl + s.stats.unrealizedPnl - s.stats.fees);
  near(s.stats.markedCost, -s.stats.netPnl);
});

test('adverse and favorable hedge prices produce signed marked cost without double-counting slippage', () => {
  for (const [bid, expected] of [[99.97, 0.03], [100.03, -0.03]]) {
    const f = fixture(); fillBuy(f); f.set(302); f.sendBook('lighter', { bids: [[bid, 10]], asks: [[201 - bid, 10]] });
    near(f.scenario().stats.markedCost, expected); near(f.scenario().stats.costPer10000, expected * 100);
  }
});

test('valuation requires fresh identity-matched paired books but not trade liveness and preserves known accounting', () => {
  const f = fixture({ binanceMakerFeeBps: 1, maxBookAgeMs: 1000, maxPairSkewMs: 750 }); fillBuy(f); f.set(302); f.sendBook('lighter');
  f.engine.invalidate({ venue: 'binance', channel: 'trades', symbol: 'BTC', reason: 'gap' }); assert.equal(f.scenario().valuation.valid, true);
  f.set(1001); const stale = f.scenario(); assert.equal(stale.valuation.valid, false); assert.equal(stale.stats.netPnl, null);
  assert.equal(stale.stats.realizedPnl, 0); assert.equal(stale.stats.fees, 0.01); assert.equal(stale.stats.binanceTurnover, 100);
  f.sendBook('binance', { nativeSymbol: 'BTCUSDT' }); assert.equal(f.scenario().valuation.valid, false);
  freshBoth(f, 1002); assert.equal(f.scenario().valuation.valid, true);
  f.set(1800); f.sendBook('lighter'); assert.equal(f.scenario().valuation.reason, 'book_pair_skew');
});

test('funding scenario uses absolute remaining Binance average-cost notional and stops accumulating after stop', () => {
  const f = fixture({ fundingCostBpsPerHour: 10 }); fillBuy(f); f.set(302); f.sendBook('lighter');
  f.set(1001); let s = f.scenario(); near(s.stats.fundingScenarioCost, 100 * 1000 / 3600000 * 10 / 10000);
  assert.ok(s.stats.modeledCostPer10000 > s.stats.costPer10000); f.engine.stop(); const snapshot = f.engine.report();
  f.set(50000); assert.deepEqual(f.engine.report(), snapshot);
  const short = fixture({ fundingCostBpsPerHour: -10 }); short.set(1); short.sendTrade({ buyerMaker: false, price: 101, quantity: 1.09 });
  short.set(1001); assert.ok(short.scenario().stats.fundingScenarioCost < 0);
  assert.equal(fixture().scenario().stats.fundingScenarioCost, null);
});

test('small partial Maker tails remain exact and visible instead of rounding to a false flat account', () => {
  const f = fixture({}, { lighter: { quantityStep: 0.1, minQuantity: 0.1, minNotional: 9 } }); fillBuy(f, 1, 0.25);
  assert.equal(f.scenario().inventory.binanceQuantity, 0.15); assert.equal(f.scenario().hedge.quantity, 0.1);
  f.set(302); f.sendBook('lighter'); assert.equal(f.scenario().inventory.residualQuantity, 0.05); assert.equal(f.scenario().hedge, null);
  assert.notEqual(f.scenario().status, 'blocked'); assert.equal(f.scenario().stats.hedgeFills, 1);
});

test('stop cancels orders and freezes quote/valuation timestamps without clearing either inventory leg', () => {
  const f = fixture(); fillBuy(f); f.set(302); f.sendBook('lighter'); f.engine.stop(); const before = f.engine.report();
  assert.equal(before.stopped, true); assert.equal(before.interrupted, true); assert.equal(f.scenario().status, 'stopped');
  assert.equal(f.scenario().inventory.binanceQuantity, 1); assert.equal(f.scenario().inventory.lighterQuantity, -1); assert.equal(f.engine.execution.orders.size, 0);
  f.set(50000); f.sendBook('lighter'); f.sendTrade(); f.engine.tick(); assert.deepEqual(f.engine.report(), before);
  const empty = fixture(); empty.engine.stop(); assert.equal(empty.engine.report().interrupted, false);
});

test('market metadata refresh preserves account while semantic changes permanently block it with balances intact', () => {
  const f = fixture(); fillBuy(f); f.engine.setMarkets(f.markets.map(row => ({ ...row, observedAt: BASE + 1 })));
  assert.equal(f.scenario().inventory.binanceQuantity, 1); assert.notEqual(f.scenario().status, 'blocked');
  f.engine.setMarkets(f.markets.map(row => ({ ...row, quantityStep: 0.02, observedAt: BASE + 1 })));
  assert.equal(f.scenario().reason, 'market_rules_changed'); assert.equal(f.scenario().status, 'blocked'); assert.equal(f.scenario().inventory.binanceQuantity, 1);
  f.set(302); f.sendBook('lighter'); assert.equal(f.scenario().inventory.lighterQuantity, 0);
  const expired = fixture(); expired.set(20 * 60000 + 1); expired.engine.tick(); assert.equal(expired.scenario().reason, 'market_metadata_unavailable');
});

test('bad market identities, quantity steps and ticks cannot create simulated quotes', () => {
  for (const patch of [{ quantityStep: 1e-30 }, { nativeSymbol: 'BTCUSDT' }, { multiplier: 1000 }, { quote: 'USDT' }, { tickSize: 0.03 }]) {
    const f = fixture({}, { binance: patch }); assert.equal(f.scenario().quotes.buy, null); assert.equal(f.scenario().quotes.sell, null);
  }
});

test('independent latency scenarios and cloned config cannot share holdings or fees', () => {
  const f = fixture({ latencyScenarios: [300, 600] }); f.config.binanceMakerFeeBps = 100; fillBuy(f); f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario(300).inventory.lighterQuantity, -1); assert.equal(f.scenario(600).inventory.lighterQuantity, 0);
  assert.equal(f.engine.report().sessionConfig.binanceMakerFeeBps, 0);
  const report = f.engine.report(); report.sessionConfig.symbols.length = 0; report.scenarios[0].stats.fees = 99;
  assert.equal(f.engine.report().sessionConfig.symbols.length, 1); assert.equal(f.scenario().stats.fees, 0);
});

test('long sessions retain bounded evidence while cumulative accounting and quote execution keep running', () => {
  const f = fixture({ inventorySkewBps: 0, orderNotional: 101 });
  for (let cycle = 0; cycle < 320; cycle++) {
    const base = cycle * 2000; if (cycle) { freshBoth(f, base); f.sendTrade({ quantity: 0 }); }
    fillBuy(f, base + 1); f.set(base + 302); f.sendBook('lighter');
    f.set(base + 303); f.sendTrade({ buyerMaker: false, price: 101, quantity: 1.1 });
    f.set(base + 604); f.sendBook('lighter'); freshBoth(f, base + 1000);
  }
  const s = f.scenario(); assert.notEqual(s.status, 'blocked'); assert.ok(s.stats.makerFills > 300); assert.ok(s.stats.binanceTurnover > 30000);
  assert.equal(s.recentFills.length, 200); assert.equal(s.history.length, 300); assert.equal(s.events.length, 30);
  assert.ok(f.engine.execution.orders.size <= 3); assert.ok(Buffer.byteLength(JSON.stringify(f.engine.report())) < 500000);
  assert.ok(s.history.at(-1).at - s.history[0].at >= 299000);
});

test('50ms ticks do not fill the 300 point curve and summary never reads the rolling detail buffers', () => {
  const f = fixture({ latencyScenarios: [300, 600] });
  for (let at = 50; at <= 1000; at += 50) { f.set(at); f.engine.tick(); }
  assert.equal(f.scenario().history.length, 2); const full = f.engine.report(), source = f.engine.scenarios[0];
  const descriptors = ['recentFills', 'history', 'events'].map(key => [key, Object.getOwnPropertyDescriptor(source, key)]);
  for (const [key] of descriptors) Object.defineProperty(source, key, { configurable: true, get() { throw new Error('summary_read_full_history'); } });
  try {
    const summary = f.engine.report({ summary: true }); assert.equal(summary.detailLevel, 'summary');
    assert.deepEqual(summary.scenarios[0].stats, full.scenarios[0].stats); assert.deepEqual(summary.scenarios[0].inventory, full.scenarios[0].inventory);
    assert.deepEqual(summary.scenarios[0].recentFills, []); assert.deepEqual(summary.scenarios[0].events, []); assert.deepEqual(summary.scenarios[0].history, []);
  } finally { for (const [key, descriptor] of descriptors) Object.defineProperty(source, key, descriptor); }
  const excluded = f.engine.scenarios[1], original = Object.getOwnPropertyDescriptor(excluded, 'stats');
  Object.defineProperty(excluded, 'stats', { configurable: true, get() { throw new Error('unselected_scenario_read'); } });
  try { assert.deepEqual(f.engine.report({ scenarioId: source.id }).scenarios, [full.scenarios[0]]); }
  finally { Object.defineProperty(excluded, 'stats', original); }
});

test('engine and independent adapter bound decimal sequence length before BigInt and reject legacy phase contracts', () => {
  const f = fixture(); f.set(1); f.sendBook('binance', { sequence: '9'.repeat(41) }); assert.equal(f.scenario().valuation.valid, false);
  const trade = fixture(); trade.set(1); trade.sendTrade({ sequence: '9'.repeat(41) }); assert.equal(trade.scenario().quotes.buy, null);
  const boundary = fixture(); boundary.set(1); boundary.sendTrade({ sequence: '9'.repeat(40) }); assert.equal(boundary.scenario().inventory.binanceQuantity, 1);
  const execution = createCostExecution(), intent = { version: 2, clientOrderId: 'independent', venue: 'binance', symbol: 'BTC', side: 'buy', phase: 'quote',
    type: 'limit_maker', quantity: 1, limitPrice: 100, submittedAt: BASE, submittedMono: 0, sourceAfter: BASE, queueAhead: 0 };
  assert.throws(() => execution.submitOrder({ ...intent, version: 1, phase: 'entry' }), /invalid_order_intent/);
  assert.throws(() => execution.submitOrder({ ...intent, queueAhead: undefined }), /invalid_order_intent/);
  execution.submitOrder(intent); assert.equal(execution.observeTrade('independent', boundary.trade({ sequence: '9'.repeat(41) })), null);
  assert.equal(execution.queryOrder('independent').status, 'invalidated'); assert.equal(execution.queryOrder('independent').filledQuantity, 0);
});

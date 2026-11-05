import test from 'node:test';
import assert from 'node:assert/strict';
import { CostLabEngine, DEFAULT_COST_CONFIG, validateCostConfig } from '../server/research/binance-lighter-core.mjs';
import { createCostExecution, EXECUTION_CONTRACT } from '../server/research/binance-lighter-execution.mjs';
import { createCostFeedDecoder } from '../server/research/binance-lighter-feeds.mjs';

const BASE = 1800000000000;
function fixture(patch = {}, marketPatch = {}, readyTrades = true) {
  let time = 0, sequence = 0;
  const events = [];
  const config = { ...structuredClone(DEFAULT_COST_CONFIG), symbols: ['BTC'], latencyScenarios: [300], notionalPerLeg: 100,
    holdMs: 0, makerWaitMs: 1000, maxBookAgeMs: 5000, maxSourceAgeMs: 10000, maxPairSkewMs: 5000, ...patch };
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
  const scenario = (direction = 'buy', latency = 300) => engine.report().scenarios.find(row => row.direction === direction && row.latencyMs === latency);
  engine.setMarkets(markets); sendBook('binance'); sendBook('lighter');
  if (readyTrades) sendTrade({ quantity: 0 });
  return { engine, config, markets, events, set, book, sendBook, trade, sendTrade, scenario };
}
function completeBuy(f) {
  f.set(1); f.sendTrade();
  f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario().status, 'maker_exit');
  f.set(303); f.sendTrade({ buyerMaker: false, price: 101 });
  f.set(604); f.sendBook('lighter');
  return f.scenario();
}

test('configuration is strict, cloned, and cannot enable live execution or inject transports', () => {
  const input = structuredClone(DEFAULT_COST_CONFIG), result = validateCostConfig(input);
  result.symbols.pop(); assert.equal(input.symbols.length, 2);
  for (const patch of [{ mode: 'live' }, { url: 'https://example.com' }, { symbols: [] }, { latencyScenarios: [299] },
    { latencyScenarios: [300, 300] }, { makerWaitMs: 1000.1 }, { notionalPerLeg: NaN }, { queueMultiplier: 0.9 }, { fundingCostBpsPerHour: 101 }]) {
    assert.throws(() => validateCostConfig({ ...input, ...patch }), /invalid_cost_config/);
  }
  assert.throws(() => createCostExecution({ mode: 'live' }), /live_execution_unavailable/);
  assert.throws(() => createCostExecution({ request: () => {} }), /live_execution_unavailable/);
  assert.equal(EXECUTION_CONTRACT.liveAvailable, false);
});

test('book touches and cancellations never fill a Maker order; only later matching aggressive quantity consumes its frozen queue', () => {
  const f = fixture();
  f.set(1); f.sendBook('binance', { bids: [[100, 0.01]], asks: [[101, 0.01]] });
  assert.equal(f.scenario().task.maker.queueAhead, 0.1);
  f.sendTrade({ sourceAt: BASE, quantity: 100 });
  f.sendTrade({ buyerMaker: false, quantity: 100 });
  f.sendTrade({ price: 100.01, quantity: 100 });
  assert.equal(f.scenario().task.binanceQuantity, 0);
  f.set(2); const first = f.sendTrade({ quantity: 0.06 });
  assert.equal(f.scenario().task.maker.queueAhead, 0.04);
  f.engine.onTrade(first); assert.equal(f.scenario().task.maker.queueAhead, 0.04);
  f.set(3); f.sendTrade({ quantity: 0.09 });
  assert.equal(f.scenario().task.binanceQuantity, 0.05);
  assert.equal(f.scenario().task.pendingHedges[0].quantity, 0.05);
});

test('the receive timestamp and source timestamp both have to follow placement evidence', () => {
  const f = fixture(); f.set(1);
  f.sendTrade({ receivedMono: 0, receivedAt: BASE });
  f.sendTrade({ sourceAt: BASE });
  assert.equal(f.scenario().task.binanceQuantity, 0);
  f.sendTrade(); assert.equal(f.scenario().task.binanceQuantity, 1);
});

test('hedges require a newly received book after 300ms and cannot execute on a tick or duplicate cached frame', () => {
  const f = fixture(); f.set(1); f.sendTrade();
  f.set(301); const atDeadline = f.sendBook('lighter');
  assert.equal(f.scenario().task.lighterQuantity, 0);
  f.set(302); f.engine.tick(); f.engine.onBook(atDeadline);
  assert.equal(f.scenario().task.lighterQuantity, 0);
  f.sendBook('lighter'); assert.equal(f.scenario().task.lighterQuantity, -1);
});

test('small Lighter source clock lead does not shorten monotonic delay or extend stale receive age', () => {
  const f = fixture({ maxBookAgeMs: 1000 });
  f.set(1); f.sendBook('lighter', { sourceAt: BASE + 91.5 }); f.sendTrade();
  f.set(300); f.sendBook('lighter', { sourceAt: BASE + 390.5 });
  assert.equal(f.scenario().task.lighterQuantity, 0);
  assert.equal(f.engine.report().books.find(row => row.venue === 'lighter').sourceClockUncertain, true);
  f.set(302); f.sendBook('lighter', { sourceAt: BASE + 392.5 });
  assert.equal(f.scenario().task.lighterQuantity, -1);
  f.set(1303); f.engine.tick(); assert.equal(f.scenario().status, 'unresolved');
  const far = fixture(); far.set(1); far.sendBook('lighter', { sourceAt: BASE + 252 });
  assert.equal(far.engine.report().books.find(row => row.venue === 'lighter').valid, false);
});

test('four-leg cash flow, fee signs and cost denominator use only closed Binance turnover', () => {
  const f = fixture({ binanceMakerFeeBps: 1, lighterTakerFeeBps: 2 });
  const result = completeBuy(f), round = result.recentRounds[0];
  assert.equal(result.stats.completed, 1); assert.equal(round.fills.length, 4);
  assert.equal(round.binanceTurnover, 201); assert.equal(round.tradingPnl, 0);
  assert.equal(round.fees, 0.0603); assert.equal(round.tradingCost, 0.0603);
  assert.equal(round.costPer10000, 3); assert.equal(result.stats.closedBinanceTurnover, 201);
  assert.equal(result.stats.costPer10000, 3); assert.equal(round.fundingScenarioCost, null);
  assert.equal(round.modeledCostPer10000, null);
  assert.equal(Object.hasOwn(result.stats, 'reward'), false);
  assert.equal(Object.hasOwn(f.engine.report(), 'total'), false);
  f.set(4000); f.sendBook('binance'); f.sendBook('lighter');
  f.set(4001); f.sendTrade({ quantity: 0.6 });
  assert.equal(f.scenario().stats.binanceTurnover, 251);
  assert.equal(f.scenario().stats.closedBinanceTurnover, 201);
  assert.equal(f.scenario().stats.costPer10000, 3);
});

test('sell direction preserves signed inventories and completes the reverse cash flows', () => {
  const f = fixture({ notionalPerLeg: 101 });
  f.set(1); f.sendTrade({ buyerMaker: false, price: 101 });
  assert.equal(f.scenario('sell').task.binanceQuantity, -1);
  f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario('sell').task.lighterQuantity, 1);
  f.set(303); f.sendTrade(); f.set(604); f.sendBook('lighter');
  const result = f.scenario('sell'); assert.equal(result.stats.completed, 1); assert.equal(result.stats.tradingPnl, 0);
});

test('partial Maker fills hedge their actual quantity, and a timed-out partial entry can complete a smaller round', () => {
  const f = fixture(); f.set(1); f.sendTrade({ quantity: 0.5 });
  assert.equal(f.scenario().task.binanceQuantity, 0.4);
  f.set(302); f.sendBook('lighter'); assert.equal(f.scenario().task.lighterQuantity, -0.4);
  f.set(1000); f.engine.tick(); assert.equal(f.scenario().status, 'maker_exit');
  f.set(1001); f.sendTrade({ price: 101, buyerMaker: false, quantity: 0.5 });
  f.set(1302); f.sendBook('lighter');
  const result = f.scenario(); assert.equal(result.stats.completed, 1); assert.equal(result.recentRounds[0].quantity, 0.4);
  assert.equal(result.stats.closedBinanceTurnover, 80.4);
});

test('sub-step Maker tails remain visible and block completion rather than being rounded to flat', () => {
  const f = fixture({}, { lighter: { quantityStep: 0.1, minQuantity: 0.1, minNotional: 9 } });
  f.set(1); f.sendTrade({ quantity: 0.25 });
  assert.equal(f.scenario().task.binanceQuantity, 0.15); assert.equal(f.scenario().task.pendingHedges[0].quantity, 0.1);
  f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario().task.residualQuantity, 0.05);
  f.set(1000); f.engine.tick(); assert.equal(f.scenario().status, 'unresolved');
  assert.equal(f.scenario().task.residualQuantity, 0.05); assert.equal(f.scenario().stats.completed, 0);
});

test('insufficient depth creates an actual partial IOC and retains both legs and the unknown round', () => {
  const f = fixture(); f.set(1); f.sendTrade();
  f.set(302); f.sendBook('lighter', { bids: [[100, 0.4]], asks: [[101, 10]] });
  const result = f.scenario(); assert.equal(result.status, 'unresolved');
  assert.equal(result.task.binanceQuantity, 1); assert.equal(result.task.lighterQuantity, -0.4); assert.equal(result.task.residualQuantity, 0.6);
  assert.equal(result.recentRounds[0].fills.length, 2); assert.equal(result.recentRounds[0].tradingPnl, null);
  assert.equal(result.stats.closedBinanceTurnover, 0); assert.equal(result.stats.costPer10000, null);
});

test('concurrent hedges in one scenario consume a single frame depth once', () => {
  const f = fixture(); f.set(1); f.sendTrade({ quantity: 0.6 });
  f.set(2); f.sendTrade({ quantity: 0.5 });
  assert.equal(f.scenario().task.pendingHedges.length, 2);
  f.set(303); f.sendBook('lighter', { bids: [[100, 0.7]], asks: [[101, 10]] });
  assert.equal(f.scenario().status, 'unresolved'); assert.equal(f.scenario().task.lighterQuantity, -0.7);
  assert.equal(f.scenario().task.residualQuantity, 0.3);
});

test('slippage guard does not substitute a fictitious hedge price', () => {
  const f = fixture(); f.set(1); f.sendTrade();
  f.set(302); f.sendBook('lighter', { bids: [[99, 10]], asks: [[100, 10]] });
  assert.equal(f.scenario().status, 'unresolved'); assert.equal(f.scenario().task.lighterQuantity, 0);
  assert.equal(f.scenario().task.residualQuantity, 1);
});

test('hedge timeout, exit timeout, disconnect and stop preserve exposure and cannot resume it', () => {
  const timeout = fixture({ hedgeWaitMs: 100 }); timeout.set(1); timeout.sendTrade(); timeout.set(402); timeout.engine.tick();
  assert.equal(timeout.scenario().reason, 'hedge_timeout'); assert.equal(timeout.scenario().task.binanceQuantity, 1);
  const exit = fixture(); exit.set(1); exit.sendTrade(); exit.set(302); exit.sendBook('lighter'); exit.set(1302); exit.engine.tick();
  assert.equal(exit.scenario().reason, 'exit_maker_timeout'); assert.equal(exit.scenario().task.lighterQuantity, -1);
  const disconnect = fixture(); disconnect.set(1); disconnect.sendTrade();
  disconnect.engine.invalidate({ venue: 'lighter', channel: 'book', symbol: 'BTC', reason: 'gap' });
  disconnect.set(2); disconnect.sendBook('lighter'); assert.equal(disconnect.scenario().status, 'unresolved');
  const stopped = fixture(); stopped.set(1); stopped.sendTrade(); stopped.engine.stop();
  const before = stopped.engine.report(); assert.equal(before.interrupted, true); assert.equal(before.stopped, true);
  stopped.set(500); stopped.sendBook('lighter'); stopped.sendTrade(); stopped.engine.tick();
  assert.deepEqual(stopped.scenario().task, before.scenarios[0].task); assert.equal(stopped.scenario().stats.binanceTurnover, 100);
  assert.equal(stopped.engine.report().updatedAt, before.updatedAt);
  assert.deepEqual(stopped.engine.report().books, before.books);
});

test('metadata refresh preserves tasks but semantic change and expiry retain risk as unresolved', () => {
  const f = fixture(); f.set(1); f.sendTrade();
  f.engine.setMarkets(f.markets.map(row => ({ ...row, observedAt: BASE + 1 })));
  assert.equal(f.scenario().task.binanceQuantity, 1);
  f.engine.setMarkets(f.markets.map(row => ({ ...row, quantityStep: 0.02, observedAt: BASE + 1 })));
  assert.equal(f.scenario().reason, 'market_rules_changed');
  const expire = fixture(); expire.set(20 * 60000 + 1); expire.sendBook('binance'); expire.sendBook('lighter');
  expire.set(20 * 60000 + 3001); expire.engine.tick();
  assert.equal(expire.scenario().status, 'waiting'); assert.equal(expire.scenario().reason, 'market_metadata_unavailable');
});

test('adverse hedge prices are counted once as loss and favorable ones as negative trading cost', () => {
  const f = fixture(); f.set(1); f.sendTrade();
  f.set(302); f.sendBook('lighter', { bids: [[99.97, 10]], asks: [[101, 10]] });
  f.set(303); f.sendTrade({ buyerMaker: false, price: 101 });
  f.set(604); f.sendBook('lighter', { bids: [[100, 10]], asks: [[101.03, 10]] });
  assert.equal(f.scenario().stats.tradingPnl, -0.06); assert.equal(f.scenario().stats.tradingCost, 0.06);
  const positive = fixture(); positive.set(1); positive.sendTrade();
  positive.set(302); positive.sendBook('lighter', { bids: [[100.03, 10]], asks: [[101, 10]] });
  positive.set(303); positive.sendTrade({ buyerMaker: false, price: 101 });
  positive.set(604); positive.sendBook('lighter', { bids: [[100, 10]], asks: [[100.97, 10]] });
  assert.equal(positive.scenario().stats.tradingPnl, 0.06); assert.equal(positive.scenario().stats.tradingCost, -0.06);
});

test('unfilled rounds and histories remain bounded, and a stop before any fill is clean', () => {
  const f = fixture({ cooldownMs: 0 });
  for (let index = 0; index < 310; index++) {
    f.set(index * 1001 + 1000); f.sendBook('binance'); f.sendBook('lighter'); f.engine.tick();
  }
  assert.equal(f.scenario().stats.unfilled, 310);
  assert.equal(f.scenario().recentRounds.length, 20); assert.equal(f.scenario().history.length, 300);
  assert.ok(f.engine.execution.orders.size <= 2);
  f.engine.stop(); assert.equal(f.engine.report().interrupted, false); assert.equal(f.scenario().task, null);
});

test('funding is explicitly modeled with the sign and exposure duration; zero fee assumption stays separate', () => {
  const f = fixture({ fundingCostBpsPerHour: 10 }); const result = completeBuy(f);
  // Binance notional 100 is held from t=1 until the Binance exit at t=303.
  assert.ok(Math.abs(result.recentRounds[0].fundingScenarioCost - 100 * 302 / 3600000 * 10 / 10000) < 1e-12);
  assert.ok(result.stats.modeledCostPer10000 > result.stats.costPer10000);
  const negative = fixture({ fundingCostBpsPerHour: -10 }); completeBuy(negative);
  assert.ok(negative.scenario().stats.modeledCostPer10000 < 0);
});

test('source config is immutable and latency scenarios remain independent', () => {
  const f = fixture({ latencyScenarios: [300, 600] }); f.config.binanceMakerFeeBps = 100;
  f.set(1); f.sendTrade(); f.set(302); f.sendBook('lighter');
  assert.equal(f.scenario('buy', 300).task.lighterQuantity, -1);
  assert.equal(f.scenario('buy', 600).task.lighterQuantity, 0);
  assert.equal(f.engine.report().sessionConfig.binanceMakerFeeBps, 0);
  const report = f.engine.report(); report.sessionConfig.symbols.length = 0; report.scenarios[0].stats.fees = 99;
  assert.equal(f.engine.report().sessionConfig.symbols.length, 1); assert.equal(f.scenario().stats.fees, 0);
});

test('invalid steps and market identities do not create simulated orders', () => {
  for (const patch of [{ quantityStep: 1e-30 }, { nativeSymbol: 'BTCUSDT' }, { multiplier: 1000 }, { quote: 'USDT' }]) {
    const f = fixture({}, { binance: patch }); assert.equal(f.scenario().stats.attempts, 0);
  }
});

test('many partial fills hit a finite evidence bound without discarding positions, and reports fit storage', () => {
  const f = fixture({ notionalPerLeg: 1000 });
  for (let i = 1; i <= 64; i++) { f.set(i); f.sendTrade({ quantity: i === 1 ? 0.11 : 0.01 }); }
  const scenario = f.scenario(); assert.equal(scenario.status, 'unresolved'); assert.equal(scenario.reason, 'fill_limit');
  assert.equal(scenario.task.binanceQuantity, 0.64); assert.equal(scenario.recentRounds[0].fills.length, 64);
  f.set(65); f.sendTrade({ quantity: 100 }); assert.equal(f.scenario().task.binanceQuantity, 0.64);
  // Max configuration cardinalities, long UUID-based identities and full histories.
  const report = f.engine.report(), round = scenario.recentRounds[0];
  for (const fill of round.fills) { fill.id += 'x'.repeat(80); fill.clientOrderId += 'x'.repeat(80); }
  report.scenarios = Array.from({ length: 12 }, () => ({ ...scenario,
    recentRounds: Array.from({ length: 20 }, () => round),
    history: Array.from({ length: 300 }, () => ({ at: BASE, costPer10000: 123.456789, modeledCostPer10000: 123.456789 })),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 8 * 1024 * 1024);
});

test('startup waits for trade-channel evidence; a first trade can establish health but cannot retroactively fill a new Maker', () => {
  const f = fixture({}, {}, false);
  assert.equal(f.scenario().status, 'waiting'); assert.equal(f.scenario().reason, 'trade_channel_unavailable');
  assert.equal(f.scenario().stats.attempts, 0);
  f.set(1); f.sendTrade();
  assert.equal(f.scenario().stats.attempts, 1); assert.equal(f.scenario().task.binanceQuantity, 0);
  f.set(2); f.sendTrade(); assert.equal(f.scenario().task.binanceQuantity, 1);
  const zeroNormal = fixture({}, {}, false);
  zeroNormal.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'live', at: BASE });
  assert.equal(zeroNormal.scenario().stats.attempts, 0, 'a transport notice cannot prove trade freshness');
  zeroNormal.sendTrade({ quantity: 0 });
  assert.equal(zeroNormal.scenario().status, 'maker_entry');
  assert.equal(zeroNormal.scenario().task.binanceQuantity, 0, 'a valid nq=0 payload can prove channel health without fabricating quantity');
});

test('a healthy book cannot clear a failed trade channel or resume its discarded queue', () => {
  const f = fixture();
  f.set(1); f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'fault', reason: 'reconnect_exhausted', at: BASE + 1 });
  f.set(4000); f.sendBook('binance'); f.sendBook('lighter');
  f.engine.onStatus({ venue: 'binance', channel: 'book', symbol: 'BTC', state: 'live', at: BASE + 4000 });
  assert.equal(f.scenario().status, 'waiting'); assert.equal(f.scenario().reason, 'trade_channel_unavailable');
  assert.equal(f.scenario().stats.attempts, 1); assert.equal(f.scenario().task, null);
  assert.equal(f.engine.report().books.find(row => row.venue === 'binance').valid, true, 'quote quality and trade-channel health are separate');
  f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'connecting', at: BASE + 4000 });
  f.engine.tick(); assert.equal(f.scenario().stats.attempts, 1);
  f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'live', at: BASE + 4000 });
  assert.equal(f.scenario().stats.attempts, 1);
  f.sendTrade({ quantity: 0 });
  assert.equal(f.scenario().stats.attempts, 2); assert.equal(f.scenario().task.maker.queueAhead, 0.1);
  f.set(4001); f.sendTrade(); assert.equal(f.scenario().task.binanceQuantity, 1);
});

test('real decoder live notices cannot recover stale trades; fresh zero-normal trades prove recovery without filling queues', () => {
  const f = fixture({ maxBookAgeMs: 1000, maxSourceAgeMs: 2000 }, {}, false);
  const decoder = createCostFeedDecoder({ markets: f.markets, onStatus: status => f.engine.onStatus(status), onTrade: trade => f.engine.onTrade(trade) });
  const deliver = (at, seq, source, quantity = '0') => {
    f.set(at);
    decoder.handle('binance', 'trades', { e: 'aggTrade', s: 'BTCUSDC', a: seq, T: BASE + source,
      p: '100', nq: quantity, q: quantity, m: true }, { receivedAt: BASE + at, receivedMono: at });
  };
  deliver(0, 1, 0);
  assert.equal(f.scenario().status, 'maker_entry'); assert.equal(f.scenario().stats.attempts, 1);
  f.set(1); decoder.invalidate('binance', 'trades', 'BTC', 'sequence_gap');
  f.set(3001); f.sendBook('binance'); f.sendBook('lighter');
  deliver(3001, 2, 1);
  assert.equal(f.engine.tradeSequences.get('BTC'), '1');
  assert.equal(f.engine.quality('BTC'), 'trade_channel_unavailable');
  assert.equal(f.scenario().stats.attempts, 1); assert.equal(f.scenario().task, null);
  deliver(3001, 3, 3001);
  assert.equal(f.scenario().status, 'maker_entry'); assert.equal(f.scenario().stats.attempts, 2);
  assert.equal(f.scenario().task.binanceQuantity, 0); assert.equal(f.scenario().task.maker.queueAhead, 0.1);
  deliver(3002, 4, 3002, '1.1');
  assert.equal(f.scenario().task.binanceQuantity, 1);
  f.set(3303); f.sendBook('lighter');
  assert.equal(f.scenario().task.lighterQuantity, -1, 'genuinely fresh trade recovery still reaches a hedged position');
});

test('a newly received stale trade revokes earlier health and preserves already-filled exposure', () => {
  for (const quantity of [0, 1]) {
    const f = fixture({ maxBookAgeMs: 5000, maxSourceAgeMs: 2000 });
    f.set(1); f.sendTrade({ quantity: 0.5 });
    assert.equal(f.scenario().task.binanceQuantity, 0.4);
    f.set(3001); f.sendTrade({ sourceAt: BASE + 1, quantity });
    assert.equal(f.engine.quality('BTC'), 'book_unavailable');
    f.sendBook('binance'); f.sendBook('lighter');
    assert.equal(f.engine.quality('BTC'), 'trade_channel_unavailable');
    assert.equal(f.scenario().status, 'unresolved'); assert.equal(f.scenario().task.binanceQuantity, 0.4);
    assert.equal(f.scenario().reason, 'trades:invalid_trade_time');
  }
});

test('trade stream failure after a partial fill remains unresolved even after both channels recover', () => {
  const f = fixture(); f.set(1); f.sendTrade({ quantity: 0.5 });
  f.engine.invalidate({ venue: 'binance', channel: 'trades', symbol: 'BTC', reason: 'sequence_gap' });
  f.set(4000); f.sendBook('binance'); f.sendBook('lighter');
  f.engine.onStatus({ venue: 'binance', channel: 'trades', symbol: 'BTC', state: 'live', at: BASE + 4000 });
  f.set(4001); f.sendTrade();
  assert.equal(f.scenario().status, 'unresolved'); assert.equal(f.scenario().stats.attempts, 1);
  assert.equal(f.scenario().task.binanceQuantity, 0.4); assert.equal(f.scenario().task.lighterQuantity, 0);
});

test('a delayed old Lighter source frame cannot hedge a later Maker; the due-time source bound retains clock tolerance', () => {
  const prepare = () => {
    const f = fixture({ makerWaitMs: 5000 });
    f.set(500); f.sendBook('lighter');
    f.set(1000); f.sendTrade();
    f.set(1301); f.sendBook('lighter', { sourceAt: BASE + 700 });
    assert.equal(f.scenario().task.lighterQuantity, 0);
    assert.equal(f.scenario().task.pendingHedges.length, 1);
    assert.equal(f.scenario().status, 'hedge_entry');
    return f;
  };
  const restored = prepare();
  restored.set(1302); restored.sendBook('lighter', { sourceAt: BASE + 1049.99 });
  assert.equal(restored.scenario().task.lighterQuantity, 0, 'source below dueAt minus 250ms remains ineligible');
  restored.set(1303); restored.sendBook('lighter', { sourceAt: BASE + 1050 });
  assert.equal(restored.scenario().task.lighterQuantity, -1, 'source at the allowed clock boundary can execute after monotonic due time');
  const expired = prepare(); expired.set(3301); expired.engine.tick();
  assert.equal(expired.scenario().reason, 'hedge_timeout'); assert.equal(expired.scenario().task.residualQuantity, 1);
});

test('engine and independent adapter bound decimal sequence length before BigInt and invalidate bad sources', () => {
  const book = fixture(); book.set(1); book.sendBook('binance', { sequence: '9'.repeat(41) });
  assert.equal(book.engine.report().books.find(row => row.venue === 'binance').valid, false);
  assert.equal(book.scenario().task, null);
  const trade = fixture(); trade.set(1); trade.sendTrade({ sequence: '9'.repeat(41) });
  trade.set(4000); trade.sendBook('binance'); trade.sendBook('lighter');
  assert.equal(trade.scenario().reason, 'trade_channel_unavailable'); assert.equal(trade.scenario().stats.attempts, 1);
  const boundary = fixture(); boundary.set(1); boundary.sendTrade({ sequence: '9'.repeat(40) });
  assert.equal(boundary.scenario().task.binanceQuantity, 1);
  const execution = createCostExecution();
  execution.submitOrder({ version: 1, clientOrderId: 'independent', venue: 'binance', symbol: 'BTC', side: 'buy', phase: 'entry',
    type: 'limit_maker', quantity: 1, limitPrice: 100, submittedAt: BASE, submittedMono: 0, sourceAfter: BASE, queueAhead: 0 });
  assert.equal(execution.observeTrade('independent', boundary.trade({ sequence: '9'.repeat(41) })), null);
  assert.equal(execution.queryOrder('independent').status, 'invalidated');
  assert.equal(execution.queryOrder('independent').filledQuantity, 0);
});

test('summary preserves task and statistics without even reading history, and scenario projection filters before cloning', () => {
  const f = fixture(); f.set(1); f.sendTrade({ quantity: 0.5 });
  const full = f.engine.report();
  assert.equal(full.detailLevel, 'full');
  const source = f.engine.scenarios[0];
  const descriptors = ['recentRounds', 'history'].map(key => [key, Object.getOwnPropertyDescriptor(source, key)]);
  for (const [key] of descriptors) Object.defineProperty(source, key, { configurable: true, get() { throw new Error('summary_read_full_history'); } });
  try {
    const summary = f.engine.report({ summary: true });
    assert.equal(summary.detailLevel, 'summary'); assert.equal(summary.scenarios.length, full.scenarios.length);
    assert.deepEqual(summary.scenarios[0].stats, full.scenarios[0].stats); assert.deepEqual(summary.scenarios[0].task, full.scenarios[0].task);
    assert.deepEqual(summary.scenarios[0].recentRounds, []); assert.deepEqual(summary.scenarios[0].history, []);
  } finally { for (const [key, descriptor] of descriptors) Object.defineProperty(source, key, descriptor); }
  const excluded = f.engine.scenarios[1], original = Object.getOwnPropertyDescriptor(excluded, 'stats');
  Object.defineProperty(excluded, 'stats', { configurable: true, get() { throw new Error('unselected_scenario_cloned'); } });
  try {
    const selected = f.engine.report({ scenarioId: source.id });
    assert.equal(selected.detailLevel, 'scenario'); assert.deepEqual(selected.scenarios, [full.scenarios[0]]);
    assert.deepEqual(f.engine.report({ scenarioId: 'not-present' }).scenarios, []);
  } finally { Object.defineProperty(excluded, 'stats', original); }
});

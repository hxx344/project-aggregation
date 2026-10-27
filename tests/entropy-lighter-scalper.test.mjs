import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BinanceScalper } from '../tools/entropy-lighter-lab/binance-scalper.mjs';
import { sweep } from '../tools/entropy-lighter-lab/core.mjs';

const base = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
const WALL = 1800000000000;
function harness({ scenarios = [{ name: 'base', entropyMs: 10 }], simulation = {}, maxBookAgeMs = 1000 } = {}) {
  const config = structuredClone(base);
  config.maxBookAgeMs = maxBookAgeMs;
  Object.assign(config.simulation, { enabled: false, verifiedSymbols: [], notionalPerLeg: 100, holdMs: 100,
    cooldownMs: 1000, fillWaitMs: 100, slippageBpsPerFill: 0, fundingReserveBpsPerRoundTrip: 2,
    latencyScenarios: scenarios, ...simulation });
  const books = new Map(), markets = new Map(), fees = new Map(), events = [];
  for (const symbol of ['SNDK', 'ANTH']) {
    markets.set(`binance:${symbol}`, { venue: 'binance', symbol, nativeSymbol: symbol === 'SNDK' ? 'SNDKUSDT' : 'ANTHROPICUSDT',
      status: 'active', quote: 'USDT', identityVerified: symbol === 'SNDK', settlementEquivalence: symbol === 'SNDK' ? 'same_reference_equity_price' : 'unverified' });
    markets.set(`entropy:${symbol}`, { venue: 'entropy', symbol, nativeSymbol: `io:${symbol}`, status: 'active', quote: 'USDC',
      sizeDecimals: 3, multiplier: 1, minBaseAmount: 0.001, minQuoteAmount: 10 });
    fees.set(symbol, { mode: 'auto_entropy', symbol, status: 'available', revision: 'fee-v1', takerBps: 5,
      fetchedAt: WALL, expiresAt: WALL + 100000, entropy: { status: 'available', revision: 'fee-v1', takerFeeBps: 5 },
      rebateBasis: 'total_entropy_fees', rebateRatios: [1.1, 1.2] });
  }
  let now = 0, seq = 0;
  const engine = new BinanceScalper(config, (event) => events.push(event), {
    fresh: (venue, symbol, mono) => {
      const b = books.get(`${venue}:${symbol}`);
      return b && mono - b.receivedMono <= config.maxBookAgeMs ? b : null;
    }, market: (venue, symbol) => markets.get(`${venue}:${symbol}`), entropyFee: (symbol) => fees.get(symbol), sweep,
  });
  function put(venue, at, bid = venue === 'binance' ? 99 : 49, ask = venue === 'binance' ? 101 : 50, options = {}) {
    now = at;
    const symbol = options.symbol || 'SNDK', meta = markets.get(`${venue}:${symbol}`);
    const book = { venue, symbol, nativeSymbol: meta?.nativeSymbol, quote: meta?.quote, receivedMono: at, receivedAt: WALL + at,
      sourceAt: WALL + at, sequence: venue === 'binance' ? String(++seq) : null,
      bids: Array.from({ length: 4 }, (_, i) => [bid - i, 100]), asks: Array.from({ length: 4 }, (_, i) => [ask + i, 100]), ...options };
    books.set(`${venue}:${symbol}`, book); engine.advance(at, WALL + at, book); return book;
  }
  const tick = (at) => { now = at; engine.advance(at, WALL + at); };
  const report = (symbol = 'SNDK', scenario = scenarios[0].name) => engine.report(now, WALL + now).bySymbol[symbol].scenarios[scenario];
  const arm = (symbol = 'SNDK', at = 0) => { put('entropy', at, 49, 50, { symbol }); put('binance', at, 99, 101, { symbol }); };
  return { engine, config, books, markets, fees, events, put, tick, report, arm, get now() { return now; } };
}

test('frozen fourth-depth OCO crosses both ways, equals trigger, and spread widening does not trigger', () => {
  for (const direction of ['long', 'short']) {
    const h = harness(); h.arm();
    assert.deepEqual(h.report().armed, { at: WALL, upper: 104, lower: 96, sequence: '1' });
    // Moving only ask outward (or bid outward) changes the fourth depth, but
    // cannot manufacture a directional crossing of the frozen trigger.
    h.put('binance', 1, direction === 'long' ? 99 : 90, direction === 'long' ? 110 : 101);
    assert.equal(h.report().state, 'armed');
    assert.equal(h.report().armed.upper, 104); assert.equal(h.report().armed.lower, 96);
    const crossed = h.put('binance', 2, direction === 'long' ? 104 : 94, direction === 'long' ? 106 : 96);
    let row = h.report();
    assert.equal(row.state, 'entry_pending'); assert.equal(row.position.direction, direction); assert.equal(row.armed, null);
    assert.equal(row.stats.signals, 1);
    // A changed book with the same sequence must not create a second signal.
    h.put('binance', 3, 95, 97, { sequence: crossed.sequence });
    row = h.report(); assert.equal(row.stats.signals, 1); assert.equal(h.engine.report(3, WALL + 3).openTasks.length, 1);
    h.put('entropy', 12, 49, 50);
    assert.equal(h.report().state, 'holding');
    h.put('binance', 12.5, direction === 'long' ? 104 : 94, direction === 'long' ? 106 : 96);
    assert.equal(h.report().state, 'holding'); // Equality is not a recross.
    h.put('binance', 13, direction === 'long' ? 103 : 95, direction === 'long' ? 105 : 97);
    assert.equal(h.report().state, 'exit_pending'); assert.equal(h.report().position.exitIntent.reason, 'recross_trigger');
    h.put('entropy', 23, 49, 50);
    row = h.report(); assert.equal(row.stats.completed, 1); assert.equal(row.recentTrades[0].direction, direction);
  }
});

test('fills require fresh incoming after due; trigger and cached books cannot fill or look ahead', () => {
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106);
  h.tick(11); assert.equal(h.report().state, 'entry_pending');
  h.put('entropy', 10, 49, 50); assert.equal(h.report().state, 'entry_pending');
  h.tick(12); assert.equal(h.report().state, 'entry_pending');
  h.put('entropy', 13, 59, 60); assert.equal(h.report().position.entryPrice, 60);
  h.tick(113); assert.equal(h.report().state, 'exit_pending');
  h.tick(123); assert.equal(h.report().state, 'exit_pending');
  h.put('entropy', 124, 61, 62);
  const trade = h.report().recentTrades[0]; assert.equal(trade.entryPrice, 60); assert.equal(trade.exitPrice, 61);
  assert.equal(trade.durationMs, 111); assert.equal(trade.exitReason, 'hold_timeout');
});

test('reversal after assumed entry send preserves the losing entry then exits with another latency', () => {
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106); h.put('binance', 2, 103, 105);
  assert.equal(h.report().state, 'entry_pending');
  assert.equal(h.report().position.exitIntent.reason, 'recross_trigger');
  h.put('entropy', 11, 49, 50);
  assert.equal(h.report().state, 'exit_pending'); assert.equal(h.report().position.entryPrice, 50);
  assert.equal(h.report().position.exitDueAt, WALL + 21);
  h.put('entropy', 20, 47, 48); assert.equal(h.report().stats.completed, 0);
  h.put('entropy', 21, 47, 48);
  assert.equal(h.report().stats.lossesBeforeRebate, 1); assert.equal(h.report().stats.failedEntries, 0);
  assert.equal(h.report().recentTrades[0].exitPrice, 47);
  assert.equal(h.events.filter((e) => e.type === 'binance_scalp_exit_sent').length, 1);
});

test('leader disconnect exits once; exit timeout retains permanently blocked exposure and null net', () => {
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106); h.put('entropy', 11, 49, 50);
  h.engine.invalidate('binance', 'SNDK', 'disconnect'); h.tick(12);
  assert.equal(h.report().state, 'exit_pending'); assert.equal(h.report().position.exitIntent.reason, 'leader_invalid');
  h.tick(123); let row = h.report();
  assert.equal(row.state, 'unresolved'); assert.equal(row.stats.unresolved, 1); assert.equal(row.position.entryCash, 100);
  assert.equal(row.stats.netBeforeRebate, null); assert.equal(row.stats.grossPnl, null);
  assert.equal(row.stats.turnover, 100); assert.equal(row.stats.fees, 0.05); assert.equal(row.stats.completed, 0);
  assert.equal(row.stats.rebateScenarios[0].net, null);
  h.put('binance', 2000, 104, 106); h.put('entropy', 2001, 60, 61); h.tick(5000);
  row = h.report(); assert.equal(row.state, 'unresolved'); assert.equal(row.stats.unresolved, 1); assert.equal(row.stats.signals, 1);
  const tasks = h.engine.report(h.now, WALL + h.now).openTasks;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].blockedPermanent, true); assert.ok(tasks[0].entry);
});

test('leader invalidation while entry is pending does not cancel the assumed send', () => {
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106);
  h.engine.invalidate('binance', 'SNDK', 'sequence_gap'); h.tick(2);
  h.put('entropy', 11, 49, 50); assert.equal(h.report().state, 'exit_pending');
  h.put('entropy', 21, 48, 49);
  assert.equal(h.report().stats.completed, 1); assert.equal(h.report().recentTrades[0].exitReason, 'leader_invalid');
});

test('stale, disconnected, insufficient-depth and out-of-order gaps disarm before a new baseline', () => {
  for (const gap of ['stale', 'disconnect', 'depth', 'regression']) {
    const h = harness({ maxBookAgeMs: 50 }); h.arm();
    let next = 3;
    if (gap === 'stale') { h.tick(51); next = 52; }
    if (gap === 'disconnect') { h.engine.invalidate('binance', 'SNDK', 'disconnect'); h.tick(1); }
    if (gap === 'depth') h.put('binance', 1, 99, 101, { bids: [[99, 1]], asks: [[101, 1]] });
    if (gap === 'regression') { h.put('binance', 1, 99, 101); h.put('binance', 2, 99, 101, { sequence: '1' }); }
    h.put('entropy', next, 49, 50);
    h.put('binance', next, 104, 106);
    assert.equal(h.report().state, 'armed', gap); assert.equal(h.report().stats.signals, 0, gap);
    assert.equal(h.report().armed.upper, 109, gap);
  }
});

test('fee unavailable or expired blocks new signals; task fee/config remain locked and do not need Lighter', () => {
  for (const status of ['unavailable', 'expired']) {
    const h = harness(); h.fees.get('SNDK').status = status; h.arm(); h.put('binance', 1, 104, 106);
    assert.equal(h.report().state, 'waiting'); assert.equal(h.report().reason, `entropy_fee_${status}`);
    assert.equal(h.report().stats.signals, 0);
  }
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106);
  h.fees.set('SNDK', { ...h.fees.get('SNDK'), revision: 'fee-v2', takerBps: 100, status: 'expired' });
  h.config.simulation.slippageBpsPerFill = 100; h.config.simulation.fundingReserveBpsPerRoundTrip = 100;
  h.put('entropy', 11, 49, 50); h.put('binance', 12, 103, 105); h.put('entropy', 22, 51, 52);
  const trade = h.report().recentTrades[0];
  assert.equal(trade.feeSnapshot.revision, 'fee-v1'); assert.equal(trade.feeSnapshot.takerBps, 5);
  assert.equal(trade.entryPrice, 50); assert.equal(trade.exitPrice, 51); assert.equal(trade.costReserve, 0.02);
  assert.equal(trade.fees, (100 + 102) * 5 / 10000); assert.equal(h.report().stats.completed, 1);
});

test('actual two-fill cash determines costs, turnover and the 110% / 120% contingent fee rebates', () => {
  const h = harness({ simulation: { slippageBpsPerFill: 2 } }); h.arm(); h.put('binance', 1, 104, 106);
  h.put('entropy', 11, 49, 50); h.put('binance', 12, 103, 105); h.put('entropy', 22, 48, 49);
  const row = h.report(), trade = row.recentTrades[0], quantity = trade.quantity;
  const entryCash = quantity * 50 * 1.0002, exitCash = quantity * 48 * 0.9998;
  assert.ok(Math.abs(trade.turnover - entryCash - exitCash) < 1e-10);
  assert.ok(Math.abs(trade.grossPnl - (exitCash - entryCash)) < 1e-10);
  assert.ok(Math.abs(trade.fees - (entryCash + exitCash) * 5 / 10000) < 1e-10);
  assert.ok(Math.abs(trade.costReserve - entryCash * 2 / 10000) < 1e-10);
  assert.ok(Math.abs(trade.netBeforeRebate - (trade.grossPnl - trade.fees - trade.costReserve)) < 1e-10);
  assert.deepEqual(trade.rebateScenarios.map((r) => r.ratio), [1.1, 1.2]);
  for (const r of trade.rebateScenarios) { assert.equal(r.contingentRebate, trade.fees * r.ratio); assert.equal(r.net, trade.netBeforeRebate + r.contingentRebate); }
  assert.equal(row.stats.lossesBeforeRebate, 1); assert.equal(row.stats.nonLossRateBeforeRebate, 0);
  assert.equal(row.stats.netBeforeRebate, trade.netBeforeRebate);
});

test('hold starts at Entropy entry; each latency scenario is an independent alternative', () => {
  const h = harness({ scenarios: [{ name: 'fast', entropyMs: 10 }, { name: 'slow', entropyMs: 30 }] });
  h.arm(); h.put('binance', 1, 104, 106); h.put('entropy', 11, 49, 50);
  assert.equal(h.report('SNDK', 'fast').state, 'holding'); assert.equal(h.report('SNDK', 'slow').state, 'entry_pending');
  h.put('entropy', 31, 50, 51); h.tick(101);
  assert.equal(h.report('SNDK', 'fast').state, 'holding'); assert.equal(h.report('SNDK', 'slow').state, 'holding');
  h.tick(111); assert.equal(h.report('SNDK', 'fast').state, 'exit_pending'); assert.equal(h.report('SNDK', 'slow').state, 'holding');
  h.put('entropy', 121, 51, 52); h.tick(131); h.put('entropy', 161, 52, 53);
  const report = h.engine.report(h.now, WALL + h.now);
  assert.equal(report.bySymbol.SNDK.scenarios.fast.stats.completed, 1); assert.equal(report.bySymbol.SNDK.scenarios.slow.stats.completed, 1);
  assert.equal(report.stats, undefined); assert.equal(report.assumptions.scenarios, 'alternative_counterfactuals_do_not_sum');
});

test('ANTH uses its native leader only as direction and does not require cross-venue price equivalence', () => {
  const h = harness(); h.arm('ANTH'); h.put('binance', 1, 104, 106, { symbol: 'ANTH' });
  assert.equal(h.report('ANTH').state, 'entry_pending');
  assert.equal(h.engine.report(1, WALL + 1).bySymbol.ANTH.leader.identityVerified, false);
  assert.equal(h.engine.report(1, WALL + 1).assumptions.crossVenuePriceComparison, false);
  const bad = harness(); bad.markets.get('binance:ANTH').status = 'unverified'; bad.arm('ANTH');
  assert.equal(bad.report('ANTH').reason, 'leader_metadata_unavailable');
  const alias = harness(); alias.markets.get('binance:ANTH').nativeSymbol = 'ANTHUSDT'; alias.arm('ANTH');
  assert.equal(alias.report('ANTH').state, 'waiting');
});

test('bounded entry failures do not enter win-rate denominator and cannot become completed trades', () => {
  const h = harness(); h.arm(); h.put('binance', 1, 104, 106);
  h.put('entropy', 11, 49, 50, { asks: [[50, 0.01]] });
  assert.equal(h.report().state, 'entry_pending');
  h.tick(112);
  const row = h.report(); assert.equal(row.stats.failedEntries, 1); assert.equal(row.stats.completed, 0);
  assert.equal(row.stats.nonLossRateBeforeRebate, null); assert.equal(row.recentTrades[0].outcome, 'failed_entry');
  assert.equal(row.recentTrades[0].netBeforeRebate, null); assert.equal(row.stats.turnover, 0);
});

test('metadata, minimum amount and receive/source quality fail closed', () => {
  for (const mutate of [
    (h) => { h.markets.get('entropy:SNDK').sizeDecimals = 11; },
    (h) => { h.markets.get('entropy:SNDK').multiplier = 10; },
    (h) => { h.markets.get('entropy:SNDK').status = 'delisted'; },
    (h) => { h.markets.get('binance:SNDK').quote = 'USDC'; },
  ]) {
    const h = harness(); mutate(h); h.arm(); h.put('binance', 1, 104, 106); assert.equal(h.report().stats.signals, 0);
  }
  const missingTime = harness(); missingTime.put('entropy', 0); missingTime.put('binance', 0, 99, 101, { sourceAt: null });
  assert.equal(missingTime.report().state, 'waiting');
  const minimum = harness(); minimum.markets.get('entropy:SNDK').minQuoteAmount = 200; minimum.arm(); minimum.put('binance', 1, 104, 106);
  assert.equal(minimum.report().stats.failedEntries, 1); assert.equal(minimum.report().stats.completed, 0);
  const changed = harness(); changed.arm(); changed.put('binance', 1, 104, 106);
  changed.markets.get('entropy:SNDK').minQuoteAmount = 200;
  changed.put('entropy', 11, 49, 50); assert.equal(changed.report().state, 'entry_pending');
  changed.tick(112); assert.equal(changed.report().stats.failedEntries, 1);
});

test('events and reports are detached snapshots; history cap never clears loss or fee-revision totals', () => {
  const h = harness({ simulation: { cooldownMs: 1 } });
  for (let i = 0; i < 23; i++) {
    const at = i * 40; h.engine.invalidate('binance', 'SNDK', 'new_observation_window');
    h.arm('SNDK', at); h.put('binance', at + 1, 104, 106); h.put('entropy', at + 11, 49, 50);
    h.put('binance', at + 12, 103, 105); h.put('entropy', at + 22, 48, 49);
    h.fees.set('SNDK', { ...h.fees.get('SNDK'), revision: `fee-v${i + 2}` });
  }
  const row = h.report(); assert.equal(row.stats.completed, 23); assert.equal(row.stats.lossesBeforeRebate, 23); assert.equal(row.recentTrades.length, 20);
  row.recentTrades[0].feeSnapshot.takerBps = 0;
  const event = h.events.find((e) => e.type === 'binance_scalp_signal'); event.feeSnapshot.takerBps = 0;
  assert.equal(h.report().recentTrades[0].feeSnapshot.takerBps, 5); assert.equal(h.report().stats.lossesBeforeRebate, 23);
  assert.ok(h.events.every((e) => e.type.startsWith('binance_scalp_')));
});

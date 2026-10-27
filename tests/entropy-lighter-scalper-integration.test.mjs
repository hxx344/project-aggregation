import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lab, automaticConfig } from '../tools/entropy-lighter-lab/core.mjs';

const wall = 1793000000000;
const template = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
const native = { SNDK: 'SNDKUSDT', ANTH: 'ANTHROPICUSDT' };
function markets(ttl = 3600000) {
  return ['SNDK', 'ANTH'].flatMap(symbol => [{ venue: 'entropy', symbol, nativeSymbol: `io:${symbol}`, quote: 'USDC', status: 'active',
    sizeDecimals: 4, multiplier: 1, minBaseAmount: 0.0001, minQuoteAmount: 10,
    fee: { status: 'available', takerFeeBps: 0.9, revision: `entropy:${symbol}:0.9`, fetchedAt: wall, expiresAt: wall + ttl,
      scope: 'public_default_tier_no_builder', accountTier: 'default', sourceUrls: ['https://example.invalid/official-fixture'], assumptions: [] } },
  { venue: 'binance', symbol, nativeSymbol: native[symbol], quote: 'USDT', status: 'active', identityVerified: symbol === 'SNDK' }]);
}
function book(venue, at, bid, ask, symbol = 'SNDK') {
  return { venue, symbol, nativeSymbol: venue === 'entropy' ? `io:${symbol}` : native[symbol], quote: venue === 'entropy' ? 'USDC' : 'USDT',
    receivedMono: at, receivedAt: wall + at, sourceAt: wall + at, sequence: String(at + 1),
    bids: Array.from({ length: 4 }, (_, i) => [Number((bid - i * 0.1).toFixed(4)), 100]),
    asks: Array.from({ length: 4 }, (_, i) => [Number((ask + i * 0.1).toFixed(4)), 100]) };
}
function fixture(ttl) {
  const config = automaticConfig(template);
  Object.assign(config.simulation, { holdMs: 1000, slippageBpsPerFill: 0, fundingReserveBpsPerRoundTrip: 0,
    latencyScenarios: [{ name: 'one', entropyMs: 200, lighterMs: 450 }] });
  const events = [], lab = new Lab(config, event => events.push(structuredClone(event)), { automaticFees: true });
  lab.setMarkets(markets(ttl), 0, wall);
  return { lab, events };
}
const row = (lab, at, symbol = 'SNDK') => lab.report(at, wall + at).binanceScalper.bySymbol[symbol].scenarios.one;

test('actual Lab books drive research-mode scalp independently of Lighter fees and absolute price levels', () => {
  const { lab } = fixture();
  lab.book(book('entropy', 0, 200, 200.1)); lab.book(book('binance', 0, 100, 100.1));
  assert.equal(lab.config.simulation.enabled, false); assert.deepEqual(lab.config.simulation.verifiedSymbols, []);
  assert.equal(lab.report(0, wall).automaticFees.bySymbol.SNDK.status, 'unavailable');
  assert.equal(row(lab, 0).state, 'armed'); assert.equal(row(lab, 0).armed.upper, 100.4);
  lab.book(book('binance', 100, 100.4, 100.5));
  assert.equal(row(lab, 100).state, 'entry_pending');
  lab.book(book('entropy', 299, 200, 200.1)); assert.equal(row(lab, 299).position.entryPrice, null);
  lab.book(book('entropy', 300, 200, 200.1)); assert.equal(row(lab, 300).state, 'holding');
  assert.equal(row(lab, 300).stats.netBeforeRebate, null);
  lab.book(book('binance', 350, 100.3, 100.4)); assert.equal(row(lab, 350).state, 'exit_pending');
  lab.book(book('entropy', 549, 199, 199.1)); assert.equal(row(lab, 549).stats.completed, 0);
  lab.book(book('entropy', 550, 199, 199.1));
  const result = row(lab, 550);
  assert.equal(result.stats.completed, 1); assert.equal(result.stats.lossesBeforeRebate, 1);
  assert.ok(result.stats.netBeforeRebate < 0); assert.ok(result.stats.turnover > 0);
  for (const scenario of result.stats.rebateScenarios) {
    assert.ok(Math.abs(scenario.contingentRebate - result.stats.fees * scenario.ratio) < 1e-10);
    assert.ok(Math.abs(scenario.net - result.stats.netBeforeRebate - scenario.contingentRebate) < 1e-10);
  }
  assert.deepEqual(result.stats.rebateScenarios.map(scenario => scenario.ratio), [1.1, 1.2]);
});

test('single-Entropy fee expiry is monotonic and blocks fresh triggers without a legacy numeric fallback', () => {
  const { lab } = fixture(100);
  assert.equal(lab.entropyFeeSnapshot('SNDK', 80, wall + 80).status, 'available');
  assert.equal(lab.entropyFeeSnapshot('SNDK', 101, wall).status, 'expired');
  lab.book(book('entropy', 110, 200, 200.1)); lab.book(book('binance', 110, 100, 100.1));
  lab.book(book('binance', 120, 100.4, 100.5));
  assert.equal(row(lab, 120).stats.signals, 0);
});

test('ANTH uses Binance direction research without requiring cross-venue price equivalence', () => {
  const { lab } = fixture();
  lab.book(book('entropy', 0, 1800, 1801, 'ANTH')); lab.book(book('binance', 0, 1900, 1901, 'ANTH'));
  assert.equal(row(lab, 0, 'ANTH').state, 'armed');
  lab.book(book('binance', 100, 1901.3, 1901.4, 'ANTH'));
  assert.equal(row(lab, 100, 'ANTH').state, 'entry_pending');
  assert.equal(row(lab, 100, 'ANTH').position.direction, 'long');
  assert.equal(lab.tasks.size, 0, 'the original cross-venue paper engine remains separately disabled');
});

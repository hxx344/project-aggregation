import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Lab, automaticConfig } from '../tools/entropy-lighter-lab/core.mjs';

const wall = 1793000000000;
const base = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
function config() {
  const c = structuredClone(base);
  Object.assign(c.simulation, { enabled: true, verifiedSymbols: ['SNDK'], entropyTakerFeeBps: 99, lighterTakerFeeBps: 99, rebateRatios: [0.2],
    holdMs: 100, fillWaitMs: 200, slippageBpsPerFill: 0, fundingReserveBpsPerRoundTrip: 0,
    latencyScenarios: [{ name: 'test', entropyMs: 200, lighterMs: 450 }] });
  return c;
}
function markets({ rate = 0.9, anthRate = 1.8, fetchedAt = wall, ttl = 3600000 } = {}) {
  return ['SNDK', 'ANTH'].flatMap((symbol) => ['entropy', 'lighter'].map((venue) => {
    const takerFeeBps = venue === 'lighter' ? 0 : symbol === 'SNDK' ? rate : anthRate;
    return { symbol, venue, nativeSymbol: `${venue}:${symbol}`, status: 'active', sizeDecimals: 4, multiplier: 1, minBaseAmount: 0.0001, minQuoteAmount: 10,
      fee: { status: 'available', takerFeeBps, baseTakerBps: venue === 'entropy' ? 4.5 : 0, growthMultiplier: 0.1,
        deployerFeeScale: 1, scope: 'public_default_tier_no_builder', accountTier: venue === 'entropy' ? 'default' : 'standard',
        sourceUrls: ['https://example.invalid/official-fixture'], fetchedAt, expiresAt: fetchedAt + ttl, revision: `${venue}:${symbol}:${takerFeeBps}`, reason: null,
        assumptions: ['Public default tier; not a real account fee.'] } };
  }));
}
function book(venue, at, bid, ask, symbol = 'SNDK') {
  return { venue, symbol, nativeSymbol: `${venue}:${symbol}`, quote: 'USDC', receivedMono: at, receivedAt: wall + at, sourceAt: wall + at,
    sequence: String(at), bids: [[bid, 100]], asks: [[ask, 100]] };
}
function fixture(c = config()) {
  const events = [], lab = new Lab(automaticConfig(c), (e) => events.push(structuredClone(e)), { automaticFees: true });
  lab.setMarkets(markets(), 0, wall);
  return { lab, events };
}
function signal(lab, at = 0) { lab.book(book('entropy', at, 99, 100)); lab.book(book('lighter', at, 110, 111)); }

test('automatic mode supersedes old manual fee and rebate parameters without rewriting the input', () => {
  const old = config(), normalized = automaticConfig(old);
  assert.equal(normalized.simulation.entropyTakerFeeBps, null); assert.equal(normalized.simulation.lighterTakerFeeBps, null);
  assert.deepEqual(normalized.simulation.rebateRatios, [0, 1.1, 1.2]);
  assert.equal(old.simulation.entropyTakerFeeBps, 99); assert.deepEqual(old.simulation.rebateRatios, [0.2]);
});

test('automatic fees are per symbol and each evaluation locks its source and both rebate scenarios', () => {
  const { lab } = fixture(); signal(lab);
  lab.book(book('entropy', 0, 99, 100, 'ANTH')); lab.book(book('lighter', 0, 110, 111, 'ANTH'));
  const r = lab.report(0, wall), sndk = r.opportunityStudy.bySymbol.SNDK.raw['entropy:lighter'].latest;
  const anth = r.opportunityStudy.bySymbol.ANTH.raw['entropy:lighter'].latest;
  assert.equal(r.automaticFees.bySymbol.SNDK.takerBps.entropy, 0.9); assert.equal(r.automaticFees.bySymbol.ANTH.takerBps.entropy, 1.8);
  assert.equal(sndk.feeSnapshot.takerBps.entropy, 0.9); assert.equal(anth.feeSnapshot.takerBps.entropy, 1.8);
  assert.deepEqual(sndk.rebates.map((b) => b.ratio), [0, 1.1, 1.2]);
  assert.equal(sndk.rebates[1].contingentRebateCash, sndk.entropyRoundTripFeesCash * 1.1);
  assert.equal(sndk.rebates[2].contingentRebateCash, sndk.entropyRoundTripFeesCash * 1.2);
});

test('a time-only refresh preserves study counts and the historical snapshot', () => {
  const { lab } = fixture(); signal(lab); lab.book(book('entropy', 201, 99, 100)); lab.book(book('lighter', 451, 110, 111));
  const before = structuredClone(lab.report(451, wall + 451));
  lab.setMarkets(markets({ fetchedAt: wall + 1000 }), 1000, wall + 1000);
  const after = lab.report(1000, wall + 1000);
  assert.equal(after.opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'].completed, 1);
  assert.equal(after.automaticFees.bySymbol.SNDK.revision, before.automaticFees.bySymbol.SNDK.revision);
  assert.equal(after.automaticFees.bySymbol.SNDK.fetchedAt, wall + 1000);
  assert.equal(after.opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'].latest.feeSnapshot.fetchedAt, wall);
});

test('semantic fee changes reset research evidence and pending probes without deleting paper exposure', () => {
  const { lab, events } = fixture(); signal(lab); const task = [...lab.tasks.values()][0];
  const revision = task.feeSnapshot.revision;
  lab.setMarkets(markets({ rate: 9, fetchedAt: wall + 100 }), 100, wall + 100);
  assert.equal(lab.studyProbes.size, 0); assert.deepEqual(lab.report(100, wall + 100).opportunityStudy.bySymbol.SNDK.raw, {});
  assert.equal(lab.tasks.size, 1); assert.equal(task.feeSnapshot.revision, revision);
  assert.ok(events.some((e) => e.type === 'delay_study' && e.failure === 'fee_revision_changed'));
  lab.book(book('entropy', 201, 99, 100)); lab.book(book('lighter', 451, 110, 111)); lab.advance(551, wall + 551);
  lab.book(book('entropy', 752, 105, 106)); lab.book(book('lighter', 1002, 104, 105));
  const result = events.find((e) => e.type === 'paper_result');
  assert.equal(result.feeSnapshot.revision, revision);
  const entropy = result.legs.find((l) => l.venue === 'entropy');
  assert.ok(Math.abs(entropy.entry.fee / entropy.entry.cash - 0.9 / 10000) < 1e-12);
  assert.ok(Math.abs(entropy.exit.fee / entropy.exit.cash - 0.9 / 10000) < 1e-12);
  assert.equal(result.rebateScenarios[1].contingentRebate, result.entropyFees * 1.1);
});

test('unknown and expired fees cannot fall back to legacy manual numbers or be renewed by a heartbeat', () => {
  const c = config(); c.simulation.enabled = false; const { lab } = fixture(c);
  lab.setMarkets(markets({ ttl: 100 }), 0, wall); signal(lab);
  assert.equal(lab.report(80, wall + 80).automaticFees.bySymbol.SNDK.status, 'available');
  assert.equal(lab.report(101, wall).automaticFees.bySymbol.SNDK.status, 'expired', 'monotonic expiry survives a stopped wall clock');
  lab.config.simulation.enabled = true;
  signal(lab, 300); assert.equal(lab.tasks.size, 0);
  const latest = lab.report(300, wall + 300).opportunityStudy.bySymbol.SNDK.raw['entropy:lighter'].latest;
  assert.equal(latest.surplusBeforeRebateCash, null); assert.equal(latest.rebates[2].surplusCash, null);
  const unavailable = markets().map((m) => ({ ...m, fee: { ...m.fee, status: 'unavailable', takerFeeBps: null, revision: null } }));
  lab.setMarkets(unavailable, 500, wall + 500); assert.equal(lab.report(500, wall + 500).automaticFees.bySymbol.SNDK.status, 'unavailable');
  const legacy = new Lab(config(), () => {}, { automaticFees: true }); legacy.setMarkets(unavailable, 0, wall); signal(legacy);
  assert.equal(legacy.tasks.size, 0, 'even an unnormalized legacy config cannot bypass automatic fee readiness');
});

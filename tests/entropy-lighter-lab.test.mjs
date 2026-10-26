import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab, Recorder, sweep, validateBook, validateConfig, studyEvaluation } from '../tools/entropy-lighter-lab/core.mjs';

const template = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
const wall = 1793000000000;
function config() {
  const c = structuredClone(template);
  Object.assign(c.simulation, { enabled: true, verifiedSymbols: ['SNDK'], entropyTakerFeeBps: 5, holdMs: 100, fillWaitMs: 200, slippageBpsPerFill: 0, fundingReserveBpsPerRoundTrip: 0, latencyScenarios: [{ name: 'test', entropyMs: 200, lighterMs: 450 }] });
  return c;
}
function book(venue, at, bid, ask, symbol = 'SNDK', overrides = {}) {
  return { venue, symbol, nativeSymbol: symbol, quote: 'USDC', receivedMono: at, receivedAt: wall + at, sourceAt: wall + at, sequence: String(at), bids: [[bid, 100]], asks: [[ask, 100]], ...overrides };
}
function lab(c = config()) {
  const events = [], l = new Lab(c, (e) => events.push(structuredClone(e)));
  l.setMarkets(['entropy', 'lighter'].map((venue) => ({ venue, symbol: 'SNDK', sizeDecimals: 4, status: 'active', multiplier: 1, minBaseAmount: 0.0001, minQuoteAmount: 10 })));
  return { l, events };
}
function signal(l) { l.book(book('entropy', 0, 99, 100)); l.book(book('lighter', 0, 110, 111)); }

test('paper can await automatic fees but still requires contract verification and valid latency', () => {
  validateConfig(template);
  const c = structuredClone(template); c.simulation.enabled = true;
  assert.throws(() => validateConfig(c), /verifiedSymbols/);
  c.simulation.verifiedSymbols = ['SNDK']; validateConfig(c);
  c.simulation.latencyScenarios[0].lighterMs = 299;
  assert.throws(() => validateConfig(c), /300ms/);
});

test('crossed, malformed, source-stale, receive-stale and future books are rejected', () => {
  const c = config(), good = book('entropy', 100, 99, 100);
  assert.equal(validateBook(good, 100, wall + 100, c), null);
  assert.equal(validateBook({ ...good, asks: [[98, 1]] }, 100, wall + 100, c), 'crossed_book');
  assert.equal(validateBook({ ...good, bids: [[99, 1], [100, 1]] }, 100, wall + 100, c), 'unsorted_depth');
  assert.equal(validateBook({ ...good, sourceAt: wall - 10000 }, 100, wall + 100, c), 'stale_source');
  assert.equal(validateBook(good, 1000, wall + 1000, c), 'stale_receive');
  assert.equal(validateBook(good, 99, wall + 100, c), 'stale_receive');
});

test('taker consumes visible depth and refuses insufficient quantity', () => {
  const b = book('entropy', 0, 99, 100, 'SNDK', { asks: [[100, 1], [102, 2]] });
  assert.equal(sweep(b, 'buy', 2).price, 101);
  assert.equal(sweep(b, 'buy', 4), null);
  assert.ok(Math.abs(sweep(b, 'buy', 2, 10).cash - 202.202) < 1e-10);
});

test('unverified ANTH never creates paper orders even at an enormous basis', () => {
  const { l } = lab();
  l.book(book('entropy', 0, 99, 100, 'ANTH'));
  l.book(book('lighter', 0, 200, 201, 'ANTH'));
  assert.equal(l.tasks.size, 0);
  assert.ok(l.report().basis.ANTH.meanBps < -4000);
});

test('USDT/USDC and stale/invalidation gaps cannot create candidates', () => {
  const { l } = lab();
  l.book(book('entropy', 0, 99, 100));
  l.book(book('lighter', 0, 110, 111, 'SNDK', { quote: 'USDT' }));
  assert.equal(l.tasks.size, 0);
  l.invalidate('lighter', 'SNDK', 'nonce_gap');
  l.book(book('entropy', 300, 99, 100));
  assert.equal(l.tasks.size, 0);
  l.book(book('lighter', 2000, 110, 111));
  assert.equal(l.tasks.size, 0);
});

test('four taker fees threshold cannot be satisfied only by a rebate', () => {
  const c = config(); c.simulation.entropyTakerFeeBps = 50;
  const { l } = lab(c);
  l.book(book('entropy', 0, 99.99, 100));
  l.book(book('lighter', 0, 100.2, 100.21));
  assert.equal(l.tasks.size, 0);
  assert.equal(l.report().counts.rejected.entry_cost_threshold, 1);
});

test('source clock uncertainty is recorded for research and cannot enter paper trading', () => {
  const { l, events } = lab();
  l.book(book('entropy', 0, 99, 100));
  l.book(book('lighter', 0, 110, 111, 'SNDK', { sourceAt: wall + 1000 }));
  assert.equal(l.report().counts.books, 2);
  assert.ok(l.report().basis.SNDK);
  assert.equal(l.tasks.size, 0);
  assert.equal(l.report().counts.rejected.paper_source_time_unverified, 1);
  assert.equal(events.find((e) => e.type === 'book' && e.venue === 'lighter').sourceClockUncertain, true);
});

test('market minimum notional and unknown multipliers block paper entries', () => {
  const { l } = lab();
  l.markets.get('lighter:SNDK').minQuoteAmount = 1000;
  signal(l); assert.equal(l.tasks.size, 0);
  const { l: second } = lab();
  second.markets.get('lighter:SNDK').multiplier = null;
  signal(second); assert.equal(second.tasks.size, 0);
});

test('each leg waits for its own arrival, and roundtrip fee rebates use Entropy fees only', () => {
  const { l, events } = lab(); signal(l);
  assert.equal(l.tasks.size, 1);
  l.book(book('entropy', 199, 99, 100));
  assert.equal(events.filter((e) => e.type === 'paper_fill').length, 0);
  l.book(book('entropy', 201, 99, 100));
  l.book(book('lighter', 449, 110, 111));
  assert.equal(events.filter((e) => e.type === 'paper_fill').length, 1);
  l.book(book('lighter', 451, 110, 111));
  l.advance(551, wall + 551);
  l.book(book('entropy', 752, 105, 106));
  l.book(book('lighter', 1002, 104, 105));
  const result = events.find((e) => e.type === 'paper_result');
  assert.ok(result.grossPnl > 0);
  assert.equal(result.rebateScenarios[1].contingentRebate, result.entropyFees * 1.1);
  assert.equal(result.netBeforeRebate, result.grossPnl - result.fees);
  assert.equal(result.turnover.entropy, result.legs.find((l) => l.venue === 'entropy').entry.cash + result.legs.find((l) => l.venue === 'entropy').exit.cash);
  assert.equal(l.tasks.size, 0);
  assert.equal(l.report().paper.test.completed, 1);
});

test('adverse post-arrival prices remain losses; no pre-trade price substitution', () => {
  const { l, events } = lab(); signal(l);
  l.book(book('entropy', 201, 119, 120));
  l.book(book('lighter', 451, 90, 91));
  l.advance(551, wall + 551);
  l.book(book('entropy', 752, 100, 101));
  l.book(book('lighter', 1002, 100, 101));
  const result = events.find((e) => e.type === 'paper_result');
  assert.ok(result.netBeforeRebate < -20);
  assert.equal(l.report().paper.test.lossesBeforeRebate, 1);
});

test('missing second leg is counted and the filled leg incurs emergency close costs', () => {
  const { l, events } = lab(); signal(l);
  l.book(book('entropy', 201, 99, 100));
  l.advance(652, wall + 652);
  l.book(book('entropy', 853, 98, 99));
  const result = events.find((e) => e.type === 'paper_result');
  assert.equal(result.failed, true);
  assert.ok(result.netBeforeRebate < 0);
  assert.equal(result.turnover.lighter, 0);
  assert.equal(l.report().paper.test.failedLegs, 1);
});

test('missing exit is unknown and blocks new paper exposure rather than inventing zero loss', () => {
  const { l, events } = lab(); signal(l);
  l.book(book('entropy', 201, 99, 100));
  l.advance(652, wall + 652); l.advance(1053, wall + 1053);
  const result = events.find((e) => e.type === 'paper_result');
  assert.equal(result.unresolved, true);
  assert.equal(result.netBeforeRebate, null);
  assert.equal(l.report().paper.test.unresolved, 1);
  assert.equal(l.report().paper.test.netBeforeRebate, null);
  assert.equal(l.report().paper.test.rebateScenarios[1].net, null);
  assert.ok(l.report().paper.test.fees > 0);
  l.book(book('entropy', 20000, 99, 100)); l.book(book('lighter', 20000, 110, 111));
  assert.equal(l.tasks.size, 0);
});

test('one task per scenario/symbol prevents repeated consumption of a displayed book', () => {
  const { l } = lab(); signal(l);
  l.book(book('entropy', 250, 99, 100)); l.book(book('lighter', 250, 110, 111));
  assert.equal(l.tasks.size, 1);
  assert.equal(l.report().counts.candidates, 1);
});

test('leader signals use relative changes and only later follower observations', () => {
  const { l, events } = lab(structuredClone(template));
  l.book(book('entropy', 0, 99, 101));
  l.book(book('binance', 0, 999, 1001, 'SNDK', { quote: 'USDT' }));
  l.book(book('entropy', 250, 99, 101));
  l.book(book('binance', 250, 1009, 1011, 'SNDK', { quote: 'USDT' }));
  assert.equal(events.filter((e) => e.type === 'leader_markout').length, 0);
  l.book(book('entropy', 351, 100, 102));
  const markout = events.find((e) => e.type === 'leader_markout');
  assert.equal(markout.lagMs, 100);
  assert.equal(markout.followerMoveBps, 100.00000000000009);
});

test('recorder retention only deletes its own segments, leaving configuration and unrelated files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entropy-lab-'));
  try {
    const c = structuredClone(template); c.retentionDays = 1;
    const stale = 'events-1000000000000-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-0.jsonl';
    writeFileSync(join(dir, stale), '{}\n'); writeFileSync(join(dir, 'keep.jsonl'), 'user data');
    const recorder = new Recorder(dir, c, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'); recorder.write({ type: 'fixture' });
    assert.ok(!readdirSync(dir).includes(stale));
    assert.equal(readFileSync(join(dir, 'keep.jsonl'), 'utf8'), 'user data');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('events-')).length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test('dashboard history is bounded and invalidation creates an explicit gap without zero prices', () => {
  const { l } = lab(structuredClone(template));
  for (let i = 0; i < 650; i++) {
    l.book(book('entropy', i * 2000, 99, 100));
    l.book(book('lighter', i * 2000, 100, 101));
  }
  assert.equal(l.report().recentSpreads.SNDK.length, 600);
  assert.equal(l.report().latestQuotes.length, 2);
  l.invalidate('lighter', 'SNDK', 'nonce_gap');
  assert.equal(l.report().recentSpreads.SNDK.at(-1).midBasisBps, null);
  assert.equal(l.report().latestQuotes.some((q) => q.venue === 'lighter'), false);
});

test('snapshot ages use the collector monotonic clock while execution freshness remains strict', () => {
  const { l } = lab(); signal(l);
  const snapshot = l.report(5000, wall + 5000);
  assert.equal(snapshot.observedAt, wall + 5000);
  assert.equal(snapshot.latestQuotes[0].receiveAgeMs, 5000);
  assert.equal(snapshot.latestQuotes[0].executionQuality, 'stale_receive');
  assert.equal(snapshot.latestQuotes[0].sourceClockUncertain, false, 'an old cached timestamp does not create a clock skew');
  assert.equal(validateBook(book('entropy', 0, 99, 100), 5000, wall + 5000, config()), 'stale_receive');
  const jumped = l.report(5000, wall - 3600000);
  assert.equal(jumped.latestQuotes[0].receiveAgeMs, 5000, 'wall clock jumps do not reset receive ages');
  assert.equal(jumped.latestQuotes[0].executionQuality, 'stale_receive');
});

test('entry study budgets four fees, only two exit slippages and rebate on Entropy fees', () => {
  const c = config(); Object.assign(c.simulation, { entropyTakerFeeBps: 5, lighterTakerFeeBps: 3, slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2 });
  const result = studyEvaluation({ buy: { venue: 'entropy', quantity: 1, price: 100, cash: 100 }, sell: { venue: 'lighter', quantity: 1, price: 101, cash: 101 }, config: c, at: wall });
  assert.ok(Math.abs(result.costs.feesRoundTripCash - 0.1606) < 1e-12);
  assert.ok(Math.abs(result.costs.exitSlippageReserveCash - 0.0402) < 1e-12);
  assert.ok(Math.abs(result.costs.fundingReserveCash - 0.0201) < 1e-12);
  assert.ok(Math.abs(result.surplusBeforeRebateCash - 0.7791) < 1e-12);
  assert.ok(Math.abs(result.rebates[1].contingentRebateCash - 0.11) < 1e-12);
  c.simulation.entropyTakerFeeBps = null;
  const unknown = studyEvaluation({ buy: { venue: 'entropy', quantity: 1, price: 100, cash: 100 }, sell: { venue: 'lighter', quantity: 1, price: 101, cash: 101 }, config: c, at: wall });
  assert.equal(unknown.surplusBeforeRebateCash, null); assert.equal(unknown.rebates[1].surplusCash, null); assert.equal(unknown.gatePassed, false);
});

test('research runs in collection mode and delayed entry prices can erase a positive original spread', () => {
  const c = config(); c.simulation.enabled = false; const { l } = lab(c); signal(l);
  l.book(book('entropy', 201, 119, 120)); l.book(book('lighter', 451, 90, 91));
  const study = l.report(451, wall + 451).opportunityStudy.bySymbol.SNDK;
  assert.ok(study.raw['entropy:lighter'].latest.surplusBeforeRebateCash > 0);
  assert.ok(study.latency['test:entropy:lighter'].latest.surplusBeforeRebateCash < 0);
  assert.equal(study.latency['test:entropy:lighter'].completed, 1);
  assert.equal(l.tasks.size, 0, 'research probes never enable paper trading');
  l.book(book('entropy', 500, 119, 120)); assert.equal(l.report().opportunityStudy.bySymbol.SNDK.raw['entropy:lighter'].attempts, 1);
});

test('missing depth, timeouts and stream invalidation remain in delayed-study denominators', () => {
  const c = config(); c.simulation.enabled = false;
  const { l } = lab(c); signal(l); l.book(book('entropy', 201, 99, 100)); l.advance(652, wall + 652);
  const timeout = l.report().opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'];
  assert.deepEqual([timeout.attempts, timeout.completed, timeout.failed], [1, 0, 1]); assert.equal(timeout.failureReasons.timeout, 1);
  const { l: depth } = lab(c); signal(depth); depth.book(book('entropy', 201, 99, 100, 'SNDK', { bids: [[99, 0.00001]], asks: [[100, 0.00001]] }));
  assert.equal(depth.report().opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'].failureReasons.insufficient_depth, 1);
  const { l: gap } = lab(c); signal(gap); gap.invalidate('lighter', 'SNDK', 'nonce_gap');
  assert.equal(gap.studyProbes.size, 0); assert.equal(gap.report().opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'].failureReasons.invalidated, 1);
});

test('a legal latency scenario named raw cannot overwrite original-price statistics', () => {
  const c = config(); c.simulation.enabled = false; c.simulation.latencyScenarios[0].name = 'raw';
  const { l } = lab(c); signal(l); l.book(book('entropy', 201, 119, 120)); l.book(book('lighter', 451, 90, 91));
  const study = l.report().opportunityStudy.bySymbol.SNDK;
  assert.equal(study.raw['entropy:lighter'].attempts, 1); assert.equal(study.latency['raw:entropy:lighter'].attempts, 1);
  assert.ok(study.raw['entropy:lighter'].latest.grossCash > 0); assert.ok(study.latency['raw:entropy:lighter'].latest.grossCash < 0);
});

test('historical uncertain source times cannot create qualified sample counts or span after one recovery', () => {
  const c = config(); c.simulation.enabled = false; const { l } = lab(c);
  for (let i = 0; i < 32; i++) {
    const at = i * 10000;
    const source = (t) => ({ sourceAt: wall + t - (i === 31 ? 0 : 3600000) });
    l.book(book('entropy', at, 99, 100, 'SNDK', source(at))); l.book(book('lighter', at, 110, 111, 'SNDK', source(at)));
    l.book(book('entropy', at + 201, 99, 100, 'SNDK', source(at + 201))); l.book(book('lighter', at + 451, 110, 111, 'SNDK', source(at + 451)));
  }
  const metric = l.report(310451, wall + 310451).opportunityStudy.bySymbol.SNDK.latency['test:entropy:lighter'];
  assert.equal(metric.completed, 32); assert.equal(metric.uncertainSourceSamples, 31);
  assert.equal(metric.costed, 1); assert.equal(metric.passedAfterCosts, 1); assert.equal(metric.qualitySpanMs, 0);
  assert.ok(metric.spanMs >= 300000, 'the full observation span must not substitute for qualified evidence');
});

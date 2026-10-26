import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchInsights } from '../server/research/entropy-lighter-insights.mjs';

const now = 1793000000000;
const scenario = { name: 'base-assumed', entropyMs: 200, lighterMs: 450 };
function evaluation(overrides = {}) {
  return { at: now, quantity: 1, buyPrice: 100, sellPrice: 101, buyNotional: 100, sellNotional: 101,
    grossCash: 1, grossBps: 100,
    costs: { feesRoundTripCash: 0.2, exitSlippageReserveCash: 0.04, fundingReserveCash: 0.02, totalReserveCash: 0.26 },
    surplusBeforeRebateCash: 0.74, surplusBeforeRebateBps: 74, entropyRoundTripFeesCash: 0.1,
    rebates: [{ ratio: 0, contingentRebateCash: 0, surplusCash: 0.74 }, { ratio: 1.1, contingentRebateCash: 0.11, surplusCash: 0.85 }, { ratio: 1.2, contingentRebateCash: 0.12, surplusCash: 0.86 }],
    gatePassed: true, sourceTimeUncertain: false, ...overrides };
}
function metrics({ delay = null, buy = 'entropy', latest = evaluation(), ...overrides } = {}) {
  return { buy, sell: buy === 'entropy' ? 'lighter' : 'entropy', scenario: delay,
    attempts: 40, completed: 36, failed: 4, costed: 36, passedAfterCosts: 32, sumSurplusBps: 36 * 74,
    minSurplusBps: -5, spanMs: 310000, firstAt: now - 310000, lastAt: now,
    qualitySpanMs: 310000, qualityFirstAt: now - 310000, qualityLastAt: now, latest, failureReasons: {}, ...overrides };
}
function makeReport() {
  const study = () => ({ raw: {
    'entropy:lighter': metrics(),
    'lighter:entropy': metrics({ buy: 'lighter', latest: evaluation({ grossCash: -1, grossBps: -100, surplusBeforeRebateCash: -1.26, surplusBeforeRebateBps: -126, gatePassed: false }) }),
  }, latency: {
    'base-assumed:entropy:lighter': metrics({ delay: scenario, latest: evaluation({ grossCash: 0.5, grossBps: 50, surplusBeforeRebateCash: 0.24, surplusBeforeRebateBps: 24 }) }),
    'base-assumed:lighter:entropy': metrics({ delay: scenario, buy: 'lighter', passedAfterCosts: 0, latest: evaluation({ surplusBeforeRebateCash: -1.26, surplusBeforeRebateBps: -126, gatePassed: false }) }),
  } });
  return { session: 'current-session', observedAt: now, observation: { asOf: now, silenceAfterMs: 10000 }, stopped: false,
    sessionConfig: { maxBookAgeMs: 750, simulation: { enabled: false, entropyTakerFeeBps: 5, lighterTakerFeeBps: 0,
      minEntryEdgeBps: 15, verifiedSymbols: ['SNDK'], notionalPerLeg: 100, fillWaitMs: 2000, latencyScenarios: [scenario] } },
    opportunityStudy: { sampleIntervalMs: 10000, bySymbol: { SNDK: study(), ANTH: study() } },
    latestQuotes: ['SNDK', 'ANTH'].flatMap((symbol) => ['entropy', 'lighter'].map((venue) => ({ symbol, venue,
      receivedAt: now - 100, sourceAt: now - 100, receiveAgeMs: 100, executionQuality: null, sourceClockUncertain: false }))),
    paper: {}, openPaperTasks: [], leaderMarkouts: {} };
}
function insights(report = makeReport(), options = {}) {
  return buildResearchInsights({ report, serverNow: now, running: true, reportCurrent: true, ...options });
}
const main = (report, options) => insights(report, options).bySymbol.SNDK;
const forwardDelay = (report) => report.opportunityStudy.bySymbol.SNDK.latency['base-assumed:entropy:lighter'];

test('sufficient delayed evidence only shortlists paper verification and keeps per-leg turnover explicit', () => {
  const result = main(makeReport());
  assert.equal(result.status, 'paper_candidate');
  assert.equal(result.title, 'SNDK 值得进行纸面验证');
  assert.deepEqual(result.direction, { buy: 'entropy', sell: 'lighter' });
  assert.deepEqual(result.notional, { buyCash: 100, sellCash: 101, approxRoundTripTurnoverCash: 402 });
  assert.equal(result.bestDelayed.sampleReady, true);
  assert.equal(result.bestDelayed.completionRate, 0.9);
  assert.equal(result.bestDelayed.passRate, 32 / 36);
  assert.match(result.caveat, /并非已实现收益/);
  assert.match(result.caveat, /样本可能相关/);
  assert.match(result.nextSteps.join(''), /只继续纸面模拟/);
});

test('a positive costed raw margin that turns negative after delay says speed erased the edge', () => {
  const report = makeReport();
  Object.assign(forwardDelay(report).latest, { surplusBeforeRebateCash: -0.1, surplusBeforeRebateBps: -10, gatePassed: false });
  const result = main(report);
  assert.equal(result.status, 'latency_erases_edge');
  assert.match(result.reason, /该买卖方向.*延迟后转负/);
  assert.equal(result.raw.surplusBeforeRebateBps, 74);
  assert.equal(result.bestDelayed.latest.surplusBeforeRebateBps, -10);
});

test('both directions are ranked by the costed surplus, not a mid-price basis or the buy price', () => {
  const report = makeReport();
  const reverse = report.opportunityStudy.bySymbol.SNDK.raw['lighter:entropy'];
  reverse.latest = evaluation({ buyPrice: 1000, sellPrice: 1020, buyNotional: 1000, sellNotional: 1020,
    grossBps: 200, surplusBeforeRebateBps: 140, surplusBeforeRebateCash: 14 });
  Object.assign(forwardDelay(report).latest, { surplusBeforeRebateBps: -2, gatePassed: false });
  const result = main(report);
  assert.equal(result.rawMetrics.buy, 'lighter');
  assert.equal(result.raw.buyPrice, 1000);
  assert.equal(result.bestDelayed.buy, 'lighter');
  assert.equal(result.bestDelayed.latest.surplusBeforeRebateBps, -126);
  assert.equal(result.status, 'latency_erases_edge');
});

test('main raw and delayed amounts keep the same direction when no scenario is eligible', () => {
  const report = makeReport();
  Object.assign(forwardDelay(report).latest, { surplusBeforeRebateCash: -0.4, surplusBeforeRebateBps: -40, gatePassed: false });
  const reverse = report.opportunityStudy.bySymbol.SNDK.latency['base-assumed:lighter:entropy'];
  Object.assign(reverse.latest, { surplusBeforeRebateCash: 0.1, surplusBeforeRebateBps: 10, gatePassed: false });
  const result = main(report);
  assert.deepEqual(result.direction, { buy: 'entropy', sell: 'lighter' });
  assert.equal(result.rawMetrics.buy, result.bestDelayed.buy);
  assert.equal(result.rawMetrics.sell, result.bestDelayed.sell);
  assert.equal(result.bestDelayed.latest.surplusBeforeRebateBps, -40);
});

test('a qualifying opposite direction switches both the raw and delayed amounts together', () => {
  const report = makeReport();
  Object.assign(forwardDelay(report).latest, { surplusBeforeRebateCash: 0.1, surplusBeforeRebateBps: 10, gatePassed: false });
  const study = report.opportunityStudy.bySymbol.SNDK;
  study.raw['lighter:entropy'].latest = evaluation({ surplusBeforeRebateCash: 0.6, surplusBeforeRebateBps: 60 });
  const reverse = study.latency['base-assumed:lighter:entropy'];
  reverse.passedAfterCosts = 32;
  reverse.latest = evaluation({ surplusBeforeRebateCash: 0.3, surplusBeforeRebateBps: 30 });
  const result = main(report);
  assert.equal(result.status, 'paper_candidate');
  assert.deepEqual(result.direction, { buy: 'lighter', sell: 'entropy' });
  assert.equal(result.rawMetrics.buy, result.bestDelayed.buy);
  assert.equal(result.raw.surplusBeforeRebateCash, 0.6);
  assert.equal(result.bestDelayed.latest.surplusBeforeRebateCash, 0.3);
});

test('unknown fees and their derived surplus stay null instead of being filled with zero', () => {
  const report = makeReport();
  report.sessionConfig.simulation.entropyTakerFeeBps = null;
  const unknown = evaluation({ costs: { feesRoundTripCash: null, exitSlippageReserveCash: 0.04, fundingReserveCash: 0.02, totalReserveCash: null },
    surplusBeforeRebateCash: null, surplusBeforeRebateBps: null, entropyRoundTripFeesCash: null,
    rebates: [{ ratio: 1.1, contingentRebateCash: null, surplusCash: null }], gatePassed: false });
  for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK.raw)) row.latest = unknown;
  const result = main(report);
  assert.equal(result.status, 'unknown_costs');
  assert.equal(result.raw.costs.feesRoundTripCash, null);
  assert.equal(result.raw.costs.totalReserveCash, null);
  assert.equal(result.raw.rebates[0].contingentRebateCash, null);
});

test('four-fee and Entropy-only 110/120 percent rebate amounts are consumed without recalculation', () => {
  const report = makeReport();
  report.sessionConfig.simulation.lighterTakerFeeBps = 10;
  const expected = evaluation({ costs: { feesRoundTripCash: 0.302, exitSlippageReserveCash: 0.04, fundingReserveCash: 0.02, totalReserveCash: 0.362 },
    surplusBeforeRebateCash: 0.638, surplusBeforeRebateBps: 63.8,
    rebates: [{ ratio: 1.1, contingentRebateCash: 0.11, surplusCash: 0.748 }, { ratio: 1.2, contingentRebateCash: 0.12, surplusCash: 0.758 }] });
  report.opportunityStudy.bySymbol.SNDK.raw['entropy:lighter'].latest = expected;
  const result = main(report);
  assert.deepEqual(result.raw, expected);
  assert.equal(result.raw.entropyRoundTripFeesCash, 0.1);
  assert.equal(result.raw.rebates[0].contingentRebateCash, 0.11);
  assert.equal(result.raw.costs.feesRoundTripCash, 0.302);
});

test('rebates cannot upgrade a negative before-rebate margin to a strategy candidate', () => {
  const report = makeReport();
  for (const group of ['raw', 'latency']) for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK[group])) {
    Object.assign(row.latest, { surplusBeforeRebateCash: -0.05, surplusBeforeRebateBps: -5, gatePassed: false,
      rebates: [{ ratio: 1.1, contingentRebateCash: 0.11, surplusCash: 0.06 }, { ratio: 1.2, contingentRebateCash: 0.12, surplusCash: 0.07 }] });
  }
  const result = main(report);
  assert.equal(result.status, 'no_edge');
  assert.ok(result.raw.rebates[0].surplusCash > 0);
  assert.match(result.reason, /不会把它升级/);
});

test('ANTH requires economic equivalence before any persistent basis can support convergence research', () => {
  const report = makeReport();
  report.sessionConfig.simulation.verifiedSymbols.push('ANTH');
  report.basis = { ANTH: { samples: 1000, meanBps: 250 } };
  const result = insights(report).bySymbol.ANTH;
  assert.equal(result.status, 'verify_equivalence');
  assert.match(result.reason, /不建议做基差收敛套利/);
});

test('each evidence threshold and the latest delayed evaluation fail closed', async (t) => {
  const cases = [
    ['fewer than 30 costed samples', (row) => { row.costed = 29; row.passedAfterCosts = 29; }],
    ['less than five quality minutes', (row) => { row.qualitySpanMs = 299999; }],
    ['legacy metrics without quality span', (row) => { delete row.qualitySpanMs; }],
    ['completion below 80 percent', (row) => { row.attempts = 100; row.completed = 79; row.costed = 79; row.passedAfterCosts = 79; }],
    ['pass rate below 75 percent', (row) => { row.passedAfterCosts = 26; }],
    ['latest margin below session threshold', (row) => { row.latest.surplusBeforeRebateBps = 14; }],
    ['latest source time uncertain', (row) => { row.latest.sourceTimeUncertain = true; }],
    ['latest gate did not pass', (row) => { row.latest.gatePassed = false; }],
    ['latest delayed evidence stale', (row) => { row.latest.at = now - 17451; }],
    ['latest delayed evidence in future', (row) => { row.latest.at = now + 101; }],
    ['inconsistent counters', (row) => { row.costed = row.completed + 1; }],
    ['failed and completed exceed attempts', (row) => { row.failed = 5; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const report = makeReport(); mutate(forwardDelay(report));
    assert.notEqual(main(report).status, 'paper_candidate');
  });
});

test('31 uncertain observations and one trustworthy costed sample cannot create a shortlist', () => {
  const report = makeReport();
  Object.assign(forwardDelay(report), { attempts: 32, completed: 32, failed: 0, costed: 1, passedAfterCosts: 1,
    sumSurplusBps: 24, qualitySpanMs: 0, qualityFirstAt: now, qualityLastAt: now });
  const result = main(report);
  assert.equal(result.status, 'insufficient_samples');
  assert.equal(result.bestDelayed.completionRate, 1);
  assert.equal(result.bestDelayed.passRate, 1);
  assert.equal(result.bestDelayed.costed, 1);
  assert.equal(result.bestDelayed.sampleReady, false);
});

test('30 trustworthy costed samples still need five minutes of quality sample span', () => {
  const report = makeReport();
  Object.assign(forwardDelay(report), { attempts: 32, completed: 32, failed: 0, costed: 30, passedAfterCosts: 30,
    spanMs: 900000, qualitySpanMs: 299999, qualityFirstAt: now - 299999, qualityLastAt: now });
  assert.equal(main(report).status, 'insufficient_samples');
  forwardDelay(report).qualitySpanMs = 300000;
  forwardDelay(report).qualityFirstAt = now - 300000;
  assert.equal(main(report).status, 'paper_candidate');
});

test('current report and quote windows do not reuse the strict 750ms execution TTL', () => {
  const report = makeReport();
  assert.equal(main(report, { serverNow: now + 5000 }).status, 'paper_candidate');
  assert.equal(main(report, { serverNow: now + 9900 }).status, 'paper_candidate');
  assert.equal(main(report, { serverNow: now + 9901 }).status, 'blocked');
  assert.equal(main(report, { serverNow: now + 10001 }).status, 'stale');
  assert.equal(main(report, { reportCurrent: false }).status, 'stale');
});

test('recent research evidence has a cadence-aware window independent of fresh report and quote windows', () => {
  const report = makeReport();
  assert.equal(insights(report).evidenceMaxAgeMs, 17450);
  for (const group of ['raw', 'latency']) for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK[group])) {
    row.latest.at = now - 17450; row.lastAt = row.latest.at;
  }
  assert.equal(main(report).status, 'paper_candidate');
  forwardDelay(report).latest.at--;
  assert.notEqual(main(report).status, 'paper_candidate');
  assert.equal(insights(report).reportCurrent, true);
});

test('stale raw or delayed evidence withdraws negative current conclusions despite fresh quotes', async (t) => {
  for (const status of ['no_edge', 'latency_erases_edge']) for (const staleGroup of ['raw', 'latency']) await t.test(`${status}: stale ${staleGroup}`, () => {
    const report = makeReport();
    for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK.latency)) {
      Object.assign(row.latest, { surplusBeforeRebateCash: -0.1, surplusBeforeRebateBps: -10, gatePassed: false });
    }
    if (status === 'no_edge') for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK.raw)) {
      Object.assign(row.latest, { surplusBeforeRebateCash: -0.1, surplusBeforeRebateBps: -10, gatePassed: false });
    }
    assert.equal(main(report).status, status);
    for (const row of Object.values(report.opportunityStudy.bySymbol.SNDK[staleGroup])) row.latest.at = now - 17451;
    const result = insights(report);
    assert.equal(result.reportCurrent, true);
    assert.equal(result.bySymbol.SNDK.status, 'waiting');
    assert.equal(result.bySymbol.SNDK.reason, '最近研究样本已停更，保留历史数值，等待双腿重新同步。');
    assert.equal(result.bySymbol.SNDK.bestDelayed.latest.surplusBeforeRebateCash, -0.1);
    assert.doesNotMatch(result.bySymbol.SNDK.title, /当前/);
  });
});

test('a newer failed or pending probe cannot reuse the older successful raw or delayed evaluation', async (t) => {
  for (const group of ['raw', 'latency']) await t.test(group, () => {
    const report = makeReport();
    const key = group === 'raw' ? 'entropy:lighter' : 'base-assumed:entropy:lighter';
    report.opportunityStudy.bySymbol.SNDK[group][key].lastAt = now + 1;
    assert.notEqual(main(report).status, 'paper_candidate');
  });
});

test('stopping and a future report withdraw the shortlist while keeping historical numbers', () => {
  const report = makeReport();
  const stopped = main(report, { running: false });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.raw.surplusBeforeRebateCash, 0.74);
  report.stopped = true;
  assert.equal(main(report).status, 'stopped');
  report.stopped = false; report.observedAt = now + 101; report.observation.asOf = now + 101;
  const future = insights(report);
  assert.equal(future.reportAgeMs, null);
  assert.equal(future.bySymbol.SNDK.status, 'stale');
  report.observedAt = now + 100; report.observation.asOf = now + 100;
  assert.equal(insights(report).reportAgeMs, 0);
});

test('quote uncertainty and execution-quality failures prevent a paper shortlist', async (t) => {
  for (const [name, patch] of [
    ['clock failure', { executionQuality: 'wall_clock' }],
    ['depth failure', { executionQuality: 'invalid_depth' }],
    ['missing execution quality', { executionQuality: undefined }],
    ['uncertain source time', { sourceClockUncertain: true }],
    ['invalid receive age', { receiveAgeMs: -1 }],
    ['silenced quote', { receiveAgeMs: 10001 }],
  ]) await t.test(name, () => {
    const report = makeReport(); Object.assign(report.latestQuotes[0], patch);
    assert.equal(main(report).status, 'blocked');
  });
});

test('strict execution staleness waits for a new trigger without erasing recent research evidence', () => {
  const report = makeReport();
  report.latestQuotes[0].executionQuality = 'stale_receive';
  report.latestQuotes[1].executionQuality = 'stale_source';
  const result = main(report);
  assert.equal(result.status, 'paper_candidate');
  assert.match(result.nextSteps[0], /等待通过严格时效检查的新盘口/);
  assert.equal(report.sessionConfig.maxBookAgeMs, 750);
  assert.equal(report.latestQuotes[0].executionQuality, 'stale_receive');
});

test('unverified identity, unresolved paper and cross-symbol open exposure block new shortlists', async (t) => {
  const cases = [
    ['identity', (report) => { report.sessionConfig.simulation.verifiedSymbols = []; }],
    ['unresolved all-symbol summary', (report) => { report.paper.base = { unresolved: 1, openTasks: 0 }; }],
    ['other-symbol open task', (report) => { report.openPaperTasks = [{ symbol: 'ANTH' }]; }],
    ['summary open task', (report) => { report.paper.base = { unresolved: 0, openTasks: 1 }; }],
    ['prior session unresolved', (report) => { report.paperSuspendedReason = 'previous_session'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const report = makeReport(); mutate(report);
    assert.equal(main(report).status, 'blocked');
  });
});

test('positive global paper results cannot replace the missing symbol-specific evidence', () => {
  const report = makeReport();
  forwardDelay(report).costed = 5; forwardDelay(report).passedAfterCosts = 5;
  report.paper.base = { completed: 1000, openTasks: 0, unresolved: 0, netBeforeRebate: 20000 };
  const result = insights(report);
  assert.equal(result.bySymbol.SNDK.status, 'insufficient_samples');
  assert.equal(result.paper.scope, 'all_symbols');
  assert.equal(result.paper.unresolved, false);
});

test('legacy reports wait for captured session parameters and new study rather than borrowing configuration', () => {
  const report = makeReport(); delete report.sessionConfig;
  const result = main(report);
  assert.equal(result.status, 'waiting');
  assert.match(result.reason, /未记录会话参数/);
  delete report.observedAt; delete report.observation; delete report.opportunityStudy;
  assert.equal(main(report).status, 'waiting');
  const withoutStudy = makeReport(); delete withoutStudy.opportunityStudy;
  assert.equal(main(withoutStudy).status, 'waiting');
  assert.equal(buildResearchInsights({ serverNow: now }).bySymbol.SNDK.status, 'waiting');
});

test('failed delayed probes retain counts with no fabricated latest evaluation', () => {
  const report = makeReport();
  forwardDelay(report).latest = null;
  const result = main(report);
  assert.equal(result.delayed.length, 2);
  assert.equal(result.delayed.find((row) => row.buy === 'entropy').latest, null);
  assert.notEqual(result.status, 'paper_candidate');
});

test('Binance markouts remain unproven even with many positive observations, without adding correlated windows', () => {
  const report = makeReport();
  report.leaderMarkouts = { 'SNDK:entropy:300': { samples: 50, directionHitRate: 0.9, meanSignedMoveBps: 10 },
    'SNDK:entropy:500': { samples: 50, directionHitRate: 0.9, meanSignedMoveBps: 12 },
    'ANTH:lighter:300': { samples: 20, directionHitRate: 0.8, meanSignedMoveBps: 3 } };
  const result = insights(report).leader;
  assert.equal(result.status, 'unproven');
  assert.equal(result.samples, 50);
  assert.equal(result.rows.length, 3);
  assert.match(result.reason, /没有成本、下单延迟和真实执行证据/);
  assert.match(insights(makeReport()).leader.reason, /样本不足/);
});

test('interpretation is repeatable and does not mutate the input report', () => {
  const report = makeReport(), before = structuredClone(report);
  assert.deepEqual(insights(report), insights(report));
  assert.deepEqual(report, before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultQualityBudget, evaluateOpportunityQuality, pairQualityHistory, parseQualityBudget, qualityHistoryIdentity, qualityPairKey } from '../lib/perpetual-quality.ts';
import { createQualityHistory, QUALITY_SAMPLE_MS, QUALITY_PRICE_WINDOW_MS, QUALITY_FUNDING_WINDOW_MS } from '../server/perpetual-quality-history.mjs';
import { openPerpetualStore } from '../server/perpetual-store.mjs';

const NOW = Math.floor(1_790_000_000_000 / 300_000) * 300_000;
const quote = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 99, ask: 100, mark: 100, last: 100, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: NOW + 3_600_000, sourceTime: NOW, receivedAt: NOW, transport: 'ws', bidAskAt: NOW, markAt: NOW, fundingAt: NOW, ...patch });
const venue = id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: NOW, error: null });
const snapshot = (quotes, now = NOW) => ({ schemaVersion: 1, monitorId: 'perpetual', status: 'live', generatedAt: now, staleAfterMs: 30_000, exchanges: [...new Set(quotes.map(item => item.exchange))].map(venue), quotes });
const pair = (patch = {}) => ({ base: 'BTC', long: quote('binance'), short: quote('gate', { bid: 101, ask: 102 }), buyPrice: 100, sellPrice: 101, spreadPercent: 1, fundingSpread8h: 0.0001, updatedAt: NOW, crossCurrency: false, ...patch });
const stats = (patch = {}) => ({ samples: 60, expectedSamples: 60, coverage: 1, firstAt: NOW - 59 * 60_000, lastAt: NOW, mean: 1, stddev: 0, positiveRatio: 1, signChanges: 0, ...patch });
const ratio = (exchange, patch = {}) => ({ exchange, symbol: 'BTCUSDT', longRatio: 0.5, shortRatio: 0.5, kind: 'accounts', scope: 'all', source: 'official', observedAt: NOW, ...patch });
const convergence = (patch = {}) => ({ method: 'non-overlapping-quoted-halving-v1', windowMs: 86400000, sampleIntervalMs: 300000, targetFraction: 0.5, minEntrySpreadPercent: 0.05, samples: 288, lastAt: NOW, horizons: [1, 4, 8].map(hours => ({ hours, completed: Math.floor(24 / hours) - 1, successful: Math.floor(24 / hours) - 1, incomplete: 0, pending: 1, successRatio: 1, medianMinutesToTarget: 30, maxAdverseExpansionPercent: 0 })), ...patch });
function report(row = pair()) {
  return {
    schemaVersion: 1, generatedAt: NOW, sampleIntervalMs: 60_000, priceWindowMs: 3_600_000, fundingWindowMs: 86_400_000,
    assets: { BTC: { coinId: 'bitcoin', name: 'Bitcoin', marketCapUsd: 10e9, fdvUsd: 10e9, circulatingSupply: 10, totalSupply: 10, maxSupply: null, updatedAt: NOW, source: 'coingecko' } },
    assetErrors: {}, positioning: { 'binance:BTCUSDT': ratio('binance'), 'gate:BTCUSDT': ratio('gate') }, positioningErrors: {},
    pairs: { [qualityPairKey(row)]: { base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}`, spread: stats(), funding: stats({ samples: 288, expectedSamples: 288, firstAt: NOW - 287 * 300_000, mean: 0.01, longStddev: 0, shortStddev: 0 }), convergence: convergence() } },
  };
}
const dimension = (result, id) => result.dimensions.find(item => item.id === id).score;
const historyRow = (spread, long = 0.01, short = 0.02, patch = {}) => [patch.base ?? 'BTC', patch.longKey ?? 'binance:BTCUSDT', patch.shortKey ?? 'gate:BTCUSDT', patch.identity ?? 'same-contract', spread, long, short];
const readPair = (history, now = NOW) => history.get('BTC', 'binance:BTCUSDT', 'gate:BTCUSDT', now);

test('detail minute observations preserve gaps, bounded window and isolated copies', () => {
  const history = createQualityHistory();
  for (const minutes of [65, 59, 58, 56, 1, 0]) history.ingest(NOW - minutes * 60_000, [historyRow(minutes / 100)], NOW);
  const before = history.metrics();
  assert.equal(readPair(history).priceSeries, undefined);
  const detail = history.get('BTC', 'binance:BTCUSDT', 'gate:BTCUSDT', NOW, true);
  assert.deepEqual(detail.priceSeries.map(point => (NOW - point[0]) / 60_000), [59, 58, 56, 1, 0]);
  detail.priceSeries[0][1] = 999;
  assert.equal(history.get('BTC', 'binance:BTCUSDT', 'gate:BTCUSDT', NOW, true).priceSeries[0][1], .59);
  assert.deepEqual(history.metrics(), before);
});

test('FX-adjusted current edge never reuses unconverted price or funding history', () => {
  const row = pair({ crossCurrency: true, fxAdjusted: true, fxAt: NOW, short: quote('gate', { quoteCurrency: 'USDC', bid: 101, ask: 102 }) });
  const budget = { ...defaultQualityBudget, takerOverrides: { gate: .05 } };
  const result = evaluateOpportunityQuality(row, report(row), NOW, budget);
  assert.equal(result.score, null);
  assert.equal(dimension(result, 'spread'), null);
  assert.equal(dimension(result, 'funding'), null);
  assert.ok(result.netSpreadPercent > 0);
  assert.equal(pairQualityHistory(row, report(row)), undefined);
  const expired = evaluateOpportunityQuality({ ...row, fxAt: NOW - 180001 }, report(row), NOW, budget);
  assert.equal(expired.netSpreadPercent, null);
  assert.match(expired.reasons.join(' '), /汇率.*过期/);
});

test('unit changes invalidate cached evidence before the next minute sampler runs', () => {
  const row = pair(), cached = report(row), key = qualityPairKey(row);
  cached.pairs[key].identity = qualityHistoryIdentity(row.long, row.short);
  const changed = { ...row, long: { ...row.long, multiplier: 1000 } };
  assert.equal(pairQualityHistory(changed, cached), undefined);
  assert.equal(dimension(evaluateOpportunityQuality(changed, cached, NOW), 'spread'), null);
  const history = createQualityHistory();
  history.ingest(NOW, [historyRow(2, .01, .02, { identity: cached.pairs[key].identity })], NOW);
  const read = history.get(row.base, 'binance:BTCUSDT', 'gate:BTCUSDT', NOW, true, qualityHistoryIdentity(changed.long, changed.short));
  assert.equal(read.spread.samples, 0);
  assert.deepEqual(read.priceSeries, []);
});
function livePair(now, longPatch = {}, shortPatch = {}) {
  const time = { bidAskAt: now, fundingAt: now, receivedAt: now, sourceTime: now };
  return snapshot([quote('binance', { ...time, ...longPatch }), quote('gate', { bid: 101, ask: 102, ...time, ...shortPatch })], now);
}

test('quality separates market size from market-cap to FDV ratio without assuming maximum supply', () => {
  const row = pair(), data = report(row);
  const complete = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(complete.grade, 'strong');
  assert.equal(complete.score, 100);
  assert.equal(complete.coverage, 100);
  for (const [cap, expected] of [[10e9, 100], [1e9, 80], [100e6, 60], [10e6, 35], [1e6, 10]]) {
    data.assets.BTC.marketCapUsd = cap;
    data.assets.BTC.fdvUsd = cap * 10;
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'marketCap'), expected);
    assert.equal(dimension(result, 'fdv'), 10);
  }
  data.assets.BTC.fdvUsd = null;
  data.assets.BTC.maxSupply = 1_000_000;
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'fdv'), null);
  data.assets.BTC.fdvUsd = data.assets.BTC.marketCapUsd * 0.5;
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'fdv'), null, 'Inconsistent provider values must not award maximum dilution points');
});

test('quality crowding uses the proposed long and short directions and does not mix accounts with positions', () => {
  const row = pair(), data = report(row);
  data.positioning['binance:BTCUSDT'] = ratio('binance', { longRatio: 0.9, shortRatio: 0.1 });
  data.positioning['gate:BTCUSDT'] = ratio('gate', { longRatio: 0.1, shortRatio: 0.9 });
  assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'positioning'), 20);
  const reversed = pair({ long: row.short, short: row.long });
  assert.equal(dimension(evaluateOpportunityQuality(reversed, data, NOW), 'positioning'), 100);
  data.positioning['gate:BTCUSDT'].kind = 'positions';
  const mixed = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(mixed, 'positioning'), null);
  assert.equal(mixed.coverage, 90);
  assert.notEqual(mixed.grade, 'strong');
});

test('quality leaves missing, stale and malformed evidence unscored rather than treating it as zero risk', () => {
  const row = pair();
  for (const changed of [
    data => { data.assets.BTC.updatedAt = NOW - 3_600_001; },
    data => { data.assets.BTC.updatedAt = NOW + 5001; },
    data => { delete data.assets.BTC; },
    data => { data.assets.BTC.marketCapUsd = 0; data.assets.BTC.fdvUsd = 0; },
  ]) {
    const data = report(row); changed(data);
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'marketCap'), null);
    assert.equal(dimension(result, 'fdv'), null);
    assert.notEqual(result.grade, 'strong');
  }
  for (const patch of [{ observedAt: NOW - 900_001 }, { observedAt: NOW + 5001 }, { longRatio: 0.9, shortRatio: 0.9 }, { longRatio: NaN }, { shortRatio: -0.1 }]) {
    const data = report(row); Object.assign(data.positioning['binance:BTCUSDT'], patch);
    assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'positioning'), null);
  }
});

test('returning after three minutes retains evidence according to each source lifetime', () => {
  const row = pair(), data = report(row);
  const returnedAt = NOW + 181_000;
  const result = evaluateOpportunityQuality({ ...row, updatedAt: returnedAt }, data, returnedAt);
  assert.equal(result.coverage, 90, 'Only the three-minute spread evidence has expired');
  assert.equal(dimension(result, 'spread'), null);
  for (const id of ['marketCap', 'fdv', 'positioning', 'funding']) assert.notEqual(dimension(result, id), null, id);
  for (const [elapsed, coverage] of [
    [180_000, 100], [180_001, 90], [600_000, 90], [600_001, 30],
    [900_000, 30], [900_001, 20], [3_600_000, 20], [3_600_001, 0],
  ]) {
    const now = NOW + elapsed;
    assert.equal(evaluateOpportunityQuality({ ...row, updatedAt: now }, data, now).coverage, coverage, `Elapsed ${elapsed} ms`);
    assert.equal(evaluateOpportunityQuality({ ...row, updatedAt: now }, { ...data, generatedAt: now }, now).coverage, coverage, 'A new response timestamp cannot renew old observations');
  }
});

test('invalid or excessively future report times cannot establish quality evidence', () => {
  const row = pair();
  for (const generatedAt of [undefined, null, NaN, Infinity, -Infinity, 0, -1, String(NOW), NOW + 5_001]) {
    const result = evaluateOpportunityQuality(row, { ...report(row), generatedAt }, NOW);
    assert.equal(result.coverage, 0, String(generatedAt));
    assert.equal(result.score, null);
    assert.ok(result.dimensions.every(item => item.score === null));
  }
  assert.equal(evaluateOpportunityQuality(row, { ...report(row), generatedAt: NOW + 5_000 }, NOW).coverage, 100);
});

test('source observations cannot postdate their report beyond the clock-skew allowance', () => {
  const row = pair(), at = NOW - 60_000;
  function coherentReport() {
    const data = report(row);
    data.generatedAt = at;
    data.assets.BTC.updatedAt = at;
    for (const ratio of Object.values(data.positioning)) ratio.observedAt = at;
    for (const history of Object.values(data.pairs)) { history.spread.lastAt = at; history.funding.lastAt = at; history.convergence.lastAt = at; }
    return data;
  }
  for (const [id, update] of [
    ['marketCap', (data, value) => { data.assets.BTC.updatedAt = value; }],
    ['positioning', (data, value) => { data.positioning['binance:BTCUSDT'].observedAt = value; }],
    ['spread', (data, value) => { data.pairs[qualityPairKey(row)].spread.lastAt = value; }],
    ['funding', (data, value) => { data.pairs[qualityPairKey(row)].funding.lastAt = value; }],
    ['convergence', (data, value) => { data.pairs[qualityPairKey(row)].convergence.lastAt = value; }],
  ]) {
    const data = coherentReport();
    update(data, at + 5_000);
    assert.equal(evaluateOpportunityQuality(row, data, NOW).coverage, 100, id);
    update(data, at + 5_001);
    assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), id), null, id);
  }
});

test('quality does not score insufficient or expired history and limits grades on partial coverage', () => {
  const row = pair(), key = qualityPairKey(row);
  for (const patch of [{ samples: 29 }, { coverage: 0.49 }, { lastAt: NOW - 180_001 }]) {
    const data = report(row); Object.assign(data.pairs[key].spread, patch);
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'spread'), null);
    assert.equal(result.score, null);
    assert.equal(result.grade, 'insufficient');
  }
  for (const patch of [{ samples: 11 }, { coverage: 0 }, { lastAt: NOW - 600_001 }, { longStddev: null }]) {
    const data = report(row); Object.assign(data.pairs[key].funding, patch);
    assert.equal(dimension(evaluateOpportunityQuality(row, data, NOW), 'funding'), null);
  }
  const limited = report(row);
  Object.assign(limited.pairs[key].funding, { samples: 12, coverage: 12 / 288 });
  const result = evaluateOpportunityQuality(row, limited, NOW);
  assert.equal(dimension(result, 'funding'), 100);
  assert.equal(result.grade, 'watch', 'One hour of funding samples cannot establish twelve-hour quality');
  delete limited.assets.BTC;
  delete limited.positioning['gate:BTCUSDT'];
  const sparse = evaluateOpportunityQuality(row, limited, NOW);
  assert.equal(sparse.coverage, 70);
  assert.equal(sparse.score, 100);
  assert.equal(sparse.grade, 'watch');
});

test('quality never gives a constant negative spread a high stability score', () => {
  const row = pair(), data = report(row), history = createQualityHistory();
  for (let index = 29; index >= 0; index--) history.ingest(NOW - index * 60_000, [historyRow(-0.5)], NOW);
  data.pairs[qualityPairKey(row)].spread = readPair(history).spread;
  const result = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(result, 'spread'), 0);
  assert.notEqual(result.grade, 'strong');
});

test('quality funding stability measures both legs even when their changes cancel in the funding difference', () => {
  const row = pair(), data = report(row), history = createQualityHistory();
  for (let index = 143; index >= 0; index--) {
    const rate = index % 2 ? -0.2 : 0.2;
    history.ingest(NOW - index * 300_000, [historyRow(null, rate, rate)], NOW);
  }
  const funding = readPair(history).funding;
  assert.equal(funding.stddev, 0);
  assert.ok(funding.longStddev > 0.19 && funding.shortStddev > 0.19);
  assert.equal(funding.coverage, 0.5);
  data.pairs[qualityPairKey(row)].funding = funding;
  assert.ok(dimension(evaluateOpportunityQuality(row, data, NOW), 'funding') <= 21);
});

test('quality keeps mark mode, cross-currency prices and stale current quotes as reference only', () => {
  const row = pair(), data = report(row);
  for (const [candidate, mode] of [[row, 'mark'], [pair({ crossCurrency: true }), 'book'], [pair({ updatedAt: NOW - 30_001 }), 'book']]) {
    const result = evaluateOpportunityQuality(candidate, data, NOW, defaultQualityBudget, mode);
    assert.equal(result.grade, 'reference');
    assert.equal(result.score, null);
    assert.equal(result.netSpreadPercent, null);
  }
});

test('quality cost budgets remain an auxiliary calculation and notices or adverse carry constrain the grade', () => {
  const row = pair(), data = report(row);
  const cost = evaluateOpportunityQuality(row, data, NOW, { takerOverrides: { binance: 0.1, gate: 0.2 }, slippagePercent: 0.5 });
  assert.equal(cost.score, 100, 'Cost settings do not rewrite the fundamental and historical evidence');
  assert.ok(Math.abs(cost.netSpreadPercent + 0.1) < 1e-10);
  assert.equal(cost.grade, 'weak');
  const delisting = pair({ long: quote('binance', { delisting: true, delistingAt: null }) });
  assert.equal(evaluateOpportunityQuality(delisting, data, NOW).grade, 'weak');
  data.pairs[qualityPairKey(row)].funding.mean = -1;
  assert.equal(evaluateOpportunityQuality(row, data, NOW).grade, 'weak');
});

test('quality migrates old aggregate fee budgets to public taker without losing the slippage setting', () => {
  for (const input of [null, '', '{broken', JSON.stringify({ version: 3, feePercent: 0 })]) assert.deepEqual(parseQualityBudget(input), defaultQualityBudget);
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: 0, slippagePercent: 0 })), { takerOverrides: {}, slippagePercent: 0 });
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: '0.1', slippagePercent: -1 })), defaultQualityBudget);
  assert.deepEqual(parseQualityBudget(JSON.stringify({ version: 1, feePercent: 10.1, slippagePercent: 0.3 })), { takerOverrides: {}, slippagePercent: 0.3 });
});

test('unknown taker cost cannot appear free or promote an otherwise strong opportunity', () => {
  const row = pair(), data = report(row);
  const known = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(known.fees.roundTripPercent, 0.2);
  assert.ok(Math.abs(known.netSpreadPercent - 0.7) < 1e-12);
  // A newly unsupported fee category must preserve the evidence score, but not its strong label.
  row.short.base = 'GATE:UNVERIFIED:BTC';
  const missing = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(missing.score, known.score);
  assert.equal(missing.fees.roundTripPercent, null);
  assert.equal(missing.netSpreadPercent, null);
  assert.equal(missing.grade, 'watch');
  assert.ok(missing.reasons.some(reason => reason.includes('taker')));
  const covered = evaluateOpportunityQuality(row, data, NOW, { ...defaultQualityBudget, takerOverrides: { gate: 0.04 } });
  assert.equal(covered.grade, 'strong');
});

test('quality history samples a minute once and leaves offline gaps empty', () => {
  const history = createQualityHistory();
  assert.ok(history.sample(livePair(NOW), NOW));
  assert.equal(history.sample(livePair(NOW + 30_000), NOW + 30_000), null);
  history.sample(livePair(NOW + 600_000), NOW + 600_000);
  const values = readPair(history, NOW + 600_000);
  assert.equal(values.spread.samples, 2);
  assert.equal(values.funding.samples, 2);
  assert.equal(values.spread.coverage, 2 / 60);
  assert.equal(values.spread.firstAt, NOW);
  assert.equal(values.spread.lastAt, NOW + 600_000);
});

test('quality history rejects stale or incomplete books and preserves missing funding rather than filling zero', () => {
  const history = createQualityHistory();
  history.sample(livePair(NOW), NOW);
  history.sample(livePair(NOW + 60_000, { bidAskAt: NOW }, { bidAskAt: NOW }), NOW + 60_000);
  history.sample(livePair(NOW + 300_000, { fundingRate: null }), NOW + 300_000);
  const values = readPair(history, NOW + 300_000);
  assert.equal(values.spread.samples, 2);
  assert.equal(values.funding.samples, 1);
});

test('quality history normalizes each funding interval and retains true zero and negative rates', () => {
  const history = createQualityHistory();
  history.sample(livePair(NOW, { fundingRate: -0.0001, fundingIntervalHours: 1 }, { fundingRate: 0, fundingIntervalHours: 4 }), NOW);
  const values = readPair(history);
  assert.ok(Math.abs(values.funding.mean - 0.08) < 1e-10);
  assert.equal(values.funding.positiveRatio, 1);
  assert.equal(values.funding.longStddev, 0);
});

test('quality history keeps venue combinations and trading directions separate when the best pair changes', () => {
  const history = createQualityHistory();
  history.sample(snapshot([quote('binance'), quote('gate', { bid: 101, ask: 102 }), quote('c', { bid: 103, ask: 104 })]), NOW);
  const next = NOW + 60_000;
  history.sample(snapshot([
    quote('binance', { bidAskAt: next, receivedAt: next }),
    quote('gate', { bid: 101, ask: 102, bidAskAt: next, receivedAt: next }),
    quote('c', { bid: 99, ask: 100, bidAskAt: next, receivedAt: next }),
  ], next), next);
  assert.equal(history.get('BTC', 'binance:BTCUSDT', 'c:BTCUSDT', next).spread.samples, 2);
  assert.equal(history.get('BTC', 'binance:BTCUSDT', 'gate:BTCUSDT', next).spread.samples, 1);
  assert.equal(history.get('BTC', 'gate:BTCUSDT', 'binance:BTCUSDT', next).spread.samples, 0);
  const forward = qualityPairKey(pair()), reverse = qualityPairKey(pair({ long: quote('gate'), short: quote('binance') }));
  assert.notEqual(forward, reverse);
});

test('same-asset watched combinations keep separate spread and funding evidence across persistence', () => {
  const history = createQualityHistory(), restored = createQualityHistory();
  const watched = [
    { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'gate:BTCUSDT' },
    { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'c:BTCUSDT' },
    { base: 'BTC', longKey: 'gate:BTCUSDT', shortKey: 'binance:BTCUSDT' },
  ];
  const end = NOW + 300_000;
  for (const at of [NOW, end]) {
    const time = { bidAskAt: at, receivedAt: at, fundingAt: at };
    const sample = history.sample(snapshot([
      quote('binance', time),
      quote('gate', { ...time, bid: 101, ask: 102, fundingRate: 0.0002 }),
      quote('c', { ...time, bid: 103, ask: 104, fundingRate: 0.0004 }),
    ], at), at, [...watched, watched[0]]);
    assert.equal(sample.rows.length, 3, 'Repeated watches and the background best pair share their existing histories');
    restored.ingest(sample.bucket, sample.rows, end);
  }
  for (const [index, spread, funding] of [[0, 1, 0.01], [1, 3, 0.03], [2, (99 / 102 - 1) * 100, -0.01]]) {
    const row = watched[index], evidence = history.get(row.base, row.longKey, row.shortKey, end);
    assert.equal(evidence.spread.samples, 2);
    assert.equal(evidence.funding.samples, 2);
    assert.ok(Math.abs(evidence.spread.mean - spread) < 1e-10);
    assert.ok(Math.abs(evidence.funding.mean - funding) < 1e-10);
    assert.deepEqual(restored.get(row.base, row.longKey, row.shortKey, end), evidence);
  }
  assert.equal(history.get('BTC', 'c:BTCUSDT', 'binance:BTCUSDT', end).spread.samples, 0);
});

test('combination ranking keeps background history per asset and watched combinations within one shared cap', () => {
  const data = snapshot(Array.from({ length: 5 }, (_, index) => [
    quote('binance', { base: `COIN${index}`, symbol: `COIN${index}USDT` }),
    quote('gate', { base: `COIN${index}`, symbol: `COIN${index}USDT`, bid: 101, ask: 102 }),
    quote('c', { base: `COIN${index}`, symbol: `COIN${index}USDT`, bid: 103, ask: 104 }),
  ]).flat());
  assert.equal(createQualityHistory().sample(data, NOW).rows.length, 5, 'Background sampling must not expand to every ranked combination');
  const history = createQualityHistory({ maxPairs: 3 });
  const best = { base: 'COIN0', longKey: 'binance:COIN0USDT', shortKey: 'c:COIN0USDT' };
  const second = { ...best, shortKey: 'gate:COIN0USDT' };
  const sample = history.sample(data, NOW, [best, second, best]);
  assert.equal(sample.rows.length, 3);
  assert.equal(history.metrics().trackedPairs, 3);
  for (const row of [best, second, { base: 'COIN1', longKey: 'binance:COIN1USDT', shortKey: 'c:COIN1USDT' }]) {
    assert.equal(history.get(row.base, row.longKey, row.shortKey, NOW).spread.samples, 1);
  }
  assert.equal(history.get('COIN2', 'binance:COIN2USDT', 'c:COIN2USDT', NOW).spread.samples, 0);
});

test('quality history resets changed units, multipliers, collateral and quote currencies without carrying old samples', () => {
  for (const patch of [{ contractUnit: 'new unit' }, { multiplier: 1000 }, { quoteCurrency: 'USDC' }, { collateralCurrency: 'USDC' }]) {
    const history = createQualityHistory();
    history.sample(livePair(NOW), NOW);
    const next = NOW + 60_000;
    history.sample(livePair(next, patch, patch), next);
    const values = readPair(history, next);
    assert.equal(values.spread.samples, 1);
    assert.equal(values.spread.firstAt, next);
    assert.equal(values.funding.samples, 0);
  }
  const history = createQualityHistory();
  history.sample(livePair(NOW), NOW);
  history.sample(livePair(NOW + 60_000, { comparable: false }), NOW + 60_000);
  assert.equal(readPair(history, NOW + 60_000).spread.samples, 0);
  const changedBase = createQualityHistory();
  changedBase.sample(livePair(NOW), NOW);
  changedBase.sample(livePair(NOW + 60_000, { base: 'OTHER' }, { base: 'OTHER' }), NOW + 60_000);
  assert.equal(readPair(changedBase, NOW + 60_000).spread.samples, 0);
  assert.equal(changedBase.get('OTHER', 'binance:BTCUSDT', 'gate:BTCUSDT', NOW + 60_000).spread.samples, 1);
});

test('quality history rolls one-hour prices and twenty-four-hour funding windows at their exact boundaries', () => {
  const history = createQualityHistory();
  for (let index = 1440; index >= 0; index--) history.ingest(NOW - index * QUALITY_SAMPLE_MS, [historyRow(1)], NOW);
  const values = readPair(history);
  assert.equal(values.spread.samples, 60);
  assert.equal(values.spread.firstAt, NOW - QUALITY_PRICE_WINDOW_MS + QUALITY_SAMPLE_MS);
  assert.equal(values.funding.samples, 288);
  assert.equal(values.funding.firstAt, NOW - QUALITY_FUNDING_WINDOW_MS + 300_000);
  assert.deepEqual(history.metrics(), { trackedPairs: 1, pricePoints: 60, fundingPoints: 288, convergencePoints: 288 });
  const expired = readPair(history, NOW + QUALITY_FUNDING_WINDOW_MS);
  assert.equal(expired.spread.samples, 0);
  assert.equal(expired.funding.samples, 0);
});

test('quality history ignores duplicate, future and unaligned persisted samples', () => {
  const history = createQualityHistory();
  history.ingest(NOW, [historyRow(1)], NOW);
  history.ingest(NOW, [historyRow(99)], NOW);
  history.ingest(NOW + 1, [historyRow(99)], NOW + 1);
  history.ingest(NOW + QUALITY_SAMPLE_MS, [historyRow(99)], NOW);
  assert.equal(readPair(history).spread.samples, 1);
  assert.equal(readPair(history).spread.mean, 1);
});

test('quality history enforces the default thousand-pair cap and keeps retained rings bounded', () => {
  const history = createQualityHistory();
  const rows = Array.from({ length: 1000 }, (_, index) => historyRow(1, 0.01, 0.02, { base: `COIN${index}`, longKey: `a:C${index}`, shortKey: `b:C${index}` }));
  history.ingest(NOW, rows, NOW);
  history.ingest(NOW + 60_000, [historyRow(1, 0.01, 0.02, { base: 'EXTRA', longKey: 'a:EXTRA', shortKey: 'b:EXTRA' })], NOW + 60_000);
  assert.equal(history.metrics().trackedPairs, 1000);
  assert.equal(history.get('EXTRA', 'a:EXTRA', 'b:EXTRA', NOW + 60_000).spread.samples, 1);
  assert.equal(history.get('COIN0', 'a:C0', 'b:C0', NOW + 60_000).spread.samples, 0);
});

test('quality samples survive restart, prune beyond a day and retain corrupt buckets as gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perpetual-quality-'));
  let store, db;
  try {
    const filename = join(directory, 'quotes.sqlite');
    store = await openPerpetualStore(filename);
    for (let index = 1440; index >= 0; index--) store.saveQualitySample(NOW - index * 60_000, [historyRow(0.5)]);
    store.saveQualitySample(NOW, [historyRow(999)]);
    store.close(); store = undefined;
    db = new DatabaseSync(filename);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM quality_samples').get().count, 1440);
    db.prepare('UPDATE quality_samples SET payload=? WHERE bucket=?').run(Buffer.from('corrupt'), NOW - 60_000);
    db.close(); db = undefined;
    store = await openPerpetualStore(filename);
    const history = createQualityHistory();
    let buckets = 0;
    for (const sample of store.loadQualitySamples(NOW)) { buckets++; history.ingest(sample.bucket, sample.rows, NOW); }
    assert.equal(buckets, 1439);
    const values = readPair(history);
    assert.equal(values.spread.samples, 59);
    assert.equal(values.spread.mean, 0.5, 'A duplicate write cannot replace the original observed minute');
    assert.equal(values.funding.samples, 288);
    assert.deepEqual([...store.loadQualitySamples(NOW + QUALITY_FUNDING_WINDOW_MS)], []);
  } finally {
    db?.close(); store?.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'perpetual-quality-'));
    await rm(directory, { recursive: true, force: true });
  }
});

const CONVERGENCE_END = Math.floor(NOW / (8 * 3_600_000)) * 8 * 3_600_000;
function convergenceHistory(end = CONVERGENCE_END, { skip = new Set(), constant = false } = {}) {
  const history = createQualityHistory();
  for (let index = 287; index >= 0; index--) {
    const at = end - index * 300_000;
    if (skip.has(at)) continue;
    const spread = !constant && at % 3_600_000 === 1_800_000 ? 0.4 : 1;
    history.ingest(at, [historyRow(spread)], end);
  }
  return history;
}

test('quoted narrowing uses disjoint complete UTC windows rather than every overlapping starting point', () => {
  const history = convergenceHistory();
  const evidence = readPair(history, CONVERGENCE_END).convergence;
  assert.equal(evidence.samples, 288);
  assert.equal(evidence.method, 'non-overlapping-quoted-halving-v1');
  for (const [index, expected] of [[0, 23], [1, 5], [2, 2]]) {
    const item = evidence.horizons[index];
    assert.equal(item.completed, expected);
    assert.equal(item.successful, expected);
    assert.equal(item.pending, 1);
    assert.equal(item.incomplete, 0);
    assert.equal(item.successRatio, 1);
    assert.equal(item.medianMinutesToTarget, 30);
    assert.equal(item.maxAdverseExpansionPercent, 0);
  }
});

test('a missing five-minute quote invalidates its whole window and is never silently interpolated', () => {
  const history = convergenceHistory(CONVERGENCE_END, { skip: new Set([CONVERGENCE_END - 15 * 60_000]) });
  const evidence = readPair(history, CONVERGENCE_END).convergence;
  for (const [index, expected] of [[0, 22], [1, 4], [2, 1]]) {
    const item = evidence.horizons[index];
    assert.equal(item.completed, expected);
    assert.equal(item.successful, expected, 'The earlier target hit cannot rescue an incomplete window');
    assert.equal(item.incomplete, 1);
  }
});

test('early narrowing in an unfinished window remains pending until the full horizon has elapsed', () => {
  const history = createQualityHistory(), start = CONVERGENCE_END;
  for (let index = 0; index <= 12; index++) history.ingest(start + index * 300_000, [historyRow(index === 0 ? 1 : 0.4)], start + 3_600_000);
  const open = readPair(history, start + 30 * 60_000).convergence.horizons[0];
  assert.equal(open.pending, 1);
  assert.equal(open.completed, 0);
  assert.equal(open.successful, 0);
  assert.equal(open.successRatio, null);
  const closed = readPair(history, start + 3_600_000).convergence.horizons[0];
  assert.equal(closed.completed, 1);
  assert.equal(closed.successful, 1);
  assert.equal(closed.medianMinutesToTarget, 5);
});

test('a missing window boundary is reported as a gap on both adjacent observed windows', () => {
  const history = convergenceHistory(CONVERGENCE_END, { skip: new Set([CONVERGENCE_END - 4 * 3_600_000]) });
  const evidence = readPair(history, CONVERGENCE_END).convergence;
  for (const [index, expected, gaps] of [[0, 21, 2], [1, 3, 2], [2, 1, 1]]) {
    assert.equal(evidence.horizons[index].completed, expected);
    assert.equal(evidence.horizons[index].incomplete, gaps);
  }
});

test('narrowing records adverse expansion in percentage points and ignores negative or tiny initial edges', () => {
  for (const initial of [-1, 0, 0.049, 1]) {
    const history = createQualityHistory(), start = CONVERGENCE_END;
    for (let index = 0; index <= 12; index++) history.ingest(start + index * 300_000, [historyRow(index === 0 ? initial : index < 6 ? 1.4 : 0.4)], start + 3_600_000);
    const item = readPair(history, start + 3_600_000).convergence.horizons[0];
    assert.equal(item.completed, initial === 1 ? 1 : 0);
    assert.equal(item.successful, initial === 1 ? 1 : 0);
    if (initial === 1) assert.ok(Math.abs(item.maxAdverseExpansionPercent - 0.4) < 1e-12);
    else assert.equal(item.maxAdverseExpansionPercent, null);
  }
});

test('a permanently positive stable quote gap does not masquerade as evidence of convergence', () => {
  const row = pair(), data = report(row);
  data.pairs[qualityPairKey(row)].convergence = readPair(convergenceHistory(NOW, { constant: true })).convergence;
  const result = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(result, 'spread'), 100);
  assert.equal(dimension(result, 'convergence'), 0);
  assert.equal(result.profiles.persistence.status, 'positive');
  assert.equal(result.profiles.convergence.status, 'negative');
  assert.notEqual(result.grade, 'strong');
});

test('small, sparse, expired or missing convergence studies cannot establish an aggregate quality grade', () => {
  for (const edit of [
    data => { delete data.convergence; },
    data => { data.convergence.samples = 144; },
    data => { data.convergence.lastAt = NOW - 600_001; },
    data => { data.convergence.horizons[0].completed = 5; },
    data => { data.convergence.horizons[0].incomplete = 8; },
  ]) {
    const row = pair(), data = report(row);
    edit(data.pairs[qualityPairKey(row)]);
    const result = evaluateOpportunityQuality(row, data, NOW);
    assert.equal(dimension(result, 'convergence'), null);
    assert.equal(result.profiles.convergence.status, 'insufficient');
    assert.equal(result.score, null);
    assert.equal(result.grade, 'insufficient');
    assert.equal(result.coverage, 60, 'Other evidence remains visible even when the convergence study is unavailable');
  }
});

test('stable historical funding expenses and currently reversed carry cannot receive the strongest grade', () => {
  const row = pair(), data = report(row);
  Object.assign(data.pairs[qualityPairKey(row)].funding, { mean: -0.01, positiveRatio: 0 });
  const expense = evaluateOpportunityQuality(row, data, NOW);
  assert.equal(dimension(expense, 'funding'), 0);
  assert.equal(expense.profiles.funding.status, 'negative');
  assert.notEqual(expense.grade, 'strong');
  const reversed = pair({ long: quote('binance', { fundingRate: 0.0003 }), short: quote('gate', { fundingRate: 0 }) });
  const currentExpense = evaluateOpportunityQuality(reversed, report(reversed), NOW);
  assert.equal(currentExpense.profiles.funding.label, '历史收入／当前支出');
  assert.notEqual(currentExpense.grade, 'strong');
});

test('narrowing rings expire without new ingestion and preserve bounded legacy seven-field storage', () => {
  const history = convergenceHistory();
  assert.equal(history.metrics().convergencePoints, 288);
  const expired = readPair(history, CONVERGENCE_END + QUALITY_FUNDING_WINDOW_MS).convergence;
  assert.equal(expired.samples, 0);
  assert.equal(expired.lastAt, null);
  assert.ok(expired.horizons.every(item => item.completed === 0 && item.successful === 0));
  const live = createQualityHistory();
  const sample = live.sample(livePair(NOW), NOW);
  assert.equal(sample.rows[0].length, 7, 'The new in-memory study does not add disk fields or extra writes');
  const restored = createQualityHistory();
  restored.ingest(sample.bucket, sample.rows, NOW);
  assert.deepEqual(readPair(restored).convergence, readPair(live).convergence);
});

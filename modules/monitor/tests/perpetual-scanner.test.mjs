import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCANNER_COLUMNS, SCANNER_CATEGORIES, defaultScannerPreferences, parseScannerPreferences,
  groupScannerRows, fundingStabilityView, formatRunDuration, formatBreakEvenHours, parseScannerPrincipal, normalizeScannerPrincipal, DEFAULT_SCANNER_PRINCIPAL,
  scannerQuoteCategory, scannerPairCategory, annualizedFundingPercent,
} from '../lib/perpetual-scanner.ts';
import { createPerpetualSnapshotAccumulator } from '../lib/perpetual-feed.ts';
import { createPerpetualPatch, createPerpetualDelta } from '../server/perpetual-service.mjs';

test('scanner defaults expose sixteen reference columns, all asset categories and grouping by asset', () => {
  assert.deepEqual(defaultScannerPreferences.columns, ['type', 'pair', 'funding', 'fundingSpread', 'fundingStability', 'annualized', 'volume', 'openInterest', 'quote', 'spread', 'capital', 'roc', 'breakEven', 'history24h', 'history7d', 'history30d']);
  assert.equal(defaultScannerPreferences.groupByBase, true);
  assert.deepEqual(SCANNER_COLUMNS.filter(column => !column.defaultVisible).map(column => column.id), ['time', 'quality']);
  assert.deepEqual(defaultScannerPreferences.categories, ['crypto', 'equity', 'commodity', 'forex', 'index', 'unknown']);
  assert.ok([...SCANNER_COLUMNS, ...SCANNER_CATEGORIES].every(item => item.label.length > 0));
});

test('scanner preference parsing removes unknown values and duplicates while preserving empty selections', () => {
  assert.deepEqual(parseScannerPreferences(JSON.stringify({ columns: ['quote', 'quote', 'future-column', null, 'spread', 3], categories: ['crypto', 'unknown', 'crypto', 'rwa', {}] })), {
    version: 3, columns: ['quote', 'spread', 'capital', 'roc', 'fundingStability', 'breakEven'], categories: ['crypto', 'unknown'], groupByBase: true,
  });
  assert.deepEqual(parseScannerPreferences('{"columns":[],"categories":[]}'), { version: 3, columns: [], categories: [], groupByBase: true });
  assert.deepEqual(parseScannerPreferences('{"columns":["future"],"categories":["future"]}'), { version: 3, columns: [], categories: [], groupByBase: true });
  assert.deepEqual(parseScannerPreferences('{"columns":[],"categories":false}'), { version: 3, columns: [], categories: defaultScannerPreferences.categories, groupByBase: true });
  assert.deepEqual(parseScannerPreferences('{"columns":null,"categories":["equity"]}'), { version: 3, columns: defaultScannerPreferences.columns, categories: ['equity'], groupByBase: true });
  assert.deepEqual(parseScannerPreferences('{"version":3,"columns":["quote","spread"],"categories":["crypto"],"groupByBase":false}'), { version: 3, columns: ['quote', 'spread'], categories: ['crypto'], groupByBase: false });
  assert.deepEqual(parseScannerPreferences('{"version":3,"columns":["quote"],"categories":["crypto"],"groupByBase":"no"}').groupByBase, true);
  // Version 2 users keep hidden columns hidden and gain the two new metrics.
  assert.deepEqual(parseScannerPreferences('{"version":2,"columns":["quote","spread"],"categories":["crypto"]}'), { version: 3, columns: ['quote', 'spread', 'fundingStability', 'breakEven'], categories: ['crypto'], groupByBase: true });
  assert.deepEqual(parseScannerPreferences('{"version":2,"columns":["quote","breakEven"],"categories":["crypto"]}').columns, ['quote', 'breakEven', 'fundingStability']);
  assert.deepEqual(parseScannerPreferences('{"version":1,"columns":["quote","spread"],"categories":["crypto"]}'), { version: 3, columns: ['quote', 'spread', 'capital', 'roc', 'fundingStability', 'breakEven'], categories: ['crypto'], groupByBase: true });
});

test('grouping keeps ranking order: the lead is each asset\'s first row and the rest stay in order', () => {
  const rows = [{ base: 'BTC', id: 1 }, { base: 'ETH', id: 2 }, { base: 'BTC', id: 3 }, { base: 'SOL', id: 4 }, { base: 'BTC', id: 5 }, { base: 'ETH', id: 6 }];
  const groups = groupScannerRows(rows);
  assert.deepEqual(groups.map(group => [group.base, group.lead.id, group.others.map(row => row.id)]), [['BTC', 1, [3, 5]], ['ETH', 2, [6]], ['SOL', 4, []]]);
  assert.deepEqual(groupScannerRows([]), []);
});

test('funding stability needs fresh real samples and keeps older reports without peak or run fields', () => {
  const now = 1_800_000_000_000;
  const funding = { samples: 12, coverage: 12 / 288, lastAt: now - 600_000, mean: 0.02, max: 0.05, positiveRunMs: 3_600_000, positiveRunCapped: true };
  assert.deepEqual(fundingStabilityView(funding, now), { mean: 0.02, max: 0.05, positiveRunMs: 3_600_000, positiveRunCapped: true, samples: 12, coverage: 12 / 288 });
  assert.equal(fundingStabilityView({ ...funding, samples: 11 }, now), null);
  assert.equal(fundingStabilityView({ ...funding, lastAt: now - 600_001 }, now), null);
  assert.equal(fundingStabilityView({ ...funding, lastAt: now + 5_001 }, now), null);
  assert.equal(fundingStabilityView({ ...funding, mean: null }, now), null);
  assert.equal(fundingStabilityView(undefined, now), null);
  const legacy = fundingStabilityView({ samples: 20, coverage: .1, lastAt: now, mean: -0.01 }, now);
  assert.deepEqual([legacy.max, legacy.positiveRunMs, legacy.positiveRunCapped], [null, null, false]);
  // A zero-length run is "currently not positive", never a capped run.
  assert.equal(fundingStabilityView({ ...funding, positiveRunMs: 0 }, now).positiveRunCapped, false);
});

test('run and break-even durations are compact and bounded', () => {
  assert.equal(formatRunDuration(300_000), '5 分钟');
  assert.equal(formatRunDuration(3_599_999), '59 分钟');
  assert.equal(formatRunDuration(3_600_000), '1h');
  assert.equal(formatRunDuration(47.9 * 3_600_000), '47h');
  assert.equal(formatRunDuration(48 * 3_600_000), '2 天');
  assert.equal(formatBreakEvenHours(0.5), '<1h');
  assert.equal(formatBreakEvenHours(4.25), '4.3h');
  assert.equal(formatBreakEvenHours(14.4), '14h');
  assert.equal(formatBreakEvenHours(60), '2.5 天');
  assert.equal(formatBreakEvenHours(300), '13 天');
  assert.equal(formatBreakEvenHours(721), '>30 天');
});

test('principal storage is clamped and falls back to the default', () => {
  assert.equal(parseScannerPrincipal(JSON.stringify({ version: 1, principal: 2500 })), 2500);
  for (const raw of [null, '', '{', '[]', '{"principal":"5000"}', '{"principal":null}']) assert.equal(parseScannerPrincipal(raw), DEFAULT_SCANNER_PRINCIPAL);
  assert.equal(normalizeScannerPrincipal(0), 1);
  assert.equal(normalizeScannerPrincipal(1e9), 10_000_000);
  assert.equal(normalizeScannerPrincipal(Number.NaN), DEFAULT_SCANNER_PRINCIPAL);
});

test('invalid or absent scanner preferences use independent default arrays', () => {
  for (const raw of [null, '', '{', 'null', '[]', 'true', '42', '"columns"', '{}']) assert.deepEqual(parseScannerPreferences(raw), defaultScannerPreferences);
  const saved = parseScannerPreferences(null);
  saved.columns.length = 0; saved.categories.length = 0;
  assert.equal(parseScannerPreferences(null).columns.length, 16);
  assert.equal(parseScannerPreferences(null).categories.length, 6);
});

test('crypto classification requires explicit category evidence and never guesses from ticker or pair eligibility', () => {
  const quote = { base: 'BTC', symbol: 'BTCUSDT', comparable: true, assetClass: 'crypto', identitySource: 'official market directory' };
  for (const identityVerified of [undefined, null, false, 'true', 1]) assert.equal(scannerQuoteCategory({ ...quote, identityVerified }), 'unknown');
  assert.equal(scannerQuoteCategory({ ...quote, identityVerified: true }), 'crypto');
  assert.equal(scannerQuoteCategory({ ...quote, comparable: false, identityVerified: true }), 'crypto', 'A display category cannot grant comparison eligibility');
  for (const identitySource of [undefined, null, '', '  ']) assert.equal(scannerQuoteCategory({ ...quote, identitySource, identityVerified: true }), 'unknown');
  assert.equal(scannerQuoteCategory({ ...quote, assetClass: undefined, identityVerified: true }), 'unknown');
  for (const base of ['BTC', 'ETH', 'XAU', 'AAPL', 'EURUSD', 'SPX', 'EQUITY:AAPL']) assert.equal(scannerQuoteCategory({ base, symbol: base, identityVerified: true }), 'unknown');
});

test('explicit official category aliases map conservatively without interpreting generic RWA or ETF labels', () => {
  const groups = {
    equity: ['equity', 'stock', 'stocks'], commodity: ['commodity', 'commodities', 'metals'],
    forex: ['forex'], index: ['index', 'indices'],
  };
  for (const [expected, categories] of Object.entries(groups)) for (const assetClass of categories) {
    assert.equal(scannerQuoteCategory({ assetClass, identitySource: 'official directory', identityVerified: false }), expected, 'The existing crypto-only verification flag does not deny explicit non-crypto classification');
    assert.equal(scannerQuoteCategory({ assetClass }), 'unknown');
  }
  assert.equal(scannerQuoteCategory({ assetClass: ' STOCK ', identitySource: 'official directory' }), 'equity');
  for (const assetClass of ['rwa', 'etf', 'pre-market', 'pre-ipo', 'category-3', 'unverified', 'unknown', '', null]) {
    assert.equal(scannerQuoteCategory({ assetClass, identitySource: 'official directory', identityVerified: true }), 'unknown');
  }
});

test('pair category requires both legs to agree on an evidenced category', () => {
  const crypto = { assetClass: 'crypto', identitySource: 'official directory', identityVerified: true };
  const equity = { assetClass: 'stock', identitySource: 'official directory' };
  assert.equal(scannerPairCategory({ long: crypto, short: { ...crypto } }), 'crypto');
  assert.equal(scannerPairCategory({ long: equity, short: { ...equity, assetClass: 'equity' } }), 'equity');
  assert.equal(scannerPairCategory({ long: crypto, short: equity }), 'unknown');
  assert.equal(scannerPairCategory({ long: crypto, short: { ...crypto, identityVerified: false } }), 'unknown');
  assert.equal(scannerPairCategory({ long: {}, short: {} }), 'unknown');
});

test('annualized carry is signed simple eight-hour extrapolation and rejects missing, non-finite or overflowing rates', () => {
  assert.equal(annualizedFundingPercent(0), 0);
  assert.ok(Math.abs(annualizedFundingPercent(0.0001) - 10.95) < 1e-12);
  assert.ok(Math.abs(annualizedFundingPercent(-0.0001) + 10.95) < 1e-12);
  for (const value of [null, NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) assert.equal(annualizedFundingPercent(value), null);
});

test('classification-only patches and deltas update browser categories without confirming prices', () => {
  const quote = {
    exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1,
    bid: 100, ask: 101, mark: 100.5, last: 100, fundingRate: 0.001, fundingIntervalHours: 8, nextFundingAt: null,
    receivedAt: 1000, sourceTime: 1000, bidAskAt: 1000, markAt: 1000, fundingAt: 1000, transport: 'ws', comparable: false,
  };
  const snapshot = { schemaVersion: 1, monitorId: 'perpetual', status: 'snapshot', generatedAt: 32000, staleAfterMs: 30000, streamId: 'scanner-test', sequence: 1, exchanges: [], quotes: [quote] };
  const accumulator = createPerpetualSnapshotAccumulator();
  accumulator(snapshot);
  const baseline = new Map([['test:BTCUSDT', quote]]), deltaBaseline = new Map(baseline);
  const verified = { ...quote, assetClass: 'crypto', identitySource: 'official directory', identityVerified: true };
  const patch = createPerpetualPatch({ ...snapshot, sequence: 2, quotes: [verified] }, baseline);
  assert.deepEqual(patch.patches, [['test:BTCUSDT', { assetClass: 'crypto', identitySource: 'official directory', identityVerified: true, receivedAt: 1000 }]]);
  const rendered = accumulator({ ...patch, baseSequence: 1 }).quotes[0];
  assert.equal(scannerQuoteCategory(rendered), 'crypto');
  for (const field of ['base', 'comparable', 'bid', 'ask', 'bidAskAt', 'markAt', 'fundingAt', 'receivedAt', 'sourceTime']) assert.equal(rendered[field], quote[field]);
  assert.deepEqual(createPerpetualDelta({ ...snapshot, quotes: [verified] }, deltaBaseline).updates, [verified]);

  const cleared = { ...verified, assetClass: null, identitySource: null, identityVerified: null };
  const removal = createPerpetualPatch({ ...snapshot, sequence: 3, quotes: [cleared] }, baseline);
  assert.deepEqual(removal.patches[0][1], { assetClass: null, identitySource: null, identityVerified: null, receivedAt: 1000 });
  assert.equal(scannerQuoteCategory(accumulator({ ...removal, baseSequence: 2 }).quotes[0]), 'unknown');
  assert.deepEqual(createPerpetualPatch({ ...snapshot, quotes: [cleared] }, baseline).patches, [], 'A cleared category must not be sent again on every tick');
});

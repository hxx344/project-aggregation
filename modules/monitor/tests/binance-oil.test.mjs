import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { validateMarket, calculateShortSpreadFunding, marketFromExchangeQuote } from '../modules/oil/binance.mjs';
import { HOUR, FUNDING_MS, FIRST_SETTLEMENT, createFundingSnapshot, validateFundingSnapshot, pairFundingHistory, analyzeFundingWindow, fetchFundingHistory, fetchFundingSnapshot } from '../modules/oil/binance-funding-history.mjs';
import { binanceOilExchangeQuote, calculateExchangeSpread, validateComparisonQuote, oilExchangeQuote } from '../lib/exchange-quotes.ts';
import { openMarketStore } from '../server/market-store.mjs';
import { seedMarketDatabase } from '../server/market-collector.mjs';
import { activateBinanceSource, emptyStore } from '../server/oil/store.mjs';

const archived = JSON.parse(await readFile(new URL('../public/oil/data/binance-funding-2026.json', import.meta.url), 'utf8'));
const legacyQuote = JSON.parse(await readFile(new URL('../public/oil/data/hyperliquid-2026.json', import.meta.url), 'utf8')).market;
const at = '2026-09-15T16:00:00Z';
const market = (left = {}, right = {}) => ({ source: 'Binance', currency: 'USDT', fetchedAt: at,
  brent: { coin: 'BZUSDT', markPx: 100, fundingRate: 0.004, fundingIntervalHours: 4, nextFundingAt: '2026-09-15T20:00:00Z', ...left },
  wti: { coin: 'CLUSDT', markPx: 80, fundingRate: 0.002, fundingIntervalHours: 4, nextFundingAt: '2026-09-15T20:00:00Z', ...right },
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const settlement = (symbol, time, rate) => ({ symbol, fundingTime: time + 2, fundingRate: String(rate), markPrice: '100', rateType: 'Regular' });

test('current Binance funding uses actual leg periods and mark notionals, and matches exchange comparison', () => {
  const quote = market(), result = calculateShortSpreadFunding(quote);
  near(result.hourlyCashflow, 100 * 0.004 / 4 - 80 * 0.002 / 4);
  near(result.hourlyRate, 0.06 / 180);
  near(result.annualizedRate, (0.06 / 180) * 8760);
  near(calculateShortSpreadFunding(quote, 'notional').hourlyRate, (0.004 / 4 - 0.002 / 4) / 2);
  near(calculateShortSpreadFunding(market({}, {fundingIntervalHours: 8})).hourlyCashflow, 0.08);
  const comparison = binanceOilExchangeQuote(quote);
  assert.equal(comparison.exchange, 'binance'); assert.equal(comparison.currency, 'USDT');
  near(calculateExchangeSpread(comparison).shortAnnualized, result.annualizedRate);
  assert.deepEqual(marketFromExchangeQuote(comparison), validateMarket(quote));
});

test('missing current funding preserves prices with null estimates, while actual zero stays zero', () => {
  const quote = market({fundingRate: null, fundingIntervalHours: null, nextFundingAt: null});
  assert.equal(validateMarket(quote).brent.markPx, 100);
  assert.equal(calculateShortSpreadFunding(quote).hourlyRate, null);
  assert.equal(calculateShortSpreadFunding(market({fundingRate: 0}, {fundingRate: 0})).hourlyRate, 0);
  assert.equal(binanceOilExchangeQuote(quote).fundingFetchedAt, at);
  const unavailable = {fundingRate: null, fundingIntervalHours: null, nextFundingAt: null};
  assert.equal(binanceOilExchangeQuote(market(unavailable, unavailable)).fundingFetchedAt, null);
  const partial = validateComparisonQuote(binanceOilExchangeQuote(market({fundingRate: null, fundingIntervalHours: null, nextFundingAt: null})), 'binance', 'oil');
  assert.equal(partial.left.fundingRate, null); assert.equal(partial.right.fundingRate, 0.002);
  assert.equal(calculateExchangeSpread(partial).shortAnnualized, null);
  for (const patch of [{fundingIntervalHours: 0}, {fundingRate: 0.1, fundingIntervalHours: null}, {coin: 'xyz:BRENTOIL'}, {markPx: ''}]) assert.throws(() => validateMarket(market(patch)));
  assert.throws(() => validateMarket(legacyQuote));
});

test('archive has actual paired four-hour settlements and annualization does not multiply rates by four', () => {
  const snapshot = validateFundingSnapshot(archived), rows = snapshot.data;
  assert.equal(rows[0].time, FIRST_SETTLEMENT); assert.ok(rows.length >= 1000);
  const gaps = rows.slice(1).flatMap((row, index) => Array.from({ length: (row.time - rows[index].time) / FUNDING_MS - 1 }, (_, i) => rows[index].time + (i + 1) * FUNDING_MS));
  // Both public source histories omit this settlement; preserve the gap rather than inventing zero.
  assert.deepEqual(gaps, [Date.UTC(2026, 5, 24, 4)]);
  const result = analyzeFundingWindow(rows, rows[0].time, rows.at(-1).time + 900_000);
  const total = rows.reduce((sum, row) => sum + (row.brent - row.wti) / 2, 0);
  near(result.shortCumulative, total);
  near(result.shortAnnualized, total / (rows.length * 4) * 8760);
  assert.equal(result.missingSettlements, 1);
  assert.equal(result.expectedSettlements, rows.length + 1);
});

test('funding pairing keeps absent legs missing, tolerates millisecond settlement delays, and rejects different schedules', () => {
  const rows = pairFundingHistory([settlement('BZUSDT', FIRST_SETTLEMENT, 0), settlement('BZUSDT', FIRST_SETTLEMENT + FUNDING_MS, 0.004)], [settlement('CLUSDT', FIRST_SETTLEMENT, 0)], FIRST_SETTLEMENT + 2 * FUNDING_MS);
  assert.deepEqual(rows, [{ time: FIRST_SETTLEMENT, brent: 0, wti: 0 }, {time: FIRST_SETTLEMENT + FUNDING_MS, brent: 0.004, wti: null}]);
  for (const row of [settlement('BTCUSDT', FIRST_SETTLEMENT, 0), settlement('BZUSDT', FIRST_SETTLEMENT + HOUR, 0), {...settlement('BZUSDT', FIRST_SETTLEMENT, 0), rateType: 'Special'}]) assert.throws(() => pairFundingHistory([row], [settlement('CLUSDT', FIRST_SETTLEMENT, 0)], FIRST_SETTLEMENT + FUNDING_MS));
  assert.throws(() => pairFundingHistory([settlement('BZUSDT', FIRST_SETTLEMENT, 0), settlement('BZUSDT', FIRST_SETTLEMENT, 0)], [], FIRST_SETTLEMENT + FUNDING_MS));
});

test('partial windows include each real settlement once; missing, unobserved and genuine zero differ', () => {
  const rows = Array.from({length: 7}, (_, i) => ({ time: FIRST_SETTLEMENT + i * FUNDING_MS, brent: i === 2 ? null : 0.004, wti: 0.002 }));
  const selected = analyzeFundingWindow(rows, FIRST_SETTLEMENT + 900_000, FIRST_SETTLEMENT + 6 * FUNDING_MS);
  assert.equal(selected.expectedSettlements, 5); assert.equal(selected.count, 4); assert.equal(selected.missingSettlements, 1);
  near(selected.shortCumulative, 0.004); near(selected.shortAnnualized, 0.001 / 4 * 8760);
  const absent = analyzeFundingWindow(rows, FIRST_SETTLEMENT + 900_000, FIRST_SETTLEMENT + HOUR);
  assert.equal(absent.expectedSettlements, 0); assert.equal(absent.shortCumulative, null);
  const zero = analyzeFundingWindow([{time: FIRST_SETTLEMENT, brent: 0, wti: 0}], FIRST_SETTLEMENT, FIRST_SETTLEMENT + 900_000);
  assert.equal(zero.shortCumulative, 0); assert.equal(zero.shortAnnualized, 0);
});

test('funding pages advance past exact source timestamps and old gaps are repaired atomically', async () => {
  const now = FIRST_SETTLEMENT + 20 * FUNDING_MS, requests = [];
  const all = Array.from({length: 20}, (_, i) => settlement('BZUSDT', FIRST_SETTLEMENT + i * FUNDING_MS, 0.004));
  const records = await fetchFundingHistory('BZUSDT', FIRST_SETTLEMENT, now, {pageSize: 3, fetcher: async url => {
    const params = new URL(url).searchParams, start = Number(params.get('startTime')); requests.push(start);
    return Response.json(all.filter(row => row.fundingTime >= start).slice(0, 3));
  }});
  assert.equal(records.length, 20); assert.equal(requests[1], all[2].fundingTime + 1);
  const existing = createFundingSnapshot(all.map((r, i) => ({time: FIRST_SETTLEMENT + i * FUNDING_MS, brent: i === 2 ? null : 0.004, wti: 0.002})).filter((_, i) => i !== 1), new Date(now).toISOString());
  const before = JSON.stringify(existing), starts = [];
  const repaired = await fetchFundingSnapshot(existing, {now, fetcher: async url => {
    const params = new URL(url).searchParams; starts.push(Number(params.get('startTime')));
    return Response.json([1, 2].map(i => settlement(params.get('symbol'), FIRST_SETTLEMENT + i * FUNDING_MS, params.get('symbol') === 'BZUSDT' ? 0.004 : 0.002)));
  }});
  assert.ok(starts.every(start => start === FIRST_SETTLEMENT + FUNDING_MS));
  assert.equal(repaired.metadata.pairedObservationRows, 20); assert.equal(JSON.stringify(existing), before);
  await assert.rejects(fetchFundingSnapshot(existing, {now, fetcher: async () => new Response('', {status: 503})}));
  assert.equal(JSON.stringify(existing), before);
});

test('source namespaces preserve every old Hyperliquid record without exposing it as Binance after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'binance-migration-')), filename = join(dir, 'market.sqlite');
  let store;
  try {
    store = await openMarketStore(filename); store.close();
    const db = new DatabaseSync(filename), old = JSON.stringify(legacyQuote), time = Date.parse(legacyQuote.fetchedAt);
    db.prepare('INSERT INTO market_datasets(key,payload,source_ms) VALUES (?,?,?)').run('oil/quote', old, time);
    db.prepare('INSERT INTO market_observations(dataset,time,payload,source_ms) VALUES (?,?,?,?)').run('oil/quote', time, old, time);
    db.close();
    store = await openMarketStore(filename); seedMarketDatabase(store);
    assert.equal(store.raw('oil', 'quote').source, 'Binance');
    assert.equal(store.raw('oil', 'candles/15m').metadata.source, 'Binance');
    assert.throws(() => store.write('oil', 'quote', legacyQuote));
    const before = store.raw('oil', 'quote'); store.close();
    store = await openMarketStore(filename); seedMarketDatabase(store);
    assert.deepEqual(store.raw('oil', 'quote'), before);
    const verify = new DatabaseSync(filename);
    assert.equal(verify.prepare('SELECT payload FROM market_datasets WHERE key=?').get('oil/quote').payload, old);
    assert.equal(verify.prepare('SELECT payload FROM market_observations WHERE dataset=?').get('oil/quote').payload, old);
    verify.close();
  } finally { store?.close(); await rm(dir, {recursive: true, force: true}); }
});

test('alert source switch preserves user thresholds and old events, resets old episodes exactly once', () => {
  const legacy = {...emptyStore(), marketSource: undefined, revision: 3, states: {'spread-1': {active: true, alerted: true}}, events: [{id: 'old', status: 'sent', rules: []}]};
  const migrated = activateBinanceSource(legacy);
  assert.equal(migrated.marketSource, 'binance'); assert.equal(migrated.revision, 4);
  assert.deepEqual(migrated.config, legacy.config); assert.deepEqual(migrated.states, {});
  assert.equal(migrated.events[0].source, 'hyperliquid'); assert.equal(migrated.events[0].id, 'old');
  assert.strictEqual(activateBinanceSource(migrated), migrated);
  assert.equal(legacy.states['spread-1'].alerted, true);
});

test('Hyperliquid remains an explicitly identified comparison and cannot enter the Binance primary path', () => {
  const comparison = oilExchangeQuote(legacyQuote);
  assert.equal(validateComparisonQuote(comparison, 'hyperliquid', 'oil').currency, 'USD');
  assert.throws(() => validateComparisonQuote({...comparison, currency: 'USDT'}, 'hyperliquid', 'oil'));
  assert.throws(() => marketFromExchangeQuote(comparison));
});

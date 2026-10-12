import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRows, filterRows, summarize, monthlyAverages, chartDomain } from '../modules/oil/data-utils.mjs';
import { ASSETS, DAY, YEAR_START, parseMarketResponse, pairDailyCandles, calculateShortSpreadFunding, requestInfo, fetchSnapshot } from '../modules/oil/hyperliquid.mjs';

const snapshot = JSON.parse(await readFile(new URL('../public/oil/data/hyperliquid-2026.json', import.meta.url), 'utf8'));
const rows = validateRows(snapshot.data.filter(row => row.brent !== null && row.wti !== null));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const candle = (coin, t, c) => ({ s: coin, i: '1d', t, T: t + DAY - 1, c: String(c) });
const market = (brentRate, wtiRate) => ({ brent: { coin: ASSETS.brent.coin, markPx: 110, oraclePx: 100, funding: brentRate }, wti: { coin: ASSETS.wti.coin, markPx: 95, oraclePx: 80, funding: wtiRate } });

test('snapshot is exclusively Hyperliquid data with explicit contract mapping and true coverage', () => {
  assert.equal(snapshot.metadata.source, 'Hyperliquid / XYZ');
  assert.equal(snapshot.market.wti.coin, 'xyz:CL');
  assert.equal(snapshot.market.brent.coin, 'xyz:BRENTOIL');
  assert.equal(rows[0].date, '2026-03-04');
  assert.equal(rows.at(-1).date, snapshot.metadata.lastCommonObservation);
  assert.equal(rows.length, snapshot.metadata.pairedObservationRows);
  for (const row of rows) {
    near(row.spread, (row.brent - row.wti) / row.wti * 100);
    assert.ok(Date.parse(row.date) + DAY <= Date.parse(snapshot.metadata.fetchedAt));
  }
  assert.equal(snapshot.data.some(row => row.date < '2026-03-04' && row.brent !== null), false);
});

test('pairing aligns actual timestamps and excludes the current incomplete day and absent leg', () => {
  const a = YEAR_START, b = a + DAY, c = b + DAY;
  const result = pairDailyCandles(
    [candle(ASSETS.brent.coin, c, 110), candle(ASSETS.brent.coin, b, 104), candle(ASSETS.brent.coin, a, 102)],
    [candle(ASSETS.wti.coin, a, 99), candle(ASSETS.wti.coin, c, 103)],
    c + DAY / 2
  );
  assert.deepEqual(result.data, [{ date: '2026-01-01', brent: 102, wti: 99 }, { date: '2026-01-02', brent: 104, wti: null }]);
  assert.equal(result.pairedObservationRows, 1);
  assert.equal(result.lastCommonObservation, '2026-01-01');
});

test('candle validation rejects a different market, interval, duplicate day and missing close', () => {
  const b = candle(ASSETS.brent.coin, YEAR_START, 102), w = candle(ASSETS.wti.coin, YEAR_START, 99);
  assert.throws(() => pairDailyCandles([{ ...b, s: 'xyz:WTIOIL' }], [w], YEAR_START + DAY));
  assert.throws(() => pairDailyCandles([{ ...b, i: '1h' }], [w], YEAR_START + DAY));
  assert.throws(() => pairDailyCandles([b, b], [w], YEAR_START + DAY));
  assert.throws(() => pairDailyCandles([{ ...b, c: '' }], [w], YEAR_START + DAY));
  assert.throws(() => pairDailyCandles([], [w], YEAR_START + DAY));
});

test('metadata mapping uses the named universe entry, not a fixed index or WTIOIL alias', () => {
  const data = [{ universe: [{ name: 'xyz:IGNORED' }, { name: ASSETS.wti.coin }, { name: ASSETS.brent.coin }] }, [{}, { markPx: '90.345', oraclePx: '91', funding: '-0.0001' }, { markPx: '95.123', oraclePx: '96', funding: '0.0002' }]];
  const parsed = parseMarketResponse(data, '2026-09-10T00:00:00Z');
  assert.equal(parsed.brent.markPx, 95.123);
  assert.equal(parsed.wti.markPx, 90.345);
  assert.equal(parsed.brent.funding, 0.0002);
  assert.equal(parsed.wti.funding, -0.0001);
  assert.throws(() => parseMarketResponse([{ universe: [{name:ASSETS.brent.coin}] }, [data[1][2]]]));
});

test('missing rates, prices, and delisted assets do not silently become zero', () => {
  const data = [{ universe: [{ name: ASSETS.brent.coin }, { name: ASSETS.wti.coin }] }, [{ markPx: '100', oraclePx: '100', funding: '0.001' }, { markPx: '80', oraclePx: '80', funding: '0.001' }]];
  for (const invalid of [null, '', ' ', 'NaN', undefined]) {
    const copy = structuredClone(data); copy[1][0].funding = invalid;
    assert.throws(() => parseMarketResponse(copy));
  }
  const zero = structuredClone(data); zero[1][0].oraclePx = '0';
  assert.throws(() => parseMarketResponse(zero));
  const delisted = structuredClone(data); delisted[0].universe[0].isDelisted = true;
  assert.throws(() => parseMarketResponse(delisted));
});

test('equal barrels: short Brent receives positive funding and long WTI pays', () => {
  const result = calculateShortSpreadFunding(market(0.001, 0.002), 'quantity');
  near(result.brentCashflow, 0.1);
  near(result.wtiCashflow, -0.16);
  near(result.hourlyCashflow, -0.06);
  near(result.grossNotional, 180);
  near(result.hourlyRate, -0.06 / 180);
  near(result.cashflowPer10k, -0.06 / 180 * 10_000);
  near(result.annualizedRate, -0.06 / 180 * 8760);
});

test('equal dollars uses oracle notionals and divides rate difference by TWO legs', () => {
  const result = calculateShortSpreadFunding(market(0.001, 0.002), 'notional');
  near(result.hourlyRate, -0.0005);
  near(result.singleLegRateDifference, -0.001);
  const m = market(0.001, 0.002); m.brent.markPx = 200; m.wti.markPx = 1;
  near(calculateShortSpreadFunding(m, 'notional').hourlyRate, result.hourlyRate);
  near(calculateShortSpreadFunding(m, 'quantity').hourlyRate, calculateShortSpreadFunding(market(0.001, 0.002), 'quantity').hourlyRate);
});

test('negative rates reverse each leg, with already-hourly API rates unscaled', () => {
  const result = calculateShortSpreadFunding(market(-0.0005, -0.0004), 'quantity');
  near(result.brentCashflow, -0.05);
  near(result.wtiCashflow, 0.032);
  near(result.hourlyCashflow, -0.018);
  near(result.brentRate, -0.0005);
  near(result.wtiRate, -0.0004);
  near(calculateShortSpreadFunding(market(-0.0004, -0.0005), 'quantity').hourlyRate, 0);
  near(calculateShortSpreadFunding(market(0, 0), 'quantity').hourlyRate, 0);
  assert.throws(() => calculateShortSpreadFunding(market(0, 0), 'margin'));
});

test('verified live market example reproduces source-independent funding arithmetic', () => {
  const sample = { brent: { oraclePx: 104.62, funding: -0.0005363387 }, wti: { oraclePx: 99.578, funding: -0.0004826865 } };
  const result = calculateShortSpreadFunding(sample, 'quantity');
  near(result.hourlyCashflow, -0.008046798497000004);
  near(result.hourlyRate, -0.00003940684285350503);
  near(calculateShortSpreadFunding(sample, 'notional').hourlyRate, -0.0000268261);
});

test('calendar ranges use the last completed candle and handle month-end clamping', () => {
  assert.equal(filterRows(rows, 'ytd'), rows);
  assert.equal(filterRows(rows, '1m').at(-1).date, rows.at(-1).date);
  const examples = ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-31'].map(date => ({ date }));
  assert.deepEqual(filterRows(examples, '1m').map(row => row.date), ['2026-02-28', '2026-03-01', '2026-03-31']);
});

test('monthly aggregation weights available observations and preserves sub-cent spread precision', () => {
  const months = monthlyAverages(rows);
  near(months.reduce((sum, month) => sum + month.average * month.count, 0) / rows.length, summarize(rows).average);
  assert.equal(months.reduce((sum, month) => sum + month.count, 0), rows.length);
  const one = validateRows([{ date: '2026-03-04', brent: 100.001, wti: 99.999 }]);
  near(one[0].spread, 0.002 / 99.999 * 100);
  assert.throws(() => validateRows([rows[0], rows[0]]));
  const domain = chartDomain([-1.245, 4.21]);
  assert.ok(domain.min < -1.245 && domain.max > 4.21);
});

test('API calls are read-only and surface transport errors without returning fake values', async () => {
  let request;
  const response = await requestInfo({ type: 'metaAndAssetCtxs', dex: 'xyz' }, { fetcher: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ result: 'ok' }) }; } });
  assert.deepEqual(response, { result: 'ok' });
  assert.equal(request.url, 'https://api.hyperliquid.xyz/info');
  assert.equal(request.options.credentials, 'omit');
  assert.deepEqual(JSON.parse(request.options.body), { type: 'metaAndAssetCtxs', dex: 'xyz' });
  await assert.rejects(() => requestInfo({}, { fetcher: async () => ({ ok: false, status: 500 }) }), /HTTP 500/);
});

test('current oil quotes publish before slow daily candles finish', async () => {
  const pending = new Map(), updates = [];
  let finished = false;
  const loading = fetchSnapshot({
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Promise(resolve => pending.set(body.type === 'metaAndAssetCtxs' ? 'market' : body.req.coin, resolve));
    },
    onMarket: value => updates.push(value),
  }).then(value => { finished = true; return value; });
  assert.equal(pending.size, 3);
  pending.get('market')(Response.json([{universe:[{name:ASSETS.brent.coin},{name:ASSETS.wti.coin}]}, [{markPx:'102',oraclePx:'102',funding:'0.0001'},{markPx:'99',oraclePx:'99',funding:'0'}]]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].brent.markPx, 102);
  assert.equal(finished, false);
  pending.get(ASSETS.brent.coin)(Response.json([candle(ASSETS.brent.coin, YEAR_START, 101)]));
  pending.get(ASSETS.wti.coin)(Response.json([candle(ASSETS.wti.coin, YEAR_START, 98)]));
  const snapshot = await loading;
  assert.equal(snapshot.market, updates[0]);
  assert.equal(snapshot.metadata.pairedObservationRows, 1);
});

test('a failed historical leg does not discard the separately delivered live oil quote', async () => {
  let failHistory;
  const updates = [];
  const loading = fetchSnapshot({
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.type === 'metaAndAssetCtxs') return Response.json([{universe:[{name:ASSETS.brent.coin},{name:ASSETS.wti.coin}]}, [{markPx:'102',oraclePx:'102',funding:'0'},{markPx:'99',oraclePx:'99',funding:'0'}]]);
      if (body.req.coin === ASSETS.brent.coin) return new Promise(resolve => { failHistory = resolve; });
      return Response.json([candle(ASSETS.wti.coin, YEAR_START, 98)]);
    },
    onMarket: value => updates.push(value),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.length, 1);
  failHistory(Response.json({}, {status:503}));
  await assert.rejects(loading, /HTTP 503/);
  assert.equal(updates[0].brent.markPx, 102);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { GOLD_OIL_INSTRUMENTS, GOLD_OIL_SYMBOLS, GOLD_OIL_INTERVAL_MS as STEP, GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, goldOilAction, parseGoldOilAction, validateGoldOilQuote, validateGoldOilHistory, goldOilChartPoints } from '../lib/gold-oil.ts';
import { parseGoldOilQuote, parseGoldOilHistory, validateGoldOilContracts, createGoldOilReader } from '../lib/gold-oil-service.ts';
import { parseGoldOilFunding, validateGoldOilFunding, currentGoldOilFunding, analyzeGoldOilFunding } from '../lib/gold-oil-funding.ts';
import { sampleGoldOilPoints } from '../lib/gold-oil-analysis.ts';
import { createDataReader } from '../lib/monitor-service.ts';

const now = Date.UTC(2026, 8, 30, 12), HOUR = 3_600_000;
const ticker = (symbol, markPrice, intervalHours = 8) => ({ symbol, markPrice: String(markPrice), time: now, lastFundingRate: symbol === 'XAUUSDT' ? '0.0016' : '0.0004', nextFundingTime: now + intervalHours * HOUR });
const candle = (time, price) => [time, String(price), String(price), String(price), String(price), '0', time + STEP - 1];
const event = (symbol, fundingTime, rate) => ({ symbol, fundingTime, fundingRate: String(rate), rateType: 'Regular' });
const fundingInfo = [{ symbol: 'CLUSDT', fundingIntervalHours: 4 }, { symbol: 'BZUSDT', fundingIntervalHours: 2 }, { symbol: 'XAUUSDT', fundingIntervalHours: 8 }];
const quote = (oilType = 'cl') => parseGoldOilQuote(ticker(GOLD_OIL_INSTRUMENTS[oilType].symbol, oilType === 'cl' ? 80 : 100, oilType === 'cl' ? 4 : 2), ticker('XAUUSDT', 4000), now, fundingInfo, oilType);
const history = (oilType = 'cl') => parseGoldOilHistory([candle(now - STEP, oilType === 'cl' ? 80 : 100)], [candle(now - STEP, 4000)], now, null, now - STEP, oilType);
const funding = (oilType = 'cl') => parseGoldOilFunding([event(GOLD_OIL_INSTRUMENTS[oilType].symbol, now - HOUR, 0.0004)], [event('XAUUSDT', now - HOUR + 1, 0.0016)], now - 24 * HOUR, now, now, null, oilType);
const legacy = input => {
  const value = structuredClone(input);
  delete value.oilType; delete value.oil;
  if (value.funding) delete value.funding.oil;
  for (const row of value.points ?? []) delete row.oil;
  return value;
};
const metadata = () => ({ symbols: ['CL', 'BZ', 'XAU'].map(baseAsset => ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', onboardDate: now - ({ CL: 2500, BZ: 1500, XAU: 2000 }[baseAsset]) * STEP })) });

test('oil actions are exact and retain the original CL endpoints', () => {
  assert.deepEqual(GOLD_OIL_SYMBOLS, { cl: 'CLUSDT', xau: 'XAUUSDT' });
  for (const action of ['quote', 'history', 'funding', 'status', 'config', 'events']) {
    assert.equal(goldOilAction(action), action);
    assert.deepEqual(parseGoldOilAction(goldOilAction(action, 'cl')), { oilType: 'cl', exchange: 'binance', action });
    assert.deepEqual(parseGoldOilAction(goldOilAction(action, 'bz')), { oilType: 'bz', exchange: 'binance', action });
  }
  for (const action of ['alerts', 'cl/quote', 'bz', 'bz/', 'BZ/quote', 'bz/bz/quote', 'bz/quote/extra', '/quote', 'bz/__proto__']) assert.equal(parseGoldOilAction(action), null);
});

test('validators normalize old CL input, recompute ratios, and reject wrong identities and aliases', () => {
  assert.deepEqual(validateGoldOilQuote(legacy(quote())), quote());
  assert.deepEqual(validateGoldOilHistory(legacy(history())), history());
  assert.deepEqual(validateGoldOilFunding(legacy(funding())), funding());
  for (const [make, validate] of [[quote, validateGoldOilQuote], [history, validateGoldOilHistory], [funding, validateGoldOilFunding]]) {
    const bz = make('bz');
    assert.deepEqual(validate(bz, 'bz'), bz);
    assert.throws(() => validate(bz), /variant/);
    assert.throws(() => validate(make(), 'bz'), /variant/);
    assert.throws(() => validate({ ...bz, oilType: undefined }, 'bz'), /variant/);
    assert.throws(() => validate({ ...make(), oilType: 'unknown' }), /variant/);
  }
  assert.equal(validateGoldOilQuote({ ...quote('bz'), ratio: 999 }, 'bz').ratio, 40);
  assert.equal(validateGoldOilHistory({ ...history('bz'), points: [{ ...history('bz').points[0], ratio: 999 }] }, 'bz').points[0].ratio, 40);
  assert.throws(() => validateGoldOilQuote({ ...quote('bz'), oil: quote().oil }, 'bz'), /contract/);
  assert.throws(() => validateGoldOilQuote({ ...quote(), cl: { ...quote().cl, price: 81 } }), /Conflicting/);
  assert.throws(() => validateGoldOilQuote({ ...quote(), funding: { ...quote().funding, cl: { ...quote().funding.cl, intervalHours: 8 } } }), /Conflicting/);
  for (const oilType of ['cl', 'bz']) {
    const q = quote(oilType), h = history(oilType), f = funding(oilType);
    assert.throws(() => validateGoldOilQuote({ ...q, cl: oilType === 'bz' ? q.oil : { ...q.oil, symbol: 'BZUSDT' } }, oilType), /Conflicting/);
    assert.throws(() => validateGoldOilHistory({ ...h, points: [{ ...h.points[0], cl: 123 }] }, oilType), /Conflicting/);
    assert.throws(() => validateGoldOilFunding({ ...f, points: [{ ...f.points[0], cl: 0.1 }, ...f.points.slice(1)] }, oilType), /Conflicting/);
  }
  const bz = quote('bz');
  assert.throws(() => validateGoldOilQuote({ ...bz, funding: { ...bz.funding, cl: bz.funding.oil } }, 'bz'), /Conflicting/);
  assert.equal(Object.hasOwn(bz, 'cl'), false); assert.equal(Object.hasOwn(bz.funding, 'cl'), false);
  assert.ok([...history('bz').points, ...funding('bz').points].every(row => !Object.hasOwn(row, 'cl')));
  assert.throws(() => validateGoldOilFunding({ ...funding('bz'), points: [] }), /variant/, 'Even empty funding must carry the matching oil identity');
});

test('BZ metadata validates the BZ base asset and both settlement currencies', () => {
  validateGoldOilContracts(metadata(), 'bz'); validateGoldOilContracts(metadata());
  const onlyBz = metadata(); onlyBz.symbols = onlyBz.symbols.filter(row => row.baseAsset !== 'CL');
  validateGoldOilContracts(onlyBz, 'bz'); assert.throws(() => validateGoldOilContracts(onlyBz));
  for (const [field, value] of [['baseAsset', 'CL'], ['quoteAsset', 'USDC'], ['marginAsset', 'USDC'], ['status', 'SETTLING'], ['contractType', 'CURRENT_QUARTER']]) {
    const input = metadata(); input.symbols[1][field] = value; assert.throws(() => validateGoldOilContracts(input, 'bz'));
  }
  const duplicate = metadata(); duplicate.symbols.push(duplicate.symbols[1]); assert.throws(() => validateGoldOilContracts(duplicate, 'bz'));
});

test('history and funding reject cross-oil previous payloads before merging', () => {
  for (const oilType of ['cl', 'bz']) {
    const other = oilType === 'cl' ? 'bz' : 'cl', symbol = GOLD_OIL_INSTRUMENTS[oilType].symbol;
    assert.throws(() => parseGoldOilHistory([candle(now - STEP, 100)], [candle(now - STEP, 4000)], now, history(other), now - STEP, oilType), /variant/);
    assert.throws(() => parseGoldOilFunding([event(symbol, now - HOUR, 0)], [], now - 24 * HOUR, now, now, funding(other), oilType), /variant/);
  }
  const updated = parseGoldOilFunding([event('CLUSDT', now - HOUR, 0.0008)], [], now - 24 * HOUR, now, now, legacy(funding()));
  assert.equal(updated.points[0].oil, 0.0008); assert.equal(updated.points[0].cl, 0.0008);
});

test('funding keeps the selected oil settlement interval and sums asynchronous actual events', () => {
  assert.equal(currentGoldOilFunding(quote()).hourlyRate, 0.00005);
  assert.equal(currentGoldOilFunding(quote('bz')).hourlyRate, 0);
  const start = now - 24 * HOUR;
  for (const oilType of ['cl', 'bz']) {
    const interval = oilType === 'cl' ? 4 : 2, count = 24 / interval - 1;
    const oil = Array.from({ length: count }, (_, index) => event(GOLD_OIL_INSTRUMENTS[oilType].symbol, start + (index + 1) * interval * HOUR + 1, 0.0004));
    const xau = [8, 16].map(hour => event('XAUUSDT', start + hour * HOUR + 2, 0.0016));
    const result = analyzeGoldOilFunding(parseGoldOilFunding(oil, xau, start, now, now, null, oilType), start, now);
    const expected = (2 * 0.0016 - count * 0.0004) / 2;
    assert.equal(result.oilCount, count); assert.equal(result.xauCount, 2);
    assert.ok(Math.abs(result.shortCumulative - expected) < 1e-12);
    assert.ok(Math.abs(result.shortAnnualized - expected / 24 * 8760) < 1e-12);
    assert.equal(Object.hasOwn(result, 'clCount'), oilType === 'cl');
    assert.throws(() => parseGoldOilFunding([event(oilType === 'cl' ? 'BZUSDT' : 'CLUSDT', start + HOUR, 0)], [], start, now, now, null, oilType), /event/);
  }
});

test('CL and BZ readers isolate requested symbols, listings, histories and funding caches', async () => {
  const logs = { cl: [], bz: [] }, readers = {};
  for (const oilType of ['cl', 'bz']) readers[oilType] = createGoldOilReader({ oilType, clock: () => now, fetcher: async input => {
    const url = new URL(input); logs[oilType].push(url);
    if (url.pathname.endsWith('exchangeInfo')) return Response.json(metadata());
    if (url.pathname.endsWith('fundingInfo')) return Response.json(fundingInfo);
    const symbol = url.searchParams.get('symbol'), price = { CLUSDT: 80, BZUSDT: 100, XAUUSDT: 4000 }[symbol];
    assert.ok(symbol === GOLD_OIL_INSTRUMENTS[oilType].symbol || symbol === 'XAUUSDT');
    if (url.pathname.endsWith('premiumIndex')) return Response.json(ticker(symbol, price));
    const start = Number(url.searchParams.get('startTime'));
    if (url.pathname.endsWith('fundingRate')) return Response.json([event(symbol, now - HOUR, 0.0001)]);
    assert.equal(url.pathname, '/fapi/v1/markPriceKlines'); assert.equal(url.searchParams.get('interval'), '15m');
    const count = Math.min(1000, (now - start) / STEP);
    return Response.json(Array.from({ length: count }, (_, index) => candle(start + index * STEP, price)));
  } });
  const [cl, bz] = await Promise.all(['cl', 'bz'].map(async oilType => {
    const reader = readers[oilType], [q, h, f] = await Promise.all([reader.quote(), reader.history(), reader.funding()]);
    return { q, h, f };
  }));
  assert.equal(cl.q.ratio, 50); assert.equal(bz.q.ratio, 40);
  assert.equal(cl.h.coverageStart, now - 2000 * STEP); assert.equal(bz.h.coverageStart, now - 1500 * STEP);
  assert.equal(cl.h.points.length, 2000); assert.equal(bz.h.points.length, 1500);
  assert.equal(cl.f.coverageStart, cl.h.coverageStart); assert.equal(bz.f.coverageStart, bz.h.coverageStart);
  for (const oilType of ['cl', 'bz']) {
    assert.equal(logs[oilType].filter(url => url.pathname.endsWith('exchangeInfo')).length, 1);
    logs[oilType].length = 0;
    const h = await readers[oilType].history(), f = await readers[oilType].funding();
    assert.equal(h.oilType, oilType); assert.equal(f.oilType, oilType);
    assert.equal(logs[oilType].filter(url => url.pathname.endsWith('markPriceKlines')).length, 2);
    assert.ok(logs[oilType].every(url => Number(url.searchParams.get('startTime')) >= now - 2 * 24 * HOUR));
    logs[oilType].length = 0;
    const other = oilType === 'cl' ? bz : cl;
    await assert.rejects(readers[oilType].history(other.h), /variant/);
    await assert.rejects(readers[oilType].funding(other.f), /variant/);
    assert.equal(logs[oilType].length, 0, 'Reject the foreign previous snapshot before reading or merging history');
  }
  logs.bz.length = 0;
  const gap = structuredClone(bz.h); gap.points.splice(20, 1); gap.points[10].oil = null; gap.points[10].ratio = null;
  const repaired = await readers.bz.history(gap);
  assert.equal(repaired.points.length, 1500); assert.equal(repaired.points[10].oil, 100);
  assert.equal(Number(logs.bz[0].searchParams.get('startTime')), gap.points[10].time);
  logs.bz.length = 0;
  const extended = await readers.bz.funding({ ...bz.f, coverageStart: now - 24 * HOUR });
  assert.equal(extended.coverageStart, bz.f.coverageStart);
  assert.equal(Number(logs.bz[0].searchParams.get('startTime')), bz.f.coverageStart, 'A partial funding snapshot must backfill from the later listing date');
});

test('BZ chart gaps and sampling preserve neutral oil values and extrema', () => {
  const bz = parseGoldOilHistory([candle(now - 3 * STEP, 100), candle(now - STEP, 100)], [candle(now - 3 * STEP, 4000), candle(now - STEP, 4000)], now, null, now - 3 * STEP, 'bz');
  const points = goldOilChartPoints(bz, 0);
  assert.deepEqual(points.map(row => row.oil), [100, null, 100]); assert.ok(points.every(row => !Object.hasOwn(row, 'cl')));
  const large = Array.from({ length: 4000 }, (_, index) => ({ time: index * STEP, oil: 100, xau: 4000, ratio: 40 }));
  large[103].oil = 200; large[402].oil = 50; large[999].oil = null;
  const sampled = sampleGoldOilPoints(large);
  assert.ok([103, 402, 998, 999, 1000].every(index => sampled.includes(large[index])));
});

test('preview CL and BZ caches have separate in-flight requests and matching data TTLs', async () => {
  let clock = 0; const calls = new Map(), adapters = {};
  for (const oilType of ['cl', 'bz']) for (const action of ['quote', 'history', 'funding']) {
    const name = goldOilAction(action, oilType);
    adapters[name] = async () => { calls.set(name, (calls.get(name) ?? 0) + 1); return { oilType, status: 'live', action }; };
  }
  const read = createDataReader({ 'cl-xau': adapters, oil: { quote: async () => ({}) } }, () => clock);
  const values = await Promise.all(['quote', 'bz/quote', 'quote', 'bz/quote'].map(action => read('cl-xau', action)));
  assert.deepEqual(values.map(value => value.oilType), ['cl', 'bz', 'cl', 'bz']);
  assert.equal(calls.get('quote'), 1); assert.equal(calls.get('bz/quote'), 1);
  for (const [action, ttl] of [['quote', GOLD_OIL_QUOTE_MS], ['history', GOLD_OIL_HISTORY_MS], ['funding', GOLD_OIL_FUNDING_MS]]) {
    clock = 0; await Promise.all([read('cl-xau', action), read('cl-xau', `bz/${action}`)]);
    clock = ttl - 1; await Promise.all([read('cl-xau', action), read('cl-xau', `bz/${action}`)]);
    assert.equal(calls.get(action), 1); assert.equal(calls.get(`bz/${action}`), 1);
    clock = ttl; await Promise.all([read('cl-xau', action), read('cl-xau', `bz/${action}`)]);
    assert.equal(calls.get(action), 2); assert.equal(calls.get(`bz/${action}`), 2);
  }
  for (const action of ['bz/status', 'bz/config', 'bz/events', 'bz/quote/extra', 'cl/quote', 'bz/bz/quote']) await assert.rejects(read('cl-xau', action));
  await assert.rejects(read('oil', 'bz/quote'));
});

test('Next preview exposes BZ data and unavailable status but no configuration route', async () => {
  const routeURL = new URL('../app/api/monitors/[id]/[...action]/route.ts', import.meta.url), original = await readFile(routeURL, 'utf8');
  const source = original.replace(/import \{ readMonitorData \} from [^;]+;/, 'const readMonitorData = async (id, action) => ({ id, action });')
    .replace(/from (["'])(\.\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(/\.(?:ts|mjs)$/.test(specifier) ? specifier : `${specifier}.ts`, routeURL).href)}`);
  const route = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const request = new Request('http://localhost/api/monitors/cl-xau/bz/quote'), context = (id, action) => ({ params: Promise.resolve({ id, action: action.split('/') }) });
  for (const action of ['quote', 'history', 'funding', 'bz/quote', 'bz/history', 'bz/funding']) {
    const response = await route.GET(request, context('cl-xau', action));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { id: 'cl-xau', action });
  }
  for (const action of ['status', 'bz/status']) {
    const response = await route.GET(request, context('cl-xau', action)), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.available, false); assert.equal(body.oilType, action.startsWith('bz/') ? 'bz' : 'cl');
  }
  for (const action of ['bz/config', 'bz/events', 'bz/quote/extra', 'bz/bz/quote']) assert.equal((await route.GET(request, context('cl-xau', action))).status, 404);
  for (const id of ['oil', 'hynix', 'perpetual']) assert.equal((await route.GET(request, context(id, 'bz/quote'))).status, 404);
  assert.equal(route.PUT, undefined);
});

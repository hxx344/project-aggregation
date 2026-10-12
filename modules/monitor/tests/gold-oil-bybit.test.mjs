import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { GOLD_OIL_INTERVAL_MS as STEP, GOLD_OIL_VARIANTS, GOLD_OIL_EXCHANGES, GOLD_OIL_INSTRUMENTS, GOLD_OIL_QUOTE_MS, GOLD_OIL_HISTORY_MS, GOLD_OIL_FUNDING_MS, goldOilAction, goldOilVariantKey, goldOilUnits, parseGoldOilAction, validateGoldOilQuote, validateGoldOilHistory, goldOilChartPoints } from '../lib/gold-oil.ts';
import { validateGoldOilFunding, currentGoldOilFunding, analyzeGoldOilFunding } from '../lib/gold-oil-funding.ts';
import { createGoldOilReader } from '../lib/gold-oil-service.ts';
import { validateBybitGoldOilContract, parseBybitGoldOilQuote, parseBybitGoldOilHistory, parseBybitGoldOilFunding } from '../lib/gold-oil-bybit-service.ts';
import { createDataReader } from '../lib/monitor-service.ts';

const now = Date.UTC(2026, 9, 7, 12), HOUR = 3_600_000;
const prices = { CLUSDT: 80, BZUSDT: 100, XAUUSDT: 4000 };
const listing = { CLUSDT: now - 6000 * STEP, BZUSDT: now - 4500 * STEP, XAUUSDT: now - 5000 * STEP };
const wrap = (list, time = now, extra = {}) => ({ retCode: 0, time, result: { category: 'linear', list, ...extra } });
const contract = symbol => ({ symbol, baseCoin: symbol.slice(0, -4), quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', isPreListing: false, launchTime: String(listing[symbol]), fundingInterval: symbol === 'XAUUSDT' ? 240 : 480 });
const ticker = (symbol, time = now) => wrap([{ symbol, markPrice: String(prices[symbol]), fundingRate: symbol === 'XAUUSDT' ? '0.0016' : '0.0004', fundingIntervalHour: symbol === 'XAUUSDT' ? '4' : '8', nextFundingTime: String(now + (symbol === 'XAUUSDT' ? 4 : 8) * HOUR) }], time);
const candle = (time, price) => [String(time), String(price), String(price), String(price), String(price)];
const event = (symbol, time, rate = 0.0001) => ({ symbol, fundingRateTimestamp: String(time), fundingRate: String(rate) });
const quote = (oilType = 'cl') => parseBybitGoldOilQuote(ticker(GOLD_OIL_INSTRUMENTS[oilType].symbol), ticker('XAUUSDT'), now, [], oilType);
const history = (oilType = 'cl') => parseBybitGoldOilHistory([candle(now - STEP, 80)], [candle(now - STEP, 4000)], now, null, now - 24 * HOUR, oilType);
const funding = (oilType = 'cl') => parseBybitGoldOilFunding([event(GOLD_OIL_INSTRUMENTS[oilType].symbol, now - HOUR)], [event('XAUUSDT', now - HOUR + 1)], now - 24 * HOUR, now, now, null, oilType);

test('four exact variant paths preserve Binance aliases and reject ambiguous paths', () => {
  assert.equal(GOLD_OIL_VARIANTS.length, 4);
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
    assert.equal(goldOilVariantKey(oilType, exchange), `${exchange}/${oilType}`);
    for (const action of ['quote', 'history', 'funding', 'status', 'config', 'events']) {
      const path = `${exchange === 'bybit' ? 'bybit/' : ''}${oilType === 'bz' ? 'bz/' : ''}${action}`;
      assert.equal(goldOilAction(action, oilType, exchange), path);
      assert.deepEqual(parseGoldOilAction(path), { oilType, exchange, action });
    }
  }
  for (const path of ['binance/quote', 'bybit/cl/quote', 'bz/bybit/quote', 'bybit/bybit/quote', 'bybit/bz/bz/quote', 'bybit/bz/quote/extra', 'bybit/Quote', '/bybit/quote', 'bybit/alerts', 'bybit/__proto__']) assert.equal(parseGoldOilAction(path), null);
  assert.deepEqual(goldOilUnits('bz', 'bybit'), { ratio: '报价比', oil: 'USDT/BZ' });
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS.filter(row => row.oilType !== 'bz' || row.exchange !== 'bybit')) assert.deepEqual(goldOilUnits(oilType, exchange), { ratio: '桶/盎司', oil: 'USDT/桶' });
});

test('validators enforce exchange and oil identity, including empty funding and legacy inputs', () => {
  for (const [make, validate] of [[quote, validateGoldOilQuote], [history, validateGoldOilHistory], [funding, validateGoldOilFunding]]) {
    for (const oilType of ['cl', 'bz']) {
      const value = make(oilType);
      assert.deepEqual(validate(value, oilType, 'bybit'), value);
      assert.throws(() => validate(value, oilType), /source/);
      assert.throws(() => validate({ ...value, source: 'Binance' }, oilType, 'bybit'), /source/);
      assert.throws(() => validate(value, oilType === 'cl' ? 'bz' : 'cl', 'bybit'), /variant/);
      assert.throws(() => validate({ ...value, oilType: undefined }, oilType, 'bybit'), /variant/);
      assert.throws(() => validate(value, oilType, '__proto__'), /source/);
    }
  }
  assert.throws(() => validateGoldOilFunding({ ...funding(), points: [] }, 'cl'), /source/);
  assert.equal(validateGoldOilQuote({ ...quote(), source: 'Binance', oilType: undefined }).oilType, 'cl');
});

test('metadata requires the exact live linear USDT contract and rejects malformed envelopes', () => {
  for (const symbol of ['CLUSDT', 'BZUSDT', 'XAUUSDT']) assert.equal(validateBybitGoldOilContract(wrap([contract(symbol)]), symbol, now).launchTime, listing[symbol]);
  for (const [key, value] of [['symbol', 'PAXGUSDT'], ['baseCoin', 'CL'], ['settleCoin', 'USDC'], ['quoteCoin', 'USDC'], ['contractType', 'LinearFutures'], ['status', 'PreLaunch'], ['isPreListing', true], ['isPreListing', undefined], ['launchTime', ''], ['launchTime', String(now + 1)]]) {
    assert.throws(() => validateBybitGoldOilContract(wrap([{ ...contract('XAUUSDT'), [key]: value }]), 'XAUUSDT', now));
  }
  for (const input of [wrap([]), wrap([contract('XAUUSDT'), contract('XAUUSDT')]), { ...wrap([contract('XAUUSDT')]), retCode: 10001 }, { ...wrap([contract('XAUUSDT')]), time: '' }, wrap([contract('XAUUSDT')], now - 76000), wrap([contract('XAUUSDT')], now + 1001), wrap([contract('XAUUSDT')], now, { category: 'inverse' })]) assert.throws(() => validateBybitGoldOilContract(input, 'XAUUSDT', now));
});

test('quotes use mark prices, current per-leg periods and synchronized fresh source timestamps', () => {
  assert.equal(quote().ratio, 50); assert.equal(quote('bz').ratio, 40);
  assert.equal(currentGoldOilFunding(quote()).hourlyRate, (0.0016 / 4 - 0.0004 / 8) / 2);
  for (const time of [now - 76000, now - 16000, now + 1001]) assert.throws(() => parseBybitGoldOilQuote(ticker('CLUSDT'), ticker('XAUUSDT', time), now));
  for (const markPrice of ['', '0', '-1', 'Infinity']) {
    const oil = ticker('CLUSDT'); oil.result.list[0].markPrice = markPrice;
    assert.throws(() => parseBybitGoldOilQuote(oil, ticker('XAUUSDT'), now));
  }
  assert.throws(() => parseBybitGoldOilQuote(ticker('BZUSDT'), ticker('XAUUSDT'), now));
  const oil = ticker('CLUSDT'), xau = ticker('XAUUSDT');
  delete oil.result.list[0].fundingIntervalHour; delete xau.result.list[0].fundingIntervalHour;
  const terms = ['CLUSDT', 'XAUUSDT'].map(symbol => validateBybitGoldOilContract(wrap([contract(symbol)]), symbol, now));
  assert.equal(parseBybitGoldOilQuote(oil, xau, now, terms).funding.oil.intervalHours, 8);
  assert.equal(parseBybitGoldOilQuote(oil, xau, now).funding, null);
  for (const interval of ['', '0', '1.5', '25', 'bad', null]) {
    oil.result.list[0].fundingIntervalHour = interval;
    assert.equal(parseBybitGoldOilQuote(oil, xau, now, terms).funding, null);
  }
  const missingFunding = ticker('CLUSDT'); delete missingFunding.result.list[0].fundingRate;
  assert.equal(parseBybitGoldOilQuote(missingFunding, ticker('XAUUSDT'), now).ratio, 50);
  assert.equal(parseBybitGoldOilQuote(missingFunding, ticker('XAUUSDT'), now).funding, null);
});

test('completed history preserves gaps and refuses foreign previous values before merging', async () => {
  const value = parseBybitGoldOilHistory([candle(now, 80), candle(now - STEP, 80), candle(now - 3 * STEP, 80)], [candle(now, 4000), candle(now - 3 * STEP, 4000)], now, null, now - 3 * STEP);
  assert.deepEqual(goldOilChartPoints(value, 0).map(row => row.ratio), [50, null, null]);
  for (const rows of [[], [candle(now, 80)], [candle(now - STEP, 0)], [candle(now - STEP, 80), candle(now - STEP, 80)]]) assert.throws(() => parseBybitGoldOilHistory(rows, [candle(now - STEP, 4000)], now, value));
  for (const exchange of ['binance', 'bybit']) for (const oilType of ['cl', 'bz']) {
    let calls = 0;
    const reader = createGoldOilReader({ oilType, exchange, clock: () => now, fetcher: async () => { calls++; throw Error('Unexpected network request'); } });
    const source = GOLD_OIL_EXCHANGES[exchange === 'binance' ? 'bybit' : 'binance'].name;
    await assert.rejects(reader.history({ ...history(oilType), source }), /source/);
    await assert.rejects(reader.funding({ ...funding(oilType), source }), /source/);
    await assert.rejects(reader.history({ ...history(oilType === 'cl' ? 'bz' : 'cl'), source: GOLD_OIL_EXCHANGES[exchange].name }), /variant/);
    assert.equal(calls, 0);
  }
});

test('funding sums real asynchronous events without assuming matching periods', () => {
  const start = now - 24 * HOUR;
  const oil = [8, 16].map(hour => event('CLUSDT', start + hour * HOUR + 1, 0.0004));
  const xau = [4, 8, 12, 16, 20].map(hour => event('XAUUSDT', start + hour * HOUR + 2, 0.0016));
  const value = parseBybitGoldOilFunding(oil, xau, start, now, now), result = analyzeGoldOilFunding(value, start, now);
  assert.equal(result.oilCount, 2); assert.equal(result.xauCount, 5); assert.equal(value.points.length, 7);
  assert.ok(value.points.every(row => row.oil === null || row.xau === null));
  assert.ok(Math.abs(result.shortCumulative - (5 * 0.0016 - 2 * 0.0004) / 2) < 1e-12);
  assert.equal(analyzeGoldOilFunding(value, start - 1, now).shortAnnualized, null);
  for (const input of [[oil[0], oil[0]], [event('XAUUSDT', start + 1)], [event('CLUSDT', now)], [event('CLUSDT', start - 1)], [event('CLUSDT', start + 1, 2)]]) assert.throws(() => parseBybitGoldOilFunding(input, xau, start, now, now));
  assert.throws(() => parseBybitGoldOilFunding(oil, xau, start, now, now, { ...value, source: 'Binance' }), /source/);
});

function paginatedFetcher(logs, oilType) {
  return async input => {
    const url = new URL(input), symbol = url.searchParams.get('symbol'); logs.push(url);
    assert.equal(url.origin, 'https://api.bybit.com'); assert.equal(url.searchParams.get('category'), 'linear');
    assert.ok([GOLD_OIL_INSTRUMENTS[oilType].symbol, 'XAUUSDT'].includes(symbol));
    if (url.pathname.endsWith('instruments-info')) return Response.json(wrap([contract(symbol)]));
    if (url.pathname.endsWith('tickers')) return Response.json(ticker(symbol));
    const candles = url.pathname.endsWith('mark-price-kline'), start = Number(url.searchParams.get(candles ? 'start' : 'startTime')), end = Number(url.searchParams.get(candles ? 'end' : 'endTime')), limit = Number(url.searchParams.get('limit'));
    if (candles) { assert.equal(limit, 1000); assert.equal(url.searchParams.get('interval'), '15'); assert.equal(end < now, true); }
    else { assert.equal(url.pathname, '/v5/market/funding/history'); assert.equal(limit, 200); }
    const rows = [], step = candles ? STEP : (symbol === 'XAUUSDT' ? 4 : 8) * HOUR;
    for (let time = listing[symbol] + (candles ? 0 : step + (symbol === 'XAUUSDT' ? 2 : 1)); time < now; time += step) if (time >= start && time <= end) rows.push(candles ? candle(time, prices[symbol]) : event(symbol, time));
    return Response.json(wrap(rows.reverse().slice(0, limit), now, candles ? { symbol } : {}));
  };
}

test('Bybit readers traverse all reverse pages beyond 1000 candles and 200 settlements, then overlap only', async () => {
  const results = [];
  for (const oilType of ['cl', 'bz']) {
    const logs = [], reader = createGoldOilReader({ exchange: 'bybit', oilType, clock: () => now, fetcher: paginatedFetcher(logs, oilType) });
    const [q, h, f] = await Promise.all([reader.quote(), reader.history(), reader.funding()]);
    results.push({ q, h, f });
    const start = Math.max(listing[GOLD_OIL_INSTRUMENTS[oilType].symbol], listing.XAUUSDT);
    assert.equal(q.source, 'Bybit'); assert.equal(h.coverageStart, start); assert.equal(f.coverageStart, start);
    assert.equal(h.points.length, (now - start) / STEP); assert.equal(h.points[0].time, start); assert.equal(h.points.at(-1).time, now - STEP);
    const xauEvents = f.points.filter(row => row.xau !== null);
    assert.ok(xauEvents.length > 200); assert.ok(xauEvents[0].time < now - 200 * 4 * HOUR);
    assert.equal(logs.filter(url => url.pathname.endsWith('instruments-info')).length, 2);
    logs.length = 0;
    assert.deepEqual(await reader.history(), h); assert.deepEqual(await reader.funding(), f);
    assert.equal(logs.filter(url => url.pathname.endsWith('mark-price-kline')).length, 2);
    assert.equal(logs.filter(url => url.pathname.endsWith('funding/history')).length, 2);
    assert.ok(logs.every(url => Number(url.searchParams.get(url.pathname.endsWith('mark-price-kline') ? 'start' : 'startTime')) >= now - 2 * 24 * HOUR));
    logs.length = 0;
    const gap = structuredClone(h); gap.points.splice(20, 1); gap.points[10].oil = null; if (oilType === 'cl') gap.points[10].cl = null;
    assert.deepEqual(await reader.history(gap), h);
    assert.equal(Math.min(...logs.map(url => Number(url.searchParams.get('start')))), gap.points[10].time);
    logs.length = 0;
    assert.equal((await reader.funding({ ...f, coverageStart: now - 24 * HOUR, points: f.points.filter(row => row.time >= now - 24 * HOUR) })).coverageStart, start);
    assert.equal(Number(logs[0].searchParams.get('startTime')), start);
  }
  assert.equal(results[0].q.ratio, 50); assert.equal(results[1].q.ratio, 40);
  assert.notEqual(results[0].h.coverageStart, results[1].h.coverageStart);
});

test('bounded candle windows keep earlier history across empty and sparse middle periods', async () => {
  const logs = [], healthy = paginatedFetcher(logs, 'cl');
  const reader = createGoldOilReader({ exchange: 'bybit', clock: () => now, fetcher: async input => {
    const url = new URL(input), response = await healthy(input);
    if (!url.pathname.endsWith('mark-price-kline')) return response;
    const value = await response.json(), start = Number(url.searchParams.get('start'));
    if (start === now - 2000 * STEP) value.result.list = [];
    if (start === now - 3000 * STEP) value.result.list = value.result.list.filter((_, index) => index % 2);
    return Response.json(value);
  } });
  const result = await reader.history(), chart = goldOilChartPoints(result, 0);
  assert.equal(result.coverageStart, listing.XAUUSDT); assert.equal(result.points[0].time, listing.XAUUSDT);
  assert.equal(result.points.length, 3500); assert.equal(chart.length, 5000);
  assert.equal(chart.filter(row => row.ratio === null).length, 1500);
  assert.equal(logs.filter(url => url.pathname.endsWith('mark-price-kline')).length, 10);
});

test('invalid ordering, duplicates, out-of-range pages, wrong result symbol and failures reject without partial coverage', async () => {
  for (const mode of ['duplicate', 'ascending', 'outside', 'symbol', 'repeated-page', 'http', 'envelope']) {
    let count = 0;
    const reader = createGoldOilReader({ exchange: 'bybit', clock: () => now, fetcher: async input => {
      const url = new URL(input), symbol = url.searchParams.get('symbol');
      if (url.pathname.endsWith('instruments-info')) return Response.json(wrap([contract(symbol)]));
      if (mode === 'http') return new Response('', { status: 503 });
      if (mode === 'envelope') return Response.json({ ...wrap([]), retCode: 10001 });
      count++;
      const rows = mode === 'repeated-page' ? Array.from({ length: 1000 }, (_, index) => candle(now - (index + 1) * STEP, prices[symbol])) : [candle(mode === 'outside' ? now : now - STEP, prices[symbol]), candle(now - (mode === 'duplicate' ? 1 : 2) * STEP, prices[symbol])];
      if (mode === 'ascending') rows.reverse();
      return Response.json(wrap(rows, now, { symbol: mode === 'symbol' ? 'WRONGUSDT' : symbol }));
    } });
    await assert.rejects(reader.history());
    if (mode === 'repeated-page') assert.ok(count >= 3);
  }
  let fail = true;
  const logs = [], healthy = paginatedFetcher(logs, 'cl');
  const reader = createGoldOilReader({ exchange: 'bybit', clock: () => now, fetcher: async input => fail ? new Response('', { status: 503 }) : healthy(input) });
  await assert.rejects(reader.quote()); fail = false; assert.equal((await reader.quote()).ratio, 50);
  let failFunding = true;
  const fundingReader = createGoldOilReader({ exchange: 'bybit', clock: () => now, fetcher: async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('funding/history') && Number(url.searchParams.get('endTime')) < now - 1 && failFunding) return new Response('', { status: 503 });
    return healthy(input);
  } });
  await assert.rejects(fundingReader.funding()); logs.length = 0; failFunding = false;
  const recovered = await fundingReader.funding();
  assert.equal(recovered.coverageStart, listing.XAUUSDT);
  assert.equal(Number(logs[0].searchParams.get('startTime')), listing.XAUUSDT);
  assert.ok(recovered.points.filter(row => row.xau !== null).length > 200);
});

test('preview keeps all four variant caches, pending requests and refresh periods independent', async () => {
  let clock = 0; const calls = new Map(), adapters = {};
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) for (const action of ['quote', 'history', 'funding']) {
    const name = goldOilAction(action, oilType, exchange);
    adapters[name] = async () => { calls.set(name, (calls.get(name) ?? 0) + 1); return { oilType, source: GOLD_OIL_EXCHANGES[exchange].name, status: 'live', action }; };
  }
  const read = createDataReader({ 'cl-xau': adapters, oil: { quote: async () => ({}) } }, () => clock);
  for (const [action, ttl] of [['quote', GOLD_OIL_QUOTE_MS], ['history', GOLD_OIL_HISTORY_MS], ['funding', GOLD_OIL_FUNDING_MS]]) {
    clock = 0; const paths = GOLD_OIL_VARIANTS.map(({ oilType, exchange }) => goldOilAction(action, oilType, exchange));
    const values = await Promise.all([...paths, ...paths].map(path => read('cl-xau', path)));
    assert.deepEqual(values.slice(0, 4).map(value => [value.source, value.oilType]), [['Binance', 'cl'], ['Binance', 'bz'], ['Bybit', 'cl'], ['Bybit', 'bz']]);
    clock = ttl - 1; await Promise.all(paths.map(path => read('cl-xau', path)));
    assert.ok(paths.every(path => calls.get(path) === 1));
    clock = ttl; await Promise.all(paths.map(path => read('cl-xau', path)));
    assert.ok(paths.every(path => calls.get(path) === 2));
  }
  for (const action of ['bybit/status', 'bybit/bz/config', 'bybit/events', 'bybit/cl/quote', 'bybit/bz/quote/extra']) await assert.rejects(read('cl-xau', action));
  for (const action of ['bybit/quote', 'bybit/bz/history']) await assert.rejects(read('oil', action));
});

test('Next preview serves all data variants and identifies unavailable status responses', async () => {
  const routeURL = new URL('../app/api/monitors/[id]/[...action]/route.ts', import.meta.url), original = await readFile(routeURL, 'utf8');
  const source = original.replace(/import \{ readMonitorData \} from [^;]+;/, 'const readMonitorData = async (id, action) => ({ id, action });')
    .replace(/from (["'])(\.\.[^"']+)\1/g, (_match, _quote, specifier) => `from ${JSON.stringify(new URL(/\.(?:ts|mjs)$/.test(specifier) ? specifier : `${specifier}.ts`, routeURL).href)}`);
  const route = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const request = new Request('http://localhost/api/monitors/cl-xau/bybit/quote'), context = (id, action) => ({ params: Promise.resolve({ id, action: action.split('/') }) });
  for (const { oilType, exchange } of GOLD_OIL_VARIANTS) {
    for (const action of ['quote', 'history', 'funding']) {
      const name = goldOilAction(action, oilType, exchange), response = await route.GET(request, context('cl-xau', name));
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { id: 'cl-xau', action: name });
    }
    const status = await (await route.GET(request, context('cl-xau', goldOilAction('status', oilType, exchange)))).json();
    assert.equal(status.available, false); assert.equal(status.oilType, oilType); assert.equal(status.exchange, exchange); assert.equal(status.source, GOLD_OIL_EXCHANGES[exchange].name);
    for (const action of ['config', 'events']) assert.equal((await route.GET(request, context('cl-xau', goldOilAction(action, oilType, exchange)))).status, 404);
  }
  for (const id of ['oil', 'hynix', 'perpetual']) for (const action of ['bybit/quote', 'bybit/bz/quote']) assert.equal((await route.GET(request, context(id, action))).status, 404);
});

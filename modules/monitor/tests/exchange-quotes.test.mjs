import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { calculateExchangeSpread, validateExchangeQuote, hynixExchangeQuote, externalQuoteStale, comparisonExchanges, displayComparisonExchanges, exchangeDefinition } from '../lib/exchange-quotes.ts';
import { parseBybitQuote, parseBinanceQuote, createExchangeReader } from '../lib/exchange-service.ts';
import { openMarketStore } from '../server/market-store.mjs';
import { createMarketCollector, marketJobs } from '../server/market-collector.mjs';
import { createMonitorServices } from '../server/monitor-services.mjs';
import { createHandler } from '../server/http.mjs';
import { readInitialMarket } from '../server/initial-market.mjs';

const NOW = Date.UTC(2026, 8, 14, 12), HOUR = 3_600_000;
function fixtures(now = NOW) {
  const data = [['BZ', 104, 0.0004, 4], ['CL', 100, 0.0008, 4], ['SKHY', 180, 0.0008, 8], ['SKHYNIX', 1200, 0.0008, 4]];
  return {
    bybitInstruments: data.map(([baseCoin]) => ({ symbol: `${baseCoin}USDT`, baseCoin, quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', fundingInterval: 480 })),
    bybitTickers: { retCode: 0, time: now, result: { category: 'linear', list: data.map(([base, price, rate]) => ({ symbol: `${base}USDT`, markPrice: String(price), fundingRate: String(rate), nextFundingTime: now + 8 * HOUR })) } },
    binanceInstruments: { symbols: data.map(([baseAsset]) => ({ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'TRADIFI_PERPETUAL' })) },
    binanceTickers: data.map(([base, price, rate, hours]) => ({ symbol: `${base}USDT`, markPrice: String(price), lastFundingRate: String(rate), nextFundingTime: now + hours * HOUR, time: now })),
    binanceFunding: data.map(([base, , , fundingIntervalHours]) => ({ symbol: `${base}USDT`, fundingIntervalHours })),
  };
}
function quote(exchange, market, now = NOW) {
  const f = fixtures(now);
  if (exchange === 'bybit') return parseBybitQuote(market, f.bybitInstruments, f.bybitTickers, now);
  const base = parseBinanceQuote(market, f.binanceInstruments, f.binanceTickers, f.binanceFunding, now);
  if (exchange === 'binance') return base;
  const definition = exchangeDefinition(exchange, market);
  return validateExchangeQuote({ ...base, exchange, currency: definition.currency, fundingPriceBasis: definition.fundingPriceBasis,
    left: { ...base.left, symbol: definition.left }, right: { ...base.right, symbol: definition.right },
  }, exchange, market);
}

test('oil expands to seven exchanges with distinct symbols and currencies; Hynix adds OKX, Bitget and Gate', () => {
  assert.deepEqual(comparisonExchanges('oil'), ['hyperliquid', 'bybit', 'binance', 'lighter', 'variational', 'okx', 'bitget']);
  assert.deepEqual(comparisonExchanges('hynix'), ['bybit', 'binance', 'okx', 'bitget', 'gate']);
  assert.deepEqual(displayComparisonExchanges('hynix'), ['hyperliquid', 'bybit', 'binance', 'okx', 'bitget', 'gate']);
  assert.throws(() => exchangeDefinition('gate', 'oil'), /Unsupported/);
  for (const [exchange, left, right] of [['okx', 'SKHY-USDT-SWAP', 'SKHYNIX-USDT-SWAP'], ['bitget', 'SKHYUSDT', 'SKHYNIXUSDT'], ['gate', 'SKHY_USDT', 'SKHYNIX_USDT']]) {
    assert.deepEqual(exchangeDefinition(exchange, 'hynix'), { left, right, currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' });
    const value = quote(exchange, 'hynix');
    assert.equal(calculateExchangeSpread(value).premium, 50);
    assert.throws(() => validateExchangeQuote(value, exchange, 'oil'));
  }
  for (const exchange of ['lighter', 'variational', 'okx', 'bitget']) {
    const value = quote(exchange, 'oil');
    assert.equal(calculateExchangeSpread(value).premium, 4);
    if (['lighter', 'variational'].includes(exchange)) assert.throws(() => validateExchangeQuote(value, exchange, 'hynix'), /Unsupported/);
    else assert.throws(() => validateExchangeQuote(value, exchange, 'hynix'), /mismatch/);
    assert.throws(() => validateExchangeQuote({ ...value, left: { ...value.left, symbol: 'BTC' } }, exchange, 'oil'));
    const wrongCurrency = value.currency === 'USDC' ? 'USDT' : 'USDC';
    assert.throws(() => validateExchangeQuote({ ...value, currency: wrongCurrency }, exchange, 'oil'));
  }
});

test('Lighter preserves independent index funding notional and explicitly estimated settlement time', () => {
  const value = quote('lighter', 'oil');
  value.left.fundingPrice = 110; value.right.fundingPrice = 90;
  value.left.nextFundingEstimated = true; value.right.nextFundingEstimated = true;
  const validated = validateExchangeQuote(value, 'lighter', 'oil');
  assert.equal(validated.left.fundingPrice, 110);
  assert.equal(validated.left.nextFundingEstimated, true);
  assert.equal(calculateExchangeSpread(validated).shortAnnualized, (110 * 0.0004 / 4 - 90 * 0.0008 / 4) / 200 * 8760);
  assert.throws(() => validateExchangeQuote({ ...value, fundingPriceBasis: 'mark' }, 'lighter', 'oil'));
  assert.throws(() => validateExchangeQuote({ ...value, left: { ...value.left, fundingPrice: null } }, 'lighter', 'oil'));
});

test('OKX funding uses its documented slower refresh while mark prices keep the normal freshness deadline', () => {
  const value = { ...quote('okx', 'oil'), fundingFetchedAt: new Date(NOW - 90_000).toISOString() };
  assert.equal(externalQuoteStale(value, NOW), false);
  assert.equal(externalQuoteStale(value, NOW + 31_000), true);
  assert.equal(externalQuoteStale({ ...value, fundingFetchedAt: new Date(NOW).toISOString() }, NOW + 45_001), true);
});

test('fixed quantity spreads annualize each leg separately; mark notional and 10:1 Hynix ratio are respected', () => {
  const hynix = calculateExchangeSpread(quote('binance', 'hynix'));
  assert.equal(hynix.equivalent, 120); assert.equal(hynix.spread, 60); assert.equal(hynix.premium, 50);
  assert.ok(Math.abs(hynix.shortAnnualized - (-0.1752)) < 1e-12);
  assert.equal(hynix.longAnnualized, -hynix.shortAnnualized);
  const oil = calculateExchangeSpread(quote('binance', 'oil'));
  assert.equal(oil.spread, 4); assert.ok(Math.abs(oil.premium - 4) < 1e-12);
  assert.ok(Math.abs(oil.shortAnnualized - ((104 * 0.0004 / 4 - 100 * 0.0008 / 4) / 204 * 8760)) < 1e-12);
});

test('Hyperliquid comparison preserves mid prices and oracle-weighted funding instead of mark prices', () => {
  const q = hynixExchangeQuote({ fetchedAt: new Date(NOW).toISOString(), adr: 180, ordinary: 1200, funding: { fetchedAt: new Date(NOW).toISOString(), adr: { oraclePx: 100, hourlyRate: 0.0001 }, ordinary: { oraclePx: 1000, hourlyRate: 0.0002 } } });
  assert.equal(q.currency, 'USD'); assert.equal(q.priceBasis, 'mid');
  assert.ok(Math.abs(calculateExchangeSpread(q).shortAnnualized - (-0.438)) < 1e-12);
  assert.equal(externalQuoteStale(q, NOW + 25001), true);
  assert.equal(externalQuoteStale({ ...q, monitorId: 'oil' }, NOW + 60000), false);
  assert.equal(externalQuoteStale(quote('bybit', 'hynix'), NOW + 45001), true);
});

test('genuine zero funding remains zero; missing rate, interval, or settlement never becomes zero', () => {
  const f = fixtures(); f.bybitTickers.result.list.forEach(row => { row.fundingRate = '0'; });
  assert.equal(calculateExchangeSpread(parseBybitQuote('hynix', f.bybitInstruments, f.bybitTickers, NOW)).shortAnnualized, 0);
  for (const field of ['fundingRate', 'nextFundingTime']) {
    const broken = structuredClone(f); broken.bybitTickers.result.list[2][field] = '';
    const q = parseBybitQuote('hynix', broken.bybitInstruments, broken.bybitTickers, NOW);
    assert.equal(q.left.price, 180); assert.equal(calculateExchangeSpread(q).shortAnnualized, null); assert.ok(q.fundingError);
  }
  const missingInterval = parseBinanceQuote('hynix', f.binanceInstruments, f.binanceTickers, f.binanceFunding.slice(0, 3), NOW);
  assert.equal(calculateExchangeSpread(missingInterval).shortAnnualized, null);
  f.bybitTickers.result.list[2].fundingIntervalHour = '4';
  assert.equal(parseBybitQuote('hynix', f.bybitInstruments, f.bybitTickers, NOW).left.fundingIntervalHours, 4);
});

test('wrong contract identity, inactive contracts, malformed prices, stale timestamps and unsynchronized legs are rejected', () => {
  for (const [field, value] of [['status', 'SETTLING'], ['quoteAsset', 'KRW'], ['baseAsset', 'SKHX'], ['contractType', 'CURRENT_QUARTER']]) {
    const f = fixtures(); f.binanceInstruments.symbols[2][field] = value;
    assert.throws(() => parseBinanceQuote('hynix', f.binanceInstruments, f.binanceTickers, f.binanceFunding, NOW));
    assert.doesNotThrow(() => parseBinanceQuote('oil', f.binanceInstruments, f.binanceTickers, f.binanceFunding, NOW));
  }
  for (const [field, value] of [['markPrice', ''], ['markPrice', '-1'], ['time', NOW - 121000], ['time', NOW + 61000], ['time', NOW - 16000]]) {
    const f = fixtures(); f.binanceTickers[2][field] = value;
    assert.throws(() => parseBinanceQuote('hynix', f.binanceInstruments, f.binanceTickers, f.binanceFunding, NOW));
  }
  const q = quote('bybit', 'hynix');
  for (const patch of [{ exchange: 'binance' }, { currency: 'KRW' }, { status: 'unknown' }, { fundingFetchedAt: null }, { left: { ...q.left, fundingIntervalHours: null } }]) assert.throws(() => validateExchangeQuote({ ...q, ...patch }, 'bybit', 'hynix'));
});

test('concurrent market reads share Bybit pagination and quote transport; expired metadata is reloaded', async () => {
  let now = NOW; const calls = [];
  const reader = createExchangeReader({ clock: () => now, fetcher: async input => {
    const url = new URL(input); calls.push(url.pathname + url.search);
    const f = fixtures(now);
    if (url.pathname.endsWith('/tickers')) return Response.json(f.bybitTickers);
    const second = url.searchParams.has('cursor');
    return Response.json({ retCode: 0, time: now, result: { category: 'linear', list: second ? f.bybitInstruments.slice(2) : f.bybitInstruments.slice(0, 2), nextPageCursor: second ? '' : 'next' } });
  } });
  const results = await Promise.all(['oil', 'hynix'].map(id => reader('bybit', id)));
  assert.equal(results.length, 2); assert.equal(calls.length, 3);
  await reader('bybit', 'oil'); assert.equal(calls.length, 3);
  now += 15000; await reader('bybit', 'hynix'); assert.equal(calls.length, 4);
  now += 60000; await reader('bybit', 'hynix'); assert.equal(calls.length, 7);
});

test('concurrent Binance markets share one transient retry and preserve upstream timestamps', async () => {
  let now = NOW;
  const calls = { exchangeInfo: 0, premiumIndex: 0, fundingInfo: 0 }, sleeps = [], f = fixtures();
  const reader = createExchangeReader({ clock: () => now, sleep: async delay => { sleeps.push(delay); now += delay; }, fetcher: async input => {
    const endpoint = new URL(input).pathname.split('/').at(-1);
    calls[endpoint]++;
    if (endpoint === 'exchangeInfo') return Response.json(f.binanceInstruments);
    if (endpoint === 'fundingInfo') return Response.json(f.binanceFunding);
    if (calls.premiumIndex === 1) return new Response('temporary gateway failure', { status: 502 });
    return Response.json(f.binanceTickers);
  } });
  const [oil, hynix] = await Promise.all(['oil', 'hynix'].map(id => reader('binance', id)));
  assert.equal(oil.left.price, 104); assert.equal(hynix.left.price, 180);
  assert.deepEqual(calls, { exchangeInfo: 1, premiumIndex: 2, fundingInfo: 1 });
  assert.deepEqual(sleeps, [300]);
  for (const value of [oil, hynix]) {
    assert.equal(value.fetchedAt, new Date(NOW).toISOString());
    assert.equal(value.fundingFetchedAt, new Date(NOW).toISOString());
  }
});

test('persistent Binance failures are bounded, never return expired cached prices, and recover on a new read', async () => {
  let now = NOW, unavailable = false, priceCalls = 0;
  const sleeps = [];
  const reader = createExchangeReader({ clock: () => now, sleep: async delay => { sleeps.push(delay); now += delay; }, fetcher: async input => {
    const f = fixtures(now);
    if (input.endsWith('/exchangeInfo')) return Response.json(f.binanceInstruments);
    if (input.endsWith('/fundingInfo')) return Response.json(f.binanceFunding);
    priceCalls++;
    return unavailable ? new Response('private gateway details', { status: 503 }) : Response.json(f.binanceTickers);
  } });
  const original = await reader('binance', 'oil');
  now += 1500; unavailable = true;
  const failures = await Promise.allSettled(['oil', 'hynix'].map(id => reader('binance', id)));
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.kind === 'http' && result.reason.httpStatus === 503));
  assert.equal(priceCalls, 3); assert.deepEqual(sleeps, [300]);
  assert.equal(original.fetchedAt, new Date(NOW).toISOString());
  unavailable = false;
  const recovered = await reader('binance', 'oil');
  assert.equal(priceCalls, 4); assert.equal(recovered.fetchedAt, new Date(now).toISOString());
});

test('funding-only Binance rate limits preserve current prices and resume funding after cooldown', async () => {
  let now = NOW, fundingCalls = 0, priceCalls = 0;
  const sleeps = [];
  const reader = createExchangeReader({ clock: () => now, sleep: async delay => { sleeps.push(delay); }, fetcher: async input => {
    const f = fixtures(now);
    if (input.endsWith('/exchangeInfo')) return Response.json(f.binanceInstruments);
    if (input.endsWith('/premiumIndex')) { priceCalls++; return Response.json(f.binanceTickers); }
    fundingCalls++;
    return fundingCalls === 1 ? new Response('private funding limit details', { status: 429 }) : Response.json(f.binanceFunding);
  } });
  const initial = await Promise.all(['oil', 'hynix'].map(id => reader('binance', id)));
  for (const value of initial) {
    assert.equal(value.status, 'live'); assert.ok(value.left.price > 0);
    assert.equal(value.fundingFetchedAt, null); assert.equal(calculateExchangeSpread(value).shortAnnualized, null);
  }
  now += 1500;
  const duringCooldown = await reader('binance', 'oil');
  assert.equal(duringCooldown.fetchedAt, new Date(now).toISOString());
  assert.equal(fundingCalls, 1); assert.equal(priceCalls, 2); assert.deepEqual(sleeps, []);
  now = NOW + 60_000;
  const recovered = await reader('binance', 'hynix');
  assert.equal(fundingCalls, 2); assert.equal(priceCalls, 3);
  assert.equal(recovered.left.fundingIntervalHours, 8);
  assert.equal(recovered.fundingFetchedAt, new Date(now).toISOString());
});

test('a Binance IP ban is shared across markets and expires before network reads resume', async () => {
  let now = NOW, banned = true;
  const calls = [], sleeps = [];
  const reader = createExchangeReader({ clock: () => now, sleep: async delay => { sleeps.push(delay); }, fetcher: async input => {
    const endpoint = new URL(input).pathname.split('/').at(-1); calls.push(endpoint);
    const f = fixtures(now);
    if (endpoint === 'premiumIndex' && banned) return new Response('private ban details', { status: 418 });
    return Response.json(endpoint === 'exchangeInfo' ? f.binanceInstruments : endpoint === 'fundingInfo' ? f.binanceFunding : f.binanceTickers);
  } });
  const first = await Promise.allSettled(['oil', 'hynix'].map(id => reader('binance', id)));
  assert.ok(first.every(result => result.status === 'rejected' && result.reason.httpStatus === 418));
  const initialCount = calls.length;
  now += 61_000; banned = false;
  for (const id of ['oil', 'hynix']) await assert.rejects(reader('binance', id), error => error.httpStatus === 418);
  assert.equal(calls.length, initialCount); assert.deepEqual(sleeps, []);
  now = NOW + 120_000;
  const recovered = await Promise.all(['oil', 'hynix'].map(id => reader('binance', id)));
  assert.equal(calls.length, initialCount + 3);
  assert.ok(recovered.every(value => value.fetchedAt === new Date(now).toISOString()));
});

test('invalid Binance quote data is not retried or repaired by a fresh local timestamp', async () => {
  for (const corrupt of [
    f => { f.binanceTickers[0].markPrice = ''; },
    f => { f.binanceTickers.forEach(row => { row.time = NOW - 121_000; }); },
  ]) {
    const calls = [], sleeps = [], f = fixtures(); corrupt(f);
    const reader = createExchangeReader({ clock: () => NOW, sleep: async delay => { sleeps.push(delay); }, fetcher: async input => {
      const endpoint = new URL(input).pathname.split('/').at(-1); calls.push(endpoint);
      return Response.json(endpoint === 'exchangeInfo' ? f.binanceInstruments : endpoint === 'fundingInfo' ? f.binanceFunding : f.binanceTickers);
    } });
    await assert.rejects(reader('binance', 'oil'), error => error.kind === 'invalid_data' && error.endpoint === 'quote');
    assert.equal(calls.length, 3); assert.deepEqual(sleeps, []);
  }
});

test('a malformed Binance oil pair does not suppress the concurrently requested Hynix quote', async () => {
  const calls = [], f = fixtures(); f.binanceTickers[0].markPrice = '';
  const reader = createExchangeReader({ clock: () => NOW, sleep: async () => assert.fail('invalid data must not retry'), fetcher: async input => {
    const endpoint = new URL(input).pathname.split('/').at(-1); calls.push(endpoint);
    return Response.json(endpoint === 'exchangeInfo' ? f.binanceInstruments : endpoint === 'fundingInfo' ? f.binanceFunding : f.binanceTickers);
  } });
  const [oil, hynix] = await Promise.allSettled(['oil', 'hynix'].map(id => reader('binance', id)));
  assert.equal(oil.status, 'rejected'); assert.equal(oil.reason.kind, 'invalid_data');
  assert.equal(hynix.status, 'fulfilled'); assert.equal(hynix.value.left.price, 180);
  assert.equal(calls.length, 3);
});

test('malformed or unavailable Binance funding metadata preserves prices and retries without poisoning the cache', async () => {
  let now = NOW, fundingCalls = 0;
  const reader = createExchangeReader({ clock: () => now, fetcher: async input => {
    const f = fixtures(now);
    if (input.endsWith('/exchangeInfo')) return Response.json(f.binanceInstruments);
    if (input.endsWith('/premiumIndex')) return Response.json(f.binanceTickers);
    fundingCalls++;
    return Response.json(fundingCalls === 1 ? { error: 'temporary' } : f.binanceFunding);
  } });
  const missing = await reader('binance', 'hynix');
  assert.equal(missing.left.price, 180); assert.equal(calculateExchangeSpread(missing).shortAnnualized, null);
  now += 15000;
  assert.equal((await reader('binance', 'hynix')).left.fundingIntervalHours, 8);
  assert.equal(fundingCalls, 2);
});

test('repeated instrument cursors and duplicate contracts fail instead of publishing an arbitrary match', async () => {
  const f = fixtures();
  const reader = createExchangeReader({ clock: () => NOW, fetcher: async input => Response.json(input.includes('/tickers') ? f.bybitTickers : { retCode: 0, result: { category: 'linear', list: f.bybitInstruments, nextPageCursor: 'same' } }) });
  await assert.rejects(reader('bybit', 'oil'), /pagination/);
  assert.throws(() => parseBybitQuote('oil', [...f.bybitInstruments, f.bybitInstruments[0]], f.bybitTickers, NOW), /duplicate/);
});

test('new exchange snapshots survive restart and upstream failure; all APIs and first-render reads remain database-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'market-exchange-test-'));
  let store, services, server;
  try {
    const now = Date.now(); store = await openMarketStore(join(directory, 'market.sqlite'));
    for (const id of ['oil', 'hynix']) for (const exchange of comparisonExchanges(id).filter(exchange => exchange !== 'hyperliquid')) store.write(id, `exchanges/${exchange}/quote`, quote(exchange, id, now));
    const collector = createMarketCollector(store, { jobs: [] });
    await collector.collect({ id: 'hynix', action: 'exchanges/bybit/quote', load() { throw Error('offline'); } });
    const snapshot = store.read('hynix', 'exchanges/bybit/quote');
    assert.equal(snapshot.status, 'snapshot'); assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
    assert.equal(externalQuoteStale(snapshot, now), true);
    await collector.collect({ id: 'oil', action: 'exchanges/lighter/quote', load() { throw Error('offline'); } });
    const retained = store.read('oil', 'exchanges/lighter/quote');
    assert.equal(retained.status, 'snapshot'); assert.equal(retained.fetchedAt, new Date(now).toISOString());
    assert.equal(retained.left.price, 104);
    await collector.stop(); store.close(); store = null;
    services = await createMonitorServices(directory, { env: {}, marketOptions: { jobs: [] } });
    server = createServer(createHandler({ services, username: 'admin', password: 'exchange-test-password', nextHandler(_req, res) { res.writeHead(404).end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Basic ${Buffer.from('admin:exchange-test-password').toString('base64')}` };
    const before = services.market.status();
    for (const id of ['oil', 'hynix']) for (const exchange of comparisonExchanges(id).filter(exchange => exchange !== 'hyperliquid')) {
      const url = `${base}/api/monitors/${id}/exchanges/${exchange}/quote`;
      assert.equal((await fetch(url)).status, 401);
      const response = await fetch(url, { headers }); assert.equal(response.status, 200);
      const data = await response.json(); assert.equal(data.collection.source, 'database'); assert.equal(data.exchange, exchange); assert.equal(data.fetchedAt, new Date(now).toISOString());
      assert.equal((await fetch(url, { headers, method: 'POST' })).status, 405);
    }
    const initial = await readInitialMarket(services);
    assert.equal(initial.hynix.exchanges.bybit.status, 'snapshot'); assert.equal(initial.oil.exchanges.binance.left.price, 104);
    for (const exchange of ['lighter', 'variational', 'okx', 'bitget']) assert.equal(initial.oil.exchanges[exchange].left.price, 104);
    for (const exchange of ['lighter', 'variational']) {
      assert.equal(initial.hynix.exchanges[exchange], undefined);
      assert.equal((await fetch(`${base}/api/monitors/hynix/exchanges/${exchange}/quote`, { headers })).status, 404);
    }
    for (const exchange of ['okx', 'bitget', 'gate']) assert.equal(initial.hynix.exchanges[exchange].left.symbol, exchangeDefinition(exchange, 'hynix').left);
    assert.equal(initial.oil.exchanges.gate, undefined);
    assert.equal((await fetch(`${base}/api/monitors/oil/exchanges/gate/quote`, { headers })).status, 404);
    assert.equal(initial.oil.exchanges.lighter.status, 'snapshot');
    assert.deepEqual(services.market.status(), before);
    const jobs = marketJobs().filter(job => job.action.startsWith('exchanges/') && job.action.endsWith('/quote'));
    assert.equal(jobs.length, 12); assert.ok(jobs.every(job => job.intervalMs === 15000));
    assert.equal(jobs.filter(job => job.id === 'hynix').length, 5);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (services) { await Promise.all([...services.values()].map(service => service.stop())); await services.market.stop(); await services.notifications.stop(); }
    store?.close(); await rm(directory, { recursive: true, force: true });
  }
});

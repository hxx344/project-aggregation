import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createPerpetualMetricsReader, sanitizePerpetualMetricsReaderState } from '../server/perpetual-metrics-reader.mjs';

const STEP = 300_000, NOW = Date.UTC(2026, 9, 8, 12);
const market = (exchange, symbol = 'BTCUSDT', extra = {}) => ({ exchange, symbol, base: 'BTC', rawBase: 'BTC', quoteCurrency: 'USDT', multiplier: 1, ...extra });
const reply = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
function fixture(handler, options = {}) {
  const calls = []; let now = NOW;
  const reader = createPerpetualMetricsReader({ fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init, now); }, clock: () => now, hostSpacingMs: 0, ...options });
  return { reader, calls, advance: ms => { now += ms; } };
}

test('Bybit shares one bulk request across contracts and preserves zero, currency, and single-side OI', async () => {
  const f = fixture(() => reply({ retCode: 0, time: NOW, result: { list: [
    { symbol: 'BTCUSDT', turnover24h: '0', singleOpenInterestValue: '125', openInterestValue: '250' },
    { symbol: 'ETHUSDC', turnover24h: '300', openInterestValue: '800' },
  ] } }));
  const [btc, eth] = await Promise.all([f.reader(market('bybit')), f.reader(market('bybit', 'ETHUSDC', { quoteCurrency: 'USDC' }))]);
  assert.equal(f.calls.length, 1); assert.equal(btc.volume24h.value, 0); assert.equal(btc.openInterest.value, 125);
  assert.equal(eth.volume24h.currency, 'USDC'); assert.equal(eth.openInterest.value, 400); assert.match(eth.openInterest.source, /双边值 ÷ 2/);
  await f.reader(market('bybit')); assert.equal(f.calls.length, 1);
  f.advance(29_999); await f.reader(market('bybit')); assert.equal(f.calls.length, 1);
  f.advance(1); const repeated = await f.reader(market('bybit')); assert.equal(f.calls.length, 2);
  assert.equal(repeated.openInterest.observedAt, NOW, 'A successful recheck cannot replace the unchanged source timestamp');
});

test('Binance volume is bulk, OI requests are deduplicated by symbol, and source time is retained', async () => {
  const f = fixture(url => url.includes('ticker/24hr') ? reply([{ symbol: 'BTCUSDT', quoteVolume: '500', closeTime: NOW - 1000 }, { symbol: 'ETHUSDT', quoteVolume: '600', closeTime: NOW - 2000 }]) : reply([{ symbol: new URL(url).searchParams.get('symbol'), sumOpenInterestValue: '70', timestamp: NOW - STEP }]));
  const [a, b] = await Promise.all([f.reader(market('binance')), f.reader(market('binance')), f.reader(market('binance', 'ETHUSDT'))]);
  assert.equal(f.calls.length, 3); assert.equal(f.calls.filter(row => row.url.includes('ticker/24hr')).length, 1);
  assert.equal(a.openInterest.value, 70); assert.equal(a.openInterest.observedAt, NOW - STEP); assert.equal(b.volume24h.observedAt, NOW - 1000);
  assert.ok(f.calls.every(row => row.init.credentials === 'omit' && row.init.redirect === 'error'));
});

test('Binance partial OI failure leaves valid turnover available without repeated failed upstream requests', async () => {
  const f = fixture(url => url.includes('ticker/24hr') ? reply([{ symbol: 'BTCUSDT', quoteVolume: '50', closeTime: NOW }]) : { ok: false, status: 500 });
  const result = await f.reader(market('binance'));
  assert.equal(result.volume24h.value, 50); assert.equal(result.openInterest.value, null); assert.match(result.openInterest.error, /失败/);
  await f.reader(market('binance')); assert.equal(f.calls.length, 2);
});

test('thirty-second Binance observation refreshes bulk volume while five-minute OI keeps its own publication time and cache', async () => {
  const f = fixture((url, _init, now) => url.includes('ticker/24hr')
    ? reply([{ symbol: 'BTCUSDT', quoteVolume: '500', closeTime: now }])
    : reply([{ symbol: 'BTCUSDT', sumOpenInterestValue: '70', timestamp: Math.floor(now / STEP) * STEP - STEP }]));
  await f.reader(market('binance')); assert.equal(f.calls.length, 2); assert.equal(f.reader.isCached(market('binance')), true);
  f.advance(30_000); assert.equal(f.reader.isCached(market('binance')), false);
  const next = await f.reader(market('binance'));
  assert.equal(next.volume24h.observedAt, NOW + 30_000); assert.equal(next.openInterest.observedAt, NOW - STEP);
  assert.equal(f.calls.filter(call => call.url.includes('openInterestHist')).length, 1);
  f.advance(STEP - 30_000); const later = await f.reader(market('binance'));
  assert.equal(f.calls.filter(call => call.url.includes('openInterestHist')).length, 2);
  assert.equal(later.openInterest.observedAt, NOW);
});

test('Bitget requests one snapshot per product and never reapplies token normalization to money', async () => {
  const f = fixture(url => reply({ code: '00000', data: [{ symbol: url.endsWith('USDC-FUTURES') ? 'BTCUSDC' : '1000PEPEUSDT', quoteVolume: '200', holdingAmount: '30', markPrice: '0.5', ts: NOW }] }));
  const pepe = await f.reader(market('bitget', '1000PEPEUSDT', { multiplier: 1000, productType: 'USDT-FUTURES' }));
  const usdC = await f.reader(market('bitget', 'BTCUSDC', { quoteCurrency: 'USDC', productType: 'USDC-FUTURES' }));
  assert.equal(pepe.volume24h.value, 200); assert.equal(pepe.openInterest.value, 15); assert.equal(usdC.openInterest.currency, 'USDC'); assert.equal(f.calls.length, 2);
  await assert.rejects(f.reader(market('bitget', 'BTCUSDC', { quoteCurrency: 'USDC', productType: 'USDT-FUTURES' })), /产品类型/);
});

test('Gate contracts require an independently verified face value, with no default multiplier', async () => {
  const f = fixture(() => reply([{ contract: 'BTC_USDT', total_size: '100', mark_price: '50000', volume_24h_quote: '200' }]));
  const absent = await f.reader(market('gate', 'BTC_USDT'));
  assert.equal(absent.openInterest.value, null); assert.equal(absent.volume24h.value, 200);
  const sized = await f.reader(market('gate', 'BTC_USDT', { contractSize: 0.0001, multiplier: 1000 }));
  assert.equal(sized.openInterest.value, 500); assert.equal(sized.openInterest.currency, 'USDT'); assert.equal(f.calls.length, 1);
});

test('Kraken only converts catalog-verified PF linear contracts and validates pair identity', async () => {
  const f = fixture(() => reply({ result: 'success', serverTime: new Date(NOW).toISOString(), tickers: [{ symbol: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', volumeQuote: 230000, openInterest: 2, markPrice: 50000 }] }));
  const result = await f.reader(market('kraken', 'PF_XBTUSD', { quoteCurrency: 'USD', contractKind: 'linear' }));
  assert.equal(result.volume24h.value, 230000); assert.equal(result.openInterest.value, 100000); assert.equal(result.openInterest.currency, 'USD');
  await assert.rejects(f.reader(market('kraken', 'PI_XBTUSD', { quoteCurrency: 'USD' })), error => error.code === 'UNSUPPORTED');
});

test('Hyperliquid matches metadata positions and preserves native vs HIP-3 namespaces and quote denomination', async () => {
  const f = fixture((_url, init) => { const body = JSON.parse(init.body); return reply([{ collateralToken: 0, universe: [{ name: body.dex ? 'io:SNDK' : 'kPEPE' }] }, [{ dayNtlVlm: '500', openInterest: '30', markPx: '0.01' }]]); });
  const a = await f.reader(market('hyperliquid', 'kPEPE', { multiplier: 1000 }));
  const b = await f.reader(market('entropy', 'io:SNDK', { dex: 'io', quoteCurrency: 'USDC' }));
  assert.equal(a.openInterest.value, 0.3); assert.equal(a.openInterest.currency, 'USDT'); assert.equal(b.openInterest.currency, 'USDC');
  assert.equal(f.calls.length, 2); assert.equal(JSON.parse(f.calls[1].init.body).dex, 'io');
  await assert.rejects(f.reader(market('entropy', 'SNDK', { dex: 'io', quoteCurrency: 'USDC' })), /命名空间/);
});

test('Lighter deployments never share a cache or assume the undocumented OI denomination', async () => {
  const f = fixture(() => reply({ code: 200, order_book_details: [{ market_id: 1, symbol: 'BTC', market_type: 'perp', daily_quote_token_volume: 900, open_interest: 999, mark_price: '50000' }] }));
  const a = await f.reader(market('lighter', 'BTC', { marketId: 1, quoteCurrency: 'USDC' }));
  const b = await f.reader(market('rh-lighter', 'BTC', { marketId: 1, quoteCurrency: 'USDG' }));
  assert.equal(a.volume24h.currency, 'USDC'); assert.equal(b.volume24h.currency, 'USDG');
  assert.equal(a.openInterest.value, null); assert.match(a.openInterest.error, /单位/); assert.equal(new Set(f.calls.map(row => new URL(row.url).host)).size, 2);
  await assert.rejects(f.reader(market('lighter', 'ETH', { marketId: 1, quoteCurrency: 'USDC' })), /标识不匹配/);
});

test('Aster uses documented bulk quote volume without inventing an OI endpoint', async () => {
  const f = fixture(() => reply([{ symbol: 'BTCUSD1', quoteVolume: '1000', closeTime: NOW }]));
  const result = await f.reader(market('aster', 'BTCUSD1', { quoteCurrency: 'USD1' }));
  assert.equal(result.volume24h.currency, 'USD1'); assert.equal(result.openInterest.value, null); assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /ticker\/24hr$/);
});

const candles = (end, { hole, unconfirmed = false } = {}) => Array.from({ length: 289 }, (_, index) => {
  const time = end - index * STEP;
  return [String(time), '1', '2', '1', '2', '100', '9999', String(index === 0 ? 99999 : 10), index === 0 || unconfirmed ? '0' : '1'];
}).filter(row => Number(row[0]) !== hole);
function okxFixture(options = {}) {
  return fixture((url, _init, now) => {
    if (url.includes('open-interest')) return reply({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', oiUsd: '300', ts: now }] });
    const limit = Number(new URL(url).searchParams.get('limit'));
    return reply({ code: '0', data: candles(Math.floor(now / STEP) * STEP, options).slice(0, limit) });
  });
}
const okx = () => market('okx', 'BTC-USDT-SWAP');

test('OKX adds 288 complete quote-volume candles and incrementally fetches only new bars', async () => {
  const f = okxFixture(), a = await f.reader(okx());
  assert.equal(a.volume24h.value, 2880); assert.equal(a.volume24h.observedAt, NOW); assert.equal(a.volume24h.currency, 'USDT'); assert.equal(a.openInterest.currency, 'USD');
  assert.equal(a.readerState.candles.length, 288); assert.match(f.calls.find(row => row.url.includes('candles')).url, /limit=300/);
  f.advance(STEP); const b = await f.reader(okx(), { readerState: a.readerState });
  assert.equal(b.volume24h.value, 2880); assert.equal(b.volume24h.observedAt, NOW + STEP);
  assert.ok(Number(new URL(f.calls.at(-1).url).searchParams.get('limit')) <= 4);
});

test('OKX thirty-second OI observations reuse complete five-minute volume candles without changing their cutoff', async () => {
  const f = okxFixture(); await f.reader(okx());
  f.advance(30_000); const next = await f.reader(okx());
  assert.equal(next.volume24h.observedAt, NOW); assert.equal(next.openInterest.observedAt, NOW + 30_000);
  assert.equal(f.calls.filter(call => call.url.includes('candles')).length, 1);
  assert.equal(f.calls.filter(call => call.url.includes('open-interest')).length, 2);
  f.advance(STEP - 30_000); const later = await f.reader(okx());
  assert.equal(later.volume24h.observedAt, NOW + STEP); assert.equal(f.calls.filter(call => call.url.includes('candles')).length, 2);
});

test('OKX incomplete or unconfirmed history is missing, not zero or base volume times last price', async () => {
  const f = okxFixture({ hole: NOW - 140 * STEP }), result = await f.reader(okx());
  assert.equal(result.volume24h.value, null); assert.match(result.volume24h.error, /完整/); assert.equal(result.openInterest.value, 300);
  const unconfirmed = await okxFixture({ unconfirmed: true }).reader(okx()); assert.equal(unconfirmed.volume24h.value, null);
});

test('OKX restart restores complete candle state and does not refill a full day', async () => {
  const f = okxFixture(), saved = await f.reader(okx());
  const next = okxFixture(); next.advance(STEP); const result = await next.reader(okx(), { readerState: saved.readerState });
  assert.equal(result.volume24h.value, 2880); assert.ok(next.calls.filter(row => row.url.includes('candles')).every(row => Number(new URL(row.url).searchParams.get('limit')) <= 4));
  assert.equal(sanitizePerpetualMetricsReaderState({ ...saved.readerState, currency: 'USD' }, okx(), NOW), undefined);
  assert.equal(sanitizePerpetualMetricsReaderState({ ...saved.readerState, candles: [[NOW, 5]] }, okx(), NOW), undefined);
});

test('missing, malformed, negative, future and duplicate response fields cannot become amounts', async () => {
  for (const value of ['', ' ', null, undefined, false, [], -1, 'NaN', 'Infinity']) {
    const f = fixture(() => reply({ retCode: 0, time: NOW, result: { list: [{ symbol: 'BTCUSDT', turnover24h: value }] } }));
    assert.equal((await f.reader(market('bybit'))).volume24h.value, null);
  }
  const future = fixture(() => reply({ retCode: 0, time: NOW + 6000, result: { list: [{ symbol: 'BTCUSDT', turnover24h: '10' }] } }));
  assert.equal((await future.reader(market('bybit'))).volume24h.value, null);
  const duplicate = fixture(() => reply({ retCode: 0, time: NOW, result: { list: [{ symbol: 'BTCUSDT' }, { symbol: 'BTCUSDT' }] } }));
  await assert.rejects(duplicate.reader(market('bybit')), /重复/);
});

test('one canceled caller does not cancel a shared batch needed by another caller', async () => {
  let release, requestSignal;
  const f = fixture((_url, init) => { requestSignal = init.signal; return new Promise(resolve => { release = () => resolve(reply({ retCode: 0, time: NOW, result: { list: [{ symbol: 'BTCUSDT', turnover24h: '7' }] } })); }); });
  const controller = new AbortController(), a = f.reader(market('bybit'), { signal: controller.signal }), b = f.reader(market('bybit'));
  await turn(); controller.abort(); await assert.rejects(a, /Aborted/); assert.equal(requestSignal.aborted, false);
  release(); assert.equal((await b).volume24h.value, 7); assert.equal(f.calls.length, 1);
});

test('failed bulk requests are cached, honor retry-after, and malformed market identity cannot choose hosts', async () => {
  const f = fixture(() => ({ ok: false, status: 429, headers: { get: () => '120' } }));
  for (let n = 0; n < 2; n++) await assert.rejects(f.reader(market('bybit')), error => error.status === 429 && error.retryAfterMs === 120000);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.reader(market('bybit', 'BTC?host=evil')), /元数据/); assert.equal(f.calls.length, 1);
  f.reader.stop();
});

test('a rate-limited first Binance request promptly rejects queued sibling work without waiting out the host ban', async () => {
  const f = fixture(() => ({ ok: false, status: 429, headers: { get: () => '120' } }));
  const result = f.reader(market('binance'));
  const bounded = await Promise.race([result.then(() => 'resolved', error => error), turn().then(() => 'still pending')]);
  assert.equal(bounded.status, 429); assert.equal(bounded.retryAfterMs, 120_000);
  assert.equal(f.calls.length, 1); assert.equal(f.reader.metrics().queued, 0); assert.equal(f.reader.retryAt(market('binance')), NOW + 120_000);
  f.reader.stop();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverKrakenMarkets, createKrakenSubscriptions, parseKrakenMessage } from '../modules/perpetual/kraken.mjs';
import { EXCHANGES, discoverMarkets, createSubscriptions, parseMessage, getControlResponse } from '../modules/perpetual/exchanges.mjs';
import { mergePerpetualQuote } from '../server/perpetual-service.mjs';

const NOW = 1_790_000_000_000;
const instrument = (change = {}) => ({ symbol: 'PF_XBTUSD', base: 'BTC', quote: 'USD', pair: 'BTC:USD', type: 'flexible_futures', contractSize: 1, tradeable: true, tradfi: false, isExpired: false, postOnly: false, ...change });
const response = instruments => async () => ({ ok: true, json: async () => ({ result: 'success', instruments }) });
const markets = () => discoverKrakenMarkets({ fetchImpl: response([instrument()]), now: NOW });
const ticker = (change = {}) => ({ feed: 'ticker', product_id: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', time: NOW,
  bid: 100, ask: 101, bid_size: 2, ask_size: 3, markPrice: 100.5, last: 100.2, suspended: false, post_only: false, ...change });

test('Kraken directory maps official BTC identity without inferring its asset from native XBT', async () => {
  const calls = [];
  const rows = await discoverMarkets('kraken', { now: NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ result: 'success', instruments: [instrument(), instrument({ symbol: 'PF_ETHUSD', base: 'ETH', pair: 'ETH:USD' })] }) };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://futures.kraken.com/derivatives/api/v3/instruments');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(rows.map(row => row.base), ['BTC', 'ETH']);
  assert.equal(rows[0].rawBase, 'BTC');
  assert.equal(rows[0].symbol, 'PF_XBTUSD');
  assert.equal(rows[0].crossexSymbol, 'KRAKEN_FUTURE_BTC_USD');
  assert.equal(rows[0].quoteCurrency, 'USD');
  assert.equal(rows[0].settlementCurrency, 'USD');
  assert.equal(rows[0].collateralCurrency, 'MULTI');
  assert.equal(rows[0].contractKind, 'linear');
  assert.equal(rows[0].identityVerified, true);
  assert.match(rows[0].identitySource, /tradfi=false/);
  assert.equal(rows[0].fundingIntervalHours, null);
  assert.ok(EXCHANGES.some(row => row.id === 'kraken' && row.kind === 'cex'));
});

test('Kraken discovery excludes inverse, fixed, non-unit, RWA, unknown and unavailable contracts', async () => {
  const variants = [
    { type: 'futures_inverse', symbol: 'PI_XBTUSD' }, { symbol: 'FF_XBTUSD_260930' },
    { contractSize: 100 }, { contractSize: null }, { tradfi: true }, { tradfi: undefined },
    { isExpired: true }, { isExpired: undefined }, { tradeable: false }, { tradeable: undefined },
    { postOnly: true }, { quote: 'USDT' }, { base: undefined }, { base: 'ETH' },
    { symbol: 'PF_XBTUSD_260930' }, { lastTradingTime: 'invalid' },
    { lastTradingTime: new Date(NOW - 1).toISOString() },
  ];
  assert.deepEqual(await discoverKrakenMarkets({ fetchImpl: response(variants.map(instrument)), now: NOW }), []);
});

test('Kraken lifecycle retains a future delisting deadline and rejects duplicate directory identities', async () => {
  const [row] = await discoverKrakenMarkets({ fetchImpl: response([instrument({ lastTradingTime: new Date(NOW + 60_000).toISOString() })]), now: NOW });
  assert.equal(row.delisting, true); assert.equal(row.delistingAt, NOW + 60_000);
  await assert.rejects(discoverKrakenMarkets({ fetchImpl: response([instrument(), instrument()]) }), /duplicate/);
  await assert.rejects(discoverKrakenMarkets({ fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
  await assert.rejects(discoverKrakenMarkets({ fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'error', instruments: [] }) }) }), /invalid market list/);
});

test('Kraken subscriptions are bounded, isolated and include server heartbeat once per connection', async () => {
  const [row] = await markets();
  const list = Array.from({ length: 205 }, (_, i) => ({ ...row, symbol: `PF_C${i}USD` }));
  const subscriptions = createSubscriptions('kraken', [...list, { exchange: 'binance', symbol: 'BTCUSDT' }]);
  assert.deepEqual(subscriptions.map(item => item.markets.length), [100, 100, 5]);
  assert.deepEqual(subscriptions.map(item => item.startDelayMs), [0, 500, 1000]);
  for (const item of subscriptions) {
    assert.equal(item.url, 'wss://futures.kraken.com/ws/v1');
    assert.deepEqual(item.subscribe[0], { event: 'subscribe', feed: 'heartbeat' });
    assert.deepEqual(item.subscribe[1].product_ids, item.markets.map(market => market.symbol));
    assert.equal(item.heartbeat, undefined, 'Do not repeatedly resubscribe to heartbeat');
  }
  assert.deepEqual(createKrakenSubscriptions([]), []);
});

test('Kraken full ticker keeps source time and cash funding is never treated as a rate', async () => {
  const list = await markets();
  const [quote] = parseMessage('kraken', JSON.stringify(ticker({ funding_rate: 5, relative_funding_rate: 0.001 })), list, NOW + 100);
  assert.equal(quote.bid, 100); assert.equal(quote.ask, 101);
  assert.equal(quote.mark, 100.5); assert.equal(quote.last, 100.2);
  assert.equal(quote.sourceTime, NOW); assert.equal(quote.receivedAt, NOW + 100);
  assert.equal(quote.base, 'BTC'); assert.equal(quote.quoteCurrency, 'USD');
  assert.equal(quote.collateralCurrency, 'MULTI'); assert.equal(quote.settlementCurrency, 'USD');
  assert.equal(Object.hasOwn(quote, 'fundingRate'), false);
  const merged = mergePerpetualQuote(null, quote, NOW + 100);
  assert.equal(merged.bidAskAt, NOW); assert.equal(merged.fundingRate, null);
});

test('Kraken invalid identities, absent and future timestamps never confirm prices', async () => {
  const list = await markets();
  for (const change of [{ product_id: 'PF_ETHUSD' }, { pair: 'ETH:USD' }, { pair: 'XBT:USDT' }, { pair: undefined },
    { tag: 'month' }, { tag: undefined }, { time: undefined }, { time: null }, { time: 0 }, { time: NOW / 1000 }, { time: NOW + 5001 }]) {
    assert.deepEqual(parseKrakenMessage(ticker(change), list, NOW), []);
  }
});

test('Kraken out-of-order tickers cannot replace a newer book', async () => {
  const list = await markets(), context = {};
  assert.equal(parseKrakenMessage(ticker(), list, NOW, context).length, 1);
  assert.deepEqual(parseKrakenMessage(ticker({ time: NOW - 1, bid: 9 }), list, NOW, context), []);
  assert.equal(parseKrakenMessage(ticker({ time: NOW + 1, bid: 99 }), list, NOW + 1, context)[0].bid, 99);
});

test('Kraken mark-only updates keep old BBO time and malformed one-sided updates cannot revive it', async () => {
  const list = await markets();
  const first = mergePerpetualQuote(null, parseKrakenMessage(ticker(), list, NOW)[0], NOW);
  const [update] = parseKrakenMessage({ feed: 'ticker', product_id: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', time: NOW + 1000, markPrice: 102, bid: 101 }, list, NOW + 1000);
  assert.equal(Object.hasOwn(update, 'bid'), false); assert.equal(Object.hasOwn(update, 'ask'), false);
  const merged = mergePerpetualQuote(first, update, NOW + 1000);
  assert.equal(merged.mark, 102); assert.equal(merged.bid, 100); assert.equal(merged.bidAskAt, NOW);
  assert.deepEqual(parseKrakenMessage({ feed: 'ticker', product_id: 'PF_XBTUSD', pair: 'XBT:USD', tag: 'perpetual', time: NOW + 1000, funding_rate: 5 }, list, NOW + 1000), []);
});

test('Kraken suspension, post-only and empty sides invalidate executable books', async () => {
  const list = await markets();
  for (const change of [{ suspended: true }, { post_only: true }]) {
    const [quote] = parseKrakenMessage(ticker(change), list, NOW);
    assert.equal(quote.bid, null); assert.equal(quote.ask, null);
  }
  const [quote] = parseKrakenMessage(ticker({ bid_size: 0, ask_size: null }), list, NOW);
  assert.equal(quote.bid, null); assert.equal(quote.ask, null);
});

test('Kraken acknowledges heartbeat without quotes and subscription failures reach the reconnect path', async () => {
  const list = await markets();
  for (const payload of [{ event: 'subscribed', feed: 'ticker' }, { feed: 'heartbeat', time: NOW }]) {
    assert.deepEqual(parseMessage('kraken', payload, list, NOW), []);
    assert.equal(getControlResponse('kraken', payload), null);
  }
  for (const event of ['error', 'subscribed_failed', 'unsubscribed_failed']) assert.throws(() => parseMessage('kraken', { event, message: 'Invalid product id' }, list, NOW), /Invalid product id/);
});

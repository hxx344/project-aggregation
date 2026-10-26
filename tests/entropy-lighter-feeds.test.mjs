import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { attachFeeFacts, createFeedDecoder, deriveAutoFees, discover, parseMetadata, retryNotBefore, startFeeds } from '../tools/entropy-lighter-lab/feeds.mjs';

const entropyBody = [{ collateralToken: 0, universe: [
  { name: 'io:ANTH', szDecimals: 3, maxLeverage: 6, onlyIsolated: true, marginMode: 'noCross', growthMode: 'enabled', deployerFeeScale: '1.0' },
  { name: 'io:SNDK', szDecimals: 4, maxLeverage: 15, growthMode: 'enabled', deployerFeeScale: '1.0' },
] }, [{ funding: '0.00001' }, { funding: '0.00004' }]];
const lighterBody = { code: 200, order_book_details: [
  { symbol: 'ANTHROPIC', market_id: 193, market_type: 'perp', status: 'active', multiplier: '1', size_decimals: 5, price_decimals: 1, taker_fee: '0.0000', is_taker_fee_enabled: true },
  { symbol: 'SNDK', market_id: 139, market_type: 'perp', status: 'active', multiplier: '1', size_decimals: 4, price_decimals: 2, taker_fee: '0.0000', is_taker_fee_enabled: true },
] };
const entropyFees = { feeSchedule: { cross: '0.00045' }, userCrossRate: '0.00001', activeReferralDiscount: '0.5' };
const lighterFees = { user_tiers: [{ name: 'standard', taker_fee_ticks: 0 }, { name: 'premium', taker_fee_ticks: 280 }] };
const binanceBody = { symbols: ['SNDKUSDT', 'ANTHROPICUSDT'].map(symbol => ({ symbol, contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING' })) };
const markets = [...parseMetadata('entropy', entropyBody), ...parseMetadata('lighter', lighterBody), ...parseMetadata('binance', binanceBody)];
const clocks = { receivedAt: 1793014668000, receivedMono: 100 };
function publicBody(url, request) {
  if (url.includes('hyperliquid')) return JSON.parse(request.body).type === 'userFees' ? entropyFees : entropyBody;
  if (url.includes('feeTiers')) return lighterFees;
  return lighterBody;
}
function lighterFrame({ type = 'update/order_book', nonce = 102, begin = 100, bids = [], asks = [], offset = 900, time = 1793014667614074 } = {}) {
  return { channel: 'order_book:139', type, offset, order_book: { bids, asks, nonce, begin_nonce: begin, last_updated_at: time } };
}
function fixtureDecoder() {
  const books = [], diagnostics = [], raw = [], resyncs = [];
  const decoder = createFeedDecoder({ markets, onBook: value => books.push(value), onDiagnostic: value => diagnostics.push(value),
    onRaw: value => raw.push(value), resubscribe: value => resyncs.push(value) });
  return { decoder, books, diagnostics, raw, resyncs };
}

test('metadata preserves native identity and raw funding, disables ANTH, separates USDT', () => {
  const anth = markets.find(x => x.venue === 'entropy' && x.symbol === 'ANTH');
  assert.equal(anth.nativeSymbol, 'io:ANTH');
  assert.equal(anth.simulationEnabled, false);
  assert.equal(anth.identityVerified, false);
  assert.equal(anth.context.funding, '0.00001');
  assert.equal(anth.collateralToken, 0);
  assert.equal(anth.fee.status, 'unavailable');
  const sndk = markets.find(x => x.venue === 'lighter' && x.symbol === 'SNDK');
  assert.equal(sndk.marketId, 139);
  assert.equal(sndk.simulationEnabled, true);
  assert.equal(sndk.quote, 'USDC');
  assert.equal(sndk.raw.taker_fee, '0.0000');
  assert.equal(markets.find(x => x.venue === 'binance').quote, 'USDT');
  assert.throws(() => parseMetadata('lighter', { ...lighterBody, order_book_details: [] }), /missing_market/);
  const scaled = structuredClone(lighterBody);
  scaled.order_book_details[1].multiplier = '100';
  assert.equal(parseMetadata('lighter', scaled).find(x => x.symbol === 'SNDK').simulationEnabled, false);
});

test('automatic Entropy fees use global schedule and asset parameters, never zero-address account discounts', () => {
  const result = attachFeeFacts(parseMetadata('entropy', entropyBody), { feeBody: entropyFees, fetchedAt: clocks.receivedAt });
  for (const market of result) {
    assert.equal(market.fee.status, 'available');
    assert.equal(market.fee.baseTakerBps, 4.5);
    assert.equal(market.fee.takerFeeBps, 0.9);
    assert.equal(market.fee.growthMultiplier, 0.1);
    assert.equal(market.fee.deployerFeeScale, 1);
    assert.equal(market.fee.scope, 'public_default_tier_no_builder');
    assert.equal(market.fee.accountTier, 'default');
    assert.equal(market.fee.expiresAt, clocks.receivedAt + 20 * 60_000);
    assert.match(market.fee.revision, /^[a-f0-9]{64}$/);
    assert.ok(market.fee.assumptions.includes('no_builder_fee_added'));
  }
  assert.notEqual(result[0].fee.revision, result[1].fee.revision);
});

test('HIP-3 fee formula covers both deployer scale branches and rejects unknown modes, collateral and invalid scale', () => {
  const market = parseMetadata('entropy', entropyBody)[0];
  const fee = (raw, collateralToken = 0) => deriveAutoFees({ venue: 'entropy',
    markets: [{ ...market, collateralToken, raw: { ...market.raw, ...raw } }], feeBody: entropyFees }).get(market.nativeSymbol);
  assert.equal(fee({ deployerFeeScale: '0' }).takerFeeBps, 0.45);
  assert.equal(fee({ deployerFeeScale: '0.5' }).takerFeeBps, 0.675);
  assert.equal(fee({ deployerFeeScale: '3.01' }).takerFeeBps.toFixed(6), '2.709000');
  assert.equal(fee({ growthMode: 'disabled', deployerFeeScale: '3' }).takerFeeBps, 27);
  for (const raw of [{ growthMode: undefined }, { growthMode: true }, { growthMode: 'unknown' },
    { deployerFeeScale: null }, { deployerFeeScale: '' }, { deployerFeeScale: -1 }, { deployerFeeScale: 'NaN' },
    { deployerFeeScale: '10' }, { deployerFeeScale: '999' }, { growthMode: 'disabled', deployerFeeScale: '3.01' }]) {
    assert.equal(fee(raw).status, 'unavailable', JSON.stringify(raw));
    assert.equal(fee(raw).takerFeeBps, null);
  }
  assert.equal(fee({}, null).reason, 'unsupported_collateral_token');
  assert.equal(fee({}, 360).reason, 'unsupported_collateral_token');
});

test('fee revision changes only when price-fee semantics change, not refresh time or irrelevant context', () => {
  const source = parseMetadata('entropy', entropyBody);
  const derive = (markets, feeBody = entropyFees, fetchedAt = clocks.receivedAt) => attachFeeFacts(markets, { feeBody, fetchedAt })[0].fee;
  const initial = derive(source);
  assert.equal(derive(source, entropyFees, clocks.receivedAt + 1000).revision, initial.revision);
  assert.equal(derive([{ ...source[0], context: { funding: '0.5', markPx: '99' } }]).revision, initial.revision);
  assert.notEqual(derive(source, { feeSchedule: { cross: '0.0004' } }).revision, initial.revision);
  assert.notEqual(derive([{ ...source[0], raw: { ...source[0].raw, growthMode: 'disabled' } }]).revision, initial.revision);
  for (const cross of [undefined, null, '', 'NaN', 'Infinity', '-0.1', '0', true]) {
    const unavailable = derive(source, { feeSchedule: { cross }, userCrossRate: '0.00045' });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.takerFeeBps, null);
    assert.equal(unavailable.revision, null);
  }
});

test('Lighter Standard fee ticks are automatic, retain exact zero and reject unverified market fee units', () => {
  const source = parseMetadata('lighter', lighterBody);
  const derive = (feeBody = lighterFees, markets = source) => attachFeeFacts(markets, { feeBody, fetchedAt: clocks.receivedAt });
  assert.ok(derive().every(market => market.fee.status === 'available' && market.fee.takerFeeBps === 0));
  assert.equal(derive()[0].fee.accountTier, 'standard');
  assert.equal(derive({ user_tiers: [{ name: 'standard', taker_fee_ticks: 50 }] })[0].fee.takerFeeBps, 0.5);
  for (const ticks of [null, '0', -1, 1.5, Infinity]) {
    assert.equal(derive({ user_tiers: [{ name: 'standard', taker_fee_ticks: ticks }] })[0].fee.status, 'unavailable');
  }
  assert.equal(derive({ user_tiers: [{ name: 'premium', taker_fee_ticks: 0 }] })[0].fee.status, 'unavailable');
  for (const taker_fee of [null, '', '0.001', 'NaN']) {
    const fee = derive(lighterFees, [{ ...source[0], raw: { ...source[0].raw, taker_fee } }])[0].fee;
    assert.equal(fee.status, 'unavailable');
    assert.equal(fee.takerFeeBps, null);
  }
});

test('discovery makes only fixed public fee requests and isolates fee failures from market metadata', async () => {
  const requests = [];
  const diagnostics = [];
  const result = await discover({ cooldowns: {}, onDiagnostic: value => diagnostics.push(value), fetchImpl: async (url, request) => {
    requests.push({ url, request });
    if (url.includes('hyperliquid') && JSON.parse(request.body).type === 'userFees') return new Response('{}', { status: 403 });
    return new Response(JSON.stringify(url.includes('binance') ? binanceBody : publicBody(url, request)));
  } });
  assert.equal(requests.length, 5);
  const entropyRequest = requests.find(({ request }) => request.body && JSON.parse(request.body).type === 'userFees');
  assert.deepEqual(JSON.parse(entropyRequest.request.body), { type: 'userFees', user: '0x0000000000000000000000000000000000000000' });
  assert.ok(requests.some(({ url }) => url.endsWith('/api/v1/feeTiers?filter=perps')));
  assert.equal(result.markets.length, 6);
  assert.ok(result.markets.filter(m => m.venue === 'entropy').every(m => m.status === 'active' && m.fee.reason === 'fee_request_unavailable'));
  assert.ok(result.markets.filter(m => m.venue === 'lighter').every(m => m.fee.status === 'available'));
  assert.ok(diagnostics.some(x => x.event === 'fees_unavailable' && x.venue === 'entropy'));
});

test('a fee endpoint rate limit persists the venue cooldown and prevents new reads without erasing metadata', async () => {
  const cooldowns = {}, calls = [];
  const deadline = Date.now() + 120_000;
  const fetchImpl = async (url, request) => {
    calls.push(url);
    if (url.includes('feeTiers')) return new Response('{}', { status: 429, headers: { 'Retry-After': new Date(deadline).toUTCString() } });
    return new Response(JSON.stringify(url.includes('binance') ? binanceBody : publicBody(url, request)));
  };
  const first = await discover({ cooldowns, fetchImpl });
  assert.equal(first.markets.filter(m => m.venue === 'lighter').length, 2);
  assert.ok(first.markets.filter(m => m.venue === 'lighter').every(m => m.fee.status === 'unavailable'));
  assert.ok(cooldowns.lighter >= deadline - 1000);
  calls.length = 0;
  await discover({ cooldowns, fetchImpl });
  assert.ok(calls.every(url => !url.includes('zklighter')));
});

test('transient fee failures retry at most three times without repeating successful metadata', async () => {
  const calls = { metadata: 0, fees: 0 };
  const result = await discover({ cooldowns: { binance: Date.now() + 60_000, lighter: Date.now() + 60_000 },
    fetchImpl: async (url, request) => {
      const type = JSON.parse(request.body).type;
      if (type === 'metaAndAssetCtxs') { calls.metadata++; return new Response(JSON.stringify(entropyBody)); }
      calls.fees++;
      return calls.fees < 3 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(entropyFees));
    } });
  assert.deepEqual(calls, { metadata: 1, fees: 3 });
  assert.ok(result.markets.filter(m => m.venue === 'entropy').every(m => m.fee.status === 'available'));
});

test('Lighter ignores pre-snapshot deltas; applies absolute sizes and removes zero levels', () => {
  const { decoder, books } = fixtureDecoder();
  decoder.handle('lighter', lighterFrame(), clocks);
  assert.equal(books.length, 0);
  decoder.handle('lighter', lighterFrame({ type: 'subscribed/order_book', nonce: 100, begin: 0,
    bids: [{ price: '10', size: '2' }, { price: '9', size: '3' }], asks: [{ price: '11', size: '4' }] }), clocks);
  decoder.handle('lighter', lighterFrame({ bids: [{ price: '10', size: '0' }, { price: '9', size: '8' }],
    asks: [{ price: '12', size: '7' }], offset: 940 }), { ...clocks, receivedMono: 101 });
  assert.deepEqual(books.at(-1).bids, [[9, 8]]);
  assert.deepEqual(books.at(-1).asks, [[11, 4], [12, 7]]);
  assert.equal(books.at(-1).sequence, '102');
  assert.equal(books.at(-1).sourceAt, 1793014667614.074);
});

test('Lighter gaps invalidate and resubscribe; arbitrary offset jumps do not', () => {
  const { decoder, books, diagnostics, resyncs } = fixtureDecoder();
  const snapshot = lighterFrame({ type: 'subscribed/order_book', nonce: 100, begin: 0,
    bids: [{ price: '10', size: '2' }], asks: [{ price: '11', size: '4' }] });
  decoder.handle('lighter', snapshot, clocks);
  decoder.handle('lighter', lighterFrame({ offset: 9999 }), clocks);
  assert.equal(books.length, 2);
  assert.equal(resyncs.length, 0);
  decoder.handle('lighter', lighterFrame({ nonce: 103, begin: 101 }), clocks);
  assert.equal(books.length, 2);
  assert.equal(resyncs.length, 1);
  assert.equal(diagnostics.at(-1).event, 'invalidated');
  assert.equal(diagnostics.at(-1).reason, 'sequence_gap');
  assert.equal(diagnostics.at(-1).symbol, 'SNDK');
  decoder.handle('lighter', lighterFrame({ nonce: 104, begin: 103 }), clocks);
  assert.equal(books.length, 2);
  decoder.handle('lighter', snapshot, clocks);
  assert.equal(books.length, 3);
});

test('Entropy replaces snapshots, ignores repeated timestamps, invalidates regressions/crosses', () => {
  const { decoder, books, diagnostics, raw } = fixtureDecoder();
  const frame = { channel: 'l2Book', data: { coin: 'io:SNDK', time: clocks.receivedAt,
    levels: [[{ px: '10', sz: '1' }], [{ px: '11', sz: '2' }]] } };
  decoder.handle('entropy', JSON.stringify(frame), clocks);
  decoder.handle('entropy', frame, clocks);
  assert.equal(books.length, 1);
  assert.equal(books[0].sequence, null); // The venue publishes no book sequence.
  assert.equal(raw.length, 2);
  frame.data.time--;
  decoder.handle('entropy', frame, clocks);
  assert.equal(diagnostics.at(-1).reason, 'source_timestamp_regression');
  frame.data.time += 2;
  frame.data.levels[0][0].px = '12';
  decoder.handle('entropy', frame, clocks);
  assert.equal(diagnostics.at(-1).reason, 'empty_or_crossed_book');
});

test('Binance partial depth replaces whole top 20 and never merges USDT into USDC', () => {
  const { decoder, books } = fixtureDecoder();
  decoder.handle('binance', { data: { e: 'depthUpdate', s: 'SNDKUSDT', T: clocks.receivedAt, u: 10,
    b: [['10', '1'], ['9', '2']], a: [['11', '2']] } }, clocks);
  decoder.handle('binance', { data: { e: 'depthUpdate', s: 'SNDKUSDT', T: clocks.receivedAt, u: 12,
    b: [['8', '1']], a: [['11', '2']] } }, clocks);
  assert.deepEqual(books.at(-1).bids, [[8, 1]]);
  assert.equal(books.at(-1).quote, 'USDT');
  assert.equal(books.at(-1).nativeSymbol, 'SNDKUSDT');
});

test('rate limits retain server ban deadlines and discovery honours persisted cooldown', async () => {
  const now = Date.now();
  assert.equal(retryNotBefore({ status: 418, now, body: { msg: `IP banned until ${now + 3_600_000}` } }), now + 3_600_000);
  const cooldowns = { binance: now + 3_600_000 };
  const calls = [];
  const result = await discover({ cooldowns, fetchImpl: async (url, request) => {
    calls.push(url);
    return new Response(JSON.stringify(publicBody(url, request)));
  } });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(x => !x.includes('binance')));
  assert.equal(result.markets.find(x => x.venue === 'binance').status, 'unverified');
  assert.equal(cooldowns.binance, now + 3_600_000);
});

test('HTTP 418 updates shared cooldown with zero automatic retries', async () => {
  let calls = 0;
  const cooldowns = {};
  const deadline = Date.now() + 3_600_000;
  await discover({ cooldowns, fetchImpl: async (url, request) => {
    if (!url.includes('binance')) return new Response(JSON.stringify(publicBody(url, request)));
    calls++;
    return new Response(JSON.stringify({ code: -1003, msg: `banned until ${deadline}` }), { status: 418 });
  } });
  assert.equal(calls, 1);
  assert.equal(cooldowns.binance, deadline);
});

test('HTML rate-limit response still creates a cooldown; metadata RTT stays transport-only', async () => {
  const cooldowns = {}, diagnostics = [];
  const result = await discover({ cooldowns, onDiagnostic: value => diagnostics.push(value), fetchImpl: async (url, request) => {
    if (!url.includes('binance')) return new Response(JSON.stringify(publicBody(url, request)));
    return new Response('<html>Rate limited</html>', { status: 429, headers: { 'Retry-After': '120' } });
  } });
  assert.ok(cooldowns.binance >= result.discoveredAt + 119_000);
  const rtts = diagnostics.filter(x => x.event === 'http_rtt');
  assert.equal(rtts.length, 5);
  assert.ok(rtts.every(x => x.details.rttMs >= 0 && x.details.notOrderLatency === true));
});

test('decoder callback failures propagate instead of masquerading as invalid market data', () => {
  const decoder = createFeedDecoder({ markets, onBook() { throw new Error('disk full'); } });
  assert.throws(() => decoder.handle('entropy', { channel: 'l2Book', data: { coin: 'io:SNDK', time: clocks.receivedAt,
    levels: [[{ px: '10', sz: '1' }], [{ px: '11', sz: '2' }]] } }), error => error.message === 'feed_callback_failed' && error.cause.message === 'disk full');
});

class FakeSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) { this.url = url; FakeSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

test('socket watchdog invalidates stale data, retries finitely per cycle, stop releases timers', async () => {
  FakeSocket.instances = [];
  const diagnostics = [];
  const handle = startFeeds({ markets: markets.filter(x => x.venue === 'entropy'), WebSocketImpl: FakeSocket,
    onDiagnostic: value => diagnostics.push(value), timings: { staleMs: 15, watchdogMs: 5, retryBaseMs: 2, maxAttempts: 2, cooldownMs: 30 } });
  await delay(65);
  await handle.stop();
  assert.ok(diagnostics.some(x => x.event === 'invalidated' && x.reason === 'stale_watchdog'));
  assert.ok(diagnostics.some(x => x.event === 'reconnect_wait' && x.details.waitMs === 30));
  assert.ok(FakeSocket.instances[0].sent.some(x => x.subscription?.fast === true));
  const count = FakeSocket.instances.length;
  await delay(35);
  assert.equal(FakeSocket.instances.length, count);
  assert.ok(FakeSocket.instances.every(x => x.readyState === 3));
});

test('persisted Binance ban blocks WS and can be stopped without waiting for ban expiry', async () => {
  FakeSocket.instances = [];
  const handle = startFeeds({ markets: markets.filter(x => x.venue === 'binance'), WebSocketImpl: FakeSocket,
    cooldowns: { binance: Date.now() + 60_000 } });
  await delay(5);
  assert.equal(FakeSocket.instances.length, 0);
  await handle.stop();
});

test('application pong records transport RTT and public subscriptions only', async () => {
  FakeSocket.instances = [];
  const diagnostics = [];
  const handle = startFeeds({ markets: markets.filter(x => x.venue === 'lighter'), WebSocketImpl: FakeSocket,
    onDiagnostic: value => diagnostics.push(value) });
  await delay(1);
  const socket = FakeSocket.instances[0];
  assert.ok(socket.sent.some(x => x.type === 'ping'));
  assert.ok(socket.sent.every(x => ['subscribe', 'ping'].includes(x.type)));
  socket.message({ type: 'pong' });
  const rtt = diagnostics.find(x => x.event === 'ws_rtt');
  assert.equal(rtt.details.notOrderLatency, true);
  assert.ok(rtt.details.rttMs >= 0);
  await handle.stop();
});

test('live callback failure rejects done and terminates socket instead of retrying', async () => {
  FakeSocket.instances = [];
  const handle = startFeeds({ markets: markets.filter(x => x.venue === 'entropy'), WebSocketImpl: FakeSocket,
    onRaw() { throw new Error('disk full'); } });
  const rejected = assert.rejects(handle.done, /feed_callback_failed/);
  await delay(1);
  FakeSocket.instances[0].message({ channel: 'pong' });
  await rejected;
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(FakeSocket.instances[0].readyState, 3);
});

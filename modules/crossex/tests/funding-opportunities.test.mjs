import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarket } from '../server/market.mjs';
import { pairKey } from '../server/model.mjs';
import { epoch, feed, quote, catalog } from './fixtures.mjs';
import { memoryMarketStore } from './live-market-performance-fixture.mjs';

function fundingQuote(exchange, extra = {}) {
  const base = extra.base ?? 'BTC', currency = extra.quoteCurrency ?? 'USDT';
  return quote(exchange, epoch, { base,
    symbol: exchange === 'okx' ? `${base}-${currency}-SWAP` : exchange === 'bybit' && currency === 'USDC' ? `${base}PERP` : `${base}${currency}`,
    settlementCurrency: currency, collateralCurrency: currency, counterCurrency: currency, contractKind: 'linear',
    crossexSymbol: `${exchange.toUpperCase()}_FUTURE_${base}_${currency}`,
    fundingRate: exchange === 'binance' ? 0.0001 : 0.0003, fundingIntervalHours: 8, fundingAt: epoch,
    nextFundingAt: epoch + 3600000, ...extra });
}
const rulesFor = quotes => quotes.map(q => ({ ...catalog[0], symbol: q.crossexSymbol, exchange_type: q.exchange.toUpperCase(), max_limit_size: '10000' }));
function signal(long, short, extra = {}) {
  const row = { id: `${long.exchange}-${short.exchange}`, base: long.base, quoteCurrency: 'USDT', long, short,
    observedAt: epoch, expiresAt: epoch + 10000, ...extra };
  return { ...row, pairKey: pairKey(row) };
}
async function fixture(t, options = {}) {
  const quotes = options.quotes ?? [fundingQuote('binance'), fundingQuote('bybit')];
  let now = epoch, current = { ...feed(epoch), schemaVersion: 2, quotes, signals: [],
    exchanges: [...new Set(quotes.map(q => q.exchange))].map(id => ({ id, status: 'live' })), ...options.snapshot };
  let rules = options.rules ?? rulesFor(quotes), offline = false;
  const market = createMarket(memoryMarketStore(options.saved), { clock: () => now,
    feedReader: async () => { if (offline) throw new Error('offline'); return current; }, catalogReader: async () => rules,
    identityReader: async () => { throw new Error('discovery must not fetch native identities'); },
    depthReader: async () => { throw new Error('discovery must not fetch depth'); } });
  t.after(() => market.stop()); await market.refresh();
  return { market, rows: () => market.view().fundingOpportunities, snapshot: () => current,
    async setSnapshot(next) { current = next; await market.refreshSource(); },
    async setRules(next) { rules = next; now += 300000; current = { ...current, generatedAt: now }; await market.refresh(); },
    advance(ms) { now += ms; }, async offline() { offline = true; await market.refreshSource(); } };
}

test('funding discovery normalizes 1/4/8h rates before choosing direction and ranking', async t => {
  const f = await fixture(t, { quotes: [fundingQuote('binance', { fundingRate: 0.0001, fundingIntervalHours: 1 }),
    fundingQuote('bybit', { fundingRate: 0.0001, fundingIntervalHours: 4 }),
    fundingQuote('okx', { fundingRate: -0.0001, fundingIntervalHours: 8 })] });
  const rows = f.rows();
  assert.deepEqual(rows.map(row => row.equivalent8hBps), [9, 6, 3]);
  assert.deepEqual(rows.map(row => [row.long.exchange, row.short.exchange]), [['okx', 'binance'], ['bybit', 'binance'], ['okx', 'bybit']]);
  assert.equal(rows[0].long.rate, -0.0001); assert.equal(rows[0].short.intervalHours, 1);
  assert.equal(rows[0].short.normalized8hBps, 8); assert.equal(rows[0].long.normalized8hBps, -1);
  assert.ok(rows.every(row => row.eligible && row.expiresAt === epoch + 10000 && row.asOf === epoch));
});

test('negative and zero funding rates are valid and equal normalized rates create no direction', async t => {
  for (const [rates, difference] of [[[0, 0.0003], 3], [[-0.0003, -0.0001], 2], [[-0.0003, 0], 3]]) {
    const f = await fixture(t, { quotes: rates.map((rate, i) => fundingQuote(i ? 'bybit' : 'binance', { fundingRate: rate })) });
    assert.equal(f.rows()[0].equivalent8hBps, difference); assert.equal(f.rows()[0].long.exchange, 'binance');
  }
  const f = await fixture(t, { quotes: [fundingQuote('binance', { fundingRate: 0.0001, fundingIntervalHours: 1 }),
    fundingQuote('bybit', { fundingRate: 0.0008, fundingIntervalHours: 8 })] });
  assert.deepEqual(f.rows(), []);
});

test('complete quotes discover negative opening spreads without signals or minNetBps filtering', async t => {
  const f = await fixture(t, { quotes: [fundingQuote('binance', { fundingRate: 0.0003 }), fundingQuote('bybit', { fundingRate: 0.0001 })] });
  f.market.settings({ config: { minNetBps: 5000 } });
  const row = f.rows()[0];
  assert.equal(row.long.symbol, 'BYBIT_FUTURE_BTC_USDT'); assert.equal(row.short.symbol, 'BINANCE_FUTURE_BTC_USDT');
  assert.ok(row.grossBps < 0); assert.equal(row.equivalent8hBps, 2); assert.equal(row.eligible, true);
  assert.deepEqual(f.market.view().opportunities, []);
  await assert.rejects(f.market.previewOpen(row.id), /机会已过期/);
});

test('missing or nonnumeric funding values never invent a rate, interval or observation time', async t => {
  for (const field of ['fundingRate', 'fundingIntervalHours', 'fundingAt']) for (const value of [undefined, null, NaN, Infinity, '1']) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', { [field]: value }), fundingQuote('bybit')] });
    assert.deepEqual(f.rows(), [], `${field}=${value}`);
  }
  for (const field of ['fundingIntervalHours', 'fundingAt']) for (const value of [0, -1]) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', { [field]: value }), fundingQuote('bybit')] });
    assert.deepEqual(f.rows(), [], `${field}=${value}`);
  }
  const unsupported = await fixture(t, { quotes: [fundingQuote('binance', { fundingIntervalHours: 169 }), fundingQuote('bybit')] });
  assert.deepEqual(unsupported.rows(), []);
});

test('funding freshness uses its own five-minute clock and never inherits current BBO time', async t => {
  for (const [offset, eligible] of [[-299999, true], [-300000, false], [-300001, false], [1000, true], [1001, false]]) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', { fundingAt: epoch + offset }), fundingQuote('bybit')] });
    const row = f.rows()[0]; assert.equal(row.eligible, eligible, String(offset));
    assert.equal(row.long.fundingAt, epoch + offset);
    if (!eligible) assert.match(row.reason, /资金费/);
  }
  const f = await fixture(t, { quotes: [fundingQuote('binance', { fundingAt: epoch - 299999 }), fundingQuote('bybit')] });
  assert.equal(f.rows()[0].expiresAt, epoch + 1); f.advance(1); assert.equal(f.rows()[0].eligible, false);
});

test('unknown, invalid or elapsed next settlement times remain null and do not suppress rate comparison', async t => {
  for (const value of [undefined, null, NaN, Infinity, 0, epoch, epoch - 1, '1790003600000']) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', { nextFundingAt: value }), fundingQuote('bybit')] });
    const row = f.rows()[0]; assert.equal(row.long.nextFundingAt, null); assert.equal(row.eligible, true);
  }
});

test('BBO freshness and two-leg synchronization remain independent of funding freshness', async t => {
  for (const extra of [{ bidAskAt: undefined }, { receivedAt: NaN }, { bidAskAt: epoch - 10001 }, { bidAskAt: String(epoch) },
    { receivedAt: epoch + 1001 }, { bidAskAt: epoch + 1001 },
    { bidAskAt: epoch + 1001, receivedAt: epoch + 1001 }, { bidAskAt: epoch - 5001 }, { bid: null }]) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', extra), fundingQuote('bybit')] });
    assert.equal(f.rows()[0].eligible, false); assert.match(f.rows()[0].reason, /报价/);
  }
  const f = await fixture(t, { quotes: [fundingQuote('binance', { bidAskAt: epoch - 5000 }), fundingQuote('bybit')] });
  assert.equal(f.rows()[0].eligible, true); assert.equal(f.rows()[0].expiresAt, epoch + 5000);
  f.advance(5000); assert.equal(f.rows()[0].eligible, false);
});

test('source failures, stale views and offline venues retain rates but disable prefilling', async t => {
  const f = await fixture(t); await f.offline();
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].eligible, false); assert.match(f.rows()[0].reason, /行情读取失败/);
  const stale = await fixture(t); stale.advance(10001); assert.equal(stale.rows()[0].eligible, false); assert.match(stale.rows()[0].reason, /过期/);
  const venue = await fixture(t); await venue.setSnapshot({ ...venue.snapshot(), exchanges: [{ id: 'binance', status: 'offline' }, { id: 'bybit', status: 'live' }] });
  assert.equal(venue.rows()[0].eligible, false); assert.match(venue.rows()[0].reason, /离线/);
});

test('only same-base, distinct-venue, verified ordinary linear identities are paired', async t => {
  for (const extra of [{ base: 'ETH' }, { identityVerified: false }, { identitySource: '' }, { assetClass: 'commodity' },
    { comparable: false }, { multiplier: 1000 }, { rawBase: '1000BTC' }, { settlementCurrency: 'USDC' },
    { crossexSymbol: 'BINANCE_FUTURE_ETH_USDT' }, { contractKind: 'inverse' }, { identityScope: 'manual' }, { delisting: true }, { delistingAt: epoch + 10000 }]) {
    const f = await fixture(t, { quotes: [fundingQuote('binance', extra), fundingQuote('bybit')] });
    assert.deepEqual(f.rows(), [], JSON.stringify(extra));
  }
  const sameVenue = await fixture(t, { quotes: [fundingQuote('bybit'), fundingQuote('bybit', { quoteCurrency: 'USDC', fundingRate: 0.001 })] });
  assert.deepEqual(sameVenue.rows(), []);
  const quanto = fundingQuote('hyperliquid', { symbol: 'BTC', contractKind: 'quanto', counterCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', crossexSymbol: 'HYPERLIQUID_FUTURE_BTC_USDC' });
  const f = await fixture(t, { quotes: [fundingQuote('binance'), quanto] }); assert.deepEqual(f.rows(), []);
});

test('exact live CrossEx directory entries gate discovery and output actual non-USDT symbols', async t => {
  const quotes = [fundingQuote('binance'), fundingQuote('bybit')], rules = rulesFor(quotes);
  for (const extra of [{ symbol: 'BYBIT_FUTURE_BTC_USDC' }, { exchange_type: 'GATE' }, { business_type: 'SPOT' },
    { state: 'suspend' }, { delist_time: '1' }, { tick_size: '0' }, { max_limit_size: undefined }]) {
    const f = await fixture(t, { quotes, rules: [rules[0], { ...rules[1], ...extra }] }); assert.deepEqual(f.rows(), [], JSON.stringify(extra));
  }
  const f = await fixture(t, { quotes, rules: [rules[0], { ...rules[1], state: 'suspend' }, rules[1]] }); assert.deepEqual(f.rows(), []);
  const usdc = [fundingQuote('binance'), fundingQuote('bybit', { quoteCurrency: 'USDC' })];
  const converted = await fixture(t, { quotes: usdc, snapshot: { fx: { baseCurrency: 'USDT', staleAfterMs: 180000,
    rates: { USDC: { bid: 0.999, ask: 1.001, at: epoch, source: 'test' } } } } });
  assert.equal(converted.rows()[0].short.symbol, 'BYBIT_FUTURE_BTC_USDC'); assert.equal(converted.rows()[0].eligible, true);
  const missingFx = await fixture(t, { quotes: usdc }); assert.equal(missingFx.rows()[0].eligible, false); assert.equal(missingFx.rows()[0].grossBps, null);
});

test('blocked bases are excluded and a previously known policy cannot silently disappear', async t => {
  const f = await fixture(t, { snapshot: { crossexFilter: { requireSpotTransfer: false, blockedBases: ['BTC'], revision: 1 } } });
  assert.deepEqual(f.rows(), []);
  const { crossexFilter, ...missing } = f.snapshot(); await f.setSnapshot(missing);
  assert.equal(f.rows()[0].eligible, false); assert.match(f.rows()[0].reason, /策略缺失/);
  const malformed = await fixture(t, { snapshot: { crossexFilter: { requireSpotTransfer: 'false', blockedBases: [] } } });
  assert.equal(malformed.rows()[0].eligible, false); assert.match(malformed.rows()[0].reason, /策略无效/);
});

test('required transfer evidence must cover both exact current identities, including reverse funding directions', async t => {
  const quotes = [fundingQuote('binance', { fundingRate: 0.0003 }), fundingQuote('bybit', { fundingRate: 0.0001 })];
  const policy = { requireSpotTransfer: true, blockedBases: [], revision: 1 };
  const certificate = signal(...quotes, { expiresAt: epoch + 5000, spotTransfer: { networks: ['ETH'], checkedAt: epoch, expiresAt: epoch + 5000 } });
  const f = await fixture(t, { quotes, snapshot: { crossexFilter: policy, signals: [certificate] } });
  assert.equal(f.rows()[0].long.exchange, 'bybit'); assert.equal(f.rows()[0].eligible, true); assert.equal(f.rows()[0].expiresAt, epoch + 5000);
  f.advance(5000); assert.equal(f.rows()[0].eligible, false);
  for (const signals of [[], [{ ...certificate, spotTransfer: undefined }], [{ ...certificate, expiresAt: epoch }],
    [{ ...certificate, pairKey: 'wrong-pair' }], [{ ...certificate, long: { ...quotes[0], identityScope: 'manual' } }],
    [{ ...certificate, short: { ...quotes[1], quoteCurrency: 'USDC' } }],
    [{ ...certificate, spotTransfer: { networks: ['ETH'], checkedAt: epoch + 1, expiresAt: epoch + 5000 } }]]) {
    const current = await fixture(t, { quotes, snapshot: { crossexFilter: policy, signals } });
    assert.equal(current.rows()[0].eligible, false); assert.match(current.rows()[0].reason, /证据/);
  }
  const duplicate = await fixture(t, { quotes, snapshot: { crossexFilter: policy, signals: [{ ...certificate, expiresAt: epoch }, certificate] } });
  assert.equal(duplicate.rows()[0].eligible, false, 'a later duplicate cannot replace the first exact current signal');
});

test('funding views honor pause, return at most 200 ranked rows, and lightweight reads skip projection', async t => {
  let reads = 0;
  const tracked = fundingQuote('binance'); Object.defineProperty(tracked, 'fundingRate', { enumerable: true, get() { reads++; return 0.0001; } });
  const f = await fixture(t, { quotes: [tracked, fundingQuote('bybit')] });
  reads = 0; assert.deepEqual(f.market.view({ includeOpportunities: false }).fundingOpportunities, []); assert.equal(reads, 0);
  assert.equal(f.rows()[0].eligible, true); f.market.settings({ config: { entryPaused: true } });
  assert.equal(f.rows()[0].eligible, false); assert.match(f.rows()[0].reason, /暂停/);
  const quotes = Array.from({ length: 205 }, (_, i) => [fundingQuote('binance', { base: `COIN${i}`, fundingRate: 0 }),
    fundingQuote('bybit', { base: `COIN${i}`, fundingRate: (i + 1) / 10000 })]).flat();
  const large = await fixture(t, { quotes }); const rows = large.rows();
  assert.equal(rows.length, 200); assert.equal(rows[0].equivalent8hBps, 205); assert.equal(rows[199].equivalent8hBps, 6);
});

test('the 200-row limit preserves an eligible lower-rate pair ahead of 200 stale higher-rate pairs', async t => {
  const stale = Array.from({ length: 200 }, (_, i) => [
    fundingQuote('binance', { base: `STALE${i}`, fundingRate: 0, fundingAt: epoch - 300000 }),
    fundingQuote('bybit', { base: `STALE${i}`, fundingRate: (i + 2) / 10000 }),
  ]).flat();
  const current = [fundingQuote('binance', { fundingRate: 0 }), fundingQuote('bybit', { fundingRate: 0.0001 })];
  const f = await fixture(t, { quotes: [...stale, ...current] });
  const rows = f.rows();
  assert.equal(rows.length, 200); assert.equal(rows[0].base, 'BTC'); assert.equal(rows[0].eligible, true);
  assert.equal(rows[0].equivalent8hBps, 1); assert.ok(rows.slice(1).every(row => !row.eligible));
  assert.equal(rows[1].equivalent8hBps, 201); assert.equal(rows.at(-1).equivalent8hBps, 3);
});

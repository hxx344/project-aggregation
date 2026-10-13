import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBase, crossexBase, validBaseMapping, isBaseBlocked } from '../server/asset-identity.mjs';
import { normalizeUnderlying } from '../modules/monitor/modules/perpetual/exchanges.mjs';
import { createPerpetualOpportunitiesV2 } from '../modules/monitor/server/perpetual-opportunities-v2.mjs';
import { createCrossExFilterService } from '../modules/monitor/server/perpetual-crossex-service.mjs';
import { initialCrossExSettings } from '../modules/monitor/server/perpetual-crossex-store.mjs';
import { parseSpotTransfer, spotTransferEvidence, SPOT_TRANSFER_TTL_MS } from '../modules/monitor/server/perpetual-spot-transfer.mjs';
import { validIdentity, validManualIdentity, validManualPair, contractIdentity, catalogRule, transferEligibility } from '../modules/crossex/server/model.mjs';
import { fundingOpportunities } from '../modules/crossex/server/funding-opportunities.mjs';
import { createPublicClients } from '../modules/crossex/server/clients.mjs';

const NOW = 1790000000000;
const ADDRESS = '0x1234567890123456789012345678901234567890';
const nativeBase = exchange => ['gate', 'okx'].includes(exchange) ? 'LUNA' : 'LUNA2';

function quote(exchange, extra = {}) {
  const rawBase = nativeBase(exchange);
  return { exchange, symbol: exchange === 'gate' ? `${rawBase}_USDT` : exchange === 'okx' ? `${rawBase}-USDT-SWAP` : `${rawBase}USDT`,
    rawBase, ...normalizeUnderlying(rawBase, exchange), quoteCurrency: 'USDT', settlementCurrency: 'USDT', collateralCurrency: 'USDT',
    contractKind: 'linear', counterCurrency: 'USDT', crossexSymbol: `${exchange.toUpperCase()}_FUTURE_${rawBase}_USDT`,
    assetClass: 'crypto', comparable: true, identityVerified: true, crossexVerified: true,
    identitySource: 'finite-official-instrument-fixture', delisting: false, delistingAt: null,
    bid: exchange === 'binance' ? 0.0499 : 0.051, ask: exchange === 'binance' ? 0.05 : 0.0511,
    bidAskAt: NOW, receivedAt: NOW, fundingRate: 0.0001, fundingIntervalHours: exchange === 'binance' ? 1 : 4,
    fundingAt: NOW, nextFundingAt: NOW + 3600000, ...extra };
}
function snapshot(quotes, extra = {}) {
  return { schemaVersion: 2, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual',
    generatedAt: NOW, status: 'live', staleAfterMs: 10000, quotes, signals: [], fx: null,
    exchanges: [...new Set(quotes.map(q => q.exchange))].map(id => ({ id, status: 'live', kind: 'cex' })), ...extra };
}
const project = (quotes, filter) => createPerpetualOpportunitiesV2(snapshot(quotes), NOW,
  (exchange, symbol) => quotes.find(q => q.exchange === exchange && q.symbol === symbol), null, filter);
const catalog = quotes => quotes.map(q => ({ symbol: q.crossexSymbol, exchange_type: q.exchange.toUpperCase(), business_type: 'FUTURE',
  state: 'live', delist_time: '0', min_size: '1', lot_size: '1', tick_size: '0.00001', min_notional: '5', max_market_size: '10000' }));
function funding(feed) {
  const rules = catalog(feed.quotes);
  return fundingOpportunities(feed, { now: NOW, ruleFor: q => catalogRule(q, rules) });
}

test('verified aliases are exchange-scoped and preserve the native CrossEx spelling', () => {
  for (const exchange of ['gate', 'okx']) {
    assert.equal(canonicalBase(exchange, 'LUNA'), 'LUNA2');
    assert.equal(crossexBase(exchange, 'LUNA'), 'LUNA');
    assert.equal(validBaseMapping(exchange, 'LUNA2', 'LUNA'), true);
    assert.equal(validBaseMapping(exchange, 'LUNA', 'LUNA'), true);
  }
  assert.equal(canonicalBase('kraken', 'XBT'), 'BTC');
  assert.equal(crossexBase('kraken', 'XBT'), 'BTC');
  for (const exchange of ['binance', 'bybit', 'kraken', 'bitget', 'unknown']) {
    assert.equal(canonicalBase(exchange, 'LUNA'), 'LUNA');
    assert.equal(validBaseMapping(exchange, 'LUNA2', 'LUNA'), false);
  }
  for (const raw of ['LUNC', '1000LUNC', 'UNKNOWN', 'LUNA3', 'LUNAN']) {
    assert.equal(canonicalBase('gate', raw), raw);
    assert.equal(validBaseMapping('gate', 'LUNA2', raw), false);
  }
  assert.equal(validBaseMapping('gate', 'LUNA2', 'luna'), false);
  assert.equal(validBaseMapping('gate', 'LUNA2', null), false);
  assert.equal(canonicalBase('gate', 'XBT'), 'XBT');
});

test('Monitor projection and funding match canonical aliases while retaining native directory rules', () => {
  for (const exchange of ['gate', 'okx']) {
    const quotes = [quote('binance'), quote(exchange)], feed = project(quotes);
    assert.equal(feed.quotes.length, 2);
    assert.equal(feed.signals.length, 1);
    assert.equal(feed.signals[0].base, 'LUNA2');
    assert.equal(feed.signals[0].long.exchange, 'binance');
    assert.equal(feed.signals[0].short.exchange, exchange);
    assert.equal(feed.quotes[1].rawBase, 'LUNA');
    assert.equal(feed.quotes[1].symbol, quotes[1].symbol);
    assert.equal(feed.quotes[1].crossexSymbol, `${exchange.toUpperCase()}_FUTURE_LUNA_USDT`);
    for (const legacy of [false, true, 'missing-raw']) {
      const second = { ...feed.quotes[1], ...(legacy ? { base: 'LUNA' } : {}) };
      if (legacy === 'missing-raw') delete second.rawBase;
      assert.equal(validIdentity(second), true, `${exchange}: ${legacy}`);
      assert.equal(validManualPair(feed.quotes[0], second), true);
      const rows = funding(snapshot([feed.quotes[0], second]));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].base, 'LUNA2');
      assert.equal(rows[0].long.symbol, `${exchange.toUpperCase()}_FUTURE_LUNA_USDT`);
      assert.equal(rows[0].short.symbol, 'BINANCE_FUTURE_LUNA2_USDT');
      assert.equal(rows[0].equivalent8hBps, 6);
      assert.equal(rows[0].eligible, true, rows[0].reason);
    }
  }
});

test('Kraken native XBT and BTC metadata both match Bitcoin without a global XBT alias', () => {
  const bitcoin = quote('binance', { base: 'BTC', rawBase: 'BTC', symbol: 'BTCUSDT', crossexSymbol: 'BINANCE_FUTURE_BTC_USDT' });
  for (const rawBase of ['XBT', 'BTC']) {
    const kraken = quote('kraken', { base: 'BTC', rawBase, symbol: 'PF_XBTUSD', quoteCurrency: 'USD',
      settlementCurrency: 'USD', counterCurrency: 'USD', collateralCurrency: 'MULTI', crossexSymbol: 'KRAKEN_FUTURE_BTC_USD' });
    assert.equal(validIdentity(kraken), true);
    assert.equal(validManualPair(bitcoin, kraken), true);
    assert.equal(validManualPair(bitcoin, { ...kraken, base: rawBase }), true);
  }
  assert.equal(validIdentity({ ...bitcoin, rawBase: 'XBT' }), false);
});

test('legacy and canonical contract identities agree only for the same native instrument', () => {
  for (const exchange of ['gate', 'okx']) {
    const current = quote(exchange), legacy = { ...current, base: 'LUNA' }, withoutRaw = { ...legacy };
    delete withoutRaw.rawBase;
    assert.equal(contractIdentity(current), contractIdentity(legacy));
    assert.equal(contractIdentity(current), contractIdentity(withoutRaw));
    for (const patch of [{ symbol: 'LUNA2_USDT' }, { rawBase: 'LUNA2' }, { multiplier: 1000 }, { nativeUnit: '10' },
      { quoteCurrency: 'USDC' }, { settlementCurrency: 'USDC' }, { crossexSymbol: `${exchange.toUpperCase()}_FUTURE_LUNA2_USDT` }]) {
      assert.notEqual(contractIdentity(current), contractIdentity({ ...current, ...patch }), JSON.stringify(patch));
    }
  }
});

test('unverified aliases, wrong units, stocks and unsupported venues cannot enter crypto matching', () => {
  const first = quote('binance'), second = quote('gate');
  for (const patch of [{ rawBase: 'LUNC' }, { rawBase: 'UNKNOWN' }, { rawBase: undefined }, { rawBase: 'LUNA2' },
    { multiplier: 1000 }, { assetClass: 'stock' }, { exchange: 'bitget' }, { comparable: false },
    { identityVerified: false }, { crossexSymbol: 'GATE_FUTURE_LUNA2_USDT' }]) {
    const forged = { ...second, ...patch };
    assert.equal(validIdentity(forged), false, JSON.stringify(patch));
    assert.equal(validManualPair(first, forged), false, JSON.stringify(patch));
    assert.deepEqual(funding(snapshot([first, forged])), []);
  }
  const lunc = quote('gate', { base: 'LUNC', rawBase: 'LUNC', symbol: 'LUNC_USDT', crossexSymbol: 'GATE_FUTURE_LUNC_USDT' });
  assert.equal(validIdentity(lunc), true, 'LUNC remains a separate valid crypto identity');
  assert.equal(validManualPair(first, lunc), false);
  assert.deepEqual(funding(snapshot([first, lunc])), []);
  for (const patch of [{ assetClass: 'stock' }, { multiplier: 1000 }, { comparable: false }]) {
    assert.equal(project([first, { ...second, ...patch }]).signals.length, 0);
  }
});

test('either LUNA spelling blocks canonical and legacy legs in funding and the real Monitor filter', async t => {
  for (const blockedBase of ['LUNA', 'LUNA2']) {
    const blocked = new Set([blockedBase]);
    assert.equal(isBaseBlocked(blocked, 'LUNA'), true);
    assert.equal(isBaseBlocked(blocked, 'LUNA2'), true);
    assert.equal(isBaseBlocked(blocked, 'LUNC'), false);
    let state = initialCrossExSettings();
    const store = { get: () => structuredClone(state), save: async next => { state = structuredClone(next); } };
    const service = createCrossExFilterService({ store, clock: () => NOW,
      read: async () => { throw new Error('block-only filters must not need transfer network IO'); } });
    t.after(() => service.stop());
    await service.update({ revision: 0, config: { requireSpotTransfer: false, blockedBases: [blockedBase] } });
    for (const raw of [false, true]) {
      const second = quote('gate', raw ? { base: 'LUNA' } : {}), quotes = [quote('binance'), second];
      const filter = service.filter();
      assert.equal(filter.evaluate(...quotes, NOW), null);
      assert.equal(filter.evaluate(...quotes.toReversed(), NOW), null);
      assert.equal(project([quote('binance'), quote('gate')], filter).signals.length, 0);
      const feed = snapshot(quotes, { crossexFilter: { requireSpotTransfer: false, blockedBases: [blockedBase] } });
      assert.deepEqual(funding(feed), []);
      for (const base of ['LUNA', 'LUNA2']) assert.equal(transferEligibility({ base }, feed, NOW).state, 'blocked');
    }
  }
});

function transferMetadata({ binanceBase = 'LUNA2', gateBase = 'LUNA', gateAddress = ADDRESS } = {}) {
  // Artificial complete network evidence exercises lookup only; it does not
  // assert that these synthetic spot/network records exist on an exchange.
  const b = parseSpotTransfer('binance', { symbols: [{ symbol: `${binanceBase}USDT`, baseAsset: binanceBase, status: 'TRADING', isSpotTradingAllowed: true }] },
    { code: '000000', data: [{ coin: binanceBase, trading: true, isLegalMoney: false, depositAllEnable: true, withdrawAllEnable: true,
      depositHideAll: false, withdrawHideAll: false, networkList: [{ coin: binanceBase, network: 'ETH', contractAddress: ADDRESS,
        depositEnable: true, withdrawEnable: true, depositHideEnable: false, withdrawHideEnable: false, busy: false }] }] });
  const g = parseSpotTransfer('gate', [{ id: `${gateBase}_USDT`, base: gateBase, trade_status: 'tradable' }],
    [{ currency: gateBase, delisted: false, trade_disabled: false, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false,
      chains: [{ name: 'ETH', addr: gateAddress, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false }] }]);
  return new Map([['binance', { at: NOW, assets: b }], ['gate', { at: NOW, assets: g }]]);
}

test('spot transfer evidence looks up native assets and never guesses missing alias evidence', () => {
  const legs = [quote('binance'), quote('gate')], metadata = transferMetadata();
  const evidence = spotTransferEvidence(...legs, metadata, NOW);
  assert.deepEqual(evidence, { networks: ['ETH'], checkedAt: NOW, expiresAt: NOW + SPOT_TRANSFER_TTL_MS });
  for (const extra of [{ base: 'LUNA' }, { base: 'LUNA', rawBase: undefined }]) {
    assert.deepEqual(spotTransferEvidence(legs[0], { ...legs[1], ...extra }, metadata, NOW), evidence);
  }
  for (const bad of [transferMetadata({ gateBase: 'LUNA2' }), transferMetadata({ binanceBase: 'LUNA' }),
    transferMetadata({ gateAddress: `0x${'f'.repeat(40)}` }), new Map()]) {
    assert.equal(spotTransferEvidence(...legs, bad, NOW), null);
    const filter = { enabled: true, requireSpotTransfer: true, blockedBases: [], revision: 0,
      evaluate: (long, short, now) => spotTransferEvidence(long, short, bad, now) };
    const feed = project(legs, filter);
    assert.deepEqual(feed.signals, []);
    const rows = funding(feed);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eligible, false);
    assert.match(rows[0].reason, /证据|充提/);
  }
  for (const patch of [{ rawBase: 'UNKNOWN' }, { multiplier: 1000 }]) assert.equal(spotTransferEvidence(legs[0], { ...legs[1], ...patch }, metadata, NOW), null);
});

function nativeClients() {
  const calls = [];
  const binance = { symbol: 'LUNA2USDT', baseAsset: 'LUNA2', quoteAsset: 'USDT', marginAsset: 'USDT',
    contractType: 'PERPETUAL', status: 'TRADING', underlyingType: 'COIN', underlyingSubType: [] };
  const gate = { name: 'LUNA_USDT', type: 'direct', contract_type: '', status: 'trading',
    in_delisting: false, is_pre_market: false, quanto_multiplier: '1' };
  const okx = { instId: 'LUNA-USDT-SWAP', instType: 'SWAP', ctType: 'linear', ctValCcy: 'LUNA', ctVal: '1', ctMult: '1',
    settleCcy: 'USDT', state: 'live', ruleType: 'normal', expTime: '', instCategory: '1' };
  const clients = createPublicClients({ clock: () => NOW, fetcher: async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers);
    calls.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(headers.has('Authorization'), false);
    assert.equal(headers.has('KEY'), false);
    assert.equal(headers.has('SIGN'), false);
    let result;
    if (url.href === 'https://fapi.binance.com/fapi/v1/exchangeInfo') result = { symbols: [binance] };
    else if (url.href === 'https://api.gateio.ws/api/v4/futures/usdt/contracts/LUNA_USDT') result = gate;
    else if (url.origin === 'https://api.gateio.ws' && url.pathname === '/api/v4/futures/usdt/order_book') {
      assert.equal(url.searchParams.get('contract'), 'LUNA_USDT');
      result = { update: NOW / 1000, bids: [{ p: '0.051', s: '200' }], asks: [{ p: '0.0511', s: '300' }] };
    } else if (url.origin === 'https://www.okx.com' && url.pathname === '/api/v5/public/instruments') {
      assert.equal(url.searchParams.get('instId'), 'LUNA-USDT-SWAP');
      result = { code: '0', data: [okx] };
    } else if (url.origin === 'https://www.okx.com' && url.pathname === '/api/v5/market/books') {
      assert.equal(url.searchParams.get('instId'), 'LUNA-USDT-SWAP');
      result = { code: '0', data: [{ ts: String(NOW), bids: [['0.051', '200']], asks: [['0.0511', '300']] }] };
    } else throw new Error(`Unexpected network request: ${url.href}`);
    return Response.json(result);
  } });
  return { clients, calls };
}

test('public native clients resolve and read manual and strict alias contracts using unchanged units', async () => {
  const { clients, calls } = nativeClients();
  for (const exchange of ['gate', 'okx']) {
    const symbol = `${exchange.toUpperCase()}_FUTURE_LUNA_USDT`;
    const manual = await clients.resolveManualQuote(symbol), strict = await clients.resolveCrossexQuote(symbol);
    assert.equal(manual.base, 'LUNA2');
    assert.equal(manual.rawBase, 'LUNA');
    assert.equal(manual.nativeUnit, '1');
    assert.equal(manual.multiplier, 1);
    assert.equal(validManualIdentity(manual), true);
    assert.equal(strict.base, 'LUNA2');
    assert.equal(strict.rawBase, 'LUNA');
    assert.equal(validIdentity(strict), true);
    const noRaw = { ...strict, base: 'LUNA' }; delete noRaw.rawBase;
    for (const [q, read] of [[manual, clients.loadManualDepth], [{ ...manual, base: 'LUNA' }, clients.loadManualDepth],
      [strict, clients.loadDepth], [{ ...strict, base: 'LUNA' }, clients.loadDepth], [noRaw, clients.loadDepth]]) {
      const book = await read(q);
      assert.equal(book.symbol, exchange === 'gate' ? 'LUNA_USDT' : 'LUNA-USDT-SWAP');
      assert.deepEqual(book.bids, [[0.051, 200]]);
      assert.deepEqual(book.asks, [[0.0511, 300]]);
    }
    await assert.rejects(clients.loadDepth({ ...strict, rawBase: 'UNKNOWN' }));
    await assert.rejects(clients.loadManualDepth({ ...manual, nativeUnit: '1000' }), /单位|身份/);
  }
  assert.ok(calls.some(url => url.pathname === '/api/v4/futures/usdt/contracts/LUNA_USDT'));
  assert.ok(calls.some(url => url.searchParams.get('instId') === 'LUNA-USDT-SWAP'));
  assert.equal(calls.some(url => url.pathname.includes('/orders') || url.pathname.includes('/account')), false);
});

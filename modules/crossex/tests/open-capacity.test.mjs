import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createMarket } from '../server/market.mjs';
import { createLiveRuntime } from '../server/live-runtime.mjs';
import { D } from '../server/money.mjs';
import { createLiveHttpFixture } from './live-http-fixture.mjs';

const epoch = 1791430000000, symbols = ['BINANCE_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'];
const clone = value => JSON.parse(JSON.stringify(value));
const pair = quantity => ({ pair: { longSymbol: symbols[0], shortSymbol: symbols[1], ...(quantity === undefined ? {} : { quantity }) } });
const order = (extra = {}) => ({ order: { symbol: symbols[0], side: 'BUY', orderType: 'LIMIT', timeInForce: 'GTC', price: '100', ...extra } });
const tier = (min = '0', max = '1000000', leverage = '100') => ({ min_risk_limit_value: min, max_risk_limit_value: max, leverage_max: leverage });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function quote(symbol, now) {
  const [venue, , base, currency] = symbol.split('_'), exchange = venue.toLowerCase();
  return { exchange, symbol: exchange === 'bybit' && currency === 'USDC' ? `${base}PERP` : `${base}${currency}`, crossexSymbol: symbol,
    base, rawBase: base, quoteCurrency: currency, collateralCurrency: currency, settlementCurrency: currency, counterCurrency: currency,
    contractKind: 'linear', multiplier: 1, nativeUnit: '1', assetClass: 'crypto', identityScope: 'manual', comparable: true,
    identitySource: 'exchange-instrument-metadata', identityVerified: true, bid: exchange === 'binance' ? 99 : 102,
    ask: exchange === 'binance' ? 100 : 103, bidAskAt: now, receivedAt: now };
}
async function fixture(t, options = {}) {
  const { initialUid = '123', ...runtimeOptions } = options;
  const directory = mkdtempSync(join(tmpdir(), 'crossex-capacity-')), store = createStore(directory);
  const remote = { now: epoch, positions: [], orders: [], marginByVenue: { BINANCE: '10000', BYBIT: '10000' },
    account: { user_id: initialUid, position_mode: 'DUAL', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', available_margin: '10000', assets: [] },
    leverages: { [symbols[0]]: '10', [symbols[1]]: '5' }, tiers: {}, fxAt: epoch, fxRate: 1.1, depthAt: null,
    depthSize: 100, depthHook: null, leverageHook: null, riskHook: null, isolatedUid: initialUid, isolatedUidsByVenue: {}, writes: 0, reads: { leverage: 0, risk: 0, account: 0 } };
  const rules = [symbols[0], symbols[1], 'BYBIT_FUTURE_BTC_USDC'].map(symbol => ({ symbol, exchange_type: symbol.split('_')[0],
    business_type: 'FUTURE', state: 'live', min_size: '0.001', lot_size: '0.001', tick_size: '0.01', min_notional: '5',
    max_market_size: '10000', max_limit_size: '10000', delist_time: '0' }));
  const market = createMarket(store, { clock: () => remote.now, catalogReader: async () => clone(rules),
    manualIdentityReader: async symbol => quote(symbol, remote.now),
    manualDepthReader: async q => {
      if (remote.depthHook) await remote.depthHook();
      return { at: remote.depthAt ?? remote.now, bids: [[q.bid, remote.depthSize]], asks: [[q.ask, remote.depthSize]] };
    },
    fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: remote.fxRate === null ? {} : {
      USDC: { bid: remote.fxRate, ask: remote.fxRate, at: remote.fxAt, source: 'capacity-fixture' } } }) });
  market.settings({ config: { notionalPerLeg: 100000, maxTotalNotional: 2000000, maxOpen: 20, slippageBps: 0 } });
  const client = {
    async getAccount(venue) {
      remote.reads.account++;
      return remote.account.account_mode === 'ISOLATED_EXCHANGE' ? { ...clone(remote.account), exchange_type: venue || 'BINANCE',
        user_id: Object.hasOwn(remote.isolatedUidsByVenue, venue) ? remote.isolatedUidsByVenue[venue] : remote.isolatedUid,
        available_margin: remote.marginByVenue[venue || 'BINANCE'] } : clone(remote.account);
    },
    async getPositions() { return clone(remote.positions); }, async getOpenOrders() { return clone(remote.orders); },
    async getLeverages(selected) { remote.reads.leverage++; if (remote.leverageHook) await remote.leverageHook(); return Object.fromEntries(selected.map(s => [s, remote.leverages[s] ?? '10'])); },
    async getRiskLimits(selected) { remote.reads.risk++; if (remote.riskHook) await remote.riskHook(); return selected.map(symbol => ({ symbol, tiers: remote.tiers[symbol] ?? [tier()] })); },
    async getFees() { return []; }, async getTrades() { return []; }, async getAccountBook() { return []; }, async getAdlRanks() { return []; },
    async createOrder() { remote.writes++; throw new Error('CAPACITY_MUST_NOT_WRITE'); }, async cancelOrder() { remote.writes++; throw new Error('CAPACITY_MUST_NOT_WRITE'); },
  };
  const runtime = createLiveRuntime(store, { market, clientFactory: () => client, clock: () => remote.now, requestTimeoutMs: 500, capacityTimeoutMs: 600, ownerLeaseMs: 3600000, ...runtimeOptions });
  t.after(async () => {
    await runtime.stop(); await market.stop(); store.close();
    const target = resolve(directory), child = relative(resolve(tmpdir()), target);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('crossex-capacity-'));
    rmSync(target, { recursive: true, force: true });
  });
  await runtime.connection({ apiKey: 'capacity-fixture-key', apiSecret: 'capacity-fixture-secret' });
  const sync = () => runtime.refresh({ includeView: false });
  return { store, market, runtime, remote, rules, client, sync,
    async rulesChanged() { remote.now += 300001; remote.fxAt = remote.now; await market.refreshCatalog(); await sync(); },
    assertReadOnly() {
      assert.equal(remote.writes, 0);
      for (const table of ['live_previews', 'live_orders', 'live_executions', 'live_requests']) assert.equal(store.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
    } };
}

test('shared margin funds unequal-leverage legs once, with exact per-leg margin and no preview writes', async t => {
  const f = await fixture(t); f.remote.account.available_margin = '33.44'; await f.sync();
  const result = await f.runtime.openCapacity(pair('1'));
  assert.equal(result.status, 'ready'); assert.equal(result.maxQuantity, '1'); assert.equal(result.maxNotionalUSDT, '202');
  assert.equal(result.requiredMargin, '33.44'); assert.equal(result.inputWithinCapacity, true);
  assert.deepEqual(result.legs.map(l => [l.leverage, l.requiredMargin, l.maxNotionalUSDT]), [['10', '11', '100'], ['5', '22.44', '102']]);
  assert.deepEqual(result.limitingFactors, ['共享可用保证金']);
  const over = await f.runtime.openCapacity(pair('2'));
  assert.equal(over.status, 'ready'); assert.equal(over.inputWithinCapacity, false); assert.equal(over.maxQuantity, '1');
  const blank = await f.runtime.openCapacity(pair());
  assert.equal(blank.requiredMargin, null); assert.equal(blank.inputWithinCapacity, null);
  assert.ok(blank.legs.every(l => l.maxLeverage === null && l.notionalUSDT === null && l.requiredMargin === null));
  f.assertReadOnly();
});

test('isolated balances cannot be shared and refresh invalidates cached venue balances', async t => {
  const f = await fixture(t); f.remote.account.account_mode = 'ISOLATED_EXCHANGE'; f.remote.marginByVenue.BYBIT = '22.44'; await f.sync();
  let result = await f.runtime.openCapacity(pair('1'));
  assert.equal(result.maxQuantity, '1'); assert.ok(result.limitingFactors.includes('BYBIT 隔离可用保证金'));
  f.remote.marginByVenue.BYBIT = '11.22'; f.remote.now++; await f.sync();
  result = await f.runtime.openCapacity(pair('1'));
  assert.equal(result.maxQuantity, '0.5'); assert.equal(result.inputWithinCapacity, false);
  f.remote.marginByVenue.BYBIT = '-1'; f.remote.now++; await f.sync();
  result = await f.runtime.openCapacity(pair('1'));
  assert.equal(result.status, 'blocked'); assert.equal(result.maxQuantity, '0'); assert.equal(result.legs[1].availableMargin, '-1');
  f.assertReadOnly();
});

test('risk cap uses current leverage while maximum leverage uses the submitted native notional tier', async t => {
  const f = await fixture(t);
  f.remote.tiers[symbols[0]] = [tier('0', '100', '20'), tier('100', '200', '10'), tier('200', '500', '5')];
  let result = await f.runtime.openCapacity(order({ quantity: '1.5' }));
  assert.equal(result.maxQuantity, '2'); assert.equal(result.legs[0].leverage, '10'); assert.equal(result.legs[0].maxLeverage, '10');
  result = await f.runtime.openCapacity(order({ quantity: '3' }));
  assert.equal(result.status, 'ready'); assert.equal(result.inputWithinCapacity, false); assert.equal(result.legs[0].maxLeverage, '5');
  result = await f.runtime.openCapacity(order({ quantity: '6' }));
  assert.equal(result.legs[0].maxLeverage, null); assert.equal(result.inputWithinCapacity, false);
});

test('joint size floors to the least common multiple of lot steps and rejects subminimum or off-step input', async t => {
  const f = await fixture(t); f.rules[0].lot_size = '0.02'; f.rules[1].lot_size = '0.03';
  f.rules[0].max_limit_size = '1'; await f.rulesChanged();
  let result = await f.runtime.openCapacity(pair('0.9'));
  assert.equal(result.maxQuantity, '0.96'); assert.equal(result.inputWithinCapacity, true);
  result = await f.runtime.openCapacity(pair('0.95')); assert.equal(result.inputWithinCapacity, false);
  result = await f.runtime.openCapacity(pair('0.001')); assert.equal(result.inputWithinCapacity, false);
  f.rules[0].max_limit_size = '0.04'; await f.rulesChanged();
  result = await f.runtime.openCapacity(pair('0.03')); assert.equal(result.status, 'blocked'); assert.equal(result.maxQuantity, '0');
});

test('market and immediate-limit capacity respects matching max size and price-limited depth', async t => {
  const f = await fixture(t); f.rules[0].max_market_size = '0.5'; f.rules[0].max_limit_size = '3'; await f.rulesChanged();
  let result = await f.runtime.openCapacity(order({ orderType: 'MARKET', timeInForce: 'IOC', price: undefined }));
  assert.equal(result.maxQuantity, '0.5');
  f.remote.depthSize = 0.2;
  result = await f.runtime.openCapacity(order({ timeInForce: 'IOC' })); assert.equal(result.maxQuantity, '0.2');
  result = await f.runtime.openCapacity(order()); assert.equal(result.maxQuantity, '3');
  result = await f.runtime.openCapacity(order({ timeInForce: 'IOC', price: '99' })); assert.equal(result.status, 'blocked'); assert.equal(result.maxQuantity, '0');
});

test('per-leg and total exposure budgets remain USDT notional limits independent of leverage', async t => {
  const f = await fixture(t); f.market.settings({ config: { notionalPerLeg: 100, maxTotalNotional: 250 } });
  f.remote.positions = [{ symbol: 'BINANCE_FUTURE_ETH_USDT', position_side: 'LONG', position_qty: '1', mark_price: '100' }]; await f.sync();
  let result = await f.runtime.openCapacity(pair('1'));
  assert.equal(result.maxQuantity, '0.742'); assert.ok(result.limitingFactors.includes('账户总名义额'));
  assert.ok(D(result.maxNotionalUSDT).lte(150));
  f.remote.positions = []; await f.sync();
  result = await f.runtime.openCapacity(pair()); assert.equal(result.maxQuantity, '0.98');
  assert.ok(result.limitingFactors.includes(`${symbols[1]} 单腿预算`));
});

test('SELL valuation uses the higher quote, missing limit uses protection price, zero margin is blocked', async t => {
  const f = await fixture(t); f.market.settings({ config: { notionalPerLeg: 100, maxTotalNotional: 1000 } });
  let result = await f.runtime.openCapacity(order({ side: 'SELL', price: '90', quantity: '1' }));
  assert.equal(result.maxQuantity, '1.01'); assert.equal(result.legs[0].notionalUSDT, '99');
  result = await f.runtime.openCapacity(order({ price: '', quantity: '' }));
  assert.equal(result.status, 'ready'); assert.equal(result.maxQuantity, '1'); assert.ok(result.notes.some(n => n.includes('限价尚未填写')));
  f.remote.account.available_margin = '0'; await f.sync();
  result = await f.runtime.openCapacity(order()); assert.equal(result.status, 'blocked'); assert.equal(result.maxQuantity, '0');
});

test('FX conversion preserves quote currency, bid/ask freshness and source timestamp', async t => {
  const f = await fixture(t), symbol = 'BYBIT_FUTURE_BTC_USDC';
  f.remote.fxAt -= 1000;
  let result = await f.runtime.openCapacity(order({ symbol, quantity: '1', price: '103' }));
  assert.equal(result.status, 'ready'); assert.equal(result.legs[0].quoteCurrency, 'USDC');
  assert.equal(result.legs[0].notionalUSDT, '113.3'); assert.equal(result.requiredMargin, '12.463'); assert.equal(result.asOf, epoch - 1000);
  f.remote.fxAt = epoch - 180001;
  result = await f.runtime.openCapacity(order({ symbol })); assert.equal(result.status, 'unavailable'); assert.equal(result.maxQuantity, null);
  f.remote.fxAt = epoch; f.remote.fxRate = null;
  result = await f.runtime.openCapacity(order({ symbol })); assert.equal(result.status, 'unavailable');
});

test('positions, active or unknown orders, pause, position count and cooldown return known zero capacity', async t => {
  for (const scenario of ['position', 'active', 'unknown', 'pause', 'count', 'cooldown']) {
    const f = await fixture(t);
    if (scenario === 'position') f.remote.positions = [{ symbol: symbols[0], position_side: 'LONG', position_qty: '1', mark_price: '100' }];
    if (['active', 'unknown'].includes(scenario)) f.remote.orders = [{ order_id: 'external-1', symbol: 'BINANCE_FUTURE_ETH_USDT', state: scenario === 'active' ? 'OPEN' : 'NEW_UNKNOWN', qty: '1', executed_qty: '0' }];
    if (scenario === 'pause') f.market.settings({ config: { entryPaused: true } });
    if (scenario === 'count') { f.market.settings({ config: { maxOpen: 1 } }); f.remote.positions = [{ symbol: 'BINANCE_FUTURE_ETH_USDT', position_side: 'LONG', position_qty: '1', mark_price: '100' }]; }
    if (scenario === 'cooldown') f.store.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run('cooldown-id', 'inert-old-preview', epoch, JSON.stringify({ id: 'cooldown-id', base: 'BTC', createdAt: epoch }));
    await f.sync(); const result = await f.runtime.openCapacity(pair());
    assert.equal(result.status, 'blocked', scenario); assert.equal(result.maxQuantity, '0', scenario); assert.equal(f.remote.reads.leverage, 0, scenario);
  }
});

test('stale account or books and incomplete leverage, tiers, balances or isolated identity return unknown capacity', async t => {
  for (const scenario of ['account', 'book', 'leverage', 'tiers', 'tier-gap', 'balance', 'isolated-uid']) {
    const f = await fixture(t);
    if (scenario === 'account') f.remote.now += 16000;
    if (scenario === 'book') f.remote.depthAt = epoch - 10001;
    if (scenario === 'leverage') f.remote.leverages[symbols[0]] = '0';
    if (scenario === 'tiers') f.remote.tiers[symbols[0]] = [];
    if (scenario === 'tier-gap') f.remote.tiers[symbols[0]] = [tier('0', '100'), tier('101', '200', '10')];
    if (scenario === 'balance') { delete f.remote.account.available_margin; await f.sync(); }
    if (scenario === 'isolated-uid') { f.remote.account.account_mode = 'ISOLATED_EXCHANGE'; await f.sync(); f.remote.isolatedUid = '999'; }
    const result = await f.runtime.openCapacity(pair());
    assert.equal(result.status, 'unavailable', scenario); assert.equal(result.maxQuantity, null, scenario); f.assertReadOnly();
  }
});

test('account, settings and connection races discard late capacity reads without blocking the execution queue', async t => {
  for (const scenario of ['balance', 'settings', 'connection']) {
    const f = await fixture(t), entered = deferred(), release = deferred();
    f.remote.leverageHook = async () => { entered.resolve(); await release.promise; };
    const pending = f.runtime.openCapacity(pair()); await entered.promise;
    if (scenario === 'balance') { f.remote.account.available_margin = '1'; await f.sync(); }
    if (scenario === 'settings') f.market.settings({ config: { notionalPerLeg: 50000 } });
    if (scenario === 'connection') await f.runtime.disconnect();
    release.resolve(); const result = await pending;
    assert.equal(result.status, 'unavailable', scenario); assert.equal(result.maxQuantity, null, scenario); f.assertReadOnly();
  }
});

test('capacity UID merging rejects an isolated account inconsistent with a later identified cache', async t => {
  const f = await fixture(t, { initialUid: null });
  assert.equal(f.runtime.connectionView().accountId, null);
  f.remote.account.account_mode = 'ISOLATED_EXCHANGE'; f.remote.isolatedUid = '123'; await f.sync();
  f.remote.isolatedUid = '999';
  let result = await f.runtime.openCapacity(pair());
  assert.equal(result.status, 'unavailable'); assert.equal(result.maxQuantity, null);
  const reads = f.remote.reads.account;
  f.remote.isolatedUid = '123';
  result = await f.runtime.openCapacity(pair());
  assert.equal(f.remote.reads.account, reads, 'The second estimate reuses cached isolated snapshots');
  assert.equal(result.status, 'unavailable', 'Cached snapshots retain UID evidence for every estimate');
  f.assertReadOnly();
});

test('capacity UID merging rejects conflicting isolated venues when all prior snapshots omit UID', async t => {
  const f = await fixture(t, { initialUid: null });
  f.remote.account.account_mode = 'ISOLATED_EXCHANGE'; await f.sync();
  f.remote.isolatedUidsByVenue = { BINANCE: '123', BYBIT: '999' };
  const result = await f.runtime.openCapacity(pair());
  assert.equal(result.status, 'unavailable'); assert.equal(result.maxQuantity, null); f.assertReadOnly();
});

test('capacity UID merging includes identities observed only on positions or terminal orders', async t => {
  for (const source of ['positions', 'orders']) {
    const f = await fixture(t, { initialUid: null }); f.remote.account.account_mode = 'ISOLATED_EXCHANGE';
    if (source === 'positions') f.remote.positions = [{ user_id: '123', symbol: 'BINANCE_FUTURE_ETH_USDT', position_side: 'LONG', position_qty: '1', mark_price: '100' }];
    else f.remote.orders = [{ user_id: '123', order_id: 'terminal-1', symbol: 'BINANCE_FUTURE_ETH_USDT', state: 'FILLED', qty: '1', executed_qty: '1' }];
    await f.sync(); f.remote.isolatedUid = '999';
    const result = await f.runtime.openCapacity(pair());
    assert.equal(result.status, 'unavailable', source); assert.equal(result.maxQuantity, null, source); f.assertReadOnly();
  }
});

test('capacity UID merging keeps all-missing and matching sparse identities compatible', async t => {
  const f = await fixture(t, { initialUid: null });
  f.remote.account.account_mode = 'ISOLATED_EXCHANGE'; await f.sync();
  let result = await f.runtime.openCapacity(pair()); assert.equal(result.status, 'ready');
  f.remote.now += 5001; f.remote.isolatedUidsByVenue = { BINANCE: '123', BYBIT: null };
  result = await f.runtime.openCapacity(pair()); assert.equal(result.status, 'ready'); f.assertReadOnly();
});

test('risk reads deduplicate within one connection, expire, and never leak into a replacement connection', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.remote.leverageHook = async () => { entered.resolve(); await release.promise; };
  const first = f.runtime.openCapacity(order()), second = f.runtime.openCapacity(order({ quantity: '1' }));
  await entered.promise; release.resolve();
  assert.ok((await Promise.all([first, second])).every(result => result.status === 'ready'));
  assert.equal(f.remote.reads.leverage, 1); assert.equal(f.remote.reads.risk, 1);
  f.remote.now += 5001; await f.runtime.openCapacity(order()); assert.equal(f.remote.reads.leverage, 2);
  await f.runtime.connection({ apiKey: 'new-capacity-account-key', apiSecret: 'new-capacity-account-secret' });
  await f.runtime.openCapacity(order()); assert.equal(f.remote.reads.leverage, 3);
});

test('bounded capacity reads do not occupy the execution queue or multiply a still-pending private read', async t => {
  const f = await fixture(t, { requestTimeoutMs: 30, capacityTimeoutMs: 40 });
  f.remote.leverageHook = () => new Promise(() => {});
  const result = await f.runtime.openCapacity(order()); assert.equal(result.status, 'unavailable');
  const status = await f.runtime.requestStatus('capacity-read-only-request'); assert.equal(status.requestStatus, 'not_submitted');
  await f.runtime.openCapacity(order()); assert.equal(f.remote.reads.leverage, 1); assert.equal(f.remote.reads.risk, 1); f.assertReadOnly();
});

test('snapshots expiring during a slow risk read are unavailable including existing-position FX', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.remote.positions = [{ symbol: 'BINANCE_FUTURE_ETH_USDC', position_side: 'LONG', position_qty: '1', mark_price: '100' }];
  f.remote.fxAt = epoch - 179999; await f.sync();
  f.remote.leverageHook = async () => { entered.resolve(); await release.promise; };
  const pending = f.runtime.openCapacity(order()); await entered.promise; f.remote.now += 2; release.resolve();
  const result = await pending; assert.equal(result.status, 'unavailable'); assert.equal(result.maxQuantity, null);
});

test('HTTP capacity requires login and CSRF, validates bounded inputs and never creates an order or preview', async t => {
  const f = await createLiveHttpFixture(); t.after(() => f.close());
  const path = '/api/live/open-capacity', request = (body, extra = {}) => f.request(path, { method: 'POST', body, ...extra });
  assert.equal((await request(order(), { auth: false })).status, 401);
  assert.equal((await request(order(), { csrf: false })).status, 403);
  assert.equal((await request(order(), { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.connect()).status, 200);
  const ready = await request(pair('0.1')); assert.equal(ready.status, 200); assert.equal(ready.data.status, 'ready');
  for (const invalid of [{ ...order(), kind: 'open' }, { ...order(), ...pair() }, order({ symbol: '../../accounts' }),
    order({ quantity: '1e100000000' }), order({ quantity: '1'.repeat(100) }), order({ quantity: 1 }), order({ orderType: 'MARKET' }),
    order({ price: '-1' }), { pair: { longSymbol: symbols[0], shortSymbol: symbols[1], quantity: 'NaN' } }]) {
    assert.equal((await request(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  for (const table of ['live_previews', 'live_orders', 'live_executions', 'live_requests']) assert.equal(f.app.store.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
  assert.ok(!JSON.stringify(ready.data).includes(f.credentials.apiKey)); assert.ok(!JSON.stringify(ready.data).includes(f.credentials.apiSecret));
});

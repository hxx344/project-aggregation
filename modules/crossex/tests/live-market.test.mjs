import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createMarket } from '../server/market.mjs';
import { feed, quote, book, catalog, epoch } from './fixtures.mjs';
import { largeMarketData, memoryMarketStore } from './live-market-performance-fixture.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-live-market-'));
  const store = createStore(directory);
  let now = epoch, current = feed(now), rules = catalog.map(r => ({ ...r, max_limit_size: '10000' }));
  let depth = q => book(q, now), offline = false, identities = 0;
  const market = createMarket(store, { clock: () => now, feedReader: async () => { if (offline) throw new Error('unavailable'); return current; },
    catalogReader: async () => rules, depthReader: q => depth(q), identityReader: async symbol => { identities++; return quote(symbol.startsWith('BINANCE') ? 'binance' : 'bybit', now); }, ...options });
  t.after(async () => { await market.stop(); store.close(); assert.ok(directory.startsWith(join(tmpdir(), 'crossex-live-market-'))); rmSync(directory, { recursive: true, force: true }); });
  return { store, market, get identities() { return identities; }, setFeed(x) { current = x; }, setRules(x) { rules = x; }, setDepth(fn) { depth = fn; }, offline() { offline = true; }, advance(ms) { now += ms; current = feed(now); }, now: () => now };
}
function manualQuote(exchange, extra = {}) {
  return quote(exchange, epoch, { symbol: { binance: 'BTCUSDT', bybit: 'BTCUSDT', gate: 'BTC_USDT', okx: 'BTC-USDT-SWAP' }[exchange],
    rawBase: 'BTC', settlementCurrency: 'USDT', collateralCurrency: 'USDT', counterCurrency: 'USDT', contractKind: 'linear',
    crossexSymbol: `${exchange.toUpperCase()}_FUTURE_BTC_USDT`, identityScope: 'manual', nativeUnit: '1',
    identitySource: 'exchange-instrument-metadata', comparable: true, ...extra });
}

test('manual market never uses saved paper positions or enabled automation', async t => {
  const f = fixture(t);
  f.store.set('config', { enabled: true, executionMode: 'staged' });
  await f.market.refresh();
  const view = f.market.view();
  assert.equal(view.config.enabled, undefined); assert.equal(view.config.executionMode, undefined);
  assert.equal(view.positions, undefined); assert.equal(f.store.positions().length, 0); assert.equal(f.store.executions().length, 0);
  assert.throws(() => f.market.settings({ config: { enabled: true } }), /手动交易/);
  assert.throws(() => f.market.settings({ config: { executionScenario: 'normal' } }), /手动交易/);
  assert.equal(f.market.view().opportunities.length, 1);
});

test('preview returns exact paired LIMIT quantities and never writes a fill', async t => {
  const f = fixture(t), plan = await f.market.previewOpen(`signal-${epoch}`);
  assert.equal(plan.kind, 'open'); assert.equal(plan.legs.length, 2);
  assert.equal(plan.legs[0].quantity, plan.legs[1].quantity);
  assert.equal(typeof plan.legs[0].quantity, 'string'); assert.equal(typeof plan.legs[0].price, 'string');
  assert.equal(plan.legs[0].side, 'BUY'); assert.equal(plan.legs[1].side, 'SELL');
  assert.ok(Number(plan.legs[0].notionalUSDT) <= 100); assert.ok(Number(plan.legs[1].notionalUSDT) <= 100);
  assert.equal(f.store.positions().length, 0); assert.equal(f.store.executions().length, 0);
  assert.ok(await f.market.revalidateOpen(plan));
  f.advance(1000); // A fresh signal version with the same identity is valid.
  assert.ok(await f.market.revalidateOpen(plan));
});

test('withdrawn opportunity, price movement, and changed settings invalidate confirmation', async t => {
  const f = fixture(t), plan = await f.market.previewOpen(`signal-${epoch}`);
  f.setFeed({ ...feed(epoch), signals: [] });
  await assert.rejects(f.market.revalidateOpen(plan), /撤回/);
  f.setFeed(feed(epoch));
  f.setDepth(q => ({ ...book(q, epoch), asks: [[q.ask + 2, 100]] }));
  await assert.rejects(f.market.revalidateOpen(plan), /价格限制/);
  f.setDepth(q => book(q, epoch));
  f.market.settings({ config: { slippageBps: 6 } });
  await assert.rejects(f.market.revalidateOpen(plan), /设置/);
});

test('new-entry pause and Monitor failure do not prevent independent reduce-only close previews', async t => {
  const f = fixture(t); f.offline(); f.market.settings({ config: { entryPaused: true } });
  const plan = await f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '0.25');
  assert.equal(f.identities, 1); assert.equal(plan.kind, 'close'); assert.equal(plan.legs[0].side, 'SELL');
  assert.equal(plan.legs[0].quantity, '0.25'); assert.equal(plan.legs[0].reduceOnly, true);
  await f.market.revalidateClose(plan);
  const short = await f.market.previewClose({ symbol: 'BYBIT_FUTURE_BTC_USDT', position_side: 'SHORT', position_qty: '-1' });
  assert.equal(short.legs[0].side, 'BUY'); assert.equal(short.legs[0].quantity, '1');
  await assert.rejects(f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '1.1'), /不超过/);
  await assert.rejects(f.market.previewClose({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '1' }, '0.2501'), /步长/);
});

test('LIMIT-specific size rule must be known or explicitly absent', async t => {
  const f = fixture(t); f.setRules(catalog);
  await assert.rejects(f.market.previewOpen(`signal-${epoch}`), /最大限价数量/);
});

test('explicit null limit is disclosed, quantity step stays exact and old quotes cannot authorize entry', async t => {
  const f = fixture(t); f.setRules(catalog.map(r => ({ ...r, max_limit_size: null, lot_size: '0.0000000001' })));
  const plan = await f.market.previewOpen(`signal-${epoch}`);
  assert.ok(plan.warnings.some(x => x.includes('最大限价数量')));
  assert.equal(f.store.positions().length, 0);
  f.advance(11000); f.setFeed(feed(epoch));
  await assert.rejects(f.market.revalidateOpen(plan), /过期/);
});

test('slow source response is discarded after a connection change', async t => {
  let done;
  const f = fixture(t, { feedReader: () => new Promise(resolve => { done = resolve; }) });
  const pending = f.market.refreshSource();
  f.market.settings({ config: { monitorUsername: 'replacement' } }); done(feed(epoch)); await pending;
  assert.equal(f.market.view().source.updatedAt, null); assert.equal(f.market.view().opportunities.length, 0);
});

test('Hyperliquid limits obey five significant figures as well as Gate ticks', async t => {
  const q = { ...quote('hyperliquid'), symbol: 'BTC', crossexSymbol: 'HYPERLIQUID_FUTURE_BTC_USDC',
    counterCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', contractKind: 'quanto', bid: 1234.5, ask: 1234.6 };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: { USDC: { bid: 1, ask: 1, at: epoch, source: 'isolated-test' } } }) });
  f.setRules([{ ...catalog[0], exchange_type: 'HYPERLIQUID', symbol: q.crossexSymbol, tick_size: '0.01', max_limit_size: null }]);
  const p = await f.market.previewClose({ symbol: q.crossexSymbol, position_side: 'LONG', position_qty: '1' });
  assert.equal(p.legs[0].price, '1233.9');
  await f.market.revalidateClose(p);
});

test('missing conversion cannot block a native reduce-only close but blocks new exposure totals', async t => {
  const q = { ...quote('bybit'), symbol: 'BTCPERP', quoteCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', counterCurrency: 'USDC', crossexSymbol: 'BYBIT_FUTURE_BTC_USDC', contractKind: 'linear' };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => { throw new Error('fx offline'); } });
  f.setRules([{ ...catalog[1], symbol: q.crossexSymbol, max_limit_size: '10000' }]);
  const plan = await f.market.previewClose({ symbol: q.crossexSymbol, position_side: 'SHORT', position_qty: '1' });
  assert.equal(plan.legs[0].notionalUSDT, null);
  await f.market.revalidateClose(plan);
  await assert.rejects(f.market.positionsNotional([{ symbol: q.crossexSymbol, position_qty: '1', mark_price: '100' }]));
});

test('manual tickets and equal-base pairs work independently of Monitor and never bypass precision or budget', async t => {
  const f = fixture(t); f.offline();
  const input = { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.25', orderType: 'LIMIT', price: '98', timeInForce: 'GTC' };
  const plan = await f.market.previewDirect(input);
  assert.equal(plan.source, 'direct'); assert.equal(plan.legs[0].price, '98');
  await f.market.revalidateOpen(plan);
  const pair = await f.market.previewPair({ longSymbol: input.symbol, shortSymbol: 'BYBIT_FUTURE_BTC_USDT', quantity: '0.25' });
  assert.equal(pair.source, 'pair'); assert.equal(pair.legs[0].quantity, pair.legs[1].quantity);
  assert.equal(pair.legs[1].side, 'SELL'); await f.market.revalidateOpen(pair);
  await assert.rejects(f.market.previewPair({ longSymbol: input.symbol, shortSymbol: input.symbol, quantity: '0.25' }), /不同交易所/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '0.2501' }), /步长/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '2' }), /预算/);
  await assert.rejects(f.market.previewDirect({ ...input, price: '98.001' }), /精度/);
  await assert.rejects(f.market.previewDirect({ ...input, quantity: 0.25 }), /无效/);
  f.market.settings({ config: { entryPaused: true } });
  await assert.rejects(f.market.revalidateOpen(plan), /设置/);
});

test('market tickets honor their own size cap and require current fillable depth', async t => {
  const f = fixture(t);
  f.setRules(catalog.map(r => ({ ...r, max_market_size: '0.1', max_limit_size: '10000' })));
  const input = { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.25', orderType: 'MARKET', timeInForce: 'IOC' };
  await assert.rejects(f.market.previewDirect(input), /单笔上限/);
  const p = await f.market.previewDirect({ ...input, quantity: '0.1' });
  assert.equal(p.legs[0].orderType, 'MARKET'); assert.ok(p.warnings.some(w => w.includes('不是最终成交')));
  await assert.rejects(f.market.previewDirect({ ...input, quantity: '0.1', price: '100' }), /无效/);
  f.setDepth(q => ({ ...book(q, epoch), asks: [[200, 100]] }));
  await assert.rejects(f.market.revalidateOpen(p), /深度不足/);
});

test('confirmation refreshes increased valuation within budget without changing the submitted order', async t => {
  const f = fixture(t); f.market.settings({ config: { notionalPerLeg: 200 } });
  const plan = await f.market.previewDirect({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', quantity: '1', orderType: 'LIMIT', price: '90', timeInForce: 'GTC' });
  assert.equal(plan.legs[0].notionalUSDT, '99');
  f.setDepth(q => ({ ...book(q, epoch), bids: [[110, 100]], asks: [[111, 100]] }));
  await f.market.revalidateOpen(plan);
  const leg = plan.legs[0];
  assert.equal(leg.referencePrice, '110'); assert.equal(leg.notionalUSDT, '110');
  assert.equal(leg.budgetPrice, '110'); assert.equal(leg.budgetFxRate, '1'); assert.equal(leg.singleLegBudgetUSDT, '200');
  assert.equal(leg.quantity, '1'); assert.equal(leg.price, '90'); assert.equal(leg.timeInForce, 'GTC');
});

test('confirmation refreshes FX valuation within budget and rejects conversion above the cap', async t => {
  let rate = 1;
  const q = { ...quote('bybit'), symbol: 'BTCPERP', quoteCurrency: 'USDC', settlementCurrency: 'USDC', collateralCurrency: 'USDC', counterCurrency: 'USDC', crossexSymbol: 'BYBIT_FUTURE_BTC_USDC', contractKind: 'linear' };
  const f = fixture(t, { identityReader: async () => q, fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180000, rates: { USDC: { bid: rate, ask: rate, at: epoch, source: 'isolated-test' } } }) });
  f.setRules([{ ...catalog[1], symbol: q.crossexSymbol, max_limit_size: '10000' }]);
  const plan = await f.market.previewDirect({ symbol: q.crossexSymbol, side: 'BUY', quantity: '0.1', orderType: 'LIMIT', price: '100', timeInForce: 'GTC' });
  rate = 1.01;
  await f.market.revalidateOpen(plan);
  assert.equal(plan.legs[0].notionalUSDT, '10.403'); assert.equal(plan.legs[0].budgetFxRate, '1.01');
  rate = 0.99;
  await f.market.revalidateOpen(plan);
  assert.equal(plan.legs[0].notionalUSDT, '10.197');
  rate = 10;
  await assert.rejects(f.market.revalidateOpen(plan), /103 USDT.*100 USDT.*3 USDT/);
  assert.equal(plan.legs[0].notionalUSDT, '10.197', 'a failed revalidation must not partially mutate the plan');
  assert.equal(plan.legs[0].price, '100'); assert.equal(plan.legs[0].quantity, '0.1');
});

test('single-leg preview and confirmation report exact budget boundary failures', async t => {
  const f = fixture(t), input = { symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'BUY', quantity: '1', orderType: 'LIMIT', price: '100', timeInForce: 'GTC' };
  const plan = await f.market.previewDirect(input);
  assert.equal(plan.legs[0].notionalUSDT, '100');
  assert.equal(plan.legs[0].singleLegBudgetUSDT, '100');
  await f.market.revalidateOpen(plan);
  await assert.rejects(f.market.previewDirect({ ...input, orderType: 'MARKET', price: undefined, timeInForce: 'IOC' }), /100\.05 USDT.*100 USDT.*0\.05 USDT/);
  f.setDepth(q => ({ ...book(q, epoch), asks: [[100.0000001, 100]] }));
  await assert.rejects(f.market.revalidateOpen(plan), error => error.status === 409 && /100\.000001 USDT.*100 USDT.*0\.000001 USDT/.test(error.message));
  assert.equal(plan.legs[0].notionalUSDT, '100');
});

test('manual pairs and Monitor orders accept SELL improvements only within each leg budget', async t => {
  for (const source of ['pair', 'monitor']) {
    const f = fixture(t);
    const plan = source === 'pair' ? await f.market.previewPair({ longSymbol: 'BINANCE_FUTURE_BTC_USDT', shortSymbol: 'BYBIT_FUTURE_BTC_USDT', quantity: '0.98' }) : await f.market.previewOpen(`signal-${epoch}`);
    const orders = plan.legs.map(({ price, quantity, side }) => ({ price, quantity, side }));
    assert.ok(plan.legs.every(l => l.singleLegBudgetUSDT === '100'));
    f.setDepth(q => ({ ...book(q, epoch), bids: [[q.exchange === 'bybit' ? 102.01 : q.bid, 100]] }));
    await f.market.revalidateOpen(plan);
    assert.equal(plan.legs[1].notionalUSDT, '99.9698');
    assert.deepEqual(plan.legs.map(({ price, quantity, side }) => ({ price, quantity, side })), orders);
    const valid = structuredClone(plan);
    f.setDepth(q => ({ ...book(q, epoch), bids: [[q.exchange === 'bybit' ? 102.05 : q.bid, 100]] }));
    await assert.rejects(f.market.revalidateOpen(plan), /100\.009 USDT.*100 USDT.*0\.009 USDT/);
    assert.deepEqual(plan, valid);
  }
});

test('large market snapshots keep refresh and views bounded and lightweight reads skip candidate work', async t => {
  const data = largeMarketData({ instrument: true });
  const market = createMarket(memoryMarketStore(), { clock: () => epoch, feedReader: async () => data.snapshot, catalogReader: async () => data.catalog });
  t.after(() => market.stop()); data.resetReads();
  await market.refresh();
  assert.ok(data.reads.quoteSymbols < data.snapshot.quotes.length * 12 + data.snapshot.signals.length * 100, 'refresh must not scan the quote directory separately for each signal');
  data.resetReads(); const full = market.view();
  assert.equal(full.opportunities.length, 200); assert.equal(full.opportunities.filter(s => s.eligible).length, 100);
  assert.ok(data.reads.quoteSymbols < 40000, 'a full view must not repeatedly traverse all 5000 quotes');
  assert.ok(data.reads.catalogSymbols < 10000, 'a full view must not scan the entire directory for each leg');
  assert.ok(data.reads.signalLegs < 20000, 'candidate identity lookup must not rescan all other signals');
  data.resetReads(); const light = market.view({ includeOpportunities: false });
  assert.deepEqual(data.reads, { quoteSymbols: 0, catalogSymbols: 0, signalLegs: 0 });
  assert.deepEqual({ ...light, opportunities: full.opportunities }, full);
  assert.equal(light.source.quoteCount, 5000); assert.equal(light.venues.find(v => v.id === 'binance').quoteCount, 2500);
  assert.ok(Buffer.byteLength(JSON.stringify(light)) < 2000);
});

test('new snapshots replace exact quote identities, venue status and withdrawn signals immediately', async t => {
  const f = fixture(t); await f.market.refresh(); assert.equal(f.market.view().opportunities[0].eligible, true);
  for (const alter of [
    next => { next.quotes[0] = { ...next.quotes[0], settlementCurrency: 'USDC' }; },
    next => { next.quotes[0] = { ...next.quotes[0], delisting: true }; },
    next => { next.quotes[0] = { ...next.quotes[0], bidAskAt: epoch - 10001 }; },
    next => { next.exchanges[0] = { ...next.exchanges[0], status: 'offline' }; },
  ]) {
    const next = feed(epoch); alter(next); f.setFeed(next); await f.market.refreshSource();
    assert.equal(f.market.view().opportunities[0].eligible, false);
    f.setFeed(feed(epoch)); await f.market.refreshSource(); assert.equal(f.market.view().opportunities[0].eligible, true);
  }
  f.setFeed({ ...feed(epoch), signals: [] }); await f.market.refreshSource();
  assert.deepEqual(f.market.view().opportunities, []);
  await assert.rejects(f.market.previewOpen(`signal-${epoch}`), /撤回/);
});

test('indexed eligibility preserves the first signal with the exact declared pair and identities', async t => {
  const f = fixture(t), next = feed(epoch), valid = next.signals[0];
  next.signals = [{ ...valid, id: 'expired-first', expiresAt: epoch }, valid];
  f.setFeed(next); await f.market.refresh();
  assert.ok(f.market.view().opportunities.every(s => !s.eligible));
  await assert.rejects(f.market.previewOpen(valid.id), /过期/);
  const mismatched = { ...next, signals: [{ ...valid, id: 'wrong-declared-pair', pairKey: 'not-the-pair', expiresAt: epoch }, valid] };
  f.setFeed(mismatched); await f.market.refreshSource();
  assert.equal(f.market.view().opportunities.find(s => s.id === valid.id).eligible, true);
});

test('cached identities never cache away transfer expiry or current freshness windows', async t => {
  const f = fixture(t), next = feed(epoch);
  next.crossexFilter = { requireSpotTransfer: true, blockedBases: [], revision: 1 };
  next.signals[0] = { ...next.signals[0], expiresAt: epoch + 500, spotTransfer: { networks: ['ETH'], checkedAt: epoch, expiresAt: epoch + 500 } };
  f.setFeed(next); await f.market.refresh();
  assert.equal(f.market.view().opportunities[0].eligible, true);
  f.advance(500);
  assert.equal(f.market.view({ includeOpportunities: false }).source.state, 'live');
  assert.equal(f.market.view().opportunities[0].eligible, false);
  assert.match(f.market.view().opportunities[0].reason, /过期/);
  f.advance(10001);
  assert.equal(f.market.view({ includeOpportunities: false }).source.state, 'stale');
  assert.equal(f.market.view({ includeOpportunities: false }).source.updatedAt, epoch);
});

test('source summary re-evaluates future timestamp bounds without another refresh', async t => {
  const f = fixture(t), next = feed(epoch);
  next.quotes = next.quotes.map(q => ({ ...q, bidAskAt: epoch + 2000, receivedAt: epoch + 2000 }));
  next.signals = []; f.setFeed(next); await f.market.refresh();
  const early = f.market.view({ includeOpportunities: false });
  assert.equal(early.source.updatedAt, null); assert.equal(early.source.state, 'stale');
  f.advance(1000);
  const current = f.market.view({ includeOpportunities: false });
  assert.equal(current.source.updatedAt, epoch + 2000); assert.equal(current.source.state, 'live');
});

test('catalog indices refresh exact venue keys and retain first duplicate validation', async t => {
  const f = fixture(t), rules = catalog.map(r => ({ ...r, max_limit_size: '10000' }));
  f.setRules([{ ...rules[0], exchange_type: 'BYBIT', state: 'suspend' }, ...rules]); await f.market.refresh();
  assert.equal(f.market.view().opportunities[0].eligible, true, 'another venue with the same symbol cannot shadow the exact rule');
  f.advance(300000); f.setRules([{ ...rules[0], state: 'suspend' }, ...rules]); await f.market.refresh();
  assert.equal(f.market.view().opportunities[0].eligible, false);
  assert.match(f.market.view().opportunities[0].reason, /未在 CrossEx/);
  f.advance(300000); f.setRules(rules); await f.market.refresh();
  assert.equal(f.market.view().opportunities[0].eligible, true);
  f.advance(300000); f.setRules(rules.map(r => ({ ...r, tick_size: '0.1' }))); await f.market.refresh();
  await assert.rejects(f.market.previewDirect({ symbol: rules[0].symbol, side: 'BUY', quantity: '0.1', price: '98.01', orderType: 'LIMIT', timeInForce: 'GTC' }), /精度/);
});

test('persisted catalogs are indexed before the first refresh and still expire', async t => {
  let now = epoch, reads = 0;
  const market = createMarket(memoryMarketStore({ catalog: { at: epoch, items: catalog.map(r => ({ ...r, max_limit_size: '10000' })) } }), {
    clock: () => now, feedReader: async () => feed(now), catalogReader: async () => { reads++; throw new Error('offline'); },
  });
  t.after(() => market.stop()); await market.refresh();
  assert.equal(reads, 0); assert.equal(market.view().opportunities[0].eligible, true);
  now += 900001; await market.refresh();
  assert.equal(reads, 1); assert.equal(market.view().catalog.state, 'unavailable'); assert.equal(market.view().opportunities[0].eligible, false);
});

test('configuration changes affect candidate decisions immediately and connection changes clear source metadata', async t => {
  const f = fixture(t); await f.market.refresh();
  const saved = f.market.settings({ config: { entryPaused: true } });
  assert.deepEqual(saved.opportunities, []); assert.equal(saved.config.entryPaused, true); assert.equal(saved.source.quoteCount, 2);
  assert.equal(f.market.view().opportunities[0].eligible, false); assert.match(f.market.view().opportunities[0].reason, /暂停/);
  f.market.settings({ config: { entryPaused: false, minNetBps: 5000 } });
  assert.equal(f.market.view().opportunities[0].eligible, false); assert.match(f.market.view().opportunities[0].reason, /门槛/);
  f.market.settings({ config: { minNetBps: 20 } }); assert.equal(f.market.view().opportunities[0].eligible, true);
  const disconnected = f.market.settings({ config: { monitorUsername: 'changed' } });
  assert.equal(disconnected.source.quoteCount, 0); assert.equal(disconnected.source.updatedAt, null); assert.equal(disconnected.source.state, 'offline');
  assert.ok(disconnected.venues.every(v => v.quoteCount === 0)); assert.deepEqual(f.market.view().opportunities, []);
  await f.market.refreshSource(); assert.equal(f.market.view().opportunities[0].eligible, true);
});

test('manual direct, pair and close use native identity and depth readers independently of Monitor', async t => {
  let identities = 0, depths = 0;
  const f = fixture(t, { identityReader: async () => { throw new Error('strict identity unavailable'); }, depthReader: async () => { throw new Error('strict depth unavailable'); },
    manualIdentityReader: async symbol => { identities++; return manualQuote(symbol.startsWith('GATE_') ? 'gate' : 'okx'); },
    manualDepthReader: async q => { depths++; return book(q, epoch); } });
  f.offline(); f.setRules(['GATE', 'OKX'].map(exchange => ({ ...catalog[0], exchange_type: exchange, symbol: `${exchange}_FUTURE_BTC_USDT`, max_limit_size: '10000' })));
  const direct = await f.market.previewDirect({ symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY', quantity: '0.25', orderType: 'LIMIT', price: '100', timeInForce: 'GTC' });
  await f.market.revalidateOpen(direct);
  const pair = await f.market.previewPair({ longSymbol: 'GATE_FUTURE_BTC_USDT', shortSymbol: 'OKX_FUTURE_BTC_USDT', quantity: '0.25' });
  await f.market.revalidateOpen(pair);
  const close = await f.market.previewClose({ symbol: 'GATE_FUTURE_BTC_USDT', position_side: 'LONG', position_qty: '0.25' });
  await f.market.revalidateClose(close);
  assert.equal(identities, 8); assert.equal(depths, 8);
});

test('manual confirmation rejects changed native units, asset class and identity scope', async t => {
  let current = manualQuote('binance');
  const f = fixture(t, { manualIdentityReader: async () => ({ ...current }) });
  const plan = await f.market.previewDirect({ symbol: current.crossexSymbol, side: 'BUY', quantity: '0.25', orderType: 'LIMIT', price: '98', timeInForce: 'GTC' });
  for (const changes of [{ nativeUnit: '2' }, { assetClass: 'commodity', comparable: false }, { identityScope: 'comparable' }]) {
    current = { ...manualQuote('binance'), ...changes };
    await assert.rejects(f.market.revalidateOpen(plan), /身份已变化/);
  }
  current = manualQuote('binance'); await f.market.revalidateOpen(plan);
});

test('close preview and confirmation re-resolve native identity even when Monitor has a saved matching quote', async t => {
  let current = manualQuote('binance'), identities = 0;
  const f = fixture(t, { manualIdentityReader: async () => { identities++; return { ...current }; } });
  await f.market.refresh();
  const plan = await f.market.previewClose({ symbol: current.crossexSymbol, position_side: 'LONG', position_qty: '0.25' });
  assert.equal(identities, 1); assert.equal(plan.legs[0].quote.identityScope, 'manual');
  current = { ...current, nativeUnit: '0.01' };
  await assert.rejects(f.market.revalidateClose(plan), /身份已变化/); assert.equal(identities, 2);
  current = { ...current, nativeUnit: '1', identityVerified: false };
  await assert.rejects(f.market.revalidateClose(plan), /未确认/); assert.equal(identities, 3);
});

test('a positive noncrypto native identity permits only direct trading and cannot become an equal-base pair', async t => {
  let second = manualQuote('okx', { assetClass: 'commodity', comparable: false });
  const f = fixture(t, { manualIdentityReader: async symbol => symbol.startsWith('GATE_') ? manualQuote('gate') : { ...second } });
  f.setRules(['GATE', 'OKX'].map(exchange => ({ ...catalog[0], exchange_type: exchange, symbol: `${exchange}_FUTURE_BTC_USDT`, max_limit_size: '10000' })));
  const direct = await f.market.previewDirect({ symbol: second.crossexSymbol, side: 'BUY', quantity: '0.25', orderType: 'LIMIT', price: '100', timeInForce: 'GTC' });
  await f.market.revalidateOpen(direct);
  const request = { longSymbol: 'GATE_FUTURE_BTC_USDT', shortSymbol: second.crossexSymbol, quantity: '0.25' };
  await assert.rejects(f.market.previewPair(request), /身份可比/);
  second = manualQuote('okx'); const pair = await f.market.previewPair(request);
  second = { ...second, assetClass: 'commodity', comparable: false };
  await assert.rejects(f.market.revalidateOpen(pair), /不再可比/);
});

test('display resolution requires an exact live CrossEx rule but never requires native identity', async t => {
  let nativeReads = 0;
  const f = fixture(t, { manualIdentityReader: async () => { nativeReads++; throw new Error('native unavailable'); } });
  const symbol = 'OKX_FUTURE_CL_USDC', rule = { ...catalog[0], exchange_type: 'OKX', symbol, max_limit_size: null, contract_size: null };
  f.setRules([rule]); const resolved = await f.market.resolveDisplaySymbol(symbol);
  assert.deepEqual(resolved.quote, { exchange: 'okx', base: 'CL', quoteCurrency: 'USDC', settlementCurrency: 'USDC', crossexSymbol: symbol });
  assert.equal(resolved.rule.symbol, symbol); assert.equal(nativeReads, 0);
  await assert.rejects(f.market.resolveSymbol(symbol), /native unavailable/); assert.equal(nativeReads, 1);
  for (const changes of [{ state: 'suspend' }, { tick_size: '0' }, { exchange_type: 'GATE' }, { delist_time: '1' }]) {
    f.advance(300000); f.setRules([{ ...rule, ...changes }]);
    await assert.rejects(f.market.resolveDisplaySymbol(symbol), /未在 CrossEx|规则/);
  }
  assert.equal(nativeReads, 1);
});

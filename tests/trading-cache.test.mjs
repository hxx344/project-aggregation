import test from 'node:test';
import assert from 'node:assert/strict';
import { ageTradingData, createTradingCache, normalizeTradingPair, tradingCacheNow } from '../src/trading-cache.ts';

const time = '2026-10-07T04:00:00.000Z';
const state = (days = 7, page = 0, revision = 1) => ({
  generatedAt: time, cache: { builtAt: time, servedAt: time, rebuilding: false }, period: { days },
  accounts: ['binance', 'bybit'].map(exchange => ({ exchange, connected: true, revision,
    positions: { state: 'live', fetchedAt: time }, funding: { state: 'live', fetchedAt: time, complete: true },
  })),
  legs: ['binance', 'bybit'].map(exchange => ({ exchange, state: 'live', fetchedAt: time, fundingComplete: true, fundingNet: '0' })),
  structure: { state: 'opposed', message: '四腿方向均相反' },
  funding: { complete: true, income: '0', expense: '0', net: '0', pagination: { page, pageSize: 50, total: 63, pages: 2 }, events: Array(page ? 13 : 50).fill({ amount: '0.1' }), daily: [{ date: '2026-10-07', income: '1', expense: '1', net: '0', complete: true }] },
  pnl: { end: Date.parse(time), latest: { time: Date.parse(time), unrealizedPnl: '1', fundingPnl: '2', totalPnl: '3' }, points: [{ time: Date.parse(time), unrealizedPnl: '1', fundingPnl: '2', totalPnl: '3' }], pointCount: 1, status: 'ready' },
});
const read = (cache, data) => { const request = cache.beginRead(); assert.equal(cache.accept(request, data), true); cache.finish(request); return data; };

test('session cache reuses exact range and server page without expanding ledger responses', () => {
  const cache = createTradingCache();
  const first = read(cache, state()), second = read(cache, state(7, 1)), month = read(cache, state(30));
  assert.equal(cache.get(7, 0).data, first);
  assert.equal(cache.get(7, 1).data, second);
  assert.equal(cache.get(30, 0).data, month);
  assert.equal(cache.get(7, 1).data.funding.events.length, 13);
  cache.select(7, 1); assert.deepEqual(cache.selection(), { days: 7, page: 1, pair: 'binance,bybit' });
});

test('LRU holds at most twelve pages and preserves both range landing pages', () => {
  const cache = createTradingCache();
  read(cache, state()); read(cache, state(30));
  for (let page = 1; page <= 10; page++) read(cache, state(7, page));
  const recentlyViewed = cache.get(7, 1);
  read(cache, state(7, 11));
  assert.equal(cache.get(7, 1), recentlyViewed, 'reading a page updates its recency');
  assert.equal(cache.get(7, 2), null, 'least recently viewed non-landing page is evicted');
  assert.ok(cache.get(7, 0)); assert.ok(cache.get(30, 0));
  for (let page = 12; page <= 100; page++) read(cache, state(7, page));
  let count = Number(!!cache.get(30, 0));
  for (let page = 0; page <= 100; page++) count += Number(!!cache.get(7, page));
  assert.equal(count, 12);
  assert.ok(cache.get(7, 0)); assert.ok(cache.get(30, 0));
  assert.equal(cache.latest().data.funding.pagination.page, 100);
});

test('late reads cannot overwrite a newer request or restore an older account revision', () => {
  const cache = createTradingCache(), earlier = cache.beginRead(), later = cache.beginRead();
  assert.equal(cache.accept(later, state()), true);
  assert.equal(cache.accept(earlier, state()), false);
  const obsolete = cache.beginRead();
  read(cache, state(30, 0, 2));
  assert.equal(obsolete.controller.signal.aborted, true);
  assert.equal(cache.accept(obsolete, state(7, 0, 1)), false);
  assert.equal(cache.get(7, 0), null);
  const staleRevision = cache.beginRead();
  assert.equal(cache.accept(staleRevision, state(7, 0, 1)), false);
  assert.equal(cache.latest().data.accounts[0].revision, 2);
});

test('account mutations share a session lock and invalidate every cached range and page', () => {
  const cache = createTradingCache();
  read(cache, state(7)); read(cache, state(7, 1)); read(cache, state(30));
  const pending = cache.beginRead(), mutation = cache.beginMutation('binance');
  assert.equal(pending.controller.signal.aborted, true);
  cache.select(30, 0);
  assert.equal(cache.beginMutation('binance'), null);
  assert.equal(cache.busy(), 'binance');
  assert.equal(cache.accept(mutation, state(7, 0, 2), true), true);
  assert.equal(cache.get(7, 1), null); assert.equal(cache.get(30, 0), null);
  cache.finish(mutation); assert.equal(cache.busy(), null);
  assert.equal(cache.accept(pending, state()), false);
});

test('logout or expiry clears cached data and aborts all request kinds across a new login', () => {
  const cache = createTradingCache(); read(cache, state());
  const source = cache.beginSource(), mutation = cache.beginMutation('bybit'), pending = cache.beginRead();
  cache.clear();
  assert.equal(cache.latest(), null); assert.equal(cache.get(7, 0), null); assert.equal(cache.busy(), null);
  for (const request of [source, mutation, pending]) {
    assert.equal(request.controller.signal.aborted, true);
    assert.equal(cache.valid(request), false);
    assert.equal(cache.accept(request, state()), false);
  }
  read(cache, state(30, 0, 0));
  assert.equal(cache.get(7, 0), null); assert.equal(cache.latest().data.accounts[0].revision, 0);
});

test('freshness advances from server servedAt and elapsed time, independently of client wall clock', () => {
  const cache = createTradingCache(); read(cache, state()); const entry = cache.latest();
  const now = tradingCacheNow(entry, entry.receivedAt + 75_001);
  assert.equal(now, Date.parse(time) + 75_001);
  const aged = ageTradingData(entry, now);
  assert.equal(aged.accounts[0].positions.state, 'stale'); assert.equal(aged.legs[0].state, 'stale');
  assert.equal(aged.accounts[0].funding.state, 'live');
  assert.equal(ageTradingData(entry, now + 900_000).accounts[0].funding.state, 'stale');
  assert.equal(entry.data.accounts[0].positions.state, 'live', 'cached payload remains immutable');
  assert.equal(ageTradingData(entry, Date.parse(time), true).accounts[0].positions.state, 'stale');
  const failed = cache.beginRead(); cache.fail(failed, 7, 0);
  assert.equal(ageTradingData(entry, Date.parse(time)).accounts[0].funding.state, 'stale');
  read(cache, state()); assert.equal(cache.latest().failed, false);
});

test('position expiry removes the structure conclusion and appends one missing latest PnL sample', () => {
  const cache = createTradingCache(); read(cache, state()); const entry = cache.latest();
  const aged = ageTradingData(entry, Date.parse(time) + 75_001);
  assert.equal(aged.structure.state, 'unknown');
  assert.equal(aged.structure.message, '等待两所最新仓位，暂不判断四腿结构');
  assert.equal(aged.funding.complete, true, 'funding has its separate freshness threshold');
  assert.equal(aged.pnl.status, 'incomplete');
  assert.deepEqual(aged.pnl.latest, { time: Date.parse(time) + 75_001, unrealizedPnl: null, fundingPnl: null, totalPnl: null });
  assert.equal(aged.pnl.points.length, 2);
  assert.deepEqual(aged.pnl.points[0], entry.data.pnl.points[0]);
  assert.equal(ageTradingData(entry, Date.parse(time) + 120_000).pnl.points.length, 2, 'repeated aging never accumulates synthetic samples');
  assert.equal(entry.data.structure.state, 'opposed'); assert.equal(entry.data.pnl.status, 'ready');
  assert.equal(entry.data.pnl.points.length, 1, 'original history remains unchanged');
  assert.equal(ageTradingData(entry, Date.parse(time), true).pnl.latest.totalPnl, null, 'offline state does not present a current total');
  const failed = cache.beginRead(); cache.fail(failed, 7, 0);
  assert.equal(ageTradingData(entry, Date.parse(time)).pnl.latest.totalPnl, null);
});

test('funding expiry propagates to accounts, legs and daily coverage without inferring missing data from one page', () => {
  const cache = createTradingCache(), data = state(7, 1);
  data.funding.events = [];
  data.accounts[1].funding.fetchedAt = new Date(Date.parse(time) - 900_001).toISOString();
  read(cache, data);
  const aged = ageTradingData(cache.latest(), Date.parse(time));
  assert.equal(aged.accounts[0].funding.complete, true);
  assert.equal(aged.accounts[1].funding.complete, false);
  assert.equal(aged.legs[0].fundingComplete, true);
  assert.equal(aged.legs[1].fundingComplete, false);
  assert.equal(aged.funding.complete, false); assert.equal(aged.funding.daily[0].complete, false);
  assert.equal(aged.funding.net, '0', 'empty current page does not prove the whole range has no receipts');
  assert.equal(aged.funding.daily[0].income, '1'); assert.equal(aged.funding.daily[0].net, '0');
  assert.equal(aged.legs[1].fundingNet, '0', 'a known zero net may have offsetting receipts elsewhere');
  assert.equal(data.funding.daily[0].complete, true);
});

test('an expired empty range no longer presents confirmed zero funding totals', () => {
  const cache = createTradingCache(), data = state();
  data.funding.pagination.total = 0; data.funding.events = [];
  data.funding.daily = [{ date: '2026-10-07', income: '0', expense: '0', net: '0', complete: true }];
  read(cache, data);
  const aged = ageTradingData(cache.latest(), Date.parse(time) + 900_001);
  assert.equal(aged.funding.complete, false);
  for (const key of ['income', 'expense', 'net']) {
    assert.equal(aged.funding[key], null); assert.equal(aged.funding.daily[0][key], null);
  }
  assert.ok(aged.legs.every(leg => !leg.fundingComplete && leg.fundingNet === null));
});

test('pair pages, latest fallbacks and selection never expose another pair', () => {
  const cache = createTradingCache();
  for (const pair of ['binance,bybit', 'binance,okx', 'bybit,okx']) {
    assert.equal(cache.get(7, 0, pair), null);
    assert.equal(cache.latest(pair), null);
    const data = { ...state(), exchanges: pair.split(',') };
    data.accounts = ['binance', 'bybit', 'okx'].map(exchange => ({ ...data.accounts[0], exchange }));
    const request = cache.beginRead(pair);
    assert.equal(cache.accept(request, data), true); cache.finish(request);
    assert.equal(cache.get(7, 0, pair).data, data);
    assert.equal(cache.latest(pair).data, data);
  }
  cache.select(30, 3, 'binance,okx');
  assert.deepEqual(cache.selection(), { days: 30, page: 3, pair: 'binance,okx' });
  assert.deepEqual(cache.latest('binance,bybit').data.exchanges, ['binance', 'bybit']);
  const wrong = cache.beginRead('bybit,okx');
  assert.equal(cache.accept(wrong, { ...state(), exchanges: ['binance', 'okx'] }), false);
  cache.clear();
  for (const pair of ['binance,bybit', 'binance,okx', 'bybit,okx']) assert.equal(cache.latest(pair), null);
});

test('replacing an account invalidates all pairs and old pair responses', () => {
  const cache = createTradingCache();
  for (const pair of ['binance,bybit', 'binance,okx']) {
    const data = { ...state(), exchanges: pair.split(',') };
    const request = cache.beginRead(pair); assert.equal(cache.accept(request, data), true); cache.finish(request);
  }
  const pending = cache.beginRead('binance,bybit');
  const mutation = cache.beginMutation('okx', 'binance,okx');
  assert.equal(cache.accept(mutation, { ...state(), exchanges: ['binance', 'okx'] }, true), true);
  assert.equal(cache.latest('binance,bybit'), null);
  assert.equal(cache.get(7, 0, 'binance,bybit'), null);
  assert.equal(cache.accept(pending, state()), false);
  assert.ok(cache.latest('binance,okx'));
});

test('the third unconfigured account does not degrade selected funding, positions or structure', () => {
  const cache = createTradingCache(), data = state();
  data.exchanges = ['binance', 'bybit'];
  data.accounts.push({ exchange: 'okx', connected: false, revision: 0,
    positions: { state: 'unconfigured', fetchedAt: null }, funding: { state: 'unconfigured', fetchedAt: null, complete: false } });
  read(cache, data);
  const aged = ageTradingData(cache.latest(), Date.parse(time));
  assert.equal(aged.funding.complete, true);
  assert.equal(aged.funding.daily[0].complete, true);
  assert.equal(aged.structure.state, 'opposed');
  assert.equal(aged.accounts[2].positions.state, 'unconfigured');
});

test('URL pair selection uses canonical exchange order and safe defaults', () => {
  assert.equal(normalizeTradingPair('okx,binance'), 'binance,okx');
  assert.equal(normalizeTradingPair('okx,bybit'), 'bybit,okx');
  for (const pair of [null, '', 'okx', 'binance,binance', 'binance,bybit,okx', 'unknown,okx']) assert.equal(normalizeTradingPair(pair), 'binance,bybit');
});

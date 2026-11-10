import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('./') && context.parentURL?.includes('/src/') && error.code === 'ERR_MODULE_NOT_FOUND') return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { createPositionsCache } = await import('../src/positions-cache.ts');
const { positionsReply } = await import('../src/hub-positions.ts');
const at = '2026-11-10T04:00:00.000Z';
const data = (positions = [{ symbol: 'CLUSDT', instrumentId: 'CLUSDT', side: 'long', quantity: '3.14', quantityUnit: 'CL', entryPrice: '70', markPrice: '72', unrealizedPnl: '6.28', pnlCurrency: 'USDT' }]) => ({ generatedAt: at, sources: [{ projectId: 'asset', name: 'Asset', status: 'ready', checkedAt: at, error: null, data: { schemaVersion: 1, generatedAt: at, exchanges: [{ id: 'binance', name: 'Binance', accounts: [{ id: 'default', revision: 'revision', configured: true, name: '主账户', scopes: [{ id: 'linear', label: '永续', status: 'live', refreshing: false, fetchedAt: at, error: null, positions }] }] }] } }] });
const request = { requestId: 'test', market: 'oil', symbols: ['CL'] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('positions views share one cold read and remounts reuse the same evidence immediately', async () => {
  let tick = 0, reads = 0;
  const held = deferred();
  const cache = createPositionsCache(() => { reads++; return held.promise; }, () => tick);
  const page = cache.refresh(), bridge = cache.read(true);
  await Promise.resolve(); assert.equal(reads, 1);
  held.resolve(data()); await Promise.all([page, bridge]);
  const snapshot = cache.getSnapshot();
  const unsubscribe = cache.subscribe(() => {}); unsubscribe();
  assert.equal(cache.getSnapshot(), snapshot, 'unmount leaves the session snapshot');
  tick = 3000;
  const reply = positionsReply(request, await cache.read(true), cache.now());
  assert.equal(reads, 1); assert.equal(reply.items[0].quantity, '3.14');
  assert.equal(cache.now(), Date.parse(at) + 3000, 'cache reads never renew the observation clock');
});

test('a slow refresh returns cached positions before the request settles; failure stays stale until success', async () => {
  let tick = 0, next = Promise.resolve(data());
  const cache = createPositionsCache(() => next, () => tick);
  await cache.refresh();
  const held = deferred(); next = held.promise; tick = 21_000;
  const cached = await cache.read(true);
  assert.equal(cached.status, 'ok'); assert.equal(cache.getSnapshot().reading, true);
  const pending = cache.refresh();
  held.reject(new TypeError('网络中断')); await pending;
  assert.equal(cache.getSnapshot().data.generatedAt, at);
  assert.equal(cache.getSnapshot().receivedAt, 0);
  let reply = positionsReply(request, await cache.read(false), cache.now());
  assert.equal(reply.items[0].stale, true);
  tick += 5000;
  assert.equal((await cache.read(true)).status, 'ok');
  assert.equal(cache.getSnapshot().failed, true, 'online/read-start cannot revalidate failed evidence');
  next = Promise.resolve(data([])); await cache.refresh(true);
  reply = positionsReply(request, await cache.read(false), cache.now());
  assert.equal(reply.items.length, 0); assert.equal(reply.incomplete, false, 'successful empty response clears old positions');
});

test('session/source invalidation fences late responses, and a 401 removes all cached positions', async () => {
  let tick = 0, next = Promise.resolve(data());
  const cache = createPositionsCache(() => next, () => tick);
  await cache.refresh();
  const old = deferred(); next = old.promise; tick = 6000;
  const pending = cache.refresh(); await Promise.resolve(); cache.clear();
  old.resolve(data()); await pending;
  assert.equal(cache.getSnapshot().data, null);
  next = Promise.resolve(data()); await cache.refresh();
  next = Promise.reject(Object.assign(new Error('登录已过期'), { status: 401 }));
  assert.equal((await cache.refresh(true)).status, 'unauthorized');
  assert.equal(cache.getSnapshot().data, null); assert.equal(cache.getSnapshot().unauthorized, true);
  assert.equal((await cache.read(false)).status, 'unauthorized');
});

test('malformed responses retain old evidence; offline cancellation cannot restore live data', async () => {
  let next = Promise.resolve(data());
  const cache = createPositionsCache(() => next);
  await cache.refresh();
  next = Promise.resolve({ generatedAt: at, sources: 'bad' }); await cache.refresh(true);
  assert.equal(cache.getSnapshot().failed, true); assert.equal(cache.getSnapshot().data.sources.length, 1);
  const held = deferred(); next = held.promise;
  const pending = cache.refresh(true); await Promise.resolve(); cache.markUnavailable();
  held.resolve(data()); await pending;
  assert.equal(cache.getSnapshot().failed, true); assert.equal(cache.getSnapshot().reading, false);
});

test('stale empty scopes never confirm there are no related positions', async () => {
  let tick = 0;
  const cache = createPositionsCache(async () => data([]), () => tick);
  await cache.refresh(); tick = 91_000;
  assert.equal(positionsReply(request, await cache.read(false), cache.now()).incomplete, true);
  cache.markUnavailable(); tick = 0;
  assert.equal(positionsReply(request, await cache.read(false), cache.now()).incomplete, true);
});

test('account changes block reads until every server invalidation is acknowledged, retrying only failures', async () => {
  let reads = 0, checksA = 0, checksB = 0, failB = true;
  const cache = createPositionsCache(async () => { reads++; return data([]); });
  await cache.refresh();
  const held = deferred();
  cache.invalidate({ id: 'asset-a', run: async signal => { checksA++; await held.promise; signal.throwIfAborted(); } });
  cache.invalidate({ id: 'asset-b', run: async () => { checksB++; if (failB) throw new TypeError('check failed'); } });
  const pending = cache.refresh();
  assert.equal(cache.getSnapshot().data, null); assert.equal(reads, 1);
  held.resolve(); await pending;
  assert.equal(reads, 1, 'no GET may repopulate the cache before acknowledgement succeeds');
  assert.equal(cache.getSnapshot().failed, true);
  failB = false; await cache.refresh();
  assert.equal(checksA, 1); assert.equal(checksB, 2); assert.equal(reads, 2);
  assert.equal(cache.getSnapshot().data.sources[0].data.exchanges[0].accounts[0].scopes[0].positions.length, 0);
});

test('session clear cancels an invalidation barrier and fences its late acknowledgement', async () => {
  let reads = 0;
  const held = deferred();
  const cache = createPositionsCache(async () => { reads++; return data(); });
  cache.invalidate({ id: 'asset', run: async () => held.promise });
  const pending = cache.refresh(); cache.clear(); held.resolve(); await pending;
  assert.equal(reads, 0); assert.equal(cache.getSnapshot().data, null);
  await cache.refresh(); assert.equal(reads, 1, 'a new login does not inherit old acknowledgement tasks');
});

test('delayed supplemental legs cannot publish snapshots revoked by clear, offline or 401', async () => {
  for (const event of ['clear', 'offline', '401']) {
    let next = Promise.resolve(data());
    const cache = createPositionsCache(() => next);
    await cache.refresh();
    const generation = cache.generation(), heldLegs = deferred();
    const waiting = Promise.all([cache.read(true), heldLegs.promise]).then(([, legs]) => cache.reply(request, legs, generation));
    if (event === 'clear') cache.clear();
    else if (event === 'offline') cache.markUnavailable();
    else { next = Promise.reject(Object.assign(new Error('expired'), { status: 401 })); await cache.refresh(true); }
    heldLegs.resolve({ status: 'ok', at: 0, data: { sources: [] } });
    const reply = await waiting;
    if (event === 'offline') { assert.equal(reply.items.length, 1); assert.equal(reply.items[0].stale, true); }
    else { assert.equal(reply.items.length, 0); assert.equal(reply.status, event === '401' ? 'unauthorized' : 'unavailable'); }
  }
});

test('a new generation may publish new positions but must discard old supplemental legs', async () => {
  let next = data();
  const cache = createPositionsCache(async () => next);
  await cache.refresh(); const generation = cache.generation();
  cache.invalidate(); next = data([]); await cache.refresh();
  const oldLegs = { status: 'ok', at: 0, data: { sources: [{ exchange: 'hyperliquid', connected: true, state: 'live', fetchedAt: at,
    positions: [{ symbol: 'xyz:ANT', side: 'long', quantity: '10', entryPrice: '1', markPrice: '2', unrealizedPnl: '10' }] }] } };
  const reply = cache.reply({ ...request, market: 'anthropic', symbols: ['XYZANT'] }, oldLegs, generation);
  assert.equal(reply.status, 'ok'); assert.equal(reply.items.length, 0); assert.equal(reply.incomplete, true);
});

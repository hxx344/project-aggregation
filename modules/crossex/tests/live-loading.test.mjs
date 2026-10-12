import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRead } from '../src/latest-read.ts';
import { BOOTSTRAP_REFRESH_MS, CATALOG_CACHE_MS, createTimedCache, latestBootstrap, needsCatalog, parseBootstrap, readRetryDelay, stateReadPath } from '../src/live-loading.ts';

const bootstrap = (changes = {}) => ({ now: 100, csrfToken: 'bootstrap-csrf', config: { monitorUrl: 'http://monitor', entryPaused: false }, connection: { configured: false, connected: false }, ...changes });

test('connection setup can use the lightweight configuration while the full state is unavailable', () => {
  const data = parseBootstrap(bootstrap());
  assert.equal(latestBootstrap(data, null), data);
  assert.equal(latestBootstrap(data, null).csrfToken, 'bootstrap-csrf');
  assert.equal(latestBootstrap(null, null), null, 'unknown configuration must not become an empty configured account');
  for (const value of [null, {}, bootstrap({ csrfToken: '' }), bootstrap({ connection: {} }), bootstrap({ config: {} })]) {
    assert.throws(() => parseBootstrap(value), /连接信息格式不可用/);
  }
});

test('administrative actions use the newest authoritative CSRF/configuration', () => {
  const earlier = bootstrap(), latest = bootstrap({ now: 200, csrfToken: 'updated-csrf' });
  const state = { now: 150, csrfToken: 'state-csrf', config: { monitorUrl: 'http://state' }, live: { connection: { configured: true } } };
  assert.equal(latestBootstrap(earlier, state).csrfToken, 'state-csrf');
  assert.equal(latestBootstrap(latest, state).csrfToken, 'updated-csrf');
  assert.equal(latestBootstrap(null, { ...state, csrfToken: '' }), null);
});

test('heavy opportunities and the instrument catalogue are requested only by relevant views', () => {
  assert.equal(stateReadPath('hedge'), '/api/state');
  for (const tab of ['trade', 'positions', 'orders', 'settings']) assert.equal(stateReadPath(tab), '/api/state?opportunities=0');
  for (const tab of ['trade', 'positions', 'hedge']) assert.equal(needsCatalog(tab), true);
  for (const tab of ['settings', 'orders']) assert.equal(needsCatalog(tab), false);
});

test('catalogue memory cache reuses the same list for five minutes and then requires a fresh read', () => {
  let now = 1000;
  const cache = createTimedCache(CATALOG_CACHE_MS, () => now), items = [{ symbol: 'BINANCE_PERP_BTC_USDT' }];
  assert.equal(cache.peek().fresh, false);
  cache.put(items);
  now += CATALOG_CACHE_MS - 1;
  assert.equal(cache.peek().fresh, true);
  assert.equal(cache.peek().value, items, 'stable references avoid rebuilding the instrument filter on account polls');
  now++;
  assert.equal(cache.peek().fresh, false);
  assert.equal(cache.peek().value, items, 'stale catalogue remains visible while a new read is pending');
  cache.put([]);
  assert.equal(cache.peek().fresh, true, 'a genuine empty catalogue is also cached');
});

test('failed reads back off and successful bootstrap polling stays infrequent', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(readRetryDelay), [3000, 6000, 12000, 24000, 30000, 30000]);
  assert.equal(BOOTSTRAP_REFRESH_MS, 30000);
});

test('bootstrap retries are single-flight and a cancelled late response cannot replace current connection data', async () => {
  let finish, calls = 0;
  const received = [], failures = [];
  const reader = createLatestRead({ canRead: () => true, load: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, onData: value => received.push(value), onError: error => failures.push(error), timeoutMs: 1000 });
  const first = reader.refresh();
  const duplicate = reader.refresh();
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(calls, 1);
  const late = finish;
  reader.cancel();
  const retry = reader.refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish(bootstrap({ now: 200, csrfToken: 'retry-csrf' }));
  await retry;
  late(bootstrap());
  await first;
  assert.equal(received.length, 1);
  assert.equal(received[0].csrfToken, 'retry-csrf');
  assert.deepEqual(failures, []);
});

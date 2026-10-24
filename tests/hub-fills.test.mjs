import test from 'node:test';
import assert from 'node:assert/strict';
import { fillsRequest, fillsReply, fillItems, fillsCacheMs, FILLS_TIMEOUT_MS, FILLS_CACHE_MS, FILLS_PENDING_CACHE_MS, FILLS_STALE_AFTER_MS, MAX_FILL_ITEMS } from '../src/hub-fills.ts';
import { createPositionsSource } from '../src/hub-positions.ts';
import { ASSET_FILLS_TIMEOUT_MS } from '../server/asset-fills.mjs';
import { FILLS_TIMEOUT_MS as MODULE_FILLS_TIMEOUT_MS, parseFillsReply } from '../modules/monitor/lib/hub-fills-contract.ts';
import { NOW, STAMP, LOOKBACK, response, scope, fill, hynixPayload } from './fills-fixtures.mjs';

const request = { type: 'fills-request', requestId: 'fills-1', market: 'oil' };
const reply = data => fillsReply(fillsRequest(request), { status: 'ok', data, at: 0 }, NOW);

test('fills requests only accept the fixed oil and hynix markets without symbol or URL overrides', () => {
  assert.deepEqual(fillsRequest(request), { requestId: 'fills-1', market: 'oil' });
  assert.deepEqual(fillsRequest({ ...request, market: 'hynix' }), { requestId: 'fills-1', market: 'hynix' });
  assert.ok(fillsRequest({ ...request, channel: 'project-hub', version: 1 }));
  for (const invalid of [null, [], {}, { ...request, type: 'fills' }, { ...request, market: 'cl-xau' }, { ...request, market: undefined }, { ...request, market: '__proto__' }, { ...request, market: 'toString' },
    { ...request, requestId: '' }, { ...request, requestId: 'a'.repeat(65) }, { ...request, requestId: 'a_b' }, { ...request, requestId: 1 },
    { ...request, symbols: ['BTC'] }, { ...request, url: 'https://example.com' }]) assert.equal(fillsRequest(invalid), null);
});

test('mapping preserves every venue/account/scope identity and exact decimals, without copying provider fields', () => {
  const raw = response(), data = raw.sources[0].data;
  data.exchanges[0].accounts.push({ ...structuredClone(data.exchanges[0].accounts[0]), id: 'second', name: '主账户' });
  raw.sources.push({ ...structuredClone(raw.sources[0]), projectId: 'second-asset' });
  scope(data).fills[0].secret = 'never-relay';
  scope(data).error = 'never-relay';
  const result = reply(raw);
  assert.equal(result.status, 'ok'); assert.equal(result.items.length, 4);
  assert.equal(new Set(result.items.map(row => row.key)).size, 4, 'duplicate display names cannot collapse source or account identity');
  const item = result.items.find(row => row.key === 'asset|binance|main|um|fill-1');
  assert.deepEqual(item, { key: 'asset|binance|main|um|fill-1', sourceId: 'asset', source: 'Asset 账本', exchangeId: 'binance', exchange: 'Binance',
    accountId: 'main', account: '主账户', scope: 'um', ...Object.fromEntries(Object.entries(fill()).filter(([key]) => key !== 'id')), stale: false });
  assert.deepEqual(result.coverage[0], { sourceId: 'asset', source: 'Asset 账本', exchangeId: 'binance', exchange: 'Binance', account: '主账户', scope: 'um', status: 'live',
    fetchedAt: STAMP, coverageStart: LOOKBACK, coverageEnd: STAMP, error: null });
  assert.ok(!JSON.stringify(result).includes('never-relay')); assert.ok(!JSON.stringify(result).includes('revision'));
  assert.equal(result.pending, false); assert.equal(result.incomplete, false); assert.equal(result.lookbackStart, LOOKBACK);
  assert.ok(parseFillsReply(result), 'the actual Monitor parser accepts the host response');
});

test('same-named Asset projects expose distinct stable source identities for fills and coverage', () => {
  const raw = response();
  raw.sources.push({ ...structuredClone(raw.sources[0]), projectId: 'second-asset' });
  const result = reply(raw);
  assert.equal(result.status, 'ok'); assert.equal(result.items.length, 2);
  assert.equal(new Set(result.items.map(item => item.source)).size, 1);
  assert.equal(new Set(result.items.map(item => item.exchangeId)).size, 1);
  assert.equal(new Set(result.items.map(item => item.accountId)).size, 1);
  assert.deepEqual(result.items.map(item => item.sourceId).sort(), ['asset', 'second-asset']);
  assert.deepEqual(result.coverage.map(item => item.sourceId).sort(), ['asset', 'second-asset']);
  for (const item of result.items) assert.equal(item.sourceId, decodeURIComponent(item.key.split('|')[0]));
  const parsed = parseFillsReply(result);
  assert.ok(parsed, 'Monitor accepts the same source identity contract');
  assert.deepEqual(parsed.items.map(item => item.sourceId).sort(), ['asset', 'second-asset']);
  assert.deepEqual(parsed.coverage.map(item => item.sourceId).sort(), ['asset', 'second-asset']);
});

test('Bybit USDC PERP contracts keep their original symbol and escaped identity', () => {
  const raw = response(), data = raw.sources[0].data; data.exchanges[0].id = 'bybit';
  Object.assign(scope(data).fills[0], { id: 'opaque/trade|id', symbol: 'BZPERP', base: 'BZ', quantityUnit: 'BZ', priceCurrency: 'USDC' });
  const result = reply(raw);
  assert.equal(result.status, 'ok'); assert.equal(result.items[0].symbol, 'BZPERP');
  assert.ok(result.items[0].key.endsWith('|opaque%2Ftrade%7Cid'));
  assert.ok(parseFillsReply(result), 'Monitor accepts the same native Bybit USDC contract');
});

test('newest fills across all accounts win the global cap, and truncation is explicit', () => {
  const raw = response();
  const first = raw.sources[0].data.exchanges[0].accounts[0];
  first.scopes[0].fills = Array.from({ length: 2000 }, (_, i) => fill({ id: `old-${i}`, time: new Date(NOW - 100000 - i).toISOString() }));
  raw.sources[0].data.exchanges[0].accounts.push({ ...structuredClone(first), id: 'new', scopes: [{ ...scope(raw.sources[0].data),
    fills: [fill({ id: 'newest' })] }] });
  const result = reply(raw);
  assert.equal(result.items.length, MAX_FILL_ITEMS); assert.ok(result.items[0].key.endsWith('|newest'));
  assert.ok(!result.items.some(item => item.key.endsWith('|old-1999')));
  assert.equal(result.truncated, true); assert.equal(result.incomplete, true);
});

test('pending, incomplete and stale derive from independent coverage signals', () => {
  for (const status of ['loading', 'live', 'stale', 'error', 'unsupported', 'unconfigured']) {
    const raw = response(), selected = scope(raw.sources[0].data); selected.status = status; selected.fills = [];
    if (['loading', 'unsupported', 'unconfigured'].includes(status)) Object.assign(selected, { fetchedAt: null, coverageStart: null, coverageEnd: null });
    const result = reply(raw);
    assert.equal(result.pending, status === 'loading', status);
    assert.equal(result.incomplete, ['stale', 'error'].includes(status), status);
  }
  for (const change of [
    raw => { scope(raw.sources[0].data).truncated = true; },
    raw => { scope(raw.sources[0].data).fills[0].positionBefore = null; scope(raw.sources[0].data).fills[0].positionAfter = null; },
    raw => { raw.sources[0].status = 'stale'; },
    raw => { raw.sources[0].status = 'unavailable'; raw.sources[0].data = null; },
    raw => { scope(raw.sources[0].data).fetchedAt = new Date(NOW - FILLS_STALE_AFTER_MS - 1).toISOString(); },
  ]) { const raw = response(); change(raw); assert.equal(reply(raw).incomplete, true); }
  const refreshing = response(); scope(refreshing.sources[0].data).refreshing = true;
  assert.equal(reply(refreshing).pending, true); assert.equal(reply(refreshing).incomplete, false);
  const stale = response(); scope(stale.sources[0].data).fetchedAt = new Date(NOW - FILLS_STALE_AFTER_MS - 1).toISOString();
  assert.equal(reply(stale).items[0].stale, true); assert.equal(reply(stale).coverage[0].status, 'stale');
  const missing = response(); missing.sources[0].status = 'unconfigured'; missing.sources[0].data = null;
  assert.equal(reply(missing).incomplete, false);
});

test('malformed replies and unavailable outcomes cannot masquerade as confirmed empty history', () => {
  for (const status of ['unavailable', 'unauthorized']) {
    const result = fillsReply(fillsRequest(request), { status, at: 0 }, NOW);
    assert.equal(result.status, status); assert.equal(result.incomplete, true); assert.deepEqual(result.items, []);
    assert.equal(result.generatedAt, null); assert.equal(result.lookbackStart, null);
  }
  for (const data of [null, {}, { sources: {} }]) assert.equal(reply(data).status, 'unavailable');
  for (const overrides of [{ quantity: 1 }, { quantity: '1e2' }, { base: 'BTC' }, { symbol: 'CLOUDUSDT' }, { side: 'long' }, { time: 'bad' }, { fee: 1 }, { positionBefore: null }]) {
    const raw = response(); Object.assign(scope(raw.sources[0].data).fills[0], overrides); assert.equal(reply(raw).status, 'unavailable');
  }
  const duplicate = response(); scope(duplicate.sources[0].data).fills.push(fill());
  assert.throws(() => fillItems(duplicate, NOW));
});

test('fills reuse the shared source cache, in-flight merge, hidden-page and unauthorized behavior', async () => {
  let clock = 0, calls = 0, release;
  const source = createPositionsSource(() => { calls++; return new Promise(resolve => { release = () => resolve(response()); }); }, { cacheMs: FILLS_CACHE_MS, clock: () => clock });
  assert.equal((await source.read(false)).status, 'unavailable'); assert.equal(calls, 0);
  const first = source.read(true), second = source.read(false); release();
  assert.deepEqual(await first, await second); assert.equal(calls, 1);
  clock = 19_999; await source.read(true); assert.equal(calls, 1);
  clock = 20_000; const expired = source.read(true); release(); await expired; assert.equal(calls, 2);
  source.dispose();
  const unauthorized = createPositionsSource(async () => { throw Object.assign(new Error('expired'), { status: 401 }); });
  assert.equal(fillsReply(fillsRequest(request), await unauthorized.read(true), NOW).status, 'unauthorized');
  unauthorized.dispose();
});

test('the browser deadline outlasts the Asset read deadline', () => {
  assert.equal(ASSET_FILLS_TIMEOUT_MS, 12_000);
  assert.equal(FILLS_TIMEOUT_MS, 15_000);
  assert.ok(FILLS_TIMEOUT_MS >= ASSET_FILLS_TIMEOUT_MS + 2000);
  assert.equal(MODULE_FILLS_TIMEOUT_MS, 20_000);
  assert.ok(MODULE_FILLS_TIMEOUT_MS >= FILLS_TIMEOUT_MS + 2000);
});

test('hynix replies carry only SK hynix contracts, and pending outcomes are cached for three seconds', () => {
  const raw = response(); raw.sources[0].data = hynixPayload();
  const hynix = fillsReply(fillsRequest({ ...request, market: 'hynix' }), { status: 'ok', data: raw, at: 0 }, NOW);
  assert.equal(hynix.status, 'ok'); assert.equal(hynix.market, 'hynix');
  assert.deepEqual(hynix.items.map(item => [item.symbol, item.base]), [['SKHYUSDT', 'SKHY']]);
  assert.ok(parseFillsReply(hynix, 'hynix'), 'the actual Monitor parser accepts the hynix response');
  assert.equal(reply(raw).status, 'unavailable', 'an oil request never accepts hynix fills');
  assert.equal(fillsReply(fillsRequest({ ...request, market: 'hynix' }), { status: 'ok', data: response(), at: 0 }, NOW).status, 'unavailable');
  assert.equal(fillsCacheMs({ status: 'ok', data: raw, at: 0 }), FILLS_CACHE_MS);
  scope(raw.sources[0].data).refreshing = true;
  assert.equal(fillsCacheMs({ status: 'ok', data: raw, at: 0 }), FILLS_PENDING_CACHE_MS);
  assert.equal(fillsCacheMs({ status: 'unavailable', at: 0 }), FILLS_CACHE_MS);
  assert.equal(fillsCacheMs({ status: 'ok', data: { sources: 'bad' }, at: 0 }), FILLS_CACHE_MS);
});

test('a pending outcome expires after the pending cache window', async () => {
  let clock = 0, calls = 0, refreshing = true;
  const source = createPositionsSource(async () => { calls++; const raw = response(); scope(raw.sources[0].data).refreshing = refreshing; return raw; },
    { cacheMs: FILLS_CACHE_MS, cacheMsFor: fillsCacheMs, clock: () => clock });
  await source.read(true); clock = FILLS_PENDING_CACHE_MS - 1; await source.read(true); assert.equal(calls, 1);
  clock = FILLS_PENDING_CACHE_MS; refreshing = false; await source.read(true); assert.equal(calls, 2);
  clock += FILLS_PENDING_CACHE_MS; await source.read(true); assert.equal(calls, 2);
  source.dispose();
});

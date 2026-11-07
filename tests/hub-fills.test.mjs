import test from 'node:test';
import assert from 'node:assert/strict';
import { fillsRequest, fillsReply, fillItems, fillsCacheMs, FILLS_TIMEOUT_MS, FILLS_CACHE_MS, FILLS_PENDING_CACHE_MS, FILLS_STALE_AFTER_MS, MAX_FILL_ITEMS } from '../src/hub-fills.ts';
import { createPositionsSource } from '../src/hub-positions.ts';
import { ASSET_FILLS_TIMEOUT_MS } from '../server/asset-fills.mjs';
import { FILLS_TIMEOUT_MS as MODULE_FILLS_TIMEOUT_MS, parseFillsReply } from '../modules/monitor/lib/hub-fills-contract.ts';
import { NOW, STAMP, LOOKBACK, response, scope, fill, hynixPayload, anthropicPayload } from './fills-fixtures.mjs';

const request = { type: 'fills-request', requestId: 'fills-1', market: 'oil' };
const reply = data => fillsReply(fillsRequest(request), { status: 'ok', data, at: 0 }, NOW);

test('verified ANT order attribution crosses both contracts, while malformed identities are rejected', () => {
  const raw = response(); raw.sources[0].data = anthropicPayload();
  const item = scope(raw.sources[0].data).fills[0];
  item.orderId = '9007199254740999999';
  item.execution = { jobId: '11111111-1111-4111-8111-111111111111', phase: 1, batch: 2, comparisonLeg: 'rh', cex: 'binance' };
  const mapped = () => fillsReply({ requestId: 'linked', market: 'anthropic' }, { status: 'ok', data: raw }, NOW);
  assert.deepEqual(parseFillsReply(mapped(), 'anthropic').items[0].execution, item.execution);
  assert.equal(parseFillsReply(mapped(), 'anthropic').items[0].orderId, item.orderId);
  for (const patch of [{ comparisonLeg: ['rh'] }, { batch: -1 }, { phase: 1.2 }, { cex: 'okx' }, { jobId: 'invalid' }]) {
    const valid = { ...item.execution }; Object.assign(item.execution, patch);
    assert.equal(mapped().status, 'unavailable'); item.execution = valid;
    const reply = mapped(); Object.assign(reply.items[0].execution, patch); assert.equal(parseFillsReply(reply, 'anthropic'), null);
  }
  delete item.orderId; assert.equal(mapped().status, 'unavailable');
});

test('fills requests only accept the fixed markets without symbol or URL overrides', () => {
  assert.deepEqual(fillsRequest(request), { requestId: 'fills-1', market: 'oil' });
  assert.deepEqual(fillsRequest({ ...request, market: 'hynix' }), { requestId: 'fills-1', market: 'hynix' });
  assert.deepEqual(fillsRequest({ ...request, market: 'anthropic' }), { requestId: 'fills-1', market: 'anthropic' });
  assert.ok(fillsRequest({ ...request, channel: 'project-hub', version: 1 }));
  for (const invalid of [null, [], {}, { ...request, type: 'fills' }, { ...request, market: 'cl-xau' }, { ...request, market: undefined }, { ...request, market: '__proto__' }, { ...request, market: 'toString' },
    { ...request, requestId: '' }, { ...request, requestId: 'a'.repeat(65) }, { ...request, requestId: 'a_b' }, { ...request, requestId: 1 },
    { ...request, symbols: ['BTC'] }, { ...request, url: 'https://example.com' }]) assert.equal(fillsRequest(invalid), null);
});

test('ANT host and Monitor contracts preserve real fills and reject wrong markets', () => {
  const raw = response(); raw.sources[0].data = anthropicPayload();
  const antRequest = fillsRequest({ ...request, market: 'anthropic' });
  const mapped = () => fillsReply(antRequest, { status: 'ok', data: raw, at: 0 }, NOW);
  const ant = mapped();
  assert.equal(ant.status, 'ok'); assert.equal(ant.incomplete, false);
  assert.equal(ant.items[0].base, 'ANTHROPIC'); assert.equal(ant.items[0].price, '80.000000000000000001');
  assert.equal(ant.items[0].realizedPnl, '2.123456789012345678'); assert.ok(parseFillsReply(ant, 'anthropic'));
  assert.equal(parseFillsReply(ant, 'oil'), null); assert.equal(parseFillsReply(ant, 'hynix'), null);
  assert.equal(reply(raw).status, 'unavailable');
  assert.equal(parseFillsReply({ ...ant, items: [{ ...ant.items[0], exchangeId: 'bybit' }] }, 'anthropic'), null);
  raw.sources[0].data.exchanges[0].id = 'bybit'; assert.equal(mapped().status, 'unavailable');
  raw.sources[0].data.exchanges[0].id = 'okx';
  Object.assign(scope(raw.sources[0].data).fills[0], { symbol: 'ANTHROPIC-USDT-SWAP', quantityUnit: '张', positionBefore: null, positionAfter: null });
  const unknown = mapped(); assert.equal(unknown.items[0].positionBefore, null); assert.ok(parseFillsReply(unknown, 'anthropic'));
});

test('ANT native fills cross the real host/Monitor contract with exact venue identities and unknown currencies', () => {
  const raw = response(); raw.sources[0].data = anthropicPayload();
  const data = anthropicPayload(), rh = data.exchanges[0];
  rh.id = 'rh-lighter'; rh.name = 'Lighter RH'; rh.accounts[0].id = '22163';
  Object.assign(scope(data).fills[0], { id: 'native-rh', symbol: 'ANTHROPIC', quantityUnit: 'ANTHROPIC', priceCurrency: 'USDG', fee: null, feeCurrency: null });
  const hl = structuredClone(rh); hl.id = 'hyperliquid'; hl.name = 'Hyperliquid'; hl.accounts[0].id = 'main';
  Object.assign(hl.accounts[0].scopes[0].fills[0], { id: 'native-xyz', symbol: 'xyz:ANT', base: 'XYZANT', quantityUnit: 'ANT', priceCurrency: null, fee: '-0.1', feeCurrency: 'USDC', realizedPnl: null });
  const io = structuredClone(hl.accounts[0].scopes[0].fills[0]); Object.assign(io, { id: 'native-io', symbol: 'io:ANTH', base: 'IOANTH', quantityUnit: 'ANTH' });
  io.feeCurrency = 'USDe';
  hl.accounts[0].scopes[0].fills.push(io); hl.accounts[0].scopes[0].truncated = true;
  data.exchanges.push(hl);
  raw.sources.push({ projectId: 'anthropic-history', name: 'ANT原生成交', status: 'ready', data });
  const request = { requestId: 'native-test', market: 'anthropic' };
  const mapped = () => fillsReply(request, { status: 'ok', data: raw, at: 0 }, NOW);
  const result = mapped(); assert.equal(result.status, 'ok'); assert.equal(result.items.length, 4); assert.equal(result.incomplete, true);
  assert.deepEqual(new Set(result.items.map(row => row.symbol)), new Set(['ANTHROPICUSDT', 'ANTHROPIC', 'xyz:ANT', 'io:ANTH']));
  const module = parseFillsReply(result, 'anthropic'); assert.ok(module);
  assert.equal(module.items.find(row => row.symbol === 'xyz:ANT').priceCurrency, null);
  assert.equal(module.items.find(row => row.symbol === 'ANTHROPIC').priceCurrency, 'USDG');
  assert.equal(module.items.find(row => row.symbol === 'xyz:ANT').fee, '-0.1');
  assert.equal(module.items.find(row => row.symbol === 'io:ANTH').feeCurrency, 'USDe');
  for (const patch of [{ exchangeId: 'binance' }, { base: 'ANTHROPIC' }, { symbol: 'xyz:ANTH' }, { quantityUnit: '张' }, { positionSide: 'long' }]) {
    const changed = structuredClone(result); Object.assign(changed.items.find(row => row.symbol === 'xyz:ANT'), patch);
    assert.equal(parseFillsReply(changed, 'anthropic'), null, JSON.stringify(patch));
  }
  scope(data).fills[0].priceCurrency = 'USDT'; assert.equal(mapped().status, 'unavailable', 'RH cannot claim the CEX settlement currency');
  scope(data).fills[0].priceCurrency = 'USDG';
  raw.sources[0].data.exchanges[0].accounts[0].scopes[0].fills[0].base = 'XYZANT';
  assert.equal(mapped().status, 'unavailable', 'a CEX fill cannot claim a HIP-3 base');
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

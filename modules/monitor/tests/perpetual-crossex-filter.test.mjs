import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { initialCrossExSettings, openCrossExSettingsStore } from '../server/perpetual-crossex-store.mjs';
import { createCrossExFilterService } from '../server/perpetual-crossex-service.mjs';
import { parseSpotTransfer, createSpotTransferReader, spotTransferEvidence, SPOT_TRANSFER_TTL_MS } from '../server/perpetual-spot-transfer.mjs';
import { createOpportunitiesV2Reader, createPerpetualOpportunitiesV2 } from '../server/perpetual-opportunities-v2.mjs';
import { createPerpetualOpportunities } from '../server/perpetual-opportunities.mjs';
import { createPerpetualService } from '../server/perpetual-service.mjs';
import { createHandler } from '../server/http.mjs';
import { MAX_CROSSEX_BLOCKED_BASES, normalizeCrossExBlockedBases } from '../lib/perpetual-crossex-config.ts';

const NOW = 1790000000000, ADDRESS = '0x1234567890123456789012345678901234567890';
const bMarket = (base = 'BTC') => ({ symbol: `${base}USDT`, baseAsset: base, status: 'TRADING', isSpotTradingAllowed: true });
const bCoin = (base = 'BTC', network = 'BTC', contract = null) => ({ coin: base, trading: true, isLegalMoney: false, depositAllEnable: true, withdrawAllEnable: true, depositHideAll: false, withdrawHideAll: false,
  networkList: [{ coin: base, network, contractAddress: contract, depositEnable: true, withdrawEnable: true, depositHideEnable: false, withdrawHideEnable: false, busy: false }] });
const gMarket = (base = 'BTC') => ({ id: `${base}_USDT`, base, trade_status: 'tradable' });
const gCoin = (base = 'BTC', name = 'BTC', addr = '') => ({ currency: base, delisted: false, trade_disabled: false, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false,
  chains: [{ name, addr, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false }] });
const parsed = (exchange, base = 'BTC', coin) => exchange === 'binance'
  ? parseSpotTransfer(exchange, { symbols: [bMarket(base)] }, { code: '000000', data: [coin ?? bCoin(base)] })
  : parseSpotTransfer(exchange, [gMarket(base)], [coin ?? gCoin(base)]);
const leg = (exchange, base = 'BTC', bid = exchange === 'binance' ? 99 : 103) => ({ exchange, symbol: `${base}${exchange === 'gate' ? '_' : ''}USDT`, base, rawBase: base, quoteCurrency: 'USDT', collateralCurrency: 'USDT', multiplier: 1, assetClass: 'crypto', identityVerified: true, crossexVerified: true, identitySource: 'official fixture', comparable: true, delisting: false, delistingAt: null, bid, ask: bid + 1, bidAskAt: NOW, receivedAt: NOW });
const data = (at = NOW) => new Map(['binance', 'gate'].map(id => [id, { at, assets: parsed(id) }]));
const memoryStore = (enabled = false) => { let state = initialCrossExSettings(); state.config.requireSpotTransfer = enabled; return { get: () => structuredClone(state), save: async next => { state = structuredClone(next); } }; };
const snapshot = quotes => ({ status: 'live', quotes, exchanges: [...new Set(quotes.map(q => q.exchange))].map(id => ({ id, kind: 'cex', status: 'live' })) });
const project = (quotes, filter, now = NOW) => createPerpetualOpportunitiesV2(snapshot(quotes), now, (exchange, symbol) => quotes.find(q => q.exchange === exchange && q.symbol === symbol), null, filter);
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'monitor-crossex-filter-'));
  t.after(async () => { if (!resolve(dir).startsWith(resolve(tmpdir()) + sep) || !dir.includes('monitor-crossex-filter-')) throw new Error('Unsafe cleanup'); await rm(dir, { force: true, recursive: true }); });
  return dir;
}

test('requires both tradable spot assets and a shared bidirectional network with matching identity', () => {
  const metadata = data();
  assert.deepEqual(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), { networks: ['BTC'], checkedAt: NOW, expiresAt: NOW + SPOT_TRANSFER_TTL_MS });
  for (const patch of [{ status: 'BREAK' }, { isSpotTradingAllowed: false }, { isSpotTradingAllowed: undefined }]) {
    const assets = parseSpotTransfer('binance', { symbols: [{ ...bMarket(), ...patch }] }, { code: '000000', data: [bCoin()] });
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), new Map([...metadata, ['binance', { at: NOW, assets }]]), NOW), null);
  }
  const b = bCoin('ABC', 'ETH', ADDRESS), g = gCoin('ABC', 'ETH', ADDRESS.toUpperCase().replace('0X', '0x'));
  const pair = () => new Map([['binance', { at: NOW, assets: parsed('binance', 'ABC', b) }], ['gate', { at: NOW, assets: parsed('gate', 'ABC', g) }]]);
  assert.ok(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW));
  g.chains[0].addr = `0x${'f'.repeat(40)}`;
  assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW), null);
  g.chains[0].addr = ''; b.networkList[0].contractAddress = '';
  assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), pair(), NOW), null, 'unknown tokens cannot inherit native identities');
});

test('suspended, delayed, hidden, missing status, mismatched network and split deposit/withdraw paths fail closed', () => {
  for (const mutate of [
    c => { c.withdraw_disabled = true; }, c => { c.withdraw_delayed = true; }, c => { c.trade_disabled = true; }, c => { c.delisted = true; },
    c => { c.chains[0].deposit_disabled = true; }, c => { delete c.chains[0].withdraw_disabled; }, c => { c.chains[0].withdraw_delayed = true; },
    c => { c.chains[0].name = 'LIGHTNING'; }, c => { c.chains = []; },
    c => { c.chains[0].withdraw_disabled = true; c.chains.push({ ...c.chains[0], deposit_disabled: true, withdraw_disabled: false }); },
  ]) {
    const coin = gCoin(); mutate(coin); const metadata = data(); metadata.get('gate').assets = parsed('gate', 'BTC', coin);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  for (const mutate of [c => { c.withdrawAllEnable = false; }, c => { c.depositHideAll = true; }, c => { c.networkList[0].busy = true; }, c => { delete c.networkList[0].depositEnable; }]) {
    const coin = bCoin(); mutate(coin); const metadata = data(); metadata.get('binance').assets = parsed('binance', 'BTC', coin);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  assert.throws(() => parseSpotTransfer('gate', [gMarket()], [gCoin(), gCoin()]), /重复/);
});

test('missing, failed, stale and future evidence cannot be revived by the response clock', () => {
  for (const at of [NOW - SPOT_TRANSFER_TTL_MS, NOW + 1, null, NaN]) assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), data(at), NOW), null);
  const metadata = data(); metadata.get('gate').error = 'unavailable';
  assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  assert.equal(spotTransferEvidence(leg('binance'), leg('bybit'), data(), NOW), null);
});

test('public adapters enforce HTTP/result schema and proxy-cache age without credentials', async () => {
  const calls = [];
  const read = createSpotTransferReader({ clock: () => NOW, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return Response.json(url.includes('exchangeInfo') ? { symbols: [bMarket()] } : { code: '000000', data: [bCoin()] }, { headers: { Age: '10' } });
  } });
  const result = await read('binance', new AbortController().signal);
  assert.equal(result.at, NOW - 10000); assert.ok(result.assets.get('BTC').spotSymbols.length);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.init.method === 'GET' && c.init.redirect === 'error' && !c.init.headers.Authorization));
  for (const response of [Response.json({}, { status: 401 }), Response.json({}, { headers: { Age: '180' } }), Response.json({ code: 'oops' })]) {
    const fail = createSpotTransferReader({ clock: () => NOW, fetchImpl: async () => response.clone() });
    await assert.rejects(fail('binance', new AbortController().signal));
  }
});

test('server configuration persists, validates inputs and serializes revision conflicts', async t => {
  const dir = await directory(t), store = await openCrossExSettingsStore(dir), service = createCrossExFilterService({ store, clock: () => NOW });
  assert.equal(service.view().config.requireSpotTransfer, false);
  await service.update({ revision: 0, config: { requireSpotTransfer: true } });
  const reopened = await openCrossExSettingsStore(dir); assert.equal(reopened.get().config.requireSpotTransfer, true);
  for (const config of [{}, { requireSpotTransfer: 'true' }, { requireSpotTransfer: true, extra: true }]) await assert.rejects(service.update({ revision: 1, config }));
  const results = await Promise.allSettled([service.update({ revision: 1, config: { requireSpotTransfer: false } }), service.update({ revision: 1, config: { requireSpotTransfer: true } })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.status, 409);
  const broken = createCrossExFilterService({ store: { get: reopened.get, save: async () => { throw new Error('disk'); } } });
  await assert.rejects(broken.update({ revision: 1, config: { requireSpotTransfer: false } }), /保存失败/);
  assert.equal(broken.view().config.requireSpotTransfer, true);
  await writeFile(join(dir, 'crossex-settings.json'), '{bad'); await assert.rejects(openCrossExSettingsStore(dir), /无法读取/);
});

test('optional filter precedes the 200-signal cap and retains every quote for existing positions', () => {
  const quotes = Array.from({ length: 230 }, (_, n) => [leg('binance', `T${n}`), leg('gate', `T${n}`, 500 - n)]).flat();
  const plain = project(quotes); assert.equal(plain.signals.length, 200);
  const filter = { enabled: true, evaluate: (long) => Number(long.base.slice(1)) >= 205 ? { networks: ['ETH'], checkedAt: NOW, expiresAt: NOW + 500 } : null };
  const filtered = project(quotes, filter); assert.equal(filtered.signals.length, 25); assert.deepEqual(filtered.quotes, plain.quotes);
  assert.ok(filtered.signals.every(s => s.expiresAt === NOW + 500 && Number(s.base.slice(1)) >= 205));
  assert.deepEqual(project(quotes, { enabled: false }).signals, plain.signals);
  const legacyQuotes = [leg('binance'), leg('bybit')], legacy = snapshot(legacyQuotes);
  assert.equal(createPerpetualOpportunities(legacy, NOW, undefined, { enabled: true, evaluate: () => null }).signals.length, 0);
  assert.equal(createPerpetualOpportunities(legacy, NOW, undefined, { enabled: true, evaluate: () => null }).quotes.length, 2);
});

test('background updates invalidate cached projections; requests never poll and failures never freshen metadata', async t => {
  let now = NOW, calls = 0, fails = false;
  const service = createCrossExFilterService({ store: memoryStore(), clock: () => now, read: async exchange => { calls++; if (fails) throw new Error('offline'); return { at: now - SPOT_TRANSFER_TTL_MS + 1000, assets: parsed(exchange) }; } });
  t.after(() => service.stop()); service.start(); await service.refresh(); assert.equal(calls, 0);
  const quotes = [leg('binance'), leg('gate')], input = snapshot(quotes), read = createOpportunitiesV2Reader();
  const readFeed = () => read(input, now, (e, s) => quotes.find(q => q.exchange === e && q.symbol === s), null, 'same-book', service.filter());
  assert.equal(readFeed().signals.length, 1);
  await service.update({ revision: 0, config: { requireSpotTransfer: true } }); await service.refresh();
  assert.equal(readFeed().signals.length, 1); assert.equal(readFeed().signals[0].expiresAt, NOW + 1000); assert.equal(calls, 2);
  now += 1000; assert.equal(readFeed().signals.length, 0); assert.equal(calls, 2);
  await service.refresh(); assert.equal(readFeed().signals.length, 1);
  const at = service.view().venues[0].checkedAt; fails = true; await service.refresh();
  assert.equal(readFeed().signals.length, 0); assert.equal(service.view().venues[0].checkedAt, at); assert.equal(service.view().venues[0].state, 'error');
  await service.update({ revision: 1, config: { requireSpotTransfer: false } }); assert.equal(readFeed().signals.length, 1);
});

test('disabled settings cancel in-flight metadata; the late result cannot revive the old generation', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createCrossExFilterService({ store: memoryStore(true), clock: () => NOW, read: async exchange => { await pending; return { at: NOW, assets: parsed(exchange) }; } });
  t.after(() => service.stop()); service.start();
  await service.update({ revision: 0, config: { requireSpotTransfer: false } }); release(); await service.refresh();
  assert.ok(service.view().venues.every(v => v.checkedAt === null));
});

test('settings HTTP shares existing authentication and persists changes without signal GET network access', async t => {
  const dir = await directory(t); let calls = 0;
  const store = await openCrossExSettingsStore(dir), service = createPerpetualService({ exchanges: [], crossexOptions: { store, read: async () => { calls++; throw new Error('offline'); } } });
  const server = createServer(createHandler({ services: new Map([['perpetual', service]]), username: 'fixture', password: 'fixture-password', nextHandler: (_q, r) => { r.writeHead(404); r.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await service.stop(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/monitors/perpetual/`, headers = { Authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}crossex-settings`)).status, 401);
  const body = JSON.stringify({ revision: 0, config: { requireSpotTransfer: true } });
  assert.equal((await fetch(`${url}crossex-settings`, { headers: { ...headers, Origin: 'https://example.com' }, method: 'PUT', body })).status, 403);
  const saved = await fetch(`${url}crossex-settings`, { headers, method: 'PUT', body }); assert.equal(saved.status, 200); assert.equal((await saved.json()).config.requireSpotTransfer, true);
  assert.equal((await fetch(`${url}crossex-settings`, { headers, method: 'PUT', body })).status, 409);
  const response = await fetch(`${url}opportunities-v2`, { headers }); assert.equal(response.status, 200); assert.equal(calls, 0);
  assert.equal((await openCrossExSettingsStore(dir)).get().config.requireSpotTransfer, true);
});

test('blocked bases normalize exact codes and reject malformed or oversized lists', () => {
  assert.deepEqual(normalizeCrossExBlockedBases([' eth ', 'btc', 'BTC', '1inch', 'BTCUSDT']), ['1INCH', 'BTC', 'BTCUSDT', 'ETH']);
  for (const input of [null, 'BTC', {}, [null], [1], [''], ['BTC/USDT'], ['比特币'], ['-'], ['X'.repeat(41)], Array(MAX_CROSSEX_BLOCKED_BASES + 1).fill('BTC')]) assert.throws(() => normalizeCrossExBlockedBases(input));
});

test('old files migrate; maximum lists survive restart and legacy PUT never erases a saved block list', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'crossex-settings.json'), JSON.stringify({ version: 1, revision: 4, config: { requireSpotTransfer: false } }));
  const store = await openCrossExSettingsStore(dir), service = createCrossExFilterService({ store, clock: () => NOW });
  assert.deepEqual(service.view().config.blockedBases, []);
  const blockedBases = Array.from({ length: MAX_CROSSEX_BLOCKED_BASES }, (_, i) => `COIN${i}`.padEnd(40, 'X'));
  await service.update({ revision: 4, config: { requireSpotTransfer: false, blockedBases } });
  assert.deepEqual((await openCrossExSettingsStore(dir)).get().config.blockedBases, blockedBases.sort());
  await service.update({ revision: 5, config: { requireSpotTransfer: true } });
  assert.deepEqual(service.view().config.blockedBases, blockedBases);
  await service.update({ revision: 6, config: { requireSpotTransfer: true, blockedBases: [] } });
  assert.deepEqual((await openCrossExSettingsStore(dir)).get().config.blockedBases, []);
});

test('block-list validation and disk failure preserve the confirmed list; response arrays cannot mutate it', async () => {
  const store = memoryStore(), service = createCrossExFilterService({ store, clock: () => NOW });
  await service.update({ revision: 0, config: { requireSpotTransfer: false, blockedBases: [' btc ', 'BTC'] } });
  const first = service.filter(); service.view().config.blockedBases.push('ETH'); first.blockedBases.length = 0;
  assert.equal(service.filter().evaluate(leg('binance'), leg('gate'), NOW), null);
  assert.deepEqual(service.view().config.blockedBases, ['BTC']);
  for (const blockedBases of [null, 'ETH', ['BTC/USDT']]) await assert.rejects(service.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases } }));
  const broken = createCrossExFilterService({ store: { get: store.get, save: async () => { throw new Error('disk full'); } }, clock: () => NOW });
  await assert.rejects(broken.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: [] } }), /保存失败/);
  assert.equal(broken.filter().evaluate(leg('binance'), leg('gate'), NOW), null);
  assert.deepEqual(broken.view().config.blockedBases, ['BTC']);
  await service.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: [] } });
  assert.equal(first.evaluate(leg('binance'), leg('gate'), NOW), null, 'previous filter retains its own snapshot');
});

test('blocking applies to all directions and venues in both feeds without requiring spot checks', async t => {
  let calls = 0;
  const service = createCrossExFilterService({ store: memoryStore(), clock: () => NOW, read: async () => { calls++; throw new Error('should not poll'); } });
  t.after(() => service.stop()); service.start();
  await service.update({ revision: 0, config: { requireSpotTransfer: false, blockedBases: ['BTC'] } });
  for (const venues of [['binance', 'bybit', 'gate'], ['gate', 'bybit', 'binance']]) {
    const quotes = ['BTC', 'ETH', 'BTCST'].flatMap(base => venues.map((venue, i) => leg(venue, base, 100 + i * 3)));
    const plain = project(quotes), filtered = project(quotes, service.filter());
    assert.ok(plain.signals.some(signal => signal.base === 'BTC'));
    assert.ok(filtered.signals.length > 0); assert.ok(filtered.signals.every(signal => signal.base !== 'BTC' && signal.spotTransfer === undefined));
    assert.ok(filtered.signals.some(signal => signal.base === 'BTCST'), 'matches full base, not a prefix');
    assert.deepEqual(filtered.quotes, plain.quotes);
    assert.deepEqual(filtered.crossexFilter, { requireSpotTransfer: false, blockedBases: ['BTC'], excluded: 3, revision: 1 });
    const legacy = createPerpetualOpportunities(snapshot(quotes), NOW, undefined, service.filter());
    assert.ok(legacy.signals.length > 0); assert.ok(legacy.signals.every(signal => signal.base !== 'BTC'));
    assert.deepEqual(legacy.quotes, createPerpetualOpportunities(snapshot(quotes), NOW).quotes);
  }
  await service.refresh(); assert.equal(calls, 0);
});

test('adding and removing a blocked base immediately invalidates the unchanged source projection', async () => {
  const service = createCrossExFilterService({ store: memoryStore(), clock: () => NOW }), quotes = [leg('binance'), leg('gate')], input = snapshot(quotes), read = createOpportunitiesV2Reader();
  const feed = () => read(input, NOW, (e, s) => quotes.find(q => q.exchange === e && q.symbol === s), null, 'same-source', service.filter());
  const original = feed(); assert.equal(original.signals.length, 1);
  await service.update({ revision: 0, config: { requireSpotTransfer: false, blockedBases: ['BTC'] } });
  assert.equal(feed().signals.length, 0); assert.deepEqual(feed().quotes, original.quotes);
  await service.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: [] } });
  assert.deepEqual(feed().signals, original.signals);
});

test('blocked-base filtering precedes the cap without dropping existing-position quotes', async () => {
  const service = createCrossExFilterService({ store: memoryStore(), clock: () => NOW });
  const quotes = Array.from({ length: 230 }, (_, i) => [leg('binance', `T${i}`), leg('gate', `T${i}`, 500 - i)]).flat();
  await service.update({ revision: 0, config: { requireSpotTransfer: false, blockedBases: Array.from({ length: 200 }, (_, i) => `T${i}`) } });
  assert.equal(project(quotes).signals.length, 200);
  const result = project(quotes, service.filter()); assert.equal(result.signals.length, 30); assert.equal(result.quotes.length, 460);
});

test('changing the block list preserves fresh spot metadata and still combines both rules', async t => {
  let calls = 0;
  const service = createCrossExFilterService({ store: memoryStore(true), clock: () => NOW, read: async exchange => { calls++; return { at: NOW, assets: parsed(exchange) }; } });
  t.after(() => service.stop()); service.start(); await service.refresh();
  const quotes = [leg('binance'), leg('gate')]; assert.equal(project(quotes, service.filter()).signals.length, 1);
  const venues = service.view().venues;
  await service.update({ revision: 0, config: { requireSpotTransfer: true, blockedBases: ['BTC'] } });
  assert.equal(project(quotes, service.filter()).signals.length, 0);
  await service.update({ revision: 1, config: { requireSpotTransfer: true, blockedBases: [] } });
  assert.ok(project(quotes, service.filter()).signals[0].spotTransfer);
  assert.equal(project([leg('binance'), leg('bybit')], service.filter()).signals.length, 0, 'unsupported transfer evidence remains blocked');
  assert.deepEqual(service.view().venues, venues); assert.equal(calls, 2);
});

test('spot trading start times and ambiguous network or contract records fail closed', () => {
  for (const patch of [{ id: '' }, { trade_status: 'buyable' }, { trade_status: 'sellable' }, { buy_start: NOW / 1000 + 1 }, { sell_start: NOW / 1000 + 1 }, { buy_start: '0' }, { sell_start: null }, { type: 'premarket' }, { delisting_time: NOW / 1000 + 1 }]) {
    const metadata = data();
    metadata.get('gate').assets = parseSpotTransfer('gate', [{ ...gMarket(), ...patch }], [gCoin()], NOW);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  const valid = data(); valid.get('gate').assets = parseSpotTransfer('gate', [{ ...gMarket(), buy_start: 0, sell_start: NOW / 1000, delisting_time: 0, type: 'normal' }], [gCoin()], NOW);
  assert.ok(spotTransferEvidence(leg('binance'), leg('gate'), valid, NOW));
  for (const exchange of ['binance', 'gate']) {
    const coin = exchange === 'binance' ? bCoin() : gCoin();
    const chains = exchange === 'binance' ? coin.networkList : coin.chains;
    chains.push({ ...chains[0], ...(exchange === 'binance' ? { withdrawEnable: false } : { withdraw_disabled: true }) });
    const metadata = data(); metadata.get(exchange).assets = parsed(exchange, 'BTC', coin);
    assert.equal(spotTransferEvidence(leg('binance'), leg('gate'), metadata, NOW), null);
  }
  for (const contract of ['unknown', ' 0x1234567890123456789012345678901234567890 ', '0x1234']) {
    const metadata = new Map([['binance', { at: NOW, assets: parsed('binance', 'ABC', bCoin('ABC', 'ETH', contract)) }], ['gate', { at: NOW, assets: parsed('gate', 'ABC', gCoin('ABC', 'ETH', contract)) }]]);
    assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), metadata, NOW), null);
  }
  const metadata = new Map([['binance', { at: NOW, assets: parsed('binance', 'ABC', bCoin('ABC', 'SOL', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')) }], ['gate', { at: NOW, assets: parsed('gate', 'ABC', gCoin('ABC', 'SOL', '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD')) }]]);
  assert.equal(spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), metadata, NOW), null, 'non-EVM contracts remain case sensitive');
});

test('raw duplicate networks and aliases remain ambiguous when one record has an invalid address or asset', () => {
  for (const [first, duplicate, canonical] of [['ETH', 'ETH', 'ETH'], ['ARB', 'ARBEVM', 'ARBITRUM']]) {
    for (const exchange of ['binance', 'gate']) {
      const b = bCoin('ABC', first, ADDRESS), g = gCoin('ABC', duplicate, ADDRESS);
      const makeData = () => new Map([['binance', { at: NOW, assets: parsed('binance', 'ABC', b) }], ['gate', { at: NOW, assets: parsed('gate', 'ABC', g) }]]);
      const readEvidence = () => spotTransferEvidence(leg('binance', 'ABC'), leg('gate', 'ABC'), makeData(), NOW);
      assert.deepEqual(readEvidence()?.networks, [canonical], 'a single valid network remains usable');
      if (exchange === 'binance') b.networkList.push({ ...b.networkList[0], network: duplicate, contractAddress: null, depositEnable: false, withdrawEnable: false });
      else g.chains.push({ ...g.chains[0], name: first, addr: null, deposit_disabled: true, withdraw_disabled: true });
      assert.equal(readEvidence(), null, `${exchange} ${first}/${duplicate} cannot discard the closed invalid-address row before checking duplicates`);
      if (exchange === 'binance') {
        b.networkList[1].contractAddress = ADDRESS; b.networkList[1].coin = 'OTHER';
        assert.equal(readEvidence(), null, 'conflicting Binance coin records cannot conceal duplicate network keys');
      }
    }
  }
});

test('both feed versions publish the same policy revision and evidence, including unavailable responses', () => {
  const quotes = [leg('binance'), leg('bybit')], input = snapshot(quotes), evidence = { networks: ['BTC'], checkedAt: NOW - 100, expiresAt: NOW + 100 };
  const filter = { enabled: true, requireSpotTransfer: true, blockedBases: [], revision: 17, evaluate: () => evidence };
  const v1 = createPerpetualOpportunities(input, NOW, undefined, filter), v2 = project(quotes, filter);
  assert.deepEqual(v1.crossexFilter, { requireSpotTransfer: true, blockedBases: [], excluded: 0, revision: 17 });
  assert.deepEqual(v2.crossexFilter, v1.crossexFilter);
  for (const result of [v1, v2]) { assert.deepEqual(result.signals[0].spotTransfer, evidence); assert.equal(result.signals[0].expiresAt, evidence.expiresAt); }
  assert.equal(createPerpetualOpportunities(input, evidence.expiresAt, undefined, filter).signals.length, 0);
  assert.equal(project(quotes, filter, evidence.expiresAt).signals.length, 0);
  const read = createOpportunitiesV2Reader();
  const feed = now => read(input, now, (e, s) => quotes.find(q => q.exchange === e && q.symbol === s), null, 'same', filter);
  assert.equal(feed(NOW).signals.length, 1); assert.equal(feed(evidence.expiresAt).signals.length, 0);
  const duplicates = snapshot([...quotes, quotes[0]]);
  for (const result of [createPerpetualOpportunities(duplicates, NOW, undefined, filter), createPerpetualOpportunitiesV2(duplicates, NOW, (e, s) => quotes.find(q => q.exchange === e && q.symbol === s), null, filter)]) {
    assert.equal(result.errorCode, 'DUPLICATE_QUOTES'); assert.deepEqual(result.crossexFilter, v1.crossexFilter);
  }
});

test('settings expose all qualified pairs without signal truncation and revoke on refresh, expiry and policy changes', async t => {
  let now = NOW, failed = false;
  const service = createCrossExFilterService({ store: memoryStore(true), clock: () => now, read: async exchange => {
    if (failed) throw new Error('offline');
    const assets = new Map();
    for (let i = 0; i < 230; i++) { const base = `T${i}`; assets.set(base, parsed(exchange, base, exchange === 'binance' ? bCoin(base, 'ETH', ADDRESS) : gCoin(base, 'ETH', ADDRESS)).get(base)); }
    return { at: now - SPOT_TRANSFER_TTL_MS + 1000, assets };
  } });
  t.after(() => service.stop()); service.start(); await service.refresh();
  const initial = service.view(); assert.equal(initial.spotTransferPairs.length, 230); assert.equal(initial.metadataRevision, 3);
  assert.deepEqual(initial.spotTransferPairs[0], { base: 'T0', exchanges: ['binance', 'gate'], networks: ['ETH'], checkedAt: NOW - SPOT_TRANSFER_TTL_MS + 1000, expiresAt: NOW + 1000 });
  initial.spotTransferPairs[0].networks.push('INVALID'); assert.deepEqual(service.view().spotTransferPairs[0].networks, ['ETH']);
  await service.update({ revision: 0, config: { requireSpotTransfer: true, blockedBases: ['T0'] } });
  assert.equal(service.view().spotTransferPairs.length, 229); assert.ok(service.view().spotTransferPairs.every(pair => pair.base !== 'T0'));
  now += 1000; assert.deepEqual(service.view().spotTransferPairs, []);
  await service.refresh(); assert.equal(service.view().spotTransferPairs.length, 229);
  failed = true; await service.refresh(); assert.deepEqual(service.view().spotTransferPairs, []);
  await service.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: [] } });
  assert.deepEqual(service.view().spotTransferPairs, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { openDatabase } from '../lib/sqlite.ts';
import { createFillsService, fillsQueryMarket } from '../lib/hub-fills.ts';
import { readFills } from '../lib/hub-fills-readers.ts';
import { FillConflict, mergeFills, replayFills } from '../lib/hub-fills-replay.ts';
import { CYCLE_LOOKBACK_MS } from '../lib/positions-cycle.ts';
import { historyContext } from '../lib/positions-history.ts';
import { position } from '../lib/positions-values.ts';
import type { HubFills, ReadFill } from '../lib/hub-fills-types.ts';
import type { Position } from '../lib/positions-types.ts';
import type { Credentials } from '../lib/validation.ts';

const at = Date.parse('2026-10-01T00:00:00.000Z'), minute = 60_000, day = 86_400_000;
const keys = { apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const okx: Credentials = { exchange: 'okx', ...keys, passphrase: 'synthetic-pass' };
const binance: Credentials = { exchange: 'binance', ...keys };
const bybit: Credentials = { exchange: 'bybit', ...keys, region: 'global' };
const iso = (time: number) => new Date(time).toISOString();
const fill = (id: string, time: number, side: 'buy' | 'sell', quantity: string, extra: Partial<ReadFill> = {}): ReadFill => ({
  id, symbol: 'CL-USDT-SWAP', base: 'CL', time: iso(time), side, positionSide: 'net', quantity, quantityUnit: '张',
  price: '80.000000000000000001', priceCurrency: 'USDT', fee: '-0.01', feeCurrency: 'USDT', realizedPnl: '0', ...extra,
});
const held = (quantity: string, side: 'long' | 'short' = 'long', leg: 'net' | 'long' | 'short' = 'net', symbol = 'CL-USDT-SWAP'): Position =>
  ({ ...position(symbol, side, quantity, '张'), positionSide: leg });
const scope = (report: HubFills, exchange = 'okx', id = 'SWAP') => report.exchanges.find(item => item.id === exchange)!.accounts[0].scopes.find(item => item.id === id)!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function historyBounds(url: URL, exchange: string, exchangeTime = at) {
  const start = Number(url.searchParams.get('startTime') ?? url.searchParams.get('begin'));
  const explicitEnd = url.searchParams.get('endTime') ?? url.searchParams.get('end');
  // Bybit startTime-only means 24h (2025-04-24); Binance means 7d; OKX has no implicit end.
  const end = explicitEnd === null ? exchange === 'bybit' ? start + day : exchange === 'binance' ? start + 7 * day : exchangeTime : Number(explicitEnd);
  if (exchange !== 'okx') assert.ok(end >= start && end - start <= 7 * day, 'bounded history requests must fit seven days');
  return { start, end: Math.min(end, exchangeTime) };
}
function mock(handler: (url: URL) => unknown) {
  const calls: URL[] = [];
  const fetcher = (async (input: string | URL, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    const url = new URL(String(input)); calls.push(url);
    return Response.json(await handler(url));
  }) as typeof fetch;
  return { calls, fetcher };
}
function fixture() {
  const database = openDatabase(':memory:'), vault = new Map<string, Credentials>();
  let revision = 0;
  const save = async (value: Credentials = okx, owner = 'owner') => {
    const encrypted = 'synthetic-' + ++revision; vault.set(encrypted, value);
    await database.prepare('INSERT INTO connections(owner,exchange,encrypted,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,exchange) DO UPDATE SET encrypted=excluded.encrypted')
      .bind(owner, value.exchange, encrypted, iso(at)).run();
  };
  const unseal = async (value: string, context: string) => {
    assert.equal(context, 'owner:' + vault.get(value)!.exchange);
    return vault.get(value);
  };
  return { database, save, unseal };
}

test('Binance history survives flat positions, splits full windows and retains symbol-scoped ids and precise cash flows', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    symbol: 'CLUSDT', id: i + 1, time: at - 4_000 - i * 10, side: i % 2 ? 'SELL' : 'BUY', positionSide: 'BOTH',
    qty: '0.000000000000000001', price: '80.000000000000000001', realizedPnl: i ? '-0.1' : '',
    commission: i ? '0.000000000000000001' : '-0.2', commissionAsset: 'USDT',
  }));
  for (const product of ['um', 'pm-um']) {
    const { calls, fetcher } = mock(url => {
      const { start, end } = historyBounds(url, 'binance');
      return url.searchParams.get('symbol') === 'BZUSDT' ? [] : rows.filter(row => row.time >= start && row.time <= end).slice(0, 1000);
    });
    const fills = await readFills(binance, product, { market: 'oil', start: at - minute - 1, end: at }, { fetcher, spacing: false });
    assert.equal(fills.length, 1001); assert.ok(calls.length > 2);
    assert.ok(calls.every(url => url.hostname === (product === 'um' ? 'fapi.binance.com' : 'papi.binance.com')));
    const first = fills.find(item => item.id === 'CLUSDT:1')!;
    assert.equal(first.price, '80.000000000000000001'); assert.equal(first.quantity, '0.000000000000000001');
    assert.equal(first.fee, '0.2'); assert.equal(first.realizedPnl, null);
    assert.equal(fills.find(item => item.id === 'CLUSDT:2')!.fee, '-0.000000000000000001');
  }
  const { calls, fetcher } = mock(url => { historyBounds(url, 'binance'); return []; });
  assert.deepEqual(await readFills(binance, 'um', { market: 'oil', start: at - CYCLE_LOOKBACK_MS, end: at }, { fetcher, spacing: false }), []);
  assert.equal(calls.length, 26, 'both fixed symbols cover all 85 days despite no current holdings');
  assert.ok(calls.every(url => { const { start, end } = historyBounds(url, 'binance'); return end - start < 7 * day; }));
});

test('Bybit cursor pages accept only exact oil contracts, preserve exponents, unknown PnL and signed post-fill size', async () => {
  const { calls, fetcher } = mock(url => {
    if (url.searchParams.get('baseCoin') === 'BZ') return { retCode: 0, result: { list: [], nextPageCursor: '' } };
    return { retCode: 0, result: url.searchParams.has('cursor')
      ? { list: [{ id: 'b', symbol: 'CLUSDC', currency: 'USDC', type: 'ADL', side: 'Sell', transactionTime: String(at - 20_000), qty: '1e-3', tradePrice: '8e1', size: '-1e-3', fee: '-2e-6', cashFlow: '-1e-2' }], nextPageCursor: '' }
      : { list: [
        { id: 'a', symbol: 'CLPERP', baseCoin: 'CL', currency: 'USDC', type: 'LIQUIDATION', side: 'Buy', transactionTime: String(at - 10_000), qty: '1E-3', tradePrice: '8.1e1', size: '0', fee: '1e-6', cashFlow: '' },
        { symbol: 'CLOUDUSDC', qty: 'bad' }, { symbol: 'CLPERP', type: 'SETTLEMENT' },
      ], nextPageCursor: 'next' } };
  });
  const fills = await readFills(bybit, 'linear-usdc', { market: 'oil', start: at - minute - 1, end: at }, { fetcher, spacing: false });
  assert.equal(calls.length, 3); assert.equal(fills.length, 2);
  assert.deepEqual(fills.map(item => [item.symbol, item.quantity, item.price, item.fee, item.realizedPnl, item.sizeAfter]), [
    ['CLPERP', '0.001', '81', '-0.000001', null, '0'], ['CLUSDC', '0.001', '80', '0.000002', '-0.01', '-0.001'],
  ]);
  const repeated = mock(() => ({ retCode: 0, result: { list: [], nextPageCursor: 'same' } }));
  await assert.rejects(readFills(bybit, 'linear-usdt', { market: 'oil', start: at - minute - 1, end: at }, { fetcher: repeated.fetcher, spacing: false }));
  assert.equal(repeated.calls.length, 2);
  const missing = mock(() => ({ retCode: 0, result: { list: [] } }));
  await assert.rejects(readFills(bybit, 'linear-usdt', { market: 'oil', start: at - minute - 1, end: at }, { fetcher: missing.fetcher, spacing: false }));
});

test('OKX paginates by billId, keeps contract quantities and its already signed fee/PnL', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ billId: String(1001 - i), instId: 'CL-USDT-SWAP', ts: String(at - 5_000 - i * 10),
    side: 'sell', posSide: 'short', fillSz: '2.000000000000000001', fillPx: '80.2', fee: '-0.123', feeCcy: 'USDT', fillPnl: '1.2' }));
  const { calls, fetcher } = mock(url => ({ code: '0', data: url.searchParams.get('instId') === 'BZ-USDT-SWAP' ? []
    : rows.filter(row => !url.searchParams.has('after') || BigInt(row.billId) < BigInt(url.searchParams.get('after')!)).slice(0, 100) }));
  const fills = await readFills(okx, 'SWAP', { market: 'oil', start: at - minute - 1, end: at }, { fetcher, spacing: false });
  assert.equal(fills.length, 101); assert.equal(calls[1].searchParams.get('after'), '902');
  assert.deepEqual([fills[0].id, fills[0].quantityUnit, fills[0].quantity, fills[0].fee, fills[0].realizedPnl], ['1001', '张', '2.000000000000000001', '-0.123', '1.2']);
  assert.equal(fills[0].positionSide, 'short');
  const bad = mock(() => ({ code: '0', data: [{ ...rows[0], fillSz: 2 }] }));
  await assert.rejects(readFills(okx, 'SWAP', { market: 'oil', start: at - minute - 1, end: at }, { fetcher: bad.fetcher, spacing: false }));
});

test('replay covers open, close, cross-zero, independent hedge legs and merged OKX margin positions', () => {
  const roundTrip = replayFills([fill('2', at - minute - 1, 'sell', '2'), fill('1', at - 2 * minute, 'buy', '2')], [], at, 'okx').fills;
  assert.deepEqual(roundTrip.map(item => [item.positionBefore, item.positionAfter]), [['2', '0'], ['0', '2']]);
  const cross = replayFills([fill('3', at - minute - 1, 'buy', '5')], [held('3')], at, 'okx').fills[0];
  assert.deepEqual([cross.positionBefore, cross.positionAfter], ['-2', '3']);
  const hedge = replayFills([fill('3', at - minute - 1, 'buy', '1', { positionSide: 'long' }), fill('2', at - 2 * minute, 'sell', '4', { positionSide: 'short' })],
    [held('2', 'long', 'long'), { ...held('1', 'long', 'long'), id: 'isolated' }, held('4', 'short', 'short')], at, 'okx').fills;
  assert.deepEqual(hedge.map(item => [item.positionBefore, item.positionAfter]), [['2', '3'], ['0', '-4']]);
  const impossible = replayFills([fill('3', at - minute - 1, 'buy', '4', { positionSide: 'long' }), fill('2', at - 2 * minute, 'sell', '1', { positionSide: 'long' })],
    [held('1', 'long', 'long')], at, 'okx').fills;
  assert.ok(impossible.every(item => item.positionBefore === null && item.positionAfter === null));
});

test('Bybit size disagreement, missing size, opposing current legs and mode changes null the entire group', () => {
  const fills = [fill('2', at - minute - 1, 'sell', '1', { sizeAfter: '2' }), fill('1', at - 2 * minute, 'buy', '3', { sizeAfter: '3' })];
  assert.ok(replayFills(fills, [held('2')], at, 'bybit').fills.every(item => item.positionBefore !== null));
  for (const data of [[{ ...fills[0], sizeAfter: '1' }, fills[1]], [{ ...fills[0], sizeAfter: null }, fills[1]]]) {
    assert.ok(replayFills(data, [held('2')], at, 'bybit').fills.every(item => item.positionBefore === null));
  }
  assert.ok(replayFills(fills, [held('3'), held('1', 'short')], at, 'bybit').fills.every(item => item.positionBefore === null));
  assert.ok(replayFills(fills, null, at, 'okx').fills.every(item => item.positionBefore === null));
  const mixed = [fills[0], { ...fills[1], positionSide: 'long' as const }];
  assert.ok(replayFills(mixed, [held('2')], at, 'okx').fills.every(item => item.positionBefore === null));
});

test('snapshot uncertainty covers sixty seconds of clock skew and has no upper bound', () => {
  for (const offset of [-60_000, -1_000, 0, 1_000, 30_000, 120_000]) {
    const input = [fill('3', at + offset, 'sell', '1'), fill('2', at - minute - 1, 'buy', '1'),
      fill('bz', at - minute - 1, 'sell', '1', { symbol: 'BZ-USDT-SWAP', base: 'BZ' })];
    const result = replayFills(input, [], at, 'okx');
    assert.equal(result.skew, true);
    assert.ok(result.fills.filter(item => item.base === 'CL').every(item => item.positionBefore === null));
    assert.notEqual(result.fills.find(item => item.base === 'BZ')!.positionBefore, null);
  }
});

test('deduplication rejects changed immutable contents and drops expired history', () => {
  const original = fill('1', at - minute - 1, 'buy', '1', { order: 1 });
  assert.equal(mergeFills([original], [{ ...original, order: 9 }], at - day).length, 1);
  assert.throws(() => mergeFills([original], [{ ...original, price: '99' }], at - day), FillConflict);
  assert.deepEqual(mergeFills([fill('old', at - 86 * day, 'buy', '1')], [], at - 85 * day), []);
});

test('fresh reads are immediate loading, then expose closed trades; credentials never enter response', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const waiting = deferred<Position[]>(); let reads = 0;
  const service = createFillsService({ now: () => at, read: async () => { reads++; return waiting.promise; },
    fills: async () => [fill('2', at - minute - 1, 'sell', '1'), fill('1', at - 2 * minute, 'buy', '1')] });
  const loading = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(loading).status, 'loading'); assert.equal(scope(loading).refreshing, true);
  await flush(); await service.read(f.database, 'owner', f.unseal); assert.equal(reads, 1);
  waiting.resolve([]); await service.idle();
  const result = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(result).status, 'live'); assert.equal(scope(result).fills.length, 2);
  assert.equal(scope(result).fills[0].positionAfter, '0');
  assert.equal(scope(result).coverageStart, iso(at - CYCLE_LOOKBACK_MS));
  assert.equal(scope(result).coverageEnd, iso(at));
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('incremental refresh overlaps ten minutes, deduplicates, recomputes all cached fills and rejects conflicts', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let clock = at, batch = 0; const requests: { start: number; end: number }[] = [];
  const old = fill('1', at - minute - 1, 'buy', '2');
  const service = createFillsService({ now: () => clock, read: async () => batch ? [held('1')] : [held('2')],
    fills: async (_c, _s, request) => { requests.push(request); return batch === 0 ? [old] : batch === 1
      ? [old, fill('2', at + minute, 'sell', '1')] : [{ ...old, price: '999' }]; } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  batch = 1; clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(requests[1].start, at - 10 * minute);
  let result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.fills.length, 2);
  assert.deepEqual(result.fills.map(item => [item.positionBefore, item.positionAfter]), [['2', '1'], ['0', '2']]);
  batch = 2; clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
  result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.status, 'error'); assert.equal(result.fills.length, 2); assert.match(result.error!, /冲突/);
});

test('skew retries after 30 seconds without advancing the incremental cursor', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let clock = at; const starts: number[] = [];
  const service = createFillsService({ now: () => clock, read: async () => [held('1')],
    fills: async (_c, _s, request) => { starts.push(request.start); return [fill('1', at - 1_000, 'buy', '1')]; } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).fills[0].positionBefore, null);
  clock += 29_999; await service.read(f.database, 'owner', f.unseal); await service.idle(); assert.equal(starts.length, 1);
  clock++; await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(starts[1], clock - CYCLE_LOOKBACK_MS, 'first skewed refresh did not establish a cursor');
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).fills[0].positionBefore, null);
  clock += 30_000; await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(starts[2], clock - CYCLE_LOOKBACK_MS);
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).fills[0].positionBefore, '0');
  clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(starts[3], at + 60_000 - 10 * minute);
});

test('real readers include trades during a slow position read, isolate uncertain groups and recover without advancing the cursor', async t => {
  for (const [tradeOffset, duration, clockSkew] of [[1_000, 6_000, 0], [5_000, 6_000, 0], [1_000, 500, 1_000], [-1_000, 500, -1_000], [30_000, 500, 30_000]]) await t.test(`trade ${tradeOffset}ms, response ${duration}ms, exchange skew ${clockSkew}ms`, async t => {
    const f = fixture(); t.after(() => f.database.close()); await f.save();
    let clock = at, positionReads = 0;
    const trade = (id: string, symbol: string, time: number, side: string, quantity: string) => ({
      billId: id, instId: symbol, ts: String(time), side, posSide: 'net', fillSz: quantity,
      fillPx: '80', fillPnl: '0', fee: '-0.01', feeCcy: 'USDT',
    });
    const trades = [
      trade('3', 'CL-USDT-SWAP', at + tradeOffset, 'sell', '2'),
      trade('2', 'CL-USDT-SWAP', at - minute - 1, 'sell', '1'),
      trade('1', 'CL-USDT-SWAP', at - 2 * minute, 'buy', '1'),
      trade('4', 'BZ-USDT-SWAP', at - 3 * minute, 'buy', '1'),
    ];
    const { calls, fetcher } = mock(url => {
      if (url.pathname === '/api/v5/account/config') return { code: '0', data: [{ perm: 'read_only' }] };
      if (url.pathname === '/api/v5/account/positions') {
        if (++positionReads === 1) clock = at + duration;
        return { code: '0', data: [
          { instType: 'SWAP', instId: 'CL-USDT-SWAP', posId: 'cl', pos: '-2', posSide: 'net', mgnMode: 'cross' },
          { instType: 'SWAP', instId: 'BZ-USDT-SWAP', posId: 'bz', pos: '1', posSide: 'net', mgnMode: 'cross' },
        ] };
      }
      if (url.pathname === '/api/v5/public/instruments') {
        const instId = url.searchParams.get('instId')!;
        return { code: '0', data: [{ instId, instType: 'SWAP', uly: instId.replace('-SWAP', ''), settleCcy: 'USDT', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0] }] };
      }
      assert.equal(url.pathname, '/api/v5/trade/fills-history');
      // Strict exchange-side filtering reproduces the missing fill; no out-of-window fixture rows leak through.
      return { code: '0', data: trades.filter(row => row.instId === url.searchParams.get('instId')
        && Number(row.ts) >= Number(url.searchParams.get('begin')) && Number(row.ts) <= Number(url.searchParams.get('end') ?? clock + clockSkew)) };
    });
    const service = createFillsService({ now: () => clock, fetcher,
      fills: (credentials, product, request, options) => readFills(credentials, product, request, { ...options, spacing: false }) });
    t.after(() => service.close());
    await service.read(f.database, 'owner', f.unseal); await service.idle();
    const awaitedReport = await service.read(f.database, 'owner', f.unseal), first = scope(awaitedReport);
    assert.equal(first.fills.length, 4, 'history must include the sell already reflected in the position response');
    assert.equal(first.coverageEnd, iso(at + Math.max(duration, tradeOffset)), 'coverage includes the newest exchange timestamp or snapshot completion, whichever is later');
    const { normalizeAssetFills } = await import(new URL('../../../server/asset-fills.mjs', import.meta.url).href);
    assert.doesNotThrow(() => normalizeAssetFills(awaitedReport, clock));
    assert.ok(first.fills.filter(item => item.base === 'CL').every(item => item.positionBefore === null && item.positionAfter === null));
    const unaffected = first.fills.find(item => item.base === 'BZ')!;
    assert.deepEqual([unaffected.positionBefore, unaffected.positionAfter], ['0', '1']);
    const history = () => calls.filter(url => url.pathname === '/api/v5/trade/fills-history');
    assert.ok(history().every(url => !url.searchParams.has('end')));
    clock += 29_999; await service.read(f.database, 'owner', f.unseal); await service.idle();
    assert.equal(positionReads, 1);
    clock += 60_001; const recoveredAt = clock;
    await service.read(f.database, 'owner', f.unseal); await service.idle();
    const recovered = scope(await service.read(f.database, 'owner', f.unseal));
    assert.equal(history()[2].searchParams.get('begin'), String(recoveredAt - CYCLE_LOOKBACK_MS), 'uncertain read did not establish an incremental cursor');
    assert.deepEqual(recovered.fills.filter(item => item.base === 'CL').map(item => [item.id, item.positionBefore, item.positionAfter]),
      [['3', '0', '-2'], ['2', '1', '0'], ['1', '0', '1']]);
    assert.equal(recovered.coverageEnd, iso(recoveredAt));
    clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
    assert.equal(history()[4].searchParams.get('begin'), String(recoveredAt - 10 * minute), 'successful recovery establishes the next cursor');
  });
});

test('revision replacement and account deletion discard in-flight results and isolate owners', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const pending = deferred<ReadFill[]>(); let calls = 0;
  const service = createFillsService({ now: () => at, read: async () => [], fills: async () => { calls++; return calls === 1 ? pending.promise : []; } });
  const first = await service.read(f.database, 'owner', f.unseal); await flush();
  await f.save({ ...okx, apiKey: 'replacement-key' });
  const next = await service.read(f.database, 'owner', f.unseal);
  assert.notEqual(first.exchanges[2].accounts[0].revision, next.exchanges[2].accounts[0].revision);
  assert.deepEqual(scope(next).fills, []);
  pending.resolve([fill('old', at - minute - 1, 'buy', '1')]); await service.idle();
  assert.deepEqual(scope(await service.read(f.database, 'owner', f.unseal)).fills, []);
  await f.database.prepare('DELETE FROM connections WHERE owner = ?').bind('owner').run();
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).status, 'unconfigured');
  assert.equal(scope(await service.read(f.database, 'other-owner', f.unseal)).status, 'unconfigured');
});

test('PM-only accounts never read classic history, and unsupported configured scopes never decrypt or call providers', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(binance);
  const paths: string[] = [];
  const service = createFillsService({ now: () => at, read: async (_c, product) => { paths.push('position:' + product); assert.equal(product, 'pm-um'); return []; },
    fills: async (_c, product) => { paths.push('fills:' + product); assert.equal(product, 'pm-um'); return []; } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  const result = await service.read(f.database, 'owner', f.unseal);
  assert.deepEqual(paths, ['position:pm-um', 'fills:pm-um']);
  assert.equal(scope(result, 'binance', 'um'), undefined);
  assert.equal(scope(result, 'binance', 'pm-cm').status, 'unsupported');
  await f.save({ exchange: 'variational', vrToken: 'synthetic-session' });
  const report = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(report, 'variational', 'portfolio').status, 'unsupported');
  assert.equal(scope(report, 'aster', 'perpetual').status, 'unconfigured');
});

test('a failed PM refresh restores probing of classic mode, while configured Gate stays unsupported', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(binance);
  let clock = at, pmFailed = false; const products: string[] = [];
  const service = createFillsService({ now: () => clock, read: async (_c, product) => {
    products.push(product); if (pmFailed && product === 'pm-um') throw new Error('PRIVATE'); return [];
  }, fills: async () => [] });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  pmFailed = true; clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.deepEqual(products, ['pm-um', 'pm-um', 'um']);
  await f.save({ exchange: 'gate', ...keys });
  const report = await service.read(f.database, 'owner', f.unseal);
  assert.equal(scope(report, 'gate', 'portfolio').status, 'unsupported');
});

test('same-millisecond Bybit executions keep exchange order through replay and a 2000-fill scope truncation', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const data = Array.from({ length: 2100 }, (_, i) => fill('row-' + String(2100 - i).padStart(4, '0'), at - minute - 1, 'buy', '1', { order: i }));
  const service = createFillsService({ now: () => at, read: async () => [], fills: async () => data });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  const result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.fills.length, 2000); assert.equal(result.truncated, true);
  assert.equal(result.fills[0].id, 'row-2100'); assert.equal(result.fills[1999].id, 'row-0101');
  assert.equal(result.fills[1999].positionBefore, '-2000');
  const bybitFills = [fill('z-new', at - minute - 1, 'sell', '1', { sizeAfter: '1', order: 0 }),
    fill('a-old', at - minute - 1, 'buy', '2', { sizeAfter: '2', order: 1 })];
  assert.deepEqual(replayFills(bybitFills, [held('1')], at, 'bybit').fills.map(item => [item.id, item.positionBefore, item.positionAfter]),
    [['z-new', '2', '1'], ['a-old', '0', '2']]);
});

test('the 80-request budget includes the current position snapshot and never returns a false live empty scope', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let calls = 0;
  const service = createFillsService({ now: () => at, fetcher: (async () => { calls++; return Response.json({ code: '0', data: [] }); }) as typeof fetch,
    read: async (_c, _s, signal, fetcher) => {
      for (let i = 0; i < 80; i++) await fetcher('https://fixture.invalid/read', { signal });
      return [];
    } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  const result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(calls, 80); assert.equal(result.status, 'error'); assert.equal(result.fetchedAt, null);
});

test('failures retain prior successful data as stale, sanitize text, retry after 60s and restore idle entries from storage', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let clock = at, fail = false, reads = 0;
  const service = createFillsService({ now: () => clock, read: async () => [], fills: async () => {
    reads++; if (fail) throw new Error('PRIVATE signature=secret'); return [fill('1', at - minute - 1, 'sell', '1')];
  } });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  fail = true; clock += 5 * minute; await service.read(f.database, 'owner', f.unseal); await service.idle();
  let result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.status, 'stale'); assert.equal(result.fetchedAt, iso(at)); assert.equal(result.fills.length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  clock += 59_999; await service.read(f.database, 'owner', f.unseal); await service.idle(); assert.equal(reads, 2);
  clock++; await service.read(f.database, 'owner', f.unseal); await service.idle(); assert.equal(reads, 3);
  // Failed refreshes are never stored: the evicted entry comes back as the last success, now stale.
  clock += 15 * minute; result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.status, 'stale'); assert.equal(result.fetchedAt, iso(at)); assert.equal(result.fills.length, 1); assert.equal(result.refreshing, true);
  await service.idle();
});

test('position read failure still exposes history with unknown replay and does not claim successful refresh', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const service = createFillsService({ now: () => at, read: async () => { throw new Error('PRIVATE'); }, fills: async () => [fill('1', at - minute - 1, 'buy', '1')] });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  const result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(result.fills.length, 1); assert.equal(result.fills[0].positionBefore, null); assert.equal(result.fetchedAt, null); assert.equal(result.status, 'error');
});

test('scope cap replays before trimming and response cap keeps the globally newest 5000', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(okx); await f.save(binance); await f.save(bybit);
  const service = createFillsService({ now: () => at, read: async () => [], fills: async (c, product) =>
    Array.from({ length: 2100 }, (_, i) => fill(c.exchange + product + i, at - minute - 1 - i * 10, 'buy', '1', { sizeAfter: String(-i) })) });
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  const report = await service.read(f.database, 'owner', f.unseal), all = report.exchanges.flatMap(e => e.accounts.flatMap(a => a.scopes));
  assert.equal(all.reduce((count, item) => count + item.fills.length, 0), 5000);
  assert.ok(all.every(item => item.fills.length <= 2000));
  const result = scope(report);
  assert.equal(result.truncated, true); assert.equal(result.coverageStart, result.fills.at(-1)!.time);
  assert.equal(result.fills[0].positionBefore, '-1'); assert.equal(result.fills[0].positionAfter, '0');
  assert.ok(result.fills.every(item => Date.parse(item.time) >= at - minute - 1 - 1250 * 10));
});

test('scheduler allows one scope per exchange across services and markets, other exchanges in parallel, and deadline releases a stalled provider', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const pending = deferred<ReadFill[]>(); let active = 0, maximum = 0;
  // The default deadline: the serialization check must not race a short timeout that releases the slot (covered below).
  const service = createFillsService({ now: () => at, read: async () => [], fills: async () => {
    active++; maximum = Math.max(maximum, active); try { return await pending.promise; } finally { active--; }
  } });
  const second = createFillsService({ now: () => at, read: async () => [], fills: async () => { maximum = Math.max(maximum, active + 1); return []; } });
  await service.read(f.database, 'owner', f.unseal); await second.read(f.database, 'owner', f.unseal, 'hynix');
  await flush(); assert.equal(active, 1);
  pending.resolve([]); await Promise.all([service.idle(), second.idle()]); assert.equal(maximum, 1);
  const p = fixture(); t.after(() => p.database.close()); await p.save(okx); await p.save(bybit);
  const gate = deferred<void>(), started: string[] = [];
  const parallel = createFillsService({ now: () => at, read: async () => [], fills: async credentials => { started.push(credentials.exchange); await gate.promise; return []; } });
  t.after(() => parallel.close());
  await parallel.read(p.database, 'owner', p.unseal); await flush(); await flush();
  assert.deepEqual(started.sort(), ['bybit', 'okx'], 'a slow exchange does not hold back another exchange');
  gate.resolve(); await parallel.idle();
  // A separate database: the shared one already stores the successful read above.
  const g = fixture(); t.after(() => g.database.close()); await g.save();
  const stuck = createFillsService({ now: () => at, deadline: 10, read: async () => new Promise(() => {}), fills: async () => assert.fail('deadline prevents fills') });
  await stuck.read(g.database, 'owner', g.unseal); await stuck.idle();
  assert.equal(scope(await stuck.read(g.database, 'owner', g.unseal)).status, 'error');
  // The stalled provider never settles, yet the deadline handed its exchange slot to the next scope.
  const h = fixture(); t.after(() => h.database.close()); await h.save();
  let released = false;
  const next = createFillsService({ now: () => at, read: async () => [], fills: async () => { released = true; return []; } });
  await next.read(h.database, 'owner', h.unseal); await next.idle();
  assert.equal(released, true);
});

test('history requests have a shared spacing reservation and refuse a page beyond the 80 request budget', async () => {
  const calls: number[] = [];
  const fetcher = (async () => { calls.push(Date.now()); return Response.json([]); }) as typeof fetch;
  const a = historyContext('binance', binance, { fetcher }), b = historyContext('binance', binance, { fetcher });
  await Promise.all([a.get('/fapi/v1/userTrades', {}), b.get('/fapi/v1/userTrades', {}), a.get('/fapi/v1/userTrades', {})]);
  assert.ok(calls[1] - calls[0] >= 230); assert.ok(calls[2] - calls[1] >= 230);
  const unlimited = mock(url => ({ retCode: 0, result: { list: [], nextPageCursor: 'cursor-' + (Number(url.searchParams.get('cursor')?.split('-')[1] ?? 0) + 1) } }));
  await assert.rejects(readFills(bybit, 'linear-usdt', { market: 'oil', start: at - minute - 1, end: at }, { fetcher: unlimited.fetcher, spacing: false }));
  assert.equal(unlimited.calls.length, 80);
});

test('fills route authenticates first, rejects all extra/duplicate query params, and sanitizes service failures', async () => {
  for (const [query, market] of [['', 'oil'], ['?schemaVersion=1', 'oil'], ['?market=oil', 'oil'], ['?schemaVersion=1&market=hynix', 'hynix']]) {
    assert.equal(fillsQueryMarket('http://localhost/api/hub/fills' + query), market);
  }
  for (const query of ['?schemaVersion=2', '?symbol=BTCUSDT', '?schemaVersion=1&symbol=CL', '?schemaVersion=1&schemaVersion=1', '?schemaVersion=',
    '?market=gold', '?market=', '?market=oil&market=hynix', '?market=__proto__']) {
    assert.equal(fillsQueryMarket('http://localhost/api/hub/fills' + query), null);
  }
  let auth = true, fail = false, reads = 0, initialized = 0;
  const markets: unknown[] = [];
  const stubs = {
    apiOwner: async () => { if (!auth) throw new Error('AUTH_REQUIRED'); return 'owner'; },
    failure: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    db: () => ({}), initialize: async () => { initialized++; }, unseal: async () => ({}), fillsQueryMarket,
    hubFillsService: { read: async (...args: unknown[]) => { reads++; markets.push(args[3]); if (fail) throw new Error('PRIVATE signature=secret'); return { schemaVersion: 1 }; } },
  };
  const key = '__assetFillsRouteTest';
  const globals = globalThis as unknown as Record<string, unknown>; globals[key] = stubs;
  try {
    let source = await readFile(new URL('../app/api/hub/fills/route.ts', import.meta.url), 'utf8');
    source = source.replace(/^import\s+\{([^}]+)\}\s+from\s+[^;]+;/gm, (_match, names) => `const {${names}} = globalThis.${key};`);
    const route = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
    const request = (query = '') => new Request('http://localhost/api/hub/fills' + query);
    assert.equal((await route.GET(request('?symbol=BTC'))).status, 400); assert.equal(reads, 0); assert.equal(initialized, 0);
    assert.equal((await route.GET(request('?schemaVersion=1'))).status, 200); assert.equal(reads, 1);
    assert.equal((await route.GET(request('?market=hynix'))).status, 200); assert.deepEqual(markets, ['oil', 'hynix']);
    assert.equal((await route.GET(request('?market=gold'))).status, 400); assert.equal(reads, 2);
    auth = false; assert.equal((await route.GET(request('?bad=1'))).status, 401);
    auth = true; fail = true; const response = await route.GET(request()); assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('PRIVATE'), false);
  } finally { delete globals[key]; }
});

test('all venue readers leave the newest window open and keep older weekly windows contiguous', async () => {
  for (const [credentials, product] of [[binance, 'um'], [binance, 'pm-um'], [bybit, 'linear-usdt'], [bybit, 'linear-usdc'], [okx, 'SWAP']] as const) {
    const currency = product === 'linear-usdc' ? 'USDC' : 'USDT', exchangeTime = at + 30_000;
    const { calls, fetcher } = mock(url => {
      const isCl = (url.searchParams.get('symbol') ?? url.searchParams.get('baseCoin') ?? url.searchParams.get('instId'))!.startsWith('CL');
      const { start, end } = historyBounds(url, credentials.exchange, exchangeTime);
      const included = isCl && start <= exchangeTime && end >= exchangeTime;
      if (credentials.exchange === 'binance') return included ? [{ symbol: 'CLUSDT', id: 1, time: exchangeTime, side: 'SELL', positionSide: 'BOTH',
        qty: '2', price: '80', realizedPnl: '0', commission: '0.1', commissionAsset: 'USDT' }] : [];
      if (credentials.exchange === 'bybit') return { retCode: 0, result: { nextPageCursor: '', list: included ? [{
        id: '1', symbol: 'CL' + currency, currency, type: 'TRADE', side: 'Sell', transactionTime: String(exchangeTime),
        qty: '2', tradePrice: '80', cashFlow: '0', fee: '0.1', size: '-2',
      }] : [] } };
      return { code: '0', data: included ? [{ billId: '1', instId: 'CL-USDT-SWAP', ts: String(exchangeTime), side: 'sell', posSide: 'net',
        fillSz: '2', fillPx: '80', fillPnl: '0', fee: '-0.1', feeCcy: 'USDT' }] : [] };
    });
    const result = await readFills(credentials, product, { market: 'oil', start: at - CYCLE_LOOKBACK_MS, end: at + 500 }, { fetcher, spacing: false });
    assert.equal(result.length, 1); assert.equal(result[0].time, iso(exchangeTime));
    const clCalls = calls.filter(url => (url.searchParams.get('symbol') ?? url.searchParams.get('baseCoin') ?? url.searchParams.get('instId'))!.startsWith('CL'));
    assert.equal(clCalls[0].searchParams.has('endTime'), false); assert.equal(clCalls[0].searchParams.has('end'), false);
    if (credentials.exchange === 'okx') continue;
    const windows = clCalls.map(url => historyBounds(url, credentials.exchange, exchangeTime)).reverse();
    assert.equal(windows[0].start, at - CYCLE_LOOKBACK_MS);
    assert.ok(windows.every(window => window.end - window.start < 7 * day));
    for (let i = 1; i < windows.length; i++) assert.equal(windows[i].start, windows[i - 1].end + 1);
  }
});

test('Bybit initial and resumed reads cover six-day history and both sides of the 23h boundary exactly once', async t => {
  const hour = 60 * minute, boundary = at - 23 * hour, exchangeTime = at + minute;
  const previousCoverageEnd = at - 2 * day;
  for (const product of ['linear-usdt', 'linear-usdc']) {
    const currency = product === 'linear-usdc' ? 'USDC' : 'USDT';
    for (const [name, start, expectedCalls] of [
      ['initial 85 days', at - CYCLE_LOOKBACK_MS, 28],
      ['resume after two days', previousCoverageEnd - 10 * minute, 4],
      ['exactly 23 hours', boundary, 2],
      ['23 hours plus one millisecond', boundary - 1, 4],
    ] as const) await t.test(`${product}: ${name}`, async () => {
      const times = [...new Set([start - 1, start, at - 6 * day, at - 5 * day, at - day, boundary - 1, boundary, boundary + 1, at - 2 * minute, exchangeTime])]
        .sort((a, b) => b - a);
      const rows = times.map((time, i) => ({
        id: String(i + 1), symbol: 'CL' + currency, currency, type: 'TRADE', side: 'Buy', transactionTime: String(time),
        qty: '1', tradePrice: '80', cashFlow: '0', fee: '0.1', size: String(times.length - i),
      }));
      const { calls, fetcher } = mock(url => {
        const bounds = historyBounds(url, 'bybit', exchangeTime);
        return { retCode: 0, result: { nextPageCursor: '', list: url.searchParams.get('baseCoin') === 'BZ' ? []
          : rows.filter(row => Number(row.transactionTime) >= bounds.start && Number(row.transactionTime) <= bounds.end) } };
      });
      const result = await readFills(bybit, product, { market: 'oil', start, end: at }, { fetcher, spacing: false });
      assert.deepEqual(result.map(item => item.time).sort(), times.filter(time => time >= start).map(iso).sort());
      assert.equal(new Set(result.map(item => item.id)).size, result.length, 'window joins must not duplicate fills');
      assert.equal(calls.length, expectedCalls, '85-day history needs 28 base requests, leaving room for positions and cursor pages');
      const clCalls = calls.filter(url => url.searchParams.get('baseCoin') === 'CL');
      assert.equal(clCalls[0].searchParams.has('endTime'), false);
      assert.equal(Number(clCalls[0].searchParams.get('startTime')), boundary);
      assert.ok(clCalls.slice(1).every(url => url.searchParams.has('endTime')));
      const windows = clCalls.map(url => historyBounds(url, 'bybit', exchangeTime)).reverse();
      assert.equal(windows[0].start, start);
      for (let i = 1; i < windows.length; i++) assert.equal(windows[i].start, windows[i - 1].end + 1);
    });
  }
});

test('Bybit 85-day pagination rejects an incomplete history when its 28 windows exceed the shared request budget', async () => {
  const { calls, fetcher } = mock(url => {
    historyBounds(url, 'bybit');
    const page = Number(url.searchParams.get('cursor') ?? 0);
    return { retCode: 0, result: { list: [], nextPageCursor: page < 2 ? String(page + 1) : '' } };
  });
  // Three cursor pages per window require 84 requests; never publish the first 80 as complete.
  await assert.rejects(readFills(bybit, 'linear-usdt', { market: 'oil', start: at - CYCLE_LOOKBACK_MS, end: at }, { fetcher, spacing: false }),
    /成交记录过多/);
  assert.equal(calls.length, 80);
  assert.equal(calls.filter(url => url.searchParams.get('baseCoin') === 'CL').length, 42);
  assert.equal(calls.filter(url => url.searchParams.get('baseCoin') === 'BZ').length, 38);
});

test('uncertainty retries without another read, keeps pending visible and stops after ten automatic attempts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let reads = 0;
  const service = createFillsService({ read: async () => [], fills: async () => {
    reads++; return [fill(String(reads), Date.now() - 1_000, 'buy', '1')];
  } });
  t.after(() => service.close());
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, true);
  t.mock.timers.tick(25_000);
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, true, 'Monitor follow-up still sees pending');
  assert.equal(reads, 1);
  t.mock.timers.tick(5_000); await service.idle();
  assert.equal(reads, 2, 'the timer refreshes without a new read');
  for (let attempt = 2; attempt <= 10; attempt++) { t.mock.timers.tick(30_000); await service.idle(); }
  assert.equal(reads, 11);
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, false);
  t.mock.timers.tick(30_000); await service.idle();
  assert.equal(reads, 11, 'automatic retry chain is bounded');
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(reads, 12, 'a later read may explicitly start another bounded chain');
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, true);
});

test('a stable later snapshot resolves the timer retry and advances the cursor only after uncertainty ends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const starts: number[] = [];
  const service = createFillsService({ read: async () => [held('1')], fills: async (_c, _s, request) => {
    starts.push(request.start); return [fill('1', at - 1_000, 'buy', '1')];
  } });
  t.after(() => service.close());
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  t.mock.timers.tick(30_000); await service.idle();
  assert.equal(starts.length, 2);
  assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).fills[0].positionBefore, null);
  t.mock.timers.tick(30_000); await service.idle();
  const result = scope(await service.read(f.database, 'owner', f.unseal));
  assert.equal(starts.length, 3); assert.equal(starts[2], Date.now() - CYCLE_LOOKBACK_MS);
  assert.equal(result.refreshing, false); assert.equal(result.fills[0].positionBefore, '0');
  t.mock.timers.tick(30_000); await service.idle(); assert.equal(starts.length, 3);
  t.mock.timers.tick(270_000); await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal(starts[3], at + 60_000 - 10 * minute);
});

test('credential replacement, account deletion, idle eviction and close cancel scheduled retry work', async t => {
  for (const action of ['revision', 'deletion', 'idle', 'close'] as const) await t.test(action, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
    const f = fixture(); t.after(() => f.database.close()); await f.save();
    let reads = 0;
    const service = createFillsService({ read: async () => [], fills: async c => {
      reads++; return 'apiKey' in c && c.apiKey === 'replacement-key' ? [] : [fill('1', at - 1_000, 'buy', '1')];
    } });
    t.after(() => service.close());
    await service.read(f.database, 'owner', f.unseal); await service.idle();
    assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, true);
    if (action === 'revision') {
      await f.save({ ...okx, apiKey: 'replacement-key' });
      await service.read(f.database, 'owner', f.unseal); await service.idle();
      assert.equal(reads, 2);
      assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).refreshing, false);
    } else if (action === 'deletion') {
      await f.database.prepare('DELETE FROM connections WHERE owner = ?').bind('owner').run();
      assert.equal(scope(await service.read(f.database, 'owner', f.unseal)).status, 'unconfigured');
    } else if (action === 'idle') {
      // A delayed timer wake after inactivity must evict, not fetch on behalf of an idle reader.
      t.mock.timers.setTime(at + 15 * minute);
    } else service.close();
    t.mock.timers.tick(30_000); await service.idle();
    assert.equal(reads, action === 'revision' ? 2 : 1);
    t.mock.timers.tick(60_000); await service.idle();
    assert.equal(reads, action === 'revision' ? 2 : 1, 'no cancelled timer returns later');
    if (action === 'idle') {
      const result = scope(await service.read(f.database, 'owner', f.unseal));
      assert.equal(result.status, 'stale'); assert.equal(result.fills.length, 1);
      await service.idle();
    }
    if (action === 'close') await assert.rejects(service.read(f.database, 'owner', f.unseal));
  });
});

test('scheduled retries recheck credentials even without a poll after deletion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at });
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let reads = 0;
  const service = createFillsService({ read: async () => [], fills: async () => { reads++; return [fill('1', at - 1_000, 'buy', '1')]; } });
  t.after(() => service.close());
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  await f.database.prepare('DELETE FROM connections WHERE owner = ?').bind('owner').run();
  t.mock.timers.tick(30_000); await service.idle(); assert.equal(reads, 1);
  t.mock.timers.tick(60_000); await service.idle(); assert.equal(reads, 1);
});

test('a restarted service serves stored fills at once, waits for the stored refresh time and resumes from the stored cursor', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let clock = at; const requests: { start: number; end: number }[] = [];
  const options = { now: () => clock, read: async () => [held('1')], fills: async (_c: Credentials, _s: string, request: { start: number; end: number }) => {
    requests.push(request); return [fill('1', at - 2 * minute, 'buy', '1')];
  } };
  const first = createFillsService(options);
  await first.read(f.database, 'owner', f.unseal); await first.idle(); first.close();
  assert.equal(requests.length, 1);

  clock += 4 * minute;
  const second = createFillsService(options); t.after(() => second.close());
  let result = scope(await second.read(f.database, 'owner', f.unseal));
  assert.equal(result.status, 'live'); assert.equal(result.refreshing, false); assert.equal(result.fetchedAt, iso(at));
  assert.deepEqual(result.fills.map(item => [item.id, item.positionBefore, item.positionAfter]), [['1', '0', '1']]);
  await second.idle(); assert.equal(requests.length, 1, 'a stored success is reused until its own refresh time');

  clock += minute;
  result = scope(await second.read(f.database, 'owner', f.unseal));
  assert.equal(result.refreshing, true); assert.equal(result.fills.length, 1);
  await second.idle();
  assert.equal(requests[1].start, at - 10 * minute, 'refresh resumes from the stored cursor, not the 85-day lookback');
  assert.equal(scope(await second.read(f.database, 'owner', f.unseal)).fetchedAt, iso(clock));
});

test('stored fills are dropped for replaced or deleted credentials, conflicts and unreadable rows', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const rows = async () => (await f.database.prepare('SELECT account,scope,revision FROM fill_cache WHERE owner = ?').bind('owner').all()).results;
  let clock = at, conflict = false;
  const options = { now: () => clock, read: async () => [held('1')], fills: async () => [fill('1', at - 2 * minute, 'buy', '1', conflict ? { price: '999' } : {})] };
  const service = createFillsService(options); t.after(() => service.close());
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal((await rows()).length, 1);

  await f.save({ ...okx, apiKey: 'replacement-key' });
  const other = createFillsService(options); t.after(() => other.close());
  assert.deepEqual(scope(await other.read(f.database, 'owner', f.unseal)).fills, []);
  assert.deepEqual(await rows(), [], 'a row from older credentials is never served and is deleted');
  await other.idle(); other.close();

  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal((await rows()).length, 1);
  conflict = true; clock += 5 * minute;
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.match(scope(await service.read(f.database, 'owner', f.unseal)).error!, /冲突/);
  assert.deepEqual(await rows(), [], 'a conflicting history does not survive the process');

  conflict = false; clock += minute;
  await service.read(f.database, 'owner', f.unseal); await service.idle();
  assert.equal((await rows()).length, 1);
  await f.database.prepare('UPDATE fill_cache SET data = ? WHERE owner = ?').bind('{"version":1,"scope":{}}', 'owner').run();
  const fresh = createFillsService(options); t.after(() => fresh.close());
  assert.equal(scope(await fresh.read(f.database, 'owner', f.unseal)).status, 'loading');
  await fresh.idle(); assert.equal((await rows()).length, 1, 'an unreadable row is replaced by a fresh full read');

  await f.database.prepare('DELETE FROM connections WHERE owner = ?').bind('owner').run();
  await fresh.read(f.database, 'owner', f.unseal);
  assert.deepEqual(await rows(), []);
});

test('a restart after 15 minutes drops stored Binance mode evidence, so a PM account hides classic mode again', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(binance);
  let clock = at, pmFailed = false; const products: string[] = [];
  const options = { now: () => clock, read: async (_c: Credentials, product: string) => {
    products.push(product); if (pmFailed && product === 'pm-um') throw new Error('PRIVATE'); return [];
  }, fills: async () => [] };
  const first = createFillsService(options);
  await first.read(f.database, 'owner', f.unseal); await first.idle();
  pmFailed = true; clock += 5 * minute; await first.read(f.database, 'owner', f.unseal); await first.idle();
  await first.read(f.database, 'owner', f.unseal); await first.idle(); first.close();
  assert.deepEqual(products, ['pm-um', 'pm-um', 'um']);

  pmFailed = false; clock += 20 * minute; products.length = 0;
  const second = createFillsService(options); t.after(() => second.close());
  await second.read(f.database, 'owner', f.unseal); await second.idle();
  const result = await second.read(f.database, 'owner', f.unseal);
  assert.deepEqual(products, ['pm-um']);
  assert.equal(scope(result, 'binance', 'um'), undefined);
});

test('stored fills stay with their owner', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save(okx, 'owner'); await f.save(okx, 'other');
  // The fixture vault is keyed by owner 'owner'; give the second owner its own key.
  const unseal = async (value: string) => value === 'synthetic-1' ? okx : { ...okx, apiKey: 'other-key' };
  const options = { now: () => at, read: async () => [held('1')],
    fills: async (c: Credentials) => [fill('apiKey' in c && c.apiKey === 'other-key' ? 'other-fill' : 'owner-fill', at - 2 * minute, 'buy', '1')] };
  const first = createFillsService(options);
  for (const owner of ['owner', 'other']) { await first.read(f.database, owner, unseal); await first.idle(); }
  first.close();
  const second = createFillsService({ ...options, fills: async () => assert.fail('stored fills are within their refresh time') });
  t.after(() => second.close());
  assert.deepEqual(scope(await second.read(f.database, 'owner', unseal)).fills.map(item => item.id), ['owner-fill']);
  assert.deepEqual(scope(await second.read(f.database, 'other', unseal)).fills.map(item => item.id), ['other-fill']);
});

test('hynix reads its own fixed contracts on every venue and rejects other instruments', async () => {
  const symbols: string[] = [];
  const binanceRows = mock(url => { symbols.push(url.searchParams.get('symbol')!); historyBounds(url, 'binance');
    return url.searchParams.get('symbol') === 'SKHYUSDT' ? [{ symbol: 'SKHYUSDT', id: 1, time: at - 5_000, side: 'SELL', positionSide: 'BOTH',
      qty: '10', price: '38.5', realizedPnl: '0', commission: '0.01', commissionAsset: 'USDT' }] : []; });
  const fills = await readFills(binance, 'um', { market: 'hynix', start: at - minute - 1, end: at }, { fetcher: binanceRows.fetcher, spacing: false });
  assert.deepEqual(fills.map(item => [item.id, item.base, item.quantityUnit]), [['SKHYUSDT:1', 'SKHY', 'SKHY']]);
  assert.deepEqual([...new Set(symbols)], ['SKHYUSDT', 'SKHYNIXUSDT']);
  const bybitRows = mock(url => ({ retCode: 0, result: { nextPageCursor: '', list: url.searchParams.get('baseCoin') === 'SKHYNIX' ? [{ id: 'h', symbol: 'SKHYNIXUSDT', currency: 'USDT',
    type: 'TRADE', side: 'Buy', transactionTime: String(at - 5_000), qty: '1', tradePrice: '390', size: '1', fee: '-0.1', cashFlow: '0' }, { symbol: 'CLUSDT', type: 'TRADE' }] : [] } }));
  assert.deepEqual((await readFills(bybit, 'linear-usdt', { market: 'hynix', start: at - minute - 1, end: at }, { fetcher: bybitRows.fetcher, spacing: false }))
    .map(item => [item.symbol, item.base]), [['SKHYNIXUSDT', 'SKHYNIX']]);
  assert.deepEqual([...new Set(bybitRows.calls.map(url => url.searchParams.get('baseCoin')))], ['SKHY', 'SKHYNIX']);
  const okxRows = mock(() => ({ code: '0', data: [] }));
  await readFills(okx, 'SWAP', { market: 'hynix', start: at - minute - 1, end: at }, { fetcher: okxRows.fetcher, spacing: false });
  assert.deepEqual([...new Set(okxRows.calls.map(url => url.searchParams.get('instId')))], ['SKHY-USDT-SWAP', 'SKHYNIX-USDT-SWAP']);
  const wrong = mock(() => [{ symbol: 'CLUSDT', id: 2, time: at - 5_000, side: 'BUY', positionSide: 'BOTH', qty: '1', price: '80', realizedPnl: '0', commission: '0', commissionAsset: 'USDT' }]);
  await assert.rejects(readFills(binance, 'um', { market: 'hynix', start: at - minute - 1, end: at }, { fetcher: wrong.fetcher, spacing: false }));
});

test('each market keeps its own entries and stored rows, and an unknown stored market is deleted', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const rows = async () => (await f.database.prepare('SELECT scope FROM fill_cache WHERE owner = ? ORDER BY scope').bind('owner').all<{ scope: string }>()).results.map(row => row.scope);
  let clock = at; const markets: string[] = [];
  const options = { now: () => clock, read: async () => [held('1')], fills: async (_c: Credentials, _s: string, request: { market: string }) => {
    markets.push(request.market); return [fill(request.market + '-1', at - 2 * minute, 'buy', '1')];
  } };
  const first = createFillsService(options);
  await first.read(f.database, 'owner', f.unseal); await first.idle();
  await first.read(f.database, 'owner', f.unseal, 'hynix'); await first.idle();
  clock += minute;
  assert.deepEqual(scope(await first.read(f.database, 'owner', f.unseal)).fills.map(item => item.id), ['oil-1'], 'reading hynix keeps the oil entry');
  await first.idle(); first.close();
  assert.deepEqual(markets, ['oil', 'hynix']);
  assert.deepEqual(await rows(), ['SWAP', 'hynix:SWAP']);
  await f.database.prepare('INSERT INTO fill_cache(owner,account,scope,revision,data,updated_at) SELECT owner,account,?,revision,data,updated_at FROM fill_cache WHERE scope = ?').bind('gold:SWAP', 'SWAP').run();
  const second = createFillsService({ ...options, fills: async () => assert.fail('stored fills are within their refresh time') });
  t.after(() => second.close());
  assert.deepEqual(scope(await second.read(f.database, 'owner', f.unseal, 'hynix')).fills.map(item => item.id), ['hynix-1']);
  assert.deepEqual(scope(await second.read(f.database, 'owner', f.unseal)).fills.map(item => item.id), ['oil-1']);
  assert.deepEqual(await rows(), ['SWAP', 'hynix:SWAP']);
});

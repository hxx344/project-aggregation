import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createTradingExchangeClient } from '../server/trading-exchanges.mjs';
import { createTrading } from '../server/trading.mjs';

const NOW = Date.parse('2026-11-07T00:00:00Z');
const credentials = { apiKey: 'fixture_only_key', apiSecret: 'fixture_only_secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const permissions = () => ({ enableReading: true, ...Object.fromEntries(['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'].map(key => [key, false])) });
const row = (symbol, extra = {}) => ({ symbol, positionSide: 'BOTH', positionAmt: '2', entryPrice: '100', markPrice: '110', notional: '220', unRealizedProfit: '20', marginAsset: 'USDT', liquidationPrice: '80', leverage: '3', updateTime: NOW - 1000, ...extra });
const delta = (symbol, amount = '3', extra = {}) => ({ s: symbol, ps: 'BOTH', pa: amount, ep: '100', up: '25', ...extra });

function fixture(t, accountMode = 'standard', binanceStreams) {
  let time = NOW;
  const sockets = [], calls = [], snapshots = [], resets = [], rows = new Map();
  class Socket {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sockets.push(this); queueMicrotask(() => this.emit('open')); }
    addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
    emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(value); }
    frame(value) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { this.closed = true; this.emit('close'); }
  }
  const f = { sockets, calls, snapshots, resets, rows, accountMode, permission: permissions(),
    now: () => time, advance(ms) { time += ms; }, permissionHook: null, riskHook: null,
    event(positions, extra = {}, socket = sockets.at(-1)) { socket.frame({ e: 'ACCOUNT_UPDATE', E: time, T: time, ...(accountMode === 'portfolio-margin' ? { fs: 'UM' } : {}), a: { P: positions, m: 'ORDER' }, ...extra }); },
  };
  f.client = createTradingExchangeClient('binance', { now: f.now, WebSocketImpl: Socket, binanceStreams, fetchImpl: async (url, init) => {
    const parsed = new URL(url); calls.push({ url: parsed, init });
    if (parsed.pathname === '/fapi/v1/time') return json({ serverTime: time });
    if (parsed.pathname.endsWith('apiRestrictions')) { if (f.permissionHook) await f.permissionHook(); return json(f.permission); }
    if (parsed.pathname.endsWith('listenKey')) { assert.ok(['POST', 'PUT'].includes(init.method)); return json({ listenKey: 'fixture_listen_token' }); }
    if (parsed.pathname.endsWith('positionRisk')) {
      const symbol = parsed.searchParams.get('symbol'), result = structuredClone(rows.get(symbol) ?? [row(symbol)]);
      if (f.riskHook) await f.riskHook(symbol);
      return json(result);
    }
    if (parsed.pathname.endsWith('income')) return json([]);
    throw new Error('Unexpected fixture path');
  } });
  f.watch = (symbols = ['ANTHROPICUSDT'], overrides = {}, key = credentials) => f.client.watchPositions(key, { accountMode, symbols,
    onSnapshot: result => snapshots.push(result), onReset: reason => resets.push(reason), ...overrides });
  t.after(() => f.client.close());
  return f;
}

for (const accountMode of ['standard', 'portfolio-margin']) test(`${accountMode} readonly positions share one stream across markets and retain only REST risk freshness`, async t => {
  const f = fixture(t, accountMode);
  f.watch(); f.watch(['CLUSDT', 'BZUSDT']); f.watch(['SKHYUSDT', 'SKHYNIXUSDT']);
  await Promise.all([f.client.anthropicPositions(credentials, { accountMode }), f.client.positions(credentials, { accountMode }), f.client.hynixPositions(credentials, { accountMode })]);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('apiRestrictions')).length, 1, 'only in-flight permission reads are shared');
  const count = f.snapshots.length;
  f.advance(1000); f.event([]); assert.equal(f.snapshots.length, count, 'empty P never clears positions or renews freshness');
  f.event([delta('UNWATCHEDUSDT')]); assert.ok(f.snapshots.length > count);
  const afterOtherMarket = f.snapshots.length;
  if (accountMode === 'portfolio-margin') { f.event([delta('ANTHROPICUSDT', '99')], { fs: 'CM' }); assert.equal(f.snapshots.length, afterOtherMarket); }
  f.event([delta('ANTHROPICUSDT')]);
  const updated = f.snapshots.findLast(result => result.positions.some(position => position.symbol === 'ANTHROPICUSDT'));
  assert.equal(updated.positions[0].quantity, '3'); assert.equal(updated.positions[0].entryPrice, '100');
  assert.equal(updated.fetchedAt, new Date(NOW).toISOString());
  assert.equal(updated.positions[0].riskFetchedAt, null);
  for (const field of ['markPrice', 'notional', 'liquidationPrice', 'leverage']) assert.equal(updated.positions[0][field], null);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('positionRisk')).length, 5, 'events perform no REST read');
  const earlier = f.snapshots.length;
  f.event([delta('ANTHROPICUSDT', '1')], { T: NOW, E: NOW + 1000 });
  assert.equal(f.snapshots.length, earlier, 'out-of-order events cannot replace a newer position');
  f.event([delta('ANTHROPICUSDT', '0')]);
  assert.deepEqual(f.snapshots.at(-1).positions, [], 'explicit zero closes just its symbol');
  const oil = f.snapshots.findLast(result => result.positions.some(position => position.symbol === 'CLUSDT'));
  assert.equal(oil.positions.length, 2);
});

for (const accountMode of ['standard', 'portfolio-margin']) {
  for (const change of ['balance', 'other position']) {
    test(`${accountMode} ${change} updates invalidate existing and in-flight risk without changing watched quantities`, async t => {
      const f = fixture(t, accountMode); f.watch();
      await f.client.anthropicPositions(credentials, { accountMode });
      const send = () => change === 'balance'
        ? f.event([], { a: { P: [], B: [{ a: 'USDT', wb: '500', cw: '500' }], m: 'MARGIN_TRANSFER' } })
        : f.event([delta('BTCUSDT', '1')]);
      f.advance(1000); send();
      const stale = f.snapshots.at(-1);
      assert.equal(stale.fetchedAt, new Date(NOW).toISOString());
      assert.equal(stale.positions[0].quantity, '2');
      assert.equal(stale.positions[0].entryPrice, '100');
      for (const field of ['riskFetchedAt', 'markPrice', 'liquidationPrice', 'notional', 'leverage']) assert.equal(stale.positions[0][field], null);
      assert.equal(f.calls.filter(call => call.url.pathname.endsWith('positionRisk')).length, 1);

      const restored = await f.client.anthropicPositions(credentials, { accountMode });
      assert.equal(restored.positions[0].liquidationPrice, '80');
      const gate = deferred(), entered = deferred();
      f.riskHook = async () => { entered.resolve(); await gate.promise; };
      const pending = f.client.anthropicPositions(credentials, { accountMode });
      await entered.promise; f.advance(1000); send(); gate.resolve();
      const raced = await pending;
      assert.equal(raced.positions[0].quantity, '2');
      assert.equal(raced.positions[0].riskFetchedAt, null);
      assert.equal(raced.positions[0].liquidationPrice, null);
      f.riskHook = null;
      const fresh = await f.client.anthropicPositions(credentials, { accountMode });
      assert.equal(fresh.positions[0].riskFetchedAt, new Date(f.now()).toISOString());
      assert.equal(fresh.positions[0].liquidationPrice, '80');
    });
  }
}

test('a delta received while the REST baseline is in flight wins; a later matching REST read restores risk', async t => {
  const f = fixture(t); f.watch();
  const gate = deferred(), entered = deferred();
  f.riskHook = async () => { entered.resolve(); await gate.promise; };
  const pending = f.client.anthropicPositions(credentials);
  await entered.promise; assert.equal(f.sockets.length, 1);
  f.advance(1000); f.event([delta('ANTHROPICUSDT', '5')]);
  assert.equal(f.snapshots.length, 0, 'an event is not a complete baseline');
  gate.resolve();
  assert.equal((await pending).positions[0].quantity, '5'); assert.equal(f.snapshots.at(-1).positions[0].riskFetchedAt, null);
  f.riskHook = null;
  f.rows.set('ANTHROPICUSDT', [row('ANTHROPICUSDT', { positionAmt: '5', updateTime: f.now() })]);
  const restored = await f.client.anthropicPositions(credentials);
  assert.equal(restored.positions[0].quantity, '5'); assert.equal(restored.positions[0].liquidationPrice, '80');
  assert.equal(restored.positions[0].riskFetchedAt, new Date(f.now()).toISOString());
});

test('hedge deltas preserve the other side and tombstones stop a late REST snapshot reopening a position', async t => {
  const f = fixture(t); f.watch();
  f.rows.set('ANTHROPICUSDT', [row('ANTHROPICUSDT', { positionSide: 'LONG' }), row('ANTHROPICUSDT', { positionSide: 'SHORT', positionAmt: '-4' })]);
  await f.client.anthropicPositions(credentials);
  const gate = deferred(), entered = deferred(); f.riskHook = async () => { entered.resolve(); await gate.promise; };
  const pending = f.client.anthropicPositions(credentials); await entered.promise;
  f.advance(1); f.event([delta('ANTHROPICUSDT', '0', { ps: 'LONG' })]); gate.resolve();
  const result = await pending;
  assert.deepEqual(result.positions.map(position => [position.side, position.quantity]), [['short', '4']]);
  f.event([delta('ANTHROPICUSDT', '-7', { ps: 'SHORT' })]);
  assert.deepEqual(f.snapshots.at(-1).positions.map(position => [position.side, position.quantity]), [['short', '7']]);
});

test('an empty REST baseline cannot be reopened by a delayed event from before that read', async t => {
  const f = fixture(t); f.watch(); f.rows.set('ANTHROPICUSDT', []);
  await f.client.anthropicPositions(credentials);
  f.advance(1000); f.event([delta('ANTHROPICUSDT', '2')], { T: NOW - 1000 });
  assert.deepEqual(f.snapshots.at(-1).positions, []);
  f.event([delta('ANTHROPICUSDT', '4')]);
  assert.equal(f.snapshots.at(-1).positions[0].quantity, '4');
});

test('a PnL-only delta does not permanently suppress risk when REST position updateTime stays unchanged', async t => {
  const f = fixture(t); f.watch(); await f.client.anthropicPositions(credentials);
  f.advance(1000); f.event([delta('ANTHROPICUSDT', '2')]);
  assert.equal(f.snapshots.at(-1).positions[0].riskFetchedAt, null);
  const result = await f.client.anthropicPositions(credentials);
  assert.equal(result.positions[0].quantity, '2'); assert.equal(result.positions[0].liquidationPrice, '80');
  assert.equal(result.positions[0].riskFetchedAt, new Date(f.now()).toISOString());
});

test('a change to another portfolio leg invalidates risk from an earlier in-flight multi-symbol REST batch', async t => {
  const f = fixture(t, 'portfolio-margin'); f.watch(); f.watch(['CLUSDT', 'BZUSDT']);
  await Promise.all([f.client.anthropicPositions(credentials, { accountMode: f.accountMode }), f.client.positions(credentials, { accountMode: f.accountMode })]);
  const gate = deferred(), entered = deferred();
  f.riskHook = async symbol => { if (symbol === 'BZUSDT') { entered.resolve(); await gate.promise; } };
  const pending = f.client.positions(credentials, { accountMode: f.accountMode });
  await entered.promise; f.advance(1); f.event([delta('ANTHROPICUSDT', '8')]); gate.resolve();
  const result = await pending;
  assert.deepEqual(result.positions.map(position => position.quantity), ['2', '2']);
  assert.ok(result.positions.every(position => position.liquidationPrice === null && position.riskFetchedAt === null));
});

test('socket resets keep old generations from updating the restored REST baseline', async t => {
  const f = fixture(t); f.watch(); await f.client.anthropicPositions(credentials);
  const old = f.sockets[0]; old.close(); assert.deepEqual(f.resets, ['stream_reset', 'stream_error']);
  const count = f.snapshots.length;
  f.event([delta('ANTHROPICUSDT', '90')], {}, old); assert.equal(f.snapshots.length, count);
  f.advance(1500);
  await f.client.anthropicPositions(credentials);
  assert.equal(f.sockets.length, 2); assert.equal(f.snapshots.at(-1).positions[0].quantity, '2');
  f.event([delta('ANTHROPICUSDT', '91')], {}, old); assert.equal(f.snapshots.at(-1).positions[0].quantity, '2');
  f.event([delta('ANTHROPICUSDT', '4')]); assert.equal(f.snapshots.at(-1).positions[0].quantity, '4');
});

test('a temporary ready failure cannot let a still-open stream roll fresh REST data back to its old baseline', async t => {
  let listener, unavailable = false;
  const streams = {
    subscribePositions(_credentials, observer) { listener = observer; return () => {}; },
    async ready() { if (unavailable) throw new Error('Public clock temporarily unavailable'); return { generation: 1, connectedAt: NOW }; },
    forget() {}, close() {},
  };
  const f = fixture(t, 'standard', streams), db = new DatabaseSync(':memory:');
  const manager = createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, now: f.now, intervalMs: 0,
    clientFactory: exchange => exchange === 'binance' ? f.client : {} });
  t.after(async () => { await manager.close(); db.close(); });
  await manager.connect('binance', { revision: 0, ...credentials }); await manager.refresh(); await nextTurn();
  assert.equal(manager.anthropic()[0].positions[0].quantity, '2');
  f.advance(30_000); unavailable = true;
  f.rows.set('ANTHROPICUSDT', [row('ANTHROPICUSDT', { positionAmt: '5', updateTime: f.now() })]);
  await manager.refresh();
  const fresh = manager.anthropic()[0];
  assert.equal(fresh.positions[0].quantity, '5'); assert.equal(fresh.fetchedAt, new Date(f.now()).toISOString());
  const event = () => listener.onEvent({ generation: 1, eventTime: f.now(), transactionTime: f.now(), positions: [delta('ANTHROPICUSDT', '7')] });
  f.advance(1); event();
  assert.equal(manager.anthropic()[0].fetchedAt, fresh.fetchedAt, 'old WS baseline must not roll back the newer REST time');
  assert.equal(manager.anthropic()[0].positions[0].quantity, '5', 'events wait for a new ready plus complete baseline');
  f.advance(30_000); unavailable = false; await manager.refresh();
  const recovered = manager.anthropic()[0].fetchedAt;
  f.advance(1); event();
  assert.equal(manager.anthropic()[0].positions[0].quantity, '7');
  assert.equal(manager.anthropic()[0].fetchedAt, recovered);
});

test('permission rejection shuts down observation and a replacement credential cannot receive old events', async t => {
  const f = fixture(t); const unwatch = f.watch(); await f.client.anthropicPositions(credentials);
  const old = f.sockets[0], count = f.snapshots.length;
  f.permission = { ...permissions(), enableFutures: true };
  await assert.rejects(f.client.anthropicPositions(credentials), { code: 'permissions' });
  assert.equal(old.closed, true);
  f.event([delta('ANTHROPICUSDT', '99')], {}, old); assert.equal(f.snapshots.length, count);
  unwatch();
  f.permission = permissions();
  const replacement = { ...credentials, apiSecret: 'replacement_only_secret' };
  f.watch(['ANTHROPICUSDT'], {}, replacement); await f.client.anthropicPositions(replacement);
  assert.equal(f.sockets.length, 2);
  f.event([delta('ANTHROPICUSDT', '98')], {}, old);
  assert.equal(f.snapshots.at(-1).positions[0].quantity, '2');
  f.advance(1); f.event([delta('ANTHROPICUSDT', '4')]); assert.equal(f.snapshots.at(-1).positions[0].quantity, '4');
});

test('coalesced permissions isolate caller cancellation and are checked again on the next read', async t => {
  const f = fixture(t), gate = deferred(), entered = deferred();
  f.permissionHook = async () => { entered.resolve(); await gate.promise; };
  const controller = new AbortController();
  const first = f.client.positions(credentials, { signal: controller.signal }), second = f.client.anthropicPositions(credentials);
  await entered.promise; controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  gate.resolve(); assert.equal((await second).positions.length, 1);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('apiRestrictions')).length, 1);
  f.permissionHook = null; await f.client.anthropicPositions(credentials);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('apiRestrictions')).length, 2);
});

test('real trading manager publishes Anthropic deltas immediately and rejects callbacks from an old account revision', async t => {
  const f = fixture(t, 'portfolio-margin'), db = new DatabaseSync(':memory:');
  const manager = createTrading({ db, encrypt: JSON.stringify, decrypt: JSON.parse, now: f.now, intervalMs: 0,
    clientFactory: exchange => exchange === 'binance' ? f.client : {} });
  t.after(async () => { await manager.close(); db.close(); });
  await manager.connect('binance', { revision: 0, accountMode: 'portfolio-margin', ...credentials });
  await manager.refresh(); await nextTurn();
  assert.equal(manager.anthropic()[0].positions[0].quantity, '2');
  const old = f.sockets[0], calls = f.calls.length;
  f.advance(1000); f.event([delta('ANTHROPICUSDT', '7')]);
  const updated = manager.anthropic()[0];
  assert.equal(updated.positions[0].quantity, '7'); assert.equal(updated.positions[0].riskFetchedAt, null);
  assert.equal(updated.fetchedAt, new Date(NOW).toISOString()); assert.equal(f.calls.length, calls);
  const persisted = JSON.parse(db.prepare("SELECT snapshot FROM trading_accounts WHERE exchange='binance'").get().snapshot);
  assert.equal(persisted.anthropic.rows[0].quantity, '7');
  manager.disconnect('binance', 1); assert.equal(old.closed, true);
  f.event([delta('ANTHROPICUSDT', '99')], {}, old);
  assert.equal(manager.anthropic()[0].connected, false); assert.deepEqual(manager.anthropic()[0].positions, []);
  await manager.connect('binance', { revision: 2, accountMode: 'portfolio-margin', ...credentials, apiSecret: 'replacement_only_secret' });
  await manager.refresh(); await nextTurn();
  f.event([delta('ANTHROPICUSDT', '98')], {}, old);
  assert.equal(manager.anthropic()[0].positions[0].quantity, '2');
  await manager.close(); assert.ok(f.sockets.every(socket => socket.closed));
});

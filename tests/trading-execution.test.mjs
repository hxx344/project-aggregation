import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { normalizeIntent, splitQuantity } from '../server/trading-execution-plan.mjs';

const baseTime = Date.UTC(2026, 9, 7, 10);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const intent = (overrides = {}) => ({ preset: 'cross-exchange', action: 'open', legs: [
  { exchange: 'binance', symbol: 'CLUSDT', side: 'long', quantity: '2', stopPrice: '90' },
  { exchange: 'bybit', symbol: 'CLUSDT', side: 'short', quantity: '2', stopPrice: '50' },
], batchCount: 2, batchIntervalMs: 1000, repriceIntervalMs: 1000, timeoutMs: 60_000, ...overrides });

async function fixture(t, options = {}) {
  const { guarded = false, ...executionOptions } = options;
  const db = new DatabaseSync(':memory:');
  let time = baseTime, serial = 0, instance;
  const directory = guarded ? mkdtempSync(join(tmpdir(), 'native-writer-')) : null;
  const writer = guarded ? createAccountWriter({ databasePath: join(directory, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: randomUUID(), now: () => time }) : null;
  const records = new Map(), calls = [], handlers = {}, markets = {};
  const accounts = Object.fromEntries(['binance', 'bybit', 'okx'].map((exchange, index) => [exchange, { identity: guarded ? String(index + 1) : exchange === 'binance' ? null : 'fixture-uid', modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] }]));
  const market = symbol => ({ symbol, bid: '70', ask: '70.01', at: new Date(time).toISOString(), rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } });
  const factory = exchange => Object.fromEntries(['verify', 'account', 'market', 'create', 'amend', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity };
    if (method === 'account') return structuredClone(accounts[exchange]);
    if (method === 'market') { const value = market(args[0]); return { ...value, ...(exchange === 'okx' ? { rule: { ...value.rule, quantityStep: '1', minQuantity: '1', contractSize: args[0] === 'CLUSDT' ? '0.1' : '0.01', instrumentId: args[0] === 'CLUSDT' ? 'CL-USDT-SWAP' : 'BZ-USDT-SWAP', quantityUnit: '张', minNotional: '0' } } : {}), ...markets[exchange] }; }
    const spec = args[1];
    if (method === 'create') {
      if (guarded) args[2].beforeMutation();
      const id = String(++serial), record = { ...spec, id, kind: exchange === 'bybit' ? 'strategy' : 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '70', averagePrice: null, createdAt: new Date(time).toISOString() };
      records.set(id, record); return { id, kind: record.kind };
    }
    const record = spec.id ? records.get(spec.id) : [...records.values()].find(item => item.clientId === spec.clientId);
    if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
    if (method === 'inspect') return structuredClone(record);
    if (method === 'amend') {
      args[2].beforeMutation();
      assert.ok(['binance', 'okx'].includes(exchange)); assert.equal(spec.quantity, record.quantity);
      record.price = (markets[exchange] ?? market(spec.symbol))[spec.side === 'buy' ? 'bid' : 'ask'];
      return structuredClone(record);
    }
    if (method === 'stop') { if (guarded) args[2].beforeMutation(); Object.assign(record, { status: 'terminal', terminal: true, childrenSettled: true }); }
  }]));
  const create = (overrides = {}) => createTradingExecution({ db, stmt: null, now: () => time, intervalMs: 0, encrypt: value => JSON.stringify(value), decrypt: JSON.parse, clientFactory: factory, accountWriter: writer, ...executionOptions, ...overrides });
  instance = create();
  t.after(async () => { await instance.close(); writer?.close(); db.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  await instance.initializeProtection();
  for (const exchange of ['binance', 'bybit', 'okx']) await instance.connect(exchange, { revision: 0, accountMode: exchange === 'binance' ? 'standard' : exchange === 'okx' ? 'cross' : 'unified', apiKey: 'fixture_key', apiSecret: 'fixture_secret', ...(exchange === 'okx' ? { passphrase: 'fixture_private_passphrase' } : {}) });
  return { db, writer, directory, records, calls, accounts, handlers, markets, create, get service() { return instance; }, set service(value) { instance = value; }, get time() { return time; }, advance(value) { time += value; },
    async preview(body = intent(), session = 'session-a') { return instance.preview(body, session); },
    start(preview, requestId = randomUUID(), session = 'session-a') { return instance.start({ previewId: preview.id, requestId, confirmLive: true }, session); },
    get creates() { return calls.filter(call => call.method === 'create'); },
    get job() { return instance.state().jobs[0]; },
    fill(id, quantity) { const record = records.get(id); Object.assign(record, { filledQuantity: quantity ?? record.quantity, terminal: true, childrenSettled: true, status: 'terminal' }); },
  };
}

test('exact decimal split conserves very large and fractional quantities', () => {
  assert.deepEqual(splitQuantity('1.000000000000000003', 2, '0.000000000000000001'), ['0.500000000000000002', '0.500000000000000001']);
  assert.deepEqual(splitQuantity('9007199254740993', 2, '1'), ['4503599627370497', '4503599627370496']);
  assert.throws(() => splitQuantity('0.003', 4, '0.001'));
  assert.throws(() => normalizeIntent({ ...intent(), orderType: 'MARKET' }));
  assert.throws(() => normalizeIntent(intent({ legs: intent().legs.map(leg => ({ ...leg, side: 'long' })) })));
});

test('managed native execution claims the full account vector before any leg and cannot take a Greeks UID', async t => {
  const f = await fixture(t, { guarded: true });
  const greeks = createAccountWriter({ databasePath: join(f.directory, 'execution-control.sqlite'), moduleId: 'greeks', runtimeId: randomUUID(), now: () => f.time });
  t.after(() => greeks.close());
  const identity = { authority: 'bybit', environment: 'mainnet', accountId: '2' };
  greeks.bind('greeks', identity, 1); greeks.claim([identity]);
  const preview = await f.preview();
  assert.throws(() => f.start(preview), /其他模块|所有权/);
  assert.equal(f.creates.length, 0);
  assert.equal(f.writer.snapshot().accounts.some(row => row.moduleId === 'hub'), false);
  greeks.close();
});

test('managed native four-leg siblings share one preflight and all final sends use operation tickets', async t => {
  const f = await fixture(t, { guarded: true });
  const four = intent({ preset: 'four-leg', batchCount: 1, legs: [...intent().legs,
    { exchange: 'binance', symbol: 'BZUSDT', side: 'short', quantity: '2', stopPrice: '50' },
    { exchange: 'bybit', symbol: 'BZUSDT', side: 'long', quantity: '2', stopPrice: '90' }] });
  f.start(await f.preview(four)); await f.service.tick();
  assert.equal(f.creates.length, 4); assert.equal(f.records.size, 4);
  assert.deepEqual(f.writer.snapshot().operations, [{ moduleId: 'hub', state: 'confirmed', count: 4 }]);
});

test('managed missing UID remains readable and cannot submit or unblock another module in the same scope', async t => {
  const f = await fixture(t, { guarded: true });
  f.accounts.bybit.identity = null;
  await f.service.connect('bybit', { revision: 1, accountMode: 'unified', apiKey: 'replacement_key', apiSecret: 'replacement_secret' });
  assert.equal(f.service.state().connections.find(row => row.exchange === 'bybit').writeProtection.identityVerified, false);
  const preview = await f.preview();
  assert.throws(() => f.start(preview), /真实身份/); assert.equal(f.creates.length, 0);
  const greeks = createAccountWriter({ databasePath: join(f.directory, 'execution-control.sqlite'), moduleId: 'greeks', runtimeId: randomUUID(), now: () => f.time });
  t.after(() => greeks.close());
  const identity = { authority: 'bybit', environment: 'mainnet', accountId: '2' };
  greeks.bind('greeks', identity, 1);
  assert.throws(() => greeks.claim([identity]), { code: 'UNVERIFIED_BINDING' });
  greeks.close();
});

test('managed reconnect cannot discard a shared orphan operation even when no local job locks the connection', async t => {
  const f = await fixture(t, { guarded: true });
  const identity = { authority: 'bybit', environment: 'mainnet', accountId: '2' }, ticket = f.writer.claim([identity]);
  f.writer.prepare(ticket, 'hub:orphan', { action: 'create', clientId: 'original' });
  f.accounts.bybit.identity = '200';
  await assert.rejects(f.service.connect('bybit', { revision: 1, accountMode: 'unified', apiKey: 'replacement_key', apiSecret: 'replacement_secret' }), /原账户/);
  assert.equal(f.service.state().connections.find(row => row.exchange === 'bybit').identity, '2');
  assert.equal(f.service.state().connections.find(row => row.exchange === 'bybit').revision, 1);
  assert.throws(() => f.service.disconnect('bybit', { revision: 1 }), { code: 'BINDING_UNRESOLVED' });
});

test('managed final transport rejects a changed binding, preserves the durable intent and accepts a local stop', async t => {
  const f = await fixture(t, { guarded: true }), entered = deferred(), release = deferred();
  let sent = false;
  f.handlers['binance:create'] = async (_credentials, _spec, options) => { entered.resolve(); await release.promise; options.beforeMutation(); sent = true; return { id: 'late-id', kind: 'order' }; };
  f.start(await f.preview(intent({ batchCount: 1 })));
  const running = f.service.tick(); await entered.promise;
  f.writer.bind('hub:binance', { authority: 'binance', environment: 'mainnet', accountId: '1' }, 2);
  release.resolve(); await running;
  assert.equal(sent, false);
  const local = f.db.prepare('SELECT json FROM execution_orders').all().map(row => JSON.parse(row.json)).find(row => row.exchange === 'binance');
  assert.equal(local.remoteId, null); assert.equal(local.writerOperation.state, 'sending');
  assert.equal(f.service.stop(f.job.id, {}).jobs[0].stopRequested, true);
});

test('managed stop accepted after the account writer retires still ends stopped after restart', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  assert.equal(f.creates.length, 2);
  f.writer.retired = true; // As after a heartbeat LEASE_EXPIRED: no further account write is admitted.
  const accepted = f.service.stop(f.job.id, {}).jobs[0];
  assert.equal(accepted.stopRequested, true); assert.equal(accepted.status, 'running');
  assert.ok(f.service.state().connections.every(row => /所有权已失效/.test(row.writeProtection.reason)));
  await f.service.close(); f.writer.close();
  const writer = createAccountWriter({ databasePath: join(f.directory, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: randomUUID(), now: () => f.time });
  try {
    f.service = f.create({ accountWriter: writer }); await f.service.initializeProtection(); await f.service.tick();
    assert.equal(f.job.status, 'stopped');
    assert.ok(f.service.state().connections.every(row => !/所有权已失效/.test(row.writeProtection.reason ?? '')));
    assert.equal(f.creates.length, 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM execution_locks').get().count, 0);
  } finally { await f.service.close(); writer.close(); }
});

test('managed unknown native amendment permits only cancellation of the verified original order', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:amend'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('lost_ack', { uncertain: true }); };
  f.markets.binance = { bid: '71', ask: '71.01' }; f.advance(1000); await f.service.tick();
  assert.equal(f.calls.filter(call => call.method === 'amend').length, 1);
  assert.equal(f.records.size, 2); assert.ok([...f.records.values()].every(row => row.terminal));
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
  assert.equal(f.job.status, 'paused');
});

test('managed restart resolves a crash after durable ACK or unsent evidence without replay', async t => {
  for (const outcome of ['confirmed', 'prepared']) {
    const f = await fixture(t, { guarded: true });
    f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
    const job = JSON.parse(f.db.prepare('SELECT json FROM execution_jobs').get().json); job.status = 'attention';
    f.db.prepare('UPDATE execution_jobs SET json=? WHERE id=?').run(JSON.stringify(job), job.id);
    const row = f.db.prepare('SELECT json FROM execution_orders').get(), order = JSON.parse(row.json);
    order.writerOperation.state = outcome; order.writerDispatch = outcome;
    f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
    const shared = new DatabaseSync(join(f.directory, 'execution-control.sqlite'));
    shared.prepare("UPDATE aw_operations SET state='sending' WHERE operation_id=?").run(order.writerOperation.operationId); shared.close();
    await f.service.close(); f.service = f.create(); await f.service.initializeProtection();
    assert.equal(f.creates.length, 2);
    assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
    const restored = JSON.parse(f.db.prepare('SELECT json FROM execution_orders WHERE id=?').get(order.localId).json);
    if (outcome === 'prepared') { assert.equal(restored.state, 'rejected'); assert.equal(restored.settled, true); }
    else assert.equal(restored.remoteId, order.remoteId);
  }
});

test('managed missing credentials with legacy unresolved orders retain an unverified scope binding', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview()); await f.service.tick();
  const job = JSON.parse(f.db.prepare('SELECT json FROM execution_jobs').get().json); job.status = 'attention';
  f.db.prepare('UPDATE execution_jobs SET json=? WHERE id=?').run(JSON.stringify(job), job.id);
  f.db.prepare("UPDATE execution_accounts SET credentials=NULL WHERE exchange='bybit'").run();
  await f.service.close(); f.service = f.create(); await f.service.initializeProtection();
  assert.equal(f.writer.snapshot().bindings.some(row => row.authority === 'bybit' && !row.verified), true);
  const greeks = createAccountWriter({ databasePath: join(f.directory, 'execution-control.sqlite'), moduleId: 'greeks', runtimeId: randomUUID(), now: () => f.time });
  t.after(() => greeks.close());
  const identity = { authority: 'bybit', environment: 'mainnet', accountId: '2' }; greeks.bind('g', identity, 1);
  assert.throws(() => greeks.claim([identity]), { code: 'UNVERIFIED_BINDING' });
  greeks.close();
});

test('managed shared prepare followed by private sending-save failure retains and settles its original intent', async t => {
  const f = await fixture(t, { guarded: true }), prepare = f.db.prepare.bind(f.db);
  let injected = false;
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO execution_orders')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => {
        const value = JSON.parse(args[2]);
        if (!injected && value.exchange === 'binance' && value.writerDispatch === 'sending') { injected = true; throw new Error('SQLITE_IOERR'); }
        return run(...args);
      };
    }
    return statement;
  };
  f.start(await f.preview()); await f.service.tick(); f.db.prepare = prepare;
  assert.equal(injected, true); assert.equal(f.creates.length, 0);
  const local = JSON.parse(f.db.prepare('SELECT json FROM execution_orders').get().json);
  assert.equal(local.writerOperation.state, 'rejected'); assert.equal(local.settled, true);
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
  await f.service.close(); f.service = f.create(); await f.service.initializeProtection();
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.doesNotThrow(() => f.service.disconnect('binance', { revision: 1 }));
});

test('managed OKX unknown amendment can cancel an exactly identified system-trimmed original or after a failed read', async t => {
  for (const failedRead of [false, true]) {
    const f = await fixture(t, { guarded: true });
    f.accounts.okx.positions = [{ symbol: 'CLUSDT', side: 'long', quantity: '20' }];
    f.accounts.bybit.positions = [{ symbol: 'CLUSDT', side: 'short', quantity: '2' }];
    const body = intent({ action: 'close', batchCount: 1, legs: intent().legs.map(leg => ({ ...leg,
      ...(leg.exchange === 'binance' ? { exchange: 'okx', quantity: '20' } : {}), stopPrice: leg.side === 'long' ? '50' : '90' })) });
    f.start(await f.preview(body)); await f.service.tick();
    const original = [...f.records.values()].find(row => row.kind === 'order');
    f.handlers['okx:amend'] = async (_credentials, _spec, options) => {
      options.beforeMutation(); original.quantity = '19';
      if (failedRead) f.handlers['okx:inspect'] = async () => { throw new Error('read unavailable'); };
      throw new ExecutionExchangeError('lost_ack', { uncertain: true });
    };
    f.markets.okx = { bid: '71', ask: '71.01' }; f.advance(1000); await f.service.tick();
    assert.equal(f.calls.filter(call => call.exchange === 'okx' && call.method === 'stop').length, 1);
    assert.equal(original.terminal, true); assert.equal(f.creates.length, 2);
    if (!failedRead) {
      assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
      assert.equal(f.job.status, 'paused');
    }
  }
});

test('preview/read endpoints do not order; session-bound and one-use preview is idempotent by request ID', async t => {
  const f = await fixture(t), preview = await f.preview(), requestId = randomUUID();
  f.service.state(); assert.equal(f.creates.length, 0);
  assert.throws(() => f.start(preview, requestId, 'other-session'), /过期|提交/);
  f.start(preview, requestId); const id = f.job.id;
  f.start(preview, requestId); assert.equal(f.job.id, id);
  assert.equal(f.service.state().jobs.length, 1); assert.equal(f.creates.length, 0);
  assert.throws(() => f.start(preview), /过期|提交/);
  assert.throws(() => f.service.disconnect('binance', { revision: 1 }), /未结束任务/);
});

test('four-leg preset validates opposite directions and auto-splits to a shared exchange quantity cap', async t => {
  const f = await fixture(t);
  const four = intent({ preset: 'four-leg', batchCount: 1, legs: [...intent().legs, { exchange: 'binance', symbol: 'BZUSDT', side: 'short', quantity: '2', stopPrice: '50' }, { exchange: 'bybit', symbol: 'BZUSDT', side: 'long', quantity: '2', stopPrice: '90' }] });
  f.markets.binance = { rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '0.7', minNotional: '5', maxNotional: null } };
  const preview = await f.preview(four); assert.equal(preview.batchCount, 3);
  for (const leg of preview.legs) assert.deepEqual(leg.batchQuantities, ['0.667', '0.667', '0.666']);
  f.start(preview); await f.service.tick(); assert.equal(f.creates.length, 4);
  assert.equal(f.job.legs.length, 4);
});

test('every two-exchange four-leg combination uses native quantities and OKX contract notionals', async t => {
  for (const pair of [['binance', 'bybit'], ['binance', 'okx'], ['bybit', 'okx']]) {
    const f = await fixture(t);
    const body = intent({ preset: 'four-leg', batchCount: 1, legs: pair.flatMap((exchange, index) => ['CLUSDT', 'BZUSDT'].map((symbol, oil) => {
      const side = index === oil ? 'long' : 'short';
      return { exchange, symbol, side, quantity: exchange === 'okx' ? (oil ? '200' : '20') : '2', stopPrice: side === 'long' ? '90' : '50' };
    })) });
    const preview = await f.preview(body);
    assert.equal(preview.legs.length, 4); assert.deepEqual([...new Set(preview.legs.map(leg => leg.exchange))], pair);
    for (const leg of preview.legs.filter(leg => leg.exchange === 'okx')) {
      assert.equal(leg.rule.quantityUnit, '张'); assert.equal(leg.estimatedNotional, leg.orderSide === 'buy' ? '140' : '140.02');
      assert.equal(leg.rule.contractSize, leg.symbol === 'CLUSDT' ? '0.1' : '0.01');
    }
    f.start(preview); await f.service.tick(); assert.equal(f.creates.length, 4);
    for (const call of f.creates.filter(call => call.exchange === 'okx')) assert.ok(call.args[1].contractSize && call.args[1].instrumentId);
  }
  const mixed = intent({ preset: 'four-leg', legs: [...intent().legs, { exchange: 'okx', symbol: 'CLUSDT', side: 'long', quantity: '20', stopPrice: '90' }, { exchange: 'okx', symbol: 'BZUSDT', side: 'short', quantity: '200', stopPrice: '50' }] });
  assert.throws(() => normalizeIntent(mixed), /两个不同/);
});

test('OKX native amendment retains original identity and total after partial fills', async t => {
  const f = await fixture(t);
  const body = intent({ batchCount: 1, legs: intent().legs.map(leg => leg.exchange === 'binance' ? { ...leg, exchange: 'okx', quantity: '20' } : leg) });
  f.start(await f.preview(body)); await f.service.tick();
  const order = [...f.records.values()].find(row => row.kind === 'order'); order.filledQuantity = '5';
  f.markets.okx = { bid: '71', ask: '71.01' }; f.advance(1000); await f.service.tick();
  const amendments = f.calls.filter(call => call.method === 'amend');
  assert.equal(amendments.length, 1); assert.equal(amendments[0].exchange, 'okx');
  assert.equal(amendments[0].args[1].id, order.id); assert.equal(amendments[0].args[1].quantity, '20');
  assert.equal(f.creates.length, 2); assert.equal(f.job.legs.find(leg => leg.exchange === 'okx').filledQuantity, '5');
  for (const row of f.records.values()) f.fill(row.id);
  await f.service.tick(); assert.equal(f.job.status, 'completed');
});

test('changed OKX contract multiplier blocks all submission and max notional applies per contract size', async t => {
  const f = await fixture(t);
  const body = intent({ batchCount: 1, legs: intent().legs.map(leg => leg.exchange === 'binance' ? { ...leg, exchange: 'okx', quantity: '20' } : leg) });
  const preview = await f.preview(body), leg = preview.legs.find(leg => leg.exchange === 'okx');
  f.markets.okx = { rule: { ...leg.rule, maxNotional: '141' } };
  assert.equal((await f.preview(body)).legs.find(leg => leg.exchange === 'okx').estimatedNotional, '140');
  f.markets.okx.rule.maxNotional = '139'; await assert.rejects(f.preview(body), /名义金额/);
  f.markets.okx.rule = { ...leg.rule, contractSize: '0.2' };
  f.start(preview); await f.service.tick();
  assert.equal(f.creates.length, 0); assert.equal(f.job.status, 'paused'); assert.match(f.job.reason, /乘数/);
});

test('batch barrier waits for all legs and all native children, then starts next batch after interval', async t => {
  const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
  assert.equal(f.creates.length, 2); assert.equal(f.job.batchIndex, 0);
  const [a, b] = [...f.records.values()];
  f.fill(a.id); Object.assign(b, { filledQuantity: '1' });
  await f.service.tick(); assert.equal(f.creates.length, 2); assert.equal(f.job.batchIndex, 0);
  f.fill(b.id); await f.service.tick(); assert.equal(f.job.batchIndex, 1);
  await f.service.tick(); assert.equal(f.creates.length, 2);
  f.advance(1000); await f.service.tick(); assert.equal(f.creates.length, 4);
  for (const record of f.records.values()) f.fill(record.id);
  await f.service.tick(); assert.equal(f.job.status, 'completed');
  assert.deepEqual(f.job.legs.map(leg => leg.filledQuantity), ['2', '2']);
  assert.ok(f.service.state().connections.every(connection => !connection.locked));
});

test('partial Binance fills use native amendments on the same order and original total quantity', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const binance = [...f.records.values()].find(record => record.kind === 'order'); binance.filledQuantity = '0.75';
  f.markets.binance = { bid: '71', ask: '71.01' };
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates.length, 2); assert.equal(f.job.legs[0].currentOrder.id, binance.id);
  assert.equal(f.calls.filter(call => call.method === 'stop').length, 0);
  let amendments = f.calls.filter(call => call.method === 'amend');
  assert.equal(amendments.length, 1); assert.equal(amendments[0].args[1].quantity, '2');
  assert.equal(amendments[0].args[1].id, binance.id); assert.equal(amendments[0].args[1].clientId, binance.clientId);
  assert.equal(f.job.legs[0].filledQuantity, '0.75');
  f.markets.binance = { bid: '72', ask: '72.01' }; binance.filledQuantity = '1.25';
  f.advance(999); await f.service.tick(); assert.equal(f.calls.filter(call => call.method === 'amend').length, 1);
  f.advance(1); await f.service.tick(); amendments = f.calls.filter(call => call.method === 'amend');
  assert.equal(amendments.length, 2); assert.ok(amendments.every(call => call.args[1].quantity === '2' && call.args[1].id === binance.id));
  for (const record of f.records.values()) f.fill(record.id);
  await f.service.tick(); assert.equal(f.job.status, 'completed'); assert.equal(f.creates.length, 2);
  assert.deepEqual(f.job.legs.map(leg => leg.filledQuantity), ['2', '2']);
});

test('cancel ACK with still-active original order cannot authorize a replacement', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async () => {};
  f.service.stop(f.job.id, {}); await f.service.tick(); assert.equal(f.creates.length, 2); assert.equal(f.job.status, 'attention');
  f.advance(1000); await f.service.tick(); assert.equal(f.creates.length, 2);
});

test('one rejected leg stops all other legs, retains fills and requires preview for remaining quantity', async t => {
  const f = await fixture(t);
  f.handlers['bybit:create'] = async () => { throw new ExecutionExchangeError('rejected'); };
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.canResume, true); assert.equal(f.creates.length, 2);
  const binance = [...f.records.values()][0]; assert.equal(binance.terminal, true);
  delete f.handlers['bybit:create'];
  const preview = await f.preview({ resumeJobId: f.job.id }); f.start(preview); await f.service.tick();
  assert.equal(f.creates.length, 4); assert.equal(f.service.state().jobs.length, 1);
});

test('unknown native create never retries or guesses identity, and explicit ID must match', async t => {
  const f = await fixture(t);
  f.handlers['bybit:create'] = async (_credentials, spec) => {
    f.records.set('native-unknown', { ...spec, id: 'native-unknown', kind: 'strategy', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0.25', price: '70', createdAt: new Date(f.time).toISOString() });
    throw new ExecutionExchangeError('network', { uncertain: true });
  };
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  assert.equal(f.job.status, 'attention'); assert.equal(f.job.canResume, false);
  for (let i = 0; i < 3; i += 1) { f.advance(1000); await f.service.tick(); }
  assert.equal(f.creates.length, 2);
  const leg = f.job.legs.find(row => row.exchange === 'bybit');
  assert.equal(leg.currentOrder.id, null);
  await assert.rejects(f.service.reconcile(f.job.id, { legId: leg.id, strategyId: 'native-unknown' }), /核对/);
  const record = f.records.get('native-unknown'); record.side = 'buy';
  await assert.rejects(f.service.reconcile(f.job.id, { legId: leg.id, strategyId: record.id, acknowledge: true }), /不一致/);
  record.side = 'sell';
  await f.service.reconcile(f.job.id, { legId: leg.id, strategyId: record.id, acknowledge: true });
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.legs.find(row => row.exchange === 'bybit').filledQuantity, '0.25');
  assert.equal(f.creates.length, 2);
});

test('ambiguous Binance create uses exact client ID query, never blind resubmission', async t => {
  const f = await fixture(t);
  f.handlers['binance:create'] = async (_credentials, spec) => {
    f.records.set('lookup-order', { ...spec, id: 'lookup-order', kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0.2', price: '70', createdAt: new Date(f.time).toISOString() });
    throw new ExecutionExchangeError('network', { uncertain: true });
  };
  f.start(await f.preview()); await f.service.tick();
  assert.equal(f.job.status, 'paused'); assert.equal(f.creates.length, 2);
  assert.equal(f.job.legs[0].filledQuantity, '0.2');
  assert.ok(f.calls.some(call => call.exchange === 'binance' && call.method === 'inspect' && call.args[1].id === null));
});

test('all legs are revalidated before submit: changed close position, stale quotes, external orders', async t => {
  for (const fault of ['position', 'quote', 'order']) {
    const f = await fixture(t);
    for (const exchange of ['binance', 'bybit']) f.accounts[exchange].positions = [{ symbol: 'CLUSDT', side: exchange === 'binance' ? 'long' : 'short', quantity: '2' }];
    const close = intent({ action: 'close', legs: intent().legs.map(leg => ({ ...leg, stopPrice: leg.side === 'long' ? '50' : '90' })) });
    f.start(await f.preview(close));
    if (fault === 'position') f.accounts.bybit.positions[0].quantity = '0.1';
    if (fault === 'quote') f.markets.bybit = { at: new Date(baseTime - 20_000).toISOString() };
    if (fault === 'order') f.accounts.bybit.openOrders.push({ id: 'external', symbol: 'CLUSDT' });
    await f.service.tick(); assert.equal(f.creates.length, 0, fault); assert.equal(f.job.status, 'paused', fault);
  }
});

test('stop during pending create persists the stop and cancels late ACK without another batch', async t => {
  const f = await fixture(t), arrived = deferred(), release = deferred();
  f.handlers['bybit:create'] = async (_credentials, spec) => {
    arrived.resolve(); await release.promise;
    f.records.set('late', { ...spec, id: 'late', kind: 'strategy', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0.4', price: '70', createdAt: new Date(f.time).toISOString() }); return { id: 'late', kind: 'strategy' };
  };
  f.start(await f.preview()); const running = f.service.tick(); await arrived.promise;
  f.service.stop(f.job.id, {}); release.resolve(); await running;
  assert.equal(f.job.status, 'stopped'); assert.equal(f.creates.length, 2);
  assert.equal(f.job.legs.find(leg => leg.exchange === 'bybit').filledQuantity, '0.4');
});

test('restart pauses durable unfinished jobs and does not automatically continue', async t => {
  const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
  // Simulate process disappearance by transferring the durable lease, not by closing.
  const old = f.service;
  f.db.prepare('UPDATE execution_lease SET expires=0').run();
  f.service = f.create();
  await f.service.tick(); assert.equal(f.job.status, 'paused'); assert.equal(f.creates.length, 2);
  await old.close(); assert.equal(f.job.status, 'paused');
  await f.service.tick(); assert.equal(f.creates.length, 2);
});

test('a late response from former lease owner cannot overwrite new owner reconciliation', async t => {
  const f = await fixture(t), arrived = deferred(), release = deferred();
  f.handlers['binance:create'] = async (_credentials, spec) => {
    f.records.set('lease-order', { ...spec, id: 'lease-order', kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0.5', price: '70', createdAt: new Date(f.time).toISOString() });
    arrived.resolve(); await release.promise; return { id: 'lease-order', kind: 'order' };
  };
  f.start(await f.preview()); const old = f.service, running = old.tick(); await arrived.promise;
  f.db.prepare('UPDATE execution_lease SET expires=0').run(); f.service = f.create(); await f.service.tick();
  const before = f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all();
  release.resolve(); await running; await old.close();
  assert.deepEqual(f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all(), before);
  assert.equal(f.job.legs[0].filledQuantity, '0.5'); assert.equal(f.creates.length, 2);
});

test('closing quantity uses explicit close intent; one-way opposite open is refused', async t => {
  const f = await fixture(t);
  f.accounts.binance.modes.CLUSDT = 'one-way'; f.accounts.binance.positions = [{ symbol: 'CLUSDT', side: 'short', quantity: '1' }];
  await assert.rejects(f.preview(), /反向仓位/);
  f.accounts.binance.modes.CLUSDT = 'hedge'; f.accounts.binance.positions = [{ symbol: 'CLUSDT', side: 'long', quantity: '2' }]; f.accounts.bybit.positions = [{ symbol: 'CLUSDT', side: 'short', quantity: '2' }];
  f.start(await f.preview(intent({ action: 'close', legs: intent().legs.map(leg => ({ ...leg, stopPrice: leg.side === 'long' ? '50' : '90' })) })));
  await f.service.tick(); assert.ok(f.creates.every(call => call.args[1].reduceOnly === true));
  assert.deepEqual(f.creates.map(call => call.args[1].positionSide), ['LONG', 'SHORT']);
});

test('stop or deadline while exchange prepares request prevents dispatch without an unknown order', async t => {
  for (const action of ['stop', 'deadline', 'stale']) {
    const f = await fixture(t), arrived = deferred(), release = deferred(); let dispatches = 0;
    f.handlers['bybit:create'] = async (_credentials, _spec, options) => {
      options.beforeMutation(); // Represents an explicitly rejected timestamp attempt.
      arrived.resolve(); await release.promise;
      options.beforeMutation(); dispatches += 1;
      throw new Error('Second dispatch should never occur');
    };
    f.start(await f.preview(intent({ timeoutMs: 30_000 }))); const pending = f.service.tick(); await arrived.promise;
    if (action === 'stop') f.service.stop(f.job.id, {});
    else f.advance(action === 'deadline' ? 30_001 : 10_001);
    release.resolve(); await pending;
    assert.equal(dispatches, 0, action);
    assert.equal(f.job.status, action === 'stop' ? 'stopped' : 'paused', action);
    assert.equal(f.job.legs.find(leg => leg.exchange === 'bybit').currentOrder.unknown, false, action);
  }
});

test('foreign orders with the same raw ID as another leg cannot be treated as owned', async t => {
  const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
  const [binance, bybit] = [...f.records.values()]; f.fill(binance.id); f.fill(bybit.id); await f.service.tick();
  f.accounts.binance.openOrders.push({ id: bybit.id, symbol: 'CLUSDT' });
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates.length, 2); assert.equal(f.job.status, 'paused');
});

test('expired preview and changed account connection require a fresh preview', async t => {
  const f = await fixture(t), old = await f.preview(); f.advance(30_001);
  assert.throws(() => f.start(old), /过期/);
  const fresh = await f.preview();
  f.service.disconnect('bybit', { revision: 1 });
  assert.throws(() => f.start(fresh), /连接已改变/); assert.equal(f.creates.length, 0);
});

test('stopping with a partial fill resumes only the remaining amount, excluding fully filled legs', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const [a, b] = [...f.records.values()]; f.fill(a.id); b.filledQuantity = '0.4';
  f.markets.bybit = { bid: '49.99', ask: '50' }; await f.service.tick();
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.legs[0].filledQuantity, '2');
  delete f.markets.bybit;
  const preview = await f.preview({ resumeJobId: f.job.id });
  assert.equal(preview.legs.length, 1); assert.equal(preview.legs[0].quantity, '1.6');
  f.start(preview); await f.service.tick();
  assert.equal(f.creates.length, 3); assert.equal(f.creates.at(-1).exchange, 'bybit'); assert.equal(f.creates.at(-1).args[1].quantity, '1.6');
  f.fill([...f.records.values()].at(-1).id); await f.service.tick(); assert.equal(f.job.status, 'completed');
  assert.deepEqual(f.job.legs.map(leg => leg.filledQuantity), ['2', '2']);
});

test('unknown or regressing fill information pauses instead of reducing recorded fills', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const first = [...f.records.values()][0]; first.filledQuantity = '0.5'; await f.service.tick();
  first.filledQuantity = '0.2'; await f.service.tick();
  assert.equal(f.job.status, 'attention'); assert.equal(f.job.legs[0].filledQuantity, '0.5');
  assert.equal(f.creates.length, 2);
});

test('lease transfer between a successful guard read and the database write cannot persist a stale ACK', async t => {
  const f = await fixture(t), arrived = deferred(), release = deferred();
  const prepare = f.db.prepare.bind(f.db); let transferAfterRead = false;
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql === 'SELECT * FROM execution_lease WHERE id=1') {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        if (transferAfterRead) { transferAfterRead = false; prepare('UPDATE execution_lease SET owner=?').run('new-owner'); }
        return row;
      };
    }
    return statement;
  };
  f.handlers['bybit:create'] = async () => { arrived.resolve(); await release.promise; transferAfterRead = true; return { id: 'late-after-guard', kind: 'strategy' }; };
  f.start(await f.preview()); const running = f.service.tick(); await arrived.promise;
  release.resolve(); await running;
  const order = f.job.legs.find(leg => leg.exchange === 'bybit').currentOrder;
  assert.equal(order.id, null); assert.equal(order.unknown, true);
  // The new owner can still recover the durable submission intent.
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM execution_orders').get().count, 2);
  f.db.prepare = prepare;
});

test('a former owner cannot reacquire a released lease and revive an earlier delayed ACK', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, { intervalMs: 1000 }), arrived = deferred(), release = deferred();
  f.handlers['binance:create'] = async (_credentials, spec) => {
    f.records.set('aba-order', { ...spec, id: 'aba-order', kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0.5', price: '70', createdAt: new Date(f.time).toISOString() });
    arrived.resolve(); await release.promise; return { id: 'aba-order', kind: 'order' };
  };
  f.start(await f.preview()); const old = f.service, running = old.tick(); await arrived.promise;
  f.db.prepare('UPDATE execution_lease SET expires=0').run();
  f.service = f.create(); await f.service.tick(); await f.service.close();
  const before = f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all();
  // The old heartbeat runs after the replacement has reconciled and exited.
  t.mock.timers.tick(1000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM execution_lease').get().count, 0);
  release.resolve(); await running;
  assert.deepEqual(f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all(), before);
  assert.equal(f.job.legs[0].filledQuantity, '0.5'); assert.equal(f.creates.length, 2);
  assert.throws(() => old.stop(f.job.id, {}), /重启服务/);
  await old.close();
});

test('unchanged same-side quote skips native amendments without resetting the order', async t => {
  const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
  f.advance(1000); await f.service.tick();
  assert.equal(f.calls.filter(call => call.method === 'amend').length, 0);
  assert.equal(f.calls.filter(call => call.method === 'stop').length, 0); assert.equal(f.creates.length, 2);
});

test('a native GTX cancellation pauses immediately without creating another order', async t => {
  const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
  const binance = [...f.records.values()].find(record => record.kind === 'order');
  f.handlers['binance:amend'] = async (_credentials, spec, options) => {
    options.beforeMutation(); assert.equal(spec.quantity, '1');
    Object.assign(binance, { status: 'terminal', terminal: true, childrenSettled: true, filledQuantity: '0.3' });
    return structuredClone(binance);
  };
  f.markets.binance = { bid: '71', ask: '71.01' }; f.advance(1000); await f.service.tick();
  assert.equal(f.job.status, 'paused'); assert.equal(f.creates.length, 2); assert.equal(f.job.legs[0].filledQuantity, '0.3');
  await f.service.tick(); assert.equal(f.creates.length, 2);
});

test('rejected, uncertain and malformed amendments reconcile the original instead of marking it rejected', async t => {
  for (const failure of ['rejected', 'timeout', 'malformed']) {
    const f = await fixture(t); f.start(await f.preview()); await f.service.tick();
    const binance = [...f.records.values()].find(record => record.kind === 'order');
    f.handlers['binance:amend'] = async (_credentials, _spec, options) => {
      options.beforeMutation(); binance.filledQuantity = '0.4';
      if (failure === 'malformed') return { ...binance, quantity: '9' };
      throw new ExecutionExchangeError(failure, { uncertain: failure === 'timeout' });
    };
    f.markets.binance = { bid: '71', ask: '71.01' }; f.advance(1000); await f.service.tick();
    assert.equal(f.job.status, 'paused', failure); assert.equal(f.creates.length, 2, failure);
    assert.equal(f.job.legs[0].filledQuantity, '0.4', failure); assert.equal(binance.terminal, true, failure);
    assert.equal(f.calls.filter(call => call.method === 'amend').length, 1, failure);
    assert.ok(f.calls.some(call => call.method === 'stop' && call.args[1].id === binance.id), failure);
  }
});

test('stop, deadline or stale market blocks a prepared native amendment and any timestamp retry', async t => {
  for (const action of ['stop', 'deadline', 'stale']) {
    const f = await fixture(t), arrived = deferred(), release = deferred(); let dispatches = 0;
    f.start(await f.preview(intent({ timeoutMs: 30_000 }))); await f.service.tick();
    f.handlers['binance:amend'] = async (_credentials, _spec, options) => {
      options.beforeMutation(); arrived.resolve(); await release.promise;
      options.beforeMutation(); dispatches += 1;
      throw new Error('Second dispatch must be blocked');
    };
    f.markets.binance = { bid: '71', ask: '71.01' }; f.advance(1000);
    const running = f.service.tick(); await arrived.promise;
    const pending = f.db.prepare('SELECT json FROM execution_orders').all().map(row => JSON.parse(row.json)).find(order => order.exchange === 'binance');
    assert.equal(pending.amendPending, true); assert.equal(pending.spec.quantity, '1');
    if (action === 'stop') f.service.stop(f.job.id, {}); else f.advance(action === 'deadline' ? 30_001 : 10_001);
    release.resolve(); await running;
    assert.equal(dispatches, 0, action); assert.equal(f.creates.length, 2, action);
    assert.equal(f.job.status, action === 'stop' ? 'stopped' : 'paused', action);
  }
});

test('restart reconciles an in-flight native amendment and ignores its former owner ACK', async t => {
  const f = await fixture(t), arrived = deferred(), release = deferred();
  f.start(await f.preview()); await f.service.tick();
  const binance = [...f.records.values()].find(record => record.kind === 'order');
  f.handlers['binance:amend'] = async (_credentials, _spec, options) => {
    options.beforeMutation(); binance.filledQuantity = '0.6'; arrived.resolve(); await release.promise;
    return { ...binance, filledQuantity: '0.1', status: 'working', terminal: false, childrenSettled: false };
  };
  f.markets.binance = { bid: '71', ask: '71.01' }; f.advance(1000);
  const old = f.service, running = old.tick(); await arrived.promise;
  f.db.prepare('UPDATE execution_lease SET expires=0').run(); f.service = f.create(); await f.service.tick();
  const before = f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all();
  release.resolve(); await running; await old.close();
  assert.deepEqual(f.db.prepare('SELECT json FROM execution_orders ORDER BY rowid').all(), before);
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.legs[0].filledQuantity, '0.6'); assert.equal(f.creates.length, 2);
});

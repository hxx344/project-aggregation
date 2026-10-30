import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { createExecutionExchangeClient, ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';
import { createOkxExecutionClient } from '../server/trading-okx-execution.mjs';
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
  const factory = exchange => Object.fromEntries(['verify', 'account', 'endedStrategies', 'market', 'create', 'amend', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity };
    if (method === 'endedStrategies') return [];
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

test('OKX amendments sent through the real adapter never reuse a reqId after a rebuild, and a stale ACK leaves the result unknown', async t => {
  const f = await fixture(t, { guarded: true });
  const body = intent({ batchCount: 1, legs: intent().legs.map(leg => leg.exchange === 'binance' ? { ...leg, exchange: 'okx', quantity: '20' } : leg) });
  f.start(await f.preview(body)); await f.service.tick();
  const record = [...f.records.values()].find(row => row.kind === 'order'), sent = [];
  let staleAck = null;
  // Real OKX adapter; only HTTP is replaced. Its order rows mirror the fixture record.
  const adapter = () => createOkxExecutionClient({ ErrorClass: ExecutionExchangeError, now: () => f.time, fetchImpl: async (url, init) => {
    const parsed = new URL(url), parameters = init.body === undefined ? Object.fromEntries(parsed.searchParams) : JSON.parse(init.body);
    const nativeId = 'ox' + createHash('sha256').update(record.clientId).digest('hex').slice(0, 30);
    let data;
    if (parsed.pathname === '/api/v5/public/instruments') data = [{ instId: 'CL-USDT-SWAP', instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', ctValCcy: 'CL', ctVal: '0.1', ctMult: '1', baseCcy: '', quoteCcy: '', tickSz: '0.01', lotSz: '1', minSz: '1', maxLmtSz: '100000000', maxLmtAmt: '20000000' }];
    else if (parsed.pathname === '/api/v5/market/books') data = [{ bids: [[f.markets.okx.bid, '10', '0', '2']], asks: [[f.markets.okx.ask, '10', '0', '2']], ts: String(f.time) }];
    else if (parsed.pathname === '/api/v5/trade/order' && init.method === 'GET') data = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', ordId: record.id, clOrdId: nativeId, ordType: 'post_only', state: 'live', tdMode: 'cross', posSide: 'long', side: 'buy', reduceOnly: 'false', sz: record.quantity, accFillSz: record.filledQuantity, px: record.price, avgPx: '', cTime: String(f.time), ccy: 'USDT', algoId: '', attachAlgoOrds: [] }];
    else if (parsed.pathname === '/api/v5/trade/amend-order') {
      sent.push(parameters); record.price = parameters.newPx;
      data = [{ ordId: record.id, clOrdId: parameters.clOrdId, reqId: staleAck ?? parameters.reqId, sCode: '0' }];
    } else throw new Error(`Unhandled fixture route ${parsed.pathname}`);
    return new Response(JSON.stringify({ code: '0', data }), { status: 200 });
  } });
  let okx = adapter();
  f.handlers['okx:amend'] = (...args) => okx.amend(...args);
  // 71 → 72 → (adapter rebuilt) → 71: the returning price is a new intent.
  for (const [bid, rebuild] of [['71', false], ['72', false], ['71', true]]) {
    if (rebuild) okx = adapter();
    f.markets.okx = { bid, ask: '72.5' }; f.advance(1000); await f.service.tick();
  }
  assert.deepEqual(sent.map(row => row.newPx), ['71', '72', '71']);
  assert.equal(new Set(sent.map(row => row.reqId)).size, 3);
  assert.equal(f.job.status, 'running');
  // An ACK carrying an earlier reqId cannot confirm the next intent.
  staleAck = sent[0].reqId; okx = adapter();
  f.markets.okx = { bid: '72', ask: '72.5' }; f.advance(1000); await f.service.tick();
  assert.equal(sent.length, 4); assert.equal(new Set(sent.map(row => row.reqId)).size, 4);
  assert.equal(f.job.status, 'paused'); assert.equal(record.terminal, true);
  // The unknown amendment was settled only by cancelling the original; no new amendment or order.
  f.markets.okx = { bid: '73', ask: '73.5' }; f.advance(1000); await f.service.tick();
  assert.equal(sent.length, 4); assert.equal(f.creates.length, 2);
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
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

test('oil equal-barrel legs convert each venue contract size to native quantities', async t => {
  const f = await fixture(t);
  const legs = [['binance', 'CLUSDT', 'long'], ['binance', 'BZUSDT', 'short'], ['okx', 'CLUSDT', 'short'], ['okx', 'BZUSDT', 'long']]
    .map(([exchange, symbol, side]) => ({ exchange, symbol, side, stopPrice: side === 'long' ? '90' : '50' }));
  const preview = await f.preview(intent({ market: 'oil', preset: 'four-leg', batchCount: 1, equalSize: '2', legs }));
  assert.deepEqual(Object.fromEntries(preview.legs.map(leg => [leg.id, leg.quantity])),
    { 'binance:BZUSDT:short': '2', 'binance:CLUSDT:long': '2', 'okx:BZUSDT:long': '200', 'okx:CLUSDT:short': '20' });
  assert.match(preview.notes[0], /等桶配腿：每腿 2 桶/);
  await assert.rejects(f.preview(intent({ preset: 'four-leg', batchCount: 1, equalSize: '0.05', legs })), /0\.1 桶的整数倍/);
  assert.throws(() => normalizeIntent(intent({ equalSize: '2' })), /只能选择一种/);
  assert.throws(() => normalizeIntent(intent({ legs: intent().legs.map(({ quantity, ...leg }) => leg) })), /请填写每腿数量/);
});

test('SK hynix equal-notional legs size from the passive price and keep other symbols in the position snapshot', async t => {
  const f = await fixture(t);
  Object.assign(f.accounts.binance.modes, { SKHYUSDT: 'hedge', SKHYNIXUSDT: 'hedge' });
  f.handlers['binance:account'] = (credentials, options) => { const value = structuredClone(f.accounts.binance); value.positions = value.positions.filter(row => options.symbols.includes(row.symbol)); return value; };
  const prices = { CLUSDT: ['70', '70.01'], BZUSDT: ['70', '70.01'], SKHYUSDT: ['100', '100.01'], SKHYNIXUSDT: ['1000', '1000.1'] };
  f.handlers['binance:market'] = symbol => ({ symbol, bid: prices[symbol][0], ask: prices[symbol][1], at: new Date(f.time).toISOString(),
    rule: { tickSize: symbol === 'SKHYNIXUSDT' ? '0.1' : '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } });
  f.accounts.binance.positions = [{ symbol: 'CLUSDT', side: 'long', quantity: '2' }];
  await f.preview(intent({ preset: 'same-exchange', batchCount: 1, legs: [
    { exchange: 'binance', symbol: 'CLUSDT', side: 'long', quantity: '1', stopPrice: '90' },
    { exchange: 'binance', symbol: 'BZUSDT', side: 'short', quantity: '1', stopPrice: '50' }] }));
  f.advance(1000);
  const legs = [{ exchange: 'binance', symbol: 'SKHYUSDT', side: 'long', stopPrice: '110' }, { exchange: 'binance', symbol: 'SKHYNIXUSDT', side: 'short', stopPrice: '900' }];
  assert.throws(() => normalizeIntent(intent({ market: 'hynix', preset: 'same-exchange', equalSize: '10000', legs: [{ ...legs[0], symbol: 'CLUSDT' }, legs[1]] })), /合约、交易所或仓位方向无效/);
  const preview = await f.preview(intent({ market: 'hynix', preset: 'same-exchange', batchCount: 1, equalSize: '10000', legs }));
  assert.equal(preview.market, 'hynix');
  assert.deepEqual(preview.legs.map(leg => [leg.symbol, leg.quantity, leg.estimatedNotional]), [['SKHYNIXUSDT', '9.999', '9999.9999'], ['SKHYUSDT', '100', '10000']]);
  assert.match(preview.notes[0], /等金额配腿/);
  const positions = f.service.state().positions.filter(row => row.exchange === 'binance');
  assert.deepEqual(positions.map(row => [row.symbol, row.fetchedAt]), [['CLUSDT', new Date(baseTime).toISOString()]]);
  f.start(preview); await f.service.tick();
  assert.equal(f.job.market, 'hynix'); assert.deepEqual(f.creates.map(call => call.args[1].symbol).sort(), ['SKHYNIXUSDT', 'SKHYUSDT']);
});

test('unanswered Binance create that never reached the venue settles after the arrival window and releases the writer', async t => {
  const f = await fixture(t, { guarded: true });
  f.handlers['binance:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('timeout', { uncertain: true }); };
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const pendingCreate = () => f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state));
  const reads = () => f.calls.filter(call => call.exchange === 'binance' && call.method === 'account').length;
  // Within the 120 s observation window a missing client ID proves nothing.
  f.advance(50_000); await f.service.tick();
  assert.equal(f.job.status, 'attention'); assert.equal(pendingCreate(), true);
  f.advance(50_000); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  // A position that moved beyond known fills keeps the order unconfirmed.
  f.accounts.binance.positions = [{ symbol: 'CLUSDT', side: 'long', quantity: '2' }];
  f.advance(25_000); await f.service.tick();
  f.advance(15_000); await f.service.tick();
  assert.equal(f.job.status, 'attention'); assert.equal(pendingCreate(), true);
  assert.match(f.job.events.map(item => item.message).join('\n'), /仓位或挂单与已知成交不一致/);
  // A known mismatch is not re-read on every attention tick.
  const before = reads();
  f.accounts.binance.positions = []; f.accounts.binance.openOrders = [{ id: 'other', symbol: 'CLUSDT' }];
  f.advance(15_000); await f.service.tick();
  assert.equal(reads(), before);
  // Any other order on the symbol also keeps it unconfirmed.
  f.advance(50_000); await f.service.tick();
  assert.equal(reads(), before + 1); assert.equal(f.job.status, 'attention');
  f.accounts.binance.openOrders = [];
  f.advance(50_000); await f.service.tick(); f.advance(15_000); await f.service.tick();
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.canResume, true); assert.equal(pendingCreate(), false);
  assert.match(f.job.events.map(item => item.message).join('\n'), /判定未送达/);
  assert.equal(f.creates.length, 2);
  delete f.handlers['binance:create'];
  f.start(await f.preview({ resumeJobId: f.job.id })); await f.service.tick();
  assert.equal(f.creates.length, 4);
});

test('a cancel that leaves the order working is retried on attention ticks up to the attempt cap', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const stops = () => f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length;
  assert.equal(stops(), 1);
  for (let i = 0; i < 8; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(stops(), 5); assert.equal(f.job.status, 'attention'); assert.equal(f.creates.length, 2);
});

test('a rejected cancel is resent with spacing under the same attempt cap', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('rejected'); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const stops = () => f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length;
  for (let i = 0; i < 10; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(stops(), 5); assert.equal(f.job.status, 'attention');
});

test('without a shared writer a repeated cancel keeps the same attempt cap', async t => {
  const f = await fixture(t);
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async () => { throw new ExecutionExchangeError('rejected'); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  for (let i = 0; i < 10; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length, 5);
});

test('a cancel left sending by a crash is resent after restart', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const stops = () => f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length;
  const row = f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%'), order = JSON.parse(row.json);
  assert.equal(order.writerOperation.action, 'cancel');
  order.writerOperation.state = 'sending'; order.writerDispatch = 'sending';
  f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
  const shared = new DatabaseSync(join(f.directory, 'execution-control.sqlite'));
  shared.prepare("UPDATE aw_operations SET state='sending' WHERE operation_id=?").run(order.writerOperation.operationId); shared.close();
  await f.service.close(); f.service = f.create(); await f.service.initializeProtection();
  delete f.handlers['binance:stop'];
  f.advance(15_000); await f.service.tick();
  assert.equal(stops(), 2); assert.equal(f.job.status, 'stopped');
  assert.equal(f.writer.snapshot().operations.some(item => ['sending', 'unknown'].includes(item.state)), false);
});

test('a first cancel lost between sending and its timestamp is resent after restart', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  const stops = () => f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length;
  const row = f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%'), order = JSON.parse(row.json);
  order.writerOperation.state = 'sending'; order.writerDispatch = 'sending'; delete order.cancelRequestedAt; delete order.cancelSent;
  f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
  const shared = new DatabaseSync(join(f.directory, 'execution-control.sqlite'));
  shared.prepare("UPDATE aw_operations SET state='sending' WHERE operation_id=?").run(order.writerOperation.operationId); shared.close();
  await f.service.close(); f.service = f.create(); await f.service.initializeProtection();
  delete f.handlers['binance:stop'];
  await f.service.tick();
  assert.equal(stops(), 2); assert.equal(f.job.status, 'stopped');
});

test('a cancel the send guard refuses spends neither budget nor spacing', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  let posts = 0;
  const assertOwned = f.writer.assertOwned.bind(f.writer);
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => {
    f.writer.assertOwned = () => { throw new Error('lease moved'); };
    try { options.beforeMutation(); } finally { f.writer.assertOwned = assertOwned; }
    posts += 1;
  };
  f.service.stop(f.job.id, {}); await f.service.tick();
  const stored = () => JSON.parse(f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%').json);
  assert.equal(posts, 0); assert.equal(stored().cancelSent, 0); assert.ok(!stored().cancelRequestedAt);
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); posts += 1; };
  await f.service.tick();
  assert.equal(posts, 1); assert.equal(stored().cancelSent, 1);
});

test('an older cancel record without a send count keeps its original budget', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const posts = rejectBinanceCancels(f);
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(posts.length, 1);
  const row = f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%'), order = JSON.parse(row.json);
  order.cancelAttempt = 2; delete order.cancelSent; // Sequence 2: three requests already sent.
  f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
  await restart(f);
  for (let i = 0; i < 8; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(posts.length, 3);
});

test('a cancel retried after restart keeps the budget of a record without a send count', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  const row = f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%'), order = JSON.parse(row.json);
  order.writerOperation.state = 'sending'; order.writerDispatch = 'sending'; delete order.cancelSent; // One request sent, not yet counted.
  f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
  const shared = new DatabaseSync(join(f.directory, 'execution-control.sqlite'));
  shared.prepare("UPDATE aw_operations SET state='sending' WHERE operation_id=?").run(order.writerOperation.operationId); shared.close();
  const posts = rejectBinanceCancels(f);
  await restart(f);
  for (let i = 0; i < 8; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(posts.length, 4, 'the four requests left of the budget of five');
});

// Records the venue time of every Binance cancel that reached transport.
function rejectBinanceCancels(f) {
  const posts = [];
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation?.(); posts.push(f.time); throw new ExecutionExchangeError('rejected'); };
  return posts;
}
const restart = async f => { await f.service.close(); f.service = f.create(); await f.service.initializeProtection(); };
const spaced = posts => posts.slice(1).every((time, index) => time - posts[index] >= 10_000);
async function finishCancelledOriginal(f) {
  delete f.handlers['binance:stop'];
  const original = f.records.get(JSON.parse(f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%').json).remoteId);
  Object.assign(original, { status: 'terminal', terminal: true, childrenSettled: true });
  f.advance(15_000); await f.service.tick();
  assert.equal(f.job.status, 'stopped'); assert.equal(f.creates.length, 2);
  assert.deepEqual(f.accounts.binance.positions, []);
  assert.equal(f.writer?.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)) ?? false, false);
}

test('a rejected cancel restarted between attempts still gets five spaced POSTs', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const posts = rejectBinanceCancels(f);
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(posts.length, 1); assert.equal(f.job.status, 'attention');
  for (let i = 0; i < 8; i += 1) {
    // Recovering the rejected cancel neither burns a send nor drops the spacing.
    f.advance(1000); await restart(f); await f.service.tick();
    f.advance(15_000); await f.service.tick();
  }
  assert.equal(posts.length, 5); assert.ok(spaced(posts), posts.join(','));
  await finishCancelledOriginal(f);
});

test('a cancel prepared but never sent before a crash does not use up the cancel budget', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const posts = rejectBinanceCancels(f);
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(posts.length, 1);
  // The shared prepare succeeds, then every private write after `prepared`
  // fails, as if the process died before transport.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO execution_orders')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const value = JSON.parse(args[2]); if (value.writerOperation?.action === 'cancel' && value.writerOperation.state !== 'prepared') throw new Error('SQLITE_IOERR'); return run(...args); };
    }
    return statement;
  };
  f.advance(15_000); await f.service.tick(); f.db.prepare = prepare;
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%').json).writerDispatch, 'prepared');
  await restart(f); await f.service.tick();
  for (let i = 0; i < 8; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(posts.length, 5); assert.ok(spaced(posts), posts.join(','));
  await finishCancelledOriginal(f);
});

test('a cancel left sending by a crash counts once toward the cancel budget', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const posts = rejectBinanceCancels(f);
  f.service.stop(f.job.id, {}); await f.service.tick();
  f.advance(15_000); await f.service.tick();
  assert.equal(posts.length, 2);
  // The second request was in flight when the process stopped.
  const row = f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"binance"%'), order = JSON.parse(row.json);
  order.writerOperation.state = 'sending'; order.writerDispatch = 'sending';
  f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId);
  const shared = new DatabaseSync(join(f.directory, 'execution-control.sqlite'));
  shared.prepare("UPDATE aw_operations SET state='sending' WHERE operation_id=?").run(order.writerOperation.operationId); shared.close();
  f.advance(1000); await restart(f); await f.service.tick();
  assert.equal(posts.length, 2);
  for (let i = 0; i < 8; i += 1) { f.advance(15_000); await f.service.tick(); }
  assert.equal(posts.length, 5); assert.ok(spaced(posts), posts.join(','));
  await finishCancelledOriginal(f);
});

test('without a shared writer a rejected cancel gets five spaced POSTs and stops on the terminal original', async t => {
  const f = await fixture(t);
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const posts = rejectBinanceCancels(f);
  f.service.stop(f.job.id, {}); await f.service.tick();
  for (let i = 0; i < 20; i += 1) { f.advance(5000); await f.service.tick(); }
  assert.equal(posts.length, 5); assert.ok(spaced(posts), posts.join(','));
  await finishCancelledOriginal(f);
});

test('connecting reads only the oil symbols so another market cannot block it', async t => {
  const f = await fixture(t);
  const reads = f.calls.filter(call => call.method === 'account');
  assert.equal(reads.length, 3);
  for (const call of reads) assert.deepEqual(call.args[1].symbols, ['CLUSDT', 'BZUSDT']);
});

test('an uncertain cancel is retried once the order is still working and then stops the job', async t => {
  const f = await fixture(t, { guarded: true });
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('timeout', { uncertain: true }); };
  f.service.stop(f.job.id, {}); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  delete f.handlers['binance:stop'];
  f.advance(15_000); await f.service.tick();
  assert.equal(f.job.status, 'stopped');
  assert.equal(f.calls.filter(call => call.exchange === 'binance' && call.method === 'stop').length, 2);
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
});

test('Bybit strategy create without an answer can be confirmed absent only after the window and with no nearby strategy', async t => {
  const f = await fixture(t, { guarded: true });
  f.handlers['bybit:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('timeout', { uncertain: true }); };
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  assert.equal(f.job.status, 'attention');
  const bybit = f.job.legs.find(row => row.exchange === 'bybit'), binance = f.job.legs.find(row => row.exchange === 'binance');
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /仍可能送达/);
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true }), /确认未创建/);
  await assert.rejects(f.service.reconcile(f.job.id, { legId: binance.id, notCreated: true, acknowledge: true }), /没有待核对委托|确认未创建/);
  const createdAt = new Date(f.time).toISOString();
  f.advance(50_000); await f.service.tick(); f.advance(50_000); await f.service.tick();
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /仍可能送达/);
  f.advance(25_000); await f.service.tick();
  const strategy = { id: 'late', symbol: 'CLUSDT', side: 'sell', quantity: '2', filledQuantity: '0', status: 'terminal', reduceOnly: false, createdAt };
  f.accounts.bybit.strategies = [strategy];
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /策略编号/);
  // A venue clock 200 s ahead still places the strategy around the request.
  f.accounts.bybit.strategies = [{ ...strategy, createdAt: new Date(Date.parse(createdAt) + 200_000).toISOString() }];
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /下单时段前后/);
  // A live strategy blocks confirmation whatever its creation time.
  f.accounts.bybit.strategies = [{ ...strategy, status: 'running', createdAt: new Date(Date.parse(createdAt) - 3_600_000).toISOString() }];
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /运行中的追逐策略/);
  f.accounts.bybit.strategies = []; f.accounts.bybit.positions = [{ symbol: 'CLUSDT', side: 'short', quantity: '1' }];
  await assert.rejects(f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true }), /仓位或挂单与本任务已知成交不一致/);
  // A terminal strategy another Hub job already claimed does not block it.
  f.db.prepare('INSERT INTO execution_orders(id,job_id,json) VALUES (?,?,?)').run('earlier-order', 'earlier-job', JSON.stringify({ exchange: 'bybit', remoteId: 'earlier-strategy' }));
  f.accounts.bybit.positions = []; f.accounts.bybit.strategies = [{ ...strategy, id: 'earlier-strategy' }];
  await f.service.reconcile(f.job.id, { legId: bybit.id, notCreated: true, acknowledge: true });
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.canResume, true);
  assert.equal(f.writer.snapshot().operations.some(row => ['sending', 'unknown'].includes(row.state)), false);
  assert.equal(f.creates.length, 2);
});

test('Bybit not-created confirmation reads ended strategies near the request through the real adapter', async t => {
  const f = await fixture(t, { guarded: true });
  f.handlers['bybit:create'] = async (_credentials, _spec, options) => { options.beforeMutation(); throw new ExecutionExchangeError('timeout', { uncertain: true }); };
  f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const leg = f.job.legs.find(row => row.exchange === 'bybit'), created = f.time;
  for (const step of [50_000, 50_000, 25_000]) { f.advance(step); await f.service.tick(); }
  assert.equal(f.job.status, 'attention');
  // Real Bybit adapter; only HTTP is replaced. The venue keeps ended (status 3)
  // strategies out of the active buckets and filters them by creation time.
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const venue = { ended: [], shortQuantity: '0', ignoreWindow: false, endlessPages: false }, lists = [];
  const row = (n, time, status = 3) => ({ strategyId: id(n), category: 'UTA_USDT', symbol: 'CLUSDT', side: 'Sell', size: '2', executedSize: '0', strategyType: 'chaseOrder', status, reduceOnly: false, createdTimeE3: String(time), updatedTimeE3: String(time), chaseOrderPrice: '70', executedAvgPrice: '0' });
  const bybit = createExecutionExchangeClient('bybit', { now: () => f.time, fetchImpl: async url => {
    const parsed = new URL(url), query = Object.fromEntries(parsed.searchParams), path = parsed.pathname;
    let result;
    if (path === '/v5/user/query-api') result = { readOnly: 0, userID: '2', permissions: { ContractTrade: ['Order', 'Position'], Derivatives: ['DerivativesTrade'], Wallet: [], Spot: [], Options: [], Earn: [] } };
    else if (path === '/v5/account/info') result = { unifiedMarginStatus: 6 };
    else if (path === '/v5/position/list') result = { category: 'linear', list: [{ symbol: query.symbol, positionIdx: 1, side: '', size: '0' }, { symbol: query.symbol, positionIdx: 2, side: query.symbol === 'CLUSDT' && venue.shortQuantity !== '0' ? 'Sell' : '', size: query.symbol === 'CLUSDT' ? venue.shortQuantity : '0' }], nextPageCursor: '' };
    else if (path === '/v5/order/realtime') result = { category: 'linear', list: [], nextPageCursor: '' };
    else if (path === '/v5/strategy/list') {
      lists.push(query);
      if (query.status !== '3') result = { list: [], nextCursor: '' };
      else if (venue.endlessPages) result = { list: [row(90, created)], nextCursor: 'again' };
      else {
        if (query.startTime || query.endTime) throw new Error('Unsupported strategy time parameters');
        const stamp = item => Number(venue.filterByEnd ? item.endedAt : item.createdTimeE3);
        result = { list: venue.ended.filter(item => venue.ignoreWindow || stamp(item) >= Number(query.beginTimeE0) * 1000 && stamp(item) <= Number(query.endTimeE0) * 1000), nextCursor: '' };
      }
    } else throw new Error(`Unhandled fixture route ${path}`);
    return new Response(JSON.stringify({ retCode: 0, retMsg: 'OK', result }), { status: 200 });
  } });
  f.handlers['bybit:account'] = (...args) => bybit.account(...args);
  f.handlers['bybit:endedStrategies'] = (...args) => bybit.endedStrategies(...args);
  const confirm = () => f.service.reconcile(f.job.id, { legId: leg.id, notCreated: true, acknowledge: true });
  // A zero-fill strategy that ended right after the request blocks the confirmation.
  venue.ended = [row(1, created + 2000)];
  await assert.rejects(confirm(), /下单时段前后/);
  const history = lists.filter(query => query.status === '3');
  assert.equal(history.length, 1);
  assert.ok(Number(history[0].beginTimeE0) * 1000 <= created - 300_000 && Number(history[0].endTimeE0) * 1000 >= created + 300_000);
  assert.ok(Number(history[0].endTimeE0) - Number(history[0].beginTimeE0) <= 7 * 86_400);
  // The venue does not say which timestamp it filters: one that ended long after
  // the request is still found when the window applies to the end time.
  for (const edge = Number(history[0].endTimeE0) * 1000; f.time <= edge + 1000;) { f.advance(20_000); await f.service.tick(); }
  venue.filterByEnd = true;
  venue.ended = [{ ...row(1, created + 2000), endedAt: f.time }];
  await assert.rejects(confirm(), /下单时段前后/);
  // A venue clock ahead of ours: a strategy it already stamped as ended is still read.
  venue.ended = [{ ...row(1, created + 2000), endedAt: f.time + 120_000 }];
  await assert.rejects(confirm(), /下单时段前后/);
  // Older than one venue window: history is read in segments through now, never truncated.
  const bybitOrder = () => JSON.parse(f.db.prepare('SELECT json FROM execution_orders WHERE json LIKE ?').get('%"exchange":"bybit"%').json);
  const setCreatedAt = value => { const order = bybitOrder(); order.createdAt = new Date(value).toISOString(); f.db.prepare('UPDATE execution_orders SET json=? WHERE id=?').run(JSON.stringify(order), order.localId); };
  const originalCreatedAt = Date.parse(bybitOrder().createdAt), aged = originalCreatedAt - 8 * 86_400_000;
  setCreatedAt(aged);
  lists.length = 0;
  venue.ended = [{ ...row(1, aged + 2000), endedAt: f.time }];
  await assert.rejects(confirm(), /下单时段前后/);
  const segments = lists.filter(query => query.status === '3');
  assert.equal(segments.length, 2);
  assert.ok(segments.every(query => Number(query.endTimeE0) - Number(query.beginTimeE0) <= 7 * 86_400));
  setCreatedAt(originalCreatedAt);
  venue.filterByEnd = false; venue.ended = [row(1, created + 2000)];
  // Incomplete pagination proves nothing.
  venue.endlessPages = true;
  await assert.rejects(confirm(), /分页结果不完整/);
  venue.endlessPages = false;
  // A position that differs from known fills still blocks it.
  venue.ended = []; venue.shortQuantity = '1';
  await assert.rejects(confirm(), /仓位或挂单与本任务已知成交不一致/);
  venue.shortQuantity = '0';
  assert.equal(f.job.status, 'attention');
  // Far history (even when the venue ignores the window) and strategies another
  // Hub job already claimed do not block it.
  f.db.prepare('INSERT INTO execution_orders(id,job_id,json) VALUES (?,?,?)').run('earlier-order', 'earlier-job', JSON.stringify({ exchange: 'bybit', remoteId: id(2) }));
  venue.ended = [row(2, created + 1000), row(3, created - 3_600_000)]; venue.ignoreWindow = true;
  await confirm();
  assert.equal(f.job.status, 'paused'); assert.equal(f.job.canResume, true);
  assert.equal(f.writer.snapshot().operations.some(item => ['sending', 'unknown'].includes(item.state)), false);
  // Routine account reads only query the active status buckets.
  assert.deepEqual([...new Set(lists.filter(query => !query.beginTimeE0).map(query => query.status))].sort(), ['2', '4', '5', '6']);
  assert.equal(f.creates.length, 2);
});

test('per-leg open quantities must balance long and short exposure in underlying units', async t => {
  const f = await fixture(t);
  const legs = quantity => [
    { exchange: 'binance', symbol: 'CLUSDT', side: 'long', quantity: '2', stopPrice: '90' },
    { exchange: 'okx', symbol: 'CLUSDT', side: 'short', quantity, stopPrice: '50' },
  ];
  await assert.rejects(f.preview(intent({ batchCount: 1, legs: legs('2') })), /多空两侧不平衡：多头合计 2 桶，空头合计 0\.2 桶/);
  const preview = await f.preview(intent({ batchCount: 1, legs: legs('20') }));
  assert.match(preview.notes[0], /逐腿数量：多头合计 2 桶，空头合计 2 桶。/);
});

test('four-leg per-leg opens balance each symbol across venues so one venue unit mistake cannot cancel out', async t => {
  const f = await fixture(t);
  const legs = (cl, bz) => [
    { exchange: 'binance', symbol: 'CLUSDT', side: 'long', quantity: '2', stopPrice: '90' },
    { exchange: 'binance', symbol: 'BZUSDT', side: 'short', quantity: '2', stopPrice: '50' },
    { exchange: 'okx', symbol: 'CLUSDT', side: 'short', quantity: cl, stopPrice: '50' },
    { exchange: 'okx', symbol: 'BZUSDT', side: 'long', quantity: bz, stopPrice: '90' },
  ];
  // OKX entered in barrels: totals still match (2.2 vs 2.2) but each symbol does not.
  await assert.rejects(f.preview(intent({ preset: 'four-leg', batchCount: 1, legs: legs('2', '20') })), /多空两侧不平衡：BZUSDT 跨所多头合计 0\.2 桶，空头合计 2 桶/);
  const preview = await f.preview(intent({ preset: 'four-leg', batchCount: 1, legs: legs('20', '200') }));
  assert.match(preview.notes[0], /逐腿数量：多头合计 4 桶，空头合计 4 桶。/);
});

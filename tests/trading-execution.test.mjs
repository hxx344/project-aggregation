import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
  const db = new DatabaseSync(':memory:');
  let time = baseTime, serial = 0, instance;
  const records = new Map(), calls = [], handlers = {}, markets = {};
  const accounts = Object.fromEntries(['binance', 'bybit'].map(exchange => [exchange, { identity: exchange === 'bybit' ? 'fixture-uid' : null, modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] }]));
  const market = symbol => ({ symbol, bid: '70', ask: '70.01', at: new Date(time).toISOString(), rule: { tickSize: '0.01', quantityStep: '0.001', minQuantity: '0.001', maxQuantity: '100', minNotional: '5', maxNotional: null } });
  const factory = exchange => Object.fromEntries(['verify', 'account', 'market', 'create', 'inspect', 'stop'].map(method => [method, async (...args) => {
    calls.push({ exchange, method, args });
    if (handlers[`${exchange}:${method}`]) return handlers[`${exchange}:${method}`](...args);
    if (method === 'verify') return { identity: accounts[exchange].identity };
    if (method === 'account') return structuredClone(accounts[exchange]);
    if (method === 'market') return { ...market(args[0]), ...markets[exchange] };
    const spec = args[1];
    if (method === 'create') {
      const id = String(++serial), record = { ...spec, id, kind: exchange === 'bybit' ? 'strategy' : 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '70', averagePrice: null, createdAt: new Date(time).toISOString() };
      records.set(id, record); return { id, kind: record.kind };
    }
    const record = spec.id ? records.get(spec.id) : [...records.values()].find(item => item.clientId === spec.clientId);
    if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
    if (method === 'inspect') return structuredClone(record);
    if (method === 'stop') Object.assign(record, { status: 'terminal', terminal: true, childrenSettled: true });
  }]));
  const create = () => createTradingExecution({ db, now: () => time, intervalMs: 0, encrypt: value => JSON.stringify(value), decrypt: JSON.parse, clientFactory: factory, ...options });
  instance = create();
  t.after(async () => { await instance.close(); db.close(); });
  for (const exchange of ['binance', 'bybit']) await instance.connect(exchange, { revision: 0, accountMode: exchange === 'binance' ? 'standard' : 'unified', apiKey: 'fixture_key', apiSecret: 'fixture_secret' });
  return { db, records, calls, accounts, handlers, markets, create, get service() { return instance; }, set service(value) { instance = value; }, get time() { return time; }, advance(value) { time += value; },
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

test('partial Binance fill is canceled and reconciled before replacing only the remainder', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const binance = [...f.records.values()].find(record => record.kind === 'order'); binance.filledQuantity = '0.75';
  f.advance(1000); await f.service.tick();
  assert.equal(f.creates.length, 3); assert.equal(f.creates.at(-1).exchange, 'binance'); assert.equal(f.creates.at(-1).args[1].quantity, '1.25');
  const stop = f.calls.findIndex(call => call.method === 'stop' && call.exchange === 'binance'), replacement = f.calls.findLastIndex(call => call.method === 'create');
  assert.ok(f.calls.slice(stop + 1, replacement).some(call => call.method === 'inspect'));
  assert.equal(f.job.legs[0].filledQuantity, '0.75');
});

test('cancel ACK with still-active original order cannot authorize a replacement', async t => {
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  f.handlers['binance:stop'] = async () => {};
  f.advance(1000); await f.service.tick(); assert.equal(f.creates.length, 2);
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
  const f = await fixture(t); f.start(await f.preview(intent({ batchCount: 1 }))); await f.service.tick();
  const [binance, bybit] = [...f.records.values()]; binance.filledQuantity = '0.5';
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

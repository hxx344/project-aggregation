import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountWriter } from '../server/execution/account-writer.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { createAnthropicReduction } from '../server/trading-anthropic-reduction.mjs';
import { readReductionRisk } from '../server/trading-reduction-plan.mjs';
import { subtract } from '../server/trading-execution-plan.mjs';
import { ExecutionExchangeError } from '../server/trading-execution-exchanges.mjs';

const TIME = Date.UTC(2026, 10, 7, 2);
const SYMBOL = 'ANTHROPICUSDT';
const stamp = time => new Date(time).toISOString();
const config = (overrides = {}) => ({ enabled: true,
  legs: [{ exchange: 'binance', symbol: SYMBOL, side: 'long' }, { exchange: 'okx', symbol: SYMBOL, side: 'short' }],
  shares: { outstanding: '3', diluted: '4' }, thresholdPercent: '5', reducePercent: '33', batchCount: 3, batchIntervalMs: 1000, timeoutMs: 60_000, ...overrides });
const credentials = exchange => ({ accountMode: exchange === 'okx' ? 'cross' : 'standard', apiKey: 'fixture_key', apiSecret: 'fixture_secret', ...(exchange === 'okx' ? { passphrase: 'fixture_passphrase' } : {}) });

async function fixture(t, { guarded = false } = {}) {
  const db = new DatabaseSync(':memory:');
  let time = TIME, serial = 0, execution, reduction;
  const directory = guarded ? mkdtempSync(path.join(tmpdir(), 'anthropic-reduction-writer-')) : null;
  const writer = guarded ? createAccountWriter({ databasePath: path.join(directory, 'execution-control.sqlite'), moduleId: 'hub', runtimeId: randomUUID(), now: () => time }) : null;
  const records = new Map(), calls = [], hooks = {}, flags = { maintenance: false };
  const accounts = Object.fromEntries(['binance', 'okx'].map((exchange, index) => [exchange, {
    identity: guarded ? String(index + 1) : `fixture-${exchange}`, modes: { [SYMBOL]: 'hedge' }, openOrders: [], strategies: [],
    positions: [{ symbol: SYMBOL, side: index ? 'short' : 'long', quantity: index ? '31' : '10.1',
      risk: { markPrice: '100', liquidationPrice: index ? '150' : '95', at: stamp(time) } }],
  }]));
  accounts['rh-lighter'] = { identity: '0x' + 'ab'.repeat(20), modes: { ANTHROPIC: 'one-way' }, openOrders: [], strategies: [],
    positions: [{ symbol: 'ANTHROPIC', side: 'short', quantity: '31', risk: { markPrice: '100', liquidationPrice: '150', at: stamp(time) } }],
    leverage: { ANTHROPIC: { type: 'cross', value: 10 } } };
  const factory = exchange => ({
    verify: async () => ({ identity: accounts[exchange].identity }),
    account: async () => { calls.push({ exchange, method: 'account' }); await hooks.account?.(exchange); return structuredClone(accounts[exchange]); },
    market: async symbol => {
      calls.push({ exchange, method: 'market' });
      const market = { symbol, bid: '100', ask: '100.01', at: stamp(time), rule: {
        tickSize: '0.01', quantityStep: exchange === 'okx' ? '1' : '0.1', minQuantity: exchange === 'okx' ? '1' : '0.1',
        maxQuantity: '1000', maxMarketQuantity: '1000', minNotional: '5', maxNotional: null, contractSize: '1',
        ...(exchange === 'rh-lighter' ? { assetId: 7, quoteAsset: 'USDG' } : {}),
      } };
      await hooks.market?.(exchange, market); return market;
    },
    create: async (_secret, spec, options) => {
      options.beforeMutation(); calls.push({ exchange, method: 'create', spec: structuredClone(spec) });
      await hooks.create?.(exchange, spec);
      const id = String(++serial);
      records.set(id, { ...spec, exchange, id, kind: 'order', status: 'working', terminal: false, childrenSettled: false, filledQuantity: '0', price: '100', createdAt: stamp(time) });
      return { id, kind: 'order' };
    },
    inspect: async (_secret, spec) => {
      await hooks.inspect?.(exchange, spec);
      const record = spec.id ? records.get(spec.id) : [...records.values()].find(row => row.clientId === spec.clientId);
      if (!record) throw new ExecutionExchangeError('not_found', { notFound: true });
      return structuredClone(record);
    },
    stop: async (_secret, spec, options) => {
      options.beforeMutation(); calls.push({ exchange, method: 'stop' });
      Object.assign(records.get(spec.id), { status: 'terminal', terminal: true, childrenSettled: true });
    },
  });
  const open = async () => {
    execution = createTradingExecution({ db, now: () => time, intervalMs: 0, encrypt: JSON.stringify, decrypt: JSON.parse, clientFactory: factory, accountWriter: writer });
    await execution.initializeProtection();
    reduction = createAnthropicReduction({ db, execution, now: () => time, intervalMs: 0, readMaintenance: () => flags.maintenance, log: { warn() {} } });
  };
  await open();
  for (const exchange of ['binance', 'okx']) await execution.connect(exchange, { revision: 0, ...credentials(exchange) });
  t.after(async () => {
    await reduction.close(); await execution.close(); writer?.close(); db.close();
    if (directory) {
      const target = path.resolve(directory);
      assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('anthropic-reduction-writer-'));
      rmSync(target, { recursive: true, force: true });
    }
  });
  function fill(record, quantity = record.quantity, terminal = true) {
    const position = accounts[record.exchange].positions[0], delta = subtract(quantity, record.filledQuantity);
    position.quantity = subtract(position.quantity, delta);
    Object.assign(record, { filledQuantity: quantity, terminal, childrenSettled: terminal, status: terminal ? 'terminal' : 'working' });
  }
  return { db, writer, accounts, records, calls, hooks, flags, fill,
    get execution() { return execution; }, get reduction() { return reduction; }, get state() { return reduction.state(); },
    get jobs() { return execution.state().jobs; }, get creates() { return calls.filter(row => row.method === 'create'); },
    advance(ms) { time += ms; },
    async wait(ms) { for (let left = ms; left > 0; left -= 10_000) { time += Math.min(left, 10_000); await execution.tick(); } },
    enable(overrides = {}) { return reduction.save({ revision: reduction.state().revision, config: config(overrides), confirmLive: true }); },
    locks() { return db.prepare('SELECT resource FROM execution_locks ORDER BY resource').all().map(row => row.resource); },
    async restart() { await reduction.close(); await execution.close(); await open(); },
    async finishBatch() { for (const record of records.values()) if (!record.terminal) fill(record); await execution.tick(); },
  };
}

test('risk thresholds compare unrounded prices on either side and clamp already crossed liquidation to zero', () => {
  const risk = (longLiquidation, shortLiquidation = '150') => readReductionRisk(config(), new Map([
    ['binance', { positions: [{ symbol: SYMBOL, side: 'long', quantity: '10.1', risk: { markPrice: '100', liquidationPrice: longLiquidation, at: stamp(TIME) } }] }],
    ['okx', { positions: [{ symbol: SYMBOL, side: 'short', quantity: '31', risk: { markPrice: '100', liquidationPrice: shortLiquidation, at: stamp(TIME) } }] }],
  ]), TIME);
  assert.equal(risk('95').met, true);
  assert.equal(risk('94.999999999999999999').met, false, 'a displayed 5% must not round down into a trigger');
  assert.equal(risk('95.000000000000000001').met, true);
  assert.equal(risk('50', '105').met, true, 'the short leg independently triggers');
  assert.equal(risk('50', '105.000000000000000001').met, false);
  assert.equal(risk('50', '104.999999999999999999').met, true);
  assert.equal(risk('101').legs[0].distancePercent, '0');
  assert.equal(risk('50', '99').legs[1].distancePercent, '0');
  assert.equal(risk('50', '99').met, true);
});

test('the rule starts disabled and requires a confirmed, revision-bound live account', async t => {
  const f = await fixture(t);
  assert.equal(f.state.state.phase, 'disabled'); assert.equal(f.state.config, null);
  await f.reduction.tick(); assert.equal(f.jobs.length, 0);
  assert.throws(() => f.reduction.save({ revision: 0, config: config() }), /确认/);
  f.db.prepare('UPDATE execution_accounts SET identity=NULL WHERE exchange=?').run('binance');
  assert.throws(() => f.enable(), /核验实盘账户/);
  assert.equal(f.state.revision, 0); assert.equal(f.creates.length, 0);
});

test('missing, stale or future risk on either leg never creates a task or sends an order', async t => {
  for (const [name, change] of [
    ['missing', row => { delete row.risk; }],
    ['stale', row => { row.risk.at = stamp(TIME - 30_001); }],
    ['future', row => { row.risk.at = stamp(TIME + 1001); }],
  ]) await t.test(name, async t => {
    const f = await fixture(t); change(f.accounts.okx.positions[0]); f.enable(); await f.reduction.tick();
    assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []); assert.equal(f.creates.length, 0);
    assert.match(f.state.state.reason, /缺少有效|过期或时间无效/);
  });
});

test('three two-sided batches conserve separately rounded native totals and finish disabled even after risk recovers', async t => {
  const f = await fixture(t); f.enable(); await f.reduction.tick();
  assert.deepEqual(f.jobs[0].legs.map(leg => [leg.exchange, leg.quantity]), [['binance', '3.3'], ['okx', '10']]);
  assert.equal(f.state.state.phase, 'reducing'); assert.equal(f.jobs[0].batchCount, 3);
  await f.execution.tick(); assert.equal(f.creates.length, 2);
  const first = [...f.records.values()];
  f.fill(first[0]); await f.execution.tick();
  assert.equal(f.creates.length, 2, 'one filled leg cannot start another batch');
  f.fill(first[1], first[1].quantity, false); await f.execution.tick();
  assert.equal(f.jobs[0].batchIndex, 0, 'full fills still require terminal orders on both sides');
  f.fill(first[1]); await f.execution.tick(); assert.equal(f.jobs[0].batchIndex, 1);
  f.accounts.binance.positions[0].risk.liquidationPrice = '50';
  f.advance(999); await f.execution.tick(); assert.equal(f.creates.length, 2);
  f.advance(1); await f.execution.tick(); assert.equal(f.creates.length, 4);
  await f.finishBatch(); f.advance(1000); await f.execution.tick(); assert.equal(f.creates.length, 6);
  await f.finishBatch(); await f.reduction.tick();
  assert.equal(f.jobs[0].status, 'completed'); assert.equal(f.state.state.phase, 'completed');
  assert.equal(f.state.config.enabled, false); assert.deepEqual(f.locks(), []);
  assert.deepEqual(f.creates.filter(row => row.exchange === 'binance').map(row => row.spec.quantity), ['1.1', '1.1', '1.1']);
  assert.deepEqual(f.creates.filter(row => row.exchange === 'okx').map(row => row.spec.quantity), ['4', '3', '3']);
  assert.ok(f.creates.every(row => row.spec.reduceOnly && row.spec.orderType === 'market'));
  assert.deepEqual([f.accounts.binance.positions[0].quantity, f.accounts.okx.positions[0].quantity], ['6.8', '21']);
  f.accounts.binance.positions[0].risk.liquidationPrice = '99';
  await f.reduction.tick(); await f.execution.tick(); assert.equal(f.jobs.length, 1); assert.equal(f.creates.length, 6);
});

test('recovered risk before the first send stops both legs without a mutation', async t => {
  const f = await fixture(t); f.enable(); await f.reduction.tick();
  f.accounts.binance.positions[0].risk.liquidationPrice = '50';
  await f.execution.tick(); await f.reduction.tick();
  assert.equal(f.creates.length, 0); assert.equal(f.jobs[0].status, 'stopped');
  assert.match(f.jobs[0].reason, /首批发送前强平距离已恢复/);
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false); assert.deepEqual(f.locks(), []);
});

test('repeated ticks and service restart keep the same durable task and never trigger a duplicate', async t => {
  const f = await fixture(t); f.enable();
  await Promise.all([f.reduction.tick(), f.reduction.tick(), f.reduction.tick()]);
  const id = f.jobs[0].id; await f.reduction.tick(); assert.equal(f.jobs.length, 1);
  await f.execution.tick(); const sent = f.creates.length; assert.equal(sent, 2);
  await f.restart(); await f.reduction.tick(); await f.execution.tick(); await f.reduction.tick();
  assert.deepEqual(f.jobs.map(job => job.id), [id]); assert.equal(f.creates.length, sent);
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false);
});

test('changing a live connection revision disables an armed rule before any sends', async t => {
  const f = await fixture(t); f.enable();
  const connection = f.execution.state().connections.find(row => row.exchange === 'binance');
  await f.execution.connect('binance', { revision: connection.revision, ...credentials('binance') });
  await f.reduction.tick();
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false);
  assert.match(f.state.state.reason, /实盘连接已变化/); assert.equal(f.jobs.length, 0); assert.equal(f.creates.length, 0);
});

test('maintenance suppresses new work, while a contract lock defers the armed rule', async t => {
  const f = await fixture(t); f.flags.maintenance = true;
  assert.throws(() => f.enable(), /维护/); f.flags.maintenance = false; f.enable();
  f.flags.maintenance = true; const reads = f.calls.length; await f.reduction.tick();
  assert.equal(f.calls.length, reads); assert.equal(f.jobs.length, 0);
  f.flags.maintenance = false;
  f.db.prepare('INSERT INTO execution_locks(resource,job_id) VALUES (?,?)').run(`binance:${SYMBOL}`, 'other-task');
  await f.reduction.tick();
  assert.equal(f.jobs.length, 0); assert.equal(f.state.state.phase, 'armed'); assert.equal(f.state.state.failures, 0);
  assert.match(f.state.state.reason, /已有未结束任务/); assert.ok(f.state.state.retryAt);
  assert.throws(() => f.enable(), /已有未结束任务/);
});

test('a failed task insert atomically rolls back its rule transition and all contract locks', async t => {
  const f = await fixture(t); f.enable();
  f.db.exec("CREATE TEMP TRIGGER reject_reduction_job BEFORE INSERT ON execution_jobs BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
  await f.reduction.tick(); await f.execution.tick();
  assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []); assert.equal(f.creates.length, 0);
  assert.equal(f.state.state.jobId, null); assert.equal(f.state.state.phase, 'armed'); assert.equal(f.state.state.failures, 1);
  f.db.exec('DROP TRIGGER reject_reduction_job');
});

test('external position changes before the first or a later batch stop all new sends', async t => {
  for (const afterFirst of [false, true]) await t.test(afterFirst ? 'later batch' : 'first batch', async t => {
    const f = await fixture(t); f.enable(); await f.reduction.tick();
    if (afterFirst) { await f.execution.tick(); await f.finishBatch(); f.advance(1000); }
    const sent = f.creates.length;
    f.accounts.okx.positions[0].quantity = subtract(f.accounts.okx.positions[0].quantity, '1');
    await f.execution.tick(); await f.reduction.tick();
    assert.equal(f.creates.length, sent); assert.match(f.jobs[0].reason, /持仓未反映已成交减仓或被外部更改/);
    assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false);
  });
});

test('a partially filled terminal market order pauses later batches and is never replenished', async t => {
  const f = await fixture(t); f.enable(); await f.reduction.tick(); await f.execution.tick();
  const first = [...f.records.values()]; f.fill(first[0], '0.5'); f.fill(first[1]);
  await f.execution.tick(); await f.reduction.tick();
  assert.match(f.jobs[0].reason, /市价单未全部成交/); assert.equal(f.state.state.phase, 'review');
  for (let i = 0; i < 3; i++) { f.advance(1000); await f.execution.tick(); await f.reduction.tick(); }
  assert.equal(f.creates.length, 2); assert.equal(f.jobs[0].legs[0].filledQuantity, '0.5');
  assert.throws(() => f.enable(), /关联减仓任务尚未结束/);
});

test('an unknown create retains the original order and never retries or creates another batch', async t => {
  const f = await fixture(t);
  f.hooks.create = exchange => { if (exchange === 'binance') throw new ExecutionExchangeError('fixture lost response', { uncertain: true }); };
  f.enable(); await f.reduction.tick(); await f.execution.tick(); await f.reduction.tick();
  const sent = f.creates.length, order = f.jobs[0].legs[0].currentOrder;
  assert.ok(sent > 0); assert.equal(order.unknown, true); assert.equal(f.jobs[0].status, 'attention');
  for (let i = 0; i < 3; i++) { f.advance(1000); await f.execution.tick(); await f.reduction.tick(); }
  assert.equal(f.creates.length, sent); assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].legs[0].currentOrder.clientId, order.clientId);
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false);
  assert.throws(() => f.enable(), /关联减仓任务尚未结束/);
});

test('managed account writing permits the bound reduction and settles both original operations', async t => {
  const f = await fixture(t, { guarded: true }); f.enable({ batchCount: 1 }); await f.reduction.tick();
  assert.equal(f.jobs.length, 1); await f.execution.tick(); assert.equal(f.creates.length, 2);
  assert.deepEqual(f.writer.snapshot().operations, [{ moduleId: 'hub', state: 'confirmed', count: 2 }]);
  await f.finishBatch(); await f.reduction.tick();
  assert.equal(f.jobs[0].status, 'completed'); assert.equal(f.state.config.enabled, false);
  assert.deepEqual(f.locks(), []);
});

test('disabling or stopping during a pending risk read prevents a late task commit', async t => {
  for (const action of ['disable', 'stop']) await t.test(action, async t => {
    const f = await fixture(t); f.enable();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
    f.hooks.account = async exchange => { if (exchange === 'binance') { enter(); await blocked; } };
    const pending = f.reduction.tick();
    try {
      await entered;
      if (action === 'disable') f.reduction.disable({ revision: f.state.revision });
      else f.reduction.stop();
    } finally { release(); }
    await pending;
    assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []); assert.equal(f.creates.length, 0);
    assert.equal(f.state.state.failures, 0); assert.equal(f.state.state.jobId, null);
    if (action === 'disable') { assert.equal(f.state.config.enabled, false); assert.equal(f.state.state.phase, 'disabled'); }
  });
});

test('read failure backoff survives restarts and disables after three attempts', async t => {
  const f = await fixture(t); delete f.accounts.okx.positions[0].risk; f.enable();
  await f.reduction.tick(); const firstRetry = f.state.state.retryAt;
  assert.equal(f.state.state.failures, 1); assert.equal(firstRetry, stamp(TIME + 30_000));
  await f.restart();
  const reads = f.calls.length; await f.reduction.tick();
  assert.equal(f.calls.length, reads); assert.equal(f.state.state.failures, 1); assert.equal(f.state.state.retryAt, firstRetry);
  await f.wait(30_000); await f.reduction.tick(); assert.equal(f.state.state.failures, 2);
  await f.restart(); assert.equal(f.state.state.failures, 2);
  await f.wait(30_000); await f.reduction.tick();
  assert.equal(f.state.state.failures, 3); assert.equal(f.state.state.retryAt, null);
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.state.config.enabled, false);
  assert.equal(f.jobs.length, 0); assert.equal(f.creates.length, 0);
});

test('a stale book after its one immediate refresh keeps the armed rule recoverable after cooldown', async t => {
  const f = await fixture(t); f.enable();
  f.hooks.market = (exchange, market) => { if (exchange === 'binance') market.at = stamp(TIME - 11_000); };
  await f.reduction.tick();
  assert.equal(f.calls.filter(row => row.exchange === 'binance' && row.method === 'market').length, 2, 'the executor already attempted its one bounded book refresh');
  assert.equal(f.state.state.failures, 1); assert.equal(f.state.state.phase, 'armed'); assert.equal(f.state.config.enabled, true);
  assert.equal(f.state.state.retryAt, stamp(TIME + 30_000)); assert.equal(f.jobs.length, 0); assert.equal(f.creates.length, 0);
  await f.restart(); const reads = f.calls.length;
  await f.reduction.tick(); assert.equal(f.calls.length, reads, 'restart must preserve the cooldown');
  delete f.hooks.market;
  await f.wait(30_000);
  for (const account of Object.values(f.accounts)) for (const position of account.positions) position.risk.at = stamp(TIME + 30_000);
  await f.reduction.tick();
  assert.equal(f.jobs.length, 1); assert.equal(f.state.state.phase, 'reducing'); assert.equal(f.state.state.failures, 0);
});

test('an executor rate-limit deadline beyond three minutes is preserved across rule restart', async t => {
  const f = await fixture(t), retryAt = TIME + 600_000;
  await f.execution.connect('rh-lighter', { revision: 0, accountMode: 'api-key', address: f.accounts['rh-lighter'].identity,
    accountIndex: 12345, apiKeyIndex: 5, apiKey: 'cd'.repeat(40) });
  f.enable({ legs: [config().legs[0], { exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'short' }] });
  // The adapter currently requests shorter waits. Exercise the executor's accepted
  // safe-integer deadline contract through its real RH read classification.
  f.hooks.account = exchange => {
    if (exchange === 'rh-lighter') throw Object.assign(new ExecutionExchangeError('upstream', { detail: 'fixture rate limit' }), { rateLimited: true, retryAt });
  };
  await f.reduction.tick();
  assert.equal(f.state.state.retryAt, stamp(retryAt)); assert.equal(f.state.state.failures, 1); assert.equal(f.state.state.phase, 'armed');
  delete f.hooks.account;
  await f.restart(); assert.equal(f.state.state.retryAt, stamp(retryAt)); const reads = f.calls.length;
  await f.wait(180_001); await f.reduction.tick(); assert.equal(f.calls.length, reads, 'the old three-minute clamp cannot admit any exchange read');
  await f.wait(419_998); await f.reduction.tick(); assert.equal(f.calls.length, reads, 'the full exchange deadline remains exclusive');
  await f.wait(1);
  for (const account of Object.values(f.accounts)) for (const position of account.positions) position.risk.at = stamp(retryAt);
  await f.reduction.tick();
  assert.equal(f.jobs.length, 1); assert.equal(f.state.state.phase, 'reducing');
});

test('a late risk read from a former lease owner cannot persist a failure or modify the rule', async t => {
  const f = await fixture(t); f.enable();
  const risk = f.accounts.okx.positions[0].risk;
  delete f.accounts.okx.positions[0].risk;
  await f.reduction.tick(); await f.wait(30_000); await f.reduction.tick();
  assert.equal(f.state.state.failures, 2); assert.equal(f.state.state.phase, 'armed');
  f.accounts.okx.positions[0].risk = risk;
  await f.wait(30_000);
  for (const account of Object.values(f.accounts)) for (const position of account.positions) position.risk.at = stamp(TIME + 60_000);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.hooks.account = async exchange => { if (exchange === 'binance') { enter(); await blocked; } };
  const before = f.db.prepare('SELECT * FROM execution_anthropic_reduction').get(), pending = f.reduction.tick();
  try {
    await entered;
    f.db.prepare('UPDATE execution_lease SET owner=? WHERE id=1').run('replacement-runtime');
  } finally { release(); }
  await pending;
  assert.equal(f.execution.leading(), false);
  assert.deepEqual(f.db.prepare('SELECT * FROM execution_anthropic_reduction').get(), before);
  assert.equal(f.jobs.length, 0); assert.deepEqual(f.locks(), []); assert.equal(f.creates.length, 0);
});

test('an owner TP/SL or limit order on a leg warns before the trigger and defers, not disarms, the rule when risk is reached', async t => {
  const f = await fixture(t);
  f.accounts.okx.openOrders = [{ symbol: SYMBOL, id: 'manual-tp-1' }];
  // Below the trigger: the read succeeds and surfaces the future blocker.
  f.enable({ thresholdPercent: '1' }); await f.reduction.tick();
  assert.equal(f.state.live.met, false); assert.match(f.state.live.warning, /okx ANTHROPICUSDT/);
  assert.equal(f.state.state.reason, null); assert.equal(f.state.state.failures, 0);
  // At the trigger: no task, no send, the rule stays armed and retries.
  f.reduction.disable({ revision: f.state.revision }); f.enable(); await f.reduction.tick();
  assert.equal(f.jobs.length, 0); assert.equal(f.creates.length, 0); assert.deepEqual(f.locks(), []);
  assert.equal(f.state.config.enabled, true); assert.equal(f.state.state.phase, 'armed'); assert.equal(f.state.state.failures, 0);
  assert.equal(f.state.state.retryAt, stamp(TIME + 30_000)); assert.match(f.state.state.reason, /活动委托.*规则保持启用/);
  assert.equal(f.state.live.met, true, 'the held trigger keeps its liquidation reading visible');
  const events = f.state.state.events.length;
  await f.wait(30_000);
  for (const account of Object.values(f.accounts)) for (const position of account.positions) position.risk.at = stamp(TIME + 30_000);
  await f.reduction.tick();
  assert.equal(f.state.config.enabled, true); assert.equal(f.state.state.events.length, events, 'a repeated identical blocker is not logged again');
  // Once the owner cancels the order the next retry reduces.
  f.accounts.okx.openOrders = [];
  await f.wait(30_000);
  for (const account of Object.values(f.accounts)) for (const position of account.positions) position.risk.at = stamp(TIME + 60_000);
  await f.reduction.tick();
  assert.equal(f.jobs.length, 1); assert.equal(f.state.state.phase, 'reducing');
});

test('an owner order placed between batches holds the next batch without cancelling or disarming, then resumes', async t => {
  const f = await fixture(t); f.enable(); await f.reduction.tick();
  await f.execution.tick(); await f.finishBatch(); f.advance(1000);
  const sent = f.creates.length, stops = f.calls.filter(row => row.method === 'stop').length;
  f.accounts.okx.openOrders = [{ symbol: SYMBOL, id: 'manual-sl-1' }];
  await f.execution.tick(); await f.execution.tick(); await f.reduction.tick();
  assert.equal(f.creates.length, sent); assert.equal(f.calls.filter(row => row.method === 'stop').length, stops);
  assert.equal(f.jobs[0].status, 'running'); assert.match(f.jobs[0].reason, /活动委托.*撤销后继续下一批/);
  assert.equal(f.state.state.phase, 'reducing'); assert.equal(f.state.config.enabled, true);
  f.accounts.okx.openOrders = [];
  await f.execution.tick(); assert.equal(f.creates.length, sent + 2);
  assert.doesNotMatch(f.jobs[0].reason ?? '', /撤销后继续下一批/, 'the stale hold reason is cleared once batches resume');
});

test('an owner order still present at the task deadline pauses the reduction for review', async t => {
  const f = await fixture(t); f.enable(); await f.reduction.tick();
  await f.execution.tick(); await f.finishBatch(); f.advance(1000);
  f.accounts.okx.openOrders = [{ symbol: SYMBOL, id: 'manual-sl-1' }];
  await f.execution.tick(); assert.equal(f.jobs[0].status, 'running');
  await f.wait(60_000); await f.reduction.tick();
  assert.notEqual(f.jobs[0].status, 'running'); assert.match(f.jobs[0].reason, /执行时间已到/);
  assert.equal(f.state.state.phase, 'review'); assert.equal(f.creates.length, 2, 'no batch is sent while the owner order remains');
});

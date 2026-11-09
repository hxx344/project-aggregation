import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { createTradingAutoExposure, projectAutoExposure } from '../server/trading-auto-exposure.mjs';

const at = Date.UTC(2026, 10, 9, 8), iso = time => new Date(time).toISOString();
const metadata = overrides => ({ tickSize: '0.01', quantityStep: '0.01', minQuantity: '0.01', maxQuantity: '10000', minNotional: '1', maxNotional: null, ...overrides });
const book = (symbol, rule = metadata()) => ({ symbol, bid: '70', ask: '70.01', at: iso(at), rule });
const rule = (id, overrides = {}) => ({ id, revision: 1, enabled: true, mode: 'live', observing: false, title: id,
  config: { name: id, market: 'oil', exchange: 'binance', direction: 'short', equalSize: '1', orderType: 'chase', ...overrides }, state: { phase: 'idle', jobId: null, held: null, account: null } });
const snapshot = rules => ({ version: 'rules-v1', rules });
const evidence = (exchange = 'binance', meta = metadata()) => ({ startedAt: iso(at), finishedAt: iso(at), changed: [], jobsChanged: false, jobs: [], heldContracts: [],
  accounts: [{ exchange, revision: 1, identity: '100', at: iso(at), symbols: ['CLUSDT', 'BZUSDT'], account: { identity: '100', modes: { CLUSDT: 'hedge', BZUSDT: 'hedge' }, positions: [], openOrders: [], strategies: [] } }],
  markets: ['CLUSDT', 'BZUSDT'].map(symbol => ({ exchange, symbol, market: book(symbol, meta) })) });
const group = (value, symbol = 'BZUSDT', side = 'short') => value.groups.find(row => row.symbol === symbol && row.side === side && row.currentAccount);

test('two same-direction rules add exact native quantities while the reverse rule stays separate', () => {
  const value = projectAutoExposure(snapshot([rule('one', { equalSize: '0.1' }), rule('two', { equalSize: '0.2' }), rule('reverse', { direction: 'long', equalSize: '2' })]), evidence(), at);
  assert.equal(group(value).target.quantity, '0.3');
  assert.equal(group(value).target.notional, '21');
  assert.equal(group(value, 'BZUSDT', 'long').target.quantity, '2');
  assert.equal(group(value).held.quantity, '0');
  assert.equal(group(value).actual.quantity, '0');
  assert.equal(group(value).orders.buyQuantity, '0');
  assert.deepEqual(group(value).sharedRuleIds.sort(), ['one', 'reverse', 'two']);
  assert.equal(value.complete, true);
});

test('configured observation and disabled targets are visible without claiming live activation', () => {
  const disabled = rule('disabled'), observe = rule('observe'); disabled.enabled = false; Object.assign(observe, { enabled: false, mode: 'observe', observing: true });
  const value = projectAutoExposure(snapshot([disabled, observe]), evidence(), at), row = group(value);
  assert.equal(row.target.quantity, '2');
  assert.equal(row.rules.find(item => item.id === 'observe').mode, 'observe');
  assert.equal(row.rules.find(item => item.id === 'disabled').enabled, false);
  assert.match(value.scope, /包含停用与只观察/);
});

test('missing coverage, account identity, stale positions and incomplete orders never prove a zero', () => {
  for (const change of [
    e => { e.accounts[0].symbols = ['CLUSDT']; },
    e => { e.accounts[0].identity = null; },
    e => { e.accounts[0].at = iso(at - 10_001); },
    e => { e.accounts[0].account.positions = undefined; },
    e => { e.accounts[0].account.modes.BZUSDT = undefined; },
    e => { e.changed = ['binance']; },
  ]) {
    const e = evidence(); change(e); const value = projectAutoExposure(snapshot([rule('one')]), e, at), row = value.groups.find(item => item.symbol === 'BZUSDT' && item.side === 'short');
    assert.equal(row.actual.quantity, null); assert.equal(value.complete, false); assert.ok(row.gaps.length);
  }
  const e = evidence(); delete e.accounts[0].account.openOrders;
  assert.equal(group(projectAutoExposure(snapshot([rule('one')]), e, at)).orders.buyQuantity, null);
});

test('unknown remaining quantity and unknown local submissions survive an empty venue order list', () => {
  const e = evidence(); e.accounts[0].account.openOrders.push({ id: 'remote', symbol: 'BZUSDT', side: 'sell', quantity: '2' });
  let row = group(projectAutoExposure(snapshot([rule('one')]), e, at));
  assert.equal(row.orders.sellQuantity, null); assert.equal(row.orders.items[0].remainingQuantity, null);
  e.accounts[0].account.openOrders = [];
  e.jobs.push({ id: 'unknown', status: 'attention', action: 'open', accounts: [{ exchange: 'binance', revision: 1, identity: '100' }], legs: [{ exchange: 'binance', symbol: 'BZUSDT', side: 'short', rule: metadata(), remainingQuantity: '1', currentOrder: { unknown: true }, unresolved: [{ unknown: true }] }] });
  row = group(projectAutoExposure(snapshot([rule('one')]), e, at));
  assert.equal(row.orders.buyQuantity, null); assert.equal(row.orders.sellQuantity, null); assert.equal(row.jobs[0].remainingQuantity, null);
  assert.deepEqual(row.rules[0].waitingFor, ['unknown']);
});

test('positions and in-flight instructions remain separate and include an untargeted opposite position', () => {
  const e = evidence(); e.accounts[0].account.positions = [{ symbol: 'BZUSDT', side: 'long', quantity: '4' }, { symbol: 'BZUSDT', side: 'short', quantity: '3' }];
  e.accounts[0].account.openOrders = [{ id: 'closing', symbol: 'BZUSDT', side: 'buy', positionSide: 'SHORT', quantity: '2', filledQuantity: '0.5' }];
  const value = projectAutoExposure(snapshot([rule('one')]), e, at), short = group(value), long = group(value, 'BZUSDT', 'long');
  assert.equal(short.target.quantity, '1'); assert.equal(short.actual.quantity, '3'); assert.equal(short.orders.buyQuantity, '1.5');
  assert.equal(long.target.quantity, '0'); assert.equal(long.actual.quantity, '4'); assert.equal(long.orders.buyQuantity, '0');
});

test('BOTH and missing positionSide orders never prove either directional total or zero', () => {
  for (const positionSide of ['BOTH', undefined]) {
    for (const side of ['buy', 'sell']) {
      const e = evidence(); e.accounts[0].account.modes.BZUSDT = 'one-way';
      e.accounts[0].account.positions = [{ symbol: 'BZUSDT', side: side === 'buy' ? 'short' : 'long', quantity: '4' }];
      e.accounts[0].account.openOrders = [{ id: 'closing', symbol: 'BZUSDT', side, positionSide, quantity: '3', filledQuantity: '0', reduceOnly: true }];
      const value = projectAutoExposure(snapshot([rule('one')]), e, at);
      assert.equal(value.complete, false);
      for (const direction of ['short', 'long']) {
        const row = group(value, 'BZUSDT', direction);
        assert.equal(row.orders.buyQuantity, null); assert.equal(row.orders.sellQuantity, null);
        assert.equal(row.orders.items[0].remainingQuantity, '3', 'known instruction quantity is retained only in details');
        assert.equal(row.orders.items[0].id, 'closing'); assert.match(row.gaps.join(' '), /归属.*未确认/);
      }
    }
  }
});

test('held records require opening-account and contract evidence, and keep older accounts separate', () => {
  const held = rule('held'); held.state = { phase: 'holding', jobId: null, held: [{ exchange: 'binance', symbol: 'BZUSDT', side: 'short', quantity: '1' }], account: { identity: '100', revision: 1 } };
  const e = evidence();
  let value = projectAutoExposure(snapshot([held]), e, at);
  assert.ok(value.groups.some(row => row.held.unknownCount === 1 && row.held.quantity === null));
  e.heldContracts.push({ auto: { ruleId: 'held' }, accounts: [{ exchange: 'binance', identity: '100', revision: 1 }], legs: [{ exchange: 'binance', symbol: 'BZUSDT', side: 'short', filledQuantity: '1', rule: metadata() }] });
  value = projectAutoExposure(snapshot([held]), e, at); assert.equal(group(value).held.quantity, '1');
  e.accounts[0].identity = '200'; e.accounts[0].revision = 2;
  value = projectAutoExposure(snapshot([held]), e, at);
  const historical = value.groups.find(row => row.held.quantity === '1');
  assert.notEqual(historical.accountKey, group(value).accountKey); assert.equal(historical.actual.quantity, null); assert.equal(historical.currentAccount, false);
  assert.equal(group(value).held.quantity, '0');
});

test('OKX native contract, quantity unit and multiplier isolate legacy records from new targets', () => {
  const oldRule = metadata({ instrumentId: 'BZ-USDT-SWAP', quantityUnit: '张', contractSize: '0.1' });
  const e = evidence('okx', metadata({ instrumentId: 'BZ-USDT-SWAP', quantityUnit: '张', contractSize: '0.2' }));
  e.markets.find(item => item.symbol === 'CLUSDT').market.rule = metadata({ instrumentId: 'CL-USDT-SWAP', quantityUnit: '张', contractSize: '0.2' });
  const held = rule('okx-rule', { exchange: 'okx' }); held.state = { phase: 'holding', jobId: null, account: { identity: '100', revision: 1 }, held: [{ exchange: 'okx', symbol: 'BZUSDT', side: 'short', quantity: '10' }] };
  e.heldContracts = [{ auto: { ruleId: held.id }, accounts: [{ exchange: 'okx', identity: '100', revision: 1 }], legs: [{ exchange: 'okx', symbol: 'BZUSDT', side: 'short', filledQuantity: '10', rule: oldRule }] }];
  const value = projectAutoExposure(snapshot([held]), e, at), current = group(value), old = value.groups.find(row => row.held.quantity === '10');
  assert.equal(current.instrumentId, 'BZ-USDT-SWAP'); assert.equal(current.unit, '张'); assert.equal(current.target.quantity, '5');
  assert.equal(old.contractSize, '0.1'); assert.notEqual(current.id, old.id); assert.equal(old.actual.quantity, null); assert.equal(old.held.notional, null); assert.equal(old.quoteAt, null);
  // A native identity change cannot be presented as the old contract either.
  e.markets.find(item => item.symbol === 'BZUSDT').market.rule.instrumentId = 'BZ-NEW-USDT-SWAP';
  const changed = projectAutoExposure(snapshot([held]), e, at);
  assert.equal(changed.groups.find(row => row.held.quantity === '10').instrumentId, 'BZ-USDT-SWAP');
  assert.equal(changed.groups.find(row => row.held.quantity === '10').held.notional, null);
  assert.equal(group(changed).instrumentId, 'BZ-NEW-USDT-SWAP');
});

test('missing OKX native units cannot be filled by a generic symbol or an assumed multiplier', () => {
  const value = projectAutoExposure(snapshot([rule('okx', { exchange: 'okx' })]), evidence('okx'), at), row = group(value);
  assert.equal(row.target.quantity, null); assert.equal(row.actual.quantity, null); assert.equal(row.instrumentId, null);
});

test('rule version race refuses the whole result; simultaneous reads are bounded', async () => {
  let version = 'before', release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = createTradingAutoExposure({ readRules: () => ({ ...snapshot([rule('one')]), version }), execution: { exposureEvidence: async () => { await gate; return evidence(); } }, now: () => at });
  const read = reader.read(); await assert.rejects(reader.read(), error => error.status === 429);
  version = 'after'; release(); await assert.rejects(read, error => error.status === 409);
  const result = await reader.read(); assert.equal(result.rulesVersion, 'after');
});

function executionFixture(t) {
  const db = new DatabaseSync(':memory:'), calls = [], hooks = {};
  const account = evidence().accounts[0].account;
  const forbidden = () => { assert.fail('Read-only exposure must not perform a trading/writer operation'); };
  const execution = createTradingExecution({ db, stmt: null, encrypt: JSON.stringify, decrypt: JSON.parse, intervalMs: 0, now: () => at,
    accountWriter: { bind: forbidden, acquire: forbidden, assertOwned: forbidden },
    clientFactory: exchange => ({ verify: async (_credentials, options) => { calls.push(['verify', exchange, options]); return { identity: '100' }; },
      account: async (_credentials, options) => { calls.push(['account', exchange, options]); await hooks.account?.(); return structuredClone(account); },
      market: async (symbol, options) => { calls.push(['market', exchange, symbol, options]); await hooks.market?.(); return book(symbol); },
      create: forbidden, amend: forbidden, stop: forbidden }) });
  db.prepare('UPDATE execution_accounts SET revision=1,credentials=?,identity=? WHERE exchange=?').run(JSON.stringify({ purpose: 'execution', exchange: 'binance', apiKey: 'fixture', apiSecret: 'fixture-secret' }), '100', 'binance');
  // Evidence must remain readable even when another process owns execution.
  db.prepare('UPDATE execution_lease SET owner=?').run('another-runtime');
  t.after(async () => { await execution.close(); db.close(); });
  return { execution, db, calls, hooks, account };
}

test('actual evidence reader deduplicates requests and performs zero database, lease, writer or trading writes', async t => {
  const f = executionFixture(t), count = () => f.db.prepare('SELECT total_changes() AS count').get().count;
  const before = count();
  const value = await f.execution.exposureEvidence([{ exchange: 'binance', symbol: 'BZUSDT' }, { exchange: 'binance', symbol: 'BZUSDT' }, { exchange: 'binance', symbol: 'CLUSDT' }]);
  assert.equal(count(), before); assert.deepEqual(value.changed, []); assert.equal(value.accounts[0].identity, '100');
  assert.equal(f.calls.filter(call => call[0] === 'verify').length, 1); assert.equal(f.calls.filter(call => call[0] === 'account').length, 1); assert.equal(f.calls.filter(call => call[0] === 'market').length, 2);
  assert.deepEqual(f.calls.find(call => call[0] === 'account')[2].symbols.sort(), ['BZUSDT', 'CLUSDT']);
  assert.equal(f.calls.find(call => call[0] === 'account')[2].beforeMutation, undefined);
  assert.equal(f.db.prepare('SELECT owner FROM execution_lease').get().owner, 'another-runtime');
  assert.equal(f.db.prepare("SELECT snapshot FROM execution_accounts WHERE exchange='binance'").get().snapshot, null);
});

test('read-only evidence does not repair missing read indexes', async t => {
  const f = executionFixture(t); f.db.exec('DROP INDEX execution_jobs_unfinished; DROP INDEX execution_orders_unsettled');
  const value = await f.execution.exposureEvidence([{ exchange: 'binance', symbol: 'BZUSDT' }]);
  assert.equal(value.accounts[0].identity, '100');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('execution_jobs_unfinished','execution_orders_unsettled')").get().count, 0);
});

test('connection revision race and mismatched actual identity withdraw confirmation', async t => {
  const f = executionFixture(t);
  f.hooks.account = () => f.db.prepare("UPDATE execution_accounts SET revision=revision+1 WHERE exchange='binance'").run();
  const value = await f.execution.exposureEvidence([{ exchange: 'binance', symbol: 'BZUSDT' }]);
  assert.deepEqual(value.changed, ['binance']);
  assert.equal(projectAutoExposure(snapshot([rule('one')]), value, at).groups.find(row => row.symbol === 'BZUSDT' && row.side === 'short').actual.quantity, null);
  delete f.hooks.account; f.account.identity = '200';
  const mismatch = await f.execution.exposureEvidence([{ exchange: 'binance', symbol: 'BZUSDT' }]);
  assert.match(mismatch.accounts[0].error, /身份/); assert.equal(mismatch.accounts[0].account, undefined);
});

test('private read failure keeps public metadata but no manufactured account zero', async t => {
  const f = executionFixture(t); f.hooks.account = () => { throw new Error('secret body must not escape'); };
  const value = await f.execution.exposureEvidence([{ exchange: 'binance', symbol: 'BZUSDT' }]);
  assert.ok(value.markets[0].market); assert.doesNotMatch(value.accounts[0].error, /secret/);
  assert.equal(projectAutoExposure(snapshot([rule('one')]), value, at).groups[0].actual.quantity, null);
});

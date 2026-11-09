import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTradingExecution } from '../server/trading-execution.mjs';
import { createExecutionPositionWatch } from '../server/trading-execution-position-watch.mjs';

const TIME = Date.UTC(2026, 10, 9, 12), SYMBOL = 'ANTHROPICUSDT', ADDRESS = '0x' + 'a'.repeat(40);
const credentials = (exchange, revision = 0) => ({ revision, accountMode: exchange === 'okx' ? 'cross' : 'standard',
  apiKey: 'fixture_key_' + revision, apiSecret: 'fixture_secret', ...(exchange === 'okx' ? { passphrase: 'fixture_passphrase' } : {}) });

async function fixture(t) {
  const db = new DatabaseSync(':memory:'), calls = [], identities = { binance: '41', okx: '42', 'rh-lighter': ADDRESS }, hooks = {};
  const execution = createTradingExecution({ db, now: () => TIME, intervalMs: 0, encrypt: JSON.stringify, decrypt: JSON.parse,
    clientFactory: exchange => ({
      verify: async () => { calls.push('verify'); return { identity: identities[exchange] }; },
      account: async () => { calls.push('account'); return { identity: identities[exchange], modes: {}, positions: [], openOrders: [], strategies: [] }; },
      positionSnapshot: async (secret, options) => {
        calls.push({ exchange, method: 'positionSnapshot', symbols: options.symbols, accountMode: options.accountMode, hasMutationGuard: Object.hasOwn(options, 'beforeMutation') });
        const snapshot = { identity: identities[exchange], ...(exchange === 'rh-lighter' ? { accountIndex: secret.accountIndex } : {}),
          fetchedAt: new Date(TIME).toISOString(), positions: [{ symbol: exchange === 'rh-lighter' ? 'ANTHROPIC' : SYMBOL, side: 'long', quantity: '3',
            markPrice: '100', liquidationPrice: '90', marginMode: 'cross', riskFetchedAt: new Date(TIME).toISOString() }] };
        if (hooks.read) await hooks.read(exchange, options, snapshot);
        return snapshot;
      },
      create: () => { throw new Error('observation must not create an order'); },
      stop: () => { throw new Error('observation must not cancel an order'); },
      amend: () => { throw new Error('observation must not amend an order'); },
    }) });
  await execution.initializeProtection();
  const cache = createExecutionPositionWatch({ readConnections: execution.anthropicPositionConnections,
    read: execution.readAnthropicPositions, now: () => TIME });
  t.after(async () => { await cache.close(); await execution.close(); db.close(); });
  return { db, execution, cache, calls, identities, hooks,
    bind: exchange => execution.anthropicPositionConnections().find(row => row.exchange === exchange),
    async connect(exchange = 'binance', revision = 0) { await execution.connect(exchange, credentials(exchange, revision)); },
    durable() { return ['execution_accounts', 'execution_jobs', 'execution_orders', 'execution_locks', 'execution_lease'].map(table => db.prepare(`SELECT * FROM ${table}`).all()); },
  };
}

test('execution observation uses only the narrow snapshot and does not change durable trading or lease state', async t => {
  const f = await fixture(t); await f.connect(); await f.connect('okx'); f.calls.length = 0;
  f.db.prepare('UPDATE execution_lease SET expires=? WHERE id=1').run(TIME - 1);
  const before = f.durable();
  for (let i = 0; i < 3; i++) f.cache.state();
  assert.equal(f.calls.length, 0);
  await f.cache.refresh();
  assert.deepEqual(f.calls, ['binance', 'okx'].map(exchange => ({ exchange, method: 'positionSnapshot', symbols: [SYMBOL], accountMode: exchange === 'okx' ? 'cross' : 'standard', hasMutationGuard: false })));
  assert.deepEqual(f.durable(), before, 'a read neither renews nor retires the execution lease or overwrites its preflight snapshot');
  assert.deepEqual(f.cache.state().filter(source => source.connected).map(source => [source.exchange, source.state, source.executionBinding.identity]), [['binance', 'live', '41'], ['okx', 'live', '42']]);
});

test('a new execution connection revokes a held position response before it can enter the observation cache', async t => {
  const f = await fixture(t); await f.connect();
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  f.hooks.read = async () => { entered(); await hold; };
  const reading = f.cache.refresh(); await waiting;
  f.identities.binance = '43'; await f.connect('binance', 1);
  release(); await reading;
  assert.deepEqual(f.cache.state().find(source => source.exchange === 'binance').positions, []);
  assert.equal(f.cache.state().find(source => source.exchange === 'binance').executionBinding, undefined);
  f.hooks.read = null; await f.cache.refresh();
  assert.equal(f.cache.state().find(source => source.exchange === 'binance').executionBinding.identity, '43');
});

test('disconnect, foreign identity and explicit cancellation never publish successful position evidence', async t => {
  for (const action of ['disconnect', 'identity', 'cancel']) await t.test(action, async t => {
    const f = await fixture(t); await f.connect();
    const binding = f.bind('binance'), controller = new AbortController();
    f.hooks.read = (_exchange, _options, snapshot) => {
      if (action === 'disconnect') f.execution.disconnect('binance', { revision: binding.revision });
      if (action === 'identity') snapshot.identity = '99';
      if (action === 'cancel') controller.abort();
    };
    await assert.rejects(f.execution.readAnthropicPositions('binance', binding, { signal: controller.signal }), error => error.code === (action === 'identity' ? 'position_identity' : 'position_binding_changed'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM execution_jobs').get().n, 0);
  });
});

test('the Lighter bridge pins the configured subaccount before and after reading', async t => {
  const f = await fixture(t);
  await f.execution.connect('rh-lighter', { revision: 0, accountMode: 'api-key', address: ADDRESS, accountIndex: 27, apiKeyIndex: 4, apiKey: 'ab'.repeat(40) });
  const binding = f.bind('rh-lighter'); assert.equal(binding.accountIndex, 27);
  const before = f.calls.length;
  await assert.rejects(f.execution.readAnthropicPositions('rh-lighter', { ...binding, accountIndex: 28 }), { code: 'position_binding_changed' });
  assert.equal(f.calls.length, before);
  f.hooks.read = (_exchange, _options, snapshot) => { snapshot.accountIndex = 28; };
  await assert.rejects(f.execution.readAnthropicPositions('rh-lighter', binding), { code: 'position_identity' });
  f.hooks.read = null; await f.cache.refresh();
  assert.equal(f.cache.state().find(source => source.exchange === 'rh-lighter').positions[0].account, 27);
});

test('execution observation restart starts without stale in-memory evidence', async t => {
  const f = await fixture(t); await f.connect(); await f.cache.refresh(); await f.cache.close();
  const next = createExecutionPositionWatch({ readConnections: f.execution.anthropicPositionConnections, read: f.execution.readAnthropicPositions, now: () => TIME });
  try {
    const source = next.state().find(row => row.exchange === 'binance');
    assert.equal(source.state, 'loading'); assert.deepEqual(source.positions, []); assert.equal(source.executionBinding, undefined);
    await next.refresh(); assert.equal(next.state().find(row => row.exchange === 'binance').state, 'live');
  } finally { await next.close(); }
});

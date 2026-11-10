import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAnthropicHistory } from '../server/trading-anthropic-history.mjs';
import { createTradingExecution } from '../server/trading-execution.mjs';

const T0 = Date.UTC(2026, 10, 7, 8), DAY = 86_400_000;
const OWNER = '0x' + 'ab'.repeat(20);
const tick = () => new Promise(resolve => setImmediate(resolve));
const result = (id = 'manual-fill') => ({ accountId: '12345', coverageStart: new Date(T0 - DAY).toISOString(), coverageEnd: new Date(T0).toISOString(), truncated: false,
  fills: [{ id, symbol: 'ANTHROPIC', base: 'ANTHROPIC', time: new Date(T0 - 1000).toISOString(), side: 'buy', positionSide: 'net', quantity: '1',
    quantityUnit: 'ANTHROPIC', price: '100', priceCurrency: 'USDG', fee: null, feeCurrency: null, realizedPnl: null, positionBefore: '0', positionAfter: '1' }] });
const scope = (state, exchange = 'rh-lighter') => state.source.data.exchanges.find(row => row.id === exchange).accounts[0].scopes[0];
function fixture(t) {
  let time = T0;
  const bindings = ['hyperliquid', 'rh-lighter'].map(exchange => ({ exchange, revision: 1, identity: OWNER, connected: false }));
  const calls = [];
  let reader = async () => result();
  const service = createAnthropicHistory({ now: () => time, execution: { historyConnections: () => structuredClone(bindings),
    readAnthropicHistory: (...args) => { calls.push(args); return reader(...args); } } });
  t.after(() => service.close());
  return { service, bindings, calls, advance: value => { time += value; }, set reader(value) { reader = value; } };
}

test('native history starts both reads asynchronously, deduplicates follow-ups and exposes no raw identity', async t => {
  const f = fixture(t);
  assert.equal(scope(f.service.state()).status, 'unconfigured'); await tick(); assert.equal(f.calls.length, 0);
  for (const binding of f.bindings) binding.connected = true;
  const releases = [];
  f.reader = () => new Promise(resolve => releases.push(resolve));
  const initial = f.service.state();
  assert.equal(initial.pending, true); assert.equal(scope(initial).status, 'loading'); assert.equal(f.calls.length, 0);
  assert.equal(initial.source.checkedAt, null);
  await tick(); assert.equal(f.calls.length, 2); f.service.state(); assert.equal(f.calls.length, 2);
  for (const release of releases) release(result()); await tick();
  const ready = f.service.state();
  assert.equal(scope(ready).status, 'live'); assert.equal(ready.pending, false); assert.equal(scope(ready).fills[0].id, 'manual-fill');
  f.advance(1000); assert.equal(f.service.state().source.checkedAt, ready.source.checkedAt);
  assert.equal(JSON.stringify(ready).includes(OWNER), false);
  const rh = ready.source.data.exchanges.find(row => row.id === 'rh-lighter').accounts[0];
  assert.equal(rh.name, '当前实盘连接账户'); assert.match(rh.revision, /^[a-f0-9]{64}$/);
  assert.equal(f.calls[0][1].end - f.calls[0][1].start, 85 * DAY);
});

test('native evidence peek never refreshes and discards changed connection identities', async t => {
  const f = fixture(t); f.bindings[1].connected = true;
  assert.equal(scope(f.service.peek()).fills.length, 0);
  await tick(); assert.equal(f.calls.length, 0);
  f.service.state(); await tick();
  assert.equal(scope(f.service.peek()).fills.length, 1);
  f.advance(300_001);
  assert.equal(scope(f.service.peek()).status, 'stale');
  await tick(); assert.equal(f.calls.length, 1);
  f.bindings[1].revision++;
  assert.deepEqual(scope(f.service.peek()).fills, []);
  await tick(); assert.equal(f.calls.length, 1);
});

test('failed refresh preserves rows and success time, uses safe errors and respects retryAt', async t => {
  const f = fixture(t); f.bindings[1].connected = true;
  f.service.state(); await tick(); const original = scope(f.service.state());
  f.advance(300_000);
  f.reader = async () => { throw Object.assign(new Error('secret-token must never escape'), { rateLimited: true, retryAt: T0 + 500_000 }); };
  assert.equal(scope(f.service.state()).status, 'stale'); await tick();
  const failed = scope(f.service.state());
  assert.equal(failed.status, 'stale'); assert.equal(failed.fetchedAt, original.fetchedAt); assert.deepEqual(failed.fills, original.fills);
  assert.equal(failed.error, '交易所成交读取限流，稍后重试'); assert.equal(f.calls.length, 2);
  f.advance(199_999); f.service.state(); await tick(); assert.equal(f.calls.length, 2);
  f.advance(1); f.reader = async () => result('new-fill'); f.service.state(); await tick();
  assert.equal(scope(f.service.state()).fills[0].id, 'new-fill'); assert.equal(f.calls.length, 3);
});

test('native cache discards old rows on revision, identity and disconnect, including late success', async t => {
  const f = fixture(t); f.bindings[1].connected = true;
  let release;
  f.reader = () => new Promise(resolve => { release = resolve; });
  f.service.state(); await tick();
  f.bindings[1].revision += 1; f.reader = async () => result('new-account');
  assert.equal(scope(f.service.state()).status, 'loading'); assert.equal(f.calls[0][1].signal.aborted, true);
  release(result('old-account')); await tick();
  assert.equal(scope(f.service.state()).fills[0].id, 'new-account');
  f.bindings[1].identity = '0x' + 'cd'.repeat(20);
  assert.equal(scope(f.service.state()).fills.length, 0); await tick();
  f.bindings[1].connected = false;
  const disconnected = scope(f.service.state()); assert.equal(disconnected.status, 'unconfigured'); assert.equal(disconnected.fills.length, 0);
});

test('unsupported and first failure have explicit empty scopes, and stop aborts pending work', async t => {
  const f = fixture(t); f.bindings[1].connected = true;
  f.reader = async () => { throw Object.assign(new Error('unsupported'), { status: 501 }); };
  f.service.state(); await tick(); assert.equal(scope(f.service.state()).status, 'unsupported');
  f.advance(60_000); f.reader = async () => { throw new Error('failed'); };
  f.service.state(); await tick(); assert.equal(scope(f.service.state()).status, 'error');
  f.advance(60_000); f.reader = (_exchange, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  f.service.state(); await tick(); f.service.stop(); await f.service.close();
  assert.equal(f.calls.at(-1)[1].signal.aborted, true); assert.equal(scope(f.service.state()).status, 'unconfigured');
});

function executionFixture(t, history) {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const execution = createTradingExecution({ db, now: () => T0, intervalMs: 0, encrypt: JSON.stringify, decrypt: JSON.parse,
    clientFactory: exchange => ({ history: (...args) => { calls.push({ exchange, args }); return history(...args); } }) });
  const credentials = { purpose: 'execution', exchange: 'rh-lighter', address: OWNER, accountIndex: 12345, apiKeyIndex: 5, apiKey: 'ab'.repeat(40) };
  db.prepare('UPDATE execution_accounts SET revision=1,credentials=?,identity=? WHERE exchange=?').run(JSON.stringify(credentials), OWNER, 'rh-lighter');
  t.after(async () => { await execution.close(); db.close(); });
  const read = (patch = {}) => execution.readAnthropicHistory('rh-lighter', { revision: 1, identity: OWNER, start: T0 - DAY, end: T0, ...patch });
  return { db, execution, calls, read, credentials };
}

test('execution history bridge is read-only without a write lease and passes no mutation capability', async t => {
  const f = executionFixture(t, async () => result());
  f.db.prepare('DELETE FROM execution_lease').run();
  const before = f.db.prepare('SELECT * FROM execution_accounts').all();
  assert.deepEqual(await f.read(), result());
  assert.deepEqual(f.db.prepare('SELECT * FROM execution_accounts').all(), before);
  assert.equal(f.calls.length, 1); assert.deepEqual(Object.keys(f.calls[0].args[1]).sort(), ['end', 'signal', 'start']);
  assert.equal(f.calls[0].args[0].apiKey, f.credentials.apiKey);
  assert.equal(JSON.stringify(f.execution.historyConnections()).includes(f.credentials.apiKey), false);
  assert.deepEqual(f.execution.connectionOf('rh-lighter'), { revision: 1, connected: true });
  await assert.rejects(f.read({ revision: 0 }), error => error.status === 409);
  await assert.rejects(f.execution.readAnthropicHistory('binance', {}), error => error.status === 400);
  assert.equal(f.calls.length, 1);
});

test('execution history refuses late responses after revision or identity changes and closes promptly', async t => {
  for (const mutation of ['revision=revision+1', "identity='another-owner'", 'credentials=NULL']) {
    let release;
    const f = executionFixture(t, () => new Promise(resolve => { release = resolve; }));
    const pending = f.read(); f.db.prepare(`UPDATE execution_accounts SET ${mutation} WHERE exchange='rh-lighter'`).run();
    release(result()); await assert.rejects(pending, error => error.status === 409);
  }
  const f = executionFixture(t, () => new Promise(() => {}));
  const pending = f.read(); const rejected = assert.rejects(pending, error => error.code === 'aborted');
  await f.execution.close(); await rejected; assert.equal(f.calls[0].args[1].signal.aborted, true);
  await assert.rejects(f.read(), error => error.status === 409);
});

test('execution history enforces the 45-second total deadline for an uncooperative client', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = executionFixture(t, () => new Promise(() => {}));
  const pending = f.read(); const rejected = assert.rejects(pending, error => error.code === 'timeout');
  t.mock.timers.tick(45_000); await rejected;
  assert.equal(f.calls[0].args[1].signal.aborted, true);
  t.mock.timers.reset();
});

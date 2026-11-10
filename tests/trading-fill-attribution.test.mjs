import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createFillAttribution } from '../server/trading-fill-attribution.mjs';

const JOB = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const OWNER = '0x' + 'ab'.repeat(20), hash = (exchange, uid) => createHash('sha256').update(`${exchange}:${uid}`).digest('hex');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE execution_jobs(id TEXT PRIMARY KEY,json TEXT); CREATE TABLE execution_orders(id TEXT,job_id TEXT,json TEXT);
    CREATE TABLE execution_previews(consumed TEXT,json TEXT); CREATE TABLE execution_accounts(exchange TEXT,revision INTEGER,identity TEXT,account_mode TEXT);`);
  t.after(() => db.close());
  const legs = [{ id: 'bn', exchange: 'binance', symbol: 'ANTHROPICUSDT', side: 'short' }, { id: 'rh', exchange: 'rh-lighter', symbol: 'ANTHROPIC', side: 'long' }];
  const connections = [{ exchange: 'binance', revision: 3, identity: '123', accountMode: 'portfolio-margin' },
    { exchange: 'rh-lighter', revision: 4, identity: OWNER, accountMode: 'api-key' }];
  const job = { id: JOB, totals: legs, plan: { market: 'anthropic', legs, connections } };
  const order = { jobId: JOB, legId: 'bn', exchange: 'binance', accountRevision: 3, phase: 0, batch: 2, remoteId: '100', filledQuantity: '0',
    spec: { symbol: 'ANTHROPICUSDT', side: 'sell', positionSide: 'SHORT', quantity: '2' } };
  const saveJob = (value = job) => db.prepare('INSERT OR REPLACE INTO execution_jobs VALUES (?,?)').run(value.id, JSON.stringify(value));
  const saveOrder = (value = order, id = 'order') => db.prepare('INSERT INTO execution_orders VALUES (?,?,?)').run(id, value.jobId, JSON.stringify(value));
  saveJob(); saveOrder();
  const fill = { id: 'trade-1', orderId: '100', symbol: 'ANTHROPICUSDT', side: 'sell', positionSide: 'short', quantity: '1' };
  const scope = { id: 'pm-um', accountIdentity: hash('binance', '123'), fills: [fill] };
  const source = { projectId: 'asset', data: { exchanges: [{ id: 'binance', accounts: [{ id: 'default', scopes: [scope] }] }] } };
  const data = { sources: [source] }, attribute = createFillAttribution({ db });
  const run = () => attribute(data, null).sources[0].data.exchanges[0].accounts[0].scopes[0];
  return { db, job, order, saveJob, saveOrder, fill, scope, source, data, attribute, run };
}

test('real fill can precede local reconciliation; exact account/order evidence links it without mutating input or DB', t => {
  const f = fixture(t), before = JSON.stringify(f.data), changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  const output = f.run();
  assert.deepEqual(output.fills[0].execution, { jobId: JOB, phase: 0, batch: 2, comparisonLeg: 'rh', cex: 'binance' });
  assert.equal(output.accountIdentity, undefined); assert.equal(JSON.stringify(f.data), before);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('same order number on another UID, scope, contract, side or position direction remains unknown', t => {
  const f = fixture(t);
  for (const [target, field, value] of [[f.scope, 'accountIdentity', hash('binance', '456')], [f.scope, 'id', 'um'],
    [f.fill, 'symbol', 'BTCUSDT'], [f.fill, 'side', 'buy'], [f.fill, 'positionSide', 'net'], [f.fill, 'orderId', '101']]) {
    const old = target[field]; target[field] = value;
    assert.equal(f.run().fills[0].execution, undefined, field); target[field] = old;
  }
  delete f.scope.accountIdentity; assert.equal(f.run().fills[0].execution, undefined);
});

test('public attribution reasons reflect the actual branch without revealing foreign account candidates', t => {
  const f = fixture(t);
  assert.equal(f.run().fills[0].attribution.reason, 'matched');
  f.fill.side = 'buy'; assert.equal(f.run().fills[0].attribution.reason, 'direction-mismatch');
  f.scope.accountIdentity = hash('binance', 'foreign');
  assert.equal(f.run().fills[0].attribution.reason, 'insufficient-evidence');
  f.fill.orderId = 'unseen'; assert.equal(f.run().fills[0].attribution.reason, 'insufficient-evidence');
  delete f.fill.orderId; assert.equal(f.run().fills[0].attribution.reason, 'missing-order');
  assert.equal(JSON.stringify(f.run()).includes('foreign'), false);
});

test('resumed single remaining leg retains original combination and consumed preview account evidence', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO execution_previews VALUES (?,?)').run(JOB, JSON.stringify(f.job.plan));
  f.job.plan = { ...f.job.plan, legs: [f.job.totals[1]], connections: [f.job.plan.connections[1]] }; f.saveJob();
  assert.equal(f.run().fills[0].execution.comparisonLeg, 'rh');
  f.db.exec('DELETE FROM execution_previews'); assert.equal(f.run().fills[0].execution, undefined);
  f.db.prepare('INSERT INTO execution_accounts VALUES (?,?,?,?)').run('binance', 3, '123', 'portfolio-margin');
  assert.equal(f.run().fills[0].execution.jobId, JOB);
  f.db.exec('UPDATE execution_accounts SET revision=4'); assert.equal(f.run().fills[0].execution, undefined);
});

test('conflicting account evidence and duplicate task claims never choose the first match', t => {
  const f = fixture(t);
  f.db.prepare('INSERT INTO execution_previews VALUES (?,?)').run(JOB, JSON.stringify({ connections: [{ ...f.job.plan.connections[0], identity: '456' }] }));
  assert.equal(f.run().fills[0].execution, undefined);
  f.db.exec('DELETE FROM execution_previews');
  f.saveJob({ ...f.job, id: OTHER }); f.saveOrder({ ...f.order, jobId: OTHER }, 'other');
  assert.equal(f.run().fills[0].execution, undefined);
  assert.equal(f.run().fills[0].attribution.reason, 'ambiguous');
});

test('RH native attribution binds the current connection revision as well as its L1 identity', t => {
  const f = fixture(t);
  f.saveOrder({ ...f.order, legId: 'rh', exchange: 'rh-lighter', accountRevision: 4, remoteId: '99',
    spec: { symbol: 'ANTHROPIC', side: 'buy', positionSide: 'BOTH' } }, 'rh-order');
  const native = { data: { exchanges: [{ id: 'rh-lighter', accounts: [{ id: '12345', scopes: [{ id: 'perpetual', fills: [{ orderId: '99', symbol: 'ANTHROPIC', side: 'buy', positionSide: 'net' }] }] }] }] } };
  f.data.sources.push(native);
  const binding = { exchange: 'rh-lighter', connected: true, revision: 4, identity: OWNER };
  const read = () => f.attribute(f.data, native, [binding]).sources[1].data.exchanges[0].accounts[0].scopes[0].fills[0];
  assert.equal(read().execution.jobId, JOB);
  binding.revision++; assert.equal(read().execution, undefined, 'same L1 address can have a different RH account index');
  binding.revision--; binding.connected = false; assert.equal(read().execution, undefined);
});

test('OKX native instrument identity and all comparison contracts are mapped independently', t => {
  const f = fixture(t);
  f.db.exec('DELETE FROM execution_orders');
  Object.assign(f.job.totals[0], { exchange: 'okx' });
  f.job.plan.connections[0] = { exchange: 'okx', revision: 3, identity: '123', accountMode: 'cross' };
  Object.assign(f.order, { exchange: 'okx', spec: { ...f.order.spec, instrumentId: 'ANTHROPIC-USDT-SWAP' } }); f.saveOrder();
  f.source.data.exchanges[0].id = 'okx'; f.scope.accountIdentity = hash('okx', '123'); f.scope.id = 'SWAP'; f.fill.symbol = 'ANTHROPIC-USDT-SWAP';
  for (const [exchange, symbol, comparison] of [['rh-lighter', 'ANTHROPIC', 'rh'], ['hyperliquid', 'xyz:ANT', 'xyz'], ['hyperliquid', 'io:ANTH', 'io']]) {
    Object.assign(f.job.totals[1], { exchange, symbol }); f.saveJob();
    assert.equal(f.run().fills[0].execution.comparisonLeg, comparison);
  }
  f.job.totals.push({ ...f.job.totals[1], id: 'third' }); f.saveJob();
  assert.equal(f.run().fills[0].execution, undefined, 'a shared CEX leg across multiple counterparts is ambiguous');
});

test('a claimed association from an upstream response is discarded without local proof', t => {
  const f = fixture(t); f.fill.execution = { jobId: OTHER, comparisonLeg: 'xyz' };
  delete f.fill.orderId;
  assert.equal(f.run().fills[0].execution, undefined);
});

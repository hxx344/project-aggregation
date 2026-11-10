import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createExecutionEvidence, reductionCosts } from '../server/trading-execution-evidence.mjs';

const JOB = '11111111-1111-4111-8111-111111111111';
const job = { id: JOB, status: 'completed', phase: 1, plan: { market: 'anthropic', action: 'close', connections: [{ identity: 'private-uid', apiSecret: 'never-export' }] } };
const fill = (id, quantity, price, extra = {}) => ({ id, orderId: 'order-1', symbol: 'ANTHROPICUSDT', quantity, price, priceCurrency: 'USDT', fee: '-0.1', feeCurrency: 'USDT',
  time: '2026-11-09T00:00:00.000Z', execution: { jobId: JOB, phase: 1, batch: 2 }, ...extra });
const data = fills => ({ generatedAt: '2026-11-10T00:00:00.000Z', sources: [{ data: { exchanges: [{ id: 'binance', accounts: [{ id: 'default', scopes: [
  { id: 'um', status: 'live', coverageStart: '2026-11-01T00:00:00.000Z', coverageEnd: '2026-11-10T00:00:00.000Z', truncated: false, fills },
] }] }] } }] });

test('costs use deduplicated actual fills, preserve phases/currencies, and never fabricate a slippage baseline', () => {
  const source = data([fill('a', '1', '100'), fill('b', '3', '110', { fee: null })]);
  source.sources.push(structuredClone(source.sources[0]));
  source.sources[1].data.exchanges[0].accounts[0].id = 'same-real-account-another-source';
  source.sources[0].data.exchanges.push({ id: 'rh-lighter', accounts: [{ id: 'native', scopes: [{ id: 'perpetual', fills: [
    fill('native-a', '0.1', '800', { symbol: 'ANTHROPIC', priceCurrency: 'USDG', fee: '-0.02', feeCurrency: 'USDG', time: '2026-11-09T00:00:00.250Z' }),
  ] }] }] });
  const before = JSON.stringify(source), result = reductionCosts(job, source), batch = result.batches[0];
  assert.equal(result.batches.length, 1); assert.equal(batch.phase, 1); assert.equal(batch.batch, 2);
  assert.equal(batch.legs[0].quantity, '4'); assert.equal(batch.legs[0].averagePrice, '107.5'); assert.equal(batch.legs[0].fillCount, 2);
  assert.equal(batch.legs[0].feesComplete, false); assert.deepEqual(batch.legs[0].fees, [{ currency: 'USDT', value: '-0.1' }]);
  assert.equal(batch.legs[1].priceCurrency, 'USDG'); assert.equal(batch.completionGapMs, 250);
  assert.equal(batch.legs[0].slippage, null); assert.match(batch.legs[0].slippageReason, /未持久化/);
  assert.equal(JSON.stringify(source), before);
  assert.equal(reductionCosts({ ...job, status: 'running' }, source), null);
  assert.equal(batch.legs[0].coverageComplete, false, 'fills alone cannot prove every settled order is covered');
  const proved = reductionCosts(job, data([fill('one', '1', '100')]), [{ exchange: 'binance', symbol: 'ANTHROPICUSDT', phase: 1, batch: 2,
    remoteId: 'order-1', filledQuantity: '1', unknown: false, settled: true, createdAt: '2026-11-08T00:00:00Z', lastCheckedAt: '2026-11-09T01:00:00Z' }]);
  assert.equal(proved.batches[0].legs[0].coverageComplete, true); assert.equal(proved.batches[0].legs[0].feesComplete, true);
});

test('conflicting fills invalidate costs and unknown timestamps/fees remain unknown', () => {
  const source = data([fill('same', '1', '100'), fill('same', '1', '101')]);
  assert.deepEqual(reductionCosts(job, source).batches, []);
  assert.equal(reductionCosts(job, source).conflicts, 1);
  const single = reductionCosts(job, data([fill('one', '1', '100', { fee: null, time: null })])).batches[0];
  assert.equal(single.completionGapMs, null); assert.equal(single.legs[0].lastFillAt, null); assert.equal(single.legs[0].feesComplete, false);
  assert.match(reductionCosts(job, null).gaps.join(' '), /尚未取得/);
});

test('single-job export is a bounded read-only scalar whitelist and preserves uncertain order quantities', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE execution_jobs(id TEXT,json TEXT); CREATE TABLE execution_orders(job_id TEXT,json TEXT)');
  const saveJob = db.prepare('INSERT INTO execution_jobs VALUES (?,?)'), saveOrder = db.prepare('INSERT INTO execution_orders VALUES (?,?)');
  saveJob.run(JOB, JSON.stringify({ ...job, events: [{ time: '2026-11-09T00:00:00Z', message: 'secret upstream payload', level: 'warning' }] }));
  saveOrder.run(JOB, JSON.stringify({ jobId: JOB, localId: 'local-1', remoteId: 'remote-1', phase: 1, batch: 2, unknown: true, filledQuantity: '0', state: 'unknown',
    spec: { quantity: '2', symbol: 'ANTHROPICUSDT', side: 'buy', apiSecret: 'never-export' }, writerOperation: { operationId: 'hub:create:local-1', action: 'create', state: 'unknown', payload: { signature: 'never-export' } } }));
  saveOrder.run('another-job', JSON.stringify({ jobId: 'another-job', remoteId: 'cross-job-private' }));
  const changes = db.prepare('SELECT total_changes() AS n').get().n, exported = await createExecutionEvidence({ db, readFills: () => data([]) })(JOB);
  assert.equal(exported.version, 1); assert.equal(exported.orders.length, 1); assert.equal(exported.orders[0].filledQuantity, null);
  assert.equal(exported.orders[0].lastKnownFilledQuantity, '0'); assert.equal(exported.orders[0].operation.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(exported), /never-export|secret upstream|private-uid|cross-job-private|signature|apiSecret/);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(await createExecutionEvidence({ db })('../not-a-job'), null);
});

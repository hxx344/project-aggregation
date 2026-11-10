import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAccountWriter } from '../server/execution/account-writer.mjs';

test('job evidence follows each original order attempt, rejects foreign group/module identities, and never writes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-evidence-'));
  const writer = createAccountWriter({ databasePath: path.join(directory, 'control.sqlite'), moduleId: 'hub', runtimeId: randomUUID() });
  t.after(() => { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const identity = { authority: 'binance', environment: 'mainnet', accountId: '12345' };
  writer.bind('hub:binance', identity, 1); const ticket = writer.claim([identity]);
  const jobId = randomUUID(), localId = randomUUID(), otherJob = randomUUID();
  for (const action of ['create', 'amend', 'cancel']) {
    const operationId = `hub:${action}:${localId}${action === 'create' ? '' : ':1'}`;
    const operation = writer.prepare(ticket, operationId, { groupId: `hub:${jobId}:0:0:${action}`, action, symbol: 'ANTHROPICUSDT', quantity: '1' });
    writer.finish(operation, action === 'cancel' ? 'unknown' : 'confirmed');
  }
  const before = writer.db.prepare('SELECT total_changes() AS n').get().n;
  const evidence = writer.executionEvidence(jobId, [localId]);
  assert.equal(evidence.attempts.length, 3); assert.ok(evidence.attempts.some(row => row.operationId.endsWith(':1') && row.state === 'unknown'));
  assert.equal(writer.executionEvidence(otherJob, [localId]).attempts.length, 0);
  assert.equal(writer.executionEvidence(jobId, [randomUUID()]).attempts.length, 0);
  assert.throws(() => writer.executionEvidence(jobId, ['%']), /identity/);
  assert.equal(writer.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.doesNotMatch(JSON.stringify(evidence), /12345|account_key|body_hash|ticket_json|signature/);
});

test('4,000 orders and 16,000 attempts use indexed bounded candidates within the read deadline', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-evidence-scale-'));
  const writer = createAccountWriter({ databasePath: path.join(directory, 'control.sqlite'), moduleId: 'hub', runtimeId: randomUUID() });
  t.after(() => { writer.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const jobId = randomUUID(), localIds = Array.from({ length: 4000 }, () => randomUUID());
  const insert = writer.db.prepare('INSERT INTO aw_operations(operation_id,module_id,body_hash,account_keys,owner_id,ticket_json,state,created_at,updated_at,group_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
  const seed = (attempts) => {
    writer.db.exec('BEGIN');
    try {
      for (const localId of localIds) for (let attempt = 0; attempt < attempts; attempt++) {
        const action = attempts === 1 ? 'create' : 'amend', id = `hub:${action}:${localId}${attempts === 1 ? '' : ':' + attempt}`;
        insert.run(id, 'hub', 'synthetic-hash', '[]', writer.ownerId, '{}', 'unknown', attempt, attempt, `hub:${jobId}:0:0:${action}`);
      }
      writer.db.exec('COMMIT');
    } catch (error) { writer.db.exec('ROLLBACK'); throw error; }
  };
  const plans = writer.db.prepare('EXPLAIN QUERY PLAN SELECT operation_id FROM aw_operations WHERE operation_id>=? AND operation_id<? ORDER BY operation_id LIMIT ?')
    .all('hub:amend:' + localIds[0] + ':', 'hub:amend:' + localIds[0] + ':\uffff', 4001);
  assert.ok(plans.some(row => /SEARCH .*INDEX .*operation_id>\? AND operation_id<\?/.test(row.detail)), JSON.stringify(plans));
  assert.ok(plans.every(row => !/SCAN aw_operations|USE TEMP B-TREE/.test(row.detail)));
  for (const attempts of [1, 4]) {
    writer.db.exec('DELETE FROM aw_operations'); seed(attempts);
    const writes = writer.db.prepare('SELECT total_changes() AS n').get().n, started = performance.now();
    const result = writer.executionEvidence(jobId, localIds), elapsed = performance.now() - started;
    assert.equal(result.attempts.length, 4000); assert.equal(result.truncated, attempts > 1);
    assert.equal(result.scannedCandidates, attempts === 1 ? 4000 : 4001); assert.ok(result.ordersVisited <= 4000);
    assert.ok(elapsed < 4000, `indexed ${4000 * attempts} operations took ${elapsed.toFixed(1)}ms (UI deadline is 12s)`);
    assert.equal(writer.db.prepare('SELECT total_changes() AS n').get().n, writes);
    t.diagnostic(`${4000 * attempts} operations / 4000 orders: ${elapsed.toFixed(1)}ms; candidates=${result.scannedCandidates}; ordersVisited=${result.ordersVisited}`);
  }
  // Filtering occurs after the candidate budget: even malformed/foreign rows cannot hide an unbounded scan.
  writer.db.prepare('UPDATE aw_operations SET module_id=?').run('foreign');
  const foreign = writer.executionEvidence(jobId, localIds);
  assert.equal(foreign.attempts.length, 0); assert.equal(foreign.scannedCandidates, 4001); assert.equal(foreign.truncated, true);
});

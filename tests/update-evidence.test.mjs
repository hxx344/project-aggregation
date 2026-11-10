import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUpdateDiagnostic } from '../server/update-evidence.mjs';
import { createModuleUpdateGuard } from '../server/modules/updates.mjs';

test('update diagnostic whitelist binds one job and never promotes liveness to health or rollback success', () => {
  const jobId = 'a'.repeat(32), at = '2026-11-10T00:00:00.000Z';
  const input = { schemaVersion: 1, jobId, job: { id: jobId, status: 'failed', startedAt: at, finishedAt: at, deployMode: 'source', scope: 'full', phase: 'activate',
    steps: [{ id: 'hub', status: 'failed', message: 'credential-do-not-export' }], config: { token: 'credential-do-not-export' } },
    versions: [{ id: 'hub', fromCommit: 'b'.repeat(40), targetCommit: 'c'.repeat(40), source: '/private/path' }],
    observation: { observedAt: at, units: [{ unit: 'project-aggregation.service', activeState: 'active', subState: 'running', environment: 'credential-do-not-export' }] },
    health: { status: 'passed' }, rollback: { status: 'succeeded' }, missing: ['raw-logs-excluded'], log: 'credential-do-not-export' };
  const output = publicUpdateDiagnostic(input, jobId);
  assert.equal(output.observation.units[0].activeState, 'active');
  assert.equal(output.health.status, 'unknown'); assert.equal(output.rollback.status, 'unknown');
  assert.ok(!JSON.stringify(output).includes('credential-do-not-export'));
  assert.ok(!JSON.stringify(output).includes('/private/path'));
  assert.throws(() => publicUpdateDiagnostic(input, 'd'.repeat(32)));
  assert.throws(() => publicUpdateDiagnostic({ ...input, job: { ...input.job, status: 'running' } }, jobId));
});

test('display impact uses only bounded GETs and never calls ASTER stop admission', async () => {
  const calls = [];
  const guard = createModuleUpdateGuard({ request: async (origin, route, options) => {
    calls.push({ origin, route, options });
    assert.equal(options.method, undefined); assert.equal(options.body, undefined);
    assert.ok(options.deadline <= Date.now() + 4000);
    if (origin.includes('aster')) { assert.equal(route, '/__workspace/update-impact'); return { data: { busy: null, activeRequests: 0, requiresFinalCheck: true } }; }
    if (origin.includes('greeks')) throw new Error('unavailable with private response');
    return { data: { busy: true, reason: 'private response should not escape' } };
  } });
  const value = await guard.readImpact();
  assert.equal(calls.length, 3);
  assert.equal(value.find(row => row.moduleId === 'crossex').busy, true);
  assert.equal(value.find(row => row.moduleId === 'greeks').busy, null);
  assert.equal(value.find(row => row.moduleId === 'aster').reasonCode, 'final-order-check-required');
  assert.ok(!JSON.stringify(value).includes('private response'));
});

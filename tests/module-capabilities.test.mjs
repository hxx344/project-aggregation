import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleCapabilities, readModuleCapabilities } from '../server/modules/capabilities.mjs';

test('five capability contracts distinguish summary, maintenance and future account protection', async () => {
  for (const [id, summaries, maintenance] of [['monitor', [1, 2], null], ['asset', [2], null], ['crossex', [1, 2], 1], ['greeks', [2], 1], ['aster', [2], 1]]) {
    const contract = moduleCapabilities(id);
    assert.deepEqual(contract.summaryVersions, summaries); assert.equal(contract.maintenanceVersion, maintenance);
    assert.equal(contract.readinessVersion, null); assert.equal(contract.accountWriterVersion, maintenance === 1 ? 1 : null);
    assert.equal(contract.recoveryProtectionVersion, maintenance === 1 ? 1 : null);
    const result = await readModuleCapabilities(id, { request: async (origin, route, options) => {
      assert.equal(origin, `http://${id}.workspace.internal`); assert.equal(route, '/__workspace/capabilities');
      assert.ok(options.deadline <= Date.now() + 5000); assert.equal(options.limit, 16 * 1024);
      return { data: JSON.parse(JSON.stringify(contract)) };
    } });
    assert.deepEqual(result, contract);
    contract.summaryVersions.push(99); assert.deepEqual(moduleCapabilities(id).summaryVersions, summaries);
  }
  for (const id of ['unknown', '__proto__', 'toString']) assert.throws(() => moduleCapabilities(id), /Unknown/);
});

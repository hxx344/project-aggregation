import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Gate asset connection lifecycle through the built production API', { timeout: 150_000 }, () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./asset-gate.smoke.mjs', import.meta.url))], {
    encoding: 'utf8', windowsHide: true, timeout: 140_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

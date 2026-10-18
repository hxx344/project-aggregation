import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('actual index drains a partially started group before releasing its lock after startup lock loss', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./fixtures/index-lock-loss.mjs', import.meta.url))], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const events = JSON.parse(result.stdout);
  assert.ok(events.indexOf('workers-close') > events.indexOf('lost'));
  assert.ok(events.indexOf('workers-closed') < events.indexOf('lock-close'));
  assert.ok(events.indexOf('lock-close') < events.indexOf('exit:1'));
  assert.equal(events.includes('app-create'), false); assert.equal(events.includes('listen'), false);
});

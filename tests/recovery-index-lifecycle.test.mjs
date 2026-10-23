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
  // The lost lock already logged the cause, so the aborted startup is a warning rather than a startup failure.
  assert.ok(events.includes('error:数据目录运行锁失效'), result.stdout);
  assert.ok(events.indexOf('warn:工作台启动已中止') < events.indexOf('exit:1'), result.stdout);
  assert.equal(events.includes('error:工作台启动失败'), false);
});

test('actual index ends the first-start contract only after listening and resynchronizes just the restarted module', () => {
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./fixtures/index-lock-loss.mjs', import.meta.url)), 'serve'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const events = JSON.parse(result.stdout);
  assert.ok(events.includes('runtime-passed'), 'the supervisor is passed to the workbench');
  assert.equal(events.filter(event => event === 'mark-started').length, 1);
  assert.ok(events.indexOf('listening') < events.indexOf('mark-started'), result.stdout);
  assert.equal(events.at(-1), 'resync:greeks');
});

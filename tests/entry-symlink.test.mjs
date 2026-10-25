import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// systemd starts the entries through the `current` release symlink. Each entry
// is given settings it refuses at once, so a non-zero exit with its own
// message proves its main block ran instead of exiting 0 without starting.
const skip = process.platform === 'win32' ? 'POSIX release symlink only' : false;

test('service and recovery entries start through a symlinked release path', { skip }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'main-module-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current');
  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), current, 'dir');
  const notDirectory = path.join(dir, 'file');
  writeFileSync(notDirectory, '');
  const cases = [
    { entry: 'server/runtime/main.mjs', env: { DATA_DIR: notDirectory }, output: '运行时启动失败' },
    { entry: 'server/api/main.mjs', env: { DATA_DIR: dir }, output: '运行时尚未初始化数据目录' },
    { entry: 'server/launcher.mjs', env: { PORT: '0' }, output: '工作台配置无效' },
    { entry: 'server/recovery/cli.mjs', env: {}, output: 'RECOVERY_' },
  ];
  for (const { entry, env, output } of cases) {
    const result = spawnSync(process.execPath, [path.join(current, entry)], { cwd: current, env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 1, `${entry}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, new RegExp(output), entry);
  }
});

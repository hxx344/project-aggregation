import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../server/index.mjs', import.meta.url));

test('a failed startup logs its cause before exiting with status 1', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-startup-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A regular file where the data directory belongs makes the first startup step fail on every platform.
  const dataDir = path.join(directory, 'not-a-directory');
  await writeFile(dataDir, '');
  const child = spawn(process.execPath, [entry], { env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', DATA_DIR: dataDir, PORT: '3199' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 20000);
  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 1, stdout);
  const failure = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(record => record?.type === 'startup' && record.msg === '工作台启动失败');
  assert.ok(failure, stdout);
  assert.equal(failure.level, 'error');
  assert.match(failure.err?.code ?? '', /^E(EXIST|NOTDIR)$/, JSON.stringify(failure.err));
});

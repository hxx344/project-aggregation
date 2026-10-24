import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { passwordMatches } from '../server/control/password.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../server/setup.mjs', import.meta.url));
const reset = dataDir => run(process.execPath, [script, '--reset-password'], { env: { ...process.env, DATA_DIR: dataDir } });

async function dataDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'setup-reset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('password reset replaces the hash and revokes sessions without reseeding or opening the data plane', async t => {
  const dir = await dataDir(t);
  const app = await createApp({ dataDir: dir, initialPassword: 'setup-reset-initial-password', refreshInterval: 0, assetSyncIntervalMs: 0, logger: () => {} });
  await app.close();
  const db = new DatabaseSync(path.join(dir, 'hub.sqlite'));
  t.after(() => db.close());
  // A deleted preset stays deleted only while its marker is respected; the reset must not run seeding at all.
  db.prepare("DELETE FROM settings WHERE key='seeded-variational-v1'").run();
  db.prepare("DELETE FROM projects WHERE id='variational'").run();
  db.prepare('INSERT INTO sessions(id,csrf,expires) VALUES (?,?,?)').run('session', 'csrf', Date.now() + 60000);
  const projects = db.prepare('SELECT id,json FROM projects ORDER BY id').all();

  const { stdout } = await reset(dir);
  const password = /新的工作台登录密码：(\S+)/.exec(stdout)?.[1];
  assert.ok(password);
  assert.equal(await passwordMatches(password, db.prepare("SELECT value FROM settings WHERE key='password'").get().value), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  assert.deepEqual(db.prepare('SELECT id,json FROM projects ORDER BY id').all(), projects);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='seeded-variational-v1'").get(), undefined);
  assert.equal(existsSync(path.join(dir, 'execution-control.sqlite')), false);
});

test('password reset refuses an uninitialized data directory without creating the database', async t => {
  const dir = await dataDir(t);
  await assert.rejects(reset(dir), error => error.code === 1 && /工作台尚未初始化/.test(error.stderr));
  assert.equal(existsSync(path.join(dir, 'hub.sqlite')), false);
  assert.equal(existsSync(path.join(dir, 'credentials.key')), false);
});

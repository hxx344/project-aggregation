import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, readLock, LockError, isProcessAlive } from '../deploy/pipeline/state.mjs';
import { gitContext } from '../deploy/pipeline/cli.mjs';
import { ConfigError } from '../deploy/pipeline/config.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-failures-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'prod.lock');
}

test('锁发布前读取不会看到空锁，发布后只可读到完整内容', t => {
  const file = fixture(t);
  const write = fs.writeFileSync, link = fs.linkSync;
  let beforeWrite = false, beforePublish = false;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (String(target).endsWith('.tmp')) {
      beforeWrite = true;
      assert.equal(readLock(file), null);
      assert.throws(() => acquireLock(file, { runId: 'competitor' }), LockError);
    }
    return write(target, ...args);
  });
  t.mock.method(fs, 'linkSync', (source, target) => {
    beforePublish = true;
    assert.equal(readLock(target), null);
    assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).runId, 'owner');
    link(source, target);
    assert.equal(readLock(target).runId, 'owner');
    assert.throws(() => acquireLock(file, { runId: 'competitor' }), LockError);
  });
  const lock = acquireLock(file, { runId: 'owner' });
  assert.ok(beforeWrite && beforePublish);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['prod.lock']);
  lock.release();
});

test('损坏锁与无效字段不是缺失锁，仅允许按 mtime 回收过期锁', t => {
  const file = fixture(t), now = Date.now(), staleMs = 1000;
  for (const content of ['', '{', 'null', '{"pid":0}', '{"pid":1,"startedAt":"invalid"}']) {
    fs.writeFileSync(file, content);
    fs.utimesSync(file, new Date(now), new Date(now));
    assert.throws(() => readLock(file), LockError);
    assert.throws(() => acquireLock(file, { runId: 'new', now, staleMs }), /内容无效且尚未超时/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    fs.utimesSync(file, new Date(now - 2000), new Date(now - 2000));
    const lock = acquireLock(file, { runId: 'new', now, staleMs });
    assert.equal(readLock(file).runId, 'new');
    lock.release();
  }
});

test('读取锁发生权限或 I/O 错误时拒绝回收与释放', t => {
  const file = fixture(t), lock = acquireLock(file, { runId: 'owner' });
  const open = fs.openSync;
  for (const code of ['EACCES', 'EIO']) {
    const stub = t.mock.method(fs, 'openSync', (target, ...args) => {
      if (target === file) throw Object.assign(new Error('synthetic failure'), { code });
      return open(target, ...args);
    });
    assert.throws(() => readLock(file), error => error instanceof LockError && error.message.includes(code));
    assert.throws(() => acquireLock(file, { runId: 'other', now: Date.now() + 86400000 }), LockError);
    assert.throws(() => lock.release(), LockError);
    assert.equal(fs.existsSync(file), true);
    stub.mock.restore();
    assert.equal(readLock(file).runId, 'owner');
  }
  lock.release();
});

test('活锁不被竞争者删除，过期回收后的旧 release 不删除同 pid/run 的新锁', t => {
  const file = fixture(t), now = Date.now();
  const first = acquireLock(file, { runId: 'same', now, staleMs: 1000 });
  const token = readLock(file).token;
  assert.throws(() => acquireLock(file, { runId: 'other', now, staleMs: 1000 }), LockError);
  assert.equal(readLock(file).token, token);
  const second = acquireLock(file, { runId: 'same', now: now + 2000, staleMs: 1000 });
  const replacementToken = readLock(file).token;
  assert.notEqual(replacementToken, token);
  first.release();
  assert.equal(readLock(file).token, replacementToken);
  assert.equal(readLock(file).runId, 'same');
  second.release();
  assert.equal(readLock(file), null);
});

test('回收过程拒绝另一个回收者，遗留保护目录拒绝继续', t => {
  const file = fixture(t);
  fs.writeFileSync(file, '{}');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(file, old, old);
  const unlink = fs.unlinkSync;
  let attempted = false;
  const stub = t.mock.method(fs, 'unlinkSync', target => {
    if (target === file) {
      attempted = true;
      assert.throws(() => acquireLock(file, { runId: 'competitor' }), /保护目录/);
    }
    unlink(target);
  });
  const lock = acquireLock(file, { runId: 'owner' });
  assert.equal(attempted, true);
  stub.mock.restore();
  lock.release();
  fs.mkdirSync(`${file}.guard`);
  assert.throws(() => acquireLock(file, { runId: 'blocked' }), /人工清理/);
  assert.equal(fs.existsSync(file), false);
});

test('竞争者短暂持有保护目录时持有者仍能释放，长期遗留才报错', t => {
  const file = fixture(t), guard = `${file}.guard`;
  const lock = acquireLock(file, { runId: 'owner' });
  const mkdir = fs.mkdirSync;
  let busy = 3;
  const stub = t.mock.method(fs, 'mkdirSync', (target, ...args) => {
    if (target === guard && busy > 0) { busy -= 1; throw Object.assign(new Error('guard held'), { code: 'EEXIST' }); }
    return mkdir(target, ...args);
  });
  lock.release();
  assert.equal(busy, 0);
  assert.equal(fs.existsSync(file), false);
  stub.mock.restore();
  const held = acquireLock(file, { runId: 'owner' });
  fs.mkdirSync(guard);
  assert.throws(() => held.release(), /人工清理/);
  assert.equal(fs.existsSync(file), true);
  fs.rmdirSync(guard);
  held.release();
});

test('经目录链接启动 CLI 仍会执行而不是静默退出', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const linked = path.join(directory, 'pipeline');
  fs.symlinkSync(path.resolve('deploy/pipeline'), linked, 'junction');
  const result = spawnSync(process.execPath, [path.join(linked, 'cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(result.stdout + result.stderr, /用法：node deploy\/pipeline\/cli\.mjs/);
});

test('不能识别的进程探测错误不作为进程退出', t => {
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('probe failure'), { code: 'EIO' }); });
  assert.throws(() => isProcessAlive(123), LockError);
});

const commit = 'a'.repeat(40);
function gitStub(failedCommand, failure, calls = []) {
  return (_command, args, options) => {
    const command = args.join(' ');
    calls.push({ command, options });
    if (command === failedCommand) throw failure;
    return ({ 'rev-parse HEAD': commit, 'rev-parse --abbrev-ref HEAD': 'main', 'describe --tags --exact-match': 'deploy-test', 'status --porcelain': '' })[command];
  };
}

test('提交、分支和 status 失败都中止，不能产出 dirty:false', () => {
  for (const command of ['rev-parse HEAD', 'rev-parse --abbrev-ref HEAD', 'status --porcelain']) {
    const failure = Object.assign(new Error('git failed'), { status: 128, stderr: 'fatal: cannot read index' });
    assert.throws(() => gitContext('.', gitStub(command, failure)), error => error instanceof ConfigError && error.message.includes(command) && error.message.includes('cannot read index'));
  }
});

test('只有确切的无标签失败可容错，其他 describe 错误仍中止', () => {
  for (const stderr of [`fatal: no tag exactly matches '${commit}'\n`, 'fatal: No names found, cannot describe anything.\n']) {
    const calls = [];
    const context = gitContext('.', gitStub('describe --tags --exact-match', { status: 128, stderr }, calls));
    assert.deepEqual(context, { commit, branch: 'main', tag: '', dirty: false });
    assert.ok(calls.every(({ options }) => options.timeout === 10000 && options.env.LC_ALL === 'C'));
    assert.equal(calls.filter(({ command }) => command === 'describe --tags --exact-match').length, 1);
  }
  for (const failure of [
    { status: 128, stderr: 'fatal: not a git repository' },
    { status: 128, stderr: 'fatal: unable to read object' },
    { code: 'ETIMEDOUT', signal: 'SIGTERM' },
    { status: 128, signal: 'SIGTERM', stderr: 'fatal: No names found, cannot describe anything.' },
  ]) assert.throws(() => gitContext('.', gitStub('describe --tags --exact-match', failure)), ConfigError);
});

test('没有 Git 元数据的归档不能生成可发布上下文', t => {
  const file = fixture(t);
  assert.throws(() => gitContext(path.dirname(file)), error => error instanceof ConfigError && /rev-parse HEAD/.test(error.message));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STAGES } from '../deploy/pipeline/stages.mjs';
import { hashFile } from '../deploy/pipeline/digest.mjs';
import { runCommand } from '../deploy/pipeline/exec.mjs';
import { acquireLock, readLock, LockError } from '../deploy/pipeline/state.mjs';
import { loadProfile } from '../deploy/pipeline/config.mjs';
import { snapshotFile } from '../deploy/pipeline/config-files.mjs';
import { parseGithubRepository } from '../deploy/pipeline/identity.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.PIPELINE_TEST_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const temporary = t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pipeline-recovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const nodeCommand = (source, args = []) => ({ cmd: process.execPath, args: ['-e', source, ...args], timeoutMs: 10000 });
const quiet = { info() {}, warn() {}, error() {} };
const commit = 'a'.repeat(40);

function fixture(t, stages) {
  const directory = temporary(t);
  cpSync(path.join(root, 'deploy/pipeline'), path.join(directory, 'deploy/pipeline'), { recursive: true });
  const profile = {
    schema: 1, description: '隔离流水线失败夹具', toolchain: { node: '>=22.0.0', pnpm: '>=11.0.0' },
    triggers: { local: {} }, config: [], stages,
  };
  const profileFile = path.join(directory, 'deploy/pipeline/environments/dev.json');
  const save = () => writeFileSync(profileFile, JSON.stringify(profile));
  save();
  const pnpmStub = path.join(directory, 'pnpm-fixture.mjs');
  writeFileSync(pnpmStub, "process.stdout.write('11.25.0\\n');");
  const environment = {};
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(directory, 'deploy/pipeline/cli.mjs'), 'run', '--env', 'dev', ...args], {
      cwd: directory, env: { ...process.env, ...environment, npm_execpath: pnpmStub }, encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(result.error);
    return result;
  };
  const state = () => JSON.parse(readFileSync(path.join(directory, '.pipeline/state/dev.json'), 'utf8'));
  const summary = () => JSON.parse(readFileSync(path.join(directory, '.pipeline/runs', state().lastRunId, 'summary.json'), 'utf8'));
  return { directory, profile, save, run, state, summary, environment };
}

function unconfirmedExecutor(f, stage) {
  const file = path.join(f.directory, 'deploy/pipeline/exec.mjs');
  writeFileSync(path.join(f.directory, 'deploy/pipeline/exec-real.mjs'), readFileSync(file));
  writeFileSync(file, [
    "import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';",
    "import {runCommand as real} from './exec-real.mjs';",
    "export {CommandError,probeVersion,formatInvocation} from './exec-real.mjs';",
    "export const runCommand = options => {",
    `if(options.stageId!==${JSON.stringify(stage)}) return real(options);`,
    "const child=Object.assign(new EventEmitter(),{pid:999999,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough(),unref(){},kill(){return true;}});",
    "return real({...options,platform:'win32',spawnImpl:()=>child,timeoutMs:10,termGraceMs:20,killGraceMs:30});};",
  ].join('\n'));
}

function quarantineWriteFailure(f) {
  const file = path.join(f.directory, 'quarantine-fault.mjs');
  writeFileSync(file, [
    "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';",
    "const original=fs.writeFileSync;",
    "fs.writeFileSync=function(file,data,...args){",
    "if(String(data).includes('\"terminationUnconfirmed\":')) throw Object.assign(new Error('隔离记录磁盘已满'),{code:'ENOSPC'});",
    "return original.call(this,file,data,...args);}; syncBuiltinESMExports();",
  ].join('\n'));
  f.environment.NODE_OPTIONS = `--import=${pathToFileURL(file).href}`;
}

test('真实 CLI 只复用成功摘要：原样跳过、改写和删除重建，旧状态与失败安全失效', t => {
  const f = fixture(t, {
    build: { inputs: ['input.txt'], outputs: ['artifact.txt'], commands: [nodeCommand(
      "const fs=require('node:fs');fs.writeFileSync('artifact.txt',fs.readFileSync('input.txt'));fs.appendFileSync('calls.txt','x');if(fs.existsSync('fail'))process.exit(1);",
    )] },
  });
  writeFileSync(path.join(f.directory, 'input.txt'), 'one');
  const success = () => { const r = f.run(); assert.equal(r.status, 0, r.stdout + r.stderr); };
  const calls = () => readFileSync(path.join(f.directory, 'calls.txt'), 'utf8').length;
  success();
  const first = f.state().stages.build;
  success();
  assert.equal(calls(), 1);
  assert.deepEqual(f.state().stages.build, first);
  writeFileSync(path.join(f.directory, 'artifact.txt'), 'tampered');
  success();
  assert.equal(calls(), 2);
  assert.equal(readFileSync(path.join(f.directory, 'artifact.txt'), 'utf8'), 'one');
  rmSync(path.join(f.directory, 'artifact.txt'));
  success();
  assert.equal(calls(), 3);
  const oldState = f.state();
  delete oldState.stages.build.outputs;
  writeFileSync(path.join(f.directory, '.pipeline/state/dev.json'), JSON.stringify(oldState));
  success();
  assert.equal(calls(), 4);
  writeFileSync(path.join(f.directory, 'input.txt'), 'two');
  success();
  assert.equal(calls(), 5);
  assert.notEqual(f.state().stages.build.inputKey, first.inputKey);
  writeFileSync(path.join(f.directory, 'fail'), '');
  assert.equal(f.run('--force').status, 1);
  assert.equal(f.state().stages.build.status, 'failed');
  assert.equal(f.state().stages.build.outputs, undefined);
  rmSync(path.join(f.directory, 'fail'));
  success();
  assert.equal(calls(), 7);
});

function releaseContext(directory, architectures = ['x64']) {
  const spec = {
    enabled: true, architectures, releaseDirectory: 'release/{env}',
    outputs: [...architectures.map(arch => `release/{env}/release-manifest-${arch}.json`), 'release/{env}/release-manifest.json'],
    commands: [{ cmd: python, args: [path.join(root, 'deploy/merge-release-manifests.py'), '{releaseDirectory}', '--architectures', ...architectures], timeoutMs: 10000 }],
  };
  const ctx = {
    root: directory, env: 'test', git: { commit }, options: {}, snapshots: {}, logger: quiet, journal() {},
    paths: { backupDir: path.join(directory, 'backups') },
    profile: { stages: { package: spec, publish: { commands: [] } } },
    async exec(command) {
      const r = spawnSync(command.cmd, command.args, { cwd: directory, encoding: 'utf8', timeout: command.timeoutMs });
      assert.ifError(r.error);
      return { code: r.status, tail: r.stderr, durationMs: 0 };
    },
  };
  return ctx;
}

function writeManifest(ctx, arch, mutate = () => {}) {
  const directory = path.join(ctx.root, 'release', ctx.env);
  mkdirSync(directory, { recursive: true });
  const file = `project-aggregation-linux-${arch}.tar.gz`;
  writeFileSync(path.join(directory, file), `archive-${arch}`);
  const manifest = {
    schema: 1, repository: 'hxx344/project-aggregation', commit, tag: `deploy-${commit}`, node_version: '24.15.0',
    artifacts: { [`linux-${arch}`]: { file, sha256: hashFile(path.join(directory, file)), application_key: 'fixture' } },
  };
  mutate(manifest);
  writeFileSync(path.join(directory, `release-manifest-${arch}.json`), JSON.stringify(manifest));
  return manifest;
}

for (const architectures of [['x64'], ['x64', 'arm64']]) {
  test(`打包真实 schema 合并 ${architectures.join('/')}，验证隔离路径与摘要`, async t => {
    const directory = temporary(t);
    const ctx = releaseContext(directory, architectures);
    const exec = ctx.exec;
    ctx.exec = async command => {
      // 模拟原生打包器的输出；合并运行生产 Python 入口。
      architectures.forEach(arch => writeManifest(ctx, arch));
      return exec(command);
    };
    const other = releaseContext(directory);
    other.env = 'prod';
    writeManifest(other, 'x64', manifest => { manifest.commit = 'b'.repeat(40); });
    const otherPath = path.join(directory, 'release/prod/release-manifest-x64.json');
    const before = readFileSync(otherPath, 'utf8');
    await STAGES.package.run(ctx);
    const outputs = STAGES.package.validate(ctx);
    assert.equal(outputs.length, 2 * architectures.length + 1);
    assert.equal(readFileSync(otherPath, 'utf8'), before);
    const merged = JSON.parse(readFileSync(path.join(directory, 'release/test/release-manifest.json')));
    assert.deepEqual(Object.keys(merged.artifacts), architectures.map(arch => `linux-${arch}`));
    await STAGES.publish.run(ctx);
    const artifact = path.join(directory, 'release/test/project-aggregation-linux-x64.tar.gz');
    writeFileSync(artifact, 'tampered');
    assert.throws(() => STAGES.package.validate(ctx), /摘要/);
    let published = false;
    ctx.exec = async () => { published = true; return { code: 0 }; };
    ctx.profile.stages.publish.commands = [nodeCommand('process.exit(0)')];
    await assert.rejects(STAGES.publish.run(ctx), /摘要/);
    assert.equal(published, false);
    rmSync(artifact);
    assert.throws(() => STAGES.package.validate(ctx), /ENOENT/);
  });
}

test('拒绝缺清单、错误提交、错误架构和目录越界，历史文件不能补足新打包', async t => {
  const ctx = releaseContext(temporary(t));
  assert.throws(() => STAGES.package.validate(ctx), /缺少产物/);
  for (const mutation of [
    manifest => { manifest.commit = 'b'.repeat(40); },
    manifest => { manifest.artifacts['linux-arm64'] = manifest.artifacts['linux-x64']; delete manifest.artifacts['linux-x64']; },
    manifest => { manifest.artifacts['linux-x64'].file = '../outside.tar.gz'; },
  ]) {
    const manifest = writeManifest(ctx, 'x64', mutation);
    writeFileSync(path.join(ctx.root, 'release/test/release-manifest.json'), JSON.stringify(manifest));
    assert.throws(() => STAGES.package.validate(ctx), /身份|架构|路径/);
  }
  const manifest = writeManifest(ctx, 'x64');
  writeFileSync(path.join(ctx.root, 'release/test/release-manifest.json'), JSON.stringify(manifest));
  ctx.profile.stages.package.commands = [];
  await STAGES.package.run(ctx);
  assert.throws(() => STAGES.package.validate(ctx), /缺少产物/);
});

test('合并入口拒绝多架构身份不一致、错误架构、篡改和越界', t => {
  const ctx = releaseContext(temporary(t), ['x64', 'arm64']);
  const run = () => spawnSync(python, [
    path.join(root, 'deploy/merge-release-manifests.py'), path.join(ctx.root, 'release/test'), '--architectures', 'x64', 'arm64',
  ], { encoding: 'utf8', timeout: 10000 });
  writeManifest(ctx, 'x64');
  for (const mutation of [
    m => { m.commit = 'b'.repeat(40); m.tag = `deploy-${m.commit}`; },
    m => { m.artifacts['linux-x64'] = m.artifacts['linux-arm64']; delete m.artifacts['linux-arm64']; },
    m => { m.artifacts['linux-arm64'].sha256 = '0'.repeat(64); },
    m => { m.artifacts['linux-arm64'].file = '../outside.tar.gz'; },
  ]) {
    writeManifest(ctx, 'arm64', mutation);
    const r = run();
    assert.ifError(r.error);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(existsSync(path.join(ctx.root, 'release/test/release-manifest.json')), false);
  }
});

for (const existed of [true, false]) {
  test(`真实 CLI 配置已应用后阶段失败，恢复系统和渲染目标（原先${existed ? '存在' : '不存在'}）`, t => {
    const f = fixture(t, {});
    const applied = path.join(f.directory, 'system.env');
    const rendered = path.join(f.directory, 'runtime.env');
    if (existed) {
      writeFileSync(applied, 'previous-system');
      writeFileSync(rendered, 'previous-rendered');
      chmodSync(applied, 0o640);
      chmodSync(rendered, 0o644);
    }
    f.profile.stages = {
      config: {
        target: 'runtime.env', applyTarget: applied, outputs: ['runtime.env'],
        applyCommands: [nodeCommand("const fs=require('node:fs');fs.copyFileSync(process.argv[1],process.argv[2]);fs.chmodSync(process.argv[2],0o600);", ['{target}', '{applyTarget}'])],
      },
      build: { commands: [nodeCommand(
        "const fs=require('node:fs');const value=fs.readFileSync('system.env','utf8');if(!value.includes('deploy/pipeline'))process.exit(2);fs.writeFileSync('applied-proof','yes');process.exit(1);",
      )] },
    };
    f.save();
    const r = f.run('--apply');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(readFileSync(path.join(f.directory, 'applied-proof'), 'utf8'), 'yes');
    assert.equal(f.state().stages.config.status, 'rolled_back');
    assert.equal(existsSync(applied), existed);
    assert.equal(existsSync(rendered), existed);
    if (existed) {
      assert.equal(readFileSync(applied, 'utf8'), 'previous-system');
      assert.equal(readFileSync(rendered, 'utf8'), 'previous-rendered');
      if (process.platform !== 'win32') {
        assert.equal(statSync(applied).mode & 0o777, 0o640);
        assert.equal(statSync(rendered).mode & 0o777, 0o644);
        assert.equal(statSync(applied).uid, process.getuid());
        assert.equal(statSync(applied).gid, process.getgid());
      }
    }
    assert.equal(existsSync(path.join(f.directory, '.pipeline/locks/dev.lock')), false);
  });
}

test('补偿失败保留备份与失败状态，手动回滚可重试原先失败的配置阶段', t => {
  const f = fixture(t, {});
  const applied = path.join(f.directory, 'system.env');
  writeFileSync(applied, 'original');
  f.profile.stages.config = {
    target: 'runtime.env', applyTarget: applied, outputs: ['runtime.env'],
    applyCommands: [nodeCommand("const fs=require('node:fs');fs.copyFileSync(process.argv[1],process.argv[2]);fs.unlinkSync(process.argv[2]);fs.mkdirSync(process.argv[2]);process.exit(1);", ['{target}', '{applyTarget}'])],
  };
  f.save();
  const r = f.run('--apply');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /配置未完全回滚.*保留备份/);
  assert.equal(f.state().stages.config.status, 'failed');
  const runId = f.state().lastRunId;
  const backup = path.join(f.directory, '.pipeline/runs', runId, 'backups/applied.env');
  assert.equal(readFileSync(backup, 'utf8'), 'original');
  rmSync(applied, { recursive: true });
  const retry = spawnSync(process.execPath, [
    path.join(f.directory, 'deploy/pipeline/cli.mjs'), 'rollback', '--env', 'dev', '--run', runId, '--yes',
  ], { cwd: f.directory, encoding: 'utf8', timeout: 10000 });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(readFileSync(applied, 'utf8'), 'original');
});

test('配置校验拒绝 apply 目标与命令声明脱节', t => {
  const f = fixture(t, { config: { target: 'runtime.env', applyCommands: [nodeCommand('process.exit(0)')] } });
  assert.throws(() => loadProfile(f.directory, 'dev'), /配置无效/);
});

test('命令超时向进程组或 Job 发送终止，已观察到写入停止也仍隔离', async t => {
  const directory = temporary(t);
  const file = path.join(directory, 'dev.lock');
  const lock = acquireLock(file, { runId: 'timeout' });
  const marker = path.join(directory, 'writes');
  const descendant = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),30);`;
  const source = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const start = Date.now();
  const result = await runCommand({
    command: nodeCommand(source), cwd: directory, commandLock: lock, timeoutMs: 2500, termGraceMs: 200, killGraceMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, true);
  lock.release();
  assert.equal(readLock(file).terminationUnconfirmed.commandId, result.commandId);
  assert.ok(Date.now() - start < 5000);
  assert.equal(existsSync(marker), true, result.tail);
  const previous = readFileSync(marker, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(readFileSync(marker, 'utf8'), previous);
});

test('主进程退出后仍有后代时有界隔离，Windows Job 强制清理后也不解除锁', async t => {
  const directory = temporary(t);
  const marker = path.join(directory, 'writes');
  const pidFile = path.join(directory, 'child.pid');
  const file = path.join(directory, 'dev.lock');
  const lock = acquireLock(file, { runId: 'pipe' });
  // Windows detached 避免 Node 自己的退出清理代替执行器回收；仍被外层作业对象约束。
  const source = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'),30);setTimeout(()=>process.exit(0),3000);`)}],{stdio:'inherit',detached:${process.platform === 'win32'}});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setTimeout(()=>process.exit(0),200);`;
  const start = Date.now();
  try {
    const result = await runCommand({
      command: nodeCommand(source), cwd: directory, commandLock: lock,
      timeoutMs: 8000, closeGraceMs: 100, termGraceMs: 200, killGraceMs: 1000,
    });
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.ok(Date.now() - start < 5000);
    assert.equal(existsSync(marker), true, result.tail);
    lock.release();
    if (process.platform === 'win32') {
      assert.equal(result.terminationUnconfirmed, true, result.tail);
      assert.match(result.terminationReason, /Windows Job/);
      assert.ok(readLock(file).terminationUnconfirmed);
      const previous = readFileSync(marker, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(readFileSync(marker, 'utf8'), previous);
    } else {
      assert.equal(result.stdioForced, true);
      assert.equal(result.terminationUnconfirmed, true);
      assert.ok(readLock(file).terminationUnconfirmed);
    }
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

test('Windows Job 强制清理标记在脱敏和输出交错时仍触发隔离', async t => {
  for (const redact of [[], ['FORCED_CLEANUP']]) {
    const file = path.join(temporary(t), 'dev.lock');
    const lock = acquireLock(file, { runId: `job-marker-${redact.length}` });
    const child = Object.assign(new EventEmitter(), {
      pid: 999998, exitCode: null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() { return true; },
    });
    const pending = runCommand({
      command: nodeCommand(''), platform: 'win32', spawnImpl: () => child, commandLock: lock, redact,
      timeoutMs: 5000, closeGraceMs: 200,
    });
    child.stderr.write('PIPELINE_JOB_');
    await new Promise(resolve => setImmediate(resolve));
    child.stdout.write('noise\n');
    await new Promise(resolve => setImmediate(resolve));
    child.stderr.write('FORCED_CLEANUP: command exited with live descendants\n');
    await new Promise(resolve => setImmediate(resolve));
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    const result = await pending;
    assert.equal(result.terminationUnconfirmed, true, JSON.stringify(redact));
    assert.match(result.terminationReason, /Windows Job/);
    lock.release();
    assert.ok(readLock(file).terminationUnconfirmed);
  }
});
test('忽略 TERM 的进程升级 KILL，已发送信号不阻止强杀', { skip: process.platform === 'win32' }, async t => {
  const directory = temporary(t);
  const file = path.join(directory, 'dev.lock');
  const lock = acquireLock(file, { runId: 'ignore-term' });
  const result = await runCommand({
    command: nodeCommand("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"),
    cwd: directory, commandLock: lock, timeoutMs: 800, termGraceMs: 100, killGraceMs: 1000,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.terminationUnconfirmed, true);
  assert.ok(result.durationMs < 3000);
  lock.release();
  assert.ok(readLock(file).terminationUnconfirmed);
  assert.throws(() => acquireLock(file, { runId: 'next' }), LockError);
});

test('终止未确认的锁不会因持有者退出或时间经过而回收', t => {
  const lockFile = path.join(temporary(t), 'env.lock');
  const lock = acquireLock(lockFile, { runId: 'uncertain' });
  lock.quarantine({ pid: 999999, stage: 'config' });
  lock.release();
  assert.equal(readLock(lockFile).terminationUnconfirmed.pid, 999999);
  assert.throws(() => acquireLock(lockFile, { runId: 'next', now: Date.now() + 86400000 }), LockError);
  const saved = readLock(lockFile);
  saved.pid = 999998;
  writeFileSync(lockFile, JSON.stringify(saved));
  assert.throws(() => acquireLock(lockFile, { runId: 'next' }), /终止未确认/);
});

test('KILL 后仍无退出事件时按总预算失败，输出管道销毁且不假称终止成功', async () => {
  const signals = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123456, exitCode: null, signalCode: null, killed: false,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
    kill(signal) { this.killed = true; signals.push(signal); return true; },
  });
  const result = await runCommand({
    command: nodeCommand(''), platform: 'win32', spawnImpl: () => child,
    timeoutMs: 30, termGraceMs: 40, killGraceMs: 50,
  });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, true);
  assert.ok(result.durationMs >= 110 && result.durationMs < 1000);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('CLI 命令超时后保留隔离锁，停止后续阶段与自动补偿', t => {
  const f = fixture(t, {
    config: { target: 'runtime.env' },
    build: { commands: [{ ...nodeCommand('setInterval(()=>{},1000);'), timeoutMs: 1500 }] },
    verify: { commands: [nodeCommand("require('node:fs').writeFileSync('unexpected-next','x');")] },
  });
  writeFileSync(path.join(f.directory, 'runtime.env'), 'original');
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /命令超时/);
  assert.ok(readLock(path.join(f.directory, '.pipeline/locks/dev.lock')).terminationUnconfirmed);
  assert.match(readFileSync(path.join(f.directory, 'runtime.env'), 'utf8'), /deploy\/pipeline/);
  assert.equal(existsSync(path.join(f.directory, 'unexpected-next')), false);
  assert.equal(f.state().stages.build.status, 'failed');
  assert.equal(f.run().status, 4);
});

test('CLI 对无法确认终止的执行结果停止补偿、持久保留锁并拒绝再次运行', t => {
  const f = fixture(t, {
    config: { target: 'runtime.env', outputs: ['runtime.env'] },
    build: { commands: [nodeCommand('')] },
  });
  writeFileSync(path.join(f.directory, 'runtime.env'), 'original');
  // 仅替换无法观察退出的 OS 句柄；真实执行器仍负责预写标记及终止预算。
  unconfirmedExecutor(f, 'build');
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(readFileSync(path.join(f.directory, 'runtime.env'), 'utf8'), /deploy\/pipeline/);
  const lock = readLock(path.join(f.directory, '.pipeline/locks/dev.lock'));
  assert.equal(lock.terminationUnconfirmed.pid, 999999);
  const next = f.run();
  assert.equal(next.status, 4, next.stdout + next.stderr);
  assert.match(next.stdout, /终止未确认/);
});

test('配置文件辅助入口保存恢复内容与元数据，备份缺失时保留现状', t => {
  const directory = temporary(t);
  const target = path.join(directory, 'system.env');
  const backup = path.join(directory, 'backups/system.env');
  const helper = path.join(root, 'deploy/pipeline/config-files.mjs');
  const run = args => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', timeout: 10000 });
  writeFileSync(target, 'private-config-value');
  chmodSync(target, 0o640);
  const before = statSync(target);
  const saved = run(['snapshot', target, backup]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.doesNotMatch(saved.stdout, /private-config-value/);
  const metadata = JSON.parse(saved.stdout);
  writeFileSync(target, 'new');
  chmodSync(target, 0o600);
  const restored = run(['restore', JSON.stringify(metadata)]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(target, 'utf8'), 'private-config-value');
  if (process.platform !== 'win32') {
    assert.equal(statSync(target).mode, before.mode);
    assert.equal(statSync(target).uid, before.uid);
    assert.equal(statSync(target).gid, before.gid);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
  }
  rmSync(backup);
  writeFileSync(target, 'keep-current');
  const failed = run(['restore', JSON.stringify(metadata)]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /缺少恢复备份/);
  assert.equal(readFileSync(target, 'utf8'), 'keep-current');
});

test('Windows 作业对象保留 cmd shim 的命令行参数语义', { skip: process.platform !== 'win32' }, async () => {
  const result = await runCommand({
    command: { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'echo pipeline-cmd-ok'] },
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0, result.tail);
  assert.equal(result.tail.trim(), 'pipeline-cmd-ok');
});

for (const fault of ['input', 'cache', 'state-and-journal', 'journal-only']) {
  test(`已应用配置遇 ${fault} 故障时仍恢复系统及渲染文件`, t => {
    const f = fixture(t, {});
    const applied = path.join(f.directory, 'system.env');
    const rendered = path.join(f.directory, 'runtime.env');
    f.profile.stages = {
      config: {
        target: 'runtime.env', applyTarget: applied, outputs: ['runtime.env'],
        applyCommands: [nodeCommand("const fs=require('node:fs');fs.copyFileSync(process.argv[1],process.argv[2]);fs.writeFileSync('applied-proof','yes');", ['{target}', '{applyTarget}'])],
      },
      build: { inputs: ['input.txt'], outputs: ['artifact.txt'], commands: [nodeCommand("require('node:fs').writeFileSync('artifact.txt','built');")] },
    };
    f.save();
    writeFileSync(path.join(f.directory, 'input.txt'), 'input');
    if (fault === 'cache') {
      const first = f.run('--apply');
      assert.equal(first.status, 0, first.stdout + first.stderr);
    }
    writeFileSync(applied, 'previous-system');
    writeFileSync(rendered, 'previous-rendered');
    rmSync(path.join(f.directory, 'applied-proof'), { force: true });
    const inject = path.join(f.directory, 'fault.mjs');
    writeFileSync(inject, [
      "import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';",
      `const fault=${JSON.stringify(fault)};`,
      "let storageFailed=false;",
      "const active=()=>fs.existsSync(path.resolve('applied-proof'));",
      "for(const name of ['readFileSync','writeFileSync','appendFileSync']) {",
      "const original=fs[name]; fs[name]=function(file,...args) {",
      "const value=String(file).replaceAll('\\\\','/');",
      "const read=name==='readFileSync' && ((fault==='input' && value.endsWith('/input.txt')) || (fault==='cache' && value.endsWith('/artifact.txt')));",
      "const stateWrite=name!=='readFileSync' && fault==='state-and-journal' && value.includes('/.pipeline/state/');",
      "if(active() && stateWrite) {storageFailed=true; throw Object.assign(new Error('注入状态写入故障'),{code:'ENOSPC'});}",
      "const writing=name!=='readFileSync' && (storageFailed || fault==='journal-only') && (value.endsWith('/journal.jsonl') || value.endsWith('/run.jsonl'));",
      "if(active() && (read || writing)) throw Object.assign(new Error('注入持久化或读取故障'), {code:read?'EACCES':'ENOSPC'});",
      "return original.call(this,file,...args); }; } syncBuiltinESMExports();",
    ].join('\n'));
    f.environment.NODE_OPTIONS = `--import=${pathToFileURL(inject).href}`;
    const failed = f.run('--apply');
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.equal(readFileSync(path.join(f.directory, 'applied-proof'), 'utf8'), 'yes', failed.stdout + failed.stderr);
    assert.equal(readFileSync(applied, 'utf8'), 'previous-system');
    assert.equal(readFileSync(rendered, 'utf8'), 'previous-rendered');
    assert.equal(existsSync(path.join(f.directory, '.pipeline/locks/dev.lock')), false);
    if (fault.includes('journal')) assert.match(failed.stderr, /恢复记录写入失败/);
    else assert.equal(f.state().stages.config.status, 'rolled_back');
  });
}

test('渲染文件缺失时共享备份目录仍由流水线创建，特权快照不阻断清单备份', async t => {
  const ctx = releaseContext(temporary(t));
  const target = path.join(ctx.root, 'system.env');
  writeFileSync(target, 'system-original');
  ctx.options.apply = true;
  ctx.profile.stages.config = {
    target: 'runtime.env', applyTarget: target, applyWithSudo: true, applyCommands: [nodeCommand('', ['{applyTarget}'])],
  };
  let privilegedBackup;
  ctx.exec = async command => {
    assert.equal(command.cmd, 'sudo');
    assert.equal(command.args[3], 'snapshot');
    assert.equal(existsSync(ctx.paths.backupDir), true, '提权之前必须创建共享目录');
    privilegedBackup = command.args[5];
    assert.equal(path.dirname(privilegedBackup), path.join(ctx.paths.backupDir, 'privileged'));
    return { code: 0, tail: JSON.stringify(snapshotFile(command.args[4], privilegedBackup)) };
  };
  const saved = await STAGES.config.snapshot(ctx);
  assert.equal(saved.existed, false);
  assert.equal(saved.applied.existed, true);
  const manifest = writeManifest(ctx, 'x64');
  writeFileSync(path.join(ctx.root, 'release/test/release-manifest.json'), JSON.stringify(manifest));
  const packages = await STAGES.package.snapshot(ctx);
  assert.equal(packages.manifests.length, 2);
  for (const entry of packages.manifests) {
    assert.equal(path.dirname(entry.backup), ctx.paths.backupDir);
    assert.deepEqual(JSON.parse(readFileSync(entry.backup)), manifest);
  }
  assert.equal(readFileSync(privilegedBackup, 'utf8'), 'system-original');
});

test('GitHub origin 解析支持 HTTPS 和 SSH，拒绝其他服务与非法仓库路径', () => {
  for (const origin of ['https://github.com/hxx344/project-aggregation.git', 'git@github.com:hxx344/project-aggregation.git', 'ssh://git@github.com/hxx344/project-aggregation']) {
    assert.equal(parseGithubRepository(origin), 'hxx344/project-aggregation');
  }
  for (const origin of ['', 'https://gitlab.com/hxx344/project-aggregation', 'https://github.com/a/b/tree/main', 'file:///a/b']) {
    assert.equal(parseGithubRepository(origin), null);
  }
});

test('CLI 在 Actions 外传入已验证发布身份，Actions 不一致或 origin 无效时拒绝', t => {
  const f = fixture(t, {});
  const git = args => {
    const result = spawnSync('git', ['-C', f.directory, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  // 只取本地已有提交对象，不创建提交，也不改作者身份。
  git(['init']);
  git(['fetch', '--no-tags', root, 'HEAD']);
  git(['update-ref', 'HEAD', 'FETCH_HEAD']);
  git(['remote', 'add', 'origin', 'git@github.com:hxx344/project-aggregation.git']);
  const current = git(['rev-parse', 'HEAD']);
  const ctx = releaseContext(f.directory);
  ctx.env = 'dev';
  const manifest = writeManifest(ctx, 'x64', m => { m.commit = current; m.tag = `deploy-${current}`; });
  writeFileSync(path.join(f.directory, 'release/dev/release-manifest.json'), JSON.stringify(manifest));
  f.profile.stages = {
    package: { ...ctx.profile.stages.package, enabled: false },
    publish: { commands: [nodeCommand("require('node:fs').writeFileSync('publisher-env.json',JSON.stringify({repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA}));")] },
  };
  f.save();
  f.environment.GITHUB_REPOSITORY = undefined;
  f.environment.GITHUB_SHA = undefined;
  const run = f.run('--only', 'publish');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const received = path.join(f.directory, 'publisher-env.json');
  assert.deepEqual(JSON.parse(readFileSync(received)), { repository: 'hxx344/project-aggregation', commit: current });
  f.environment.GITHUB_REPOSITORY = 'hxx344/project-aggregation';
  f.environment.GITHUB_SHA = current;
  assert.equal(f.run('--only', 'publish', '--force').status, 0);
  for (const name of ['GITHUB_REPOSITORY', 'GITHUB_SHA']) {
    rmSync(received, { force: true });
    const original = f.environment[name];
    f.environment[name] = name === 'GITHUB_SHA' ? 'b'.repeat(40) : 'other/repository';
    const failed = f.run('--only', 'publish');
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /身份不一致/);
    assert.equal(existsSync(received), false);
    f.environment[name] = original;
  }
  git(['remote', 'set-url', 'origin', 'https://gitlab.com/hxx344/project-aggregation']);
  const unknown = f.run('--only', 'publish');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /无法从 origin/);
  assert.equal(existsSync(received), false);
});

test('第一项补偿的 journal 写入失败不阻断后续配置补偿', t => {
  const f = fixture(t, {});
  const target = path.join(f.directory, 'system.env');
  writeFileSync(target, 'system-original');
  writeFileSync(path.join(f.directory, 'runtime.env'), 'render-original');
  const ctx = releaseContext(f.directory);
  ctx.env = 'dev';
  const manifest = writeManifest(ctx, 'x64');
  const merged = path.join(f.directory, 'release/dev/release-manifest.json');
  writeFileSync(merged, JSON.stringify(manifest));
  f.profile.stages = {
    config: {
      target: 'runtime.env', applyTarget: target, outputs: ['runtime.env'],
      applyCommands: [nodeCommand("require('node:fs').copyFileSync(process.argv[1],process.argv[2]);", ['{target}', '{applyTarget}'])],
    },
    // 清单先备份，再被打包阶段清理；空命令造成校验失败，触发 package -> config 补偿。
    package: { ...ctx.profile.stages.package, commands: [] },
  };
  f.save();
  const inject = path.join(f.directory, 'rollback-log-fault.mjs');
  writeFileSync(inject, [
    "import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';",
    "const original=fs.writeFileSync;",
    "fs.writeFileSync=function(file,data,...args) {",
    "if(String(file).endsWith('journal.jsonl') && String(data).includes('\"type\":\"rollback.')) throw Object.assign(new Error('回滚记录失败'),{code:'ENOSPC'});",
    "return original.call(this,file,data,...args);}; syncBuiltinESMExports();",
  ].join('\n'));
  f.environment.NODE_OPTIONS = `--import=${pathToFileURL(inject).href}`;
  const failed = f.run('--apply');
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /恢复记录写入失败/);
  assert.equal(readFileSync(target, 'utf8'), 'system-original');
  assert.equal(readFileSync(path.join(f.directory, 'runtime.env'), 'utf8'), 'render-original');
  assert.deepEqual(JSON.parse(readFileSync(merged)), manifest);
  assert.equal(f.state().stages.config.status, 'rolled_back');
  assert.equal(existsSync(path.join(f.directory, '.pipeline/locks/dev.lock')), false);
});

test('显式提权命令配置只接受布尔标记', t => {
  const f = fixture(t, { build: { commands: [{ cmd: 'trusted-wrapper', privileged: true }] } });
  assert.equal(loadProfile(f.directory, 'dev').stages.build.commands[0].privileged, true);
  f.profile.stages.build.commands[0].privileged = 'true';
  f.save();
  assert.throws(() => loadProfile(f.directory, 'dev'), error => {
    assert.equal(error.name, 'ConfigError');
    assert.deepEqual(error.issues, ['stages.build.commands[0].privileged：必须为布尔值']);
    return true;
  });
});

test('sudo 超时隔离原因写入 CLI 日志、命令日志、journal 和持久锁', t => {
  const f = fixture(t, { build: { commands: [{ cmd: 'sudo', args: ['bash', 'deploy/install-all.sh'], timeoutMs: 30 }] } });
  unconfirmedExecutor(f, 'build');
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const lock = readLock(path.join(f.directory, '.pipeline/locks/dev.lock'));
  const reason = lock.terminationUnconfirmed.reason;
  assert.match(reason, /命令超时.*后代停止未确认.*root/);
  assert.ok(result.stdout.includes(reason));
  const runDir = path.join(f.directory, '.pipeline/runs', f.state().lastRunId);
  assert.ok(readFileSync(path.join(runDir, 'logs/build.log'), 'utf8').includes(reason));
  const journal = readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.find(record => record.type === 'run.quarantined').reason, reason);
  assert.ok(journal.find(record => record.type === 'stage.failed').message.includes(reason));
  assert.equal(f.run().status, 4);
});

test('运行中标记预写失败时不得启动命令', async t => {
  const file = path.join(temporary(t), 'dev.lock');
  const lock = acquireLock(file, {
    runId: 'before-spawn',
    persist() { throw Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' }); },
  });
  let launched = false;
  await assert.rejects(runCommand({
    command: nodeCommand(''), commandLock: lock,
    spawnImpl() { launched = true; throw new Error('不应启动'); },
  }), /磁盘已满/);
  assert.equal(launched, false);
  lock.release();
  assert.equal(existsSync(file), false);
});

test('隔离写入 ENOSPC 后仍保留启动标记，死持有者不能被下一轮回收', async t => {
  const file = path.join(temporary(t), 'dev.lock');
  const lock = acquireLock(file, {
    pid: 999998, runId: 'disk-full',
    persist(file, state) {
      if (state.terminationUnconfirmed) throw Object.assign(new Error('磁盘已满'), { code: 'ENOSPC' });
      writeFileSync(file, JSON.stringify(state));
    },
  });
  let preparedId;
  const child = Object.assign(new EventEmitter(), {
    pid: 999999, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() {},
  });
  const result = await runCommand({
    command: nodeCommand(''), commandLock: lock, stageId: 'build', platform: 'win32', env: { FIXTURE: 'unchanged' },
    spawnImpl(_cmd, _args, options) {
      assert.deepEqual(options.env, { FIXTURE: 'unchanged' });
      preparedId = readLock(file).commandRunning.commandId;
      assert.equal(typeof preparedId, 'string');
      return child;
    },
    timeoutMs: 10, termGraceMs: 20, killGraceMs: 30,
  });
  assert.equal(result.terminationUnconfirmed, true);
  assert.match(result.lockError, /磁盘已满/);
  lock.release();
  assert.equal(readLock(file).commandRunning.commandId, preparedId);
  assert.equal(result.commandId, preparedId);
  assert.equal(readLock(file).terminationUnconfirmed, undefined);
  assert.throws(() => acquireLock(file, { runId: 'next' }), /禁止自动回收.*手动移除/);
});

test('CLI 隔离写入失败后退出，启动标记仍拒绝下一轮并停止补偿', t => {
  const f = fixture(t, {
    config: { target: 'runtime.env' },
    build: { commands: [nodeCommand('')] },
  });
  writeFileSync(path.join(f.directory, 'runtime.env'), 'original');
  unconfirmedExecutor(f, 'build');
  quarantineWriteFailure(f);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(readFileSync(path.join(f.directory, 'runtime.env'), 'utf8'), /deploy\/pipeline/);
  const lock = readLock(path.join(f.directory, '.pipeline/locks/dev.lock'));
  assert.equal(lock.commandRunning.stage, 'build');
  assert.equal(lock.terminationUnconfirmed, undefined);
  assert.equal(f.run().status, 4);
});

test('手动回滚隔离写入失败时 finally 保留运行标记并拒绝重试', t => {
  const f = fixture(t, { config: { target: 'runtime.env' } });
  const runId = 'manual-rollback';
  const runDir = path.join(f.directory, '.pipeline/runs', runId);
  mkdirSync(runDir, { recursive: true });
  const target = path.join(f.directory, 'runtime.env');
  const applied = path.join(f.directory, 'system.env');
  writeFileSync(target, 'previous-render');
  writeFileSync(applied, 'previous-system');
  const snapshot = snapshotFile(target, path.join(runDir, 'render.bak'));
  snapshot.applied = { ...snapshotFile(applied, path.join(runDir, 'system.bak')), sudo: true };
  writeFileSync(target, 'current-render');
  writeFileSync(applied, 'current-system');
  writeFileSync(path.join(runDir, 'journal.jsonl'), [
    JSON.stringify({ type: 'snapshot', stage: 'config', data: snapshot }),
    JSON.stringify({ type: 'stage.ok', stage: 'config' }), '',
  ].join('\n'));
  unconfirmedExecutor(f, 'config');
  quarantineWriteFailure(f);
  const rollback = () => spawnSync(process.execPath, [
    path.join(f.directory, 'deploy/pipeline/cli.mjs'), 'rollback', '--env', 'dev', '--run', runId, '--yes',
  ], { cwd: f.directory, env: { ...process.env, ...f.environment }, encoding: 'utf8', timeout: 10000 });
  const failed = rollback();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const lock = readLock(path.join(f.directory, '.pipeline/locks/dev.lock'));
  assert.equal(lock.commandRunning.stage, 'config');
  assert.equal(lock.terminationUnconfirmed, undefined);
  assert.equal(readFileSync(target, 'utf8'), 'current-render');
  assert.equal(readFileSync(applied, 'utf8'), 'current-system');
  assert.equal(rollback().status, 4);
});

test('损坏的现存锁不能作为死持有者自动回收', t => {
  const file = path.join(temporary(t), 'dev.lock');
  writeFileSync(file, '{"pid":');
  assert.throws(() => acquireLock(file, { runId: 'next' }), /损坏/);
  assert.equal(readFileSync(file, 'utf8'), '{"pid":');
});

test('死锁回收序列化，竞争者不能同时回收并覆盖新锁', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'dev.lock');
  writeFileSync(file, JSON.stringify({ pid: 999998, runId: 'dead', startedAt: 'old' }));
  const stateUrl = pathToFileURL(path.join(root, 'deploy/pipeline/state.mjs')).href;
  const contender = [
    `import {acquireLock,LockError} from ${JSON.stringify(stateUrl)};`,
    `try {acquireLock(${JSON.stringify(file)},{runId:'contender'});process.exitCode=0;}`,
    'catch(error){if(!(error instanceof LockError))throw error;process.exitCode=4;}',
  ].join('');
  const owner = [
    "import fs from 'node:fs'; import {spawnSync} from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';",
    `const file=${JSON.stringify(file)}; const original=fs.rmSync; let checked=false;`,
    'fs.rmSync=function(target,...args){if(target===file&&!checked){checked=true;',
    `const other=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(contender)}],{encoding:'utf8',timeout:5000});`,
    "if(other.status!==4)throw new Error('竞争者没有被回收互斥阻止：'+other.status+other.stderr);",
    '}return original.call(this,target,...args);};syncBuiltinESMExports();',
    `const {acquireLock}=await import(${JSON.stringify(stateUrl)});`,
    "const lock=acquireLock(file,{runId:'owner'});",
    "if(!checked)throw new Error('未经过回收竞争窗口');",
    "if(JSON.parse(fs.readFileSync(file)).runId!=='owner')throw new Error('新锁被覆盖');",
    'lock.release();',
  ].join('');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', owner], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(`${file}.reclaim`), false);
});


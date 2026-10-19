import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, resolveConfig, configFingerprint, secretFingerprint, renderEnvFile, parseEnvFile, ConfigError } from '../deploy/pipeline/config.mjs';
import { buildPlan, computeInputKey, evaluateGuards, matchPattern, planRollback, shouldSkip } from '../deploy/pipeline/plan.mjs';
import { snapshotOutputs, outputsIntact } from '../deploy/pipeline/digest.mjs';
import { acquireLock, LockError, readLock } from '../deploy/pipeline/state.mjs';
import { createLogger } from '../deploy/pipeline/logger.mjs';
import { compareVersion } from '../deploy/pipeline/stages.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));

test('环境配置按 extends 合并，触发条件不继承父级', () => {
  const prod = loadProfile(root, 'prod');
  assert.deepEqual(prod.inherits, ['base', 'test']);
  assert.equal(prod.stages.build.commands[0].args[1], 'build:all');
  assert.equal(prod.stages.package.enabled, true);
  assert.equal(prod.stages.publish.enabled, true);
  assert.deepEqual(Object.keys(prod.triggers).sort(), ['manual', 'release']);
  const testProfile = loadProfile(root, 'test');
  assert.deepEqual(Object.keys(testProfile.triggers).sort(), ['manual', 'pull_request', 'push']);
  const dev = loadProfile(root, 'dev');
  assert.equal(dev.toolchain.strict, false);
  assert.equal(dev.config.find(entry => entry.name === 'INITIAL_PASSWORD').required, false);
});

test('未知环境与循环继承会明确报错', () => {
  assert.throws(() => loadProfile(root, 'staging'), ConfigError);
});

test('配置解析优先级为 环境变量 > .env 文件 > 默认值，并一次列出缺失项', () => {
  const profile = loadProfile(root, 'prod');
  const empty = resolveConfig(profile, { env: {}, fileValues: {} });
  assert.deepEqual(empty.issues.map(issue => issue.name).sort(), ['INITIAL_PASSWORD', 'PUBLIC_ORIGIN']);
  assert.equal(empty.sources.PUBLIC_ORIGIN, 'missing');

  const resolved = resolveConfig(profile, {
    env: { PUBLIC_ORIGIN: 'https://hub.example.com', PORT: '3200' },
    fileValues: { INITIAL_PASSWORD: 'a-long-enough-password', PORT: '3100' },
  });
  assert.deepEqual(resolved.issues, []);
  assert.equal(resolved.values.PORT, 3200);
  assert.equal(resolved.values.PUBLIC_ORIGIN, 'https://hub.example.com');
  assert.equal(resolved.sources.PORT, 'env');
  assert.equal(resolved.sources.INITIAL_PASSWORD, 'file');
  assert.ok(resolved.secretNames.has('INITIAL_PASSWORD'));
});

test('类型校验拒绝非法端口、相对路径与短口令', () => {
  const prod = loadProfile(root, 'prod');
  const resolved = resolveConfig(prod, {
    env: { PUBLIC_ORIGIN: 'ftp://example.com', PORT: '70000', INITIAL_PASSWORD: 'short' },
    fileValues: {},
  });
  assert.deepEqual(resolved.issues.map(issue => issue.name).sort(), ['INITIAL_PASSWORD', 'PORT', 'PUBLIC_ORIGIN']);
  const relative = resolveConfig(prod, { env: { PUBLIC_ORIGIN: 'https://a.example', INITIAL_PASSWORD: 'long-enough-secret', DATA_DIR: './data' }, fileValues: {} });
  assert.equal(relative.issues[0].name, 'DATA_DIR');
});

test('配置指纹忽略敏感值，敏感值指纹单独变化', () => {
  const profile = loadProfile(root, 'prod');
  const base = { PUBLIC_ORIGIN: 'https://hub.example.com', INITIAL_PASSWORD: 'first-long-password' };
  const first = resolveConfig(profile, { env: base, fileValues: {} });
  const rotated = resolveConfig(profile, { env: { ...base, INITIAL_PASSWORD: 'second-long-password' }, fileValues: {} });
  const changed = resolveConfig(profile, { env: { ...base, PUBLIC_ORIGIN: 'https://other.example.com' }, fileValues: {} });
  const toolchain = { node: '24.15.0', pnpm: '11.25.0' };
  assert.equal(configFingerprint(profile, first, toolchain), configFingerprint(profile, rotated, toolchain));
  assert.notEqual(configFingerprint(profile, first, toolchain), configFingerprint(profile, changed, toolchain));
  assert.notEqual(secretFingerprint(first), secretFingerprint(rotated));
});

test('渲染结果稳定、可回读，未设置的敏感项不落盘', () => {
  const profile = loadProfile(root, 'dev');
  const resolved = resolveConfig(profile, { env: {}, fileValues: {} });
  const text = renderEnvFile(profile, resolved);
  assert.equal(text, renderEnvFile(profile, resolved));
  assert.match(text, /^# 由 deploy\/pipeline 生成/m);
  assert.match(text, /# INITIAL_PASSWORD 未设置/);
  assert.doesNotMatch(text, /INITIAL_PASSWORD=/);
  const parsed = parseEnvFile(text);
  assert.equal(parsed.PORT, '3100');
  assert.equal(parsed.PUBLIC_ORIGIN, 'http://127.0.0.1:3100');
});

test('触发守卫按环境与标签拦截发布', () => {
  const dev = loadProfile(root, 'dev');
  const testProfile = loadProfile(root, 'test');
  const prod = loadProfile(root, 'prod');
  const dirtyMain = { commit: 'a'.repeat(40), branch: 'main', tag: '', dirty: true };
  const cleanMain = { ...dirtyMain, dirty: false };

  assert.deepEqual(evaluateGuards({ profile: dev, trigger: 'local', git: dirtyMain, options: { allowDirty: true } }), []);
  assert.deepEqual(evaluateGuards({ profile: dev, trigger: 'local', git: dirtyMain, options: {} }), []);
  assert.match(evaluateGuards({ profile: testProfile, trigger: 'manual', git: dirtyMain, options: {} })[0], /未提交改动/);
  assert.match(evaluateGuards({ profile: testProfile, trigger: 'manual', git: dirtyMain, options: { allowDirty: true } })[0], /未提交改动/);
  assert.match(evaluateGuards({ profile: prod, trigger: 'manual', git: cleanMain, options: {} })[0], /--confirm-prod/);
  assert.deepEqual(evaluateGuards({ profile: prod, trigger: 'manual', git: cleanMain, options: { confirmProd: true } }), []);
  assert.match(evaluateGuards({ profile: prod, trigger: 'push', git: cleanMain, options: { confirmProd: true } })[0], /不接受触发条件/);
  assert.match(evaluateGuards({ profile: prod, trigger: 'release', git: cleanMain, options: {} })[0], /没有标签/);
  assert.deepEqual(
    evaluateGuards({ profile: prod, trigger: 'release', git: { ...cleanMain, tag: 'deploy-abc123' }, options: {} }),
    [],
  );
  assert.equal(matchPattern('deploy-*', 'deploy-abc'), true);
  assert.equal(matchPattern('deploy-*', 'v1.0.0'), false);
});

test('阶段计划固定顺序，支持局部重跑且拒绝未知阶段', () => {
  const prod = loadProfile(root, 'prod');
  assert.deepEqual(buildPlan({ profile: prod }).map(item => item.id), ['preflight', 'deps', 'config', 'build', 'verify', 'package', 'publish', 'activate']);
  assert.deepEqual(buildPlan({ profile: prod, options: { only: ['build', 'verify'] } }).map(item => item.id), ['build', 'verify']);
  assert.deepEqual(buildPlan({ profile: prod, options: { from: 'config', to: 'verify' } }).map(item => item.id), ['config', 'build', 'verify']);
  assert.deepEqual(buildPlan({ profile: prod, options: { skip: ['deps', 'package'] } }).map(item => item.id), ['preflight', 'config', 'build', 'verify', 'publish', 'activate']);
  assert.equal(buildPlan({ profile: prod })[0].enabled, true);
  assert.throws(() => buildPlan({ profile: prod, options: { only: ['deploy'] } }), ConfigError);
});

test('幂等键随输入内容变化，敏感值只影响配置阶段', () => {
  const directory = tempDir();
  try {
    writeFileSync(path.join(directory, 'input.txt'), 'one\n');
    const profile = { id: 'dev' };
    const spec = { inputs: ['input.txt'], commands: [{ cmd: 'pnpm', args: ['run', 'build'] }] };
    const args = { root: directory, stageId: 'build', profile, spec, configFingerprint: 'cfg', secretFingerprint: 'sec1', git: { commit: 'c1' }, toolchain: { node: '24.15.0' } };
    const first = computeInputKey(args);
    assert.equal(first, computeInputKey(args));
    assert.notEqual(first, computeInputKey({ ...args, configFingerprint: 'cfg2' }));
    assert.notEqual(first, computeInputKey({ ...args, git: { commit: 'c2' } }));
    assert.notEqual(first, computeInputKey({ ...args, spec: { ...spec, commands: [{ cmd: 'pnpm', args: ['run', 'build:all'] }] } }));
    assert.notEqual(first, computeInputKey({ ...args, stageId: 'config', secretFingerprint: 'sec1' }));
    assert.notEqual(
      computeInputKey({ ...args, stageId: 'config', secretFingerprint: 'sec1' }),
      computeInputKey({ ...args, stageId: 'config', secretFingerprint: 'sec2' }),
    );
    assert.equal(
      computeInputKey({ ...args, secretFingerprint: 'sec1' }),
      computeInputKey({ ...args, secretFingerprint: 'sec2' }),
    );
    writeFileSync(path.join(directory, 'input.txt'), 'two\n');
    assert.notEqual(first, computeInputKey(args));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('跳过判断要求同键成功记录且产物完整', () => {
  const directory = tempDir();
  try {
    mkdirSync(path.join(directory, 'dist'), { recursive: true });
    writeFileSync(path.join(directory, 'dist/index.html'), '<html></html>');
    const outputs = snapshotOutputs(directory, ['dist/index.html']);
    assert.equal(outputsIntact(directory, outputs), true);
    const state = { stages: { build: { status: 'ok', inputKey: 'k1', outputs } } };
    assert.equal(shouldSkip({ state, stageId: 'build', inputKey: 'k1', root: directory, outputs }).skip, true);
    assert.equal(shouldSkip({ state, stageId: 'build', inputKey: 'k2', root: directory, outputs }).skip, false);
    assert.equal(shouldSkip({ state, stageId: 'build', inputKey: 'k1', root: directory, outputs, force: true }).skip, false);
    writeFileSync(path.join(directory, 'dist/index.html'), '<html>changed</html>');
    assert.equal(shouldSkip({ state, stageId: 'build', inputKey: 'k1', root: directory, outputs }).skip, false);
    rmSync(path.join(directory, 'dist/index.html'));
    assert.equal(shouldSkip({ state, stageId: 'build', inputKey: 'k1', root: directory, outputs }).skip, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('环境锁拒绝并发，持有进程消失后可以回收', () => {
  const directory = tempDir();
  try {
    const lockFile = path.join(directory, 'prod.lock');
    const lock = acquireLock(lockFile, { runId: 'run-a', pid: process.pid });
    assert.equal(readLock(lockFile).runId, 'run-a');
    assert.throws(() => acquireLock(lockFile, { runId: 'run-b', pid: process.pid }), LockError);
    lock.release();
    assert.equal(readLock(lockFile), null);

    writeFileSync(lockFile, JSON.stringify({ pid: 999999, runId: 'dead', startedAt: new Date().toISOString() }));
    const reclaimed = acquireLock(lockFile, { runId: 'run-c', pid: process.pid });
    assert.equal(readLock(lockFile).runId, 'run-c');
    reclaimed.release();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('回滚计划逆序且只包含可补偿阶段', () => {
  const records = [
    { type: 'stage.ok', stage: 'deps' },
    { type: 'stage.ok', stage: 'config' },
    { type: 'snapshot', stage: 'config', data: { target: '/tmp/x', existed: false } },
    { type: 'stage.ok', stage: 'build' },
    { type: 'stage.ok', stage: 'publish' },
    { type: 'stage.failed', stage: 'activate' },
  ];
  const plan = planRollback(records);
  assert.deepEqual(plan.map(item => item.stage), ['publish', 'config']);
  assert.equal(plan.find(item => item.stage === 'config').snapshot.target, '/tmp/x');
});

test('日志对消息与结构化字段脱敏，并写入 JSONL', () => {
  const directory = tempDir();
  try {
    const secret = 'super-secret-value';
    const lines = [];
    const stream = { write: line => lines.push(line) };
    const logger = createLogger({ runId: 'run-1', env: 'prod', directory, secrets: [secret], out: stream });
    logger.child({ stage: 'config' }).info('config.rendered', `写入 ${secret}`, { password: secret, nested: { token: secret, note: 'ok' } });
    const record = JSON.parse(readFileSync(path.join(directory, 'run.jsonl'), 'utf8').trim());
    assert.equal(record.stage, 'config');
    assert.equal(record.data.password, '***');
    assert.equal(record.data.nested.token, '***');
    assert.equal(record.data.nested.note, 'ok');
    assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
    assert.doesNotMatch(lines.join(''), new RegExp(secret));
    assert.match(lines.join(''), /\*\*\*/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('工具链版本比较支持精确版本与最低版本', () => {
  assert.equal(compareVersion('24.15.0', '24.15.0'), true);
  assert.equal(compareVersion('24.15.1', '24.15.0'), false);
  assert.equal(compareVersion('24.16.0', '>=24.15.0'), true);
  assert.equal(compareVersion('22.22.2', '>=24.15.0'), false);
  assert.equal(compareVersion('11.25.0', '>=11.0.0'), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadProfile } from '../deploy/pipeline/config.mjs';

// 激活阶段绑定本轮提交（#94）且缓存命中仍核验运行态（#93）。
// 安装器与服务均为本机模拟：不执行 sudo、真实安装或任何网络访问，HTTP 只监听 127.0.0.1。
const root = fileURLToPath(new URL('..', import.meta.url));
const other = 'b'.repeat(40);

// 模拟 install-all.sh --expect-commit：按“当前正式版”决定是否安装，安装后写部署记录并启动服务。
// drift：安装过程中正式版变为该文件内容；unbound：安装器在安装时重新读取正式版（错误实现）；broken：服务起不来。
const installer = [
  "const fs=require('node:fs');",
  "const [flag,expected,record]=process.argv.slice(1);",
  "if(flag!=='--expect-commit'||!/^[a-f0-9]{40}$/.test(expected))process.exit(2);",
  "fs.appendFileSync('calls.txt',expected+'\\n');",
  "const latest=fs.readFileSync('latest.txt','utf8').trim();",
  "if(latest!==expected){console.log('错误：当前正式版 '+latest.slice(0,12)+' 不是指定提交 '+expected.slice(0,12)+'；尚未开始部署。');process.exit(75);}",
  "if(fs.existsSync('drift'))fs.writeFileSync('latest.txt',fs.readFileSync('drift'));",
  "const installed=fs.existsSync('unbound')?fs.readFileSync('latest.txt','utf8').trim():latest;",
  "fs.writeFileSync(record,installed+' '+'f'.repeat(64)+'\\n');",
  "if(!fs.existsSync('broken'))fs.writeFileSync('service-up','');",
].join('');

async function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pipeline-activate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', ['-C', directory, ...args.slice(0, -1)], { encoding: 'utf8', input: args.at(-1), timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '']);
  const tree = git(['hash-object', '-t', 'tree', '-w', '--stdin', '']);
  const signature = 'Pipeline Fixture <fixture@example.invalid> 0 +0000';
  const commit = git(['hash-object', '-t', 'commit', '-w', '--stdin', `tree ${tree}\nauthor ${signature}\ncommitter ${signature}\n\nfixture\n`]);
  git(['update-ref', 'HEAD', commit, '']);
  cpSync(path.join(root, 'deploy/pipeline'), path.join(directory, 'deploy/pipeline'), { recursive: true });

  const health = { hits: 0 };
  const server = http.createServer((req, res) => {
    health.hits += 1;
    const up = existsSync(path.join(directory, 'service-up'));
    res.writeHead(up ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: up ? 'ok' : 'unavailable' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const record = path.join(directory, 'deployed-state');
  writeFileSync(path.join(directory, 'deploy/pipeline/environments/dev.json'), JSON.stringify({
    schema: 1, description: '激活绑定夹具', toolchain: { node: '>=22.0.0', pnpm: '>=11.0.0' }, triggers: { local: {} }, config: [],
    stages: { activate: {
      requiresApply: true,
      commands: [{ cmd: process.execPath, args: ['-e', installer, '--', '--expect-commit', '{commit}', record], timeoutMs: 10000 }],
      targetMismatchExitCode: 75,
      healthUrl: `http://127.0.0.1:${server.address().port}/api/health`, healthAttempts: 2, healthIntervalMs: 20,
      deployedRecord: record,
    } },
  }));
  const pnpmStub = path.join(directory, 'pnpm-fixture.mjs');
  writeFileSync(pnpmStub, "process.stdout.write('11.25.0\\n');");

  // 异步运行真实 CLI，本进程的 HTTP 端点才能应答。只有成功阶段会更新 lastRunId，故按新增运行目录取摘要。
  const runs = () => (existsSync(path.join(directory, '.pipeline/runs')) ? readdirSync(path.join(directory, '.pipeline/runs')) : []);
  let summary = null;
  const run = (...args) => new Promise((resolve, reject) => {
    const before = new Set(runs());
    const child = spawn(process.execPath, [path.join(directory, 'deploy/pipeline/cli.mjs'), 'run', '--env', 'dev', '--apply', ...args], {
      cwd: directory, env: { ...process.env, npm_execpath: pnpmStub }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      const [created] = runs().filter(id => !before.has(id));
      summary = created ? JSON.parse(readFileSync(path.join(directory, '.pipeline/runs', created, 'summary.json'), 'utf8')) : null;
      resolve({ status, output });
    });
  });
  const file = name => path.join(directory, name);
  const write = (name, value = '') => writeFileSync(file(name), value);
  const remove = name => rmSync(file(name), { force: true });
  const calls = () => (existsSync(file('calls.txt')) ? readFileSync(file('calls.txt'), 'utf8').split('\n').filter(Boolean) : []);
  const state = () => (existsSync(file('.pipeline/state/dev.json')) ? JSON.parse(readFileSync(file('.pipeline/state/dev.json'), 'utf8')) : { stages: {} });
  const activate = () => summary.stages.activate;
  const deployed = () => readFileSync(record, 'utf8').split(' ')[0];
  return { commit, health, record, run, write, remove, calls, state, activate, deployed, runStatus: () => summary.status };
}

test('候选 A 未晋级、正式版为 B 时不安装 B，记为 deferred；晋级后固定安装 A 并核对部署记录', async t => {
  const f = await fixture(t);
  f.write('latest.txt', other);
  f.write('deployed-state', `${other} key\n`);
  f.write('service-up');

  const pending = await f.run();
  assert.equal(pending.status, 0, pending.output);
  assert.equal(f.activate().status, 'deferred');
  assert.match(f.activate().reason, /不是本轮提交/);
  assert.deepEqual(f.calls(), [f.commit], '安装器收到本轮提交，而不是裸调用 latest');
  assert.equal(f.deployed(), other, '没有安装正式版 B 冒充 A');
  assert.equal(f.state().stages.activate, undefined, 'deferred 不留下成功缓存');
  assert.equal(f.runStatus(), 'deferred');
  assert.match(pending.output, /运行结束：deferred/);

  f.write('latest.txt', f.commit);
  const promoted = await f.run();
  assert.equal(promoted.status, 0, promoted.output);
  assert.equal(f.activate().status, 'ok');
  assert.equal(f.deployed(), f.commit);
  assert.equal(f.state().stages.activate.status, 'ok');
});

test('原样健康重跑不调用安装器但重新核验；服务停止后执行幂等安装器恢复', async t => {
  const f = await fixture(t);
  f.write('latest.txt', f.commit);
  assert.equal((await f.run()).status, 0);
  assert.equal(f.calls().length, 1);

  const hits = f.health.hits;
  const again = await f.run();
  assert.equal(again.status, 0, again.output);
  assert.equal(f.activate().status, 'skipped', again.output);
  assert.match(f.activate().reason, /运行态核验通过/);
  assert.equal(f.calls().length, 1, '健康且版本一致时不重复安装');
  assert.ok(f.health.hits > hits, '命中缓存仍读取健康端点');

  f.remove('service-up');
  const restarted = await f.run();
  assert.equal(restarted.status, 0, restarted.output);
  assert.equal(f.activate().status, 'ok');
  assert.equal(f.calls().length, 2, '服务停止不能由缓存证明成功，回落到安装器');
});

test('服务停止且安装后仍不健康时失败，不保留成功缓存', async t => {
  const f = await fixture(t);
  f.write('latest.txt', f.commit);
  assert.equal((await f.run()).status, 0);
  f.remove('service-up');
  f.write('broken');
  const failed = await f.run();
  assert.equal(failed.status, 1, failed.output);
  assert.equal(f.activate().status, 'failed');
  assert.match(f.activate().reason, /健康检查失败/);
  assert.equal(f.state().stages.activate.status, 'failed');
  assert.equal(f.calls().length, 2);
});

test('其他入口换成正式版 B 后重跑：缓存撤销，安装器拒绝 B 以外的目标，记为 deferred 而非 ok', async t => {
  const f = await fixture(t);
  f.write('latest.txt', f.commit);
  assert.equal((await f.run()).status, 0);
  f.write('latest.txt', other);
  f.write('deployed-state', `${other} key\n`);
  const rerun = await f.run();
  assert.equal(rerun.status, 0, rerun.output);
  assert.match(rerun.output, /部署记录显示当前版本 bbbbbbbbbbbb/);
  assert.equal(f.activate().status, 'deferred');
  assert.equal(f.state().stages.activate, undefined, '旧的成功记录已撤销');
  assert.equal(f.deployed(), other);
});

test('强制重跑时目标不可用：撤销上一提交的成功记录，状态不显示新提交 + activate ok', async t => {
  const f = await fixture(t);
  f.write('latest.txt', f.commit);
  assert.equal((await f.run()).status, 0);
  assert.equal(f.state().stages.activate.status, 'ok');

  f.write('latest.txt', other);
  const forced = await f.run('--force');
  assert.equal(forced.status, 0, forced.output);
  assert.equal(f.activate().status, 'deferred');
  assert.equal(f.runStatus(), 'deferred');
  assert.equal(f.state().stages.activate, undefined);
  assert.equal(f.state().commit, f.commit);
});
test('latest 在安装中途变化：按已解析的 A 安装则成功；实际装成 B（服务健康但版本错误）则失败', async t => {
  const f = await fixture(t);
  f.write('latest.txt', f.commit);
  f.write('drift', other);
  const pinned = await f.run();
  assert.equal(pinned.status, 0, pinned.output);
  assert.equal(f.activate().status, 'ok');
  assert.equal(f.deployed(), f.commit);

  const g = await fixture(t);
  g.write('latest.txt', g.commit);
  g.write('drift', other);
  g.write('unbound');
  const wrong = await g.run();
  assert.equal(wrong.status, 1, wrong.output);
  assert.equal(g.activate().status, 'failed');
  assert.match(g.activate().reason, /不是本轮提交/);
  assert.equal(g.state().stages.activate.status, 'failed');
});

test('激活配置必须绑定 {commit} 与部署记录；生产配置与安装器的退出码约定一致', () => {
  const prod = loadProfile(root, 'prod').stages.activate;
  assert.deepEqual(prod.commands[0].args, ['bash', 'deploy/install-all.sh', '--expect-commit', '{commit}']);
  assert.equal(prod.deployedRecord, '/opt/project-aggregation/.deployed-state');
  const installAll = readFileSync(path.join(root, 'deploy/install-all.sh'), 'utf8');
  assert.equal(Number(installAll.match(/^STACK_TARGET_MISMATCH=(\d+)$/m)?.[1]), prod.targetMismatchExitCode);

  const directory = mkdtempSync(path.join(tmpdir(), 'pipeline-activate-profile-'));
  try {
    cpSync(path.join(root, 'deploy/pipeline'), path.join(directory, 'deploy/pipeline'), { recursive: true });
    const save = activate => writeFileSync(path.join(directory, 'deploy/pipeline/environments/dev.json'), JSON.stringify({
      schema: 1, description: '校验夹具', toolchain: { node: '>=22.0.0', pnpm: '>=11.0.0' }, triggers: { local: {} }, config: [],
      stages: { activate },
    }));
    const issues = () => { try { loadProfile(directory, 'dev'); return []; } catch (error) { return error.issues ?? [error.message]; } };
    save({ commands: [{ cmd: 'sudo', args: ['bash', 'deploy/install-all.sh'] }], deployedRecord: '/opt/x' });
    assert.ok(issues().some(issue => issue.includes('{commit}')), '裸调用安装器被拒绝');
    save({ commands: [{ cmd: 'sudo', args: ['bash', 'deploy/install-all.sh', '--expect-commit', '{commit}'] }] });
    assert.ok(issues().some(issue => issue.includes('deployedRecord')), '缺少部署记录被拒绝');
    save({ enabled: false, commands: [] });
    assert.doesNotThrow(() => loadProfile(directory, 'dev'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

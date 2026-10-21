import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = 'test change\n\n更新说明：提交证据门禁回归\n风险等级：R2\n已运行：isolated Git regression passed\n未运行：browser (no visible behavior)\n待确认：无\n';
const focused = ['test', '.only("fixture", () => {});'].join('');
const logging = ['console', '.log("fixture");'].join('');
const secret = ['ghp_', 'a'.repeat(36)].join('');

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aggregation-review-'));
  t.after(() => { assert.ok(path.basename(directory).startsWith('aggregation-review-')); rmSync(directory, { recursive: true, force: true }); });
  const run = (command, args, env = {}) => spawnSync(command, args, { cwd: directory, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'empty-gitconfig'), GIT_AUTHOR_NAME: 'Review fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Review fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...env } });
  const git = (...args) => { const result = run('git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const put = (name, content) => { const filename = path.join(directory, name); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, content); };
  const node = (script, args = [], env) => run(process.execPath, [path.join(root, 'scripts', script), ...args], { ...(script === 'review-ci.mjs' ? { REVIEW_BASE_SHA: base } : {}), ...env });
  git('init', '-q');
  git('config', 'core.hooksPath', path.join(directory, 'empty-hooks'));
  put('README.md', '# Fixture\n'); git('add', '.'); git('commit', '-qm', 'initial fixture');
  const base = git('rev-parse', 'HEAD');
  return { directory, run, git, put, node, base };
}

test('range mode inspects committed changes in a clean worktree and rejects ambiguous modes', t => {
  const f = fixture(t);
  f.put('modules/monitor/app/fixture.ts', logging); f.git('add', '.'); f.git('commit', '-qm', evidence);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.node('review-gate.mjs', ['--range', `${f.base}..HEAD`]).status, 1);
  for (const args of [['--range'], ['--range', '--staged'], ['--staged', '--range', `${f.base}..HEAD`], ['--staged', '--staged']]) {
    assert.equal(f.node('review-gate.mjs', args).status, 2, JSON.stringify(args));
  }
});

test('staged mode uses staged bytes, while worktree mode sees later edits', t => {
  const f = fixture(t);
  f.put('src/fixture.ts', 'export const value = 1;\n'); f.git('add', '.');
  f.put('src/fixture.ts', logging);
  assert.equal(f.node('review-gate.mjs', ['--staged']).status, 0);
  assert.equal(f.node('review-gate.mjs').status, 1);
  f.put('src/fixture.test.ts', focused); f.git('add', '.');
  assert.equal(f.node('review-gate.mjs', ['--staged']).status, 1);
});

test('path checks cover nested, binary, empty and renamed files without blocking env examples or removal', t => {
  const f = fixture(t);
  f.put('fixture.bin', Buffer.from([0, 1, 2])); f.git('add', '.'); f.git('commit', '-qm', evidence);
  mkdirSync(path.join(f.directory, 'modules/asset/dist'), { recursive: true });
  f.git('mv', 'fixture.bin', 'modules/asset/dist/renamed.bin');
  assert.equal(f.node('review-gate.mjs', ['--staged']).status, 1);
  f.git('reset', '--hard', '-q');
  for (const [filename, content] of [['modules/monitor/dist/empty.js', ''], ['modules/asset/dist/空 格.bin', Buffer.from([0, 3, 4])], ['output/new.bin', Buffer.from([0, 3, 4])]]) {
    f.put(filename, content); f.git('add', filename);
    assert.equal(f.node('review-gate.mjs', ['--staged']).status, 1, filename);
    f.git('reset', '--hard', '-q');
  }
  f.put('.env.example', 'EXAMPLE_KEY=\n'); f.git('add', '.env.example');
  assert.equal(f.node('review-gate.mjs', ['--staged']).status, 0);
  f.put('.env.production', 'EXAMPLE_KEY=local\n'); f.git('add', '.env.production');
  assert.equal(f.node('review-gate.mjs', ['--staged']).status, 1);
});

test('secret diagnostics never echo source text even when another rule matches the same line', t => {
  const f = fixture(t);
  f.put('server/fixture.mjs', ['console', `.log("${secret}");`].join('')); f.git('add', '.');
  const result = f.node('review-gate.mjs', ['--staged']);
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
  assert.match(result.stdout, /server\/fixture\.mjs:1/);
});

test('commit evidence covers non-src modules, scripts, CI and deletion; docs remain lightweight', t => {
  const f = fixture(t);
  f.put('message.txt', 'change\n');
  for (const name of ['modules/monitor/lib/fixture.ts', 'modules/aster/trading/fixture.py', 'modules/aster/requirements.txt', 'CMakeLists.txt', 'scripts/fixture.mjs', '.github/workflows/fixture.yml']) {
    f.put(name, 'fixture\n'); f.git('add', name);
    assert.equal(f.node('review-message.mjs', ['--staged', '--message', path.join(f.directory, 'message.txt')]).status, 1);
  }
  const withoutNote = evidence.replace('更新说明：提交证据门禁回归\n', '');
  for (const body of ['更新说明：变更\n风险等级：R9\n已运行：yes\n未运行：none\n待确认：none', '更新说明：变更\n风险等级：R2\n已运行：\n未运行：none\n待确认：none', evidence.replace('R2', 'R1 / R2 / R3'), evidence + '风险等级：R3\n',
    withoutNote, withoutNote.replace('风险等级', '更新说明：Fix the gate\n风险等级'), withoutNote.replace('风险等级', '更新说明：\n\n- 空行后的条目\n风险等级'),
    withoutNote.replace('风险等级', '更新说明：<中文摘要>\n风险等级'), withoutNote.replace('风险等级', `更新说明：${'很'.repeat(301)}\n风险等级`), evidence.replace('风险等级', '更新说明：重复\n风险等级')]) {
    f.put('message.txt', body);
    assert.equal(f.node('review-message.mjs', ['--staged', '--message', path.join(f.directory, 'message.txt')]).status, 1);
  }
  for (const body of [evidence, evidence.replace(/\n/g, '\r\n'), withoutNote.replace('风险等级', `更新说明：\n- 修复 Aster 5x 维护状态\n- ${'好'.repeat(270)}\n风险等级`)]) {
    f.put('message.txt', body);
    assert.equal(f.node('review-message.mjs', ['--staged', '--message', path.join(f.directory, 'message.txt')]).status, 0, body);
  }
  f.git('reset', '--hard', '-q'); f.put('server/deleted.mjs', 'export const value = 1;'); f.git('add', 'server/deleted.mjs'); f.git('commit', '-qm', evidence);
  f.git('rm', 'server/deleted.mjs');
  f.put('message.txt', 'missing evidence');
  assert.equal(f.node('review-message.mjs', ['--staged', '--message', path.join(f.directory, 'message.txt')]).status, 1);
  f.git('reset', '--hard', '-q'); f.put('docs/fixture.md', '# Documentation\n'); f.git('add', 'docs/fixture.md'); f.put('message.txt', 'docs');
  assert.equal(f.node('review-message.mjs', ['--staged', '--message', path.join(f.directory, 'message.txt')]).status, 0);
});

function copyHooks(f) {
  for (const name of ['review-gate.mjs', 'review-message.mjs', 'install-hooks.mjs']) {
    f.put(`scripts/${name}`, readFileSync(path.join(root, 'scripts', name)));
  }
  for (const name of ['pre-commit', 'commit-msg']) f.put(`.githooks/${name}`, readFileSync(path.join(root, '.githooks', name)));
}

test('hook installation is idempotent, preserves custom settings and ignores an archive inside another repo', t => {
  const f = fixture(t); copyHooks(f);
  const installer = path.join(f.directory, 'scripts/install-hooks.mjs');
  assert.equal(f.run(process.execPath, [installer]).status, 0);
  assert.equal(f.git('config', '--get', 'core.hooksPath'), path.join(f.directory, 'empty-hooks'));
  f.git('config', '--unset', 'core.hooksPath');
  const installed = f.run(process.execPath, [installer]);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /已启用/, installed.stdout + installed.stderr);
  assert.equal(f.git('config', '--get', 'core.hooksPath'), '.githooks');
  assert.equal(f.run(process.execPath, [installer]).status, 0);
  const archive = path.join(f.directory, 'archive'); mkdirSync(archive);
  cpSync(path.join(f.directory, 'scripts'), path.join(archive, 'scripts'), { recursive: true });
  cpSync(path.join(f.directory, '.githooks'), path.join(archive, '.githooks'), { recursive: true });
  f.git('config', 'core.hooksPath', 'keep-custom');
  assert.equal(f.run(process.execPath, [path.join(archive, 'scripts/install-hooks.mjs')]).status, 0);
  assert.equal(f.git('config', '--get', 'core.hooksPath'), 'keep-custom');
});

test('actual Git commit hooks block bad content and missing evidence, then permit a reviewed commit', t => {
  const f = fixture(t); copyHooks(f); f.git('config', '--unset', 'core.hooksPath');
  assert.equal(f.run(process.execPath, [path.join(f.directory, 'scripts/install-hooks.mjs')]).status, 0);
  f.put('modules/monitor/app/fixture.ts', logging); f.git('add', '.');
  assert.notEqual(f.run('git', ['commit', '-qm', evidence]).status, 0);
  f.put('modules/monitor/app/fixture.ts', 'export const value = 1;\n'); f.git('add', '.');
  assert.notEqual(f.run('git', ['commit', '-qm', 'missing evidence']).status, 0);
  assert.equal(f.run('git', ['commit', '-qm', evidence]).status, 0);
});

test('CI entry uses push and PR ranges, checks commit evidence, and handles initial push explicitly', t => {
  const f = fixture(t);
  const event = path.join(f.directory, 'event.json');
  f.put('src/fixture.ts', logging); f.git('add', '.'); f.git('commit', '-qm', evidence);
  const head = f.git('rev-parse', 'HEAD');
  for (const [name, payload] of [['push', { before: f.base, after: head }], ['pull_request', { pull_request: { base: { sha: f.base }, head: { sha: head } } }], ['push', { before: '0'.repeat(40), after: head }]]) {
    f.put('event.json', JSON.stringify(payload));
    assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: event, GITHUB_SHA: head }).status, 1);
  }
  f.put('src/fixture.ts', 'export const value = 2;\n'); f.git('add', 'src/fixture.ts'); f.git('commit', '-qm', evidence);
  const good = f.git('rev-parse', 'HEAD'); f.put('event.json', JSON.stringify({ before: head, after: good }));
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: good }).status, 0);
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_SHA: good }).status, 0);
  f.put('src/fixture.ts', 'export const value = 3;'); f.git('add', 'src/fixture.ts'); f.git('commit', '-qm', 'missing evidence');
  const noEvidence = f.git('rev-parse', 'HEAD'); f.put('event.json', JSON.stringify({ before: good, after: noEvidence }));
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: noEvidence }).status, 1);
});

test('first push and manual CI dispatch can review a clean initial tree', t => {
  const f = fixture(t), event = path.join(f.directory, 'event.json');
  f.put('event.json', JSON.stringify({ before: '0'.repeat(40), after: f.base }));
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: f.base, REVIEW_BASE_SHA: '0'.repeat(40) }).status, 0);
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: event, GITHUB_SHA: f.base, REVIEW_BASE_SHA: '0'.repeat(40) }).status, 0);
});

test('a failed code push stays blocked through a later docs push or manual dispatch', t => {
  const f = fixture(t), event = path.join(f.directory, 'event.json');
  f.put('src/fixture.ts', logging); f.git('add', '.'); f.git('commit', '-qm', evidence);
  const bad = f.git('rev-parse', 'HEAD');
  f.put('README.md', '# Later documentation\n'); f.git('add', 'README.md'); f.git('commit', '-qm', 'docs only');
  const later = f.git('rev-parse', 'HEAD'); f.put('event.json', JSON.stringify({ before: bad, after: later }));
  for (const name of ['push', 'workflow_dispatch']) assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: event, GITHUB_SHA: later }).status, 1);
  f.put('src/fixture.ts', 'export const value = 1;'); f.git('add', 'src/fixture.ts'); f.git('commit', '-qm', 'code fixed but not reviewed');
  const fixed = f.git('rev-parse', 'HEAD'); f.put('event.json', JSON.stringify({ before: later, after: fixed }));
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: fixed }).status, 1);
  f.put('README.md', '# Reviewed delivery\n'); f.git('add', 'README.md'); f.git('commit', '-qm', evidence);
  const reviewed = f.git('rev-parse', 'HEAD'); f.put('event.json', JSON.stringify({ before: fixed, after: reviewed }));
  assert.equal(f.node('review-ci.mjs', [], { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event, GITHUB_SHA: reviewed }).status, 0);
});

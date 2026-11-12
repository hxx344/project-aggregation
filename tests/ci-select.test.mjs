import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JOBS, RULES, selectJobs } from '../scripts/ci-select.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'ci-select.mjs');
const pick = (...paths) => selectJobs(paths).jobs;

test('traced paths select only the jobs that read them', () => {
  assert.deepEqual(pick('platform/executor/test/adl.test.ts', 'platform/executor/scripts/measure.ts', 'platform/executor/README.md'), ['platform-executor']);
  for (const name of ['platform/executor/src/live/canary.ts', 'platform/executor/package.json']) {
    assert.deepEqual(pick(name), ['app', 'platform-executor', 'installer-release', 'installer-slots', 'installer-deploy'], name);
  }
  assert.deepEqual(pick('tools/options-backtest/optbt/spec.py'), ['options-backtest']);
  assert.deepEqual(pick('tools/main-watch/main_watch.py'), ['main-watch']);
  assert.deepEqual(pick('test-download-speed.sh'), ['installer-release', 'release-mirror']);
  assert.deepEqual(pick('modules/aster/trading/capacity_relay_server.py'), ['app', 'aster-python', 'aster-relay']);
  assert.deepEqual(pick('modules/monitor/lib/market.ts', 'modules/greeks/tests/test_x.py'), ['app', 'module-units']);
  assert.deepEqual(pick('modules/asset/lib/auth-core.ts'), ['app', 'module-units', 'installer-slots']);
  assert.deepEqual(pick('modules/crossex/src/main.ts'), ['app', 'build-tooling', 'module-units']);
  assert.deepEqual(pick('src/App.tsx', 'index.html', 'public/logo.svg', 'vite.config.ts', 'tsconfig.json'), ['app', 'build-tooling']);
  assert.deepEqual(pick('tests/hub-fills.test.mjs', 'tests/fixtures/split-runtime.mjs'), ['app', 'installer-release', 'installer-slots']);
  assert.deepEqual(pick('server/exchange-transport/bybit.mjs'),
    ['app', 'build-tooling', 'platform-executor', 'aster-python', 'module-units', 'installer-release', 'installer-slots', 'installer-deploy']);
});

test('several areas run the union, and documentation adds nothing', () => {
  assert.deepEqual(pick('platform/executor/test/adl.test.ts', 'tools/main-watch/main_watch.py', 'docs/unified-platform-plan.md', 'README.md'),
    ['platform-executor', 'main-watch']);
  assert.deepEqual(pick('docs/reviews/note.md', 'CONVENTIONS.md'), []);
  // Root behavior tests read these, and the NOTICE files ship in the package.
  for (const name of ['LESSONS.md', 'AGENTS.md', 'docs/timeout-budgets.md', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) {
    assert.deepEqual(pick(name), ['app'], name);
  }
});

test('untraced paths, dependency manifests and an empty change list run every job', () => {
  for (const name of [
    'deploy/install.sh', '.github/workflows/ci.yml', 'scripts/ci-select.mjs', 'scripts/modules.mjs', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tools/aero-roles/executor.mjs', 'tools/new-tool/main.py',
    'platform/other/index.ts', 'modules/new-module/index.ts', 'modules/README.md', 'docs/diagram.png', 'docs/notes/a.md/b.png',
    'modules/crossex/package.json', 'modules/aster/dashboard/package.json', 'modules/aster/requirements.lock',
    'modules/aster/requirements-relay.lock', 'modules/greeks/requirements.lock', 'modules/aster/requirements.txt',
    'modules/asset/scripts/prepare-ledger.mjs', 'modules/asset/lib/example-ledger.json',
    'server', 'srcx/a.ts', 'Tests/a.mjs', 'nested/README.md', 'LICENSE',
  ]) {
    assert.deepEqual(pick(name), JOBS, name);
    assert.deepEqual(pick('platform/executor/test/a.test.ts', name), JOBS, name);
  }
  assert.deepEqual(selectJobs(['tools/new-tool/main.py', 'src/a.ts']).unknown, ['tools/new-tool/main.py']);
  assert.deepEqual(pick(), JOBS);
});

test('every rule names known jobs', () => {
  for (const rule of RULES) for (const job of rule.jobs) assert.ok(JOBS.includes(job), `${rule.match} -> ${job}`);
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aggregation-ci-select-'));
  t.after(() => { assert.ok(path.basename(directory).startsWith('aggregation-ci-select-')); rmSync(directory, { recursive: true, force: true }); });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(directory, 'empty-gitconfig'), GIT_AUTHOR_NAME: 'Select fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Select fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => { const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, env }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const put = (name, content) => { const filename = path.join(directory, name); mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, content); };
  const select = () => {
    const output = path.join(directory, 'github-output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', windowsHide: true, env: { ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(Object.keys(values), JOBS);
    return { stdout: result.stdout, jobs: JOBS.filter(job => values[job] === 'true') };
  };
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', path.join(directory, 'empty-hooks'));
  put('platform/executor/test/a.ts', 'export const a = 1;\n'); put('tools/main-watch/old.py', 'old\n'); put('deploy/install.sh', 'true\n');
  git('add', '.'); git('commit', '-qm', 'base');
  return { directory, git, put, select };
}

test('the command reads the pull request merge commit, including deletions, renames and base-only changes', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'topic');
  f.put('platform/executor/test/a.ts', 'export const a = 2;\n'); f.git('add', '.'); f.git('commit', '-qm', 'topic change');
  // A change that only the base has must not count as the pull request's.
  f.git('checkout', '-q', 'main');
  f.put('deploy/install.sh', 'false\n'); f.git('add', '.'); f.git('commit', '-qm', 'base moves on');
  f.git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');
  assert.deepEqual(f.select().jobs, ['platform-executor']);

  f.git('checkout', '-q', 'topic');
  f.git('rm', '-q', 'tools/main-watch/old.py'); f.git('commit', '-qm', 'delete');
  f.git('checkout', '-q', 'main'); f.git('reset', '-q', '--hard', 'HEAD^1'); f.git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');
  assert.deepEqual(f.select().jobs, ['platform-executor', 'main-watch']);

  // Moving a file out of a traced directory must still count its old location.
  f.git('checkout', '-q', 'topic');
  mkdirSync(path.join(f.directory, 'docs'));
  f.git('mv', 'platform/executor/test/a.ts', 'docs/a.md'); f.git('commit', '-qm', 'move');
  f.git('checkout', '-q', 'main'); f.git('reset', '-q', '--hard', 'HEAD^1'); f.git('merge', '-q', '--no-ff', '-m', 'merge', 'topic');
  assert.deepEqual(f.select().jobs, ['platform-executor', 'main-watch']);
});

test('the command runs every job when the checkout is not a merge commit or not a repository', t => {
  const f = fixture(t);
  const linear = f.select();
  assert.deepEqual(linear.jobs, JOBS);
  assert.match(linear.stdout, /changed paths unavailable/);
  const empty = mkdtempSync(path.join(tmpdir(), 'aggregation-ci-select-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const output = path.join(empty, 'github-output');
  // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp directory.
  const result = spawnSync(process.execPath, [script], { cwd: empty, encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '', GIT_CEILING_DIRECTORIES: path.dirname(empty) } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), JOBS.map(job => `${job}=true\n`).join(''));
});

test('ci.yml gates exactly the selectable jobs and release waits for all of them', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const blocks = new Map();
  let current;
  for (const line of body.split('\n')) {
    const id = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (id) { current = []; blocks.set(id[1], current); } else current?.push(line);
  }
  assert.deepEqual([...blocks.keys()].sort(), [...JOBS, 'changes', 'hygiene', 'release'].sort());
  for (const job of JOBS) {
    const lines = blocks.get(job);
    assert.ok(lines.includes('    needs: changes'), job);
    assert.ok(lines.includes(`    if: \${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.${job} != 'false') }}`), job);
    assert.ok(blocks.get('changes').includes(`      ${job}: \${{ steps.select.outputs.${job} }}`), job);
  }
  const changes = blocks.get('changes');
  assert.ok(changes.includes("    if: github.event_name == 'pull_request'"));
  assert.equal(changes.filter(line => /^ {6}[a-z-]+: \$\{\{ steps\.select\.outputs\./.test(line)).length, JOBS.length);
  // The review gate inspects changed lines, so it never depends on the selection.
  assert.equal(blocks.get('hygiene').some(line => /^ {4}(needs|if):/.test(line)), false);
  const release = blocks.get('release');
  const needs = /^ {4}needs: \[(.*)\]$/.exec(release.find(line => line.startsWith('    needs:')))[1].split(',').map(name => name.trim());
  assert.deepEqual(needs.sort(), [...JOBS, 'hygiene'].sort());
  // The skipped changes job would otherwise skip release on main; requiring
  // every listed job to succeed keeps a partial run from publishing.
  assert.ok(release.includes("    if: ${{ !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') && !contains(needs.*.result, 'skipped') && github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') }}"));
});

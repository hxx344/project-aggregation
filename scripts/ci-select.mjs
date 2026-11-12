#!/usr/bin/env node
// Chooses which Checks jobs a pull request runs from the paths it changes.
// Pushes to main and manual runs never consult this: they run every job, so a
// release candidate is always fully verified.
//
// The table lists only paths whose readers were traced through the jobs'
// scripts and imports. A path no rule matches runs every job, so new
// directories, deploy/, .github/, scripts/ and dependency locks stay safe by
// default. tests/ci-select.test.mjs keeps this table and ci.yml in step, but
// it cannot see a job starting to read a new path: when a job's script, import
// or copy reaches into another directory, add that job to the directory's rule.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const JOBS = [
  'app', 'build-tooling', 'platform-executor', 'aster-python', 'module-units',
  'installer-release', 'installer-slots', 'installer-deploy', 'aster-relay',
  'options-backtest', 'main-watch', 'release-mirror',
];

// First match wins.
export const RULES = [
  // pnpm install runs in several jobs: it reads every importer's manifest and
  // runs Asset's prepare script (the dependency inputs in deploy/install.sh).
  // Python locks feed the pip caches and the relay installer.
  { match: /^modules\/(.*\/)?(package\.json|\.npmrc|requirements[^/]*\.(lock|txt))$/, jobs: JOBS },
  { match: /^modules\/asset\/(scripts\/prepare-ledger\.mjs|lib\/example-ledger\.json)$/, jobs: JOBS },
  // Imports server/ only; nothing else reads the prototype.
  { match: /^platform\/executor\//, jobs: ['platform-executor'] },
  { match: /^tools\/options-backtest\//, jobs: ['options-backtest'] },
  { match: /^tools\/main-watch\//, jobs: ['main-watch'] },
  // Syntax-checked by installer-release and run by deploy/test-mirror-tools.py.
  { match: /^test-download-speed\.sh$/, jobs: ['installer-release', 'release-mirror'] },
  // app builds, tests and packages every module. The relay installs and tests
  // modules/aster/{monitor.py,trading}.
  { match: /^modules\/aster\//, jobs: ['app', 'aster-python', 'aster-relay'] },
  { match: /^modules\/(monitor|greeks)\//, jobs: ['app', 'module-units'] },
  // server/modules/asset.mjs imports modules/asset/lib/auth-core.ts, and the
  // slot test runs a copy of server/.
  { match: /^modules\/asset\//, jobs: ['app', 'module-units', 'installer-slots'] },
  // deploy/test-typecheck-cache.mjs type-checks modules/crossex.
  { match: /^modules\/crossex\//, jobs: ['app', 'module-units', 'build-tooling'] },
  // Module tests, the executor prototype, the Aster and Greeks Python tests and
  // all three installer jobs load files from server/.
  { match: /^server\//, jobs: ['app', 'build-tooling', 'platform-executor', 'aster-python', 'module-units', 'installer-release', 'installer-slots', 'installer-deploy'] },
  { match: /^(src\/|public\/|index\.html$|vite\.config\.ts$|tsconfig\.json$)/, jobs: ['app', 'build-tooling'] },
  // installer-release and installer-slots run a few root tests and fixtures directly.
  { match: /^tests\//, jobs: ['app', 'installer-release', 'installer-slots'] },
  // Read by root behavior tests, or shipped in the release package.
  { match: /^(LESSONS\.md|AGENTS\.md|NOTICE\.md|THIRD_PARTY_NOTICES\.md|docs\/timeout-budgets\.md)$/, jobs: ['app'] },
  // The same documentation paths ci.yml leaves to docs.yml.
  { match: /^(docs\/.*\.(md|txt|rst)|[^/]+\.md)$/, jobs: [] },
];

export function selectJobs(paths) {
  const selected = new Set();
  const unknown = [];
  for (const file of paths) {
    const rule = RULES.find(candidate => candidate.match.test(file));
    if (!rule) { unknown.push(file); continue; }
    for (const job of rule.jobs) selected.add(job);
  }
  // An empty change list means the diff could not be trusted, not that nothing changed.
  const full = unknown.length > 0 || paths.length === 0;
  return { jobs: JOBS.filter(job => full || selected.has(job)), unknown };
}

// On pull_request the checkout is the merge of the PR into its base, so the
// first parent is the base. --no-renames reports both sides of a move.
export function changedPaths(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(/\s+/).length - 1;
  if (parents !== 2) throw new Error(`HEAD has ${parents} parent(s), expected the pull request merge commit`);
  return git('diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD').split('\0').filter(Boolean);
}

function main() {
  let paths = [];
  let reason = '';
  try {
    paths = changedPaths();
  } catch (error) {
    reason = `changed paths unavailable (${error.message.split('\n')[0]})`;
  }
  const { jobs, unknown } = selectJobs(paths);
  if (!reason && unknown.length) reason = `no rule for ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`;
  if (!reason && !paths.length) reason = 'no changed paths';
  const lines = [
    `${paths.length} changed path(s); running ${jobs.length} of ${JOBS.length} selectable jobs${reason ? ` (all: ${reason})` : ''}.`,
    ...JOBS.map(job => `- ${job}: ${jobs.includes(job) ? 'run' : 'skip'}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, JOBS.map(job => `${job}=${jobs.includes(job)}\n`).join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const ids = ['monitor', 'asset', 'crossex', 'aster'];
const importer = id => `modules/${id}${id === 'aster' ? '/dashboard' : ''}`;

test('workspace importers resolve the same shared runtime and compiler packages', () => {
  for (const name of ['react', 'react-dom', 'recharts', 'lucide-react', 'typescript']) {
    const locations = ['.', ...ids.filter(id => id !== 'aster' || name === 'typescript').map(importer)].map(directory =>
      realpathSync(path.join(root, directory, 'node_modules', name)));
    assert.equal(new Set(locations).size, 1, `${name} is shared across all importers`);
  }
});

test('Aster keeps its RSC runtime trio aligned without changing existing React consumers', () => {
  const versions = ['react', 'react-dom', 'react-server-dom-webpack'].map(name =>
    JSON.parse(readFileSync(path.join(root, 'modules/aster/dashboard/node_modules', name, 'package.json'), 'utf8')).version);
  assert.deepEqual(versions, ['19.2.8', '19.2.8', '19.2.8']);
  for (const name of ['lucide-react', 'typescript']) {
    const version = directory => JSON.parse(readFileSync(path.join(root, directory, 'node_modules', name, 'package.json'), 'utf8')).version;
    assert.equal(version('modules/aster/dashboard'), version('.'), `${name} uses the shared catalog version with its own React peer context`);
  }
});

test('module cache tracks workspace inputs, local changes, environment and missing artifacts', t => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'pnpm-module-cache-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(path.join(fixture, 'scripts'));
  copyFileSync(path.join(root, 'scripts/modules.mjs'), path.join(fixture, 'scripts/modules.mjs'));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(path.join(fixture, name), '{}\n');
  for (const id of ids) {
    mkdirSync(path.join(fixture, importer(id)), { recursive: true });
    writeFileSync(path.join(fixture, importer(id), 'package.json'), '{}\n');
  }
  const manager = path.join(fixture, 'manager.mjs');
  writeFileSync(manager, `
    import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2), id = path.basename(process.cwd()) === 'dashboard' ? 'aster' : path.basename(process.cwd());
    if (args.join(' ') === 'install --frozen-lockfile') {
      appendFileSync(${JSON.stringify(path.join(fixture, 'calls'))}, 'install\\n');
    } else if (args.join(' ') === 'run build') {
      const artifact = id === 'aster' ? 'dist/client/index.html' : id === 'asset' ? '.next/BUILD_ID' : id === 'monitor' ? 'dist/build-manifest.json' : 'dist/index.html';
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, 'built');
      appendFileSync(${JSON.stringify(path.join(fixture, 'calls'))}, id + '\\n');
    } else if (args.join(' ') !== 'run prepare') throw new Error('Unexpected arguments: ' + args);
  `);
  const environment = { ...process.env, npm_execpath: manager, npm_config_user_agent: 'pnpm/11.25.0' };
  const run = (action = 'build', env = {}) => execFileSync(process.execPath, ['scripts/modules.mjs', action], {
    cwd: fixture, env: { ...environment, ...env }, encoding: 'utf8', windowsHide: true,
  });
  const calls = () => readFileSync(path.join(fixture, 'calls'), 'utf8').trim().split('\n');
  run('install');
  assert.deepEqual(calls(), ['install'], 'installation runs exactly once at the workspace root');
  run();
  assert.deepEqual(calls().slice(1), ids);
  assert.equal(run().match(/unchanged; skipped/g)?.length, 4);
  assert.equal(calls().length, 5);
  writeFileSync(path.join(fixture, 'modules/monitor/source.ts'), 'changed');
  run();
  assert.deepEqual(calls().slice(5), ['monitor'], 'local source change rebuilds only its module');
  writeFileSync(path.join(fixture, 'pnpm-lock.yaml'), 'changed lock\n');
  run();
  assert.deepEqual(calls().slice(6), ids, 'shared dependency changes invalidate every importer');
  run('build', { NEXT_PUBLIC_TEST: 'new' });
  assert.deepEqual(calls().slice(10), ids, 'public build environment changes invalidate the cache');
  rmSync(path.join(fixture, 'modules/crossex/dist/index.html'));
  run('build', { NEXT_PUBLIC_TEST: 'new' });
  assert.deepEqual(calls().slice(14), ['crossex'], 'missing artifacts rebuild even with a matching key');
  writeFileSync(path.join(fixture, 'modules/asset/.env.production'), 'NEXT_PUBLIC_TEST=file\n');
  run('build', { NEXT_PUBLIC_TEST: 'new' });
  assert.deepEqual(calls().slice(15), ['asset'], 'module environment files are build inputs');
  mkdirSync(path.join(fixture, 'modules/aster/trading'));
  writeFileSync(path.join(fixture, 'modules/aster/trading/cycle-config.json'), '{}');
  run('build', { NEXT_PUBLIC_TEST: 'new' });
  assert.deepEqual(calls().slice(16), ['aster'], 'Aster shared trading configuration is a frontend build input');
  writeFileSync(path.join(fixture, 'modules/aster/dashboard/.env.production'), 'VITE_TEST=file');
  run('build', { NEXT_PUBLIC_TEST: 'new' });
  assert.deepEqual(calls().slice(17), ['aster'], 'nested importer environment files are build inputs');
});

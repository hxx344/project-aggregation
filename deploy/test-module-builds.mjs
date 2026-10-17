import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const runner = new URL('../scripts/modules.mjs', import.meta.url);
const modules = { monitor: 'modules/monitor', asset: 'modules/asset', crossex: 'modules/crossex', aster: 'modules/aster/dashboard' };

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'module-builds-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'first'), log = path.join(directory, 'builds.log');
  const put = (relative, value) => {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, value);
  };
  put('scripts/modules.mjs', readFileSync(runner));
  put('package.json', '{"type":"module"}');
  put('pnpm-lock.yaml', 'lockfileVersion: 9.0');
  put('pnpm-workspace.yaml', 'packages: []');
  put('.env.production', 'VITE_TEST=value');
  for (const [id, importer] of Object.entries(modules)) {
    put(`${importer}/package.json`, JSON.stringify({ name: id }));
    put(`${importer}/src/input.js`, 'export const value = 1;');
  }
  put('modules/asset/lib/example-ledger.json', '{"example":true}');
  const manager = path.join(directory, 'pnpm.mjs');
  writeFileSync(manager, `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    const id = JSON.parse(readFileSync('package.json', 'utf8')).name;
    if (process.argv[3] === 'prepare') {
      mkdirSync('lib', { recursive: true });
      if (!existsSync('lib/imported-ledger.json')) writeFileSync('lib/imported-ledger.json', readFileSync('lib/example-ledger.json'));
    } else if (process.argv[3] === 'build') {
      appendFileSync(process.env.FIXTURE_LOG, id + '\\n');
      const artifact = { monitor: 'dist/build-manifest.json', asset: '.next/BUILD_ID', crossex: 'dist/index.html', aster: 'dist/client/index.html' }[id];
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, 'built ' + id);
    } else process.exit(7);
  `);
  const run = (where = root, args = []) => spawnSync(process.execPath, [path.join(where, 'scripts/modules.mjs'), 'build', ...args], {
    cwd: where, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, npm_execpath: manager, npm_config_user_agent: 'pnpm/11.25.0', FIXTURE_LOG: log },
  });
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  return { directory, root, log, run, calls };
}

test('module selection builds exactly the requested modules and rejects unknown selectors', t => {
  const f = fixture(t);
  const result = f.run(f.root, ['crossex']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['crossex']);
  assert.notEqual(f.run(f.root, ['../asset']).status, 0);
  assert.notEqual(f.run(f.root, ['asset', 'asset']).status, 0);
  assert.deepEqual(f.calls(), ['crossex']);
});

test('cache keys survive relocation and deterministic asset preparation; one module change rebuilds only itself', t => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['monitor', 'asset', 'crossex', 'aster']);
  const moved = path.join(f.directory, 'second');
  cpSync(f.root, moved, { recursive: true });
  rmSync(path.join(moved, 'modules/asset/lib/imported-ledger.json'));
  result = f.run(moved);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().length, 4, result.stdout);
  appendFileSync(path.join(moved, 'modules/crossex/src/input.js'), '\nexport const next = 2;');
  result = f.run(moved);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ['monitor', 'asset', 'crossex', 'aster', 'crossex']);
});

test('shared navigation, asset identities and capital metrics invalidate only their consuming module builds', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  mkdirSync(path.join(f.root, 'server'), { recursive: true });
  for (const filename of ['hub-navigation.mjs', 'hub-navigation.d.mts', 'asset-identity.mjs', 'asset-identity.d.mts', 'capital-metrics.mjs', 'capital-metrics.d.mts']) {
    const before = f.calls().length;
    writeFileSync(path.join(f.root, 'server', filename), 'changed shared input');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls().slice(before), ['monitor', 'crossex']);
    assert.equal(f.run().status, 0);
    assert.equal(f.calls().length, before + 2, 'unchanged inputs reuse the successful build');
  }
});

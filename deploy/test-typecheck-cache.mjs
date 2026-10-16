import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const compiler = path.join(repository, 'node_modules/typescript/bin/tsc');

for (const importer of ['.', 'modules/crossex']) {
  test(`${importer}: warm typecheck detects changed errors and recovers`, t => {
    // Keep Windows junctions on the repository volume; some workspace volumes
    // cannot be reached through a junction created in the system temp volume.
    const output = path.join(repository, 'output');
    mkdirSync(output, { recursive: true });
    const workspace = mkdtempSync(path.join(output, 'typecheck-cache-'));
    const directory = path.join(workspace, importer);
    mkdirSync(directory, { recursive: true });
    const dependencies = path.join(directory, 'node_modules');
    t.after(() => {
      try { unlinkSync(dependencies); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(workspace.startsWith(output + path.sep));
      rmSync(workspace, { recursive: true, force: true });
    });
    const source = path.join(repository, importer);
    for (const name of ['src', 'tsconfig.json', 'vite.config.ts', 'package.json']) {
      cpSync(path.join(source, name), path.join(directory, name), { recursive: true });
    }
    // Preserve repository-relative imports without reading shared source outside the fixture.
    mkdirSync(path.join(workspace, 'server'), { recursive: true });
    for (const name of ['hub-navigation.mjs', 'hub-navigation.d.mts', 'asset-identity.mjs', 'asset-identity.d.mts']) {
      cpSync(path.join(repository, 'server', name), path.join(workspace, 'server', name));
    }
    symlinkSync(path.join(source, 'node_modules'), dependencies, 'junction');
    const options = JSON.parse(readFileSync(path.join(directory, 'tsconfig.json'), 'utf8')).compilerOptions;
    const cache = path.resolve(directory, options.tsBuildInfoFile);
    assert.ok(cache.startsWith(directory + path.sep));
    const run = label => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [compiler, '--noEmit', '--project', directory], {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 120_000,
      });
      assert.ifError(result.error);
      t.diagnostic(`${label}: ${((performance.now() - started) / 1000).toFixed(3)}s`);
      return result;
    };
    let result = run('cold');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(cache), 'successful check must create incremental metadata');
    result = run('warm');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const probe = path.join(directory, 'src/build-cache-probe.ts');
    writeFileSync(probe, 'export const cacheProbe: number = "invalid";\n');
    result = run('changed source');
    assert.notEqual(result.status, 0, 'cached success must not hide a new type error');
    assert.match(result.stdout + result.stderr, /build-cache-probe\.ts.*TS2322/);
    writeFileSync(probe, 'export const cacheProbe: number = 1;\n');
    result = run('fixed source');
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(root);
// dist contains only generated artifacts. Old framework outputs must not be
// copied into a successful Vite release or leave a stale success marker.
const output = resolve(root, 'dist');
if (dirname(output) !== root) throw new Error('Build output escaped the project');
await rm(output, { recursive: true, force: true });
await mkdir(join(root, '.build-cache'), { recursive: true });
async function stage(name, task) {
  const start = performance.now();
  await task();
  console.log(`[build] ${name}: ${((performance.now() - start) / 1000).toFixed(3)}s`);
}
await stage('TypeScript', () => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--project', 'tsconfig.linux.json'], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`TypeScript failed (${code})`)));
}));
// Reused node_modules are immutable during upgrades. The module runner loads
// TypeScript config in memory instead of writing node_modules/.vite-temp.
await stage('Vite client', () => build({ root, configLoader: 'runner' }));
await stage('Vite SSR', () => build({ root, configLoader: 'runner', build: { ssr: 'web/entry-server.tsx' } }));
const files = {};
async function inventory(relative) {
  for (const entry of await readdir(resolve(root, 'dist', relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected build symlink: ${name}`);
    if (entry.isDirectory()) await inventory(name);
    else if (entry.isFile()) files[name] = createHash('sha256').update(await readFile(join(root, 'dist', name))).digest('hex');
    else throw new Error(`Unexpected build entry: ${name}`);
  }
}
await inventory('client');
await inventory('server');
await writeFile(join(root, 'dist/build-manifest.json'), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
console.log('[build] Verified client and SSR artifact inventory written.');

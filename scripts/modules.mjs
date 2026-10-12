import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2];
if (!['install', 'build'].includes(action)) throw new Error('Usage: node scripts/modules.mjs install|build');
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm)) throw new Error('Run through npm run install:modules or npm run build:modules');
const environment = `${process.version}:${process.platform}:${process.arch}:${process.env.NODE_ENV || ''}`;
const ignored = new Set(['node_modules', 'dist', '.next', '.build-cache', '.module-cache', '.git', '__pycache__', '.pytest_cache', '.venv', '.data', 'output']);
function digest(directory, files) {
  const hash = createHash('sha256').update('embedded-build-v1:' + environment);
  function visit(relative) {
    const file = path.join(directory, relative);
    if (!existsSync(file)) return;
    const entries = readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignored.has(entry.name) || entry.name.startsWith('.env') || entry.name.endsWith('.tsbuildinfo')) continue;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected module source link: ${relative}/${entry.name}`);
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) hash.update(name.replaceAll('\\', '/')).update(readFileSync(path.join(directory, name)));
    }
  }
  if (files) for (const file of files) hash.update(file).update(readFileSync(path.join(directory, file)));
  else visit('');
  return hash.digest('hex');
}
const run = (directory, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npm, ...args], { cwd: directory, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} failed (${code})`)));
});
for (const id of ['monitor', 'asset', 'crossex']) {
  const directory = path.join(root, 'modules', id), cache = path.join(directory, '.module-cache');
  mkdirSync(cache, { recursive: true });
  const key = digest(directory, action === 'install' ? ['package.json', 'package-lock.json'] : undefined);
  const stamp = path.join(cache, `${action}.json`);
  const artifact = path.join(directory, action === 'install' ? 'node_modules/.package-lock.json' : id === 'asset' ? '.next/BUILD_ID' : id === 'monitor' ? 'dist/build-manifest.json' : 'dist/index.html');
  let saved;
  try { saved = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* first run or invalid cache */ }
  const artifactHash = () => createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (saved?.key === key && existsSync(artifact) && saved.artifact === artifactHash()) {
    console.log(`[modules] ${id}: ${action} unchanged; skipped`); continue;
  }
  console.log(`[modules] ${id}: ${action}`);
  await run(directory, action === 'install' ? ['ci', '--no-audit', '--no-fund'] : ['run', 'build']);
  if (!existsSync(artifact)) throw new Error(`${id} did not produce ${artifact}`);
  // Recalculate because a preparation step may create a required source input.
  writeFileSync(stamp, JSON.stringify({ key: digest(directory, action === 'install' ? ['package.json', 'package-lock.json'] : undefined), artifact: artifactHash() }) + '\n');
}

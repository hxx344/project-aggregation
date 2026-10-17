import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2];
if (!['install', 'build'].includes(action)) throw new Error('Usage: node scripts/modules.mjs install|build');
const selected = process.argv.slice(3);
const pnpm = process.env.npm_execpath;
if (!pnpm || !existsSync(pnpm) || !process.env.npm_config_user_agent?.startsWith('pnpm/')) {
  throw new Error('Run through pnpm run install:modules or pnpm run build:modules');
}
const builds = [
  { id: 'monitor', importer: 'modules/monitor', artifact: 'dist/build-manifest.json' },
  { id: 'asset', importer: 'modules/asset', artifact: '.next/BUILD_ID' },
  { id: 'crossex', importer: 'modules/crossex', artifact: 'dist/index.html' },
  { id: 'aster', importer: 'modules/aster/dashboard', artifact: 'dist/client/index.html' },
];
if (selected.some(id => !builds.some(build => build.id === id)) || new Set(selected).size !== selected.length || (action === 'install' && selected.length)) {
  throw new Error('Select each build module at most once: monitor, asset, crossex, aster');
}
const manifests = ['package.json', ...builds.map(({ importer }) => `${importer}/package.json`)];
const sharedInputs = [...manifests, 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/modules.mjs'];
const moduleSharedInputs = ['server/hub-navigation.mjs', 'server/hub-navigation.d.mts', 'server/asset-identity.mjs', 'server/asset-identity.d.mts', 'server/capital-metrics.mjs', 'server/capital-metrics.d.mts'];
const environment = JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  manager: process.env.npm_config_user_agent.split(' ')[0],
  variables: Object.entries(process.env).filter(([name]) => name === 'NODE_ENV' || /^(VITE_|NEXT_PUBLIC_)/.test(name)).sort(([a], [b]) => a.localeCompare(b)),
});
const ignored = new Set(['node_modules', 'dist', '.next', '.vinext', '.wrangler', '.build-cache', '.module-cache', '.git', '__pycache__', '.pytest_cache', '.venv', '.data', 'output']);
function digest(directory, buildDirectory) {
  const hash = createHash('sha256').update('embedded-workspace-build-v2:' + environment);
  const inputs = ['monitor', 'crossex'].includes(path.basename(directory)) ? [...sharedInputs, ...moduleSharedInputs] : sharedInputs;
  for (const relative of inputs) {
    const file = path.join(root, relative);
    hash.update(relative).update(existsSync(file) ? readFileSync(file) : '<absent>');
  }
  // Environment files are build inputs, but their contents never enter logs/stamps.
  for (const base of new Set([root, directory, buildDirectory])) for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = path.join(base, name);
    hash.update(path.relative(root, file).replaceAll('\\', '/')).update(existsSync(file) ? readFileSync(file) : '<absent>');
  }
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
  visit('');
  return hash.digest('hex');
}
const run = (directory, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [pnpm, ...args], { cwd: directory, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} failed (${code})`)));
});
if (action === 'install') {
  console.log('[modules] Installing all workspace dependencies with the frozen lockfile');
  await run(root, ['install', '--frozen-lockfile']);
  process.exit(0);
}
for (const { id, importer, artifact: output } of builds.filter(build => !selected.length || selected.includes(build.id))) {
  const directory = path.join(root, 'modules', id), buildDirectory = path.join(root, importer), cache = path.join(directory, '.module-cache');
  // Prepare deterministic build inputs before computing the cache key.
  if (id === 'asset') await run(buildDirectory, ['run', 'prepare']);
  mkdirSync(cache, { recursive: true });
  const key = digest(directory, buildDirectory);
  const stamp = path.join(cache, `${action}.json`);
  const artifact = path.join(buildDirectory, output);
  let saved;
  try { saved = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* first run or invalid cache */ }
  const artifactHash = () => createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (saved?.key === key && existsSync(artifact) && saved.artifact === artifactHash()) {
    console.log(`[modules] ${id}: ${action} unchanged; skipped`); continue;
  }
  console.log(`[modules] ${id}: ${action}`);
  await run(buildDirectory, ['run', 'build']);
  if (!existsSync(artifact)) throw new Error(`${id} did not produce ${artifact}`);
  // Recalculate because a preparation step may create a required source input.
  writeFileSync(stamp, JSON.stringify({ key: digest(directory, buildDirectory), artifact: artifactHash() }) + '\n');
}

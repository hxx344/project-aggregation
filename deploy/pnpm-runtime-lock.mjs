// Run from the trusted deployment tools; resolve the YAML parser only in an
// explicitly trusted dependency workspace, never beside a caller's input file.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [lockfile, ...roots] = process.argv.slice(2);
if (!lockfile || !roots.length) throw new Error('Usage: pnpm-runtime-lock.mjs LOCKFILE DEPENDENCY_ROOT...');
let parse;
for (const directory of roots) {
  const root = realpathSync(directory);
  const require = createRequire(path.join(root, 'package.json'));
  let resolved;
  try { resolved = realpathSync(require.resolve('yaml')); }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') continue; throw error; }
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`YAML parser escapes trusted dependency root: ${resolved}`);
  }
  ({ parse } = require(resolved));
  break;
}
if (!parse) throw new Error('Missing locked yaml build dependency; install the complete pnpm workspace first');
const lock = parse(readFileSync(lockfile, 'utf8'), { uniqueKeys: true, maxAliasCount: 100 });
if (!lock || String(lock.lockfileVersion) !== '9.0' || !lock.importers || !lock.packages || !lock.snapshots) {
  throw new Error('Unsupported pnpm lockfile; expected lockfileVersion 9.0 with importers, packages and snapshots');
}
process.stdout.write(JSON.stringify(lock));

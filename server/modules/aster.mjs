import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPythonModule } from './python-module.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
export function pythonExecutable(environment = {}) {
  const managed = resolve(workspace, '.venv-aster', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return environment.ASTER_PYTHON || process.env.ASTER_PYTHON || (existsSync(managed) ? managed : process.platform === 'win32' ? 'python' : 'python3');
}
export async function createModule(options) { return createAsterModule(options); }
// The import hook is only for explicit local tests, never selected by a request.
export async function createAsterModule({ root, dataDir, secret, environment = {}, application = 'trading.workspace:app',
  requestTimeout = 60_000, startupTimeout = 90_000, shutdownTimeout = 100_000 }) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('Missing ASTER worker secret');
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, ...environment, ASTER_TRADING_RUNTIME: resolve(dataDir),
    ASTER_DASHBOARD_DIR: resolve(root, 'dashboard/dist/client'), ASTER_WORKSPACE_SECRET: secret,
    WORKSPACE_MANAGED: '1', PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  delete env.ASTER_PUBLIC_ORIGIN;
  delete env.ASTER_DASHBOARD_PASSWORD;
  return createPythonModule({ root, secret, env, executable: pythonExecutable(environment), application, label: 'ASTER',
    privateHeaders: [['x-workspace-key', secret]], requestTimeout, startupTimeout, shutdownTimeout });
}

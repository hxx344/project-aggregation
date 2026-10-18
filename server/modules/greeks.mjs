import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPythonModule } from './python-module.mjs';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
export function pythonExecutable(environment = {}) {
  const managed = resolve(workspace, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return environment.GREEKS_PYTHON || process.env.GREEKS_PYTHON || (existsSync(managed) ? managed : process.platform === 'win32' ? 'python' : 'python3');
}
export async function createModule(options) { return createGreeksModule(options); }
// Explicit fixture hooks are used only by transport tests, never by HTTP input.
export async function createGreeksModule({ root, dataDir, secret, environment = {}, application = 'app.main:app', requestTimeout = 60_000, startupTimeout = 90_000 }) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('Missing Greeks worker secret');
  if (environment.WORKSPACE_MANAGED === '1' && (!environment.WORKSPACE_WRITER_DB || !environment.WORKSPACE_RUNTIME_ID)) throw new Error('Missing shared account protection');
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, ...environment, STATE_FILE: resolve(dataDir, 'engine_state.json'),
    DASHBOARD_USERNAME: 'workspace', DASHBOARD_PASSWORD: secret, WORKSPACE_MANAGED: '1',
    PYTHONPATH: root, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  for (const key of ['WORKSPACE_WRITER_DB', 'WORKSPACE_RUNTIME_ID', 'WORKSPACE_WRITER_MODULE']) delete env[key];
  for (const key of ['WORKSPACE_WRITER_DB', 'WORKSPACE_RUNTIME_ID']) {
    if (typeof environment[key] === 'string') env[key] = environment[key];
  }
  env.WORKSPACE_WRITER_MODULE = resolve(workspace, 'server/execution/account_writer.py');
  return createPythonModule({ root, secret, env, executable: pythonExecutable(environment), application, label: 'Greeks',
    privateHeaders: [['authorization', `Basic ${Buffer.from(`workspace:${secret}`).toString('base64')}`]], requestTimeout, startupTimeout,
    requireWriterProtection: application === 'app.main:app' && Boolean(env.WORKSPACE_WRITER_DB) });
}

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { moduleCatalog, moduleDependencies } from './catalog.mjs';
import { registerModuleTransport } from './transport.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
export async function startModules({ dataDir, root = repository, logger = console, onFailure = () => {}, onStarting = () => {}, timeoutMs = 120_000, writerContext = { databasePath: path.join(path.resolve(dataDir), 'execution-control.sqlite'), runtimeId: randomUUID() } } = {}) {
  if (path.resolve(writerContext.databasePath) !== path.join(path.resolve(dataDir), 'execution-control.sqlite') || !/^[a-f0-9-]{36}$/.test(writerContext.runtimeId)) throw new Error('Invalid writer runtime context');
  const directory = mkdtempSync(path.join(tmpdir(), 'workbench-'));
  const children = [], unregister = [], generations = {}, ready = {};
  // Every instance gets a fresh path and secret, so a stale listener from an
  // earlier generation can never receive traffic meant for its successor.
  const createTransport = (id, generation) => ({
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\workbench-${path.basename(directory)}-${id}-${generation}` : path.join(directory, `${id}-${generation}.sock`),
    secret: randomBytes(32).toString('hex'),
  });
  const dependencies = id => Object.fromEntries((moduleDependencies[id] ?? []).filter(dependency => ready[dependency]).map(dependency => [dependency, ready[dependency]]));
  function notifyDependents(id, transport) {
    for (const child of children) {
      if (child.moduleId === id || !(moduleDependencies[child.moduleId] ?? []).includes(id) || !child.connected) continue;
      child.send({ type: 'dependency', id, transport }, () => {});
    }
  }
  let stopping = false, closing;
  function close() {
    if (closing) return closing;
    stopping = true;
    for (const remove of unregister) remove();
    closing = (async () => {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (!child.pid || child.exitCode !== null || child.signalCode) return resolve();
        const timer = setTimeout(() => child.kill('SIGKILL'), child.moduleId === 'aster' ? 115_000 : 32_000).unref();
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'shutdown' }, () => {}); else child.kill();
      })));
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    })();
    return closing;
  }
  try {
    // Publish cleanup before the first worker await. The parent must be able
    // to drain a partially started group when its lifecycle lock is lost.
    onStarting({ close });
    // Sequential readiness keeps resource use bounded and starts Monitor before
    // CrossEx, which consumes its opportunities over the private pipe.
    for (const { id } of moduleCatalog) {
      if (stopping) throw new Error('Module startup was interrupted');
      const moduleRoot = path.join(root, 'modules', id), moduleData = path.join(dataDir, 'modules', id);
      mkdirSync(moduleData, { recursive: true, mode: 0o700 });
      const envFile = path.join(moduleData, '.env');
      const environment = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
      environment.WORKSPACE_MAINTENANCE = '1';
      environment.WORKSPACE_MANAGED = '1';
      environment.WORKSPACE_WRITER_DB = writerContext.databasePath;
      environment.WORKSPACE_RUNTIME_ID = writerContext.runtimeId;
      environment.WORKSPACE_WRITER_MODULE = path.join(root, 'server', 'execution', 'account_writer.py');
      const env = { ...process.env };
      for (const key of ['PORT', 'HOST', 'DATA_DIR', 'INITIAL_PASSWORD', 'PUBLIC_ORIGIN', 'APP_PASSWORD', 'APP_USERNAME', 'COOKIE_SECURE', 'MONITOR_EXTERNAL_LOCK', 'WORKSPACE_WRITER_DB', 'WORKSPACE_RUNTIME_ID', 'WORKSPACE_WRITER_MODULE']) delete env[key];
      const worker = path.join(root, 'server', 'modules', 'worker.mjs');
      const locking = id === 'monitor' && process.platform === 'linux';
      if (locking) environment.MONITOR_EXTERNAL_LOCK = '1';
      const args = [worker];
      const child = spawn(locking ? 'flock' : process.execPath,
        locking ? ['--no-fork', '--nonblock', '--conflict-exit-code', '75', path.join(moduleData, 'instance.lock'), process.execPath, ...args] : args,
        { cwd: moduleRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const generation = generations[id] = (generations[id] ?? 0) + 1, instanceId = randomUUID(), transport = createTransport(id, generation);
      child.moduleId = id;
      children.push(child);
      child.stdout.on('data', data => logger.info(`[${id}] ${String(data).trimEnd()}`));
      child.stderr.on('data', data => logger.warn(`[${id}] ${String(data).trimEnd()}`));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(new Error(`${id} startup timed out`)); }, timeoutMs);
        const failure = error => { clearTimeout(timer); reject(error); };
        const exited = code => failure(new Error(`${id} exited during startup (${code})`));
        child.once('error', failure); child.once('exit', exited);
        child.on('message', message => {
          if (message?.type === 'failed') failure(new Error(`${id}: ${message.message}`));
          if (message?.type !== 'ready') return;
          clearTimeout(timer); child.removeListener('exit', exited);
          const remove = registerModuleTransport(id, transport, { instanceId, generation });
          child.once('exit', (code, signal) => {
            remove();
            if (ready[id] === transport) { delete ready[id]; notifyDependents(id, null); }
            if (!stopping) void close().finally(() => onFailure(new Error(`${id} stopped (${signal || code})`)));
          });
          unregister.push(remove); ready[id] = transport; notifyDependents(id, transport); resolve();
        });
        child.send({ type: 'start', id, root: moduleRoot, dataDir: moduleData, environment, transports: dependencies(id), ...transport }, error => { if (error) failure(error); });
      });
    }
    return { projects: moduleCatalog, close };
  } catch (error) { await close(); throw error; }
}

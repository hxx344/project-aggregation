import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { moduleCatalog, moduleDependencies } from './catalog.mjs';
import { registerModuleTransport } from './transport.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
// Initial design values from docs/control-data-plane-separation.md section 4.2.
const restartDefaults = Object.freeze({ delaysMs: Object.freeze([1000, 2000, 4000, 8000, 16_000, 30_000, 60_000]), jitter: 0.2, maxFailures: 5, stableMs: 600_000 });
// Longer than the worker's own close limit (ASTER 110 s, others 30 s) and the
// Python bridges' self-shutdown after stdin closes (ASTER about 102 s).
const stopBudget = id => id === 'aster' ? 115_000 : 32_000;
// POSIX workers lead their own process group so the supervisor can tell when a
// Python bridge outlives its worker. Windows children are reported over IPC.
const processGroups = process.platform !== 'win32';

export async function startModules({ dataDir, root = repository, logger = console, onFailure = () => {}, onStarting = () => {}, onModuleReady = () => {}, timeoutMs = 120_000, restartPolicy = {}, holdFaults = false, drainTimeoutMs = stopBudget, killGraceMs = 5000, probeMs = 100, random = Math.random, now = Date.now, writerContext = { databasePath: path.join(path.resolve(dataDir), 'execution-control.sqlite'), runtimeId: randomUUID() } } = {}) {
  if (path.resolve(writerContext.databasePath) !== path.join(path.resolve(dataDir), 'execution-control.sqlite') || !/^[a-f0-9-]{36}$/.test(writerContext.runtimeId)) throw new Error('Invalid writer runtime context');
  const policy = { ...restartDefaults, ...restartPolicy };
  const directory = mkdtempSync(path.join(tmpdir(), 'workbench-'));
  const children = [], unregister = [], ready = {}, tasks = new Set();
  const slots = Object.fromEntries(moduleCatalog.map(({ id }) => [id, { id, state: 'stopped', generation: 0, child: null, timer: null, due: false,
    restartCount: 0, consecutiveFailures: 0, readyAt: null, lastExitAt: null, lastExitKind: null, nextAttemptAt: null, faultReason: null }]));
  // Every instance gets a fresh path and secret, so a stale listener from an
  // earlier generation can never receive traffic meant for its successor.
  const createTransport = (id, generation) => ({
    socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\workbench-${path.basename(directory)}-${id}-${generation}` : path.join(directory, `${id}-${generation}.sock`),
    secret: randomBytes(32).toString('hex'),
  });
  const requires = id => moduleDependencies[id] ?? [];
  const dependencies = id => Object.fromEntries(requires(id).filter(dependency => ready[dependency]).map(dependency => [dependency, ready[dependency]]));
  const lifecycle = (level, fields, message) => logger[level]({ type: 'module-lifecycle', ...fields }, message);
  function notifyDependents(id, transport) {
    for (const child of children) {
      if (child.moduleId === id || !requires(child.moduleId).includes(id) || !child.connected) continue;
      child.send({ type: 'dependency', id, transport }, () => {});
    }
  }
  const running = child => Boolean(child.pid) && child.exitCode === null && child.signalCode === null;
  const exists = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  const remaining = child => running(child) || Boolean(child.pid) && (processGroups ? exists(-child.pid) : [...child.descendants].some(exists));
  function terminate(child) {
    if (!child.pid) return;
    if (processGroups) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} return; }
    child.kill('SIGKILL');
    for (const pid of child.descendants) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  async function vanished(child, milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (remaining(child)) {
      if (Date.now() >= deadline) return false;
      await delay(probeMs);
    }
    return true;
  }
  // CrossEx and Asset have no instance lock and the account writer refuses a
  // live previous owner, so a successor starts only after the whole tree left.
  async function drain(child, id) {
    if (await vanished(child, drainTimeoutMs(id))) return true;
    terminate(child);
    return vanished(child, killGraceMs);
  }

  let stopping = false, started = false, closing;
  function close() {
    if (closing) return closing;
    stopping = true;
    for (const slot of Object.values(slots)) { clearTimeout(slot.timer); slot.timer = null; slot.state = 'stopping'; }
    for (const remove of unregister) remove();
    closing = (async () => {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (!running(child)) return resolve();
        const timer = setTimeout(() => terminate(child), drainTimeoutMs(child.moduleId)).unref();
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'shutdown' }, () => {}); else child.kill();
      })));
      // Drains in progress are bounded by their own budgets.
      await Promise.allSettled([...tasks]);
      for (const slot of Object.values(slots)) slot.state = 'stopped';
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    })();
    return closing;
  }
  // Errors that escape recovery mean the supervisor itself is broken.
  function supervise(work) {
    const task = work.catch(error => {
      if (stopping) return;
      logger.warn({ err: error, type: 'module-lifecycle' }, '内嵌模块监督失败');
      void close().finally(() => onFailure(error));
    }).finally(() => tasks.delete(task));
    tasks.add(task);
  }

  function launch(slot) {
    const { id } = slot;
    const moduleRoot = path.join(root, 'modules', id), moduleData = path.join(dataDir, 'modules', id);
    mkdirSync(moduleData, { recursive: true, mode: 0o700 });
    const envFile = path.join(moduleData, '.env');
    const environment = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
    // Restarted instances also begin in maintenance until the hub releases them.
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
    // flock --no-fork execs Node in place, so the worker stays the group leader.
    const child = spawn(locking ? 'flock' : process.execPath,
      locking ? ['--no-fork', '--nonblock', '--conflict-exit-code', '75', path.join(moduleData, 'instance.lock'), process.execPath, ...args] : args,
      { cwd: moduleRoot, env, windowsHide: true, detached: processGroups, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const generation = slot.generation += 1, instanceId = randomUUID(), transport = createTransport(id, generation);
    child.moduleId = id; child.descendants = new Set();
    Object.assign(slot, { state: 'starting', child, readyAt: null });
    children.push(child);
    child.once('close', () => { const index = children.indexOf(child); if (index >= 0) children.splice(index, 1); });
    child.stdout.on('data', data => logger.info(`[${id}] ${String(data).trimEnd()}`));
    child.stderr.on('data', data => logger.warn(`[${id}] ${String(data).trimEnd()}`));
    child.on('message', message => { if (message?.type === 'child' && Number.isSafeInteger(message.pid) && message.pid > 0) child.descendants.add(message.pid); });
    const readiness = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${id} startup timed out`)); }, timeoutMs);
      const failure = error => { clearTimeout(timer); reject(error); };
      const exited = code => failure(new Error(`${id} exited during startup (${code})`));
      child.once('error', failure); child.once('exit', exited);
      child.on('message', message => {
        if (message?.type === 'failed') failure(new Error(`${id}: ${message.message}`));
        if (message?.type !== 'ready') return;
        clearTimeout(timer); child.removeListener('exit', exited); resolve();
      });
      child.send({ type: 'start', id, root: moduleRoot, dataDir: moduleData, environment, transports: dependencies(id), ...transport }, error => { if (error) failure(error); });
    });
    return { child, transport, generation, instanceId, readiness };
  }

  function activate(slot, { child, transport, generation, instanceId }) {
    const { id } = slot;
    const registration = registerModuleTransport(id, transport, { instanceId, generation });
    const remove = () => { registration(); const index = unregister.indexOf(remove); if (index >= 0) unregister.splice(index, 1); };
    unregister.push(remove);
    Object.assign(slot, { state: 'ready', readyAt: now(), nextAttemptAt: null });
    ready[id] = transport;
    child.once('exit', (code, signal) => {
      remove();
      if (ready[id] === transport) { delete ready[id]; notifyDependents(id, null); }
      if (stopping) return;
      // Until the whole group is ready, keep the old contract: the installer's
      // health check must still see a broken release fail.
      if (!started) { void close().finally(() => onFailure(new Error(`${id} stopped (${signal || code})`))); return; }
      supervise(recover(slot, child, { kind: signal ? 'signal' : 'exit', code, signal }));
    });
    notifyDependents(id, transport);
    for (const dependent of Object.values(slots)) if (requires(dependent.id).includes(id)) attempt(dependent);
  }

  async function recover(slot, child, { kind, code = null, signal = null, error = null }) {
    const { id } = slot, exitedAt = now();
    const stable = slot.readyAt !== null && exitedAt - slot.readyAt >= policy.stableMs;
    Object.assign(slot, { state: 'draining', readyAt: null, lastExitAt: new Date(exitedAt).toISOString(), lastExitKind: kind });
    lifecycle('warn', { moduleId: id, generation: slot.generation, event: 'exit', kind, code, signal, ...(error ? { reason: error.message } : {}) }, '内嵌模块已退出，等待旧进程结束');
    const drainStarted = Date.now(), drained = await drain(child, id);
    if (stopping) return;
    lifecycle('info', { moduleId: id, generation: slot.generation, event: 'drained', drained, drainMs: Date.now() - drainStarted }, drained ? '内嵌模块旧进程已全部结束' : '内嵌模块旧进程强制结束后仍存在');
    if (!drained) return fault(slot, 'process-tree');
    slot.consecutiveFailures = stable ? 0 : slot.consecutiveFailures + 1;
    if (slot.consecutiveFailures >= policy.maxFailures) return fault(slot, 'failures');
    // The first restart, and any restart after a stable run, waits the first step.
    const base = policy.delaysMs[Math.min(Math.max(slot.consecutiveFailures - 1, 0), policy.delaysMs.length - 1)];
    const wait = Math.round(base * (1 + random() * policy.jitter));
    Object.assign(slot, { state: 'backoff', due: false, nextAttemptAt: new Date(now() + wait).toISOString() });
    lifecycle('info', { moduleId: id, generation: slot.generation, event: 'backoff', delayMs: wait, consecutiveFailures: slot.consecutiveFailures }, '内嵌模块将在退避后重启');
    slot.timer = setTimeout(() => { slot.timer = null; slot.due = true; attempt(slot); }, wait);
  }

  function fault(slot, reason) {
    Object.assign(slot, { state: 'fault', nextAttemptAt: null, faultReason: reason });
    lifecycle('warn', { moduleId: slot.id, generation: slot.generation, event: 'fault', reason, consecutiveFailures: slot.consecutiveFailures }, holdFaults ? '内嵌模块已停止自动重启，需要管理员恢复' : '内嵌模块已停止自动重启，正在关闭工作台');
    // Until an operator can restart a faulted module (P0-3), fall back to the
    // old contract: the whole workbench exits and systemd restarts it.
    if (!holdFaults) void close().finally(() => onFailure(new Error(`${slot.id} fault (${reason})`)));
  }

  // A due module waits in backoff, without counting a failure, until every
  // dependency is ready again; activate() retries it.
  function attempt(slot) {
    if (stopping || slot.state !== 'backoff' || !slot.due || requires(slot.id).some(dependency => !ready[dependency])) return;
    slot.due = false;
    supervise(restart(slot));
  }

  async function restart(slot) {
    slot.restartCount += 1; slot.nextAttemptAt = null;
    const instance = launch(slot);
    try { await instance.readiness; }
    catch (error) {
      if (running(instance.child)) { if (instance.child.connected) instance.child.send({ type: 'shutdown' }, () => {}); else instance.child.kill(); }
      if (!stopping) await recover(slot, instance.child, { kind: 'startup', error });
      return;
    }
    // close() already owns this child.
    if (stopping) return;
    activate(slot, instance);
    lifecycle('info', { moduleId: slot.id, generation: instance.generation, event: 'ready', restartCount: slot.restartCount }, '内嵌模块已重新就绪');
    onModuleReady({ id: slot.id, generation: instance.generation });
  }

  /** Operator recovery from fault; returns false in any other state. */
  function restartModule(id) {
    if (!Object.hasOwn(slots, id)) throw new Error('Unknown embedded module');
    const slot = slots[id];
    if (stopping || slot.state !== 'fault') return false;
    const lingering = slot.faultReason === 'process-tree';
    Object.assign(slot, { consecutiveFailures: 0, state: 'draining', faultReason: null });
    supervise((async () => {
      // Only this fault leaves a process tree behind; never start beside it.
      // Any other fault already confirmed the old tree was gone.
      if (lingering && !await drain(slot.child, id)) return fault(slot, 'process-tree');
      if (stopping) return;
      Object.assign(slot, { state: 'backoff', due: true });
      attempt(slot);
    })());
    return true;
  }

  function status() {
    return moduleCatalog.map(({ id }) => {
      const slot = slots[id];
      return { moduleId: id, state: slot.state, generation: slot.generation, restartCount: slot.restartCount, consecutiveFailures: slot.consecutiveFailures,
        lastExitAt: slot.lastExitAt, lastExitKind: slot.lastExitKind, readyAt: slot.readyAt === null ? null : new Date(slot.readyAt).toISOString(), nextAttemptAt: slot.nextAttemptAt };
    });
  }

  try {
    // Publish cleanup before the first worker await. The parent must be able
    // to drain a partially started group when its lifecycle lock is lost.
    onStarting({ close });
    // Sequential readiness keeps resource use bounded and starts Monitor before
    // CrossEx, which consumes its opportunities over the private pipe.
    for (const { id } of moduleCatalog) {
      if (stopping) throw new Error('Module startup was interrupted');
      const instance = launch(slots[id]);
      await instance.readiness;
      if (stopping) throw new Error('Module startup was interrupted');
      activate(slots[id], instance);
    }
    started = true;
    return { projects: moduleCatalog, close, status, restart: restartModule };
  } catch (error) { await close(); throw error; }
}

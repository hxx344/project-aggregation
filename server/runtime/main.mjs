import { mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from '../logger.mjs';
import { runProcess } from '../process-entry.mjs';
import { startModules } from '../modules/runtime.mjs';
import { createModuleUpdateGuard, tradingModules } from '../modules/updates.mjs';
import { createAccountWriter } from '../execution/account-writer.mjs';
import { acquireRuntimeLock } from '../recovery/lifecycle-lock.mjs';
import { assertRecoveryStartup } from '../recovery/startup.mjs';
import { openHubDatabase } from '../control/schema.mjs';
import { markHubSchema } from '../control/hub-schema.mjs';
import { logWriteWaits } from '../sqlite-writes.mjs';
import { createControlStore } from '../control/store.mjs';
import { createProjectCatalog } from '../control/projects.mjs';
import { loadCredentialCipher } from './credentials.mjs';
import { createRuntimeService } from './service.mjs';
import { createDataPlane } from './data-plane.mjs';
import { startInternalServer } from './internal-server.mjs';
import { ensureRuntimeDir, runtimeDir, socketPathFor } from './protocol.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// A restarted trading module that could not take the durable maintenance value
// is tried again with this backoff until it confirms or restarts again. The
// runtime keeps at most one of its own syncs in the service queue, and each
// waits at most SYNC_DEADLINE_MS for the modules. The API's 25 s maintenance
// budget covers its sync (10 s) behind that one and, during a dual-slot
// handoff, the other API's sync as well, however many modules restart
// together (docs/timeout-budgets.md, C18).
const SYNC_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000], SYNC_DEADLINE_MS = 4000;
// Closing the data plane waits for in-flight work (exchange calls, an Aero
// operation); past this the runtime logs it and closes the rest, so the unit's
// 150 s TimeoutStopSec is not the only bound. As long as the slowest module
// stop, which runs alongside (docs/timeout-budgets.md, C11).
const DATA_PLANE_CLOSE_MS = 120_000;
const bounded = (work, ms, message) => {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.(); });
  return Promise.race([Promise.resolve(work), expired]).finally(() => clearTimeout(timer));
};

// The runtime process (design doc 3.1): the embedded modules, the data plane
// and the internal server the API reaches it through. It holds `.runtime.lock`
// from its first step until close() has stopped everything else. The API
// seeds the control tables; the runtime only reads them.
// `startModules` and `dataPlaneOptions` are replaced by the two-process tests.
export async function startRuntime({ dataDir, logger = defaultLogger, signal, fail = () => {}, env = process.env, startModules: launchModules = startModules, dataPlaneOptions = {}, syncRetryMs = SYNC_RETRY_MS, dataPlaneCloseMs = DATA_PLANE_CLOSE_MS }) {
  const resolvedData = path.resolve(dataDir);
  const stopped = () => { if (signal?.aborted) throw new Error('运行时启动已中止'); };
  let lock = null, accountWriter = null, modules = null, moduleStartup = null, db = null, dataPlane = null, internal = null, service = null, ready = false;
  let closing = null;
  const generations = new Map(), retries = new Set();
  // Modules due while a runtime sync is queued or running join the next one,
  // which enters the service queue only after it: one sync for all of them.
  // The batch skips (null) while another sync is queued only if every member
  // is a retry. Each caller gets the rows of its own module.
  let syncTail = Promise.resolve(), syncBatch = null;
  const syncModule = (id, ifIdle) => {
    if (!syncBatch) {
      const batch = syncBatch = { ids: new Set(), ifIdle: true };
      batch.result = syncTail.then(() => {
        syncBatch = null;
        return closing ? null : service.syncMaintenance([...batch.ids], { ifIdle: batch.ifIdle, deadlineMs: SYNC_DEADLINE_MS });
      });
      syncTail = batch.result.catch(() => {});
    }
    syncBatch.ids.add(id); syncBatch.ifIdle &&= ifIdle;
    return syncBatch.result.then(result => result && { ...result, modules: result.modules.filter(row => row.id === id) });
  };
  const stopWriteLog = logWriteWaits({ logger, role: 'runtime' });
  function close() {
    return closing ??= (async () => {
      ready = false;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      dataPlane?.stop();
      const results = [];
      const step = async action => { try { await action(); } catch (error) { results.push(error); } };
      // The API sees the runtime as unavailable before anything else stops.
      await step(() => internal?.close());
      // Workers drain while the data plane closes, as in the single process.
      const workers = Promise.resolve().then(() => (modules ?? moduleStartup)?.close());
      await step(() => bounded(dataPlane ? dataPlane.close() : accountWriter?.close(), dataPlaneCloseMs, '数据面未在期限内关闭'));
      await step(() => workers);
      await step(stopWriteLog);
      await step(() => db?.close());
      // Last: a successor may start once the lock is free.
      await step(() => lock?.close());
      if (results.length) throw new AggregateError(results, '运行时关闭失败');
    })();
  }
  // A module group still starting is closed at once, so startup ends promptly.
  const abortModules = () => { void moduleStartup?.close(); };
  signal?.addEventListener('abort', abortModules, { once: true });
  try {
    mkdirSync(resolvedData, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(resolvedData, 0o700);
    lock = await acquireRuntimeLock({ dataDir: resolvedData, onLost: fail });
    stopped();
    assertRecoveryStartup(resolvedData);
    const { encrypt, decrypt } = loadCredentialCipher(resolvedData, logger);
    const writerContext = { databasePath: path.join(resolvedData, 'execution-control.sqlite'), runtimeId: randomUUID() };
    accountWriter = createAccountWriter({ ...writerContext, moduleId: 'hub' });
    // A restarted trading module starts in maintenance and takes the durable
    // value at once; modules of the first start are synchronized by the API.
    // Retries stop once the module confirms, a new instance of it is ready or
    // the runtime closes. A retry is skipped while an API sync is queued and
    // waits its delay again; the first failures and then every 20th are logged.
    const onModuleReady = ({ id, generation }) => {
      if (!service || !tradingModules.includes(id)) return;
      generations.set(id, generation);
      const current = () => !closing && generations.get(id) === generation;
      let attempt = 0;
      const retry = delay => { const timer = setTimeout(() => { retries.delete(timer); void sync(); }, delay); timer.unref?.(); retries.add(timer); };
      const sync = async () => {
        if (!current()) return;
        const result = await syncModule(id, attempt > 0).catch(error => ({ error }));
        if (!current() || result?.modules?.every(module => module.confirmed)) return;
        // A skipped retry waits the delay it just waited, not the next one.
        const delay = syncRetryMs[Math.min(result === null ? Math.max(attempt - 1, 0) : attempt, syncRetryMs.length - 1)];
        if (result === null) { retry(delay); return; }
        attempt += 1;
        if (attempt <= syncRetryMs.length || attempt % 20 === 0) logger.warn({ err: result.error, moduleId: id, generation, attempt, delay, type: 'module-lifecycle' }, '重启的模块未能同步维护状态，稍后重试');
        retry(delay);
      };
      void sync();
    };
    // The API reaches the module sockets directly (Portal), so they live in the
    // runtime directory. Its own socket path is checked before any module starts.
    const runDir = ensureRuntimeDir(runtimeDir(resolvedData, env));
    socketPathFor(runDir, randomUUID());
    modules = await launchModules({ dataDir: resolvedData, socketDir: runDir, logger, writerContext, onStarting: handle => { moduleStartup = handle; }, onModuleReady, onFailure: fail });
    lock.assertHeld(); stopped();
    db = openHubDatabase(path.join(resolvedData, 'hub.sqlite'));
    const control = createControlStore(db);
    const readMaintenance = () => control.getSetting('updates-maintenance') === '1';
    service = createRuntimeService({ moduleRuntime: modules, guard: createModuleUpdateGuard(), readMaintenance, isReady: () => ready, prepareAutomation: () => dataPlane?.prepareStop() });
    dataPlane = createDataPlane({ db, control, catalog: createProjectCatalog({ control, embeddedModules: true, decrypt }), encrypt, decrypt, embeddedModules: true,
      dataDir: resolvedData, log: logger, accountWriter, ...dataPlaneOptions });
    await dataPlane.initialize();
    lock.assertHeld(); stopped();
    dataPlane.startBaseline();
    // Every hub.sqlite creator has run now (the baseline last).
    markHubSchema(db, { log: logger });
    internal = await startInternalServer({ service, dataPlane, dir: runDir, logger });
    lock.assertHeld(); stopped();
    // From here a crashed module restarts alone instead of failing startup.
    modules.markStarted(); ready = true;
    return { ready: { instanceId: service.instanceId }, close };
  } catch (error) {
    try { await close(); } catch (cause) { logger.error({ err: cause, type: 'startup' }, '运行时启动失败后的清理未完成'); }
    throw error;
  } finally { signal?.removeEventListener('abort', abortModules); }
}

if (import.meta.main) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
  void runProcess({ name: '运行时', logger: defaultLogger, start: options => startRuntime({ ...options, dataDir }) });
}

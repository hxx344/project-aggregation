import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from '../logger.mjs';
import { runProcess } from '../process-entry.mjs';
import { validateAuthOrigin } from '../adapters.mjs';
import { assertRecoveryStartup } from '../recovery/startup.mjs';
import { acquireLifecycleLock } from '../recovery/lifecycle-lock.mjs';
import { openHubDatabase, seedProjects, logWriteWaits } from '../control/schema.mjs';
import { createControlStore } from '../control/store.mjs';
import { createProjectCatalog } from '../control/projects.mjs';
import { ensurePassword } from '../control/password.mjs';
import { createExecutionJobsReader } from '../control/execution-jobs.mjs';
import { createRuntimeConnection } from '../runtime/connection.mjs';
import { createSocketClient } from '../runtime/supervisor-client.mjs';
import { createSocketDataClient } from '../runtime/data-client.mjs';
import { runtimeDir } from '../runtime/protocol.mjs';
import { createApiServer, resolveLoginLimits, supervisorTransports } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Only the legacy external projects store credentials, and this entry runs the
// embedded modules only; the key stays with the runtime.
const noCredentials = () => { throw new Error('API 进程不处理项目凭据'); };

// The API process (design doc 3.1): sessions, the update coordinator, project
// configuration, Portal, the overview streams and static files, reaching the
// runtime only through its socket. It writes the control tables, so it seeds
// them. It holds `.api.lock` shared from before the recovery check until close()
// has closed the Hub database, so the recovery tools see it alive (design doc 5.7).
export async function startApi({ dataDir, logger = defaultLogger, signal, fail = () => {}, env = process.env, port = 3100, host = '127.0.0.1', distDir = path.join(root, 'dist'), updatesClient, loginLimits = resolveLoginLimits() }) {
  const resolvedData = path.resolve(dataDir);
  // Each step checks the lock too: a lost lock may already let a recovery tool in.
  const stopped = () => { lock.assertHeld(); if (signal?.aborted) throw new Error('API 启动已中止'); };
  let db = null, api = null, lock = null, closing = null;
  const stopWriteLog = logWriteWaits({ logger, role: 'api' });
  function close() {
    return closing ??= (async () => {
      const results = [];
      for (const action of [() => api?.close(), () => api?.closeServer(), stopWriteLog, () => db?.close(), () => lock?.close()]) { try { await action(); } catch (error) { results.push(error); } }
      if (results.length) throw new AggregateError(results, 'API 关闭失败');
    })();
  }
  try {
    // The runtime creates the data directory and the credential key first; a
    // database created here without the key would keep the runtime from starting.
    if (!existsSync(path.join(resolvedData, 'credentials.key'))) throw new Error('运行时尚未初始化数据目录，请先启动运行时');
    lock = await acquireLifecycleLock({ dataDir: resolvedData, name: 'api', mode: 'shared', onLost: fail });
    stopped();
    assertRecoveryStartup(resolvedData);
    lock.assertHeld();
    db = openHubDatabase(path.join(resolvedData, 'hub.sqlite'));
    const control = createControlStore(db);
    await ensurePassword(control, { initialPassword: env.INITIAL_PASSWORD, log: logger });
    seedProjects(control, { embeddedModules: true });
    stopped();
    const dir = runtimeDir(resolvedData, env);
    // A new runtime instance restarted every module in maintenance: take them all through the durable value again.
    // It has no stream counts yet either.
    const connection = createRuntimeConnection({ dir, onInstanceChange: () => { void api?.updates.resynchronize(); api?.reportStats(); } });
    const supervisor = createSocketClient({ dir, connection });
    api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: true }), encrypt: noCredentials, decrypt: noCredentials, embeddedModules: true, log: logger,
      supervisor, runtime: createSocketDataClient({ dir, connection, log: logger }), executionJobs: createExecutionJobsReader(db),
      readMaintenance: () => control.getSetting('updates-maintenance') === '1', updatesClient, secureCookies: env.COOKIE_SECURE === 'true',
      configuredOrigin: env.PUBLIC_ORIGIN ? validateAuthOrigin(env.PUBLIC_ORIGIN) : '', distDir, loginLimits, resolveTransport: supervisorTransports(supervisor) });
    // A module in fault or backoff must not keep the API from starting: its
    // execution entry stays refused until it is confirmed, and the release
    // watcher keeps retrying it.
    await api.initialize().catch(error => logger.warn({ err: error, type: 'startup' }, '交易模块的维护状态尚未全部确认，相关写入暂被拒绝'));
    stopped();
    await new Promise((resolve, reject) => { api.server.once('error', reject); api.server.listen(port, host, () => { api.server.off('error', reject); resolve(); }); });
    api.server.once('error', fail);
    stopped();
    return { ready: { port: api.server.address().port }, close, server: api.server };
  } catch (error) {
    try { await close(); } catch (cause) { logger.error({ err: cause, type: 'startup' }, 'API 启动失败后的清理未完成'); }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
  const port = Number(process.env.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
  void runProcess({ name: 'API', logger: defaultLogger, start: options => startApi({ ...options, dataDir, port, host: process.env.HOST || '127.0.0.1' }) });
}

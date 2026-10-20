import { createApp } from './app.mjs';
import { logger } from './logger.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModules } from './modules/runtime.mjs';
import { randomUUID } from 'node:crypto';
import { createAccountWriter } from './execution/account-writer.mjs';
import { mkdirSync } from 'node:fs';
import { acquireRuntimeLock } from './recovery/lifecycle-lock.mjs';
import { assertRecoveryStartup } from './recovery/startup.mjs';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
const dataDir = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
let app, modules, moduleStartup, accountWriter, runtimeLock, closing = false, shutdownPromise, exitCode = 0;
let finishStartup;
const startupFinished = new Promise(resolve => { finishStartup = resolve; });
const writerContext = { databasePath: path.join(dataDir, 'execution-control.sqlite'), runtimeId: randomUUID() };
function shutdown(code = 0) {
  exitCode = Math.max(exitCode, code); closing = true;
  return shutdownPromise ??= (async () => {
    // Close an incomplete worker group immediately, then await the startup
    // continuation before releasing the shared data-directory lock.
    let workerClose;
    try { workerClose = (modules || moduleStartup)?.close(); } catch (error) { workerClose = Promise.reject(error); }
    const workersClosed = Promise.allSettled([workerClose]);
    await startupFinished;
    const results = await Promise.allSettled([app?.close()]); results.push(...await workersClosed);
    if (!app) { try { accountWriter?.close(); } catch (error) { results.push({ status: 'rejected', reason: error }); } }
    try { await runtimeLock?.close(); } catch (error) { results.push({ status: 'rejected', reason: error }); }
    for (const result of results) if (result.status === 'rejected') logger.error({ err: result.reason }, '关闭组件失败');
    process.exit(results.some(result => result.status === 'rejected') ? 1 : exitCode);
  })();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { logger.info({ signal, type: 'shutdown' }, '收到关闭信号，正在优雅退出...'); void shutdown(); });
try {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  runtimeLock = await acquireRuntimeLock({ dataDir, onLost: error => { logger.error({ err: error }, '数据目录运行锁失效'); void shutdown(1); } });
  if (closing) throw new Error('工作台启动已中止');
  assertRecoveryStartup(dataDir);
  accountWriter = createAccountWriter({ ...writerContext, moduleId: 'hub' });
  modules = await startModules({ dataDir, logger, writerContext, onStarting: handle => { moduleStartup = handle; }, onFailure: error => { logger.error({ err: error }, '内嵌模块已停止，正在关闭工作台'); void shutdown(1); } });
  runtimeLock.assertHeld();
  if (closing) throw new Error('工作台启动已中止');
  app = await createApp({ logger, dataDir, embeddedModules: true, accountWriter });
  runtimeLock.assertHeld();
  if (closing) throw new Error('工作台启动已中止');
} catch (error) {
  // shutdown() ends with process.exit, so the cause must be logged before it; a signal,
  // lost lock or module failure already logged why startup was aborted.
  if (closing) logger.warn({ err: error, type: 'startup' }, '工作台启动已中止');
  else logger.error({ err: error, type: 'startup' }, '工作台启动失败');
  finishStartup(); await shutdown(1); throw error;
}
finally { finishStartup(); }
app.server.listen(port, host, () => logger.info({ port, host, type: 'startup' }, `工作台已启动：http://${host}:${port}`));
app.server.once('error', error => { logger.error({ err: error }, '工作台监听失败'); void shutdown(1); });

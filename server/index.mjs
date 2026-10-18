import { createApp } from './app.mjs';
import { logger } from './logger.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModules } from './modules/runtime.mjs';
import { randomUUID } from 'node:crypto';
import { createAccountWriter } from './execution/account-writer.mjs';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
const dataDir = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
let app, modules, accountWriter, closing = false;
const writerContext = { databasePath: path.join(dataDir, 'execution-control.sqlite'), runtimeId: randomUUID() };
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  // Begin every engine's shutdown together, within the service stop budget.
  // Failure in one close path must not leave another trading worker running.
  const results = await Promise.allSettled([app?.close(), modules?.close()]);
  for (const result of results) if (result.status === 'rejected') logger.error({ err: result.reason }, '关闭组件失败');
  process.exit(results.some(result => result.status === 'rejected') ? 1 : code);
}
try {
  accountWriter = createAccountWriter({ ...writerContext, moduleId: 'hub' });
  modules = await startModules({ dataDir, logger, writerContext, onFailure: error => { logger.error({ err: error }, '内嵌模块已停止，正在关闭工作台'); void shutdown(1); } });
  app = await createApp({ logger, dataDir, embeddedModules: true, accountWriter });
} catch (error) { await modules?.close(); accountWriter?.close(); throw error; }
app.server.listen(port, host, () => logger.info({ port, host, type: 'startup' }, `工作台已启动：http://${host}:${port}`));
app.server.once('error', error => { logger.error({ err: error }, '工作台监听失败'); void shutdown(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { logger.info({ signal, type: 'shutdown' }, '收到关闭信号，正在优雅退出...'); void shutdown(); });

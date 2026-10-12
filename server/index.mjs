import { createApp } from './app.mjs';
import { logger } from './logger.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModules } from './modules/runtime.mjs';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
const dataDir = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
let app, modules, closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await app?.close();
  await modules?.close();
  process.exit(code);
}
try {
  modules = await startModules({ dataDir, logger, onFailure: error => { logger.error({ err: error }, '内嵌模块已停止，正在关闭工作台'); void shutdown(1); } });
  app = await createApp({ logger, dataDir, embeddedModules: true });
} catch (error) { await modules?.close(); throw error; }
app.server.listen(port, host, () => logger.info({ port, host, type: 'startup' }, `工作台已启动：http://${host}:${port}`));
app.server.once('error', error => { logger.error({ err: error }, '工作台监听失败'); void shutdown(1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { logger.info({ signal, type: 'shutdown' }, '收到关闭信号，正在优雅退出...'); void shutdown(); });

import { createApp } from './app.mjs';
import { logger } from './logger.mjs';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
const app = await createApp({ logger });
app.server.listen(port, host, () => logger.info({ port, host, type: 'startup' }, `工作台已启动：http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { logger.info({ signal, type: 'shutdown' }, '收到关闭信号，正在优雅退出...'); await app.close(); process.exit(0); });

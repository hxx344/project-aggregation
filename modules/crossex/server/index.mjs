import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 3200), host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const app = createApp();
app.server.listen(port, host, () => console.log(`Gate CrossEx 手动实盘已启动：http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });

import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
const app = await createApp();
app.server.listen(port, host, () => console.log(`工作台已启动：http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });

// Local browser fixture whose first render embeds a Hynix overview trend. No collectors, database, credentials or live APIs.
// node --experimental-strip-types tests/hynix-initial-server.mjs [3198]
import { createServer } from 'node:http';
import { createPageHandler } from '../server/page-handler.mjs';

const port = Number(process.argv[2] ?? 3198);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a local fixture port');
const hour = 3_600_000, renderedAt = Date.now(), last = Math.floor(renderedAt / hour) * hour - hour;
// Only the persisted Hynix history is readable at render time; every other dataset is missing.
const history = { status: 'live', fetchedAt: new Date(renderedAt).toISOString(), interval: '1h', firstAvailable: new Date(last - 199 * hour).toISOString(), warnings: [],
  points: Array.from({ length: 200 }, (_, index) => ({ time: last - (199 - index) * hour, ordinary: 1000, adr: 104 + index % 3, equivalent: 100, spread: 4 + index % 3, premium: index === 199 ? 5 : 4 + index % 3 })) };
const services = new Map([['hynix', { async handle(action) { if (action === 'history') return history; throw new Error('Fixture dataset unavailable'); } }]]);
const pages = await createPageHandler({ services });
const server = createServer((request, response) => {
  if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
  if (request.url.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Browser fixture unavailable' })); return; }
  void pages.handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500).end('Fixture rendering failed');
    else response.destroy();
  });
});
await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
process.stdout.write(`Hynix first-render fixture ready at http://127.0.0.1:${port}\n`);
async function stop() {
  server.closeAllConnections();
  await new Promise(accept => server.close(accept));
  await pages.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

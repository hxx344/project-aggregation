// Local browser fixture whose first render embeds an oil overview trend. No collectors, database, credentials or live APIs.
// node --experimental-strip-types tests/oil-initial-server.mjs [3199]
import { createServer } from 'node:http';
import { createPageHandler } from '../server/page-handler.mjs';
import { createIntradaySnapshot, OIL_CANDLE_MS } from '../modules/oil/intraday.mjs';

const port = Number(process.argv[2] ?? 3199);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a local fixture port');
const renderedAt = Date.now(), last = Math.floor(renderedAt / OIL_CANDLE_MS) * OIL_CANDLE_MS - OIL_CANDLE_MS;
// Only the persisted 15-minute candles are readable at render time; every other dataset is missing.
// Nine days of bars so the embedded trend keeps exactly the last seven days (672 bars); the last spread is 4.500.
const candles = createIntradaySnapshot(Array.from({ length: 864 }, (_, index) => ({ time: last - (863 - index) * OIL_CANDLE_MS, brent: index === 863 ? 70.5 : 70 + index % 3 / 10, wti: 66 })), new Date(renderedAt).toISOString());
const services = new Map([['oil', { async handle(action) { if (action === 'candles/15m') return candles; throw new Error('Fixture dataset unavailable'); } }]]);
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
process.stdout.write(`Oil first-render fixture ready at http://127.0.0.1:${port}\n`);
async function stop() {
  server.closeAllConnections();
  await new Promise(accept => server.close(accept));
  await pages.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

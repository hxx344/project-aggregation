// Local browser fixture. No collectors, database, credentials or live APIs.
// node tests/ssr-browser-server.mjs 3189 [3193 ...]
import { createServer } from 'node:http';
import { createPageHandler } from '../server/page-handler.mjs';

const ports = process.argv.slice(2).map(Number);
if (!ports.length) ports.push(3189);
if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Expected local fixture ports');
const pages = await createPageHandler({ services: new Map() });
const servers = [];
for (const port of ports) {
  const server = createServer((request, response) => {
    if (request.url === '/__stop' && request.method === 'POST') { response.end('stopped'); void stop(); return; }
    if (request.url.startsWith('/api/')) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Browser fixture unavailable' })); return; }
    void pages.handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end('Fixture rendering failed');
      else response.destroy();
    });
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  servers.push(server);
  console.log(`React SSR browser fixture ready at http://127.0.0.1:${port}`);
}
async function stop() {
  await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise(accept => server.close(accept)); }));
  await pages.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

// Build the Hub, Monitor and CrossEx, then run this read-only local fixture.
// APIs are supplied only by tests/opportunity-import.browser.mjs; no collectors run.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPageHandler } from '../modules/monitor/server/page-handler.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4176;
const monitor = await createPageHandler({ services: new Map(), root: path.join(root, 'modules/monitor') });
const hosts = new Map([
  [`hub.localhost:${port}`, 'dist'],
  [`p-111111111111111111111111.hub.localhost:${port}`, 'monitor'],
  [`p-222222222222222222222222.hub.localhost:${port}`, 'modules/crossex/dist'],
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = http.createServer(async (request, response) => {
  const directory = hosts.get(request.headers.host);
  if (!directory || request.method !== 'GET') { response.writeHead(404).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) { response.writeHead(404).end('Browser fixture API required'); return; }
    if (directory === 'monitor') { await monitor.handle(request, response); return; }
    const base = path.resolve(root, directory), file = path.resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(base + path.sep)) { response.writeHead(404).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch (error) {
    console.error('Opportunity import fixture:', error.message);
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy(error);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated Hub / Monitor / CrossEx preview on http://hub.localhost:${port}`));
async function stop() {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await monitor.close();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

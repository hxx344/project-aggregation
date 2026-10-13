// Isolated static preview for tests/crossex-position-metrics.browser.mjs.
// Build the Hub and CrossEx first. APIs must be supplied by the browser fixture.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer(async (request, response) => {
  const host = request.headers.host;
  const directory = host === 'hub.localhost:4175' ? 'dist' : host === 'p-000000000000000000000000.hub.localhost:4175' ? 'modules/crossex/dist' : null;
  if (!directory || request.method !== 'GET') { response.writeHead(404).end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) { response.writeHead(404).end('Fixture API required'); return; }
    const base = path.resolve(root, directory), file = path.resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(base + path.sep)) { response.writeHead(404).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { response.writeHead(404).end(); }
});
server.listen(4175, '127.0.0.1', () => console.log('Isolated Hub/CrossEx static preview on port 4175'));

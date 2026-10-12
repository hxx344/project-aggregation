import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createPageHandler } from '../server/page-handler.mjs';
import { createAuthorization, createHandler } from '../server/http.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const credentials = { username: 'development-fixture', password: 'development-test-password-only' };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;

function listeners() {
  // Inspect only handles owned by this test process; never probe another service.
  return new Set(process._getActiveHandles().filter(handle => typeof handle.address === 'function' && handle.listening));
}

function deadline(task, ms, message) {
  let timer;
  return Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

function read(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.setTimeout(30_000, () => request.destroy(new Error('Development HTTP request timed out')));
    request.end();
  });
}

async function fixture(t) {
  const before = listeners(), sockets = new Set(), clients = new Set();
  const services = new Map();
  let pages, server, pageClosed = false;
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    if (pages && !pageClosed) await deadline(pages.close(), 10_000, 'Vite cleanup timed out');
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  pages = await createPageHandler({ root, services, development: true, authorize: createAuthorization(credentials) });
  assert.equal(typeof pages.handleUpgrade, 'function');
  assert.deepEqual([...listeners()].filter(handle => !before.has(handle)), [], 'Creating Vite middleware must not open an independent HMR listener');
  server = createServer(createHandler({ ...credentials, services, pageHandler: pages.handle }));
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', pages.handleUpgrade);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const ownListeners = [...listeners()].filter(handle => !before.has(handle));
  assert.deepEqual(ownListeners, [server], 'HTTP and HMR share the one randomly assigned application listener');
  return {
    port,
    read: (path, headers) => read(port, path, headers),
    async open({ headers = {}, path = '/', protocol = 'vite-hmr' } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocol, { headers, handshakeTimeout: 5000 });
      clients.add(ws);
      ws.once('close', () => clients.delete(ws));
      return deadline(new Promise((resolve, reject) => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve({ ws, ...value }); } };
        ws.on('message', data => {
          try { const message = JSON.parse(data.toString()); if (message.type === 'connected') finish({ message }); }
          catch (error) { reject(error); }
        });
        ws.once('unexpected-response', (_request, response) => {
          response.resume();
          finish({ status: response.statusCode });
          ws.terminate();
        });
        ws.on('error', error => { if (!settled) { settled = true; reject(error); } });
        ws.once('close', () => { if (!settled) { settled = true; reject(new Error('HMR closed before sending connected')); } });
      }), 7000, 'HMR handshake timed out');
    },
    async closePages() {
      await deadline(pages.close(), 10_000, 'Vite must close with a live HMR connection');
      pageClosed = true;
    },
  };
}

test('development refuses to start without an explicit shared authorization check', async () => {
  let unexpected;
  try {
    await assert.rejects(async () => { unexpected = await createPageHandler({ root, services: new Map(), development: true }); }, /authoriz/i);
  } finally { await unexpected?.close(); }
});

test('real Vite HTTP and HMR share Basic authentication without a second listener', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  await t.test('HTML and the Vite client require the same Basic credentials', async () => {
    for (const path of ['/', '/@vite/client']) {
      for (const headers of [{}, { Authorization: 'Basic wrong-credentials' }]) {
        const response = await f.read(path, headers);
        assert.equal(response.status, 401, path);
        assert.match(response.headers['www-authenticate'], /^Basic /);
      }
      const response = await f.read(path, { Authorization: authorization });
      assert.equal(response.status, 200, path);
      assert.match(response.text, path === '/' ? /market-initial-data/ : /\bwsToken\b/);
    }
  });
  await t.test('unauthorized non-browser upgrades are rejected before Vite accepts a connection', async () => {
    for (const headers of [{}, { Authorization: 'Basic wrong-credentials' }]) {
      const response = await f.open({ headers });
      assert.equal(response.status, 401);
      assert.equal(response.message, undefined);
      assert.equal((await f.read('/healthz')).status, 200, 'Rejected HMR handshakes leave the application healthy');
    }
  });
  await t.test('authenticated non-browser and browser connections retain Vite token checks', async () => {
    const direct = await f.open({ headers: { Authorization: authorization } });
    assert.equal(direct.message.type, 'connected');
    direct.ws.close();
    const client = await f.read('/@vite/client', { Authorization: authorization });
    const match = /\bconst wsToken\s*=\s*("(?:[^"\\]|\\.)*")/.exec(client.text);
    assert.ok(match, 'The served Vite client includes its generated WebSocket token');
    const token = JSON.parse(match[1]);
    const headers = { Authorization: authorization, Origin: `http://127.0.0.1:${f.port}` };
    const rejected = await f.open({ headers, path: '/?token=invalid-fixture-token' });
    assert.ok(rejected.status >= 400 && rejected.status < 500, 'Basic does not bypass Vite browser-origin token verification');
    assert.equal(rejected.message, undefined);
    const browser = await f.open({ headers, path: `/?token=${encodeURIComponent(token)}` });
    assert.equal(browser.message.type, 'connected');
    assert.equal(browser.ws.readyState, WebSocket.OPEN);
    const disconnected = new Promise(resolve => browser.ws.once('close', resolve));
    await f.closePages();
    await deadline(disconnected, 5000, 'The HMR client must receive the server shutdown');
    assert.equal(browser.ws.readyState, WebSocket.CLOSED, 'Closing Vite terminates its active HMR client');
  });
});

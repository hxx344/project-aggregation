import { timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { moduleCapabilities } from './capabilities.mjs';

let application, closing = false, closeTimeoutMs = 30_000;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), closeTimeoutMs).unref();
  try { await application?.close(); }
  finally { clearTimeout(deadline); process.exit(code); }
}
function equal(value, expected) {
  const input = Buffer.from(typeof value === 'string' ? value : '');
  const secret = Buffer.from(expected);
  return input.length === secret.length && timingSafeEqual(input, secret);
}
process.on('message', async message => {
  if (message?.type === 'shutdown') return void close();
  if (message?.type !== 'start' || application || closing) return;
  try {
    const { id, root, dataDir, secret, socketPath, environment, transports } = message;
    if (!['monitor', 'asset', 'crossex', 'greeks', 'aster'].includes(id)) throw new Error('Invalid module');
    closeTimeoutMs = id === 'aster' ? 110_000 : 30_000;
    process.chdir(root);
    const { createModule } = await import(`./${id}.mjs`);
    application = await createModule({ root, dataDir, secret, environment, transports });
    const handlers = application.server.listeners('request');
    application.server.removeAllListeners('request');
    application.server.on('request', (request, response) => {
      if (!equal(request.headers['x-workspace-key'], secret)) {
        response.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        response.end('Forbidden'); return;
      }
      let url;
      try { url = new URL(request.url, 'http://workspace.internal'); }
      catch { response.writeHead(400, { 'Cache-Control': 'no-store' }).end(); return; }
      if (url.pathname === '/__workspace/capabilities') {
        const status = request.method !== 'GET' ? 405 : url.search ? 400 : 200;
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'GET' } : {}) });
        response.end(JSON.stringify(status === 200 ? moduleCapabilities(id) : { error: 'Invalid capabilities request' }));
        return;
      }
      for (const handler of handlers) handler.call(application.server, request, response);
    });
    // Production modules do not expose WebSocket upgrades through this bridge.
    application.server.removeAllListeners('upgrade');
    application.server.on('upgrade', (_request, socket) => socket.destroy());
    await new Promise((resolve, reject) => { application.server.once('error', reject); application.server.listen(socketPath, resolve); });
    application.server.on('error', error => { console.error(error.message); void close(1); });
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
    process.send?.({ type: 'ready', id });
  } catch (error) {
    console.error(error.stack || error.message);
    process.send?.({ type: 'failed', message: '模块启动失败，请检查服务日志' });
    await close(1);
  }
});
process.once('disconnect', () => void close());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());

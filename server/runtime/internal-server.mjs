import http from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { createSecret, ensureRuntimeDir, equalSecret, MAX_REQUEST_BYTES, PROTOCOL_VERSION, removeDiscovery, RUNTIME_KEY_HEADER, RuntimeError, socketPathFor, writeDiscovery } from './protocol.mjs';

const windows = process.platform === 'win32';
const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
};
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_REQUEST_BYTES) throw new RuntimeError(400, '请求体过大'); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RuntimeError(400, '请求体不是有效 JSON'); }
}

// Routes of design doc 5.2 handled in this batch; overview, forwarding and stats arrive with the runtime entry.
export function createInternalHandler({ service, secret, logger = console }) {
  const routes = [
    ['GET', /^\/internal\/v1\/status$/, () => service.status()],
    ['GET', /^\/internal\/v1\/modules\/([a-z]+)\/transport$/, (_, id) => service.resolveTransport(id)],
    ['POST', /^\/internal\/v1\/maintenance\/sync$/, body => service.syncMaintenance(body?.modules)],
    ['POST', /^\/internal\/v1\/maintenance\/prepare-stop$/, () => service.prepareStop()],
    ['POST', /^\/internal\/v1\/modules\/([a-z]+)\/restart$/, (_, id) => service.restartModule(id)],
  ];
  return async (req, res) => {
    try {
      if (!equalSecret(req.headers[RUNTIME_KEY_HEADER], secret)) { req.resume(); json(res, 401, { error: { message: '内部请求未授权' } }); return; }
      const url = new URL(req.url, 'http://runtime.internal');
      if (url.search) throw new RuntimeError(400, '内部接口不接受查询参数');
      const matches = routes.map(([method, pattern, handle]) => ({ method, handle, match: pattern.exec(url.pathname) })).filter(item => item.match);
      if (!matches.length) throw new RuntimeError(404, '内部接口不存在');
      const route = matches.find(item => item.method === req.method);
      if (!route) throw new RuntimeError(405, '内部接口方法不匹配');
      const body = req.method === 'POST' ? await readBody(req) : (req.resume(), null);
      json(res, 200, await route.handle(body, ...route.match.slice(1)));
    } catch (error) {
      if (error instanceof RuntimeError) { json(res, error.status, { error: { message: error.message } }); return; }
      logger.error?.({ err: error, type: 'runtime-internal' }, '运行时内部接口处理失败');
      json(res, 503, { error: { message: '运行时内部错误' } });
    }
  };
}

// Listens on the private socket, then publishes the discovery record; close() withdraws both.
export async function startInternalServer({ service, dir, release = null, logger = console }) {
  ensureRuntimeDir(dir);
  const secret = createSecret(), socketPath = socketPathFor(dir, service.instanceId);
  const server = http.createServer(createInternalHandler({ service, secret, logger }));
  // prepare-stop may take up to 70 s; headers must still arrive promptly.
  server.requestTimeout = 75_000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  if (!windows) rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  let closed = false;
  async function close() {
    if (closed) return; closed = true;
    removeDiscovery(dir, service.instanceId);
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
    if (!windows) rmSync(socketPath, { force: true });
  }
  try {
    if (!windows) chmodSync(socketPath, 0o600);
    writeDiscovery(dir, { schemaVersion: 1, protocol: PROTOCOL_VERSION, instanceId: service.instanceId, pid: process.pid, socketPath, secret, startedAt: new Date().toISOString(), release });
  } catch (error) { await close(); throw error; }
  return { socketPath, server, close };
}

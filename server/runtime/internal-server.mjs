import http from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { createSecret, ensureRuntimeDir, equalSecret, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_VERSION, removeDiscovery, removeStaleRuntimeFiles, RUNTIME_KEY_HEADER, RuntimeError, socketPathFor, writeDiscovery } from './protocol.mjs';
import { DEADLINE_HEADER, FORWARD_PREFIX, METHOD_HEADER, SESSION_HEADER, validateChange, validateForward, validateProjectId, validateRevision } from './data-client.mjs';

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

// An events stream whose reader stops keeping up is dropped; the API reconnects and starts from a full projection.
const MAX_EVENT_BACKLOG = 2 * MAX_RESPONSE_BYTES;
const PROJECT = '([a-zA-Z0-9_-]{1,64})';

// Routes of design doc 5.2. The data-plane routes exist when `dataPlane` is
// given; api-stats arrives with P1-4.
export function createInternalHandler({ service, dataPlane = null, secret, logger = console }) {
  const routes = [
    ['GET', /^\/internal\/v1\/status$/, () => service.status()],
    ['GET', /^\/internal\/v1\/modules\/([a-z]+)\/transport$/, (_, id) => service.resolveTransport(id)],
    ['POST', /^\/internal\/v1\/maintenance\/sync$/, body => service.syncMaintenance(body?.modules)],
    ['POST', /^\/internal\/v1\/maintenance\/prepare-stop$/, () => service.prepareStop()],
    ['POST', /^\/internal\/v1\/modules\/([a-z]+)\/restart$/, (_, id) => service.restartModule(id)],
    ...(dataPlane ? [
      ['GET', /^\/internal\/v1\/overview$/, () => dataPlane.overview()],
      ['POST', new RegExp(`^/internal/v1/projects/${PROJECT}/changed$`), (body, id) => { dataPlane.projectChanged(validateProjectId(id), validateChange(body)); return { accepted: true }; }],
      ['POST', new RegExp(`^/internal/v1/projects/${PROJECT}/asset-sync$`), async (body, id) => ({ status: await dataPlane.coordinateAssetSync(validateProjectId(id), validateRevision(body?.revision)) })],
      // Transitional until P1-4 reports the API's SSE counts as one record.
      ['POST', /^\/internal\/v1\/overview\/slow-consumers$/, () => { dataPlane.observeSlowConsumer(); return { accepted: true }; }],
    ] : []),
  ];
  function events(res) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    const write = event => { if (res.writableLength > MAX_EVENT_BACKLOG) res.destroy(); else res.write(`${JSON.stringify(event)}\n`); };
    const stop = dataPlane.subscribeOverview({ wants: () => true, deliver: write });
    res.once('close', stop);
    write(dataPlane.overviewEvent());
  }
  // The browser request's path, query, method, content type and body, checked again on this side.
  async function forward(req, res, url) {
    const deadline = req.headers[DEADLINE_HEADER], override = req.headers[METHOD_HEADER];
    if (override !== undefined && (override !== 'HEAD' || req.method !== 'GET')) throw new RuntimeError(400, '转发请求的方法无效');
    const request = validateForward({ method: override ?? req.method, target: url.pathname.slice(FORWARD_PREFIX.length) + url.search, sessionId: req.headers[SESSION_HEADER],
      contentType: req.headers['content-type'], deadline: deadline === undefined ? undefined : /^\d{1,16}$/.test(deadline) ? Number(deadline) : NaN, body: req });
    // The client checks the reply against the contract, as it does in process.
    const reply = await dataPlane.handle(request);
    json(res, 200, { status: reply?.status, body: reply?.body });
  }
  return async (req, res) => {
    try {
      if (!equalSecret(req.headers[RUNTIME_KEY_HEADER], secret)) { req.resume(); json(res, 401, { error: { message: '内部请求未授权' } }); return; }
      const url = new URL(req.url, 'http://runtime.internal');
      if (dataPlane && url.pathname.startsWith(`${FORWARD_PREFIX}/`)) { await forward(req, res, url); return; }
      if (url.search) throw new RuntimeError(400, '内部接口不接受查询参数');
      if (dataPlane && url.pathname === '/internal/v1/overview/events') {
        if (req.method !== 'GET') throw new RuntimeError(405, '内部接口方法不匹配');
        req.resume(); events(res); return;
      }
      const matches = routes.map(([method, pattern, handle]) => ({ method, handle, match: pattern.exec(url.pathname) })).filter(item => item.match);
      if (!matches.length) throw new RuntimeError(404, '内部接口不存在');
      const route = matches.find(item => item.method === req.method);
      if (!route) throw new RuntimeError(405, '内部接口方法不匹配');
      const body = req.method === 'POST' ? await readBody(req) : (req.resume(), null);
      json(res, 200, await route.handle(body, ...route.match.slice(1)));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof RuntimeError) { json(res, error.status, { error: { message: error.message } }); return; }
      logger.error?.({ err: error, type: 'runtime-internal' }, '运行时内部接口处理失败');
      json(res, 503, { error: { message: '运行时内部错误' } });
    }
  };
}

// Listens on the private socket, then publishes the discovery record; close() withdraws both.
// The caller holds `.runtime.lock`, so files of earlier instances in `dir` are stale.
export async function startInternalServer({ service, dataPlane = null, dir, release = null, logger = console }) {
  ensureRuntimeDir(dir);
  const secret = createSecret(), socketPath = socketPathFor(dir, service.instanceId);
  removeStaleRuntimeFiles(dir, service.instanceId);
  const server = http.createServer(createInternalHandler({ service, dataPlane, secret, logger }));
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

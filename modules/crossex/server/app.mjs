import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { createMarket } from './market.mjs';
import { createLiveRuntime } from './live-runtime.mjs';
import { createTerminalMarket } from './terminal-market.mjs';
import { AppError } from './model.mjs';
import { createAuthenticator } from './auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));
const makePassword = value => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`; };
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('请使用 JSON 请求', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new AppError('请求过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('请求格式无效'); }
}
export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, '.data'), initialPassword = process.env.INITIAL_PASSWORD, publicOrigin = process.env.PUBLIC_ORIGIN || '', intervalMs = 5000, sourceIntervalMs = intervalMs > 0 ? Math.min(intervalMs, 2000) : 0, marketOptions, liveOptions, terminalOptions, engineOptions, authorizeRequest, initialWorkspaceMaintenance = false, logger = console.log, distDir = path.join(root, 'dist') } = {}) {
  if (authorizeRequest !== undefined && typeof authorizeRequest !== 'function') throw new TypeError('authorizeRequest must be a function');
  const store = createStore(dataDir);
  if (!authorizeRequest && !store.get('password')) {
    const value = initialPassword || randomBytes(18).toString('base64url');
    if (typeof value !== 'string' || value.length < 12 || value.length > 1024) { store.close(); throw new Error('INITIAL_PASSWORD 需要 12–1024 个字符'); }
    store.set('password', makePassword(value));
    if (!initialPassword) logger(`CrossEx 初始登录信息：admin / ${value}\n首次显示，请保存。重置：node server/setup.mjs --reset-password`);
  }
  // The old paper engine is deliberately not imported. Saved simulated orders,
  // positions and automation flags cannot enter this execution path.
  const market = createMarket(store, marketOptions ?? engineOptions);
  let live;
  try { live = createLiveRuntime(store, { ...liveOptions, market }); }
  catch (error) { store.close(); throw error; }
  const terminal = createTerminalMarket({ ...terminalOptions, market });
  const csrf = randomBytes(32).toString('base64url');
  const auth = createAuthenticator({ getRecord: () => store.get('password') });
  let accountTimer = null, stopping = false, workspaceMaintenance = Boolean(authorizeRequest && initialWorkspaceMaintenance);
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const runTick = () => {
    if (stopping) return;
    // Each market reader owns its in-flight request. Neither can delay accounts.
    void market.refreshSource();
    void market.refreshCatalog();
  };
  const pollAccount = async () => {
    if (stopping) return;
    const startedAt = performance.now();
    try { await live.refresh({ includeView: false }); }
    catch { logger('账户本轮读取未完成，等待下一次检查'); }
    finally {
      // One chain prevents overlap; slow reads resume promptly instead of
      // losing another full interval to a skipped fixed timer tick.
      if (!stopping) {
        accountTimer = setTimeout(pollAccount, Math.max(0, intervalMs - (performance.now() - startedAt)));
        accountTimer.unref();
      }
    }
  };
  const timer = intervalMs > 0 ? setInterval(runTick, intervalMs) : null; timer?.unref();
  const sourceTimer = sourceIntervalMs > 0 ? setInterval(() => { if (!stopping) void market.refreshSource(); }, sourceIntervalMs) : null; sourceTimer?.unref();
  if (intervalMs > 0) { runTick(); void pollAccount(); }
  async function authenticate(req) {
    if (authorizeRequest) return authorizeRequest(req);
    return auth.authenticate(req.headers.authorization || '');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname;
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', mode: 'live', executionMode: 'manual', liveTradingAvailable: true });
      if (!await authenticate(req)) { res.setHeader('WWW-Authenticate', 'Basic realm="Gate CrossEx", charset="UTF-8"'); return json(res, 401, { error: '需要模块登录信息' }); }
      if (authorizeRequest && route === '/__workspace/update-status' && req.method === 'GET') return json(res, 200, live.updateStatus());
      if (authorizeRequest && route === '/__workspace/maintenance' && req.method === 'POST') {
        const input = await body(req);
        if (!input || typeof input.active !== 'boolean' || Object.keys(input).some(key => key !== 'active')) throw new AppError('维护状态无效');
        workspaceMaintenance = input.active;
        return json(res, 200, { active: workspaceMaintenance });
      }
      if (workspaceMaintenance && !['GET', 'HEAD'].includes(req.method)) return json(res, 503, { error: '工作台正在准备更新，请稍后重试', requestStatus: 'not_submitted' });
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expected = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site' || !equal(req.headers['x-csrf-token'] || '', csrf)) throw new AppError('操作来源或会话校验失败，请刷新页面', 403);
      }
      if (route === '/api/bootstrap' && req.method === 'GET') return json(res, 200, {
        now: Date.now(), config: { ...market.config(), hasMonitorPassword: !!store.get('monitorPassword') }, connection: live.connectionView(), csrfToken: csrf,
      });
      if (route === '/api/state' && req.method === 'GET') return json(res, 200, { ...live.view({ includeOpportunities: url.searchParams.get('opportunities') !== '0', ...(url.searchParams.get('funding') === '1' ? { includeFundingOpportunities: true } : {}) }), csrfToken: csrf });
      if (route === '/api/hub/summary' && req.method === 'GET') {
        const { updatedAt, metrics, health } = live.summary();
        if (url.searchParams.get('schemaVersion') === '2') return json(res, 200, { schemaVersion: 2, data: { updatedAt, metrics, health } });
        return json(res, 200, { schemaVersion: 1, data: { updatedAt: updatedAt || new Date(0).toISOString(), metrics } });
      }
      if (route === '/api/settings' && req.method === 'PUT') return json(res, 200, market.settings(await body(req)));
      if (route === '/api/live/connection' && req.method === 'PUT') return json(res, 200, await live.connection(await body(req)));
      if (route === '/api/live/connection' && req.method === 'DELETE') return json(res, 200, await live.disconnect());
      if (route === '/api/live/refresh' && req.method === 'POST') { await body(req); await live.refresh({ includeView: false }); return json(res, 200, live.view({ includeOpportunities: false })); }
      if (route === '/api/live/instruments' && req.method === 'GET') return json(res, 200, await market.instruments());
      if (route === '/api/live/market' && req.method === 'GET') return json(res, 200, await terminal.read(url.searchParams.get('symbol'), url.searchParams.get('interval') || '5m'));
      if (route === '/api/live/preview' && req.method === 'POST') return json(res, 200, await live.preview(await body(req)));
      if (route === '/api/live/open-capacity' && req.method === 'POST') return json(res, 200, await live.openCapacity(await body(req)));
      if (route === '/api/live/confirm' && req.method === 'POST') return json(res, 200, await live.confirm(await body(req)));
      if (route === '/api/live/cancel' && req.method === 'POST') return json(res, 200, await live.cancel(await body(req)));
      if (route.startsWith('/api/live/requests/') && req.method === 'GET') return json(res, 200, await live.requestStatus(decodeURIComponent(route.slice('/api/live/requests/'.length))));
      if (['/api/open', '/api/close', '/api/execution'].includes(route)) throw new AppError('模拟交易接口已移除，请刷新页面并使用实盘预览确认', 410);
      if (route.startsWith('/api/')) throw new AppError('不支持此接口或请求方法', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError('不支持此请求方法', 405);
      const asset = route === '/' ? 'index.html' : route.replace(/^\//, '');
      if (!/^(?:index\.html|favicon\.svg|assets\/[A-Za-z0-9_.-]+)$/.test(asset)) throw new AppError('页面不存在', 404);
      let content; try { content = await readFile(path.join(distDir, asset)); } catch { throw new AppError('页面尚未构建或文件不存在', 404); }
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
      if (/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(asset)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.writeHead(200, { 'Content-Type': types[path.extname(asset)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '操作未完成，请检查服务状态', ...(error.requestStatus === 'not_submitted' ? { requestStatus: 'not_submitted' } : {}) }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, market, live, terminal, store, resetPassword() { const password = randomBytes(18).toString('base64url'); store.set('password', makePassword(password)); auth.reset(); return password; }, async close() { stopping = true; clearInterval(timer); clearInterval(sourceTimer); clearTimeout(accountTimer); await live.stop(); await terminal.stop(); await market.stop(); await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); store.close(); } };
}

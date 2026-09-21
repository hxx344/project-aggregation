import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUrl, validateAuthOrigin, readSummary, UpstreamError } from './adapters.mjs';
import { createPortal } from './portal.mjs';
import { createAssetSync, syncAsset } from './asset-sync.mjs';

const scrypt = promisify(scryptCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SESSION_AGE = 12 * 60 * 60 * 1000;
const defaults = [
  { id: 'aster', name: 'ASTER 5X', description: '交易账户、保证金占用与运行状态', category: 'trading', adapter: 'aster', url: 'http://127.0.0.1:8765', apiUrl: 'http://127.0.0.1:8765', staleAfterSeconds: 120 },
  { id: 'monitor', name: 'Market Monitor', description: '原油价差与市场监控', category: 'monitoring', adapter: 'monitor', url: 'http://127.0.0.1:3000/?monitor=oil', apiUrl: 'http://127.0.0.1:3000', staleAfterSeconds: 120 },
  { id: 'asset', name: 'Asset Ledger', description: '资产账本、持有金额与历史变化', category: 'assets', adapter: 'asset', url: 'http://127.0.0.1:5678', apiUrl: 'http://127.0.0.1:5678', staleAfterSeconds: 900 },
].map((project, order) => ({ ...project, authOrigin: '', mode: 'external', enabled: true, order }));

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}
async function passwordMatches(password, record) {
  const [salt, expected] = record.split(':');
  const derived = await scrypt(password, salt, 64);
  return timingSafeEqual(derived, Buffer.from(expected, 'hex'));
}

export async function createApp({ dataDir = process.env.DATA_DIR || path.join(root, '.data'), initialPassword = process.env.INITIAL_PASSWORD, refreshInterval = 30000, timeoutMs = 5000, loginWindowMs = 15 * 60000, summaryReader = readSummary, assetSyncIntervalMs = 60000, assetSyncReader = syncAsset, logger = console.log, secureCookies = process.env.COOKIE_SECURE === 'true', publicOrigin = process.env.PUBLIC_ORIGIN || '', distDir = path.join(root, 'dist') } = {}) {
  const configuredOrigin = publicOrigin ? validateAuthOrigin(publicOrigin) : '';
  const resolvedData = path.resolve(dataDir);
  mkdirSync(resolvedData, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(resolvedData, 0o700);
  const keyPath = path.join(resolvedData, 'credentials.key');
  const dbPath = path.join(resolvedData, 'hub.sqlite');
  if (!existsSync(keyPath)) {
    if (existsSync(dbPath)) throw new Error('凭据密钥文件缺失，请恢复 credentials.key 后再启动');
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('凭据密钥文件长度不正确');
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,json TEXT NOT NULL,credentials TEXT); CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);');
  if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  const getSetting = name => db.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value;
  if (!getSetting('password')) {
    const password = initialPassword || randomBytes(18).toString('base64url');
    if (password.length < 12 || password.length > 1024) { db.close(); throw new Error('INITIAL_PASSWORD 必须为 12 至 1024 个字符'); }
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('password', await passwordRecord(password));
    if (!initialPassword) logger(`工作台初始登录密码：${password}\n请保存此密码；只在首次启动显示。重置请运行 node server/setup.mjs --reset-password`);
  }
  if (!getSetting('seeded')) {
    db.exec('BEGIN');
    try { for (const project of defaults) db.prepare('INSERT OR IGNORE INTO projects(id,json) VALUES (?,?)').run(project.id, JSON.stringify(project)); db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('seeded', '1'); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); };
  const decrypt = value => { if (!value) return null; const buffer = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); cipher.setAuthTag(buffer.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString()); };
  const publicProject = row => { const project = JSON.parse(row.json); const credentials = decrypt(row.credentials); return { authOrigin: '', accessMode: ['aster', 'monitor', 'asset'].includes(project.adapter) ? 'proxy' : 'direct', autoSync: project.adapter === 'asset', ...project, hasCredentials: !!credentials?.password, ...(credentials?.username ? { username: credentials.username } : {}) }; };
  const getProjects = () => db.prepare('SELECT * FROM projects').all().map(publicProject).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const rowFor = id => { const row = db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!row) throw new HttpError(404, '项目不存在'); return row; };
  const states = new Map(); const pending = new Map(); const controllers = new Set(); const loginAttempts = new Map();
  let closed = false;
  let assetSync = null;
  const projectRevision = id => { const row = db.prepare('SELECT json,credentials FROM projects WHERE id=?').get(id); return row ? hash(`${row.json}\0${row.credentials || ''}`) : null; };
  const portal = createPortal({
    getProjects: () => getProjects().filter(project => project.accessMode === 'proxy'),
    getProjectRevision: projectRevision,
    isSessionValid: id => !!db.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(id, Date.now()),
    coordinateAssetSync: async ({ projectId, revision }) => {
      if (closed || projectRevision(projectId) !== revision) return null;
      const status = await assetSync.run(projectId);
      return !closed && projectRevision(projectId) === revision ? status : null;
    },
  });

  function snapshot(project) {
    const saved = db.prepare('SELECT json FROM snapshots WHERE id=?').get(project.id);
    const old = saved ? JSON.parse(saved.json) : null;
    const state = states.get(project.id) || old;
    const base = { project, state: 'unconfigured', message: '等待首次读取数据', checkedAt: null, updatedAt: null, latencyMs: null, metrics: [], ...(project.adapter === 'asset' ? { sync: assetSync?.getStatus(project.id) || null } : {}) };
    if (!project.enabled) return { ...base, state: 'disabled', message: '项目已停用' };
    if (!project.apiUrl && project.adapter !== 'link') return { ...base, message: '请配置接口地址' };
    if (project.adapter === 'link') return { ...base, state: project.url ? 'online' : 'unconfigured', message: project.url ? '链接入口；不采集项目数据' : '请配置项目地址' };
    if (!state) return base;
    const result = { ...base, ...state, project };
    if (result.freshness !== 'static' && ['online', 'partial'].includes(result.state) && (!result.updatedAt || Date.now() - new Date(result.updatedAt).getTime() > project.staleAfterSeconds * 1000)) { result.state = 'stale'; result.message = result.updatedAt ? `数据已过期。${result.message}` : `上游未提供有效的数据更新时间。${result.message}`; }
    return result;
  }

  async function check(id) {
    if (pending.has(id)) return pending.get(id);
    const row = rowFor(id); const project = publicProject(row);
    if (!project.enabled || !project.apiUrl || project.adapter === 'link') return snapshot(project);
    const controller = new AbortController(); controllers.add(controller);
    const run = (async () => {
      const start = Date.now(); const checkedAt = new Date(start).toISOString();
      const saved = db.prepare('SELECT json FROM snapshots WHERE id=?').get(id);
      const previous = saved ? JSON.parse(saved.json) : null;
      try {
        const data = await summaryReader(project, decrypt(row.credentials), { deadline: start + timeoutMs, signal: controller.signal });
        if (closed) return null;
        const latest = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!latest) return null;
        if (latest.json !== row.json || latest.credentials !== row.credentials) return snapshot(publicProject(latest));
        const value = { state: data.stale ? 'stale' : data.partial ? 'partial' : 'online', message: data.message, checkedAt, updatedAt: data.updatedAt || null, latencyMs: Date.now() - start, metrics: data.metrics, ...(data.freshness === 'static' ? { freshness: 'static' } : {}), ...(data.trend ? { trend: data.trend } : {}) };
        db.prepare('INSERT INTO snapshots(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(value)); states.set(id, value);
      } catch (error) {
        if (closed) return null;
        const latest = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!latest) return null;
        if (latest.json !== row.json || latest.credentials !== row.credentials) return snapshot(publicProject(latest));
        const unauthorized = error instanceof UpstreamError && error.code === 'unauthorized';
        states.set(id, { ...(previous || {}), state: unauthorized ? 'unauthorized' : previous ? 'stale' : 'offline', message: `${error instanceof UpstreamError ? error.message : '无法读取项目摘要'}${previous ? '；保留上次成功数据' : ''}`, checkedAt, latencyMs: Date.now() - start, updatedAt: previous?.updatedAt || null, metrics: previous?.metrics || [] });
      }
      return snapshot(publicProject(rowFor(id)));
    })().finally(() => { pending.delete(id); controllers.delete(controller); });
    pending.set(id, run); return run;
  }

  function validateProject(body, existing) {
    const allowed = ['id', 'name', 'description', 'category', 'adapter', 'url', 'apiUrl', 'authOrigin', 'accessMode', 'autoSync', 'mode', 'enabled', 'staleAfterSeconds', 'order', 'password', 'username', 'clearCredentials'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, '项目包含不支持的字段');
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id) || (existing && body.id !== existing.id))) throw new HttpError(400, '项目标识必须为1至64位字母、数字、下划线或短横线，创建后不能修改');
    const value = { name: '', description: '', category: 'other', adapter: 'link', url: '', apiUrl: '', authOrigin: '', mode: 'external', enabled: true, staleAfterSeconds: 120, order: 0, ...existing };
    for (const field of allowed.filter(field => !['password', 'username', 'clearCredentials'].includes(field))) if (body[field] !== undefined) value[field] = body[field];
    value.accessMode ??= ['aster', 'monitor', 'asset'].includes(value.adapter) ? 'proxy' : 'direct';
    value.autoSync ??= value.adapter === 'asset';
    if (!['proxy', 'direct'].includes(value.accessMode) || typeof value.autoSync !== 'boolean') throw new HttpError(400, '页面连接或后台同步设置不正确');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || typeof value.description !== 'string' || value.description.length > 500) throw new HttpError(400, '项目名称或说明长度不正确');
    value.name = value.name.trim();
    if (!['trading', 'monitoring', 'assets', 'other'].includes(value.category) || !['aster', 'monitor', 'asset', 'standard', 'link'].includes(value.adapter) || !['external', 'embed'].includes(value.mode) || typeof value.enabled !== 'boolean' || !Number.isInteger(value.staleAfterSeconds) || value.staleAfterSeconds < 30 || value.staleAfterSeconds > 86400 || !Number.isInteger(value.order) || Math.abs(value.order) > 10000) throw new HttpError(400, '项目配置值不正确');
    if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 1024)) throw new HttpError(400, '密码格式不正确');
    if (body.username !== undefined && (typeof body.username !== 'string' || body.username.length > 200 || body.username.includes(':'))) throw new HttpError(400, '用户名格式不正确');
    if (body.clearCredentials !== undefined && typeof body.clearCredentials !== 'boolean') throw new HttpError(400, '清除凭据选项不正确');
    try { value.url = validateUrl(value.url); value.apiUrl = validateUrl(value.apiUrl, { api: true }); value.authOrigin = validateAuthOrigin(value.authOrigin); } catch (error) { throw new HttpError(400, error.message); }
    return value;
  }

  function session(req) {
    const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('hub_session='))?.slice(12);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(cookie), Date.now());
    return row || null;
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    const expected = `${secureCookies || req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请求来源校验失败，请从工作台页面操作');
  }
  const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
  async function bodyOf(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请求需使用 JSON');
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw new HttpError(413, '请求内容过大'); chunks.push(chunk); }
    try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw new HttpError(400, 'JSON 格式不正确'); }
  }
  async function api(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/api/health' && req.method === 'GET') { send(res, 200, { status: 'ok' }); return; }
    const current = session(req);
    if (pathname === '/api/session' && req.method === 'GET') { send(res, 200, current ? { authenticated: true, csrfToken: current.csrf } : { authenticated: false }); return; }
    if (pathname === '/api/login' && req.method === 'POST') {
      sameOrigin(req);
      const ip = req.socket.remoteAddress || 'unknown'; const now = Date.now();
      for (const [address, attempt] of loginAttempts) if (attempt.until < now) loginAttempts.delete(address);
      const attempt = loginAttempts.get(ip) || { count: 0, until: now + loginWindowMs };
      if (attempt.count >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后重试');
      // Reserve before reading the body: partial concurrent requests share one quota.
      attempt.count += 1; loginAttempts.set(ip, attempt);
      const body = await bodyOf(req);
      const passwordVersion = getSetting('password');
      if (typeof body.password !== 'string' || body.password.length > 1024 || !await passwordMatches(body.password, passwordVersion) || getSetting('password') !== passwordVersion) throw new HttpError(401, '登录密码不正确');
      // Release only this successful attempt, retaining concurrent and failed attempts.
      if (loginAttempts.get(ip) === attempt) { attempt.count -= 1; if (attempt.count === 0) loginAttempts.delete(ip); }
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
      if (current) db.prepare('DELETE FROM sessions WHERE id=?').run(current.id);
      const raw = token(); const csrf = token();
      db.prepare('INSERT INTO sessions(id,csrf,expires) VALUES (?,?,?)').run(hash(raw), csrf, now + SESSION_AGE);
      send(res, 200, { authenticated: true, csrfToken: csrf }, { 'Set-Cookie': `hub_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secureCookies ? '; Secure' : ''}` }); return;
    }
    if (!current) throw new HttpError(401, '请先登录工作台');
    if (!['GET', 'HEAD'].includes(req.method)) { sameOrigin(req); if (req.headers['x-csrf-token'] !== current.csrf) throw new HttpError(403, '请求校验失败，请刷新页面后重试'); }
    if (pathname === '/api/logout' && req.method === 'POST') { db.prepare('DELETE FROM sessions WHERE id=?').run(current.id); send(res, 200, { ok: true }, { 'Set-Cookie': `hub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}` }); return; }
    if (pathname === '/api/projects' && req.method === 'GET') { send(res, 200, { projects: getProjects() }); return; }
    if (pathname === '/api/overview' && req.method === 'GET') { send(res, 200, { projects: getProjects().map(snapshot), generatedAt: new Date().toISOString() }); return; }
    if (pathname === '/api/projects' && req.method === 'POST') {
      const body = await bodyOf(req);
      if (getProjects().length >= 30) throw new HttpError(400, '最多接入 30 个项目');
      const value = validateProject(body); value.id = body.id || randomBytes(8).toString('hex');
      if (db.prepare('SELECT id FROM projects WHERE id=?').get(value.id)) throw new HttpError(409, '项目标识已存在');
      const credentials = body.password ? encrypt({ password: body.password, username: body.username || '' }) : null;
      db.prepare('INSERT INTO projects(id,json,credentials) VALUES (?,?,?)').run(value.id, JSON.stringify(value), credentials);
      send(res, 201, { project: publicProject(rowFor(value.id)) }); void check(value.id).catch(() => {}); if (assetSyncIntervalMs > 0) void assetSync.refresh(); return;
    }
    const match = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)(\/(?:check|launch|sync))?$/);
    if (match) {
      const id = match[1]; const row = rowFor(id);
      if (match[2] === '/check' && req.method === 'POST') { send(res, 200, { snapshot: await check(id) }); return; }
      if (match[2] === '/launch' && req.method === 'POST') {
        const project = publicProject(row);
        if (!project.enabled || project.accessMode !== 'proxy' || !project.apiUrl) throw new HttpError(400, '请先启用项目并配置通过工作台访问的服务地址');
        send(res, 200, portal.createLaunch({ projectId: id, sessionId: current.id, req })); return;
      }
      if (match[2] === '/sync' && req.method === 'POST') {
        const project = publicProject(row);
        if (project.adapter !== 'asset' || !project.enabled || !project.autoSync) throw new HttpError(400, '请先启用资产后台同步');
        void assetSync.run(id).catch(() => {}); send(res, 202, { sync: assetSync.getStatus(id) }); return;
      }
      if (!match[2] && req.method === 'PUT') {
        const body = await bodyOf(req); const prior = JSON.parse(row.json); const value = validateProject(body, prior);
        const boundaryChanged = prior.apiUrl !== value.apiUrl || prior.adapter !== value.adapter || (prior.authOrigin || '') !== value.authOrigin;
        const previous = boundaryChanged || body.clearCredentials ? null : decrypt(row.credentials);
        const credentials = body.password ? encrypt({ password: body.password, username: body.username ?? previous?.username ?? '' }) : previous ? encrypt({ ...previous, username: body.username ?? previous.username }) : null;
        const inFlight = pending.get(id);
        db.prepare('UPDATE projects SET json=?,credentials=? WHERE id=?').run(JSON.stringify(value), credentials, id);
        if (boundaryChanged || (value.adapter === 'monitor' && prior.url !== value.url) || body.password || body.clearCredentials || (body.username !== undefined && body.username !== decrypt(row.credentials)?.username)) db.prepare('DELETE FROM snapshots WHERE id=?').run(id);
        states.delete(id); if (assetSyncIntervalMs > 0) void assetSync.refresh(); send(res, 200, { project: publicProject(rowFor(id)) });
        if (inFlight) void inFlight.finally(() => { if (!closed && db.prepare('SELECT id FROM projects WHERE id=?').get(id)) void check(id).catch(() => {}); }).catch(() => {});
        else void check(id).catch(() => {}); return;
      }
      if (!match[2] && req.method === 'DELETE') { db.prepare('DELETE FROM projects WHERE id=?').run(id); states.delete(id); if (assetSyncIntervalMs > 0) void assetSync.refresh(); send(res, 200, { ok: true }); return; }
    }
    throw new HttpError(404, '接口不存在');
  }

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    try { if ((!configuredOrigin || req.headers.host !== new URL(configuredOrigin).host) && await portal.handle(req, res)) return; }
    catch { if (!res.headersSent) send(res, 502, { error: '项目页面暂时不可用，请从工作台重新打开' }); else res.destroy(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, '请求地址格式不正确');
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const localHost = ['127.0.0.1', 'localhost', '[::1]', 'hub.localhost'].includes(url.hostname);
      if (!localHost && (!configuredOrigin || url.host !== new URL(configuredOrigin).host)) throw new HttpError(421, '请使用工作台配置的访问地址');
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '请求方法不支持');
      if (localHost && url.hostname !== 'hub.localhost') {
        res.writeHead(302, { Location: `${portal.canonicalOrigin(req)}${url.pathname}${url.search}`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '地址格式不正确'); }
      let filename = path.resolve(distDir, `.${decoded}`);
      if (!filename.startsWith(`${path.resolve(distDir)}${path.sep}`)) filename = path.join(distDir, 'index.html');
      if (!existsSync(filename) || !statSync(filename).isFile()) { if (path.extname(decoded)) throw new HttpError(404, '文件不存在'); filename = path.join(distDir, 'index.html'); }
      if (!existsSync(filename)) { send(res, 503, { error: '前端尚未构建，请先执行 npm run build' }); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(filename));
    } catch (error) { if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '服务暂时无法处理请求' }); else res.end(); }
  });
  server.on('upgrade', (req, socket, head) => { void portal.handleUpgrade(req, socket, head).then(handled => { if (!handled) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); }).catch(() => socket.destroy()); });
  server.requestTimeout = 60000; server.headersTimeout = 10000; server.maxHeadersCount = 80;
  assetSync = createAssetSync({
    listTargets: () => db.prepare('SELECT * FROM projects').all().map(row => ({ project: publicProject(row), credentials: decrypt(row.credentials), revision: projectRevision(row.id) })),
    intervalMs: assetSyncIntervalMs > 0 ? assetSyncIntervalMs : 60000,
    autoStart: assetSyncIntervalMs > 0, syncReader: assetSyncReader,
    onComplete: async (id, revision, status) => { if (!closed && projectRevision(id) === revision && ['success', 'partial'].includes(status.state)) await check(id); },
  });
  async function refresh() { await Promise.allSettled(getProjects().filter(project => project.enabled && project.apiUrl && project.adapter !== 'link').map(project => check(project.id))); }
  const interval = refreshInterval > 0 ? setInterval(() => { if (!closed) void refresh(); }, refreshInterval) : null;
  interval?.unref();
  const first = refreshInterval > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();
  return {
    server, check, refresh, assetSync, dataDir: resolvedData,
    async resetPassword() { const password = randomBytes(18).toString('base64url'); db.prepare('UPDATE settings SET value=? WHERE key=?').run(await passwordRecord(password), 'password'); db.exec('DELETE FROM sessions'); return password; },
    async close() { closed = true; clearInterval(interval); clearTimeout(first); await assetSync.close(); portal.close(); for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending.values()]); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close(); },
  };
}

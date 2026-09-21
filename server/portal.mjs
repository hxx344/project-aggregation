import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { validateUrl, validateAuthOrigin, blockedAddress } from './adapters.mjs';

export const HUB_HOST = 'hub.localhost';
export const PORTAL_COOKIE = 'hub_portal';
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const reservedCookie = name => /^(?:__Host-|__Secure-)?hub_(?:session|portal)$/i.test(name);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

class PortalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkedPath(raw) {
  if (typeof raw !== 'string' || raw.length > 16384 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x20\x7f]/.test(raw)) throw new PortalError(400, '项目路径格式不正确');
  let pathname = raw.split('?')[0];
  for (let round = 0; round < 6; round++) {
    if (/[\\\x00-\x1f\x7f]/.test(pathname) || /%2f|%5c/i.test(pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname) || pathname.startsWith('//')) throw new PortalError(400, '不允许的项目路径');
    let next;
    try { next = decodeURIComponent(pathname); } catch { throw new PortalError(400, '项目路径编码不正确'); }
    if (next === pathname) return raw;
    pathname = next;
  }
  throw new PortalError(400, '项目路径编码层数过多');
}

function cleanCookies(value, auth) {
  return (value || '').split(';').map(part => part.trim()).filter(part => part.includes('=') && !reservedCookie(part.slice(0, part.indexOf('='))) && part.slice(0, part.indexOf('=')).toLowerCase() !== auth?.cookie?.name.toLowerCase()).join('; ');
}

function setCookies(values, secure, auth) {
  return (values || []).flatMap(value => {
    const parts = value.split(';').map(part => part.trim());
    const name = parts[0].slice(0, parts[0].indexOf('='));
    if (!name || reservedCookie(name) || name.toLowerCase() === auth?.cookie?.name.toLowerCase()) return [];
    return [parts.filter((part, index) => index === 0 || (!/^domain\s*=/i.test(part) && (secure || !/^(secure|partitioned)$/i.test(part)))).map(part => !secure && /^samesite\s*=\s*none$/i.test(part) ? 'SameSite=Lax' : part).join('; ')];
  });
}

function cleanHeaders(headers) {
  const blocked = new Set([...hopHeaders, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function framePolicy(value, hubOrigin) {
  const policies = Array.isArray(value) ? value : value ? [value] : [''];
  return policies.map(policy => [...String(policy).split(';').map(part => part.trim()).filter(part => part && !/^frame-ancestors(?:\s|$)/i.test(part)), `frame-ancestors ${hubOrigin}`].join('; '));
}

/**
 * State callbacks are synchronous and must return current database state.
 * getProjects(): Project[] (only projects permitted to use the portal).
 * getProjectRevision(id): opaque revision string covering configuration and credentials.
 * isSessionValid(id): whether the hashed hub session id remains valid.
 * authenticateProject({projectId, revision, deadline, signal}): optional fresh server-side login per grant.
 * coordinateAssetSync({projectId, revision}): optional shared background Promise<{state, message}>.
 * Client cancellation never cancels that shared background promise.
 * createLaunch is called only by the authenticated, CSRF-protected hub API.
 */
export function createPortal({ getProjects, getProjectRevision, isSessionValid, coordinateAssetSync, authenticateProject, authenticationTimeoutMs = 10000, now = Date.now, ticketTtlMs = 30000, grantTtlMs = 12 * 3600000, connectTimeoutMs = 10000, responseHeaderTimeoutMs = 90000, maxRequestBytes = 16 * 1024 * 1024, dnsLookup = lookup } = {}) {
  if (![getProjects, getProjectRevision, isSessionValid].every(value => typeof value === 'function')) throw new Error('项目代理需要项目、版本和会话校验回调');
  const tickets = new Map(); const grants = new Map(); const active = new Set(); const syncFlights = new Map();
  let closed = false;
  const projectHost = id => `p-${digest(String(id)).slice(0, 24)}.${HUB_HOST}`;

  function requestContext(req) {
    const raw = req.headers.host;
    if (typeof raw !== 'string' || !/^(?:[a-z0-9.-]+)(?::[0-9]{1,5})?$/i.test(raw)) throw new PortalError(421, '不支持的工作台主机名');
    const parsed = new URL(`http://${raw}`);
    const localPort = req.socket.localPort;
    const secure = !!req.socket.encrypted;
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    if (!localPort || port !== localPort) throw new PortalError(421, '工作台访问端口不匹配');
    const suffix = port === (secure ? 443 : 80) ? '' : `:${port}`;
    return { hostname: parsed.hostname, origin: `${secure ? 'https' : 'http'}://${parsed.hostname}${suffix}`, hubOrigin: `${secure ? 'https' : 'http'}://${HUB_HOST}${suffix}`, suffix, secure };
  }

  function canonicalOrigin(req) { return requestContext(req).hubOrigin; }

  function projectFor(id) { return getProjects().find(project => project.id === id && project.enabled && project.apiUrl); }

  function liveGrant(grant) {
    if (closed || !grant || grant.revoked || grant.expires <= now() || !isSessionValid(grant.sessionId)) return false;
    const project = projectFor(grant.projectId);
    return !!project && getProjectRevision(project.id) === grant.revision;
  }

  function prune() {
    for (const [id, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(id);
    for (const [id, grant] of grants) if (!liveGrant(grant)) grants.delete(id);
    for (const stream of active) if (!liveGrant(stream.grant)) { stream.destroy(); active.delete(stream); }
  }

  const sweep = setInterval(prune, 1000); sweep.unref();

  function createLaunch({ projectId, sessionId, req }) {
    if (closed) throw new PortalError(503, '项目代理已关闭');
    const context = requestContext(req);
    if (![HUB_HOST, 'localhost', '127.0.0.1'].includes(context.hostname)) throw new PortalError(403, '请从工作台发起项目访问');
    const project = projectFor(projectId);
    if (!project || !isSessionValid(sessionId)) throw new PortalError(403, '项目或工作台会话不可用');
    const base = new URL(validateUrl(project.apiUrl, { api: true }));
    if (!base.hostname) throw new PortalError(400, '请配置项目服务地址');
    const revision = getProjectRevision(project.id);
    if (typeof revision !== 'string' || !revision) throw new PortalError(403, '项目配置不可用');
    let destination = '/';
    if (project.url) { const page = new URL(validateUrl(project.url)); destination = checkedPath(page.pathname + page.search) + page.hash; }
    prune();
    if (tickets.size >= 300 || grants.size >= 300) throw new PortalError(429, '项目访问会话过多，请关闭不用的会话后重试');
    const raw = token(); const expires = now() + ticketTtlMs;
    tickets.set(digest(raw), { projectId, sessionId, revision, destination, expires });
    const projectOrigin = `${context.secure ? 'https' : 'http'}://${projectHost(projectId)}${context.suffix}`;
    return { url: `${projectOrigin}/__hub/authorize?ticket=${raw}`, expiresAt: new Date(expires).toISOString(), projectOrigin };
  }

  function browserBoundary(req, context, { authorize = false, websocket = false } = {}) {
    const origin = req.headers.origin;
    if (origin && origin !== context.origin && !(authorize && origin === context.hubOrigin)) throw new PortalError(403, '请在该项目页面中操作');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || websocket;
    if (unsafe && origin !== context.origin) throw new PortalError(403, '项目请求来源校验失败');
    const site = req.headers['sec-fetch-site'];
    const navigation = req.headers['sec-fetch-mode'] === 'navigate';
    const destination = req.headers['sec-fetch-dest'];
    if (site === 'cross-site' && !(navigation && destination === 'document' && !unsafe)) throw new PortalError(403, '不允许跨站读取项目');
    if (site === 'same-site' && !navigation && !authorize) throw new PortalError(403, '不允许跨项目读取数据');
    if (site === 'same-site' && navigation && destination === 'iframe' && !authorize && origin) throw new PortalError(403, '不允许跨项目嵌入请求来源');
  }

  function authorized(req, context, project) {
    const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${PORTAL_COOKIE}=`));
    if (matches.length !== 1) throw new PortalError(401, '请从工作台重新打开此项目');
    const raw = matches[0].slice(PORTAL_COOKIE.length + 1);
    const grant = /^[A-Za-z0-9_-]{43}$/.test(raw) ? grants.get(digest(raw)) : null;
    if (!grant || grant.projectId !== project.id || !liveGrant(grant)) throw new PortalError(401, '项目访问授权已失效，请从工作台重新打开');
    return grant;
  }

  function normalizedAuth(auth) {
    if (auth == null) return null;
    const invalid = () => { throw new PortalError(502, '项目自动登录失败，请返回工作台检查登录信息后重新打开'); };
    if (!auth || typeof auth !== 'object' || (!!auth.cookie === !!auth.authorization)) return invalid();
    if (auth.cookie) {
      const { name, value, maxAge = 43200 } = auth.cookie;
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) || reservedCookie(name) || typeof value !== 'string' || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/.test(value) || !Number.isFinite(maxAge) || maxAge <= 0) return invalid();
      return { cookie: { name, value, maxAge: Math.min(43200, Math.floor(maxAge)) } };
    }
    if (typeof auth.authorization !== 'string' || auth.authorization.length > 8192 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(auth.authorization)) return invalid();
    return { authorization: auth.authorization };
  }

  async function authenticateGrant(req, res, ticket) {
    if (!authenticateProject) return null;
    const controller = new AbortController();
    const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); };
    const disconnected = () => abort(new PortalError(401, '项目入口已关闭，请从工作台重新打开'));
    const stream = { grant: ticket, destroy: () => { abort(new PortalError(401, '项目入口已失效，请从工作台重新打开')); res.destroy(); } };
    const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    active.add(stream); res.once('close', disconnected); req.once('aborted', disconnected);
    const limit = Math.max(1, Math.min(10000, authenticationTimeoutMs));
    const timer = setTimeout(() => abort(new PortalError(504, '项目自动登录超时，请返回工作台检查登录信息后重新打开')), limit);
    const check = () => { if (!liveGrant(ticket) || req.aborted || req.socket.destroyed || res.destroyed || controller.signal.aborted) throw new PortalError(401, '项目入口已失效，请从工作台重新打开'); };
    try {
      check();
      const auth = await Promise.race([Promise.resolve().then(() => { check(); return authenticateProject({ projectId: ticket.projectId, revision: ticket.revision, deadline: Date.now() + limit, signal: controller.signal }); }), aborted]);
      check(); return normalizedAuth(auth);
    } catch (error) {
      abort(error instanceof PortalError ? error : new PortalError(502, '项目自动登录失败'));
      if (error instanceof PortalError) throw error;
      const status = error?.code === 'unauthorized' ? 401 : error?.code === 'timeout' ? 504 : 502;
      throw new PortalError(status, status === 504 ? '项目自动登录超时，请返回工作台检查登录信息后重新打开' : '项目自动登录失败，请返回工作台检查登录信息后重新打开');
    } finally { clearTimeout(timer); res.removeListener('close', disconnected); req.removeListener('aborted', disconnected); active.delete(stream); }
  }

  function revokeGrant(grant) {
    grant.revoked = true;
    for (const [key, value] of grants) if (value === grant) grants.delete(key);
    delete grant.auth;
  }

  function clearPortalCookie(context) {
    return `${PORTAL_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${context.secure ? '; Secure' : ''}`;
  }

  function automaticAuthFailed(incoming, grant, project, target, requestPath) {
    if (!grant.auth) return false;
    if (incoming.statusCode === 401) return true;
    if (project.adapter !== 'asset' || incoming.statusCode < 300 || incoming.statusCode >= 400 || !incoming.headers.location) return false;
    try {
      const redirect = new URL(incoming.headers.location, new URL(target.base.pathname.replace(/\/$/, '') + requestPath, target.base.origin));
      const prefix = target.base.pathname.replace(/\/$/, '');
      return [target.base.origin, target.authOrigin].includes(redirect.origin) && [prefix + '/login', prefix + '/login/'].includes(redirect.pathname);
    } catch { return false; }
  }

  function sendAutomaticAuthFailure(res, context, grant) {
    revokeGrant(grant);
    if (res.destroyed || res.headersSent) return;
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': clearPortalCookie(context), 'Content-Security-Policy': `default-src 'none'; frame-ancestors ${context.hubOrigin}` });
    const message = '项目登录已失效，请返回工作台检查登录信息后重新打开；刚才的操作没有自动重试';
    res.end(JSON.stringify({ error: message, detail: message }));
  }
  async function targetFor(project) {
    const base = new URL(validateUrl(project.apiUrl, { api: true }));
    const hostname = base.hostname.replace(/^\[|\]$/g, '');
    let timer;
    try {
      const addresses = await Promise.race([dnsLookup(hostname, { all: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new PortalError(504, '项目地址解析超时')), connectTimeoutMs); })]);
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => blockedAddress(item.address))) throw new PortalError(502, '项目地址解析到不允许访问的地址');
      return { base, address: addresses[0], authOrigin: project.authOrigin ? validateAuthOrigin(project.authOrigin) : base.origin };
    } finally { clearTimeout(timer); }
  }

  function requestHeaders(req, context, target, websocket, grant) {
    const headers = cleanHeaders(req.headers);
    for (const name of Object.keys(headers)) if (/^(?:forwarded|x-forwarded-.*|x-real-ip|proxy-.*)$/i.test(name)) delete headers[name];
    headers.host = target.base.host;
    let cookies = cleanCookies(req.headers.cookie, grant?.auth);
    if (grant?.auth) { delete headers.authorization; if (grant.auth.authorization) headers.authorization = grant.auth.authorization; }
    if (grant?.auth?.cookie) cookies = [cookies, grant.auth.cookie.name + '=' + grant.auth.cookie.value].filter(Boolean).join('; ');
    if (cookies) headers.cookie = cookies; else delete headers.cookie;
    headers.origin = target.authOrigin;
    if (headers.referer) { try { const reference = new URL(headers.referer); if (reference.origin === context.origin) headers.referer = target.authOrigin + reference.pathname + reference.search; else delete headers.referer; } catch { delete headers.referer; } }
    if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  function responseHeaders(source, context, target, requestPath = '/', grant) {
    const headers = cleanHeaders(source);
    for (const name of Object.keys(headers)) if (/^access-control-/i.test(name) || /^(?:x-frame-options|clear-site-data|refresh|alt-svc|service-worker-allowed)$/i.test(name)) delete headers[name];
    headers['set-cookie'] = setCookies(source['set-cookie'], context.secure, grant?.auth);
    if (!headers['set-cookie'].length) delete headers['set-cookie'];
    if (grant?.auth) delete headers['www-authenticate'];
    headers['content-security-policy'] = framePolicy(source['content-security-policy'], context.hubOrigin);
    if (source['content-security-policy-report-only']) headers['content-security-policy-report-only'] = framePolicy(source['content-security-policy-report-only'], context.hubOrigin);
    headers['referrer-policy'] = 'no-referrer';
    // Avoid a shared browser cache serving private data after a grant is revoked.
    headers['cache-control'] = 'no-store';
    if (source.location) {
      let location;
      try { location = new URL(source.location, new URL(target.base.pathname.replace(/\/$/, '') + requestPath, target.base.origin)); } catch { throw new PortalError(502, '项目返回了无效跳转地址'); }
      if (![target.base.origin, target.authOrigin].includes(location.origin)) throw new PortalError(502, '项目尝试跳转到其他服务，请在项目设置中检查地址');
      let pathname = location.pathname;
      const prefix = target.base.pathname.replace(/\/$/, '');
      if (prefix && (pathname === prefix || pathname.startsWith(prefix + '/'))) pathname = pathname.slice(prefix.length) || '/';
      headers.location = context.origin + checkedPath(pathname + location.search) + location.hash;
    }
    return headers;
  }

  function sendError(res, error) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    const status = error instanceof PortalError ? error.status : 502;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors http://hub.localhost:* https://hub.localhost:*" });
    res.end(error instanceof PortalError ? error.message : '无法连接项目服务，请检查项目地址与运行状态');
  }

  function consumeBody(req) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const cleanup = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error); req.removeListener('aborted', aborted); };
      const error = value => { cleanup(); reject(value); };
      const aborted = () => error(new PortalError(499, '项目请求已关闭'));
      const end = () => { cleanup(); resolve(); };
      const data = chunk => { bytes += chunk.length; if (bytes > maxRequestBytes) { cleanup(); req.resume(); reject(new PortalError(413, '项目请求超过 16 MiB 限制')); } };
      req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
      if (req.readableEnded) end();
    });
  }

  async function coordinatedSync(req, res, context, project, grant, target) {
    const transports = new Set();
    let rejectStopped; let canceled = false;
    const stopped = new Promise((_, reject) => { rejectStopped = reject; });
    stopped.catch(() => {});
    const check = () => {
      if (closed || !liveGrant(grant) || req.aborted || req.socket.destroyed || res.destroyed || canceled) throw new PortalError(401, '项目访问授权已失效');
    };
    const cancel = () => { canceled = true; for (const transport of transports) transport.destroy(); rejectStopped(new PortalError(499, '项目请求已关闭')); };
    const stream = { grant, destroy: () => { cancel(); res.destroy(); } }; active.add(stream);
    res.once('close', cancel);
    const timer = setTimeout(() => { for (const transport of transports) transport.destroy(); rejectStopped(new PortalError(504, '资产同步等待超时，请稍后查看原项目状态')); }, responseHeaderTimeoutMs);
    const wait = promise => Promise.race([promise, stopped]);

    function ledger(discardSuccess) {
      check();
      const headers = requestHeaders(req, context, target, false, grant);
      for (const key of ['content-length', 'content-type', 'content-encoding', 'expect', 'if-modified-since', 'if-none-match', 'range']) delete headers[key];
      const route = '/api/ledger';
      return new Promise((resolve, reject) => {
        const upstream = (target.base.protocol === 'https:' ? https : http).request(target.base, { method: 'GET', path: target.base.pathname.replace(/\/$/, '') + route, headers, lookup: (_host, options, callback) => options.all ? callback(null, [target.address]) : callback(null, target.address.address, target.address.family) });
        transports.add(upstream);
        const connectionTimer = setTimeout(() => upstream.destroy(new PortalError(504, '项目服务连接超时')), connectTimeoutMs);
        upstream.once('socket', socket => { if (!socket.connecting) clearTimeout(connectionTimer); else socket.once(target.base.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectionTimer)); });
        upstream.once('close', () => { clearTimeout(connectionTimer); transports.delete(upstream); });
        upstream.on('error', reject);
        upstream.once('response', incoming => {
          try {
            check();
            if (automaticAuthFailed(incoming, grant, project, target, route)) { incoming.destroy(); sendAutomaticAuthFailure(res, context, grant); resolve(false); return; }
            const discard = discardSuccess && incoming.statusCode === 200;
            if (discard) incoming.resume();
            else { res.writeHead(incoming.statusCode, responseHeaders(incoming.headers, context, target, route, grant)); incoming.pipe(res); }
            incoming.once('error', reject);
            incoming.once('end', () => resolve(discard));
          } catch (error) { incoming.destroy(); reject(error); }
        });
        upstream.end();
      });
    }

    try {
      await wait(consumeBody(req)); check();
      // Verify the grant's application session before joining the shared worker.
      if (!await wait(ledger(true))) return;
      check();
      const key = project.id + ':' + grant.revision;
      let flight = syncFlights.get(key);
      if (!flight) {
        if (syncFlights.size >= 60) throw new PortalError(429, '资产同步等待过多，请稍后重试');
        flight = Promise.resolve().then(() => { check(); return coordinateAssetSync({ projectId: project.id, revision: grant.revision }); }).finally(() => { if (syncFlights.get(key) === flight) syncFlights.delete(key); });
        syncFlights.set(key, flight);
      }
      const result = await wait(flight); check();
      if (!result || !['success', 'partial'].includes(result.state)) {
        const message = typeof result?.message === 'string' ? result.message.slice(0, 240) : '资产同步尚未完成，请稍后重试';
        const status = result?.state === 'unauthorized' ? 401 : result?.state === 'timeout' ? 504 : 502;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; frame-ancestors ${context.hubOrigin}` });
        res.end(JSON.stringify({ error: message })); return;
      }
      await wait(ledger(false));
    } catch (error) {
      if (res.destroyed || canceled) return;
      if (!res.headersSent) {
        const status = error instanceof PortalError ? error.status : 502;
        res.writeHead(status === 499 ? 401 : status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; frame-ancestors ${context.hubOrigin}` });
        res.end(JSON.stringify({ error: error instanceof PortalError ? error.message : '资产同步未完成，请稍后查看原项目状态' }));
      } else res.destroy();
    } finally {
      clearTimeout(timer); res.removeListener('close', cancel); active.delete(stream);
      for (const transport of transports) transport.destroy();
    }
  }
  async function proxy(req, res, context, project, grant) {
    const target = await targetFor(project);
    if (!liveGrant(grant) || req.aborted || req.socket.destroyed || res.destroyed) throw new PortalError(401, '项目访问授权已失效');
    if (coordinateAssetSync && project.adapter === 'asset' && project.autoSync !== false && project.hasCredentials && req.method === 'POST' && new URL(req.url, context.origin).pathname === '/api/sync') { await coordinatedSync(req, res, context, project, grant, target); return; }
    const prefix = target.base.pathname.replace(/\/$/, '');
    const path = prefix + checkedPath(req.url);
    const upstream = (target.base.protocol === 'https:' ? https : http).request(target.base, { method: req.method, path, headers: requestHeaders(req, context, target, false, grant), lookup: (_host, options, callback) => options.all ? callback(null, [target.address]) : callback(null, target.address.address, target.address.family) });
    const timer = setTimeout(() => upstream.destroy(new PortalError(504, '项目服务响应超时')), responseHeaderTimeoutMs);
    const connectionTimer = setTimeout(() => upstream.destroy(new PortalError(504, '项目服务连接超时')), connectTimeoutMs);
    upstream.once('socket', socket => { if (!socket.connecting) clearTimeout(connectionTimer); else socket.once(target.base.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectionTimer)); });
    const stream = { grant, destroy: () => { upstream.destroy(); res.destroy(); } }; active.add(stream);
    upstream.once('response', incoming => {
      clearTimeout(timer);
      try {
        if (!liveGrant(grant)) throw new PortalError(401, '项目访问授权已失效');
        if (automaticAuthFailed(incoming, grant, project, target, req.url)) { incoming.destroy(); sendAutomaticAuthFailure(res, context, grant); return; }
        const headers = responseHeaders(incoming.headers, context, target, req.url, grant);
        if (req.method === 'POST' && new URL(req.url, context.origin).pathname === '/api/logout' && incoming.statusCode >= 200 && incoming.statusCode < 300) {
          revokeGrant(grant); headers['set-cookie'] = [...(headers['set-cookie'] || []), clearPortalCookie(context)];
        }
        res.writeHead(incoming.statusCode, headers); incoming.pipe(res);
      }
      catch (error) { incoming.destroy(); sendError(res, error); }
      incoming.on('error', error => sendError(res, error));
    });
    upstream.on('error', error => sendError(res, error));
    req.on('aborted', () => upstream.destroy());
    res.once('close', () => { clearTimeout(timer); clearTimeout(connectionTimer); active.delete(stream); upstream.destroy(); });
    let receivedBytes = 0;
    req.on('data', chunk => { receivedBytes += chunk.length; if (receivedBytes > maxRequestBytes) { req.unpipe(upstream); upstream.destroy(); sendError(res, new PortalError(413, '项目请求超过 16 MiB 限制')); } });
    req.pipe(upstream);
  }

  async function handle(req, res) {
    let context;
    try {
      if (closed) throw new PortalError(503, '项目代理已关闭');
      context = requestContext(req);
      if ([HUB_HOST, 'localhost', '127.0.0.1'].includes(context.hostname)) return false;
      const project = getProjects().find(item => projectHost(item.id) === context.hostname);
      if (!project) throw new PortalError(421, '未知的项目入口');
      checkedPath(req.url);
      const url = new URL(req.url, context.origin);
      if (url.pathname === '/__hub/authorize') {
        if (req.method !== 'GET') throw new PortalError(405, '授权入口仅支持页面访问');
        browserBoundary(req, context, { authorize: true });
        const raw = url.searchParams.get('ticket');
        const ticket = raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? tickets.get(digest(raw)) : null;
        if (!ticket || ticket.projectId !== project.id || !liveGrant(ticket)) throw new PortalError(401, '项目入口已过期，请从工作台重新打开');
        tickets.delete(digest(raw));
        const auth = await authenticateGrant(req, res, ticket);
        if (!liveGrant(ticket) || req.aborted || req.socket.destroyed || res.destroyed) throw new PortalError(401, '项目入口已失效，请从工作台重新打开');
        if (grants.size >= 300) throw new PortalError(429, '项目访问会话过多，请稍后重试');
        const grantToken = token(); const grant = { ...ticket, ...(auth ? { auth } : {}), expires: Math.min(now() + grantTtlMs, now() + 12 * 3600000, auth?.cookie ? now() + auth.cookie.maxAge * 1000 : Infinity) };
        grants.set(digest(grantToken), grant);
        res.writeHead(302, { Location: ticket.destination, 'Set-Cookie': `${PORTAL_COOKIE}=${grantToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((grant.expires - now()) / 1000))}${context.secure ? '; Secure' : ''}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; frame-ancestors ${context.hubOrigin}` }); res.end(); return true;
      }
      if (url.pathname.startsWith('/__hub/')) throw new PortalError(404, '项目代理接口不存在');
      browserBoundary(req, context);
      const grant = authorized(req, context, project);
      await proxy(req, res, context, project, grant);
    } catch (error) { sendError(res, error); }
    return true;
  }

  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    try {
      const context = requestContext(req);
      if ([HUB_HOST, 'localhost', '127.0.0.1'].includes(context.hostname)) return false;
      const project = getProjects().find(item => projectHost(item.id) === context.hostname);
      if (!project) throw new PortalError(421, '未知项目入口');
      if (req.method !== 'GET' || String(req.headers.upgrade).toLowerCase() !== 'websocket') throw new PortalError(400, '不支持的连接升级');
      checkedPath(req.url); browserBoundary(req, context, { websocket: true });
      const grant = authorized(req, context, project);
      const target = await targetFor(project);
      if (!liveGrant(grant) || req.aborted || socket.destroyed) throw new PortalError(401, '项目访问授权已失效');
      const upstream = (target.base.protocol === 'https:' ? https : http).request(target.base, { method: 'GET', path: target.base.pathname.replace(/\/$/, '') + req.url, headers: requestHeaders(req, context, target, true, grant), lookup: (_host, options, callback) => options.all ? callback(null, [target.address]) : callback(null, target.address.address, target.address.family) });
      const timer = setTimeout(() => upstream.destroy(), responseHeaderTimeoutMs);
      const connectionTimer = setTimeout(() => upstream.destroy(), connectTimeoutMs);
      upstream.once('socket', peerSocket => { if (!peerSocket.connecting) clearTimeout(connectionTimer); else peerSocket.once(target.base.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectionTimer)); });
      let peer;
      const stream = { grant, destroy: () => { upstream.destroy(); peer?.destroy(); socket.destroy(); } }; active.add(stream);
      socket.once('close', () => { clearTimeout(timer); clearTimeout(connectionTimer); active.delete(stream); upstream.destroy(); peer?.destroy(); });
      upstream.once('upgrade', (response, targetSocket, targetHead) => {
        clearTimeout(timer); peer = targetSocket;
        if (!liveGrant(grant)) { stream.destroy(); return; }
        try {
          const headers = responseHeaders(response.headers, context, target, req.url, grant); headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
          const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`));
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
          if (targetHead.length) socket.write(targetHead); if (head.length) targetSocket.write(head);
          socket.pipe(targetSocket).pipe(socket); targetSocket.on('error', () => socket.destroy()); socket.on('error', () => targetSocket.destroy());
        } catch { stream.destroy(); }
      });
      upstream.once('response', response => { response.resume(); stream.destroy(); });
      upstream.on('error', () => stream.destroy()); upstream.end();
    } catch (error) { const status = error instanceof PortalError ? error.status : 502; socket.end(`HTTP/1.1 ${status} Proxy Request Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
    return true;
  }

  return { createLaunch, handle, handleUpgrade, canonicalOrigin, projectHost, close() { closed = true; clearInterval(sweep); tickets.clear(); grants.clear(); syncFlights.clear(); for (const stream of active) stream.destroy(); active.clear(); } };
}

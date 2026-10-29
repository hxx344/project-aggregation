import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { validateUrl, validateAuthOrigin } from '../adapters.mjs';
import { createPortal } from '../portal.mjs';
import { loginForPortal } from '../portal-auth.mjs';
import { createOverviewEncoder } from '../overview-stream.mjs';
import { createReleaseAssetLookup, createStaticResponder } from '../static-response.mjs';
import { createUpdateClient, createUpdateCoordinator, validateUpdateBody, UpdateError } from '../updates.mjs';
import { createUpdateStream } from '../update-stream.mjs';
import { moduleIds } from '../modules/catalog.mjs';
import { moduleOrigin } from '../modules/transport.mjs';
import { tradingModules } from '../modules/updates.mjs';
import { RuntimeError, UNAVAILABLE } from '../runtime/protocol.mjs';
import { coordinatorHooks } from '../runtime/supervisor-client.mjs';
import { MAX_PROJECTS } from '../control/schema.mjs';
import { passwordMatches, resetPassword } from '../control/password.mjs';
import { createLoginGuard } from '../control/login-guard.mjs';
import { createPortalStore } from '../control/portal-store.mjs';
import { updateSettings } from '../control/update-state.mjs';
import { clientAddress } from '../slot-protocol.mjs';
import { HttpError, send, readJson, readJsonBody, errorResponder } from '../http-common.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;

// Login rate limits; createApp resolves them before opening any file.
export function resolveLoginLimits({ loginWindowMs = 15 * 60000, accountLockoutMs = 30 * 60000 } = {}) {
  if (!Number.isInteger(accountLockoutMs) || accountLockoutMs < 1000 || accountLockoutMs > 86400000) throw new RangeError('accountLockoutMs 必须为 1000 至 86400000 的整数（毫秒）');
  return { loginWindowMs, accountLockoutMs };
}
// Trading and execution errors are mapped by the data plane, which returns them as replies.
const respond = errorResponder([HttpError, UpdateError, RuntimeError]);
// Native execution is not gated by any one embedded trading module's maintenance sync.
const native = { scope: 'native' };
// Account, preview and start writes are admitted by the update coordinator before they reach the data plane.
const admitted = (pathname, method) => /^\/api\/trading\/execution\/accounts\/(?:binance|bybit|okx)$/.test(pathname) ? ['PUT', 'DELETE'].includes(method)
  : ['/api/trading/execution/preview', '/api/trading/execution/jobs'].includes(pathname) && method === 'POST';

// The control plane's HTTP entry (design doc 3.1): sessions, the update
// coordinator, project configuration, Portal, the overview streams and static
// files. Business routes go to the data plane through `runtime`, module
// supervision through `supervisor`; neither is reached any other way.
// The browser request's budget, which a forwarded call keeps (design doc 5.2).
const REQUEST_TIMEOUT_MS = 60_000, HANDLER_GRACE_MS = 2000, COORDINATOR_CLOSE_MS = 5000;
// Overview streams get a frame at least this often, and project changes are
// retried this many times at these delays (initial design values).
const OVERVIEW_HEARTBEAT_MS = 15_000, RUNTIME_STALE_MS = 30_000, NOTICE_RETRY_MS = [1000, 5000];
// The overview stream counts go to the runtime at least this often (design doc 5.8);
// closing waits this long at most for its last report.
const STATS_INTERVAL_MS = 15_000, CLOSE_REPORT_MS = 500;
// What the API shows while it has not heard from the runtime for RUNTIME_STALE_MS.
const staleOverview = overview => ({ ...overview, projects: overview.projects.map(item => ({ ...item, state: 'stale', message: UNAVAILABLE })) });

// When the API runs in its own process the module transports are registered in
// the runtime's, so the Portal asks the supervisor on every request: a restarted
// module comes back with a new socket and secret. Same checks as moduleTransport().
export function supervisorTransports(supervisor) {
  const suffix = '.workspace.internal';
  return async base => {
    if (!base.hostname.endsWith(suffix)) return null;
    const id = base.hostname.slice(0, -suffix.length);
    if (base.username || base.password || !moduleIds.includes(id) || base.origin !== moduleOrigin(id)) throw new Error('Embedded module is unavailable');
    return supervisor.resolveTransport(id);
  };
}

// candidate: an API slot that is not serving yet (design doc api-dual-slot 3.3):
// no update coordinator, no stream-count reports, Portal neither issues nor takes
// grants, and only the probe's reads are answered until promote().
// privateProbe: the server's own listener is a slot's probe socket and traffic
// comes through attach(); probe connections take only GET and HEAD and no
// upgrades once the slot serves.
export function createApiServer({ control, catalog, encrypt, decrypt, embeddedModules, log, supervisor, runtime, executionJobs, candidate = false, privateProbe = false,
  updatesClient, secureCookies, configuredOrigin, distDir, loginLimits = resolveLoginLimits(), resolveTransport,
  overviewHeartbeatMs = OVERVIEW_HEARTBEAT_MS, runtimeStaleMs = RUNTIME_STALE_MS, noticeRetryMs = NOTICE_RETRY_MS, statsIntervalMs = STATS_INTERVAL_MS, drainMs = REQUEST_TIMEOUT_MS }) {
  const { loginWindowMs, accountLockoutMs } = loginLimits;
  const { getSetting, setSetting, sessions, projects } = control;
  const { publicProject, getProjects, rowFor, projectRevision } = catalog;
  // The coordinator caches the durable values when it is built, so a candidate
  // builds it only when promoted and starts from the values of that moment.
  const coordinator = () => createUpdateCoordinator({ client: updatesClient || createUpdateClient(), execution: executionJobs,
    ...(embeddedModules ? { ...coordinatorHooks(supervisor, { log }), tradingModules, moduleIds } : {}),
    ...updateSettings(control),
  });
  let updates = candidate ? null : coordinator();
  // Supervisor state joined with the trading maintenance gate; no pids, paths or secrets.
  async function moduleStatus() {
    const status = await supervisor.status();
    if (!status.modulesEnabled) return { schemaVersion: 1, enabled: false, modules: [] };
    updates.observeModules(status.modules);
    const gates = updates.moduleMaintenance();
    return { schemaVersion: 1, enabled: true, modules: status.modules.map(row => ({ ...row,
      maintenanceConfirmed: gates[row.moduleId]?.confirmed ?? null, maintenanceReleasedAt: gates[row.moduleId]?.releasedAt ?? null })) };
  }
  // IP rate limiting and the account lockout live in hub.sqlite, shared by every API instance.
  const loginGuard = createLoginGuard(control, { loginWindowMs, accountLockoutMs });
  // draining: the listener is closing and the requests in flight may finish;
  // closed: they have, and the control-plane services are ending.
  let draining = false, closed = false, closing = null;
  const updateStream = createUpdateStream({ readState: () => updates.status(),
    isSessionActive: id => !closed && sessions.isActive(id),
  });
  const streams = new Map();
  // Stream counts for the runtime's baseline: sent at start, after every
  // change and every statsIntervalMs, one report at a time. A failed report is
  // not retried; the next one carries the current counts. The first failure of
  // a run and then every 20th are logged.
  const apiInstanceId = randomUUID();
  let slowConsumers = 0, sequence = 0, reporting = false, reportAgain = false, reportFailures = 0;
  const sendStats = activeConnections => runtime.reportApiStats({ instanceId: apiInstanceId, sequence: ++sequence, activeConnections, slowConsumerDisconnects: slowConsumers });
  function reportStats() {
    if (closed || candidate) return;
    if (reporting) { reportAgain = true; return; }
    reporting = true;
    void sendStats(streams.size).then(() => { reportFailures = 0; }, error => {
      if (reportFailures++ % 20 === 0) log.warn({ err: error, failures: reportFailures, type: 'overview' }, 'SSE 计数上报失败');
    }).finally(() => { reporting = false; if (reportAgain) { reportAgain = false; reportStats(); } });
  }
  // On close the API reports no streams, waiting at most CLOSE_REPORT_MS; a
  // report still in flight carries a lower sequence and cannot replace it.
  const finalReport = () => new Promise(resolve => {
    const timer = setTimeout(resolve, CLOSE_REPORT_MS);
    void sendStats(0).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
  let statsTimer = null;
  function startStats() { statsTimer = setInterval(reportStats, statsIntervalMs); statsTimer.unref?.(); reportStats(); }
  if (!candidate) startStats();
  const serveStatic = createStaticResponder(), releaseAsset = createReleaseAssetLookup(distDir);
  // Ends the streams whose session is gone; the others get the next overview.
  const pruneStreams = () => {
    const size = streams.size;
    for (const [res, current] of streams) if (closed || !sessions.isActive(current.id)) { res.end(); streams.delete(res); }
    if (streams.size !== size) reportStats();
  };
  function publishOverview(data) {
    let message; const size = streams.size;
    for (const [res, current] of streams) {
      if (closed || !sessions.isActive(current.id)) { res.end(); streams.delete(res); continue; }
      if (res.writableLength > 256 * 1024) { slowConsumers += 1; res.destroy(); streams.delete(res); continue; }
      if (current.encode) res.write(`data: ${JSON.stringify(current.encode(data))}\n\n`);
      else { message ??= `data: ${JSON.stringify(data)}\n\n`; res.write(message); }
    }
    if (streams.size !== size) reportStats();
  }
  // The latest projection and when the runtime last answered. Streams get it
  // again when the runtime has pushed nothing for a heartbeat period, so session
  // checks and the write-buffer guard do not depend on the runtime; after
  // runtimeStaleMs without contact every project is shown as stale. A read that
  // a push overtook does not bring back its older projection.
  let latest = null, lastContact = 0, lastPush = 0, pushes = 0;
  async function readOverview() {
    const before = pushes, overview = await runtime.overview();
    if (pushes === before) latest = overview;
    lastContact = Date.now(); return overview;
  }
  const unsubscribe = runtime.subscribeOverview({ wants: () => streams.size > 0,
    deliver: event => { latest = event.overview; pushes += 1; lastContact = lastPush = Date.now(); publishOverview(event.overview); } });
  const heartbeat = setInterval(() => {
    // A stream is registered only after its first projection was read, so `latest` is set here.
    if (!streams.size || Date.now() - lastPush < overviewHeartbeatMs) return;
    publishOverview(Date.now() - lastContact > runtimeStaleMs ? staleOverview(latest) : latest);
  }, overviewHeartbeatMs);
  heartbeat.unref?.();
  // The data plane drops what it derived from a project; the row itself is
  // already written. A failed notice is retried in the background; repeating
  // one is harmless, though a retry that arrives after a newer change to the
  // same id drops that change's cached state until the next collection.
  const retries = new Set();
  function retryNotice(id, change, attempts, error) {
    if (closed || attempts > noticeRetryMs.length) { log.warn({ err: error, projectId: id, reason: change.reason, attempts, type: 'project-change' }, '项目变更未能通知运行时'); return; }
    const timer = setTimeout(() => { retries.delete(timer); runtime.projectChanged(id, change).catch(next => retryNotice(id, change, attempts + 1, next)); }, noticeRetryMs[attempts - 1]);
    timer.unref?.(); retries.add(timer);
  }
  const notify = (id, change) => runtime.projectChanged(id, change).catch(error => retryNotice(id, change, 1, error));
  const portal = createPortal({
    store: createPortalStore(control),
    ...(embeddedModules ? { withMutation: (task, options) => updates.withExecutionEntry(task, options) } : {}),
    isServing: () => !candidate,
    ...(resolveTransport ? { resolveTransport } : {}),
    getProjects: () => getProjects().filter(project => project.accessMode === 'proxy'),
    getProjectRevision: projectRevision,
    isSessionValid: sessions.isActive,
    authenticateProject: async ({ projectId, revision, deadline, signal }) => {
      if (closed || signal.aborted || projectRevision(projectId) !== revision) throw new HttpError(401, '页面授权已失效');
      const row = rowFor(projectId);
      const auth = embeddedModules ? null : await loginForPortal(publicProject(row), decrypt(row.credentials), { deadline, signal });
      if (closed || signal.aborted || projectRevision(projectId) !== revision) throw new HttpError(401, '页面授权已失效');
      return auth;
    },
    coordinateAssetSync: async ({ projectId, revision }) => closed ? null : runtime.coordinateAssetSync(projectId, revision),
  });

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
    return sessions.find(hash(cookie));
  }
  function sameOrigin(req) {
    const origin = req.headers.origin;
    const expected = `${secureCookies || req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请求来源校验失败，请从工作台页面操作');
  }
  const bodyOf = req => readJson(req.headers['content-type'], req);
  // The target is the normalized path and query this API matched, not the raw request line.
  const receivedAt = new WeakMap();
  async function forward(req, res, url, current, { body = req, contentType = req.headers['content-type'] } = {}) {
    const deadline = (receivedAt.get(req) ?? Date.now()) + REQUEST_TIMEOUT_MS;
    const reply = await runtime.forward({ method: req.method, target: url.pathname + url.search, sessionId: current.id, contentType, deadline, body });
    send(res, reply.status, reply.body);
  }
  async function api(req, res, url) {
    const pathname = url.pathname;
    if (pathname === '/api/health' && req.method === 'GET') { send(res, 200, { status: 'ok' }); return; }
    // Ready once a compatible runtime reports ready; a probe learns nothing more.
    if (pathname === '/api/ready' && req.method === 'GET') {
      const ready = !draining && (await supervisor.status().catch(() => null))?.ready === true;
      send(res, ready ? 200 : 503, { ready }); return;
    }
    const current = session(req);
    if (pathname === '/api/session' && req.method === 'GET') { send(res, 200, current ? { authenticated: true, csrfToken: current.csrf } : { authenticated: false }); return; }
    if (candidate) throw new HttpError(503, '候选实例尚未接管服务');
    if (pathname === '/api/login' && req.method === 'POST') {
      sameOrigin(req);
      const ip = clientAddress(req) || 'unknown'; const now = Date.now();
      const accountId = 'global'; // Single-account system
      const lockedError = until => new HttpError(429, `账户已被锁定，请 ${Math.ceil((until - Date.now()) / 60000)} 分钟后重试`);
      // A check that never finished is counted when its lease expires, and may set the lock then.
      const refuseLocked = ({ locked, lockedNow }) => {
        if (lockedNow) log.error({ ip, type: 'account_locked', reason: 'lapsed_check' }, '账户已被锁定');
        return lockedError(locked);
      };
      // Reserve before reading the body: partial concurrent requests share one quota.
      const attempt = loginGuard.admit(accountId, ip, now);
      if (attempt.locked) throw refuseLocked(attempt);
      if (attempt.limited) throw new HttpError(429, '登录尝试过多，请 15 分钟后重试');
      const body = await bodyOf(req);

      // Reserve an account slot after the body arrives, so held-open bodies cannot block logins,
      // and before hashing, so concurrent guesses cannot exceed the remaining failure budget.
      const reserved = loginGuard.reserveAccount(accountId, Date.now());
      if (reserved.locked) throw refuseLocked(reserved);
      if (reserved.exhausted) throw new HttpError(429, '登录尝试过多，请稍后重试');
      let passwordValid;
      try {
        const passwordVersion = getSetting('password');
        passwordValid = typeof body.password === 'string' && body.password.length <= 1024 && await passwordMatches(body.password, passwordVersion) && getSetting('password') === passwordVersion;
      } catch (error) {
        // Unreleased, the check counts as a failure once its lease expires.
        try { loginGuard.release(reserved); } catch (releaseError) { log.warn({ err: releaseError, type: 'auth_release_failed' }, '登录校验名额未能释放'); }
        throw error;
      }

      if (!passwordValid) {
        const { failed, lockedUntil, lockedNow } = loginGuard.failure(reserved, Date.now());
        log.warn({ ip, failedAttempts: failed, type: 'auth_failed' }, '登录失败');
        if (lockedUntil && !lockedNow) throw lockedError(lockedUntil);
        if (lockedNow) {
          log.error({ ip, failedAttempts: failed, type: 'account_locked' }, '账户已被锁定');
          throw new HttpError(429, `连续登录失败过多，账户已被锁定 ${Math.ceil(accountLockoutMs / 60000)} 分钟`);
        }
        throw new HttpError(401, '登录密码不正确');
      }
      // A lock set by concurrent failures while this password was being checked still applies.
      const lockedAfterCheck = loginGuard.success(reserved, attempt, Date.now());
      if (lockedAfterCheck) throw lockedError(lockedAfterCheck);

      log.info({ ip, type: 'auth_success' }, '登录成功');

      sessions.deleteExpired(now);
      // Security: Always delete old session and generate new ID on login to prevent session fixation
      if (current) sessions.delete(current.id);
      // Always generate a fresh session ID and CSRF token after successful authentication
      const raw = token(); const csrf = token();
      sessions.create(hash(raw), csrf, now + SESSION_AGE);
      send(res, 200, { authenticated: true, csrfToken: csrf }, { 'Set-Cookie': `hub_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secureCookies ? '; Secure' : ''}` }); return;
    }
    if (!current) throw new HttpError(401, '请先登录工作台');
    if (!['GET', 'HEAD'].includes(req.method)) { sameOrigin(req); if (req.headers['x-csrf-token'] !== current.csrf) throw new HttpError(403, '请求校验失败，请刷新页面后重试'); }
    if (pathname === '/api/system/architecture' || pathname === '/api/system/metrics' || pathname === '/api/system/accounts' || pathname === '/api/system/recovery' || pathname === '/api/system/modules') {
      if (req.method !== 'GET') throw new HttpError(405, '基线接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '基线接口不接受查询参数');
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台读取基线');
      if (req.headers.origin) sameOrigin(req);
      if (pathname === '/api/system/modules') { send(res, 200, await moduleStatus()); return; }
      await forward(req, res, url, current); return;
    }
    const moduleRestart = /^\/api\/system\/modules\/([^/]+)\/restart$/.exec(pathname);
    if (moduleRestart) {
      if (req.method !== 'POST') throw new HttpError(405, '模块恢复接口仅支持 POST');
      if (url.search) throw new HttpError(400, '模块恢复接口不接受查询参数');
      const id = moduleRestart[1];
      await supervisor.restartModule(id);
      log.info({ moduleId: id, ip: clientAddress(req), type: 'module-restart' }, '管理员已请求恢复内嵌模块');
      send(res, 202, { accepted: true, moduleId: id }); return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      log.info({ ip: clientAddress(req), type: 'auth_logout' }, '用户登出');
      sessions.delete(current.id);
      pruneStreams();
      updateStream.revalidate();
      send(res, 200, { ok: true }, { 'Set-Cookie': `hub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}` });
      return;
    }
    if (pathname === '/api/system/updates' || pathname.startsWith('/api/system/updates/')) {
      if (url.search) throw new HttpError(400, '更新接口不接受查询参数');
      if (pathname === '/api/system/updates' && req.method === 'GET') { send(res, 200, await updates.status()); return; }
      if (pathname === '/api/system/updates/events' && req.method === 'GET') {
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台订阅状态');
        if (req.headers.origin) sameOrigin(req);
        updateStream.subscribe(res, current.id); return;
      }
      const action = pathname === '/api/system/updates/check' ? 'check' : pathname === '/api/system/updates/apply' ? 'apply' : pathname === '/api/system/updates/token' ? 'token' : null;
      if (action && req.method === 'POST') {
        const body = await bodyOf(req); validateUpdateBody(action, body);
        const authorize = () => {
          const latest = session(req);
          if (!latest || latest.id !== current.id) throw new HttpError(401, '登录已失效，请重新登录');
          sameOrigin(req);
          if (req.headers['x-csrf-token'] !== latest.csrf) throw new HttpError(403, '请求校验失败，请刷新页面后重试');
        };
        authorize();
        try {
          const state = action === 'check' ? await updates.check() : action === 'token' ? await updates.token(body.token, authorize) : await updates.apply(body.planId, authorize, body.deployMode, body.phase);
          send(res, action === 'token' ? 200 : 202, state);
        }
        finally { void updateStream.refresh(); }
        return;
      }
      throw new HttpError(404, '更新接口不存在');
    }
    if (pathname === '/api/research/entropy-lighter' || pathname.startsWith('/api/research/entropy-lighter/')) {
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台读取研究数据');
      if (req.headers.origin) sameOrigin(req);
      await forward(req, res, url, current); return;
    }
    if (pathname === '/api/trading' || pathname.startsWith('/api/trading/')) {
      if (!admitted(pathname, req.method)) { await forward(req, res, url, current); return; }
      // The body is read first, so its errors still come before an admission refusal; its bytes are forwarded unchanged.
      const { raw } = await readJsonBody(req.headers['content-type'], req);
      await updates.withExecutionEntry(() => forward(req, res, url, current, { body: [raw] }), native); return;
    }
    if (pathname === '/api/projects' && req.method === 'GET') { send(res, 200, { projects: getProjects() }); return; }
    if (pathname === '/api/overview' && req.method === 'GET') { send(res, 200, await readOverview()); return; }
    if (pathname === '/api/overview/events' && req.method === 'GET') {
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台订阅状态');
      if (req.headers.origin) sameOrigin(req);
      // Read before the limit check, so concurrent subscribers cannot all pass it during the read.
      const initial = await readOverview();
      if (res.destroyed) return;
      if (draining) throw new HttpError(503, '工作台正在关闭');
      if (!sessions.isActive(current.id)) throw new HttpError(401, '登录已失效，请重新登录');
      if (streams.size >= 60 || [...streams.values()].filter(value => value.id === current.id).length >= 12) throw new HttpError(429, '状态订阅过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const encode = url.searchParams.get('protocol') === '2' ? createOverviewEncoder() : null;
      streams.set(res, { ...current, encode }); res.write(`retry: 5000\ndata: ${JSON.stringify(encode ? encode(initial) : initial)}\n\n`);
      res.once('close', () => { streams.delete(res); reportStats(); }); reportStats(); return;
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      if (embeddedModules) throw new HttpError(405, '工作台只运行内嵌模块');
      const body = await bodyOf(req);
      if (getProjects().length >= MAX_PROJECTS) throw new HttpError(400, `最多接入 ${MAX_PROJECTS} 个项目`);
      const value = validateProject(body); value.id = body.id || randomBytes(8).toString('hex');
      if (projects.exists(value.id)) throw new HttpError(409, '项目标识已存在');
      const credentials = body.password ? encrypt({ password: body.password, username: body.username || '' }) : null;
      projects.insert(value.id, JSON.stringify(value), credentials);
      send(res, 201, { project: publicProject(rowFor(value.id)) }); void notify(value.id, { reason: 'created' }); return;
    }
    const match = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)(\/(?:check|launch|sync))?$/);
    if (match) {
      const id = match[1]; const row = rowFor(id);
      if (embeddedModules && !match[2]) {
        if (req.method !== 'PUT') throw new HttpError(405, '内嵌模块不能删除');
        const body = await bodyOf(req);
        if (Object.keys(body).some(key => !['autoSync', 'staleAfterSeconds', 'order'].includes(key))) throw new HttpError(400, '仅可修改模块显示与同步设置');
        if (body.autoSync !== undefined && (id !== 'asset' || typeof body.autoSync !== 'boolean')) throw new HttpError(400, '同步设置无效');
        if (body.staleAfterSeconds !== undefined && (!Number.isInteger(body.staleAfterSeconds) || body.staleAfterSeconds < 30 || body.staleAfterSeconds > 86400)) throw new HttpError(400, '数据过期时间无效');
        if (body.order !== undefined && (!Number.isInteger(body.order) || body.order < 0 || body.order > 9999)) throw new HttpError(400, '排列顺序无效');
        const preferences = { ...JSON.parse(getSetting('module-preferences:' + id) || '{}'), ...body };
        setSetting('module-preferences:' + id, JSON.stringify(preferences));
        await notify(id, { reason: 'preferences' });
        send(res, 200, { project: publicProject(row) }); return;
      }
      if ((match[2] === '/check' || match[2] === '/sync') && req.method === 'POST') { await forward(req, res, url, current); return; }
      if (match[2] === '/launch' && req.method === 'POST') {
        const project = publicProject(row);
        if (!project.enabled || project.accessMode !== 'proxy' || !project.apiUrl) throw new HttpError(400, '请先启用项目并配置通过工作台访问的服务地址');
        send(res, 200, portal.createLaunch({ projectId: id, sessionId: current.id, req })); return;
      }
      if (!match[2] && req.method === 'PUT') {
        const body = await bodyOf(req); const prior = JSON.parse(row.json); const value = validateProject(body, prior);
        const boundaryChanged = prior.apiUrl !== value.apiUrl || prior.adapter !== value.adapter || (prior.authOrigin || '') !== value.authOrigin;
        const previous = boundaryChanged || body.clearCredentials ? null : decrypt(row.credentials);
        const credentials = body.password ? encrypt({ password: body.password, username: body.username ?? previous?.username ?? '' }) : previous ? encrypt({ ...previous, username: body.username ?? previous.username }) : null;
        projects.update(id, JSON.stringify(value), credentials);
        const clearSnapshot = !!(boundaryChanged || prior.enabled !== value.enabled || prior.staleAfterSeconds !== value.staleAfterSeconds || (value.adapter === 'monitor' && prior.url !== value.url) || body.password || body.clearCredentials || (body.username !== undefined && body.username !== decrypt(row.credentials)?.username));
        await notify(id, { reason: 'updated', clearSnapshot });
        send(res, 200, { project: publicProject(rowFor(id)) }); return;
      }
      if (!match[2] && req.method === 'DELETE') { projects.delete(id); await notify(id, { reason: 'deleted' }); send(res, 200, { ok: true }); return; }
    }
    throw new HttpError(404, '接口不存在');
  }

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
  // Responses not finished yet, while draining each one closes its connection;
  // handlers still running; upgraded sockets, which server.close() waits for
  // but closeAllConnections() does not reach.
  const inFlight = new Set(), handlers = new Set(), upgrades = new Set();
  // Listeners whose connections this server handles: a slot's traffic socket.
  // The server's own listener keeps the connection tracking that the request
  // timeouts and closeIdleConnections() rely on.
  const attached = new Set(), traffic = new WeakSet();
  const isProbe = socket => privateProbe && !traffic.has(socket);
  const server = http.createServer((req, res) => { const task = handle(req, res), done = () => handlers.delete(task); handlers.add(task); task.then(done, error => { done(); log.error({ err: error, type: 'request' }, '请求处理失败'); }); });
  async function handle(req, res) {
    receivedAt.set(req, Date.now());
    inFlight.add(res);
    res.once('close', () => { inFlight.delete(res); if (draining) setImmediate(() => server.closeIdleConnections()); });
    if (draining) res.setHeader('Connection', 'close');
    if (!candidate && isProbe(req.socket) && !['GET', 'HEAD'].includes(req.method)) { send(res, 405, { error: '探针连接只接受读取' }); return; }
    try { if ((!configuredOrigin || req.headers.host !== new URL(configuredOrigin).host) && await portal.handle(req, res)) return; }
    catch { if (!res.headersSent) send(res, 502, { error: '项目页面暂时不可用，请从工作台重新打开' }); else res.destroy(); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    const localRouteSource = req.headers.host === 'hub.localhost:3100' && !secureCookies && !req.socket.encrypted ? ' http://127.0.0.1:3101' : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${localRouteSource}; frame-src http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
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
      if (!existsSync(filename) || !statSync(filename).isFile()) {
        const other = decoded.startsWith('/assets/') ? releaseAsset(decoded.slice(8)) : null;
        if (other) filename = other;
        else if (path.extname(decoded)) throw new HttpError(404, '文件不存在');
        else filename = path.join(distDir, 'index.html');
      }
      if (!existsSync(filename)) { send(res, 503, { error: '前端尚未构建，请先执行 npm run build' }); return; }
      await serveStatic(req, res, filename, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    } catch (error) { if (!res.headersSent) { const reply = respond(error); send(res, reply.status, reply.body); } else res.end(); }
  }
  server.on('upgrade', (req, socket, head) => {
    upgrades.add(socket); socket.once('close', () => upgrades.delete(socket));
    if (isProbe(socket)) { socket.on('error', () => {}); socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroySoon(); return; }
    void portal.handleUpgrade(req, socket, head).then(handled => { if (!handled) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroySoon(); } }).catch(() => socket.destroy());
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS; server.headersTimeout = 10000; server.maxHeadersCount = 80;

  return {
    server, instanceId: apiInstanceId,
    get updates() { return updates; },
    get candidate() { return candidate; },
    attach(listener) {
      attached.add(listener);
      listener.on('connection', socket => { traffic.add(socket); server.emit('connection', socket); });
    },
    // Takes up the serving duties; the caller has made the database writable.
    promote() {
      if (!candidate || closing) return;
      updates = coordinator(); candidate = false; startStats();
    },
    streamCount: () => streams.size,
    // A new runtime instance has no counts yet: the entry reports them at once.
    reportStats,
    initialize: async () => updates?.initialize(),
    async resetPassword() { const password = await resetPassword(control); pruneStreams(); updateStream.revalidate(); return password; },
    // Drains, then ends the control-plane services (design doc api-dual-slot 5.1):
    // the listener stops and kept-alive connections close after their response;
    // the overview and update streams end, and so do Portal's upgraded connections
    // and event streams, which the pages reconnect; drainMs after close() began,
    // every connection left is destroyed, and handlers still running get
    // HANDLER_GRACE_MS more. Only then do the coordinator (at most
    // COORDINATOR_CLOSE_MS), the last stream-count report and Portal end,
    // within the API unit's TimeoutStopSec.
    close() {
      return closing ??= (async () => {
        draining = true;
        const open = [server, ...attached].filter(item => item.listening);
        const listener = open.length ? Promise.all(open.map(item => new Promise(resolve => item.close(resolve)))) : null;
        const forced = listener && setTimeout(() => {
          log.warn({ requests: inFlight.size, upgrades: upgrades.size, type: 'shutdown' }, '在途请求未在期限内结束，已关闭其连接');
          server.closeAllConnections(); for (const socket of upgrades) socket.destroy();
        }, drainMs);
        for (const res of inFlight) if (!res.headersSent) res.setHeader('Connection', 'close');
        server.closeIdleConnections();
        for (const res of streams.keys()) res.end(); streams.clear();
        portal.drain();
        // End stream clients now, but drain requests before waiting for its
        // shared status read. That read may be behind slow module syncs.
        const streamClosing = updateStream.close();
        if (listener) { await listener; clearTimeout(forced); }
        let grace; await Promise.race([Promise.allSettled([...handlers]), new Promise(resolve => { grace = setTimeout(resolve, HANDLER_GRACE_MS); })]); clearTimeout(grace);
        // A candidate that never served has reported nothing and reports nothing now.
        const reported = candidate ? Promise.resolve() : finalReport();
        closed = true; unsubscribe(); clearInterval(heartbeat); clearInterval(statsTimer); for (const timer of retries) clearTimeout(timer); retries.clear();
        // A status read or module synchronization in flight gets COORDINATOR_CLOSE_MS; closing does not wait longer.
        const ending = Promise.allSettled([updates ? updates.close() : Promise.resolve(), streamClosing]).then(results => {
          for (const result of results) if (result.status === 'rejected') log.warn({ err: result.reason, type: 'shutdown' }, '更新协调器关闭失败');
        }); let bound;
        const late = await Promise.race([ending.then(() => false), new Promise(resolve => { bound = setTimeout(() => resolve(true), COORDINATOR_CLOSE_MS); })]); clearTimeout(bound);
        if (late) { log.warn({ type: 'shutdown' }, '更新协调器未在期限内结束，继续关闭'); ending.catch(error => log.warn({ err: error, type: 'shutdown' }, '更新协调器关闭失败')); }
        portal.close(); await reported;
      })();
    },
  };
}

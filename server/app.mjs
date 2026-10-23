import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateUrl, validateAuthOrigin, readSummary, requestJson, UpstreamError } from './adapters.mjs';
import { createPortal } from './portal.mjs';
import { loginForPortal } from './portal-auth.mjs';
import { createAssetSync, syncAsset } from './asset-sync.mjs';
import { createOverviewEncoder } from './overview-stream.mjs';
import { createStaticResponder } from './static-response.mjs';
import { createTrading, TradingError } from './trading.mjs';
import { snapshotDiagnostics } from './diagnostics.mjs';
import { createTradingImporter } from './trading-import.mjs';
import { createAssetPositions } from './asset-positions.mjs';
import { createAssetFills } from './asset-fills.mjs';
import { createTradingExecution } from './trading-execution.mjs';
import { ExecutionError } from './trading-execution-plan.mjs';
import { normalizeTradingPair } from './trading-markets.mjs';
import { createUpdateClient, createUpdateCoordinator, validateUpdateBody, UpdateError } from './updates.mjs';
import { createUpdateStream } from './update-stream.mjs';
import { createStatementCache } from './db-cache.mjs';
import { moduleCatalog, moduleIds } from './modules/catalog.mjs';
import { createModuleUpdateGuard } from './modules/updates.mjs';
import { readModuleCapabilities } from './modules/capabilities.mjs';
import { createBaseline, BASELINE_INTERVAL_MS, validateBaselineInterval } from './observability.mjs';
import { createAccountWriter } from './execution/account-writer.mjs';
import { assertRecoveryStartup } from './recovery/startup.mjs';

const scrypt = promisify(scryptCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_PROJECTS = 30;
const defaults = [
  { id: 'aster', name: 'ASTER 5X', description: '交易账户、保证金占用与运行状态', category: 'trading', adapter: 'aster', url: 'http://127.0.0.1:8765', apiUrl: 'http://127.0.0.1:8765', staleAfterSeconds: 120 },
  { id: 'monitor', name: 'Market Monitor', description: '原油价差与市场监控', category: 'monitoring', adapter: 'monitor', url: 'http://127.0.0.1:3000/?monitor=oil', apiUrl: 'http://127.0.0.1:3000', staleAfterSeconds: 120 },
  { id: 'asset', name: 'Asset Ledger', description: '资产账本、持有金额与历史变化', category: 'assets', adapter: 'asset', url: 'http://127.0.0.1:5678', apiUrl: 'http://127.0.0.1:5678', staleAfterSeconds: 900 },
  { id: 'crossex', name: 'Gate CrossEx', description: '跨交易所永续手动实盘与持仓观察', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:3200', apiUrl: 'http://127.0.0.1:3200', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 120 },
  { id: 'variational', name: 'Variational Grid', description: 'Lighter QQQ / Variational US100 对冲剥头皮模拟', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:9876', apiUrl: 'http://127.0.0.1:9876', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 120 },
  { id: 'greeks', name: 'Greeks · BTC 期权', description: 'Bybit BTC 铁鹰期权、持仓与策略收益', category: 'trading', adapter: 'standard', url: 'http://127.0.0.1:8000', apiUrl: 'http://127.0.0.1:8000', accessMode: 'proxy', autoSync: false, staleAfterSeconds: 30 },
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

export async function createApp({ embeddedModules = false, dataDir = process.env.DATA_DIR || path.join(root, '.data'), initialPassword = process.env.INITIAL_PASSWORD, refreshInterval = 30000, timeoutMs = 5000, loginWindowMs = 15 * 60000, accountLockoutMs = 30 * 60000, summaryReader = readSummary, assetSyncIntervalMs = 60000, assetSyncReader = syncAsset, assetPositionsRequest, assetPositionsCacheMs, assetPositionsTimeoutMs, assetPositionsNow, assetFillsRequest, assetFillsCacheMs, assetFillsTimeoutMs, assetFillsNow, assetPositionsBackgroundMs = assetSyncIntervalMs > 0 ? 30000 : 0, tradingClientFactory, tradingRefreshIntervalMs = 1000, tradingNow = Date.now, tradingTaskTimeoutMs = 60000, tradingImportRequest, tradingImportSourceTimeoutMs, tradingImportTimeoutMs, executionClientFactory, executionIntervalMs = 1000, executionNow = Date.now, updatesClient, logger = console, secureCookies = process.env.COOKIE_SECURE === 'true', publicOrigin = process.env.PUBLIC_ORIGIN || '', distDir = path.join(root, 'dist'), warmupEnabled = process.env.WARMUP_ENABLED !== 'false', warmupProjects = process.env.WARMUP_PROJECTS === undefined ? ['aster', 'monitor', 'asset'] : process.env.WARMUP_PROJECTS.split(','), warmupIntervalMs = process.env.WARMUP_INTERVAL_MS === undefined ? 90000 : Number(process.env.WARMUP_INTERVAL_MS), baselineIntervalMs = BASELINE_INTERVAL_MS, baselineNow = Date.now, capabilitiesRequest = requestJson, accountWriter = null } = {}) {
  validateBaselineInterval(baselineIntervalMs);
  if (!Number.isInteger(warmupIntervalMs) || warmupIntervalMs < 1000 || warmupIntervalMs > 2147483647) throw new RangeError('WARMUP_INTERVAL_MS 必须为 1000 至 2147483647 的整数（毫秒）');
  if (!Number.isInteger(accountLockoutMs) || accountLockoutMs < 1000 || accountLockoutMs > 86400000) throw new RangeError('accountLockoutMs 必须为 1000 至 86400000 的整数（毫秒）');
  if (!Array.isArray(warmupProjects) || warmupProjects.some(id => typeof id !== 'string')) throw new TypeError('warmupProjects 必须为项目 ID 字符串数组');
  const warmupProjectIds = new Set(warmupProjects.map(id => id.trim()).filter(Boolean));
  const configuredOrigin = publicOrigin ? validateAuthOrigin(publicOrigin) : '';
  const resolvedData = path.resolve(dataDir);
  const log = typeof logger === 'function' ? { info: logger, warn: logger, error: logger, debug: logger } : logger;
  log.info({ dataDir: resolvedData, type: 'startup' }, '初始化数据目录');
  mkdirSync(resolvedData, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(resolvedData, 0o700);
  assertRecoveryStartup(resolvedData);
  const keyPath = path.join(resolvedData, 'credentials.key');
  const dbPath = path.join(resolvedData, 'hub.sqlite');
  if (!existsSync(keyPath)) {
    if (existsSync(dbPath)) throw new Error('凭据密钥文件缺失，请恢复 credentials.key 后再启动');
    log.info({ type: 'security' }, '生成新的凭据加密密钥');
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('凭据密钥文件长度不正确');
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,json TEXT NOT NULL,credentials TEXT); CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);');
  if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  log.info({ dbPath, type: 'startup' }, '数据库初始化完成');
  const stmt = createStatementCache(db);
  const getSetting = name => stmt.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value;
  if (!getSetting('password')) {
    const password = initialPassword || randomBytes(18).toString('base64url');
    if (password.length < 12 || password.length > 1024) { db.close(); throw new Error('INITIAL_PASSWORD 必须为 12 至 1024 个字符'); }
    stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('password', await passwordRecord(password));
    if (!initialPassword) log.info({ type: 'security' }, `工作台初始登录密码：${password}\n请保存此密码；只在首次启动显示。重置请运行 node server/setup.mjs --reset-password`);
  }
  if (!getSetting('seeded')) {
    db.exec('BEGIN IMMEDIATE');
    try { for (const project of (embeddedModules ? moduleCatalog : defaults)) stmt.prepare('INSERT OR IGNORE INTO projects(id,json) SELECT ?,? WHERE (SELECT COUNT(*) FROM projects) < ?').run(project.id, JSON.stringify(project), MAX_PROJECTS); stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('seeded', '1'); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (embeddedModules) {
    // Fixed modules are always present, even when a previous external preset
    // was deleted or a legacy installation already used all project slots.
    for (const project of moduleCatalog) stmt.prepare('INSERT OR IGNORE INTO projects(id,json) VALUES (?,?)').run(project.id, JSON.stringify(project));
  }
  for (const id of (embeddedModules ? moduleIds : ['crossex', 'variational', 'greeks'])) {
    const marker = `seeded-${id}-v1`;
    if (getSetting(marker)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const project = (embeddedModules ? moduleCatalog : defaults).find(item => item.id === id);
      // Keep existing connections intact; the marker also preserves a later user deletion.
      stmt.prepare('INSERT OR IGNORE INTO projects(id,json) SELECT ?,? WHERE (SELECT COUNT(*) FROM projects) < ?').run(project.id, JSON.stringify(project), MAX_PROJECTS);
      stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(marker, '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!getSetting('updated-crossex-live-description-v1')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = stmt.prepare('SELECT json FROM projects WHERE id=?').get('crossex');
      const project = row ? JSON.parse(row.json) : null;
      if (project?.description === '同币种跨交易所永续价差套利模拟') {
        project.description = defaults.find(item => item.id === 'crossex').description;
        stmt.prepare('UPDATE projects SET json=? WHERE id=?').run(JSON.stringify(project), 'crossex');
      }
      stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('updated-crossex-live-description-v1', '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!embeddedModules && !getSetting('updated-variational-description-v1')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = stmt.prepare('SELECT json FROM projects WHERE id=?').get('variational');
      const project = row ? JSON.parse(row.json) : null;
      if (project?.description === 'CL/BZ 网格、库存组合与 QQQ / US100 对冲模拟') {
        project.description = defaults.find(item => item.id === 'variational').description;
        stmt.prepare('UPDATE projects SET json=? WHERE id=?').run(JSON.stringify(project), 'variational');
      }
      stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('updated-variational-description-v1', '1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); };
  const decrypt = value => { if (!value) return null; const buffer = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); cipher.setAuthTag(buffer.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString()); };
  const trading = createTrading({ db, stmt, encrypt, decrypt, clientFactory: tradingClientFactory, intervalMs: tradingRefreshIntervalMs, now: tradingNow, taskTimeoutMs: tradingTaskTimeoutMs, logger: log });
  const writerDatabase = path.join(resolvedData, 'execution-control.sqlite');
  // A legacy external-module launch must not turn off protection for data that
  // already belongs to a managed or recovered authority.
  const sharedAccountWriter = accountWriter || (embeddedModules || existsSync(writerDatabase) || existsSync(`${writerDatabase}.required`) ? createAccountWriter({ databasePath: writerDatabase, runtimeId: randomUUID(), moduleId: 'hub' }) : null);
  const execution = createTradingExecution({ db, stmt, encrypt, decrypt, clientFactory: executionClientFactory, intervalMs: executionIntervalMs, now: executionNow, accountWriter: sharedAccountWriter, isSessionActive: id => !!stmt.prepare('SELECT 1 FROM sessions WHERE id=? AND expires>?').get(id, Date.now()) });
  const moduleUpdateGuard = embeddedModules ? createModuleUpdateGuard() : null;
  const updates = createUpdateCoordinator({ client: updatesClient || createUpdateClient(), execution,
    ...(moduleUpdateGuard ? { setModuleMaintenance: moduleUpdateGuard.setMaintenance, prepareApply: moduleUpdateGuard.prepareApply } : {}),
    readMaintenance: () => getSetting('updates-maintenance') === '1',
    writeMaintenance: active => stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('updates-maintenance', active ? '1' : '0'),
    readPendingPlanId: () => getSetting('updates-pending-plan') || null,
    writePendingPlanId: planId => stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('updates-pending-plan', planId || ''),
    readPendingDeployMode: () => getSetting('updates-pending-deploy-mode') || 'source',
    writePendingDeployMode: mode => stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('updates-pending-deploy-mode', mode),
  });
  const publicProject = row => { const project = JSON.parse(row.json);
    if (embeddedModules) {
      const module = moduleCatalog.find(item => item.id === project.id);
      if (!module) return null;
      const preferences = JSON.parse(getSetting('module-preferences:' + module.id) || '{}');
      return { ...module, ...preferences, revision: hash(JSON.stringify([module, preferences])) };
    }
    const credentials = decrypt(row.credentials); return { authOrigin: '', accessMode: ['aster', 'monitor', 'asset'].includes(project.adapter) ? 'proxy' : 'direct', autoSync: project.adapter === 'asset', ...project, revision: hash(`${row.json}\0${row.credentials || ''}`), hasCredentials: !!credentials?.password, ...(credentials?.username ? { username: credentials.username } : {}) }; };
  const getProjects = () => stmt.prepare('SELECT * FROM projects').all().map(publicProject).filter(Boolean).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const rowFor = id => { if (embeddedModules && !moduleIds.includes(id)) throw new HttpError(404, '模块已移除'); const row = stmt.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!row) throw new HttpError(404, '项目不存在'); return row; };
  const states = new Map(); const pending = new Map(); const controllers = new Set();
  let baseline = null;
  async function observedSummary(...args) {
    const start = performance.now();
    try { const value = await summaryReader(...args); baseline?.observeSummary(true, performance.now() - start); return value; }
    catch (error) { baseline?.observeSummary(false, performance.now() - start); throw error; }
  }
  async function capabilities(signal) {
    if (!embeddedModules) return [];
    return Promise.all(moduleIds.map(async id => {
      try { return { moduleId: id, state: 'compatible', capabilities: await readModuleCapabilities(id, { request: capabilitiesRequest, deadline: Date.now() + 5000, signal }) }; }
      catch { return { moduleId: id, state: 'unavailable', capabilities: null }; }
    }));
  }
  const loginAttempts = new Map(); // IP-based rate limiting
  // Account-level lockout: failures within accountLockoutMs of the first one, password checks in flight, and the lock deadline.
  const accountLockouts = new Map();
  const ACCOUNT_LOCKOUT_THRESHOLD = 5;
  // A lock expires at its deadline; unlocked failures expire one lockout period after the first failure.
  const expireLockouts = now => { for (const [account, lockout] of accountLockouts) if (!lockout.pending && (lockout.until ? lockout.until <= now : now - lockout.firstFailureAt >= accountLockoutMs)) accountLockouts.delete(account); };
  let closed = false;
  const updateStream = createUpdateStream({ readState: updates.status,
    isSessionActive: id => !closed && !!stmt.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(id, Date.now()),
  });
  let assetSync = null;
  const streams = new Map();
  const serveStatic = createStaticResponder();
  const overview = () => {
    // Use in-memory states cache directly; snapshot() handles lazy loading from DB
    return { projects: getProjects().map(snapshot), generatedAt: new Date().toISOString() };
  };
  function publishOverview() {
    let message, data;
    for (const [res, current] of streams) {
      if (closed || !stmt.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(current.id, Date.now())) { res.end(); streams.delete(res); continue; }
      if (res.writableLength > 256 * 1024) { baseline?.observeSlowConsumer(); res.destroy(); streams.delete(res); continue; }
      data ??= overview();
      if (current.encode) res.write(`data: ${JSON.stringify(current.encode(data))}\n\n`);
      else { message ??= `data: ${JSON.stringify(data)}\n\n`; res.write(message); }
    }
  }
  const projectRevision = id => { if (embeddedModules) return getProjects().find(item => item.id === id)?.revision || null; const row = stmt.prepare('SELECT json,credentials FROM projects WHERE id=?').get(id); return row ? hash(`${row.json}\0${row.credentials || ''}`) : null; };
  const tradingImporter = createTradingImporter({ trading, request: tradingImportRequest, sourceTimeoutMs: tradingImportSourceTimeoutMs, importTimeoutMs: tradingImportTimeoutMs,
    listTargets: () => stmt.prepare('SELECT * FROM projects').all().filter(row => { const project = embeddedModules ? publicProject(row) : JSON.parse(row.json); return project?.enabled && project.adapter === 'asset'; }).map(row => ({ project: publicProject(row), credentials: embeddedModules ? null : decrypt(row.credentials), revision: projectRevision(row.id) })),
  });
  const assetTargets = () => stmt.prepare('SELECT * FROM projects').all().filter(row => { const project = embeddedModules ? publicProject(row) : JSON.parse(row.json); return project?.enabled && project.adapter === 'asset'; }).map(row => ({ project: publicProject(row), credentials: embeddedModules ? null : decrypt(row.credentials), revision: projectRevision(row.id) }));
  const assetPositions = createAssetPositions({ request: assetPositionsRequest, cacheMs: assetPositionsCacheMs, timeoutMs: assetPositionsTimeoutMs, now: assetPositionsNow, backgroundIntervalMs: assetPositionsBackgroundMs,
    listTargets: assetTargets,
  });
  const assetFills = createAssetFills({ listTargets: assetTargets, request: assetFillsRequest, cacheMs: assetFillsCacheMs, timeoutMs: assetFillsTimeoutMs, now: assetFillsNow });
  const portal = createPortal({
    ...(embeddedModules ? { withMutation: updates.withExecutionEntry } : {}),
    getProjects: () => getProjects().filter(project => project.accessMode === 'proxy'),
    getProjectRevision: projectRevision,
    isSessionValid: id => !!stmt.prepare('SELECT id FROM sessions WHERE id=? AND expires>?').get(id, Date.now()),
    authenticateProject: async ({ projectId, revision, deadline, signal }) => {
      if (closed || signal.aborted || projectRevision(projectId) !== revision) throw new HttpError(401, '页面授权已失效');
      const row = rowFor(projectId);
      const auth = embeddedModules ? null : await loginForPortal(publicProject(row), decrypt(row.credentials), { deadline, signal });
      if (closed || signal.aborted || projectRevision(projectId) !== revision) throw new HttpError(401, '页面授权已失效');
      return auth;
    },
    coordinateAssetSync: async ({ projectId, revision }) => {
      if (closed || projectRevision(projectId) !== revision) return null;
      const status = await assetSync.run(projectId);
      return !closed && projectRevision(projectId) === revision ? status : null;
    },
  });

  function snapshot(project) {
    const base = { project, state: 'unconfigured', message: '等待首次读取数据', checkedAt: null, updatedAt: null, latencyMs: null, metrics: [], ...(project.adapter === 'asset' ? { sync: assetSync?.getStatus(project.id) || null } : {}) };
    if (!project.enabled) return { ...base, state: 'disabled', message: '项目已停用' };
    if (!project.apiUrl && project.adapter !== 'link') return { ...base, message: '请配置接口地址' };
    if (project.adapter === 'link') return { ...base, state: project.url ? 'online' : 'unconfigured', message: project.url ? '链接入口；不采集项目数据' : '请配置项目地址' };
    let state = states.get(project.id);
    if (!state) { const saved = stmt.prepare('SELECT json FROM snapshots WHERE id=?').get(project.id); state = saved ? JSON.parse(saved.json) : null; }
    if (!state) return base;
    const diagnostics = snapshotDiagnostics(state, project);
    if (JSON.stringify(diagnostics) !== JSON.stringify(state.diagnostics)) {
      state = { ...state, diagnostics };
      stmt.prepare('INSERT INTO snapshots(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(project.id, JSON.stringify(state));
      states.set(project.id, state);
    }
    const { sourceDiagnostics, sourceState, sourceMessage, transportError, ...visible } = state;
    const result = { ...base, ...visible, project };
    result.staleAfterSeconds = Math.min(project.staleAfterSeconds, state.staleAfterSeconds || project.staleAfterSeconds);
    if (['online', 'partial'].includes(result.state) && diagnostics.some(item => item.id === 'hub:data-freshness')) { result.state = 'stale'; result.message = result.updatedAt ? `数据已过期。${result.message}` : `上游未提供有效的数据更新时间。${result.message}`; }
    return result;
  }

  async function check(id) {
    if (pending.has(id)) return pending.get(id);
    const row = rowFor(id); const project = publicProject(row);
    if (!project.enabled || !project.apiUrl || project.adapter === 'link') return snapshot(project);
    const controller = new AbortController(); controllers.add(controller);
    const run = (async () => {
      const start = Date.now(); const checkedAt = new Date(start).toISOString();
      const saved = stmt.prepare('SELECT json FROM snapshots WHERE id=?').get(id);
      const previous = saved ? JSON.parse(saved.json) : null;
      try {
        const data = await observedSummary(project, embeddedModules ? null : decrypt(row.credentials), { deadline: start + timeoutMs, signal: controller.signal });
        if (closed) return null;
        const latest = stmt.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!latest) return null;
        if (latest.json !== row.json || latest.credentials !== row.credentials) return snapshot(publicProject(latest));
        const value = { state: data.state || (data.stale ? 'stale' : data.partial ? 'partial' : 'online'), message: data.message, checkedAt, lastSuccessAt: new Date(Date.now()).toISOString(), updatedAt: data.updatedAt || null, latencyMs: Date.now() - start, metrics: data.metrics, ...(data.staleAfterSeconds ? { staleAfterSeconds: data.staleAfterSeconds } : {}), ...(data.freshness === 'static' ? { freshness: 'static' } : {}), ...(data.trend ? { trend: data.trend } : {}) };
        value.sourceState = value.state; value.sourceMessage = value.message;
        if (Array.isArray(data.diagnostics)) value.sourceDiagnostics = data.diagnostics.map(({ id, kind, message }) => ({ id, kind, message }));
        value.diagnostics = snapshotDiagnostics({ ...value, diagnostics: states.get(id)?.diagnostics || previous?.diagnostics }, project);
        stmt.prepare('INSERT INTO snapshots(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(value)); states.set(id, value);
      } catch (error) {
        if (closed) return null;
        const latest = stmt.prepare('SELECT * FROM projects WHERE id=?').get(id);
        if (!latest) return null;
        if (latest.json !== row.json || latest.credentials !== row.credentials) return snapshot(publicProject(latest));
        const unauthorized = error instanceof UpstreamError && error.code === 'unauthorized';
        const hasData = previous && previous.lastSuccessAt !== null;
        const message = error instanceof UpstreamError ? error.message : '无法读取项目摘要';
        const value = { ...(previous || {}), sourceState: previous?.sourceState || (hasData ? previous.state : 'online'), sourceMessage: previous?.sourceMessage || previous?.message, lastSuccessAt: hasData ? previous.lastSuccessAt || previous.checkedAt : null, transportError: { code: unauthorized ? 'unauthorized' : 'connection', message }, state: unauthorized ? 'unauthorized' : hasData ? 'stale' : 'offline', message: `${message}${hasData ? '；保留上次成功数据' : ''}`, checkedAt, latencyMs: Date.now() - start, updatedAt: previous?.updatedAt || null, metrics: previous?.metrics || [] };
        value.diagnostics = snapshotDiagnostics({ ...value, diagnostics: states.get(id)?.diagnostics || value.diagnostics }, project);
        stmt.prepare('INSERT INTO snapshots(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(value)); states.set(id, value);
      }
      return snapshot(publicProject(rowFor(id)));
    })().finally(() => { pending.delete(id); controllers.delete(controller); if (!closed) publishOverview(); });
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
    const row = stmt.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(cookie), Date.now());
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
      expireLockouts(now);
      const accountId = 'global'; // Single-account system
      const locked = lockout => lockout && lockout.until > Date.now() ? new HttpError(429, `账户已被锁定，请 ${Math.ceil((lockout.until - Date.now()) / 60000)} 分钟后重试`) : null;
      const lockedError = locked(accountLockouts.get(accountId));
      if (lockedError) throw lockedError;

      const attempt = loginAttempts.get(ip) || { count: 0, until: now + loginWindowMs };
      if (attempt.count >= 10) throw new HttpError(429, '登录尝试过多，请 15 分钟后重试');
      // Reserve before reading the body: partial concurrent requests share one quota.
      attempt.count += 1; loginAttempts.set(ip, attempt);
      const body = await bodyOf(req);

      // Reserve an account slot after the body arrives, so held-open bodies cannot block logins,
      // and before hashing, so concurrent guesses cannot exceed the remaining failure budget.
      expireLockouts(Date.now());
      const reserved = accountLockouts.get(accountId) || { failedAttempts: 0, pending: 0, until: 0, firstFailureAt: 0 };
      const reservedError = locked(reserved);
      if (reservedError) throw reservedError;
      if (reserved.failedAttempts + reserved.pending >= ACCOUNT_LOCKOUT_THRESHOLD) throw new HttpError(429, '登录尝试过多，请稍后重试');
      reserved.pending += 1; accountLockouts.set(accountId, reserved);
      let passwordValid;
      try {
        const passwordVersion = getSetting('password');
        passwordValid = typeof body.password === 'string' && body.password.length <= 1024 && await passwordMatches(body.password, passwordVersion) && getSetting('password') === passwordVersion;
      } finally { reserved.pending -= 1; }

      // The record cannot be removed while a check is pending, so update it in place instead of writing back a stale copy.
      if (!passwordValid) {
        const failedAt = Date.now();
        if (!reserved.failedAttempts) reserved.firstFailureAt = failedAt;
        reserved.failedAttempts += 1;
        log.warn({ ip, failedAttempts: reserved.failedAttempts, type: 'auth_failed' }, '登录失败');
        const alreadyLocked = locked(reserved);
        if (alreadyLocked) throw alreadyLocked;
        if (reserved.failedAttempts >= ACCOUNT_LOCKOUT_THRESHOLD) {
          reserved.until = failedAt + accountLockoutMs;
          log.error({ ip, failedAttempts: reserved.failedAttempts, type: 'account_locked' }, '账户已被锁定');
          throw new HttpError(429, `连续登录失败过多，账户已被锁定 ${Math.ceil(accountLockoutMs / 60000)} 分钟`);
        }
        throw new HttpError(401, '登录密码不正确');
      }
      // A lock set by concurrent failures while this password was being checked still applies.
      const lockedAfterCheck = locked(reserved);
      if (lockedAfterCheck) throw lockedAfterCheck;

      log.info({ ip, type: 'auth_success' }, '登录成功');
      reserved.failedAttempts = 0; reserved.firstFailureAt = 0;
      if (!reserved.pending) accountLockouts.delete(accountId);
      if (loginAttempts.get(ip) === attempt) { attempt.count -= 1; if (attempt.count === 0) loginAttempts.delete(ip); }

      stmt.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
      // Security: Always delete old session and generate new ID on login to prevent session fixation
      if (current) stmt.prepare('DELETE FROM sessions WHERE id=?').run(current.id);
      // Always generate a fresh session ID and CSRF token after successful authentication
      const raw = token(); const csrf = token();
      stmt.prepare('INSERT INTO sessions(id,csrf,expires) VALUES (?,?,?)').run(hash(raw), csrf, now + SESSION_AGE);
      send(res, 200, { authenticated: true, csrfToken: csrf }, { 'Set-Cookie': `hub_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secureCookies ? '; Secure' : ''}` }); return;
    }
    if (!current) throw new HttpError(401, '请先登录工作台');
    if (!['GET', 'HEAD'].includes(req.method)) { sameOrigin(req); if (req.headers['x-csrf-token'] !== current.csrf) throw new HttpError(403, '请求校验失败，请刷新页面后重试'); }
    if (pathname === '/api/system/architecture' || pathname === '/api/system/metrics' || pathname === '/api/system/accounts' || pathname === '/api/system/recovery') {
      if (req.method !== 'GET') throw new HttpError(405, '基线接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '基线接口不接受查询参数');
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台读取基线');
      if (req.headers.origin) sameOrigin(req);
      if (pathname === '/api/system/metrics') { send(res, 200, baseline.read()); return; }
      if (pathname === '/api/system/accounts') { send(res, 200, { schemaVersion: 1, enabled: !!sharedAccountWriter, ...(sharedAccountWriter?.snapshot() || { accounts: [], bindings: [], operations: [], isolations: [] }) }); return; }
      if (pathname === '/api/system/recovery') { send(res, 200, { schemaVersion: 1, enabled: !!sharedAccountWriter, recovery: sharedAccountWriter?.snapshot().recovery ?? null }); return; }
      const controller = new AbortController(); controllers.add(controller);
      try {
        const modules = await capabilities(controller.signal);
        if (closed || session(req)?.id !== current.id) throw new HttpError(401, '登录已失效，请重新登录');
        send(res, 200, { schemaVersion: 1, embeddedModules, modules, accountWriterVersion: sharedAccountWriter ? 1 : null, recoveryProtectionVersion: sharedAccountWriter?.recoveryProtectionVersion ?? null });
      } finally { controllers.delete(controller); }
      return;
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      log.info({ ip: req.socket.remoteAddress, type: 'auth_logout' }, '用户登出');
      stmt.prepare('DELETE FROM sessions WHERE id=?').run(current.id);
      publishOverview();
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
          const state = action === 'check' ? await updates.check() : action === 'token' ? await updates.token(body.token, authorize) : await updates.apply(body.planId, authorize, body.deployMode);
          send(res, action === 'token' ? 200 : 202, state);
        }
        finally { void updateStream.refresh(); }
        return;
      }
      throw new HttpError(404, '更新接口不存在');
    }
    if (pathname === '/api/trading/positions') {
      if (req.method !== 'GET') throw new HttpError(405, '仓位接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '仓位接口不接受查询参数');
      const data = await assetPositions.state();
      if (session(req)?.id !== current.id) throw new HttpError(401, '请先登录工作台');
      send(res, 200, data); return;
    }
    if (pathname === '/api/trading/fills') {
      if (req.method !== 'GET') throw new HttpError(405, '成交接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '成交接口不接受查询参数');
      const data = await assetFills.state();
      if (session(req)?.id !== current.id) throw new HttpError(401, '请先登录工作台');
      send(res, 200, data); return;
    }
    if (pathname === '/api/trading/execution' || pathname.startsWith('/api/trading/execution/')) {
      if (pathname === '/api/trading/execution' && req.method === 'GET') { send(res, 200, execution.state()); return; }
      const account = pathname.match(/^\/api\/trading\/execution\/accounts\/(binance|bybit|okx)$/);
      if (account && req.method === 'PUT') { const body = await bodyOf(req); send(res, 200, await updates.withExecutionEntry(() => execution.connect(account[1], body, current.id))); return; }
      if (account && req.method === 'DELETE') { const body = await bodyOf(req); send(res, 200, await updates.withExecutionEntry(() => execution.disconnect(account[1], body, current.id))); return; }
      if (pathname === '/api/trading/execution/preview' && req.method === 'POST') { const body = await bodyOf(req); send(res, 200, await updates.withExecutionEntry(() => execution.preview(body, current.id))); return; }
      if (pathname === '/api/trading/execution/jobs' && req.method === 'POST') { const body = await bodyOf(req); send(res, 202, await updates.withExecutionEntry(() => execution.start(body, current.id))); return; }
      const job = pathname.match(/^\/api\/trading\/execution\/jobs\/([0-9a-f-]{36})\/(stop|reconcile)$/);
      if (job && req.method === 'POST') { const body = await bodyOf(req); send(res, 200, job[2] === 'stop' ? execution.stop(job[1], body, current.id) : await execution.reconcile(job[1], body, current.id)); return; }
      throw new HttpError(404, '实盘执行接口不存在');
    }
    if (pathname === '/api/trading' || pathname.startsWith('/api/trading/')) {
      const daysValue = url.searchParams.get('days') || '7';
      if (!['7', '30'].includes(daysValue)) throw new HttpError(400, '资金费区间仅支持 7 天或 30 天');
      const days = Number(daysValue);
      const pageValue = url.searchParams.get('page') || '0';
      if (!/^(?:0|[1-9]\d{0,3})$/.test(pageValue) || Number(pageValue) > 1999) throw new HttpError(400, '流水页码无效');
      const page = Number(pageValue);
      let pair;
      try { pair = normalizeTradingPair(url.searchParams.get('pair') ?? undefined); } catch { throw new HttpError(400, '请选择两个不同的交易所'); }
      if (pathname === '/api/trading' && req.method === 'GET') { send(res, 200, trading.state(days, { page, pair })); return; }
      if (pathname === '/api/trading/import-sources' && req.method === 'GET') { send(res, 200, await tradingImporter.sources()); return; }
      const importedAccount = pathname.match(/^\/api\/trading\/accounts\/(binance|bybit|okx)\/import$/);
      if (importedAccount && req.method === 'POST') { await tradingImporter.importAccount(importedAccount[1], await bodyOf(req)); send(res, 202, trading.state(days, { page, pair })); return; }
      if (pathname === '/api/trading/refresh' && req.method === 'POST') { await bodyOf(req); void trading.refresh({ force: true }); send(res, 202, trading.state(days, { page, pair })); return; }
      const account = pathname.match(/^\/api\/trading\/accounts\/(binance|bybit|okx)$/);
      if (account && req.method === 'PUT') { await trading.connect(account[1], await bodyOf(req)); send(res, 202, trading.state(days, { page, pair })); return; }
      if (account && req.method === 'DELETE') { const body = await bodyOf(req); trading.disconnect(account[1], body.revision); send(res, 200, trading.state(days, { page, pair })); return; }
      throw new HttpError(404, '交易模块仅提供只读查询和账户连接管理');
    }
    if (pathname === '/api/projects' && req.method === 'GET') { send(res, 200, { projects: getProjects() }); return; }
    if (pathname === '/api/overview' && req.method === 'GET') { send(res, 200, overview()); return; }
    if (pathname === '/api/overview/events' && req.method === 'GET') {
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请从工作台订阅状态');
      if (req.headers.origin) sameOrigin(req);
      if (streams.size >= 60 || [...streams.values()].filter(value => value.id === current.id).length >= 12) throw new HttpError(429, '状态订阅过多');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const encode = url.searchParams.get('protocol') === '2' ? createOverviewEncoder() : null;
      streams.set(res, { ...current, encode }); res.write(`retry: 5000\ndata: ${JSON.stringify(encode ? encode(overview()) : overview())}\n\n`);
      res.once('close', () => streams.delete(res)); return;
    }
    if (pathname === '/api/projects' && req.method === 'POST') {
      if (embeddedModules) throw new HttpError(405, '工作台只运行内嵌模块');
      const body = await bodyOf(req);
      if (getProjects().length >= MAX_PROJECTS) throw new HttpError(400, `最多接入 ${MAX_PROJECTS} 个项目`);
      const value = validateProject(body); value.id = body.id || randomBytes(8).toString('hex');
      if (stmt.prepare('SELECT id FROM projects WHERE id=?').get(value.id)) throw new HttpError(409, '项目标识已存在');
      const credentials = body.password ? encrypt({ password: body.password, username: body.username || '' }) : null;
      stmt.prepare('INSERT INTO projects(id,json,credentials) VALUES (?,?,?)').run(value.id, JSON.stringify(value), credentials);
      send(res, 201, { project: publicProject(rowFor(value.id)) }); void check(value.id).catch(() => {}); if (assetSyncIntervalMs > 0) void assetSync.refresh(); return;
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
        stmt.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('module-preferences:' + id, JSON.stringify(preferences));
        assetFills.invalidate(id);
        states.delete(id); publishOverview();
        if (assetSyncIntervalMs > 0) void assetSync.refresh();
        send(res, 200, { project: publicProject(row) }); return;
      }
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
        stmt.prepare('UPDATE projects SET json=?,credentials=? WHERE id=?').run(JSON.stringify(value), credentials, id);
        assetPositions.invalidate(id); assetFills.invalidate(id);
        if (boundaryChanged || prior.enabled !== value.enabled || prior.staleAfterSeconds !== value.staleAfterSeconds || (value.adapter === 'monitor' && prior.url !== value.url) || body.password || body.clearCredentials || (body.username !== undefined && body.username !== decrypt(row.credentials)?.username)) stmt.prepare('DELETE FROM snapshots WHERE id=?').run(id);
        states.delete(id); publishOverview(); if (assetSyncIntervalMs > 0) void assetSync.refresh(); send(res, 200, { project: publicProject(rowFor(id)) });
        if (inFlight) void inFlight.finally(() => { if (!closed && stmt.prepare('SELECT id FROM projects WHERE id=?').get(id)) void check(id).catch(() => {}); }).catch(() => {});
        else void check(id).catch(() => {}); return;
      }
      if (!match[2] && req.method === 'DELETE') { stmt.prepare('DELETE FROM projects WHERE id=?').run(id); assetPositions.invalidate(id); assetFills.invalidate(id); states.delete(id); publishOverview(); if (assetSyncIntervalMs > 0) void assetSync.refresh(); send(res, 200, { ok: true }); return; }
    }
    throw new HttpError(404, '接口不存在');
  }

  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
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
      if (!existsSync(filename) || !statSync(filename).isFile()) { if (path.extname(decoded)) throw new HttpError(404, '文件不存在'); filename = path.join(distDir, 'index.html'); }
      if (!existsSync(filename)) { send(res, 503, { error: '前端尚未构建，请先执行 npm run build' }); return; }
      await serveStatic(req, res, filename, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': path.basename(filename) === 'index.html' ? 'no-cache' : 'public, max-age=3600' });
    } catch (error) { if (!res.headersSent) send(res, error instanceof HttpError || error instanceof TradingError || error instanceof ExecutionError || error instanceof UpdateError ? error.status : 500, { error: error instanceof HttpError || error instanceof TradingError || error instanceof ExecutionError || error instanceof UpdateError ? error.message : '服务暂时无法处理请求' }); else res.end(); }
  });
  server.on('upgrade', (req, socket, head) => { void portal.handleUpgrade(req, socket, head).then(handled => { if (!handled) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); }).catch(() => socket.destroy()); });
  server.requestTimeout = 60000; server.headersTimeout = 10000; server.maxHeadersCount = 80;
  assetSync = createAssetSync({
    listTargets: () => stmt.prepare('SELECT * FROM projects').all().filter(row => !embeddedModules || moduleIds.includes(row.id)).map(row => ({ project: publicProject(row), credentials: embeddedModules ? null : decrypt(row.credentials), revision: projectRevision(row.id) })),
    intervalMs: assetSyncIntervalMs > 0 ? assetSyncIntervalMs : 60000,
    autoStart: assetSyncIntervalMs > 0, syncReader: assetSyncReader,
    onComplete: async (id, revision, status) => { if (!closed && projectRevision(id) === revision && ['success', 'partial'].includes(status.state)) await check(id); },
  });
  async function refresh(dueOnly = false) { await Promise.allSettled(getProjects().filter(project => {
    if (!project.enabled || !project.apiUrl || project.adapter === 'link') return false;
    if (!dueOnly) return true;
    const state = states.get(project.id);
    // Share the summary schedule so faster refreshes already keep the app warm.
    const warmupPeriod = warmupEnabled && warmupProjectIds.has(project.id) ? warmupIntervalMs : Infinity;
    const ttlMs = Math.min(project.staleAfterSeconds, state?.staleAfterSeconds || project.staleAfterSeconds) * 1000;
    const checkedAt = Date.parse(state?.checkedAt || ''), updatedAt = Date.parse(state?.updatedAt || '');
    // A healthy source can already be several seconds old when sampled. Keep
    // its next read inside the remaining lifetime, anchored to this check.
    const remainingAtCheck = updatedAt + ttlMs - checkedAt;
    const sourcePeriod = state?.freshness !== 'static' && ['online', 'partial'].includes(state?.state)
      && Number.isFinite(remainingAtCheck) && remainingAtCheck > 0 ? remainingAtCheck / 2 : Infinity;
    const period = Math.max(1000, Math.min(refreshInterval, ttlMs / 2, warmupPeriod, sourcePeriod));
    return !state?.checkedAt || Date.now() - checkedAt >= period;
  }).map(project => check(project.id))); }
  const interval = refreshInterval > 0 ? setInterval(() => { if (!closed) void refresh(true); }, Math.min(refreshInterval, 1000)) : null;
  interval?.unref();
  const heartbeat = setInterval(publishOverview, 15000); heartbeat.unref();
  const first = refreshInterval > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();
  await execution.initializeProtection();
  await updates.initialize();
  baseline = createBaseline({ db, intervalMs: baselineIntervalMs, now: baselineNow, logger: log, readCapabilities: capabilities,
    readSnapshot: () => ({ accountWriterVersion: embeddedModules && sharedAccountWriter ? 1 : null, sseConnections: streams.size, projects: getProjects().map(project => ({ project,
      snapshot: states.get(project.id) || (() => { const saved = stmt.prepare('SELECT json FROM snapshots WHERE id=?').get(project.id); return saved ? JSON.parse(saved.json) : null; })(),
    })) }),
  });
  baseline.start();
  return {
    server, check, refresh, assetSync, trading, execution, baseline, dataDir: resolvedData,
    async resetPassword() { const password = randomBytes(18).toString('base64url'); stmt.prepare('UPDATE settings SET value=? WHERE key=?').run(await passwordRecord(password), 'password'); db.exec('DELETE FROM sessions'); publishOverview(); updateStream.revalidate(); return password; },
    async close() { closed = true; clearInterval(interval); clearInterval(heartbeat); clearTimeout(first); await updates.close(); for (const res of streams.keys()) res.end(); streams.clear(); await baseline.close(); await updateStream.close(); await execution.close(); sharedAccountWriter?.close(); await tradingImporter.close(); await assetPositions.close(); await assetFills.close(); await trading.close(); await assetSync.close(); portal.close(); for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending.values()]); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close(); },
  };
}

import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readSummary, requestJson, UpstreamError } from '../adapters.mjs';
import { createAssetSync, syncAsset } from '../asset-sync.mjs';
import { createTrading, TradingError } from '../trading.mjs';
import { snapshotDiagnostics } from '../diagnostics.mjs';
import { createTradingImporter } from '../trading-import.mjs';
import { createAssetPositions } from '../asset-positions.mjs';
import { createAssetFills, ASSET_FILLS_BACKGROUND_MS, FILL_MARKETS } from '../asset-fills.mjs';
import { createTradingExecution } from '../trading-execution.mjs';
import { ExecutionError } from '../trading-execution-plan.mjs';
import { normalizeTradingPair } from '../trading-markets.mjs';
import { UpdateError } from '../updates.mjs';
import { moduleIds } from '../modules/catalog.mjs';
import { readModuleCapabilities } from '../modules/capabilities.mjs';
import { createBaseline, BASELINE_INTERVAL_MS, validateBaselineInterval } from '../observability.mjs';
import { createAccountWriter } from '../execution/account-writer.mjs';
import { HttpError, readJson, errorResponder } from '../http-common.mjs';
import { RuntimeError } from './protocol.mjs';
import { createExecutionEntries, EXECUTION_MAINTENANCE } from '../control/execution-jobs.mjs';
import { createEntropyLighterResearch } from '../research/entropy-lighter.mjs';

const respond = errorResponder([HttpError, TradingError, ExecutionError, UpdateError, RuntimeError]);
// The API reports every 15 s; a sample needs a report at most this old (design doc 5.8).
export const API_STATS_MAX_AGE_MS = 60_000;
// API instances whose counts are kept; the least recently reported is dropped first.
const API_STATS_INSTANCES = 16;

// Warmup settings with the environment defaults; createApp resolves them before opening any file.
export function resolveWarmup({ warmupEnabled = process.env.WARMUP_ENABLED !== 'false', warmupProjects = process.env.WARMUP_PROJECTS === undefined ? ['aster', 'monitor', 'asset'] : process.env.WARMUP_PROJECTS.split(','),
  warmupIntervalMs = process.env.WARMUP_INTERVAL_MS === undefined ? 90000 : Number(process.env.WARMUP_INTERVAL_MS) } = {}) {
  if (!Number.isInteger(warmupIntervalMs) || warmupIntervalMs < 1000 || warmupIntervalMs > 2147483647) throw new RangeError('WARMUP_INTERVAL_MS 必须为 1000 至 2147483647 的整数（毫秒）');
  if (!Array.isArray(warmupProjects) || warmupProjects.some(id => typeof id !== 'string')) throw new TypeError('warmupProjects 必须为项目 ID 字符串数组');
  return { enabled: warmupEnabled, projectIds: new Set(warmupProjects.map(id => id.trim()).filter(Boolean)), intervalMs: warmupIntervalMs };
}

// The data plane of the workbench (design doc 3.2): summary collection and
// snapshots, the overview projection, trading data, native execution, asset
// sync and the baseline. It owns the `snapshots` table and only reads the
// control tables. Business routes reach it through handle() after the API has
// checked the session, origin and CSRF token. The API reports its overview
// stream counts through reportApiStats() (design doc 5.8).
export function createDataPlane({ db, control, catalog, encrypt, decrypt, embeddedModules, dataDir, log, accountWriter = null,
  researchEnabledByDefault = embeddedModules,
  refreshInterval = 30000, timeoutMs = 5000, summaryReader = readSummary, assetSyncIntervalMs = 60000, assetSyncReader = syncAsset,
  assetPositionsRequest, assetPositionsCacheMs, assetPositionsTimeoutMs, assetPositionsNow, assetFillsRequest, assetFillsCacheMs, assetFillsTimeoutMs, assetFillsNow,
  assetPositionsBackgroundMs = assetSyncIntervalMs > 0 ? 30000 : 0, assetFillsBackgroundMs = assetSyncIntervalMs > 0 ? ASSET_FILLS_BACKGROUND_MS : 0,
  tradingClientFactory, tradingRefreshIntervalMs = 1000, tradingNow = Date.now, tradingTaskTimeoutMs = 60000, tradingImportRequest, tradingImportSourceTimeoutMs, tradingImportTimeoutMs,
  executionClientFactory, executionIntervalMs = 1000, executionNow = Date.now,
  warmup = resolveWarmup(), baselineIntervalMs = BASELINE_INTERVAL_MS, baselineNow = Date.now, capabilitiesRequest = requestJson }) {
  validateBaselineInterval(baselineIntervalMs);
  const { stmt, sessions, projects } = control;
  const { publicProject, getProjects, rowFor, projectRevision } = catalog;
  const research = createEntropyLighterResearch({ dataDir, enabledByDefault: researchEnabledByDefault, log });
  const trading = createTrading({ db, stmt, encrypt, decrypt, clientFactory: tradingClientFactory, intervalMs: tradingRefreshIntervalMs, now: tradingNow, taskTimeoutMs: tradingTaskTimeoutMs, logger: log });
  const writerDatabase = path.join(dataDir, 'execution-control.sqlite');
  // A legacy external-module launch must not turn off protection for data that
  // already belongs to a managed or recovered authority.
  const sharedAccountWriter = accountWriter || (embeddedModules || existsSync(writerDatabase) || existsSync(`${writerDatabase}.required`) ? createAccountWriter({ databasePath: writerDatabase, runtimeId: randomUUID(), moduleId: 'hub' }) : null);
  const execution = createTradingExecution({ db, stmt, encrypt, decrypt, clientFactory: executionClientFactory, intervalMs: executionIntervalMs, now: executionNow, accountWriter: sharedAccountWriter, isSessionActive: sessions.isActive });
  const executionEntries = createExecutionEntries({ db, log, readMaintenance: () => control.getSetting('updates-maintenance') === '1', refuse: () => { throw new UpdateError(409, EXECUTION_MAINTENANCE); } });
  const states = new Map(); const pending = new Map(); const controllers = new Set();
  // Overview subscribers; wants() lets an in-process subscriber skip the projection while nobody listens.
  const subscribers = new Set();
  let baseline = null, closed = false, overviewRevision = 0;
  // The latest stream counts of each API instance, with their arrival time.
  // A report older than the instance's last one is dropped. Slow consumers are
  // counted by difference per instance, so a restarted API counts from zero;
  // those reported before the baseline starts are kept. An instance's first
  // report to this runtime, or its first after it was dropped as the least
  // recently reported, counts its whole total.
  const apiStats = new Map(); let slowConsumers = 0;
  function reportApiStats({ instanceId, sequence, activeConnections, slowConsumerDisconnects }) {
    const previous = apiStats.get(instanceId);
    if (previous && sequence <= previous.sequence) return;
    slowConsumers += Math.max(0, slowConsumerDisconnects - (previous?.slowConsumerDisconnects ?? 0));
    if (baseline && slowConsumers) { baseline.observeSlowConsumer(slowConsumers); slowConsumers = 0; }
    apiStats.delete(instanceId);
    apiStats.set(instanceId, { sequence, activeConnections, slowConsumerDisconnects, at: baselineNow() });
    if (apiStats.size > API_STATS_INSTANCES) apiStats.delete(apiStats.keys().next().value);
  }
  // The open streams of the instances that reported within API_STATS_MAX_AGE_MS;
  // with none, the count is unknown and the baseline skips that minute.
  function readConnections() {
    let total = null;
    for (const stats of apiStats.values()) if (baselineNow() - stats.at <= API_STATS_MAX_AGE_MS) total = (total ?? 0) + stats.activeConnections;
    return total;
  }
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
  const overview = () => {
    // Use in-memory states cache directly; snapshot() handles lazy loading from DB
    return { projects: getProjects().map(snapshot), generatedAt: new Date().toISOString() };
  };
  function publish() {
    let event;
    for (const subscriber of subscribers) {
      if (!subscriber.wants()) continue;
      event ??= { revision: ++overviewRevision, overview: overview() };
      try { subscriber.deliver(event); } catch (error) { log.warn({ err: error, type: 'overview' }, '概览推送失败'); }
    }
  }
  const assetTargets = () => projects.all().filter(row => { const project = embeddedModules ? publicProject(row) : JSON.parse(row.json); return project?.enabled && project.adapter === 'asset'; }).map(row => ({ project: publicProject(row), credentials: embeddedModules ? null : decrypt(row.credentials), revision: projectRevision(row.id) }));
  const tradingImporter = createTradingImporter({ trading, request: tradingImportRequest, sourceTimeoutMs: tradingImportSourceTimeoutMs, importTimeoutMs: tradingImportTimeoutMs, listTargets: assetTargets });
  const assetPositions = createAssetPositions({ request: assetPositionsRequest, cacheMs: assetPositionsCacheMs, timeoutMs: assetPositionsTimeoutMs, now: assetPositionsNow, backgroundIntervalMs: assetPositionsBackgroundMs,
    listTargets: assetTargets,
  });
  // Background reads keep Asset's per-scope fills warm, so opening a chart serves fresh trades at once.
  const assetFillsByMarket = Object.fromEntries(Object.keys(FILL_MARKETS).map(market => [market, createAssetFills({ market, listTargets: assetTargets, request: assetFillsRequest,
    cacheMs: assetFillsCacheMs, timeoutMs: assetFillsTimeoutMs, now: assetFillsNow, backgroundIntervalMs: assetFillsBackgroundMs })]));
  const assetFills = {
    invalidate: id => { for (const source of Object.values(assetFillsByMarket)) source.invalidate(id); },
    close: () => Promise.all(Object.values(assetFillsByMarket).map(source => source.close())),
  };
  let assetSync = null;

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
        const latest = projects.get(id);
        if (!latest) return null;
        if (latest.json !== row.json || latest.credentials !== row.credentials) return snapshot(publicProject(latest));
        const value = { state: data.state || (data.stale ? 'stale' : data.partial ? 'partial' : 'online'), message: data.message, checkedAt, lastSuccessAt: new Date(Date.now()).toISOString(), updatedAt: data.updatedAt || null, latencyMs: Date.now() - start, metrics: data.metrics, ...(data.staleAfterSeconds ? { staleAfterSeconds: data.staleAfterSeconds } : {}), ...(data.freshness === 'static' ? { freshness: 'static' } : {}), ...(data.trend ? { trend: data.trend } : {}) };
        value.sourceState = value.state; value.sourceMessage = value.message;
        if (Array.isArray(data.diagnostics)) value.sourceDiagnostics = data.diagnostics.map(({ id, kind, message }) => ({ id, kind, message }));
        value.diagnostics = snapshotDiagnostics({ ...value, diagnostics: states.get(id)?.diagnostics || previous?.diagnostics }, project);
        stmt.prepare('INSERT INTO snapshots(id,json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(value)); states.set(id, value);
      } catch (error) {
        if (closed) return null;
        const latest = projects.get(id);
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
    })().finally(() => { pending.delete(id); controllers.delete(controller); if (!closed) publish(); });
    pending.set(id, run); return run;
  }

  // The API changed a project row or its module preferences; drop what was derived from the old value.
  function projectChanged(id, { reason, clearSnapshot = false }) {
    if (reason === 'created') { void check(id).catch(() => {}); if (assetSyncIntervalMs > 0) void assetSync.refresh(); return; }
    if (reason === 'preferences') assetFills.invalidate(id);
    else { assetPositions.invalidate(id); assetFills.invalidate(id); }
    // Captured before the check below, so a check that read the old row runs again afterwards.
    const inFlight = reason === 'updated' ? pending.get(id) : null;
    if (reason === 'updated' && clearSnapshot) stmt.prepare('DELETE FROM snapshots WHERE id=?').run(id);
    states.delete(id); publish(); if (assetSyncIntervalMs > 0) void assetSync.refresh();
    if (reason !== 'updated') return;
    if (inFlight) void inFlight.finally(() => { if (!closed && projects.exists(id)) void check(id).catch(() => {}); }).catch(() => {});
    else void check(id).catch(() => {});
  }

  async function coordinateAssetSync(projectId, revision) {
    if (closed || projectRevision(projectId) !== revision) return null;
    const status = await assetSync.run(projectId);
    return !closed && projectRevision(projectId) === revision ? status : null;
  }

  // A business route forwarded by the API. `target` is the path and query of
  // the browser request; `body` is read only where the route reads it.
  async function handle(request) {
    try { return await route(request); } catch (error) { return respond(error); }
  }
  async function route({ method, target, sessionId, contentType, body: stream }) {
    const url = new URL(target, 'http://runtime.internal');
    const pathname = url.pathname;
    const bodyOf = () => readJson(contentType, stream);
    const reply = (status, body) => ({ status, body });
    // The API checked the session; it may have ended while the request waited for admission.
    if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
    if (pathname === '/api/research/entropy-lighter' || pathname.startsWith('/api/research/entropy-lighter/')) {
      if (url.search) throw new HttpError(400, '研究接口不接受查询参数');
      if (pathname === '/api/research/entropy-lighter' && method === 'GET') return reply(200, research.state());
      if (pathname === '/api/research/entropy-lighter/report' && method === 'GET') return reply(200, { report: research.state().report });
      const action = pathname === '/api/research/entropy-lighter/config' && method === 'PUT' ? 'save'
        : pathname === '/api/research/entropy-lighter/start' && method === 'POST' ? 'start'
          : pathname === '/api/research/entropy-lighter/stop' && method === 'POST' ? 'stop' : null;
      if (!action) throw new HttpError(404, '研究接口不存在');
      const body = await bodyOf();
      const authorize = () => { if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录'); };
      authorize();
      if (action === 'save') {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'config')) throw new HttpError(400, '请提供研究配置');
        return reply(200, await research.save(body.config, authorize));
      }
      if (Object.keys(body).length) throw new HttpError(400, '启动和停止不接受额外参数');
      return reply(200, await research[action](authorize));
    }
    if (pathname === '/api/system/architecture' || pathname === '/api/system/metrics' || pathname === '/api/system/accounts' || pathname === '/api/system/recovery') {
      if (method !== 'GET') throw new HttpError(405, '基线接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '基线接口不接受查询参数');
      if (pathname === '/api/system/metrics') return reply(200, baseline.read());
      if (pathname === '/api/system/accounts') return reply(200, { schemaVersion: 1, enabled: !!sharedAccountWriter, ...(sharedAccountWriter?.snapshot() || { accounts: [], bindings: [], operations: [], isolations: [] }) });
      if (pathname === '/api/system/recovery') return reply(200, { schemaVersion: 1, enabled: !!sharedAccountWriter, recovery: sharedAccountWriter?.snapshot().recovery ?? null });
      const controller = new AbortController(); controllers.add(controller);
      try {
        const modules = await capabilities(controller.signal);
        if (closed || !sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
        return reply(200, { schemaVersion: 1, embeddedModules, modules, accountWriterVersion: sharedAccountWriter ? 1 : null, recoveryProtectionVersion: sharedAccountWriter?.recoveryProtectionVersion ?? null });
      } finally { controllers.delete(controller); }
    }
    if (pathname === '/api/trading/positions') {
      if (method !== 'GET') throw new HttpError(405, '仓位接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '仓位接口不接受查询参数');
      const data = await assetPositions.state();
      if (!sessions.isActive(sessionId)) throw new HttpError(401, '请先登录工作台');
      return reply(200, data);
    }
    if (pathname === '/api/trading/fills') {
      if (method !== 'GET') throw new HttpError(405, '成交接口仅支持只读查询');
      const market = url.search ? url.searchParams.get('market') : 'oil';
      if (url.search && ([...url.searchParams.keys()].join() !== 'market' || !Object.hasOwn(FILL_MARKETS, market))) throw new HttpError(400, '成交接口只接受 market 参数');
      const data = await assetFillsByMarket[market].state();
      if (!sessions.isActive(sessionId)) throw new HttpError(401, '请先登录工作台');
      return reply(200, data);
    }
    // The API admits the account, preview and start writes before forwarding
    // them (withExecutionEntry); here each one also holds an execution entry
    // against the durable maintenance flag. Stop and reconcile stay open.
    if (pathname === '/api/trading/execution' || pathname.startsWith('/api/trading/execution/')) {
      if (pathname === '/api/trading/execution' && method === 'GET') return reply(200, execution.state());
      const account = pathname.match(/^\/api\/trading\/execution\/accounts\/(binance|bybit|okx)$/);
      const entered = async operation => { const body = await bodyOf(); return executionEntries.run(() => operation(body)); };
      if (account && method === 'PUT') return reply(200, await entered(body => execution.connect(account[1], body, sessionId)));
      if (account && method === 'DELETE') return reply(200, await entered(body => execution.disconnect(account[1], body, sessionId)));
      if (pathname === '/api/trading/execution/preview' && method === 'POST') return reply(200, await entered(body => execution.preview(body, sessionId)));
      if (pathname === '/api/trading/execution/jobs' && method === 'POST') return reply(202, await entered(body => execution.start(body, sessionId)));
      const job = pathname.match(/^\/api\/trading\/execution\/jobs\/([0-9a-f-]{36})\/(stop|reconcile)$/);
      if (job && method === 'POST') { const body = await bodyOf(); return reply(200, job[2] === 'stop' ? execution.stop(job[1], body, sessionId) : await execution.reconcile(job[1], body, sessionId)); }
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
      if (pathname === '/api/trading' && method === 'GET') return reply(200, trading.state(days, { page, pair }));
      if (pathname === '/api/trading/import-sources' && method === 'GET') return reply(200, await tradingImporter.sources());
      const importedAccount = pathname.match(/^\/api\/trading\/accounts\/(binance|bybit|okx)\/import$/);
      if (importedAccount && method === 'POST') { await tradingImporter.importAccount(importedAccount[1], await bodyOf()); return reply(202, trading.state(days, { page, pair })); }
      if (pathname === '/api/trading/refresh' && method === 'POST') { await bodyOf(); void trading.refresh({ force: true }); return reply(202, trading.state(days, { page, pair })); }
      const account = pathname.match(/^\/api\/trading\/accounts\/(binance|bybit|okx)$/);
      if (account && method === 'PUT') { await trading.connect(account[1], await bodyOf()); return reply(202, trading.state(days, { page, pair })); }
      if (account && method === 'DELETE') { const body = await bodyOf(); trading.disconnect(account[1], body.revision); return reply(200, trading.state(days, { page, pair })); }
      throw new HttpError(404, '交易模块仅提供只读查询和账户连接管理');
    }
    const project = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/(check|sync)$/);
    if (project && method === 'POST') {
      const id = project[1]; const row = rowFor(id);
      if (project[2] === 'check') return reply(200, { snapshot: await check(id) });
      const value = publicProject(row);
      if (value.adapter !== 'asset' || !value.enabled || !value.autoSync) throw new HttpError(400, '请先启用资产后台同步');
      void assetSync.run(id).catch(() => {}); return reply(202, { sync: assetSync.getStatus(id) });
    }
    throw new HttpError(404, '接口不存在');
  }

  assetSync = createAssetSync({
    listTargets: () => projects.all().filter(row => !embeddedModules || moduleIds.includes(row.id)).map(row => ({ project: publicProject(row), credentials: embeddedModules ? null : decrypt(row.credentials), revision: projectRevision(row.id) })),
    intervalMs: assetSyncIntervalMs > 0 ? assetSyncIntervalMs : 60000,
    autoStart: assetSyncIntervalMs > 0, syncReader: assetSyncReader,
    onComplete: async (id, revision, status) => { if (!closed && projectRevision(id) === revision && ['success', 'partial'].includes(status.state)) await check(id); },
  });
  async function refresh(dueOnly = false) { await Promise.allSettled(getProjects().filter(project => {
    if (!project.enabled || !project.apiUrl || project.adapter === 'link') return false;
    if (!dueOnly) return true;
    const state = states.get(project.id);
    // Share the summary schedule so faster refreshes already keep the app warm.
    const warmupPeriod = warmup.enabled && warmup.projectIds.has(project.id) ? warmup.intervalMs : Infinity;
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
  // Recomputes the projection, so freshness changes reach subscribers without a new check.
  const heartbeat = setInterval(publish, 15000); heartbeat.unref();
  const first = refreshInterval > 0 ? setTimeout(() => { if (!closed) void refresh(); }, 100) : null; first?.unref();

  function stop() { closed = true; clearInterval(interval); clearInterval(heartbeat); clearTimeout(first); }
  return {
    trading, execution, assetSync, check, refresh, overview, projectChanged, coordinateAssetSync, handle,
    get baseline() { return baseline; },
    subscribeOverview(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    // The first event of a new socket subscriber; revisions stay monotonic across subscribers.
    overviewEvent: () => ({ revision: ++overviewRevision, overview: overview() }),
    reportApiStats,
    initialize: async () => { executionEntries.clear(); await execution.initializeProtection(); await research.initialize(); },
    startBaseline() {
      baseline = createBaseline({ db, intervalMs: baselineIntervalMs, now: baselineNow, logger: log, readCapabilities: capabilities,
        readSnapshot: () => ({ accountWriterVersion: embeddedModules && sharedAccountWriter ? 1 : null, sseConnections: readConnections(), projects: getProjects().map(project => ({ project,
          snapshot: states.get(project.id) || (() => { const saved = stmt.prepare('SELECT json FROM snapshots WHERE id=?').get(project.id); return saved ? JSON.parse(saved.json) : null; })(),
        })) }),
      });
      if (slowConsumers) { baseline.observeSlowConsumer(slowConsumers); slowConsumers = 0; }
      baseline.start();
    },
    // stop() ends the timers at once; close() then releases every service.
    stop,
    async close() { stop(); subscribers.clear(); await research.close(); await baseline?.close(); await execution.close(); sharedAccountWriter?.close(); await tradingImporter.close(); await assetPositions.close(); await assetFills.close(); await trading.close(); await assetSync.close(); for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending.values()]); },
  };
}

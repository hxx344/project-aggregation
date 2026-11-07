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
import { createTradingAuto } from '../trading-auto.mjs';
import { createAnthropicWatch } from '../trading-anthropic-watch.mjs';
import { createAnthropicReduction } from '../trading-anthropic-reduction.mjs';
import { createAnthropicHistory } from '../trading-anthropic-history.mjs';
import { createFillAttribution } from '../trading-fill-attribution.mjs';
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
import { createBinanceLighterCost } from '../research/binance-lighter-cost.mjs';
import { createAeroMarket } from '../research/aero-market.mjs';
import { createAeroSafe } from '../automation/aero-safe.mjs';
import { createFeishuDigest } from '../automation/feishu-digest.mjs';
import { createEventLoopLag } from './event-loop-lag.mjs';
import { collectSections } from '../automation/feishu-digest-sources.mjs';

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
  aeroMarketEnabledByDefault = embeddedModules && process.env.NODE_ENV !== 'test' && process.env.AERO_MARKET_SCAN !== 'false',
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
  const costResearch = createBinanceLighterCost({ dataDir, log });
  // 只读链上行情；测试、非内置实例与 AERO_MARKET_SCAN=false 时默认不扫描，避免启动即访问公共 RPC；页面保存的配置优先。
  const aeroMarket = createAeroMarket({ dataDir, enabledByDefault: aeroMarketEnabledByDefault, log });
  // Aero 实盘：bot 经 Safe 的 Roles 模块执行，受维护与隔离恢复闸门约束。
  const aeroSafe = createAeroSafe({ dataDir, encrypt, decrypt, readMaintenance: () => control.getSetting('updates-maintenance') === '1',
    readAdmission: () => !sharedAccountWriter || sharedAccountWriter.snapshot().recovery?.state === 'normal', readPrices: () => aeroMarket.tokenPrices(), log });
  const trading = createTrading({ db, stmt, encrypt, decrypt, clientFactory: tradingClientFactory, intervalMs: tradingRefreshIntervalMs, now: tradingNow, taskTimeoutMs: tradingTaskTimeoutMs, logger: log });
  const writerDatabase = path.join(dataDir, 'execution-control.sqlite');
  // A legacy external-module launch must not turn off protection for data that
  // already belongs to a managed or recovered authority.
  const sharedAccountWriter = accountWriter || (embeddedModules || existsSync(writerDatabase) || existsSync(`${writerDatabase}.required`) ? createAccountWriter({ databasePath: writerDatabase, runtimeId: randomUUID(), moduleId: 'hub' }) : null);
  const execution = createTradingExecution({ db, stmt, encrypt, decrypt, clientFactory: executionClientFactory, intervalMs: executionIntervalMs, now: executionNow, accountWriter: sharedAccountWriter, isSessionActive: sessions.isActive });
  const anthropicHistory = createAnthropicHistory({ execution, now: executionNow });
  const attributeFills = createFillAttribution({ db, stmt });
  const executionEntries = createExecutionEntries({ db, log, readMaintenance: () => control.getSetting('updates-maintenance') === '1', refuse: () => { throw new UpdateError(409, EXECUTION_MAINTENANCE); } });
  // Automatic rules create jobs through the same maintenance entry as a manual start.
  const executionAuto = createTradingAuto({ db, execution, admit: operation => executionEntries.run(operation), readMaintenance: () => control.getSetting('updates-maintenance') === '1', now: executionNow, intervalMs: executionIntervalMs > 0 ? 2000 : 0, log });
  const anthropicReduction = createAnthropicReduction({ db, execution, admit: operation => executionEntries.run(operation), readMaintenance: () => control.getSetting('updates-maintenance') === '1', now: executionNow, intervalMs: executionIntervalMs > 0 ? 15_000 : 0, log });
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
  const feishuDigest = createFeishuDigest({ dataDir, encrypt, decrypt, log, readSections: () => collectSections({ overview, log,
    positions: () => assetPositions.state(), funding: () => trading.state(7), execution: () => execution.state(), research: () => research.state() }) });
  // Anthropic legs: read-only Binance/OKX accounts plus the live Hyperliquid connection's public positions.
  const anthropicWatch = createAnthropicWatch({ dataDir, log, feishu: feishuDigest, encrypt, decrypt, intervalMs: tradingRefreshIntervalMs > 0 ? 30_000 : 0, readCex: () => trading.anthropic(),
    readAddress: exchange => { const row = execution.state().connections.find(item => item.exchange === exchange); return row?.connected && typeof row.identity === 'string' ? row.identity.toLowerCase() : null; } });
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
  async function route({ method, target, sessionId, contentType, deadline, body: stream }) {
    const url = new URL(target, 'http://runtime.internal');
    const pathname = url.pathname;
    const bodyOf = () => readJson(contentType, stream);
    const reply = (status, body) => ({ status, body });
    // The API checked the session; it may have ended while the request waited for admission.
    if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
    if (pathname === '/api/research/binance-lighter-cost' || pathname.startsWith('/api/research/binance-lighter-cost/')) {
      if (url.search) throw new HttpError(400, '成本研究接口不接受查询参数');
      const base = '/api/research/binance-lighter-cost';
      if (pathname === base && method === 'GET') return reply(200, costResearch.state());
      if (pathname === `${base}/report` && method === 'GET') return reply(200, costResearch.report());
      const scenario = pathname.match(/^\/api\/research\/binance-lighter-cost\/scenario\/([0-9a-f-]{36})\/((?:BTC|ETH)-inventory-\d{3,5})$/);
      if (scenario && method === 'GET') return reply(200, costResearch.scenario(scenario[1], scenario[2]));
      const archive = pathname.match(/^\/api\/research\/binance-lighter-cost\/report\/([0-9a-f-]{36})$/);
      if (archive && method === 'GET') return reply(200, costResearch.report(archive[1]));
      const action = pathname === `${base}/config` && method === 'PUT' ? 'save'
        : pathname === `${base}/start` && method === 'POST' ? 'start'
          : pathname === `${base}/stop` && method === 'POST' ? 'stop'
            : pathname === `${base}/archive` && method === 'POST' ? 'archive' : null;
      if (!action) throw new HttpError(404, '成本研究接口不存在');
      const body = await bodyOf();
      const authorize = () => { if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录'); };
      authorize();
      if (action === 'save') {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'config')) throw new HttpError(400, '请提供研究配置');
        return reply(200, await costResearch.save(body.config, authorize));
      }
      if (Object.keys(body).length) throw new HttpError(400, '研究控制操作不接受额外参数');
      return reply(200, await costResearch[action](authorize));
    }
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
    if (pathname === '/api/research/aero-market' || pathname.startsWith('/api/research/aero-market/')) {
      if (pathname === '/api/research/aero-market' && method === 'GET') {
        const keys = [...url.searchParams.keys()];
        const raw = url.searchParams.get('revision');
        if (keys.some((k) => k !== 'revision') || keys.length > 1 || (raw !== null && !/^\d{1,12}$/.test(raw))) throw new HttpError(400, '市场接口只接受 revision 参数');
        return reply(200, aeroMarket.state(raw === null ? {} : { since: Number(raw) }));
      }
      if (pathname === '/api/research/aero-market/pool' && method === 'GET') {
        const keys = [...url.searchParams.keys()].sort().join(',');
        if (keys !== 'address,chain') throw new HttpError(400, '请提供 chain 与 address');
        return reply(200, aeroMarket.pool(url.searchParams.get('chain'), url.searchParams.get('address')));
      }
      if (pathname === '/api/research/aero-market/samples' && method === 'GET') {
        const keys = [...url.searchParams.keys()], tag = url.searchParams.get('tag');
        if (keys.filter((k) => k === 'window').length !== 1 || keys.some((k) => k !== 'window' && k !== 'tag') || keys.filter((k) => k === 'tag').length > 1
          || (tag !== null && (!tag || tag.length > 200))) throw new HttpError(400, '请提供 window，可选一个 tag');
        return reply(200, aeroMarket.samples(url.searchParams.get('window'), tag));
      }
      if (pathname === '/api/research/aero-market/liquidity' && method === 'GET') {
        const keys = [...url.searchParams.keys()].sort().join(',');
        if (keys !== 'address,chain') throw new HttpError(400, '请提供 chain 与 address');
        return reply(200, await aeroMarket.liquidity(url.searchParams.get('chain'), url.searchParams.get('address')));
      }
      if (url.search) throw new HttpError(400, '市场接口不接受查询参数');
      const action = pathname === '/api/research/aero-market/config' && method === 'PUT' ? 'save'
        : pathname === '/api/research/aero-market/refresh' && method === 'POST' ? 'refresh'
          : pathname === '/api/research/aero-market/favorites' && method === 'PUT' ? 'favorites'
            : pathname === '/api/research/aero-market/replay' && method === 'POST' ? 'replay' : null;
      if (!action) throw new HttpError(404, '市场接口不存在');
      const body = await bodyOf();
      const authorize = () => { if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录'); };
      authorize();
      if (action === 'save') {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'config')) throw new HttpError(400, '请提供扫描配置');
        return reply(200, await aeroMarket.save(body.config, authorize));
      }
      if (action === 'replay') return reply(200, await aeroMarket.replay(body));
      if (action === 'favorites') {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'favorites')) throw new HttpError(400, '请提供收藏列表');
        return reply(200, await aeroMarket.saveFavorites(body.favorites, authorize));
      }
      if (Object.keys(body).length) throw new HttpError(400, '刷新不接受额外参数');
      return reply(200, aeroMarket.refresh(authorize));
    }
    if (pathname === '/api/automation/aero-safe' || pathname.startsWith('/api/automation/aero-safe/')) {
      if (url.search) throw new HttpError(400, 'Aero 实盘接口不接受查询参数');
      if (pathname === '/api/automation/aero-safe' && method === 'GET') return reply(200, aeroSafe.state());
      const routes = { 'PUT /config': 'save', 'PUT /wallet': 'setKey', 'POST /wallet/clear': 'clearKey', 'POST /refresh': 'refresh', 'POST /preview': 'preview', 'POST /execute': 'execute', 'PUT /auto': 'setAuto', 'PUT /policy': 'setPolicy', 'POST /auto/discard': 'discardAuto',
        'POST /changes/pool': 'addPoolChange', 'POST /changes/allowances': 'setAllowanceChanges', 'POST /changes/remove': 'removePoolChange',
        'POST /changes/batch': 'buildChangeBatch', 'POST /changes/apply': 'applyChangeBatch', 'POST /changes/clear': 'clearChanges' };
      const action = routes[`${method} ${pathname.slice('/api/automation/aero-safe'.length)}`];
      if (!action) throw new HttpError(404, 'Aero 实盘接口不存在');
      const body = await bodyOf();
      const authorize = () => { if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录'); };
      authorize();
      const only = (...keys) => { if (Object.keys(body).some((key) => !keys.includes(key))) throw new HttpError(400, '请求包含未知字段'); };
      if (action === 'save') { only('config'); return reply(200, await aeroSafe.save(body.config, authorize, { deadline })); }
      if (action === 'setKey') { only('privateKey'); return reply(200, await aeroSafe.setKey(body.privateKey, authorize, { deadline })); }
      if (action === 'preview') { only('params'); return reply(200, await aeroSafe.preview(body.params, authorize, { deadline })); }
      if (action === 'execute') { only('action', 'params'); return reply(200, await aeroSafe.execute(body.action, body.params, authorize, { deadline })); }
      if (action === 'setAuto') { only('auto'); return reply(200, await aeroSafe.setAuto(body.auto, authorize, { deadline })); }
      if (action === 'setPolicy') { only('policy'); return reply(200, await aeroSafe.setPolicy(body.policy, authorize, { deadline })); }
      if (action === 'addPoolChange') { only('pool', 'allowances'); return reply(200, await aeroSafe.addPoolChange(body, authorize, { deadline })); }
      if (action === 'setAllowanceChanges') { only('allowances'); return reply(200, await aeroSafe.setAllowanceChanges(body.allowances, authorize, { deadline })); }
      if (action === 'removePoolChange') { only('pool'); return reply(200, await aeroSafe.removePoolChange(body, authorize, { deadline })); }
      if (Object.keys(body).length) throw new HttpError(400, '该操作不接受额外参数');
      return reply(200, await aeroSafe[action](authorize, { deadline }));
    }
    if (pathname === '/api/automation/feishu-digest' || pathname.startsWith('/api/automation/feishu-digest/')) {
      if (url.search) throw new HttpError(400, '汇总接口不接受查询参数');
      if (pathname === '/api/automation/feishu-digest' && method === 'GET') return reply(200, feishuDigest.state());
      const action = pathname === '/api/automation/feishu-digest/config' && method === 'PUT' ? 'save'
        : pathname === '/api/automation/feishu-digest/channel' && method === 'PUT' ? 'setChannel'
          : pathname === '/api/automation/feishu-digest/channel/clear' && method === 'POST' ? 'clearChannel'
            : pathname === '/api/automation/feishu-digest/preview' && method === 'POST' ? 'preview'
              : pathname === '/api/automation/feishu-digest/send' && method === 'POST' ? 'send' : null;
      if (!action) throw new HttpError(404, '汇总接口不存在');
      const body = await bodyOf();
      if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
      if (action === 'save' || action === 'preview') {
        const { config, ...rest } = body, fresh = action === 'preview' && rest.fresh === true;
        if (config === undefined || Object.keys(rest).length !== (fresh ? 1 : 0)) throw new HttpError(400, '请提供汇总配置');
        return reply(200, await feishuDigest[action](config, { fresh }));
      }
      if (action === 'setChannel') return reply(200, feishuDigest.setChannel(body));
      if (Object.keys(body).length) throw new HttpError(400, '该操作不接受额外参数');
      return reply(200, await feishuDigest[action]());
    }
    if (pathname === '/api/system/architecture' || pathname === '/api/system/metrics' || pathname === '/api/system/accounts' || pathname === '/api/system/recovery' || pathname === '/api/system/event-loop') {
      if (method !== 'GET') throw new HttpError(405, '基线接口仅支持只读查询');
      if (url.search) throw new HttpError(400, '基线接口不接受查询参数');
      if (pathname === '/api/system/metrics') return reply(200, baseline.read());
      if (pathname === '/api/system/event-loop') return reply(200, eventLoop.read());
      if (pathname === '/api/system/accounts') return reply(200, { schemaVersion: 1, enabled: !!sharedAccountWriter, ...(sharedAccountWriter?.snapshot() || { accounts: [], bindings: [], operations: [], isolations: [] }) });
      if (pathname === '/api/system/recovery') return reply(200, { schemaVersion: 1, enabled: !!sharedAccountWriter, recovery: sharedAccountWriter?.snapshot().recovery ?? null });
      const controller = new AbortController(); controllers.add(controller);
      try {
        const modules = await capabilities(controller.signal);
        if (closed || !sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
        return reply(200, { schemaVersion: 1, embeddedModules, modules, accountWriterVersion: sharedAccountWriter ? 1 : null, recoveryProtectionVersion: sharedAccountWriter?.recoveryProtectionVersion ?? null });
      } finally { controllers.delete(controller); }
    }
    if (pathname === '/api/trading/anthropic' || pathname.startsWith('/api/trading/anthropic/')) {
      if (url.search) throw new HttpError(400, 'Anthropic 仓位接口不接受查询参数');
      if (pathname === '/api/trading/anthropic' && method === 'GET') return reply(200, anthropicWatch.state());
      const action = pathname === '/api/trading/anthropic/alerts' && method === 'PUT' ? 'save' : pathname === '/api/trading/anthropic/alerts/test' && method === 'POST' ? 'test'
        : pathname === '/api/trading/anthropic/alerts/channel' && method === 'PUT' ? 'channel' : pathname === '/api/trading/anthropic/alerts/channel/clear' && method === 'POST' ? 'clear' : null;
      if (!action) throw new HttpError(404, 'Anthropic 仓位接口不存在');
      const body = await bodyOf();
      if (!sessions.isActive(sessionId)) throw new HttpError(401, '登录已失效，请重新登录');
      if (action === 'save') {
        if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'config')) throw new HttpError(400, '请提供预警设置');
        return reply(200, anthropicWatch.save(body.config));
      }
      if (action === 'channel') return reply(200, anthropicWatch.setChannel(body));
      if (Object.keys(body).length) throw new HttpError(400, '该操作不接受额外参数');
      if (action === 'clear') return reply(200, anthropicWatch.clearChannel());
      return reply(200, await anthropicWatch.test());
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
      let data = await assetFillsByMarket[market].state();
      if (market === 'anthropic') {
        const native = anthropicHistory.state();
        data.sources.push(native.source);
        data.pending = !!data.pending || native.pending;
        data = attributeFills(data, native.source, execution.historyConnections());
      }
      if (!sessions.isActive(sessionId)) throw new HttpError(401, '请先登录工作台');
      return reply(200, data);
    }
    // The API admits the account, preview and start writes before forwarding
    // them (withExecutionEntry); here each one also holds an execution entry
    // against the durable maintenance flag. Stop and reconcile stay open.
    if (pathname === '/api/trading/execution' || pathname.startsWith('/api/trading/execution/')) {
      if (pathname === '/api/trading/execution' && method === 'GET') {
        if (url.search && [...url.searchParams.keys()].join() !== 'jobId') throw new HttpError(400, '执行状态只接受一个 jobId 参数');
        return reply(200, execution.state(url.searchParams.get('jobId')));
      }
      if (pathname === '/api/trading/execution/quotes' && method === 'GET') {
        if (url.search) throw new HttpError(400, '行情接口不接受查询参数');
        const data = await execution.quotes();
        if (!sessions.isActive(sessionId)) throw new HttpError(401, '请先登录工作台');
        return reply(200, data);
      }
      if (pathname === '/api/trading/execution/auto' && method === 'GET') return reply(200, executionAuto.state());
      // A logout while the body was arriving must not save or enable a rule.
      const signedBody = async () => { const body = await bodyOf(); if (!sessions.isActive(sessionId)) throw new HttpError(401, '请先登录工作台'); return body; };
      if (pathname === '/api/trading/execution/anthropic-reduction' || pathname === '/api/trading/execution/anthropic-reduction/disable') {
        if (url.search) throw new HttpError(400, '自动减仓接口不接受查询参数');
        if (pathname.endsWith('/disable') && method === 'POST') return reply(200, anthropicReduction.disable(await signedBody()));
        if (!pathname.endsWith('/disable') && method === 'GET') return reply(200, anthropicReduction.state());
        if (!pathname.endsWith('/disable') && method === 'PUT') return reply(200, anthropicReduction.save(await signedBody()));
        throw new HttpError(405, '自动减仓接口不支持此操作');
      }
      if (pathname === '/api/trading/execution/auto/rules' && method === 'POST') return reply(201, executionAuto.create(await signedBody()));
      const autoRule = pathname.match(/^\/api\/trading\/execution\/auto\/rules\/([0-9a-f-]{36})(?:\/(enable|disable|reset))?$/);
      if (autoRule && !autoRule[2] && method === 'PUT') return reply(200, executionAuto.update(autoRule[1], await signedBody()));
      if (autoRule && !autoRule[2] && method === 'DELETE') return reply(200, executionAuto.remove(autoRule[1], await signedBody()));
      if (autoRule && autoRule[2] && method === 'POST') return reply(200, executionAuto.act(autoRule[1], autoRule[2], await signedBody()));
      const account = pathname.match(/^\/api\/trading\/execution\/accounts\/(binance|bybit|okx|hyperliquid|rh-lighter)$/);
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
  // All collectors, WS feeds and research share this process's single thread.
  const eventLoop = createEventLoopLag(); eventLoop.start();

  function stop() { closed = true; clearInterval(interval); clearInterval(heartbeat); clearTimeout(first); eventLoop.stop(); executionAuto.stop(); anthropicReduction.stop(); anthropicHistory.stop(); }
  return {
    trading, execution, assetSync, check, refresh, overview, projectChanged, coordinateAssetSync, handle,
    get baseline() { return baseline; },
    subscribeOverview(subscriber) { subscribers.add(subscriber); return () => subscribers.delete(subscriber); },
    // The first event of a new socket subscriber; revisions stay monotonic across subscribers.
    overviewEvent: () => ({ revision: ++overviewRevision, overview: overview() }),
    reportApiStats,
    prepareStop: async () => { await aeroSafe.prepareStop(); },
    initialize: async () => { executionEntries.clear(); await execution.initializeProtection(); await research.initialize(); await costResearch.initialize(); await aeroMarket.initialize(); await aeroSafe.initialize(); feishuDigest.initialize(); anthropicWatch.initialize(); },
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
    async close() { stop(); subscribers.clear(); await anthropicHistory.close(); await anthropicReduction.close(); await anthropicWatch.close(); await feishuDigest.close(); await research.close(); await costResearch.close(); await aeroMarket.close(); await aeroSafe.close(); await baseline?.close(); await executionAuto.close(); await execution.close(); sharedAccountWriter?.close(); await tradingImporter.close(); await assetPositions.close(); await assetFills.close(); await trading.close(); await assetSync.close(); for (const controller of controllers) controller.abort(); await Promise.allSettled([...pending.values()]); },
  };
}

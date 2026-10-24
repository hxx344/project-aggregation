import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAuthOrigin, readSummary, requestJson } from './adapters.mjs';
import { syncAsset } from './asset-sync.mjs';
import { ASSET_FILLS_BACKGROUND_MS } from './asset-fills.mjs';
import { createModuleUpdateGuard } from './modules/updates.mjs';
import { createRuntimeService } from './runtime/service.mjs';
import { createInProcessClient } from './runtime/supervisor-client.mjs';
import { createInProcessDataClient } from './runtime/data-client.mjs';
import { createDataPlane, resolveWarmup } from './runtime/data-plane.mjs';
import { createApiServer, resolveLoginLimits } from './api/server.mjs';
import { BASELINE_INTERVAL_MS, validateBaselineInterval } from './observability.mjs';
import { assertRecoveryStartup } from './recovery/startup.mjs';
import { openHubDatabase, seedProjects } from './control/schema.mjs';
import { createControlStore } from './control/store.mjs';
import { createProjectCatalog } from './control/projects.mjs';
import { ensurePassword } from './control/password.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp({ embeddedModules = false, dataDir = process.env.DATA_DIR || path.join(root, '.data'), initialPassword = process.env.INITIAL_PASSWORD, refreshInterval = 30000, timeoutMs = 5000, loginWindowMs, accountLockoutMs, summaryReader = readSummary, assetSyncIntervalMs = 60000, assetSyncReader = syncAsset, assetPositionsRequest, assetPositionsCacheMs, assetPositionsTimeoutMs, assetPositionsNow, assetFillsRequest, assetFillsCacheMs, assetFillsTimeoutMs, assetFillsNow, assetPositionsBackgroundMs = assetSyncIntervalMs > 0 ? 30000 : 0, assetFillsBackgroundMs = assetSyncIntervalMs > 0 ? ASSET_FILLS_BACKGROUND_MS : 0, tradingClientFactory, tradingRefreshIntervalMs = 1000, tradingNow = Date.now, tradingTaskTimeoutMs = 60000, tradingImportRequest, tradingImportSourceTimeoutMs, tradingImportTimeoutMs, executionClientFactory, executionIntervalMs = 1000, executionNow = Date.now, updatesClient, logger = console, secureCookies = process.env.COOKIE_SECURE === 'true', publicOrigin = process.env.PUBLIC_ORIGIN || '', distDir = path.join(root, 'dist'), warmupEnabled, warmupProjects, warmupIntervalMs, baselineIntervalMs = BASELINE_INTERVAL_MS, baselineNow = Date.now, capabilitiesRequest = requestJson, accountWriter = null, moduleRuntime = null } = {}) {
  validateBaselineInterval(baselineIntervalMs);
  const warmup = resolveWarmup({ warmupEnabled, warmupProjects, warmupIntervalMs });
  const loginLimits = resolveLoginLimits({ loginWindowMs, accountLockoutMs });
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
  const db = openHubDatabase(dbPath);
  const control = createControlStore(db);
  const { getSetting } = control;
  log.info({ dbPath, type: 'startup' }, '数据库初始化完成');
  try { await ensurePassword(control, { initialPassword, log }); seedProjects(control, { embeddedModules }); }
  catch (error) { db.close(); throw error; }
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); };
  const decrypt = value => { if (!value) return null; const buffer = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); cipher.setAuthTag(buffer.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString()); };

  const catalog = createProjectCatalog({ control, embeddedModules, decrypt });
  const readMaintenance = () => getSetting('updates-maintenance') === '1';
  // The API and the data plane share this process and talk only through these
  // clients; the separated entries use socket clients against the same contracts.
  const supervisor = createInProcessClient(createRuntimeService({ moduleRuntime, guard: embeddedModules ? createModuleUpdateGuard() : null, readMaintenance }));
  let api = null;
  const dataPlane = createDataPlane({ db, control, catalog, encrypt, decrypt, embeddedModules, dataDir: resolvedData, log, accountWriter, readConnections: () => api?.streamCount() ?? 0,
    refreshInterval, timeoutMs, summaryReader, assetSyncIntervalMs, assetSyncReader,
    assetPositionsRequest, assetPositionsCacheMs, assetPositionsTimeoutMs, assetPositionsNow, assetFillsRequest, assetFillsCacheMs, assetFillsTimeoutMs, assetFillsNow, assetPositionsBackgroundMs, assetFillsBackgroundMs,
    tradingClientFactory, tradingRefreshIntervalMs, tradingNow, tradingTaskTimeoutMs, tradingImportRequest, tradingImportSourceTimeoutMs, tradingImportTimeoutMs,
    executionClientFactory, executionIntervalMs, executionNow,
    warmup, baselineIntervalMs, baselineNow, capabilitiesRequest });
  api = createApiServer({ control, catalog, encrypt, decrypt, embeddedModules, log, supervisor, runtime: createInProcessDataClient(dataPlane, { log }), executionJobs: dataPlane.execution, readMaintenance,
    updatesClient, secureCookies, configuredOrigin, distDir, loginLimits });
  await dataPlane.initialize();
  await api.initialize();
  dataPlane.startBaseline();
  const { trading, execution, assetSync, check, refresh } = dataPlane;
  return {
    server: api.server, check, refresh, assetSync, trading, execution, baseline: dataPlane.baseline, dataDir: resolvedData, resynchronizeModules: api.updates.resynchronize,
    resetPassword: api.resetPassword,
    async close() { dataPlane.stop(); await api.close(); await dataPlane.close(); await api.closeServer(); db.close(); },
  };
}

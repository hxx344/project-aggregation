// Public-market paper research owned by the workbench runtime. No credentials,
// signing clients or private exchange endpoints enter this service.
import { existsSync, lstatSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-common.mjs';
import { CostLabEngine, DEFAULT_COST_CONFIG, validateCostConfig } from './binance-lighter-core.mjs';
import { discoverCostMarkets, startCostFeeds } from './binance-lighter-feeds.mjs';

const LIMIT = 8 * 1024 * 1024;
const MAX_ARCHIVES = 50;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
// JSON string escaping can expand a source byte into six bytes. Preserve the
// original UTF-8 text of the three bounded files without nesting later backups.
const MIGRATION_BACKUP_LIMIT = 6 * (LIMIT + 128 * 1024) + 4096;
const MIGRATION_FILES = { 'config-v2.json': 64 * 1024, 'session-v2.json': LIMIT, 'archives-v2.json': 64 * 1024 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXECUTION = Object.freeze({ mode: 'paper', liveAvailable: false, version: 2 });
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const nonzero = value => finite(value) && value !== 0;
const SCENARIO = /^(BTC|ETH)-inventory-\d{3,5}$/;
const LEGACY_FIELDS = ['schema', 'symbols', 'notionalPerLeg', 'latencyScenarios', 'makerWaitMs', 'holdMs', 'hedgeWaitMs',
  'cooldownMs', 'maxBookAgeMs', 'maxSourceAgeMs', 'maxPairSkewMs', 'maxHedgeSlippageBps', 'queueMultiplier',
  'binanceMakerFeeBps', 'lighterTakerFeeBps', 'fundingCostBpsPerHour'];

function legacyConfig(value) {
  if (!object(value) || value.schema !== 1 || Object.keys(value).length !== LEGACY_FIELDS.length
    || Object.keys(value).some(key => !LEGACY_FIELDS.includes(key))
    || !Array.isArray(value.symbols) || !value.symbols.length || value.symbols.length > 2
    || new Set(value.symbols).size !== value.symbols.length || value.symbols.some(symbol => !['BTC', 'ETH'].includes(symbol))
    || !Array.isArray(value.latencyScenarios) || !value.latencyScenarios.length || value.latencyScenarios.length > 3
    || new Set(value.latencyScenarios).size !== value.latencyScenarios.length
    || value.latencyScenarios.some(ms => !Number.isInteger(ms) || ms < 300 || ms > 10000)) throw new Error('invalid_legacy_config');
  for (const [name, low, high, integer] of [
    ['notionalPerLeg', 10, 100000], ['makerWaitMs', 1000, 120000, true], ['holdMs', 0, 3600000, true],
    ['hedgeWaitMs', 100, 10000, true], ['cooldownMs', 0, 60000, true], ['maxBookAgeMs', 100, 5000, true],
    ['maxSourceAgeMs', 100, 10000, true], ['maxPairSkewMs', 0, 5000, true], ['maxHedgeSlippageBps', 0, 100],
    ['queueMultiplier', 1, 10], ['binanceMakerFeeBps', 0, 100], ['lighterTakerFeeBps', 0, 100],
  ]) if (!finite(value[name]) || value[name] < low || value[name] > high || integer && !Number.isInteger(value[name])) throw new Error('invalid_legacy_config');
  if (value.fundingCostBpsPerHour !== null && (!finite(value.fundingCostBpsPerHour) || Math.abs(value.fundingCostBpsPerHour) > 100)) throw new Error('invalid_legacy_config');
  return value;
}
function migrateConfig(value) {
  legacyConfig(value);
  const next = clone(DEFAULT_COST_CONFIG);
  for (const key of LEGACY_FIELDS) if (key !== 'schema' && Object.hasOwn(next, key)) next[key] = clone(value[key]);
  next.orderNotional = value.notionalPerLeg;
  next.symbols = ['BTC'];
  // An old order larger than the new default limit remains a valid bounded order.
  next.maxInventoryNotional = Math.max(next.maxInventoryNotional, next.orderNotional);
  return validateCostConfig(next);
}

function historicalConfig(value) {
  // Historical v2 reports keep their original symbols and immediate-hedge
  // assumptions. Only this read adapter accepts the old exact field shape.
  const fields = Object.keys(DEFAULT_COST_CONFIG).filter(key => key !== 'hedgeThresholdNotional');
  const hasThreshold = object(value) && Object.hasOwn(value, 'hedgeThresholdNotional');
  if (!object(value) || Object.keys(value).length !== fields.length + Number(hasThreshold)
    || Object.keys(value).some(key => !fields.includes(key) && key !== 'hedgeThresholdNotional')
    || !Array.isArray(value.symbols) || !value.symbols.length || value.symbols.length > 2
    || new Set(value.symbols).size !== value.symbols.length || value.symbols.some(symbol => !['BTC', 'ETH'].includes(symbol))) {
    throw new Error('invalid_historical_config');
  }
  // Reuse the numeric contract without changing the stored historical config.
  validateCostConfig({ ...value, symbols: ['BTC'], hedgeThresholdNotional: hasThreshold ? value.hedgeThresholdNotional : 0 });
  return value;
}
function migrateV2Config(value) {
  historicalConfig(value);
  return validateCostConfig({ ...value, symbols: ['BTC'],
    hedgeThresholdNotional: Object.hasOwn(value, 'hedgeThresholdNotional') ? value.hedgeThresholdNotional : Math.min(1000, value.maxUnhedgedNotional) });
}

function regular(file, limit) {
  let info;
  try { info = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid_research_file');
  return info;
}
function read(file, limit = LIMIT) {
  return regular(file, limit) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}
function atomic(file, value, limit = LIMIT) {
  regular(file, limit);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > limit) throw new Error('research_storage_limit');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
// Same file contract as atomic(), split for the running session's snapshots:
// the slow write + fsync run on the libuv pool so the feeds keep flowing, and
// the caller decides on the main thread whether to rename. A synchronous
// atomic() write made meanwhile is newer and the staged file is discarded.
async function stageAtomic(file, value, limit = LIMIT) {
  regular(file, limit);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > limit) throw new Error('research_storage_limit');
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body); await handle.sync();
    await handle.close(); handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  const discard = () => { if (existsSync(temporary)) unlinkSync(temporary); };
  return {
    commit() { try { regular(file, limit); renameSync(temporary, file); } finally { discard(); } },
    discard,
  };
}
function validReport(value, schema = 2) {
  if (!object(value) || value.schema !== schema || value.mode !== 'paper' || typeof value.sessionId !== 'string' || !UUID.test(value.sessionId)
    || !finite(value.startedAt) || !finite(value.updatedAt) || !Array.isArray(value.scenarios) || value.scenarios.length > 12
    || typeof value.stopped !== 'boolean' || typeof value.interrupted !== 'boolean'
    || !['markets', 'books', 'assumptions'].every(key => Array.isArray(value[key]))
    || ['channels', 'diagnostics'].some(key => value[key] !== undefined && !Array.isArray(value[key]))
    || new Set(value.scenarios.map(row => row?.id)).size !== value.scenarios.length
    || value.scenarios.some(row => !object(row) || !object(row.stats))) throw new Error('invalid_research_report');
  if (schema === 1) {
    legacyConfig(value.sessionConfig);
    if (value.scenarios.some(row => !/^(BTC|ETH)-(buy|sell)-\d{3,5}$/.test(row.id)
      || !count(row.stats.completed) || !count(row.stats.unresolved)
      || row.task != null && (!object(row.task) || !['binanceQuantity', 'lighterQuantity', 'residualQuantity'].every(key => finite(row.task[key]))))) throw new Error('invalid_legacy_report');
    return value;
  }
  historicalConfig(value.sessionConfig);
  if (value.strategy !== 'inventory_quotes' || value.scenarios.length > 6) throw new Error('invalid_research_report');
  for (const row of value.scenarios) {
    if (!SCENARIO.test(row.id) || !value.sessionConfig.symbols.includes(row.symbol)
      || !value.sessionConfig.latencyScenarios.includes(row.latencyMs) || row.id !== `${row.symbol}-inventory-${row.latencyMs}`
      || !['waiting', 'quoting', 'hedging', 'recovering', 'blocked', 'stopped'].includes(row.status)
      || !object(row.inventory) || !object(row.quotes)
      || !['binanceQuantity', 'lighterQuantity', 'residualQuantity', 'projectedResidualQuantity', 'limitNotional'].every(key => finite(row.inventory[key]))
      || (Object.hasOwn(value.sessionConfig, 'hedgeThresholdNotional') || Object.hasOwn(row.inventory, 'residualNotional'))
        && row.inventory.residualNotional !== null && (!finite(row.inventory.residualNotional) || row.inventory.residualNotional < 0)
      || !['binanceAveragePrice', 'lighterAveragePrice', 'binanceNotional', 'utilization'].every(key => row.inventory[key] === null || finite(row.inventory[key]))
      || !['quoteUpdates', 'makerFills', 'hedgeFills', 'hedgeFailures'].every(key => count(row.stats[key]))
      || !['binanceTurnover', 'lighterTurnover', 'fees', 'realizedPnl'].every(key => finite(row.stats[key]))
      || !['unrealizedPnl', 'netPnl', 'markedCost', 'costPer10000', 'fundingScenarioCost', 'modeledCostPer10000'].every(key => row.stats[key] === null || finite(row.stats[key]))) throw new Error('invalid_research_scenario');
    if (!object(row.valuation) || row.valuation.at !== null && !finite(row.valuation.at) || typeof row.valuation.valid !== 'boolean'
      || !['binanceMark', 'lighterMark'].every(key => row.valuation[key] === null || finite(row.valuation[key]))) throw new Error('invalid_research_valuation');
    for (const side of ['buy', 'sell']) {
      const quote = row.quotes[side];
      if (quote !== null && (!object(quote) || typeof quote.id !== 'string' || quote.side !== side
        || !['price', 'quantity', 'remainingQuantity', 'queueAhead', 'submittedAt'].every(key => finite(quote[key]))
        || quote.price <= 0 || quote.quantity <= 0 || quote.remainingQuantity < 0 || quote.remainingQuantity > quote.quantity || quote.queueAhead < 0)) throw new Error('invalid_research_quote');
    }
    if (row.hedge !== null && (!object(row.hedge) || typeof row.hedge.id !== 'string' || !['buy', 'sell'].includes(row.hedge.side)
      || !finite(row.hedge.quantity) || row.hedge.quantity <= 0 || !finite(row.hedge.dueAt) || !count(row.hedge.attempt))) throw new Error('invalid_research_hedge');
    for (const [key, limit] of [['recentFills', 200], ['history', 300], ['events', 30]]) {
      if (!Array.isArray(row[key]) || row[key].length > limit) throw new Error('invalid_research_history');
    }
    if (row.recentFills.some(fill => !object(fill) || typeof fill.id !== 'string'
      || !['binance', 'lighter'].includes(fill.venue) || fill.symbol !== row.symbol || !['buy', 'sell'].includes(fill.side)
      || !['quote', 'hedge'].includes(fill.phase) || !['quantity', 'price', 'notional', 'fee', 'at', 'sourceAt'].every(key => finite(fill[key]))
      || fill.quantity <= 0 || fill.price <= 0)
      || row.history.some(point => !object(point) || !['at', 'binanceQuantity', 'residualQuantity'].every(key => finite(point[key]))
        || !['costPer10000', 'modeledCostPer10000'].every(key => point[key] === null || finite(point[key])))
      || row.events.some(event => !object(event) || !finite(event.at) || typeof event.type !== 'string'
        || event.reason !== null && typeof event.reason !== 'string')) throw new Error('invalid_research_history');
  }
  return value;
}
const legacyUnresolved = row => row.status === 'unresolved' || row.stats.unresolved > 0
  || row.task && (nonzero(row.task.binanceQuantity) || nonzero(row.task.lighterQuantity));
const hasExposure = row => Boolean(row.inventory && (nonzero(row.inventory.binanceQuantity) || nonzero(row.inventory.lighterQuantity)
  || nonzero(row.inventory.residualQuantity) || nonzero(row.inventory.projectedResidualQuantity)));
export function hasUnresolvedCostReport(report) {
  return Boolean(report && (report.interrupted || !report.stopped || report.scenarios.some(row => report.schema === 2
    ? row.status === 'blocked' || row.hedge != null || hasExposure(row) : legacyUnresolved(row))));
}
const marketIdentity = markets => JSON.stringify(markets.map(({ observedAt, ...row }) => row));
function projectReport(report, { summary = false, scenarioId } = {}) {
  const selected = scenarioId === undefined ? report.scenarios : report.scenarios.filter(row => row.id === scenarioId);
  return { ...report, detailLevel: summary ? 'summary' : scenarioId === undefined ? 'full' : 'scenario',
    scenarios: summary ? selected.map(row => report.schema === 2 ? ({ ...row, recentFills: [], history: [], events: [] })
      : ({ ...row, recentRounds: [], history: [] })) : selected };
}

export function createBinanceLighterCost({ dataDir, log = console, now = Date.now, mono = () => performance.now(),
  discover = discoverCostMarkets, connect = startCostFeeds, engineFactory = (config, options) => new CostLabEngine(config, options),
  tickMs = 50, snapshotMs = 1000, metadataMs = 10 * 60_000, stopWaitMs = 3000, persistGapMs = 200, write = atomic,
  // An injected synchronous writer also serves the background path, so tests and fault injection see every write.
  stage = write === atomic ? stageAtomic : async (file, value, limit) => ({ commit: () => write(file, value, limit), discard() {} }) } = {}) {
  const directory = path.join(dataDir, 'binance-lighter-cost');
  const archiveDirectory = path.join(directory, 'archives-v2');
  const configPath = path.join(directory, 'config-v2.json');
  const sessionPath = path.join(directory, 'session-v2.json');
  const archivesPath = path.join(directory, 'archives-v2.json');
  const migrationBackupPath = path.join(directory, 'threshold-migration-backup.json');
  const legacyArchiveDirectory = path.join(directory, 'archives');
  const legacyConfigPath = path.join(directory, 'config.json');
  const legacySessionPath = path.join(directory, 'session.json');
  const legacyArchivesPath = path.join(directory, 'archives.json');
  const cooldownPath = path.join(directory, 'cooldowns.json');
  let config = clone(DEFAULT_COST_CONFIG), storedReport = null, legacyReport = null, legacyClean = true;
  let engine = null, archives = [], initialized = false, closed = false;
  let configValid = true, enabled = false, phase = 'stopped', failure = null, generation = 0, streamGeneration = 0;
  let controller = null, feeds = null, launchTask = null, tickTimer = null, snapshotTimer = null, metadataTimer = null;
  let controls = Promise.resolve(), dirty = false, metadataIdentity = null, cooldownJson = '{}';
  // Session writes are numbered; only the newest may land on disk (L083).
  let sessionWrites = 0, background = null, cooling = false, coolTimer = null;
  const channels = new Map(), diagnostics = [], cooldowns = {};
  const serial = operation => {
    const next = controls.then(() => {
      if (closed) throw new HttpError(503, '研究服务正在关闭');
      return operation();
    });
    controls = next.catch(() => {});
    return next;
  };
  function currentReport(options = {}) {
    if (!engine) return storedReport ? clone(projectReport(storedReport, options)) : null;
    return { ...engine.report(options), channels: [...channels.values()].map(clone), diagnostics: clone(diagnostics) };
  }
  function persist(clean = !enabled) {
    sessionWrites += 1;
    const report = currentReport();
    write(sessionPath, { schema: 2, clean, report });
    storedReport = report;
    dirty = false;
  }
  // Running-session snapshots. Every quote update marks the report dirty; a
  // synchronous fsync per update stalled the whole data plane, WS feeds
  // included, so they are written in the background: at most one in flight and
  // one started per persistGapMs, the newest state each time. A crash loses at
  // most that window, and the file stays unclean, so restart still treats the
  // session as interrupted. Start, stop, fault and archive stay synchronous.
  function persistSoon() {
    if (!dirty || background || cooling || !enabled || closed) return;
    const seq = ++sessionWrites, run = generation;
    const report = currentReport();
    storedReport = report; dirty = false;
    const failed = () => { if (seq === sessionWrites && enabled && generation === run) fault('成本研究处理或记录失败，已停止新增模拟', 'processing_failed'); };
    background = stage(sessionPath, { schema: 2, clean: false, report }).then(staged => {
      if (seq !== sessionWrites || !enabled || closed || generation !== run) { staged.discard(); return; }
      try { staged.commit(); } catch { failed(); }
    }, failed).finally(() => { background = null; persistSoon(); });
    cooling = true;
    coolTimer = setTimeout(() => { cooling = false; coolTimer = null; persistSoon(); }, persistGapMs); coolTimer.unref?.();
  }
  function persistCooldowns() {
    const next = JSON.stringify(cooldowns);
    if (next !== cooldownJson) { write(cooldownPath, cooldowns, 16 * 1024); cooldownJson = next; }
  }
  function diagnostic(row) {
    // Upstream diagnostics are bounded public facts, never raw response bodies.
    const safe = { at: finite(row?.at) ? row.at : now(), level: ['info', 'warn', 'error'].includes(row?.level) ? row.level : 'warn',
      event: typeof row?.event === 'string' ? row.event.slice(0, 80) : 'feed',
      venue: ['binance', 'lighter'].includes(row?.venue) ? row.venue : null,
      message: typeof row?.message === 'string' ? row.message.slice(0, 300) : '公开行情状态变化' };
    if (typeof row?.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(row.reason)) safe.reason = row.reason;
    const retryNotBefore = row?.retryNotBefore ?? row?.details?.retryNotBefore;
    if (safe.venue && finite(retryNotBefore) && retryNotBefore > 0) cooldowns[safe.venue] = Math.max(cooldowns[safe.venue] || 0, retryNotBefore);
    diagnostics.push(safe);
    if (diagnostics.length > 50) diagnostics.shift();
    dirty = true;
    persistCooldowns();
  }
  function clearTimers() {
    clearInterval(tickTimer); clearInterval(snapshotTimer); clearTimeout(metadataTimer); clearTimeout(coolTimer);
    tickTimer = null; snapshotTimer = null; metadataTimer = null; coolTimer = null; cooling = false;
  }
  function fault(message, reason = 'service_fault') {
    if (!enabled && phase === 'fault') return;
    enabled = false; phase = 'fault'; failure = message;
    generation += 1; streamGeneration += 1;
    clearTimers(); controller?.abort();
    try { engine?.stop(reason); } catch {}
    // A failed write never authorizes more simulation. The last durable file
    // remains unclean, so a restart retains it and requires explicit archival.
    try { persist(true); } catch { failure = `${message}；研究记录未能完整保存，原文件已保留`; }
    const old = feeds; feeds = null;
    void old?.stop().catch(() => {});
    log.warn?.({ type: 'binance-lighter-cost', reason }, message);
  }
  function guarded(operation) {
    if (!enabled || closed) return;
    try {
      operation();
      persistSoon();
    } catch { fault('成本研究处理或记录失败，已停止新增模拟', 'processing_failed'); }
  }
  function legacySummary() {
    if (!legacyReport) return null;
    return { schema: 1, sessionId: legacyReport.sessionId, startedAt: legacyReport.startedAt, updatedAt: legacyReport.updatedAt,
      stopped: true, interrupted: !legacyClean || !legacyReport.stopped || legacyReport.interrupted,
      completed: legacyReport.scenarios.reduce((sum, row) => sum + row.stats.completed, 0),
      unresolved: legacyReport.scenarios.filter(legacyUnresolved).length,
      exposures: legacyReport.scenarios.filter(row => row.task && (nonzero(row.task.binanceQuantity) || nonzero(row.task.lighterQuantity)))
        .map(row => ({ id: row.id, symbol: row.symbol || row.id.split('-')[0], binanceQuantity: row.task.binanceQuantity,
          lighterQuantity: row.task.lighterQuantity, residualQuantity: row.task.residualQuantity })) };
  }
  const state = () => ({ schema: 2, state: phase, enabled, error: failure, serverNow: now(), config: clone(config),
    report: currentReport({ summary: true }), legacySession: legacySummary(), archives: clone(archives), execution: { ...EXECUTION } });

  async function waitStop(source) {
    if (!source) return;
    let timer;
    try {
      await Promise.race([source.stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('feed_stop_timeout')), stopWaitMs); })]);
    } finally { clearTimeout(timer); }
  }
  function attach(markets, run) {
    const stream = ++streamGeneration;
    const active = () => enabled && !closed && generation === run && streamGeneration === stream;
    const source = connect({ markets, signal: controller.signal, now, mono, cooldowns,
      onBook: book => { if (active()) guarded(() => engine.onBook(book)); },
      onTrade: trade => { if (active()) guarded(() => engine.onTrade(trade)); },
      onStatus: status => {
        if (!active()) return;
        guarded(() => {
          channels.set(`${status.venue}:${status.channel}:${status.symbol || '*'}`, clone(status));
          engine.onStatus(status);
          dirty = true;
        });
      },
      onDiagnostic: row => { if (active()) guarded(() => diagnostic(row)); },
    });
    feeds = source;
    Promise.resolve(source.done).then(() => {
      if (active()) fault('行情连接恢复次数已用尽，请检查诊断后重新启动', 'feeds_ended');
    }, () => {
      if (active()) fault('公开行情连接异常终止，请检查诊断', 'feeds_failed');
    });
  }
  async function refreshMetadata(run) {
    if (!enabled || closed || generation !== run) return;
    try {
      const markets = (await discover({ symbols: config.symbols, signal: controller.signal, cooldowns, onDiagnostic: row => {
        if (enabled && generation === run) guarded(() => diagnostic(row));
      } })).filter(row => config.symbols.includes(row.symbol));
      if (!enabled || closed || generation !== run) return;
      const identity = marketIdentity(markets);
      engine.setMarkets(markets);
      dirty = true; persistSoon();
      if (identity !== metadataIdentity) {
        const old = feeds; feeds = null; streamGeneration += 1;
        await waitStop(old);
        if (!enabled || closed || generation !== run) return;
        metadataIdentity = identity;
        attach(markets, run);
      }
    } catch {
      if (!enabled || closed || generation !== run) return;
      guarded(() => diagnostic({ event: 'metadata_refresh_failed', message: '合约规则刷新失败；旧规则只在原有效期内使用', level: 'warn' }));
    } finally {
      if (enabled && !closed && generation === run) {
        metadataTimer = setTimeout(() => void refreshMetadata(run), metadataMs);
        metadataTimer.unref?.();
      }
    }
  }
  async function launch(run) {
    try {
      const markets = (await discover({ symbols: config.symbols, signal: controller.signal, cooldowns, onDiagnostic: row => {
        if (enabled && generation === run) guarded(() => diagnostic(row));
      } })).filter(row => config.symbols.includes(row.symbol));
      if (!enabled || closed || generation !== run) return;
      engine.setMarkets(markets);
      metadataIdentity = marketIdentity(markets);
      phase = 'running'; dirty = true; persist(false);
      attach(markets, run);
      if (!enabled || closed || generation !== run) return;
      tickTimer = setInterval(() => guarded(() => engine.tick()), tickMs); tickTimer.unref?.();
      // Refreshes valuation and book ages on disk even when nothing emitted.
      snapshotTimer = setInterval(() => guarded(() => { dirty = true; persistCooldowns(); }), snapshotMs); snapshotTimer.unref?.();
      metadataTimer = setTimeout(() => void refreshMetadata(run), metadataMs); metadataTimer.unref?.();
    } catch {
      if (enabled && !closed && generation === run) fault('公开合约规则读取失败，未开始成交模拟；请检查诊断后重试', 'metadata_unavailable');
    }
  }
  function archiveReport(report) {
    if (!report) return;
    validReport(report);
    if (archives.some(item => item.sessionId === report.sessionId)) return;
    const currentArchives = archives.filter(item => item.schema === 2);
    if (currentArchives.length >= MAX_ARCHIVES) throw new HttpError(409, '新版研究归档已达到 50 个会话，请先导出并整理数据目录');
    const body = JSON.stringify(report);
    const total = currentArchives.reduce((sum, item) => sum + (regular(path.join(archiveDirectory, `${item.sessionId}.json`), LIMIT)?.size || 0), 0);
    if (total + Buffer.byteLength(body) > MAX_ARCHIVE_BYTES) throw new HttpError(409, '研究归档已达到容量上限，请先导出并整理数据目录');
    write(path.join(archiveDirectory, `${report.sessionId}.json`), report);
    const summary = { schema: 2, sessionId: report.sessionId, startedAt: report.startedAt, endedAt: report.updatedAt,
      hasExposure: report.scenarios.some(hasExposure),
      interrupted: Boolean(report.interrupted),
      makerFills: report.scenarios.reduce((sum, row) => sum + row.stats.makerFills, 0) };
    const next = [...archives, summary];
    write(archivesPath, { schema: 2, sessions: next.filter(item => item.schema === 2) }, 64 * 1024);
    archives = next;
  }
  function publicConfig(value) {
    try { return clone(validateCostConfig(value)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '研究配置无效'); }
  }
  function validIndex(index, schema) {
    if (index === undefined) return [];
    if (!object(index) || index.schema !== schema || !Array.isArray(index.sessions) || index.sessions.length > MAX_ARCHIVES
      || index.sessions.some(item => !object(item) || typeof item.sessionId !== 'string' || !UUID.test(item.sessionId) || !finite(item.startedAt) || !finite(item.endedAt)
        || item.schema !== undefined && item.schema !== schema
        || (schema === 1 ? !count(item.unresolved) || !count(item.completed) : !count(item.makerFills) || typeof item.hasExposure !== 'boolean')
        || item.interrupted !== undefined && typeof item.interrupted !== 'boolean')
      || new Set(index.sessions.map(item => item.sessionId)).size !== index.sessions.length) throw new Error('invalid_archive_index');
    return index.sessions.map(item => ({ ...item, schema }));
  }
  const readIndex = (file, schema) => validIndex(read(file, 64 * 1024), schema);
  function saveMigrationBackup() {
    const previous = read(migrationBackupPath, MIGRATION_BACKUP_LIMIT);
    if (previous !== undefined) {
      if (!object(previous) || previous.schema !== 1 || previous.migration !== 'btc-hedge-threshold' || !finite(previous.createdAt)
        || !object(previous.files) || Object.keys(previous.files).length !== Object.keys(MIGRATION_FILES).length
        || Object.entries(MIGRATION_FILES).some(([name, limit]) => previous.files[name] !== null
          && (typeof previous.files[name] !== 'string' || Buffer.byteLength(previous.files[name]) > limit))) throw new Error('invalid_migration_backup');
      historicalConfig(JSON.parse(previous.files['config-v2.json']));
      if (previous.files['session-v2.json'] !== null) {
        const session = JSON.parse(previous.files['session-v2.json']);
        if (!object(session) || session.schema !== 2 || typeof session.clean !== 'boolean') throw new Error('invalid_migration_backup');
        if (session.report !== null) validReport(session.report);
      }
      if (previous.files['archives-v2.json'] !== null) validIndex(JSON.parse(previous.files['archives-v2.json']), 2);
      return;
    }
    const files = Object.fromEntries(Object.entries(MIGRATION_FILES).map(([name, limit]) => {
      const file = path.join(directory, name);
      return [name, regular(file, limit) ? readFileSync(file, 'utf8') : null];
    }));
    write(migrationBackupPath, { schema: 1, migration: 'btc-hedge-threshold', createdAt: now(), files }, MIGRATION_BACKUP_LIMIT);
  }
  async function halt(reason = 'stopped') {
    enabled = false; generation += 1; streamGeneration += 1;
    clearTimers(); controller?.abort();
    const old = feeds; feeds = null;
    engine?.stop(reason);
    // Snapshot first: stopping must not discard positions while awaiting I/O.
    try { persist(true); }
    catch { phase = 'fault'; failure = '模拟已停止，但记录保存失败；原文件已保留'; throw new HttpError(503, failure); }
    try { await waitStop(old); }
    catch { phase = 'fault'; failure = '模拟已停止，行情连接结束尚未确认'; throw new HttpError(503, failure); }
    phase = 'stopped'; failure = null;
  }
  return {
    state,
    get directory() { return directory; },
    async initialize() {
      if (initialized) return;
      initialized = true;
      for (const folder of [directory, archiveDirectory]) {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw new Error('invalid_research_directory');
      }
      try {
        if (existsSync(legacyArchiveDirectory) && (!lstatSync(legacyArchiveDirectory).isDirectory()
          || lstatSync(legacyArchiveDirectory).isSymbolicLink())) throw new Error('invalid_legacy_directory');
        // Read and validate every legacy source before publishing migration. Legacy
        // reports are never loaded into the inventory engine or written back.
        const oldConfig = read(legacyConfigPath, 64 * 1024);
        if (oldConfig !== undefined) legacyConfig(oldConfig);
        archives = [...readIndex(legacyArchivesPath, 1), ...readIndex(archivesPath, 2)];
        if (new Set(archives.map(item => item.sessionId)).size !== archives.length) throw new Error('duplicate_session_identity');
        const legacy = read(legacySessionPath);
        if (legacy !== undefined) {
          if (legacy.schema !== 1 || typeof legacy.clean !== 'boolean') throw new Error('invalid_legacy_session');
          legacyReport = legacy.report === null ? null : validReport(legacy.report, 1);
          legacyClean = legacy.clean;
        }
        const savedConfig = read(configPath, 64 * 1024);
        const needsMigration = savedConfig !== undefined && (!Object.hasOwn(savedConfig ?? {}, 'hedgeThresholdNotional')
          || Array.isArray(savedConfig?.symbols) && savedConfig.symbols.includes('ETH'));
        config = savedConfig !== undefined ? needsMigration ? migrateV2Config(savedConfig) : publicConfig(savedConfig)
          : oldConfig !== undefined ? migrateConfig(oldConfig) : clone(DEFAULT_COST_CONFIG);
        const savedCooldowns = read(cooldownPath, 16 * 1024);
        if (savedCooldowns !== undefined) {
          if (!object(savedCooldowns) || Object.entries(savedCooldowns).some(([key, value]) => !['binance', 'lighter'].includes(key) || !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid_cooldowns');
          Object.assign(cooldowns, savedCooldowns); cooldownJson = JSON.stringify(cooldowns);
        }
        const saved = read(sessionPath);
        if (saved !== undefined) {
          if (saved.schema !== 2 || typeof saved.clean !== 'boolean') throw new Error('invalid_session_file');
          storedReport = saved.report === null ? null : validReport(saved.report);
          if (storedReport && (legacyReport?.sessionId === storedReport.sessionId
            || archives.some(item => item.schema === 1 && item.sessionId === storedReport.sessionId))) throw new Error('duplicate_session_identity');
          if (storedReport && (!saved.clean || !storedReport.stopped)) {
            // Preserve the original session, metrics and last known exposure.
            // No recovery mark can prove the missing tail of a crashed process.
            storedReport = { ...storedReport, stopped: true, interrupted: true,
              scenarios: storedReport.scenarios.map(row => ({ ...row, quotes: { buy: null, sell: null },
                status: row.status === 'blocked' ? 'blocked' : 'stopped', reason: 'service_interrupted' })) };
            failure = '上次模拟未正常结束，已保留最后记录；归档前不会开始新会话';
          }
        }
        // Every source used by initialization has now passed validation. A failed
        // backup or atomic config replacement leaves all original source files.
        if (needsMigration) saveMigrationBackup();
        if (savedConfig === undefined || needsMigration) write(configPath, config, 64 * 1024);
      } catch {
        configValid = false; phase = 'fault'; failure = '研究配置、旧版记录或新版记录无法校验或保存，原文件已保留，请检查数据目录';
      }
    },
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      // Failed initialization cannot be repaired by overwriting its source or
      // bypassing the required pre-migration recovery copy.
      if (!configValid) throw new HttpError(409, '研究配置或记录无效，请先检查保留的数据文件');
      if (enabled) throw new HttpError(409, '请先停止研究，再保存参数');
      const next = publicConfig(value);
      write(configPath, next, 64 * 1024);
      config = next;
      phase = 'stopped'; failure = storedReport?.interrupted ? '上次模拟未正常结束，请先导出或归档记录' : null;
      return state();
    }),
    start: (authorize = () => {}) => serial(() => {
      authorize();
      if (!configValid) throw new HttpError(409, '研究配置或记录无效，请先检查保留的数据文件');
      if (enabled) return state();
      const previous = currentReport();
      if (hasUnresolvedCostReport(previous)) throw new HttpError(409, '上次模拟存在库存、对冲、阻断或中断记录，请先停止并归档后再开始新会话');
      archiveReport(previous);
      const candidate = engineFactory(config, { now, mono, sessionId: randomUUID(), emit: () => { dirty = true; } });
      const initial = validReport({ ...candidate.report(), channels: [], diagnostics: [] });
      // Persist the unclean marker before any public feeds can drive a model.
      write(sessionPath, { schema: 2, clean: false, report: initial });
      channels.clear(); diagnostics.length = 0;
      engine = candidate; storedReport = initial; dirty = false;
      phase = 'starting'; enabled = true; failure = null; metadataIdentity = null;
      controller = new AbortController();
      const run = ++generation;
      launchTask = launch(run);
      return state();
    }),
    stop: (authorize = () => {}) => serial(async () => {
      authorize();
      if (!configValid) throw new HttpError(409, '研究记录无法校验，原文件已保留，请检查数据目录');
      await halt(); return state();
    }),
    archive: (authorize = () => {}) => serial(() => {
      authorize();
      if (!configValid) throw new HttpError(409, '研究记录无法校验，原文件已保留，请检查数据目录');
      if (enabled) throw new HttpError(409, '请先停止模拟，再归档会话');
      const report = currentReport();
      archiveReport(report);
      write(sessionPath, { schema: 2, clean: true, report: null });
      engine = null; storedReport = null;
      phase = 'stopped'; failure = null;
      return state();
    }),
    report(sessionId) {
      if (sessionId !== undefined) {
        if (!UUID.test(sessionId)) throw new HttpError(404, '研究归档不存在');
        if (legacyReport?.sessionId === sessionId) return { report: clone(legacyReport), archives: clone(archives) };
        const current = currentReport();
        if (current?.sessionId === sessionId) return { report: current, archives: clone(archives) };
        const item = archives.find(row => row.sessionId === sessionId);
        if (!item) throw new HttpError(404, '研究归档不存在');
        try {
          const report = validReport(read(path.join(item.schema === 1 ? legacyArchiveDirectory : archiveDirectory, `${sessionId}.json`)), item.schema);
          if (report.sessionId !== sessionId) throw new Error('archive_identity_mismatch');
          return { report, archives: clone(archives) };
        }
        catch { throw new HttpError(503, '研究归档暂时无法读取，原文件已保留'); }
      }
      return { report: currentReport(), archives: clone(archives), execution: { ...EXECUTION } };
    },
    scenario(sessionId, scenarioId) {
      if (!UUID.test(sessionId) || typeof scenarioId !== 'string' || !SCENARIO.test(scenarioId)) throw new HttpError(404, '研究情景不存在');
      const report = currentReport({ scenarioId });
      if (!report || report.sessionId !== sessionId) throw new HttpError(409, '研究会话已改变，请刷新后查看');
      const scenario = report.scenarios.find(row => row.id === scenarioId);
      if (!scenario) throw new HttpError(404, '研究情景不存在');
      return { sessionId, updatedAt: report.updatedAt, scenario };
    },
    async close() {
      closed = true;
      await controls;
      if (!initialized) return;
      if (enabled || engine) {
        try { await halt('service_shutdown'); }
        catch (error) { log.warn?.({ type: 'binance-lighter-cost', reason: 'shutdown_incomplete' }, error.message); }
      } else { clearTimers(); controller?.abort(); }
      // Discovery observes AbortSignal and has its own bounded HTTP deadline.
      await launchTask;
      // halt() already wrote the final state; the staged file is only removed.
      await background;
    },
  };
}

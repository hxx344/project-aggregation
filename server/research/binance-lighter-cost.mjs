// Public-market paper research owned by the workbench runtime. No credentials,
// signing clients or private exchange endpoints enter this service.
import { existsSync, lstatSync, mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-common.mjs';
import { CostLabEngine, DEFAULT_COST_CONFIG, validateCostConfig } from './binance-lighter-core.mjs';
import { discoverCostMarkets, startCostFeeds } from './binance-lighter-feeds.mjs';

const LIMIT = 8 * 1024 * 1024;
const MAX_ARCHIVES = 50;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXECUTION = Object.freeze({ mode: 'paper', liveAvailable: false, version: 1 });
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function regular(file, limit) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid_research_file');
  return info;
}
function read(file, limit = LIMIT) {
  return regular(file, limit) ? JSON.parse(readFileSync(file, 'utf8')) : null;
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
function validReport(value) {
  if (!object(value) || value.schema !== 1 || value.mode !== 'paper' || !UUID.test(value.sessionId)
    || !finite(value.startedAt) || !finite(value.updatedAt) || !Array.isArray(value.scenarios) || value.scenarios.length > 12
    || value.scenarios.some(row => !object(row) || !object(row.stats))) throw new Error('invalid_research_report');
  validateCostConfig(value.sessionConfig);
  return value;
}
export function hasUnresolvedCostReport(report) {
  return Boolean(report && (report.interrupted || !report.stopped || report.scenarios.some(row => row.status === 'unresolved'
    || row.task && (Math.abs(row.task.binanceQuantity || 0) > 1e-12 || Math.abs(row.task.lighterQuantity || 0) > 1e-12)
    || row.stats.unresolved > 0)));
}
const marketIdentity = markets => JSON.stringify(markets.map(({ observedAt, ...row }) => row));
function projectReport(report, { summary = false, scenarioId } = {}) {
  const selected = scenarioId === undefined ? report.scenarios : report.scenarios.filter(row => row.id === scenarioId);
  return { ...report, detailLevel: summary ? 'summary' : scenarioId === undefined ? 'full' : 'scenario',
    scenarios: summary ? selected.map(row => ({ ...row, recentRounds: [], history: [] })) : selected };
}

export function createBinanceLighterCost({ dataDir, log = console, now = Date.now, mono = () => performance.now(),
  discover = discoverCostMarkets, connect = startCostFeeds, engineFactory = (config, options) => new CostLabEngine(config, options),
  tickMs = 50, snapshotMs = 1000, metadataMs = 10 * 60_000, stopWaitMs = 3000, write = atomic } = {}) {
  const directory = path.join(dataDir, 'binance-lighter-cost');
  const archiveDirectory = path.join(directory, 'archives');
  const configPath = path.join(directory, 'config.json');
  const sessionPath = path.join(directory, 'session.json');
  const archivesPath = path.join(directory, 'archives.json');
  const cooldownPath = path.join(directory, 'cooldowns.json');
  let config = clone(DEFAULT_COST_CONFIG), storedReport = null, engine = null, archives = [], initialized = false, closed = false;
  let configValid = true, enabled = false, phase = 'stopped', failure = null, generation = 0, streamGeneration = 0;
  let controller = null, feeds = null, launchTask = null, tickTimer = null, snapshotTimer = null, metadataTimer = null;
  let controls = Promise.resolve(), dirty = false, metadataIdentity = null, cooldownJson = '{}';
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
    const report = currentReport();
    write(sessionPath, { schema: 1, clean, report });
    storedReport = report;
    dirty = false;
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
    clearInterval(tickTimer); clearInterval(snapshotTimer); clearTimeout(metadataTimer);
    tickTimer = null; snapshotTimer = null; metadataTimer = null;
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
      if (dirty) persist(false);
    } catch { fault('成本研究处理或记录失败，已停止新增模拟', 'processing_failed'); }
  }
  const state = () => ({ schema: 1, state: phase, enabled, error: failure, serverNow: now(), config: clone(config),
    report: currentReport({ summary: true }), archives: clone(archives), execution: { ...EXECUTION } });

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
      const markets = (await discover({ signal: controller.signal, cooldowns, onDiagnostic: row => {
        if (enabled && generation === run) guarded(() => diagnostic(row));
      } })).filter(row => config.symbols.includes(row.symbol));
      if (!enabled || closed || generation !== run) return;
      const identity = marketIdentity(markets);
      engine.setMarkets(markets);
      dirty = true; persist(false);
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
      const markets = (await discover({ signal: controller.signal, cooldowns, onDiagnostic: row => {
        if (enabled && generation === run) guarded(() => diagnostic(row));
      } })).filter(row => config.symbols.includes(row.symbol));
      if (!enabled || closed || generation !== run) return;
      engine.setMarkets(markets);
      metadataIdentity = marketIdentity(markets);
      phase = 'running'; dirty = true; persist(false);
      attach(markets, run);
      if (!enabled || closed || generation !== run) return;
      tickTimer = setInterval(() => guarded(() => engine.tick()), tickMs); tickTimer.unref?.();
      snapshotTimer = setInterval(() => guarded(() => { persist(false); persistCooldowns(); }), snapshotMs); snapshotTimer.unref?.();
      metadataTimer = setTimeout(() => void refreshMetadata(run), metadataMs); metadataTimer.unref?.();
    } catch {
      if (enabled && !closed && generation === run) fault('公开合约规则读取失败，未开始成交模拟；请检查诊断后重试', 'metadata_unavailable');
    }
  }
  function archiveReport(report) {
    if (!report) return;
    validReport(report);
    if (archives.some(item => item.sessionId === report.sessionId)) return;
    if (archives.length >= MAX_ARCHIVES) throw new HttpError(409, '研究归档已达到 50 个会话，请先导出并整理数据目录');
    const body = JSON.stringify(report);
    const total = archives.reduce((sum, item) => sum + (regular(path.join(archiveDirectory, `${item.sessionId}.json`), LIMIT)?.size || 0), 0);
    if (total + Buffer.byteLength(body) > MAX_ARCHIVE_BYTES) throw new HttpError(409, '研究归档已达到容量上限，请先导出并整理数据目录');
    write(path.join(archiveDirectory, `${report.sessionId}.json`), report);
    const summary = { sessionId: report.sessionId, startedAt: report.startedAt, endedAt: report.updatedAt,
      unresolved: report.scenarios.filter(row => row.status === 'unresolved' || row.stats.unresolved > 0 || row.task && (Math.abs(row.task.binanceQuantity || 0) > 1e-12 || Math.abs(row.task.lighterQuantity || 0) > 1e-12)).length,
      interrupted: Boolean(report.interrupted),
      completed: report.scenarios.reduce((sum, row) => sum + (row.stats.completed || 0), 0) };
    const next = [...archives, summary];
    write(archivesPath, { schema: 1, sessions: next }, 64 * 1024);
    archives = next;
  }
  function publicConfig(value) {
    try { return clone(validateCostConfig(value)); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '研究配置无效'); }
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
        const savedConfig = read(configPath, 64 * 1024);
        if (savedConfig) config = publicConfig(savedConfig);
        const index = read(archivesPath, 64 * 1024);
        if (index) {
          if (index.schema !== 1 || !Array.isArray(index.sessions) || index.sessions.length > MAX_ARCHIVES
            || index.sessions.some(item => !object(item) || !UUID.test(item.sessionId) || !finite(item.startedAt) || !finite(item.endedAt)
              || !Number.isSafeInteger(item.unresolved) || item.unresolved < 0 || !Number.isSafeInteger(item.completed) || item.completed < 0
              || item.interrupted !== undefined && typeof item.interrupted !== 'boolean')
            || new Set(index.sessions.map(item => item.sessionId)).size !== index.sessions.length) throw new Error('invalid_archive_index');
          archives = index.sessions;
        }
        const savedCooldowns = read(cooldownPath, 16 * 1024);
        if (savedCooldowns) {
          if (!object(savedCooldowns) || Object.entries(savedCooldowns).some(([key, value]) => !['binance', 'lighter'].includes(key) || !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid_cooldowns');
          Object.assign(cooldowns, savedCooldowns); cooldownJson = JSON.stringify(cooldowns);
        }
        const saved = read(sessionPath);
        if (saved) {
          if (saved.schema !== 1 || typeof saved.clean !== 'boolean') throw new Error('invalid_session_file');
          storedReport = saved.report === null ? null : validReport(saved.report);
          if (storedReport && (!saved.clean || !storedReport.stopped)) {
            // Preserve the original session, metrics and last known exposure.
            // No recovery mark can prove the missing tail of a crashed process.
            storedReport = { ...storedReport, stopped: true, interrupted: true };
            failure = '上次模拟未正常结束，已保留最后记录；归档前不会开始新会话';
          }
        }
      } catch {
        configValid = false; phase = 'fault'; failure = '研究配置或记录无法校验，原文件已保留，请检查数据目录';
      }
    },
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      if (enabled) throw new HttpError(409, '请先停止研究，再保存参数');
      const next = publicConfig(value);
      write(configPath, next, 64 * 1024);
      config = next;
      // Bad persisted reports must not be repaired by overwriting a config.
      if (configValid) { phase = 'stopped'; failure = storedReport?.interrupted ? '上次模拟未正常结束，请先导出或归档记录' : null; }
      return state();
    }),
    start: (authorize = () => {}) => serial(() => {
      authorize();
      if (!configValid) throw new HttpError(409, '研究配置或记录无效，请先检查保留的数据文件');
      if (enabled) return state();
      const previous = currentReport();
      if (hasUnresolvedCostReport(previous)) throw new HttpError(409, '上次模拟存在未决或中断记录，请先停止并归档后再开始新会话');
      archiveReport(previous);
      const candidate = engineFactory(config, { now, mono, sessionId: randomUUID(), emit: () => { dirty = true; } });
      const initial = { ...candidate.report(), channels: [], diagnostics: [] };
      // Persist the unclean marker before any public feeds can drive a model.
      write(sessionPath, { schema: 1, clean: false, report: initial });
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
      write(sessionPath, { schema: 1, clean: true, report: null });
      engine = null; storedReport = null;
      phase = 'stopped'; failure = null;
      return state();
    }),
    report(sessionId) {
      if (sessionId !== undefined) {
        if (!UUID.test(sessionId) || !archives.some(item => item.sessionId === sessionId)) throw new HttpError(404, '研究归档不存在');
        try { return { report: validReport(read(path.join(archiveDirectory, `${sessionId}.json`))), archives: clone(archives) }; }
        catch { throw new HttpError(503, '研究归档暂时无法读取，原文件已保留'); }
      }
      return { report: currentReport(), archives: clone(archives), execution: { ...EXECUTION } };
    },
    scenario(sessionId, scenarioId) {
      if (!UUID.test(sessionId) || typeof scenarioId !== 'string' || !/^(BTC|ETH)-(buy|sell)-\d{3,5}$/.test(scenarioId)) throw new HttpError(404, '研究情景不存在');
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
    },
  };
}

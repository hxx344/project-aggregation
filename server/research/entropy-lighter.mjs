import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, automaticConfig, validateConfig } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';
import { buildResearchInsights } from './entropy-lighter-insights.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = path.join(root, 'tools/entropy-lighter-lab');
const defaults = JSON.parse(readFileSync(path.join(tool, 'config.example.json'), 'utf8'));
const REPORT_KEYS = ['schema', 'session', 'mode', 'startedAt', 'heartbeatAt', 'observedAt', 'observation', 'opportunityStudy', 'automaticFees', 'configHash', 'sessionConfig', 'paperSuspendedReason', 'counts', 'basis', 'leaderMarkouts', 'paper', 'openPaperTasks', 'assumptions', 'diagnostics', 'eventLoopDelayMs', 'stopped', 'latestQuotes', 'recentSpreads'];

function readBounded(file, limit) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid_research_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Configuration is data only; the browser cannot select executables, URLs,
// environment variables, directories, or extra keys ignored by the CLI.
export function strictLabConfig(value) {
  const shape = (v, template) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '研究配置格式不正确');
    if (Object.keys(v).length !== Object.keys(template).length || Object.keys(v).some((k) => !Object.hasOwn(template, k))) throw new HttpError(400, '研究配置包含缺失或不支持的字段');
  };
  shape(value, defaults);
  shape(value.simulation, defaults.simulation);
  if (!Array.isArray(value.simulation.latencyScenarios)) throw new HttpError(400, '延迟情景格式不正确');
  for (const row of value.simulation.latencyScenarios) shape(row, defaults.simulation.latencyScenarios[0]);
  try { return structuredClone(validateConfig(automaticConfig(value))); }
  catch { throw new HttpError(400, '研究参数无效，请核对费率、已核验标的和延迟范围'); }
}

export function createEntropyLighterResearch({ dataDir, enabledByDefault = false, log = console,
  launch = spawn, now = Date.now, stopGraceMs = 5000, killWaitMs = 2000, retryDelays = [1000, 2000, 4000, 8000, 16000] } = {}) {
  const directory = path.join(dataDir, 'entropy-lighter');
  const configPath = path.join(directory, 'config.json'), controlPath = path.join(directory, 'control.json');
  let config = automaticConfig(defaults), configValid = true, enabled = enabledByDefault, child = null, closed = false, initialized = false;
  let failure = null, readFailure = null, retry = 0, retryTimer = null, generationStarted = 0;
  let operation = Promise.resolve();
  const cleared = () => { clearTimeout(retryTimer); retryTimer = null; };
  const serial = (fn) => {
    const next = operation.then(() => { if (closed) throw new HttpError(503, '研究服务正在关闭'); return fn(); });
    operation = next.catch(() => {}); return next;
  };
  const persistWanted = () => atomicJson(controlPath, { schema: 1, enabled });
  function report() {
    try {
      const source = readBounded(path.join(directory, 'report.json'), 4 * 1024 * 1024);
      if (source === null) { readFailure = null; return null; }
      if (typeof source !== 'object' || Array.isArray(source) || typeof source.session !== 'string' || !source.counts || typeof source.counts !== 'object') throw new Error('invalid_report');
      readFailure = null;
      return Object.fromEntries(REPORT_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]));
    } catch { readFailure = '研究报告暂时无法读取，原文件已保留'; return null; }
  }
  function state() {
    const projection = report();
    let heartbeatAt = projection?.heartbeatAt ?? null, matched = false;
    try {
      const status = readBounded(path.join(directory, 'status.json'), 256 * 1024);
      if (child?.pid && status?.pid === child.pid && typeof status.session === 'string' && !status.stopped) {
        heartbeatAt = status.heartbeatAt;
        const age = now() - Date.parse(heartbeatAt);
        matched = Number.isFinite(age) && age >= -5000 && age <= 15000 && status.session === projection?.session;
      }
    } catch { readFailure ||= '研究状态暂时无法读取'; }
    const serverNow = now();
    const reportAt = projection?.observedAt ?? Date.parse(projection?.heartbeatAt || '');
    const elapsed = serverNow - reportAt;
    const reportAgeMs = Number.isFinite(elapsed) && elapsed >= -100 ? Math.max(0, elapsed) : null;
    const stale = !matched || reportAgeMs === null || reportAgeMs > 15000;
    return { schema: 1, enabled, state: child ? matched ? 'running' : 'starting' : failure && !retryTimer ? 'fault' : enabled ? 'starting' : 'stopped',
      error: failure || readFailure, heartbeatAt, serverNow, reportAgeMs, stale, config: structuredClone(config), report: projection,
      insights: buildResearchInsights({ report: projection, serverNow, running: Boolean(child && enabled && !closed), reportCurrent: !stale && projection?.stopped !== true }) };
  }
  function startChild() {
    if (closed || !enabled || child) return;
    cleared(); failure = null;
    const env = { ...process.env, NODE_ENV: 'production', ENTROPY_LAB_MANAGED: '1' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    generationStarted = now();
    let current;
    try { current = launch(process.execPath, [path.join(tool, 'cli.mjs'), 'run', '--config', configPath, '--data', directory], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }); } catch { handleExit(null); return; }
    child = current;
    // Drain bounded process output; keep network/raw data in its private journal.
    let stderr = '';
    current.stdout?.on('data', () => {});
    current.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    current.once('error', () => { failure = '行情采集进程启动失败'; });
    current.once('close', () => {
      if (child !== current) return;
      child = null;
      if (closed || !enabled) return;
      log.warn?.({ type: 'entropy-lighter', detail: stderr, attempt: retry }, '行情研究进程已退出');
      handleExit(current);
    });
  }
  function handleExit() {
    if (closed || !enabled) return;
    if (now() - generationStarted > 120000) retry = 0;
    failure = '行情采集已中断，正在等待恢复';
    if (retry >= retryDelays.length) { failure = '行情采集多次退出，请检查诊断后重新启动'; return; }
    retryTimer = setTimeout(() => { retryTimer = null; startChild(); }, retryDelays[retry++]);
    retryTimer.unref?.();
  }
  async function halt() {
    cleared();
    const current = child;
    if (!current) return;
    await new Promise((resolve) => {
      let killTimer, doneTimer, settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(killTimer); clearTimeout(doneTimer); current.removeListener('close', done); resolve(); };
      current.once('close', done);
      killTimer = setTimeout(() => {
        try { current.kill('SIGKILL'); } catch {}
        doneTimer = setTimeout(done, killWaitMs);
      }, stopGraceMs);
      try {
        if (current.connected && typeof current.send === 'function') current.send({ type: 'entropy-lighter-stop' }, (error) => { if (error) { try { current.kill('SIGTERM'); } catch { done(); } } });
        else current.kill('SIGTERM');
      } catch { done(); }
    });
    if (child === current) {
      // Never spawn a second worker when the first one's death was not proven.
      failure = '采集进程停止结果尚未确认，请稍后核对';
      throw new HttpError(503, failure);
    }
  }
  return {
    state,
    async initialize() {
      if (initialized) return;
      initialized = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        if (existsSync(configPath)) {
          const saved = readBounded(configPath, 64 * 1024);
          config = strictLabConfig(saved);
          if (!existsSync(path.join(directory, 'config.before-auto-fees.json'))) atomicJson(path.join(directory, 'config.before-auto-fees.json'), saved);
        } else {
          atomicJson(configPath, config);
          if (!existsSync(path.join(directory, 'config.before-auto-fees.json'))) atomicJson(path.join(directory, 'config.before-auto-fees.json'), config);
        }
        const prior = readBounded(controlPath, 4096);
        if (prior) {
          if (prior.schema !== 1 || typeof prior.enabled !== 'boolean' || Object.keys(prior).some((k) => !['schema', 'enabled'].includes(k))) throw new Error('invalid_control');
          enabled = prior.enabled;
        } else persistWanted();
        if (enabled) startChild();
      } catch {
        configValid = false; enabled = false; failure = '研究配置或运行设置无效，原文件已保留，请检查后重新保存';
      }
    },
    start: (authorize = () => {}) => serial(() => {
      authorize();
      if (!configValid) throw new HttpError(409, '请先重新保存有效研究配置');
      atomicJson(controlPath, { schema: 1, enabled: true });
      retry = 0; enabled = true; startChild(); return state();
    }),
    stop: (authorize = () => {}) => serial(async () => { authorize(); atomicJson(controlPath, { schema: 1, enabled: false }); enabled = false; await halt(); failure = null; return state(); }),
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      if (child || retryTimer || enabled) throw new HttpError(409, '请先停止采集，再保存研究参数');
      const next = strictLabConfig(value);
      atomicJson(controlPath, { schema: 1, enabled: false });
      atomicJson(configPath, next); config = next; configValid = true; failure = null; return state();
    }),
    async close() {
      closed = true; cleared();
      await operation;
      try { await halt(); } catch (error) { log.warn?.({ type: 'entropy-lighter', err: error }, '研究进程关闭未确认'); }
    },
    // Exposed only to tests/operators in the process, never an HTTP parameter.
    get directory() { return directory; },
  };
}

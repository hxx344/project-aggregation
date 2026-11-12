import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './atomic-json.mjs';
import { HttpError } from './http-common.mjs';

// Runs the real-venue contract probes (server/contract-probes/*.ts) for the workbench page.
// The probes keep every guard of their command-line use: read-only unless `--live` comes with
// the phrase their own read-only run printed, fixed size caps, no retry of a write whose
// outcome is unknown. This manager adds: one run at a time, parameters from a whitelist,
// paths fixed by the server, and a live run only from the latest read-only run of the same
// parameters, within LIVE_WINDOW_MS, with the phrase the page displayed.
//
// A probe's output goes to a file, not a pipe, so a runtime that exits does not by itself break
// the probe's wind-down. On a service stop systemd signals every process of the unit and kills
// what is left after its stop timeout; a second signal ends a probe at once, so close() never
// signals the child.
const SCRIPTS = Object.freeze({
  bybit: fileURLToPath(new URL('./contract-probes/bybit-chase.ts', import.meta.url)),
  aster: fileURLToPath(new URL('./contract-probes/aster-transfer.ts', import.meta.url)),
  canary: fileURLToPath(new URL('./contract-probes/oil-canary.ts', import.meta.url)),
});
export const BYBIT_PROBE_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT', 'SKHYUSDT', 'SKHYNIXUSDT']);
// The canary's executor code sits under platform/ of the install, outside the probe directory.
const INSTALL_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));
const PROBES = ['bybit', 'aster', 'canary'];
export const CANARY_SYMBOLS = Object.freeze(['CLUSDT', 'BZUSDT']);
const CANARY_STEPS = ['check', 'open', 'close', 'settle'];
const KEEP_RUNS = 10;
export const LIVE_WINDOW_MS = 10 * 60_000;
// Upper bound of a run that goes well, plus ten minutes; past it the probe is asked to stop once.
// Bybit: at most eight waits of the settle limit. ASTER: two transfers, and per nonce offset one
// probe and one return, each up to the settle limit plus two minutes of reads and send timeout;
// a stale offset first waits its own length and a refused one is watched 75 s plus its offset.
// Canary: the wait for a lapsed executor lease, a minute of preflight and reads, then the job's time
// limit (a settle step drives earlier jobs, each at most 600 s) and three minutes to make it final.
function runLimitMs(probe, params) {
  if (probe === 'canary') return 65_000 + 60_000 + (params.step === 'settle' ? 600 : params.timeoutS) * 1000 + 180_000 + 600_000;
  const settle = params.settleTimeoutS * 1000;
  if (probe === 'bybit') return 8 * settle + 600_000;
  const offsets = params.probeNonce;
  return (2 + 2 * offsets.length) * (settle + 120_000) + offsets.reduce((sum, value) => sum + Math.abs(value) * 1000 + 75_000, 0) + 600_000;
}
const TAIL_BYTES = 16_384, TAIL_LINES = 80, LINE_CHARS = 300, PARSE_BYTES = 262_144;
const REPORT_MAX_BYTES = 1_500_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIX = /^[A-Z][A-Z0-9_]{1,40}$/;
const PHRASE = /--live --confirm ([A-Za-z0-9._-]{1,160})/;

const bad = message => new HttpError(400, message);
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw bad('请求参数不正确');
  return body;
}
function decimal(value, fallback, name, max, digits) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,6}(?:\\.\\d{1,${digits}})?$`).test(value) || !(Number(value) > 0) || Number(value) > max) throw bad(`${name}须为大于 0 且不超过 ${max} 的数值`);
  return value;
}
function integer(value, fallback, name, low, high) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < low || value > high) throw bad(`${name}须为 ${low} 至 ${high} 的整数`);
  return value;
}
function flag(value, name) {
  if (value !== undefined && typeof value !== 'boolean') throw bad(`${name}选项不正确`);
  return value === true;
}

function bybitParams(input) {
  const body = fields(input, ['symbol', 'maxNotional', 'passiveBps', 'allowFill', 'settleTimeoutS']);
  if (!BYBIT_PROBE_SYMBOLS.includes(body.symbol)) throw bad('请选择测试标的');
  return { symbol: body.symbol, maxNotional: decimal(body.maxNotional, '50', '名义金额上限', 200, 2), passiveBps: integer(body.passiveBps, 200, '被动价距', 50, 2000),
    allowFill: flag(body.allowFill, '成交测试'), settleTimeoutS: integer(body.settleTimeoutS, 60, '结清等待', 10, 300) };
}
function asterParams(input, prefixes) {
  const body = fields(input, ['masterPrefix', 'aPrefix', 'bPrefix', 'amount', 'probeNonce', 'balancerPaused', 'settleTimeoutS', 'historyMinutes']);
  const chosen = [body.masterPrefix, body.aPrefix, body.bPrefix];
  if (chosen.some(value => typeof value !== 'string' || !PREFIX.test(value) || !prefixes.includes(value))) throw bad('请从 ASTER 模块已配置的账户中选择主账户与两个子账户');
  if (new Set(chosen).size !== 3) throw bad('主账户、子账户 A、子账户 B 必须互不相同');
  const offsets = body.probeNonce ?? [];
  if (!Array.isArray(offsets) || offsets.length > 8 || offsets.some(value => !Number.isInteger(value) || value === 0 || Math.abs(value) > 600) || new Set(offsets).size !== offsets.length)
    throw bad('nonce 偏移最多 8 个，每个为 ±600 秒内互不相同的非零整数');
  return { masterPrefix: body.masterPrefix, aPrefix: body.aPrefix, bPrefix: body.bPrefix, amount: decimal(body.amount, '1', '划转金额', 5, 8), probeNonce: [...offsets],
    balancerPaused: flag(body.balancerPaused, '保证金平衡'), settleTimeoutS: integer(body.settleTimeoutS, 300, '入账等待', 10, 900), historyMinutes: integer(body.historyMinutes, 30, '流水回看', 1, 1440) };
}

// The probe checks the same bounds again (platform/executor/src/live/canary.ts); these give the page a 400 instead of a failed run.
function canaryParams(input) {
  const body = fields(input, ['step', 'symbol', 'lead', 'leadSide', 'leadOrder', 'quantity', 'perJob', 'totalOpen', 'timeoutS', 'maxSlippageBps']);
  const pick = (value, allowed, name) => { if (!allowed.includes(value)) throw bad(`请选择${name}`); return value; };
  const step = pick(body.step, CANARY_STEPS, '金丝雀步骤');
  // A check or a settle places nothing new; the probe still parses a quantity, so they get a fixed one.
  const params = { step, symbol: pick(body.symbol, CANARY_SYMBOLS, '合约'), lead: pick(body.lead, ['binance', 'bybit'], '首腿交易所'),
    leadSide: pick(body.leadSide, ['long', 'short'], '首腿方向'), leadOrder: pick(body.leadOrder ?? 'market', ['market', 'chase'], '首腿下单方式'),
    quantity: decimal(step === 'open' || step === 'close' ? body.quantity : body.quantity ?? '1', undefined, '每腿数量', 10_000, 8), perJob: decimal(body.perJob, '100', '单笔名义金额上限', 200, 2),
    totalOpen: decimal(body.totalOpen, '300', '累计开仓名义金额上限', 500, 2), timeoutS: integer(body.timeoutS, 120, '最长执行秒数', 30, 600),
    maxSlippageBps: body.maxSlippageBps === undefined || body.maxSlippageBps === null ? null : integer(body.maxSlippageBps, null, '价格保护基点', 1, 200) };
  if (params.quantity === undefined) throw bad('请填写每腿数量');
  if (params.leadOrder === 'chase' && params.lead !== 'bybit') throw bad('只有 Bybit 首腿可以用原生追价');
  if (Number(params.perJob) > Number(params.totalOpen)) throw bad('单笔名义金额上限不得大于累计开仓上限');
  return params;
}

function tail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function createContractProbes({ dataDir, admit, readMaintenance, liveBlocker = () => null, log, now = Date.now, execPath = process.execPath, scripts = SCRIPTS, environment = process.env, platform = process.platform }) {
  if (typeof admit !== 'function' || typeof readMaintenance !== 'function') throw new TypeError('createContractProbes requires admit and readMaintenance');
  const directory = path.join(dataDir, 'contract-probes'), stateFile = path.join(directory, 'state.json');
  const asterEnv = path.join(dataDir, 'modules', 'aster', '.env');
  const iso = () => new Date(now()).toISOString();
  const fileOf = (id, kind) => path.join(directory, `${id}.${kind}`);
  // What the page sees of a run's output carries neither the data directory nor the install directory.
  const scriptDirectory = path.dirname(scripts.bybit);
  const pathless = text => text.replaceAll(directory + path.sep, '').replaceAll(dataDir, '数据目录').replaceAll(scriptDirectory, '程序目录').replaceAll(INSTALL_DIRECTORY, '安装目录' + path.sep);
  // Windows cannot deliver a stop signal a process can handle: a stop would end the probe without its wind-down.
  const blocker = probe => platform === 'win32' ? '真实运行只能在 Linux 服务器上的工作台进行：Windows 上停止会直接结束探测进程，无法收尾' : liveBlocker(probe);
  let runs = [], active = null, closed = false, prefixCache = { stamp: null, value: [] };

  function load() {
    let saved;
    try { saved = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return; }
    if (!Array.isArray(saved?.runs)) return;
    runs = saved.runs.filter(run => run && ID.test(run.id) && PROBES.includes(run.probe) && ['read-only', 'live'].includes(run.mode)).slice(0, 4 * KEEP_RUNS);
    let changed = false;
    for (const run of runs) if (run.status === 'running') {
      // The runtime that started it is gone; whether its wind-down finished is only in its report, if any.
      Object.assign(run, { status: 'interrupted', endedAt: iso(), ...parse(run), phrase: null }); changed = true;
    }
    if (changed) save();
  }
  function save() {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); atomicJson(stateFile, { runs }); }
    catch (error) { log?.warn?.({ err: error, type: 'contract-probe' }, '接口实测状态未能保存'); }
  }
  function parse(run) {
    const text = pathless(tail(fileOf(run.id, 'log'), PARSE_BYTES));
    const last = pattern => { const found = [...text.matchAll(pattern)].at(-1); return found ? found[1].trim().slice(0, 600) : null; };
    return { phrase: PHRASE.exec(text)?.[1] ?? null, outcome: last(/^结果：(.+)$/gm), error: last(/^(?:已中止|运行失败)：(.+)$/gm) };
  }
  function asterPrefixes() {
    let stamp;
    try { const stat = statSync(asterEnv); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { prefixCache = { stamp: null, value: [] }; return []; }
    if (stamp === prefixCache.stamp) return prefixCache.value;
    const seen = new Map();
    try {
      // Names only: no value of this file is kept or returned.
      for (const line of readFileSync(asterEnv, 'utf8').split(/\r?\n/)) {
        const found = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,40})_(USER|SIGNER|PRIVATE_KEY)\s*=\s*\S/.exec(line);
        if (found) seen.set(found[1], (seen.get(found[1]) ?? new Set()).add(found[2]));
      }
    } catch { return []; }
    prefixCache = { stamp, value: [...seen].filter(([, names]) => names.size === 3).map(([prefix]) => prefix).sort().slice(0, 64) };
    return prefixCache.value;
  }
  function args(probe, params, reportFile, phrase) {
    const live = phrase ? ['--live', '--confirm', phrase] : [];
    if (probe === 'canary') return ['--data-dir', dataDir, '--step', params.step, '--symbol', params.symbol, '--lead', params.lead, '--lead-side', params.leadSide,
      '--lead-order', params.leadOrder, '--quantity', params.quantity, '--per-job', params.perJob, '--total-open', params.totalOpen, '--timeout-s', String(params.timeoutS),
      ...(params.maxSlippageBps === null ? [] : ['--max-slippage-bps', String(params.maxSlippageBps)]), '--out', reportFile, ...live];
    if (probe === 'bybit') return ['--symbol', params.symbol, '--data-dir', dataDir, '--max-notional', params.maxNotional, '--passive-bps', String(params.passiveBps),
      '--settle-timeout-s', String(params.settleTimeoutS), '--out', reportFile, ...(params.allowFill ? ['--allow-fill'] : []), ...live];
    return ['--env-file', asterEnv, '--master-prefix', params.masterPrefix, '--a-prefix', params.aPrefix, '--b-prefix', params.bPrefix, '--amount', params.amount,
      '--settle-timeout-s', String(params.settleTimeoutS), '--history-minutes', String(params.historyMinutes), '--out', reportFile,
      ...(params.probeNonce.length ? [`--probe-nonce=${params.probeNonce.join(',')}`] : []), ...(params.balancerPaused ? ['--balancer-paused'] : []), ...live];
  }
  function prune() {
    while (runs.length > KEEP_RUNS) {
      // A run that still needs checking at the venue outlives the ordinary ones.
      const settled = runs.findLastIndex(run => run !== active?.run && run.status !== 'needs-check' && !(run.status === 'interrupted' && run.mode === 'live'));
      if (settled < 0) break;
      const [dropped] = runs.splice(settled, 1);
      for (const kind of ['log', 'json']) try { unlinkSync(fileOf(dropped.id, kind)); } catch { /* Already absent. */ }
    }
  }
  function launch(probe, mode, params, phrase, hold) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const run = { id: randomUUID(), probe, mode, params, status: 'running', startedAt: iso(), endedAt: null, exitCode: null, phrase: null, outcome: null, error: null, stopRequestedAt: null, forced: false, liveRunId: null };
    const limit = runLimitMs(probe, params);
    const descriptor = openSync(fileOf(run.id, 'log'), 'wx', 0o600);
    let child;
    try {
      // The probe reads its credentials itself (Bybit and the canary from the data directory, ASTER from the module's env file); none is passed here.
      child = spawn(execPath, [scripts[probe], ...args(probe, params, fileOf(run.id, 'json'), phrase)], { cwd: directory, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
        env: { PATH: environment.PATH ?? '', NODE_OPTIONS: '', NODE_PATH: '', ...(environment.SystemRoot ? { SystemRoot: environment.SystemRoot } : {}) } });
    } finally { closeSync(descriptor); }
    const entry = { run, child, hold, watchdog: null };
    const finish = (code, failure) => {
      if (active !== entry) return;
      active = null; clearTimeout(entry.watchdog); hold?.release();
      const parsed = parse(run);
      const sent = mode === 'live' && !failure && code !== 1;
      Object.assign(run, parsed, { endedAt: iso(), exitCode: Number.isInteger(code) ? code : null,
        phrase: mode === 'read-only' && code === 0 ? parsed.phrase : null,
        // A canary check, or a settle with nothing to settle, completes read-only without offering a live run.
        status: code === 0 && (mode === 'live' || parsed.phrase || probe === 'canary') ? 'completed' : sent ? 'needs-check' : mode === 'live' ? 'not-sent' : 'failed',
        error: failure ?? parsed.error });
      save();
      log?.info?.({ type: 'contract-probe', id: run.id, probe, mode, status: run.status, exitCode: run.exitCode }, '接口实测已结束');
    };
    // Without a pid the process never started; any later error leaves the verdict to its exit.
    child.on('error', () => { if (child.pid === undefined) finish(null, '无法启动探测进程，未发送任何请求'); });
    child.once('exit', code => finish(code, null));
    entry.watchdog = setTimeout(() => { if (active === entry && !run.stopRequestedAt) { run.stopRequestedAt = iso(); save(); child.kill('SIGTERM'); } }, limit);
    entry.watchdog.unref?.();
    active = entry; runs.unshift(run); prune(); save();
    log?.info?.({ type: 'contract-probe', id: run.id, probe, mode }, '接口实测已启动');
    return run;
  }
  const find = id => { const run = runs.find(item => item.id === id); if (!run) throw new HttpError(404, '没有这次测试记录'); return run; };
  function ready() {
    if (closed) throw new HttpError(503, '运行环境正在关闭，请稍后重试');
    if (active) throw new HttpError(409, '已有一项接口实测在运行，请等它结束');
  }
  function visible(run, withLog) {
    const { liveRunId, ...rest } = run;
    const lines = withLog ? pathless(tail(fileOf(run.id, 'log'), TAIL_BYTES)).split(/\r?\n/).filter(Boolean).slice(-TAIL_LINES).map(line => line.slice(0, LINE_CHARS)) : null;
    let hasReport = false;
    try { hasReport = statSync(fileOf(run.id, 'json')).size > 0; } catch { /* No report. */ }
    return { ...rest, usedForLive: liveRunId !== null, hasReport, ...(lines ? { log: lines } : {}) };
  }
  function state() {
    const latest = new Set(PROBES.map(probe => runs.find(run => run.probe === probe)?.id));
    return { observedAt: iso(), running: active?.run.id ?? null, maintenance: readMaintenance(), liveWindowMs: LIVE_WINDOW_MS,
      options: { bybit: { symbols: BYBIT_PROBE_SYMBOLS }, aster: { prefixes: asterPrefixes() }, canary: { symbols: CANARY_SYMBOLS } },
      liveBlocked: Object.fromEntries(PROBES.map(probe => [probe, blocker(probe)])),
      runs: runs.map(run => visible(run, latest.has(run.id))) };
  }

  load();
  return {
    state,
    /** A read-only run: the probe sends no order and no transfer. */
    start(input) {
      const body = fields(input, ['probe', 'params']);
      if (!PROBES.includes(body.probe)) throw bad('请选择要测试的接口');
      const params = body.probe === 'bybit' ? bybitParams(body.params) : body.probe === 'canary' ? canaryParams(body.params) : asterParams(body.params, asterPrefixes());
      ready();
      if (readMaintenance()) throw new HttpError(409, '系统正在更新或等待确认更新结果，暂不能开始测试');
      launch(body.probe, 'read-only', params, null, null);
      return state();
    },
    /** The live run of a finished read-only run: same parameters, the phrase that run printed. */
    live(id, input) {
      const body = fields(input, ['confirmLive', 'phrase']);
      if (body.confirmLive !== true || typeof body.phrase !== 'string') throw bad('真实运行前请确认会向交易所发送真实请求');
      const source = find(id);
      ready();
      if (source.mode !== 'read-only' || source.status !== 'completed' || !source.phrase) throw new HttpError(409, '请先完成一次只读检查');
      if (source.liveRunId || runs.find(run => run.probe === source.probe) !== source) throw new HttpError(409, '这次只读检查之后已有新的运行，请重新做只读检查');
      if (now() - Date.parse(source.endedAt) > LIVE_WINDOW_MS) throw new HttpError(409, `只读检查已超过 ${LIVE_WINDOW_MS / 60_000} 分钟，请重新检查`);
      if (body.phrase !== source.phrase) throw new HttpError(409, '确认内容与只读检查结果不一致，请刷新后重新确认');
      const blocked = blocker(source.probe);
      if (blocked) throw new HttpError(409, blocked);
      // Held until the probe exits, so an update cannot restart the runtime under a live run.
      const hold = admit();
      let run;
      try { run = launch(source.probe, 'live', source.params, source.phrase, hold); }
      catch (error) { hold.release(); throw error; }
      source.liveRunId = run.id; save();
      return state();
    },
    /** First request: the probe stops at its next step and winds down. With `force`, after that: it exits at once. */
    stop(id, input) {
      const body = fields(input, ['force']);
      const force = flag(body.force, '强制结束'), run = find(id);
      if (!active || active.run !== run) throw new HttpError(409, '这次测试没有在运行');
      if (run.stopRequestedAt && !force) throw new HttpError(409, '已请求停止，正在收尾');
      if (!run.stopRequestedAt && force) throw new HttpError(409, '请先请求停止，收尾未结束时再强制结束');
      if (run.stopRequestedAt) run.forced = true; else run.stopRequestedAt = iso();
      save();
      active.child.kill('SIGTERM');
      return state();
    },
    report(id) {
      const run = find(id), file = fileOf(run.id, 'json');
      let size;
      try { size = statSync(file).size; } catch { size = 0; }
      if (!size) throw new HttpError(404, '这次测试没有生成报告');
      if (size > REPORT_MAX_BYTES) throw new HttpError(409, '报告过大，无法在页面下载');
      try { return { id: run.id, report: JSON.parse(readFileSync(file, 'utf8')) }; }
      catch { throw new HttpError(409, '报告文件不完整，请稍后重试'); }
    },
    /** Resolves when no probe is running; for tests. */
    idle: () => new Promise(resolve => { const check = () => active ? setTimeout(check, 20) : resolve(); check(); }),
    // A probe still running keeps its update hold until that expires; only the renewal stops.
    close() { closed = true; if (active) { clearTimeout(active.watchdog); active.hold?.abandon(); } },
  };
}

import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from './logger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Initial design values (design doc 3.1): a crashed API restarts with this
// backoff, which resets once an instance stayed up API_STABLE_MS; an API that
// is not ready within API_READY_MS or does not stop within API_STOP_MS is
// ended. The runtime gets no deadline here: the service manager's apply.
const API_BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const API_STABLE_MS = 60_000, API_READY_MS = 60_000, API_STOP_MS = 30_000;
const running = child => child.exitCode === null && child.signalCode === null;

// Runs the runtime and the API as two child processes of one service unit.
// The runtime starts first and the API only once it is ready; the API restarts
// alone, and a runtime exit ends both with a non-zero code. stop() ends the API
// first, then the runtime. `done` resolves with the exit code for the unit;
// `onApiReady({ port, runtimePid, apiPid })` follows each API start.
export function launch({ runtimeEntry = path.join(here, 'runtime/main.mjs'), apiEntry = path.join(here, 'api/main.mjs'), env = process.env, logger = defaultLogger, onApiReady = () => {},
  apiBackoffMs = API_BACKOFF_MS, apiStableMs = API_STABLE_MS, apiReadyMs = API_READY_MS, apiStopMs = API_STOP_MS }) {
  let runtime = null, api = null, restartTimer = null, readyTimer = null, failures = 0, code = 0, stopping = null;
  let finish; const done = new Promise(resolve => { finish = resolve; });
  // `onExit({ ready, exitCode, signal })` runs once, also when the process could not be started.
  function start(entry, onReady, onExit) {
    const child = fork(entry, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let ready = false, ended = false;
    const end = (exitCode, signal) => { if (ended) return; ended = true; onExit({ ready, exitCode, signal }); };
    child.on('message', message => { if (!ready && message?.type === 'ready') { ready = true; onReady(message); } });
    child.once('exit', end);
    child.once('error', error => { logger.error({ err: error, entry, type: 'launcher' }, '子进程无法启动或通信失败'); if (!child.pid) end(null, null); });
    child.exited = new Promise(resolve => { if (!running(child)) resolve(); else child.once('exit', resolve); });
    return child;
  }
  const exitCode = ({ exitCode: value, signal }) => signal === null && Number.isInteger(value) ? value : 1;
  // While stopping, a child ended by the SIGTERM sent to it, or by the SIGINT a
  // terminal sends its process group (one that had no handler yet), stopped as
  // asked, as systemd counts a main process ended by SIGTERM.
  const stopCode = result => ['SIGTERM', 'SIGINT'].includes(result.signal) ? 0 : exitCode(result);
  function startApi() {
    restartTimer = null;
    if (stopping) return;
    let readyAt = null;
    readyTimer = setTimeout(() => { logger.error({ type: 'launcher' }, 'API 未在期限内就绪，正在结束'); child.kill('SIGKILL'); }, apiReadyMs);
    const child = api = start(apiEntry, message => {
      clearTimeout(readyTimer); readyAt = Date.now();
      logger.info({ port: message.port, type: 'startup' }, '工作台 API 已就绪');
      onApiReady({ port: message.port, runtimePid: runtime?.pid ?? null, apiPid: child.pid });
    }, result => {
      clearTimeout(readyTimer); api = null;
      if (stopping) { code = Math.max(code, stopCode(result)); return; }
      if (readyAt !== null && Date.now() - readyAt >= apiStableMs) failures = 0;
      const delay = apiBackoffMs[Math.min(failures, apiBackoffMs.length - 1)]; failures += 1;
      logger.error({ exitCode: result.exitCode, signal: result.signal, delay, type: 'launcher' }, 'API 进程已退出，稍后重启');
      restartTimer = setTimeout(startApi, delay);
    });
  }
  async function terminate(child, graceMs) {
    if (!child || !running(child)) return;
    child.kill('SIGTERM');
    const timer = graceMs ? setTimeout(() => { logger.error({ type: 'launcher' }, 'API 未在期限内退出，正在强制结束'); child.kill('SIGKILL'); }, graceMs) : null;
    await child.exited; clearTimeout(timer);
  }
  function stop(value = 0) {
    code = Math.max(code, value);
    return stopping ??= (async () => {
      // The stop deadline applies from here on, not the ready deadline.
      clearTimeout(restartTimer); clearTimeout(readyTimer);
      await terminate(api, apiStopMs);
      await terminate(runtime, null);
      finish(code);
      return code;
    })();
  }
  runtime = start(runtimeEntry, () => { if (!stopping) startApi(); }, result => {
    if (stopping) { code = Math.max(code, stopCode(result)); return; }
    logger.error({ exitCode: result.exitCode, signal: result.signal, ready: result.ready, type: 'launcher' }, '运行时进程已退出，正在结束工作台');
    runtime = null; void stop(1);
  });
  return { done, stop };
}

// The service entry (server/index.mjs): logs the address once the first API is
// ready and ends with the unit's exit code. A repeated signal is ignored, as in
// the children. Settings the API would refuse on every start end the unit
// instead of restarting the API forever.
export async function runLauncher({ env = process.env, logger = defaultLogger, start = launch } = {}) {
  const port = Number(env.PORT || 3100);
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1 至 65535');
    if (env.PUBLIC_ORIGIN) (await import('./adapters.mjs')).validateAuthOrigin(env.PUBLIC_ORIGIN);
  } catch (error) { logger.error({ err: error, type: 'startup' }, '工作台配置无效'); process.exitCode = 1; return; }
  let started = false;
  const launcher = start({ env, logger, onApiReady: ({ port }) => {
    if (started) return;
    started = true;
    const host = env.HOST || '127.0.0.1';
    logger.info({ port, host, type: 'startup' }, `工作台已启动：http://${host}:${port}`);
  } });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!stopping) logger.info({ signal, type: 'shutdown' }, '收到关闭信号，正在依次停止 API 与运行时'); stopping = true; void launcher.stop(0); });
  process.exitCode = await launcher.done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLauncher();

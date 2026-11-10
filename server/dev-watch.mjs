import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { logger as defaultLogger } from './logger.mjs';

// `pnpm dev:server` (design: docs/evolution-plan.md, E3). On Linux it runs the
// launcher, so development has the runtime and API as separate processes like
// production; other platforms keep the single-process workbench under
// `node --watch`, as the split processes are tested on Linux only.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// The sources the launcher's processes load: the workbench itself and the
// server side of each module (the module pages are built separately).
const WATCHED = ['server', 'modules/monitor/server', 'modules/monitor/lib', 'modules/monitor/modules', 'modules/monitor/web', 'modules/crossex/server', 'modules/asset/lib', 'modules/asset/scripts', 'modules/greeks/app', 'modules/aster/trading'];
const IGNORED = /(?:^|[\\/])(?:node_modules|__pycache__|\.pytest_cache)(?:[\\/]|$)|\.(?:log|pyc|swp|tmp)$|~$/;
// A restart waits for the whole group: the launcher stops the API (75 s) and
// then the runtime (150 s), so the group gets both plus a margin before it is
// killed (docs/timeout-budgets.md). Processes still carrying the group's
// marker after that are killed and given RESIDUE_GRACE_MS to go; so is a
// killed group that does not report its exit.
const STOP_MS = 240_000, RESIDUE_GRACE_MS = 5000, DEBOUNCE_MS = 300;
export const DEV_RUN_ENV = 'WORKBENCH_DEV_RUN';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// A group's marker names the watch that started it and the repository, so a
// later watch can tell the groups a dead watch left behind (`<pid>:<id>:<root>`).
const markerOf = (pid, id) => `${pid}:${id}:${root}`;
const orphaned = value => {
  const [, pid, rest] = /^(\d+):[^:]+:(.*)$/.exec(value) ?? [];
  return rest === root && Number(pid) !== process.pid && !alive(Number(pid));
};

/**
 * Live processes, other than this one, whose environment sets `name` to
 * `value`, or to a value `value(found)` accepts (Linux).
 */
export function findMarked(name, value) {
  const prefix = `${name}=`, found = [];
  const accepts = typeof value === 'function' ? value : candidate => candidate === value;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    // A zombie or another user's process has no readable environment.
    let environment;
    try { environment = readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
    const entry = environment.split('\0').find(item => item.startsWith(prefix));
    if (entry !== undefined && accepts(entry.slice(prefix.length))) found.push(Number(pid));
  }
  return found;
}

// Runs one process group at a time. Module workers lead process groups of
// their own, so the group is told by an environment marker every descendant
// inherits, not by its process group. Groups a dead watch of this repository
// left are ended before the first start. `close()` resolves with the pids of
// this watch's groups that could not be ended.
export function createDevWatch({ entry = path.join(root, 'server', 'launcher.mjs'), roots = WATCHED.map(dir => path.join(root, dir)), env = process.env, logger = defaultLogger,
  stopMs = STOP_MS, residueGraceMs = RESIDUE_GRACE_MS, debounceMs = DEBOUNCE_MS, probeMs = 100, scan = findMarked,
  spawnProcess = spawn, signalProcess = (pid, signal) => process.kill(pid, signal) } = {}) {
  let group = null, timer = null, queued = false, closing = null, cycle = Promise.resolve(), starts = 0;
  const watchers = [], runs = [];
  // Retain the selector even when cleanup throws or the parent has exited.
  // A later source change may retry cleanup, but cannot forget the old group.
  const pendingResidue = new Set([orphaned]);
  const log = (level, fields, message) => logger[level]({ type: 'dev-watch', ...fields }, message);
  // Lifecycle steps run one after another, so a group never starts before the last one left.
  const enqueue = (work, propagate = false) => {
    const pending = cycle.then(work);
    cycle = pending.catch(error => { log('error', { err: error }, '开发进程组操作失败'); return []; });
    return propagate ? pending : cycle;
  };

  function start() {
    const run = markerOf(process.pid, randomUUID());
    runs.push(run); starts += 1;
    // Its own process group, so a terminal's Ctrl-C reaches only this watch,
    // which then stops the group in the launcher's order.
    const child = spawnProcess(process.execPath, [entry], { env: { ...env, [DEV_RUN_ENV]: run }, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
    const current = { child, run, stopping: false };
    current.exited = new Promise(resolve => {
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
      child.once('error', error => { log('error', { err: error }, '工作台进程组无法启动'); if (!child.pid) resolve({ exitCode: null, signal: null }); });
    });
    group = current;
    void current.exited.then(result => {
      if (current.stopping) return;
      void enqueue(async () => {
        if (group !== current) return;
        group = null;
        pendingResidue.add(run);
        log('warn', result, '工作台进程组已退出，源码变更后再启动');
        await cleanupResidue();
      });
    });
  }
  // A process found later (forked meanwhile) is killed as well.
  async function residue(marker, message = '进程组退出后仍有残留进程，正在强制结束') {
    let left = scan(DEV_RUN_ENV, marker);
    if (!left.length) return left;
    log('warn', { pids: left }, message);
    const deadline = Date.now() + residueGraceMs;
    while (left.length) {
      for (const pid of left) { try { signalProcess(pid, 'SIGKILL'); } catch {} }
      if (Date.now() >= deadline) break;
      await delay(probeMs);
      left = scan(DEV_RUN_ENV, marker);
    }
    if (left.length) log('error', { pids: left }, '残留进程未能结束');
    return left;
  }
  async function cleanupResidue() {
    const remaining = new Set();
    for (const marker of pendingResidue) {
      const left = await residue(marker, marker === orphaned ? '发现已退出的 watch 留下的工作台进程，正在强制结束' : undefined);
      if (left.length) for (const pid of left) remaining.add(pid);
      else pendingResidue.delete(marker);
    }
    return [...remaining];
  }
  const bounded = (promise, ms) => {
    let expiry;
    const expired = new Promise(resolve => { expiry = setTimeout(resolve, ms, 'expired'); });
    return Promise.race([promise, expired]).finally(() => clearTimeout(expiry));
  };
  async function stopGroup() {
    const current = group;
    if (!current) return cleanupResidue();
    current.stopping = true;
    pendingResidue.add(current.run);
    const { child } = current;
    // A group that already left may have had its pid reused.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { signalProcess(child.pid, 'SIGTERM'); } catch {}
      if (await bounded(current.exited, stopMs) === 'expired') {
        log('error', { stopMs }, '工作台进程组未在期限内退出，正在强制结束');
        kill(current);
        if (await bounded(current.exited, residueGraceMs) === 'expired') log('error', { pid: child.pid }, '工作台进程未报告退出');
      }
    }
    const left = await cleanupResidue();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      // /proc scanning alone cannot replace the parent's observed exit.
      pendingResidue.add(current.run);
      return [...new Set([...left, child.pid])];
    }
    group = null;
    return left;
  }
  const kill = current => { if (current.child.pid && current.child.exitCode === null && current.child.signalCode === null) { try { signalProcess(-current.child.pid, 'SIGKILL'); } catch {} } };
  // Changes that arrive before a restart starts the next group are covered by
  // it: that group loads the sources as they are then.
  function changed(file) {
    if (closing) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (queued || closing) return;
      queued = true;
      void enqueue(async () => {
        try {
          log('info', { file: path.relative(root, file) }, '源码已变更，正在重启工作台进程组');
          const left = await stopGroup();
          if (left.length) log('error', { pids: left }, '旧进程尚未清理完成，已阻止启动；下次源码变更时重试');
          else if (!closing) start();
        } finally { queued = false; }
      });
    }, debounceMs);
  }
  for (const dir of roots) {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        const file = name ? path.join(dir, String(name)) : dir;
        if (!IGNORED.test(file)) changed(file);
      });
      watcher.on('error', error => log('error', { err: error, dir }, '源码监视失败'));
      watchers.push(watcher);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      log('warn', { dir }, '监视目录不存在，已跳过');
    }
  }
  void enqueue(async () => {
    const left = await cleanupResidue();
    if (left.length) log('error', { pids: left }, '孤儿进程尚未清理完成，已阻止首次启动；下次源码变更时重试');
    else if (!closing) start();
  });
  function close() {
    return closing ??= (clearTimeout(timer), enqueue(async () => {
      for (const watcher of watchers.splice(0)) watcher.close();
      const left = await stopGroup();
      return [...new Set([...left, ...runs.flatMap(run => scan(DEV_RUN_ENV, run))])];
    }, true));
  }
  // Ends the running group at once instead of waiting for its stop (a second Ctrl-C).
  const forceStop = () => { if (group) kill(group); };
  return { close, changed, forceStop, get pid() { return group?.child.pid ?? null; }, get starts() { return starts; } };
}

export async function runDevWatch({ platform = process.platform, logger = defaultLogger } = {}) {
  if (platform !== 'linux') {
    // The terminal's Ctrl-C reaches the child itself; a SIGTERM is passed on.
    const child = spawn(process.execPath, ['--watch', path.join(root, 'server', 'workbench.mjs')], { stdio: 'inherit' });
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.exitCode = await new Promise(resolve => {
      child.once('error', error => { logger.error({ err: error, type: 'dev-watch' }, '工作台无法启动'); resolve(1); });
      child.once('exit', code => resolve(code ?? 1));
    });
    return;
  }
  const devWatch = createDevWatch({ logger });
  let signals = 0;
  await new Promise(resolve => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
      signals += 1;
      if (signals === 1) logger.info({ signal, type: 'dev-watch' }, '收到关闭信号，正在停止工作台进程组，再按一次立即结束');
      else { logger.warn({ signal, type: 'dev-watch' }, '再次收到关闭信号，立即结束工作台进程组'); devWatch.forceStop(); }
      resolve();
    });
  });
  try {
    const left = await devWatch.close();
    process.exitCode = left.length ? 1 : 0;
  } catch (error) {
    logger.error({ err: error, type: 'dev-watch' }, '无法确认开发进程已全部退出');
    process.exitCode = 1;
  }
}

if (import.meta.main) await runDevWatch();

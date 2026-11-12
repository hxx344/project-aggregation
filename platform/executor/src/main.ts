// Independent entry point of the executor. It owns a separate data directory,
// refuses the legacy workbench data directory and listens on loopback only
// (plan 1, 8). Without --live-config it runs simulated venues; with it, the
// live canary (3.0c): one Binance and one Bybit account, notional caps, no
// shared writer registry and no ASTER transfers or ADL.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { WAL_SIZE_LIMIT_BYTES, openStore } from './store.ts';
import { createExecutor, type Executor } from './executor.ts';
import type { Environment } from './contracts.ts';
import { createLiveConnectors, loadLiveConfig, loadLiveCredentials, preflightLive } from './live/setup.ts';
import { SIM_BINDINGS, SIM_TRANSFER_PAIR, createSimulatedVenues } from './simulation.ts';
import { createExecutorServer } from './http.ts';

const LEGACY_MARKERS = ['hub.sqlite', 'execution-control.sqlite', 'credentials.key', 'modules'];
const TICK_MS = 1_000;
const WAL_CHECK_MS = 1_000;
/** Consecutive failed passes before the entry gives up the lease and exits, so another instance can take over. */
const MAX_TICK_FAILURES = 5;

/**
 * The directory and every ancestor are checked after resolving links, so neither a
 * subdirectory of the workbench data directory nor a link into it is accepted.
 * Names compare case-insensitively because Windows and macOS file systems do.
 */
export function assertDedicatedDataDir(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('--data-dir 必须是绝对路径');
  const path = resolve(dir);
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  for (let current = realpathSync.native(existing); ; current = dirname(current)) {
    let names: string[] = [];
    try { names = readdirSync(current); } catch { /* an unreadable ancestor cannot be the workbench data directory of this user */ }
    const found = names.find(name => LEGACY_MARKERS.includes(name.toLowerCase()));
    if (found) throw new Error(`拒绝使用工作台数据目录（${current} 含 ${found}）；执行器原型必须使用独立数据目录，且不能位于工作台代码或数据目录之下`);
    if (dirname(current) === current) break;
  }
  return path;
}

const ENVIRONMENT_MARKER = 'environment';
/**
 * Binds the data directory to one environment for good: jobs, accounts and ledgers of simulated venues must never be read
 * as real ones, nor the other way round. A directory used before the marker existed ran simulated venues only.
 */
export function claimDataDirEnvironment(dir: string, environment: Environment): void {
  const marker = join(dir, ENVIRONMENT_MARKER);
  let recorded: string | null = null;
  try { recorded = readFileSync(marker, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`数据目录环境标记无法读取：${(error as Error).message}`); }
  const current = recorded ?? (existsSync(join(dir, 'executor.sqlite')) ? 'simulated' : null);
  if (current !== null && current !== environment) throw new Error(`数据目录已用于${current === 'mainnet' ? '实盘' : current === 'simulated' ? '模拟' : `未知环境（${current.slice(0, 32)}）`}，不能以${environment === 'mainnet' ? '实盘' : '模拟'}模式启动；请另用一个数据目录`);
  if (recorded === null) writeFileSync(marker, `${environment}\n`, { mode: 0o600, flag: 'wx' });
}

/**
 * Writes the login link to <dir>/access-url and returns that path. The token never
 * reaches stdout or logs; whoever can read the data directory can log in. The
 * temporary file plus rename keeps a reader from seeing a half-written link.
 */
export function writeAccessUrl(dir: string, port: number, token: string): string {
  const target = join(dir, 'access-url');
  const temp = join(dir, `.access-url.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `http://127.0.0.1:${port}/login?token=${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } catch (error) { rmSync(temp, { force: true }); throw error; }
  return target;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string', default: '4710' }, 'live-config': { type: 'string' } } });
  if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
  const dir = assertDedicatedDataDir(values['data-dir']);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
  const live = values['live-config'] === undefined ? null : loadLiveConfig(values['live-config']);
  // Keys are read and every account checked before the data directory is touched, so a bad key leaves nothing behind.
  const liveConnectors = live ? createLiveConnectors(live, loadLiveCredentials(live.credentialsFile)) : null;
  if (live && liveConnectors) await preflightLive(live, liveConnectors);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  claimDataDirEnvironment(dir, live ? 'mainnet' : 'simulated');

  const store = openStore(join(dir, 'executor.sqlite'));
  let executor: Executor;
  if (live && liveConnectors) {
    executor = createExecutor({ store, connectors: liveConnectors, environment: 'mainnet', notionalLimits: live.notionalLimits });
    if (!executor.acquire()) throw new Error('另一个执行器实例持有写入租约；等待其租约过期后再启动');
    for (const binding of live.accounts) executor.registerAccount(binding);
  } else {
    const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
    executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
    if (!executor.acquire()) throw new Error('另一个执行器实例持有写入租约；等待其租约过期后再启动');
    for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
    // A new pair starts disabled; an existing one keeps its switch and settings.
    if (!executor.transferPairs().some(pair => pair.id === SIM_TRANSFER_PAIR.id) && !executor.corruptTransferPairs().includes(SIM_TRANSFER_PAIR.id)) executor.registerTransferPair(SIM_TRANSFER_PAIR);
  }

  // Lease renewal runs apart from the passes so a slow venue call cannot let the lease lapse.
  const heartbeat = setInterval(() => {
    try { if (!executor.acquire() && !stopping) { process.stderr.write('执行器已失去写入租约，停止\n'); process.exitCode = 1; void shutdown(); } }
    catch (error) { process.stderr.write(`续租失败：${error instanceof Error ? error.message : String(error)}\n`); }
  }, Math.floor(executor.budgets.leaseTtlMs / 3));
  // Automatic checkpoints cannot reset the WAL while some reader is always active; the owner truncates it past a threshold.
  let walOverLimit = false;
  const walCheck = setInterval(() => {
    // An instance that lost the lease leaves the database to its new owner.
    if (stopping || executor.retired) return;
    try {
      const { walBytes } = store.maintainWal();
      const over = walBytes > WAL_SIZE_LIMIT_BYTES;
      if (over && !walOverLimit) process.stderr.write(`WAL 已达 ${Math.round(walBytes / 2 ** 20)} MiB，超过 64 MiB 上限：有读取方长时间占用快照，截断无法完成\n`);
      walOverLimit = over;
    } catch (error) { process.stderr.write(`WAL 维护失败：${error instanceof Error ? error.message : String(error)}\n`); }
  }, WAL_CHECK_MS);
  let stopping = false;
  let loops: Promise<void>[] = [];
  // Waits that a shutdown cuts short, so no loop keeps the exit waiting out its spacing.
  const sleepers = new Set<() => void>();
  const pause = (ms: number) => new Promise<void>(resolve => {
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  });
  // Jobs, transfers and ADL each run on their own schedule, so a venue that answers slowly holds up only its own loop (2.4a).
  // A loop that no longer runs must not keep the lease alive: exit and let another instance take over.
  const passLoop = (label: string, pass: () => Promise<void>) => (async () => {
    let failures = 0;
    while (!stopping && !executor.retired) {
      try { await pass(); failures = 0; }
      catch (error) {
        failures += 1;
        process.stderr.write(`${label}失败（${failures}/${MAX_TICK_FAILURES}）：${error instanceof Error ? error.message : String(error)}\n`);
        if (executor.retired || failures >= MAX_TICK_FAILURES) break;
      }
      if (stopping || executor.retired) break;
      await pause(TICK_MS * (failures + 1));
    }
    if (!stopping) { process.exitCode = 1; void shutdown(); }
  })();
  const accessToken = randomBytes(32).toString('base64url');
  const server = createExecutorServer({ executor, accessToken });
  server.on('error', error => { process.stderr.write(`HTTP 监听失败：${error.message}\n`); process.exitCode = 1; void shutdown(); });
  server.listen(port, '127.0.0.1', () => {
    try { process.stdout.write(`${live ? `执行器（实盘金丝雀：单笔上限 ${live.notionalLimits.perJob} USDT，累计开仓上限 ${live.notionalLimits.totalOpen} USDT）` : '执行器原型（模拟传输）'}已启动，登录链接已写入 ${writeAccessUrl(dir, port, accessToken)}\n`); }
    catch (error) { process.stderr.write(`写入登录链接失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; void shutdown(); }
  });
  // Started after the server exists; declared first, so a loop that ends at once can still shut everything down.
  loops = [passLoop('两腿任务循环', executor.tickJobs), passLoop('划转循环', executor.tickTransfers), passLoop('ADL 循环', executor.tickAdl)];
  // The position display reads on its own schedule, so a slow read neither waits for the passes nor holds them up (L049).
  loops.push((async () => {
    while (!stopping && !executor.retired) {
      const started = Date.now();
      try { await executor.refreshPositions(); }
      catch (error) { process.stderr.write(`持仓读取轮失败：${error instanceof Error ? error.message : String(error)}\n`); }
      // A shutdown that arrived during the round must not wait out another spacing.
      if (stopping || executor.retired) break;
      await pause(Math.max(TICK_MS, executor.budgets.positionsRefreshMs - (Date.now() - started)));
    }
  })());

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    clearInterval(walCheck);
    executor.close();
    server.close();
    for (const wake of [...sleepers]) wake();
    await Promise.all(loops);
    store.close();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

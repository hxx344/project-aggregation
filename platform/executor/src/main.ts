// Independent entry point of the phase 1 executor prototype. It owns a separate
// data directory, refuses the legacy workbench data directory and runs only
// simulated venues on loopback (plan 1, 8).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from './store.ts';
import { createExecutor } from './executor.ts';
import { SIM_BINDINGS, SIM_TRANSFER_PAIR, createSimulatedVenues } from './simulation.ts';
import { createExecutorServer } from './http.ts';

const LEGACY_MARKERS = ['hub.sqlite', 'execution-control.sqlite', 'credentials.key', 'modules'];
const TICK_MS = 1_000;
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
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string', default: '4710' } } });
  if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
  const dir = assertDedicatedDataDir(values['data-dir']);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const store = openStore(join(dir, 'executor.sqlite'));
  const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
  const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading });
  if (!executor.acquire()) throw new Error('另一个执行器实例持有写入租约；等待其租约过期后再启动');
  for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
  // A new pair starts disabled; an existing one keeps its switch and settings.
  if (!executor.transferPairs().some(pair => pair.id === SIM_TRANSFER_PAIR.id) && !executor.corruptTransferPairs().includes(SIM_TRANSFER_PAIR.id)) executor.registerTransferPair(SIM_TRANSFER_PAIR);

  // Lease renewal runs apart from the tick so a slow venue call cannot let the lease lapse.
  const heartbeat = setInterval(() => {
    try { if (!executor.acquire() && !stopping) { process.stderr.write('执行器已失去写入租约，停止\n'); process.exitCode = 1; void shutdown(); } }
    catch (error) { process.stderr.write(`续租失败：${error instanceof Error ? error.message : String(error)}\n`); }
  }, Math.floor(executor.budgets.leaseTtlMs / 3));
  let stopping = false;
  // A loop that no longer runs must not keep the lease alive: exit and let another instance take over.
  const loop = (async () => {
    let failures = 0;
    while (!stopping && !executor.retired) {
      try { await executor.tick(); failures = 0; }
      catch (error) {
        failures += 1;
        process.stderr.write(`执行循环失败（${failures}/${MAX_TICK_FAILURES}）：${error instanceof Error ? error.message : String(error)}\n`);
        if (executor.retired || failures >= MAX_TICK_FAILURES) break;
      }
      await new Promise(resolve => setTimeout(resolve, TICK_MS * (failures + 1)));
    }
    if (!stopping) { process.exitCode = 1; void shutdown(); }
  })();

  const accessToken = randomBytes(32).toString('base64url');
  const server = createExecutorServer({ executor, accessToken });
  server.on('error', error => { process.stderr.write(`HTTP 监听失败：${error.message}\n`); process.exitCode = 1; void shutdown(); });
  server.listen(port, '127.0.0.1', () => {
    try { process.stdout.write(`执行器原型（模拟传输）已启动，登录链接已写入 ${writeAccessUrl(dir, port, accessToken)}\n`); }
    catch (error) { process.stderr.write(`写入登录链接失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; void shutdown(); }
  });
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    executor.close();
    server.close();
    await loop;
    store.close();
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });

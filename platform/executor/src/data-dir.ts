// The executor data directory's environment marker and database names, shared by the entry (main.ts) and the
// workbench-driven live canary (live/canary.ts).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Environment } from './contracts.ts';

const ENVIRONMENT_MARKER = 'environment';
/**
 * The live database has its own name, so code that predates the marker (a rollback) opens an empty database in a live
 * directory instead of reconciling real jobs against simulated venues.
 */
export const DATABASE_FILES: Readonly<Record<Environment, string>> = { simulated: 'executor.sqlite', mainnet: 'executor-live.sqlite' };
/**
 * Binds the data directory to one environment for good: jobs, accounts and ledgers of simulated venues must never be read
 * as real ones, nor the other way round. A directory used before the marker existed ran simulated venues only.
 */
export function claimDataDirEnvironment(dir: string, environment: Environment): void {
  const marker = join(dir, ENVIRONMENT_MARKER);
  let recorded: string | null = null;
  try { recorded = readFileSync(marker, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`数据目录环境标记无法读取：${(error as Error).message}`); }
  // Without a marker the database file tells: one predating the marker, or a marker lost in a crash before it reached disk.
  const current = recorded ?? (existsSync(join(dir, DATABASE_FILES.mainnet)) ? 'mainnet' : existsSync(join(dir, DATABASE_FILES.simulated)) ? 'simulated' : null);
  if (current !== null && current !== environment) throw new Error(`数据目录已用于${current === 'mainnet' ? '实盘' : current === 'simulated' ? '模拟' : `未知环境（${current.slice(0, 32)}）`}，不能以${environment === 'mainnet' ? '实盘' : '模拟'}模式启动；请另用一个数据目录`);
  if (recorded !== null) return;
  let fd: number;
  try { fd = openSync(marker, 'wx', 0o600); }
  catch (error) {
    // Another start wrote it first: judge again by what it wrote.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return claimDataDirEnvironment(dir, environment);
    throw new Error(`数据目录环境标记无法写入：${(error as Error).message}`);
  }
  try { writeSync(fd, `${environment}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dirFd = openSync(dir, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

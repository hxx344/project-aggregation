// Live canary wiring (3.0c): the operator's config file, the key file and the startup checks. Keys stay in memory only;
// no message built here carries a key, a secret or a fragment of the key file.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { ContractError, exactKeys, parseBinding, parseNotionalLimits, type AccountBinding, type NotionalLimits, type Venue } from '../contracts.ts';
import type { VenueConnector } from '../connector.ts';
import { createBinanceConnector } from './binance.ts';
import { createBybitConnector } from './bybit.ts';
import type { FetchLike } from './http.ts';
import { describe, validCredentials, type LiveCredentials } from './values.ts';

/** The canary trades one account on each of these. */
export const LIVE_VENUES = ['binance', 'bybit'] as const satisfies readonly Venue[];
const MAX_FILE_BYTES = 64 * 1024;
const PREFLIGHT_TIMEOUT_MS = 30_000;

export interface LiveConfig { notionalLimits: NotionalLimits; credentialsFile: string; accounts: AccountBinding[] }

/** Reads a small regular file this user owns and nobody else can read or write; the open descriptor is checked, not the path. */
function readPrivateFile(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name}必须是绝对路径`);
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw new Error('实盘模式只在 Linux 上运行（需要检查文件属主与权限、按账户加进程锁）');
  let fd: number;
  // Non-blocking, so a FIFO in place of the file fails the regular-file check instead of hanging the start.
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch (error) { throw new Error(`${name}无法打开：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${name}不是普通文件`);
    if (stat.uid !== process.getuid()) throw new Error(`${name}不属于当前用户`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${name}权限过宽，须为 600（chmod 600 ${path}）`);
    // Bounded read: the file can still grow after fstat.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (let read; length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += read;
    if (length > MAX_FILE_BYTES) throw new Error(`${name}超过 64 KiB`);
    return buffer.toString('utf8', 0, length);
  } finally { closeSync(fd); }
}
/** JSON.parse messages quote the text around the error, so they never reach the operator for a file that may hold keys. */
function parsePrivateJson(text: string, name: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${name}不是有效的 JSON`); }
}
const explain = (error: unknown, name: string): Error => new Error(`${name}无效：${error instanceof ContractError ? error.message : describe(error)}`);

/**
 * The operator's live config: { notionalLimits: { perJob, totalOpen }, credentialsFile: <absolute path>,
 * accounts: [{ venue, accountId, accountMode, credentialVersion }, …] } with exactly one account per live venue.
 * It holds no keys but chooses the accounts and the caps, so it gets the same ownership check as the key file.
 */
export function loadLiveConfig(path: string): LiveConfig {
  const raw = parsePrivateJson(readPrivateFile(path, '实盘配置文件'), '实盘配置文件');
  try {
    const value = exactKeys(raw, ['notionalLimits', 'credentialsFile', 'accounts']);
    const notionalLimits = parseNotionalLimits(value.notionalLimits);
    if (typeof value.credentialsFile !== 'string' || !isAbsolute(value.credentialsFile)) throw new Error('credentialsFile 必须是绝对路径');
    if (!Array.isArray(value.accounts) || value.accounts.length !== LIVE_VENUES.length) throw new Error(`accounts 必须恰好列出 ${LIVE_VENUES.join('、')} 各一个账户`);
    const accounts = value.accounts.map(item => parseBinding({ ...exactKeys(item, ['venue', 'accountId', 'accountMode', 'credentialVersion']), environment: 'mainnet' }));
    for (const venue of LIVE_VENUES) if (accounts.filter(account => account.venue === venue).length !== 1) throw new Error(`accounts 必须恰好列出 ${LIVE_VENUES.join('、')} 各一个账户`);
    return { notionalLimits, credentialsFile: value.credentialsFile, accounts };
  } catch (error) { throw explain(error, '实盘配置文件'); }
}

/** The key file: { binance: { apiKey, apiSecret }, bybit: { apiKey, apiSecret } }. */
export function loadLiveCredentials(path: string): Map<Venue, LiveCredentials> {
  const raw = parsePrivateJson(readPrivateFile(path, '密钥文件'), '密钥文件');
  // Field names are never echoed: a key pasted in place of a name would otherwise reach the message.
  const exactly = (value: unknown, names: readonly string[], where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) throw new Error(`密钥文件无效：${where}的字段须恰好为 ${names.join('、')}`);
    return value as Record<string, unknown>;
  };
  const value = exactly(raw, LIVE_VENUES, '顶层');
  const keys = new Map<Venue, LiveCredentials>();
  for (const venue of LIVE_VENUES) {
    const entry = exactly(value[venue], ['apiKey', 'apiSecret'], ` ${venue} `);
    const credentials = { apiKey: entry.apiKey, apiSecret: entry.apiSecret } as LiveCredentials;
    if (!validCredentials(credentials)) throw new Error(`密钥文件无效：${venue} 的密钥不完整或格式无效`);
    keys.set(venue, credentials);
  }
  return keys;
}

/**
 * One live executor per real account on this host, whatever its data directory: two instances would each keep their own
 * notional total and treat the other's orders as foreign. The lock is a Linux abstract socket, released by the kernel
 * when the process ends, so a crash leaves no stale lock.
 */
export async function holdAccountLocks(accounts: readonly AccountBinding[]): Promise<{ release(): void }> {
  if (process.platform !== 'linux') throw new Error('实盘模式只在 Linux 上运行（按账户加进程锁）');
  const servers: ReturnType<typeof createServer>[] = [];
  const release = () => { for (const server of servers) server.close(); };
  try {
    for (const account of accounts) {
      const server = createServer(socket => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        server.once('error', error => reject((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? new Error(`${account.venue} 账户 ${account.accountId} 已被本机另一个实盘执行器占用`) : error));
        server.listen(`\0pa-executor-live/${account.venue}/${account.accountId}`, () => resolve());
      });
      server.unref();
      servers.push(server);
    }
  } catch (error) { release(); throw error; }
  return { release };
}

/**
 * Live connectors whose key resolves only for the configured account and credential version, so a stale binding in the
 * database can never borrow the key of another account.
 */
export function createLiveConnectors(config: Pick<LiveConfig, 'accounts'>, keys: Map<Venue, LiveCredentials>, options: { fetchImpl?: FetchLike; now?: () => number } = {}): VenueConnector[] {
  const credentials = (binding: AccountBinding): LiveCredentials => {
    const account = config.accounts.find(item => item.venue === binding.venue);
    const key = keys.get(binding.venue);
    if (!account || !key || account.accountId !== binding.accountId || account.accountMode !== binding.accountMode || account.credentialVersion !== binding.credentialVersion) throw new Error('该账户不是实盘配置里的账户或凭据版本');
    return key;
  };
  return [createBinanceConnector({ credentials, ...options }), createBybitConnector({ credentials, ...options })];
}

/** Every configured account passes its venue's key and identity check, one after another, before any is registered. */
export async function preflightLive(config: Pick<LiveConfig, 'accounts'>, connectors: readonly VenueConnector[], timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<void> {
  for (const account of config.accounts) {
    const connector = connectors.find(item => item.venue === account.venue);
    if (!connector?.preflight) throw new Error(`${account.venue} 连接器没有启动检查，拒绝实盘启动`);
    try { await connector.preflight(account, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw new Error(`${account.venue} 账户 ${account.accountId} 启动检查未通过：${describe(error)}`); }
  }
}

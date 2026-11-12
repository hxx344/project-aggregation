// Live canary wiring (3.0c): the operator's config file, the key file and the startup checks. Keys stay in memory only;
// no message built here carries a key, a secret or a fragment of the key file.
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
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
  if (process.platform === 'win32' || typeof process.getuid !== 'function') throw new Error('实盘模式只在 Linux 或 macOS 上运行（需要检查文件属主与权限）');
  let fd: number;
  try { fd = openSync(path, 'r'); } catch (error) { throw new Error(`${name}无法打开：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${name}不是普通文件`);
    if (stat.uid !== process.getuid()) throw new Error(`${name}不属于当前用户`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${name}权限过宽，须为 600（chmod 600 ${path}）`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${name}超过 64 KiB`);
    return readFileSync(fd, 'utf8');
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
  const keys = new Map<Venue, LiveCredentials>();
  try {
    const value = exactKeys(raw, LIVE_VENUES);
    for (const venue of LIVE_VENUES) {
      const entry = exactKeys(value[venue], ['apiKey', 'apiSecret']);
      const credentials = { apiKey: entry.apiKey, apiSecret: entry.apiSecret } as LiveCredentials;
      if (!validCredentials(credentials)) throw new Error(`${venue} 的密钥不完整或格式无效`);
      keys.set(venue, credentials);
    }
  } catch (error) { throw explain(error, '密钥文件'); }
  return keys;
}

/**
 * Live connectors whose key resolves only for the configured account and credential version, so a stale binding in the
 * database can never borrow the key of another account.
 */
export function createLiveConnectors(config: LiveConfig, keys: Map<Venue, LiveCredentials>, options: { fetchImpl?: FetchLike; now?: () => number } = {}): VenueConnector[] {
  const credentials = (binding: AccountBinding): LiveCredentials => {
    const account = config.accounts.find(item => item.venue === binding.venue);
    const key = keys.get(binding.venue);
    if (!account || !key || account.accountId !== binding.accountId || account.accountMode !== binding.accountMode || account.credentialVersion !== binding.credentialVersion) throw new Error('该账户不是实盘配置里的账户或凭据版本');
    return key;
  };
  return [createBinanceConnector({ credentials, ...options }), createBybitConnector({ credentials, ...options })];
}

/** Every configured account passes its venue's key and identity check, one after another, before any is registered. */
export async function preflightLive(config: LiveConfig, connectors: readonly VenueConnector[], timeoutMs = PREFLIGHT_TIMEOUT_MS): Promise<void> {
  for (const account of config.accounts) {
    const connector = connectors.find(item => item.venue === account.venue);
    if (!connector?.preflight) throw new Error(`${account.venue} 连接器没有启动检查，拒绝实盘启动`);
    try { await connector.preflight(account, { signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw new Error(`${account.venue} 账户 ${account.accountId} 启动检查未通过：${describe(error)}`); }
  }
}

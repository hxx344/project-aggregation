import { createHash } from 'node:crypto';
import type { openDatabase } from './sqlite.ts';

export type TradingExchange = 'binance' | 'bybit' | 'okx';
type Database = Pick<ReturnType<typeof openDatabase>, 'prepare'>;
type ConnectionRow = { exchange: string; encrypted: string; updated_at: string };
type Unseal = (encrypted: string, context: string) => Promise<unknown>;
type Credentials = { apiKey: string; apiSecret: string; passphrase?: string };
type ExportInput = { exchange: TradingExchange; revision: string; password: string };
export type TradingConnectionMetadata = {
  exchange: TradingExchange;
  configured: boolean;
  revision: string | null;
  label: string | null;
  updatedAt: string | null;
  supported: boolean;
  reason: string | null;
};

const EXCHANGES = ['binance', 'bybit', 'okx'] as const;
const PASSWORD_WINDOW_MS = 15 * 60_000;
const PASSWORD_ATTEMPTS = 5;
const INVALID_CONNECTION = 'Asset 连接无法用于导入，请在 Asset 重新保存连接';
const SOURCE_CHANGED = 'Asset 连接已变更，请刷新连接列表后重试';
const UNAVAILABLE = 'Asset 连接服务暂不可用，请稍后重试';

export class TradingExportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TradingExportError';
    this.status = status;
  }
}

/** Only errors created here are public; storage and crypto errors never cross the API. */
export function tradingExportFailure(error: unknown) {
  return error instanceof TradingExportError
    ? { error: error.message, status: error.status }
    : { error: UNAVAILABLE, status: 503 };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseTradingExportInput(value: unknown, workspaceAuthorized = false): ExportInput {
  if (!record(value) || Object.keys(value).length !== (workspaceAuthorized ? 2 : 3)
    || !Object.keys(value).every(key => (workspaceAuthorized ? ['exchange', 'revision'] : ['exchange', 'revision', 'password']).includes(key))
    || !EXCHANGES.some(exchange => exchange === value.exchange)
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/i.test(value.revision)
    || (!workspaceAuthorized && (typeof value.password !== 'string' || value.password.length < 1 || value.password.length > 256))) {
    throw new TradingExportError('输入格式不正确', 400);
  }
  return { exchange: value.exchange as TradingExchange, revision: value.revision.toLowerCase(), password: workspaceAuthorized ? '' : value.password as string };
}

/** Fingerprint the exact stored encrypted blob, never the credential plaintext. */
export function tradingConnectionRevision(encrypted: string) {
  return createHash('sha256').update(encrypted, 'utf8').digest('hex');
}

function validateCredentials(value: unknown, exchange: TradingExchange): Credentials {
  const fields = exchange === 'okx' ? ['exchange', 'apiKey', 'apiSecret', 'passphrase'] : ['exchange', 'apiKey', 'apiSecret', 'region'];
  if (!record(value) || value.exchange !== exchange
    || !Object.keys(value).every(key => fields.includes(key))) {
    throw new TradingExportError(INVALID_CONNECTION, 409);
  }
  if ((exchange === 'bybit' && value.region !== 'global')
    || (exchange === 'binance' && value.region !== undefined && value.region !== 'global')) {
    throw new TradingExportError('Hub 交易仅支持 global 地区连接，请在 Asset 更新连接', 409);
  }
  if (typeof value.apiKey !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(value.apiKey)
    || typeof value.apiSecret !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(value.apiSecret)) {
    throw new TradingExportError(INVALID_CONNECTION, 409);
  }
  if (exchange === 'okx') {
    if (typeof value.passphrase !== 'string' || value.passphrase.length < 8 || value.passphrase.length > 128
      || /[\u0000-\u001f\u007f-\u009f]/.test(value.passphrase)) {
      throw new TradingExportError(INVALID_CONNECTION, 409);
    }
    return { apiKey: value.apiKey, apiSecret: value.apiSecret, passphrase: value.passphrase };
  }
  return { apiKey: value.apiKey, apiSecret: value.apiSecret };
}

async function readConnection(database: Database, owner: string, exchange: TradingExchange) {
  // Query one explicitly allowed exchange; Aster credentials are never read or unsealed.
  return database.prepare('SELECT exchange,encrypted,updated_at FROM connections WHERE owner = ? AND exchange = ?')
    .bind(owner, exchange).first<ConnectionRow>();
}

function validRow(row: ConnectionRow, exchange: TradingExchange) {
  return row.exchange === exchange && typeof row.encrypted === 'string'
    && row.encrypted.length > 0 && row.encrypted.length <= 32_768;
}

export async function readTradingConnections(database: Database, owner: string, unseal: Unseal, options: { includeOkx?: boolean } = {}) {
  const exchanges = options.includeOkx === false ? EXCHANGES.filter(exchange => exchange !== 'okx') : EXCHANGES;
  const connections = await Promise.all(exchanges.map(async exchange => {
    const metadata: TradingConnectionMetadata = {
      exchange, configured: false, revision: null, label: null, updatedAt: null, supported: true, reason: null,
    };
    const row = await readConnection(database, owner, exchange);
    if (!row) return metadata;
    try {
      if (!validRow(row, exchange)) throw new TradingExportError(INVALID_CONNECTION, 409);
      const credential = validateCredentials(await unseal(row.encrypted, owner + ':' + exchange), exchange);
      return {
        ...metadata, configured: true, revision: tradingConnectionRevision(row.encrypted), label: credential.apiKey.slice(-4),
        updatedAt: typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at))
          ? new Date(row.updated_at).toISOString() : null,
      };
    } catch (error) {
      return { ...metadata, supported: false, reason: error instanceof TradingExportError ? error.message : INVALID_CONNECTION };
    }
  }));
  return { schemaVersion: 1 as const, connections };
}

async function reservePasswordAttempt(database: Database, owner: string, now: number) {
  const id = 'hub-trading-export:' + owner;
  const cutoff = now - PASSWORD_WINDOW_MS;
  // The SQL statement reserves a slot atomically before password verification yields.
  // Use a separate namespace from login limits, and cap growth for rejected requests.
  const reserved = await database.prepare(`INSERT INTO auth_attempts(id,started_at,attempts) VALUES(?,?,1)
    ON CONFLICT(id) DO UPDATE SET
      started_at=CASE WHEN started_at <= ? THEN excluded.started_at ELSE started_at END,
      attempts=CASE WHEN started_at <= ? THEN 1 ELSE attempts+1 END
    WHERE started_at <= ? OR attempts < ? RETURNING started_at`)
    .bind(id, now, cutoff, cutoff, cutoff, PASSWORD_ATTEMPTS).first<{ started_at: number }>();
  if (!reserved) throw new TradingExportError('密码尝试次数过多，请 15 分钟后重试', 429);
  return { id, startedAt: reserved.started_at };
}

async function checkRevision(database: Database, owner: string, input: ExportInput) {
  const row = await readConnection(database, owner, input.exchange);
  if (!row || !validRow(row, input.exchange) || tradingConnectionRevision(row.encrypted) !== input.revision) {
    throw new TradingExportError(SOURCE_CHANGED, 409);
  }
  return row;
}

/**
 * Caller must authenticate the owner, enforce same-origin JSON requests, and deliver
 * this response only over the private worker transport or trusted HTTPS/loopback.
 * A session alone is insufficient: standalone exports recheck the Asset password;
 * managed exports require the process-only workspace authorization checked by the route.
 */
export async function exportTradingConnection(
  database: Database,
  owner: string,
  value: unknown,
  dependencies: { unseal: Unseal; verifyPassword: (password: string) => Promise<boolean>; now?: () => number; workspaceAuthorized?: boolean },
) {
  const input = parseTradingExportInput(value, dependencies.workspaceAuthorized === true);
  await checkRevision(database, owner, input);
  if (dependencies.workspaceAuthorized !== true) {
    const attempt = await reservePasswordAttempt(database, owner, (dependencies.now ?? Date.now)());
    if (!await dependencies.verifyPassword(input.password)) throw new TradingExportError('Asset 登录密码不正确', 401);
    // Refund only this successful reservation in the same window. Never clear other failures.
    await database.prepare('UPDATE auth_attempts SET attempts = MAX(0, attempts - 1) WHERE id = ? AND started_at = ?')
      .bind(attempt.id, attempt.startedAt).run();
  }
  const row = await checkRevision(database, owner, input);
  let credentials: Credentials;
  try {
    credentials = validateCredentials(await dependencies.unseal(row.encrypted, owner + ':' + input.exchange), input.exchange);
  } catch (error) {
    if (error instanceof TradingExportError) throw error;
    throw new TradingExportError(INVALID_CONNECTION, 409);
  }
  await checkRevision(database, owner, input);
  return { schemaVersion: 1 as const, exchange: input.exchange, revision: input.revision, region: 'global' as const, credentials };
}

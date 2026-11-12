// Read-only access to the execution accounts the workbench's trading center saved (hub.sqlite execution_accounts,
// decrypted with credentials.key), for the probes the workbench starts with its own data directory.
import { createDecipheriv } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProbeAbort } from './common.ts';

const NAMES: Record<string, string> = { binance: 'Binance', bybit: 'Bybit' };
export interface WorkbenchAccount { exchange: string; apiKey: string; apiSecret: string; accountMode: string; identity: string | null; revision: number }
interface Row { exchange: string; credentials: string | null; account_mode: string; identity: string | null; revision: number }

/** Every requested exchange must have a saved key; nothing is created or changed in the data directory. */
export function readWorkbenchAccounts(dataDir: string, exchanges: readonly string[]): WorkbenchAccount[] {
  // Same layout as server/runtime/credentials.mjs (iv 12 | tag 16 | ciphertext, AES-256-GCM), read-only:
  // that loader would create a key file when none exists, which a probe must never do.
  let key: Buffer;
  try { key = readFileSync(join(dataDir, 'credentials.key')); } catch { throw new ProbeAbort('数据目录中没有 credentials.key'); }
  if (key.length !== 32) throw new ProbeAbort('credentials.key 长度不正确');
  // A read-only connection to a cold WAL database can leave -wal/-shm files owned by whoever runs this (LESSONS L063),
  // which stops the workbench service from opening it. Without pending WAL pages the file is read as immutable; with
  // them the workbench must be running, so its -shm exists and nothing new is created.
  const file = join(dataDir, 'hub.sqlite'), size = (suffix: string): number | null => { try { return statSync(file + suffix).size; } catch { return null; } };
  if (size('') === null) throw new ProbeAbort('数据目录中没有 hub.sqlite');
  if (size('-journal')) throw new ProbeAbort('hub.sqlite 有未完成的回滚日志，请改用环境变量提供凭据');
  const pending = Boolean(size('-wal'));
  if (pending && size('-shm') === null) throw new ProbeAbort('hub.sqlite 有未合并的 WAL 而工作台未在运行：请先启动工作台，或改用环境变量提供凭据');
  const database = new DatabaseSync(pending ? file : pathToFileURL(file).href + '?immutable=1', { readOnly: true });
  let rows: Row[];
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=750');
    rows = database.prepare(`SELECT exchange, credentials, account_mode, identity, revision FROM execution_accounts WHERE exchange IN (${exchanges.map(() => '?').join(',')})`).all(...exchanges) as unknown as Row[];
  } finally { database.close(); }
  return exchanges.map(exchange => {
    const row = rows.find(item => item.exchange === exchange), name = NAMES[exchange] ?? exchange;
    if (!row || typeof row.credentials !== 'string' || !row.credentials) throw new ProbeAbort(`工作台没有保存 ${name} 执行账户`);
    try {
      const buffer = Buffer.from(row.credentials, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString());
      const secrets = value as Record<string, unknown>;
      if (typeof value !== 'object' || value === null || typeof secrets.apiKey !== 'string' || typeof secrets.apiSecret !== 'string' || !secrets.apiKey || !secrets.apiSecret) throw new Error();
      return { exchange, apiKey: secrets.apiKey, apiSecret: secrets.apiSecret, accountMode: row.account_mode, identity: typeof row.identity === 'string' && row.identity ? row.identity : null, revision: Number(row.revision) };
    } catch { throw new ProbeAbort(`无法解密工作台保存的 ${name} 执行账户`); }
  });
}

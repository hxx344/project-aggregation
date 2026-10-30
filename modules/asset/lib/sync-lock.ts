import { randomUUID } from 'node:crypto';
import type { openDatabase } from './sqlite.ts';

type Database = Pick<ReturnType<typeof openDatabase>, 'prepare' | 'transaction'>;
export const LOCK_TTL_MS = 120_000;
export const LOCK_RENEW_MS = 30_000;
/** A task holding the lock longer than this stops renewing; once the TTL runs out it can no longer write. */
export const LOCK_MAX_HOLD_MS = 600_000;
export const LOCK_BUSY = '资产正在更新，请稍后重试';
export const LOCK_LOST = '资产更新超时或已被其他操作接替，本次结果未保存';

export type SyncLease = {
  readonly token: string;
  /** Verify ownership and run the synchronous writes in one transaction; throws LOCK_LOST and writes nothing once ownership is gone. */
  write<T>(run: () => Synchronous<T>): T;
  release(): Promise<void>;
};
/** Writes run inside a transaction, so an async callback (writing after an await, outside it) is a type error. */
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;
type Options = { now?: () => number; ttlMs?: number; renewMs?: number; maxHoldMs?: number };

/**
 * Owner-scoped ledger lock with a per-acquisition token. Expiry lets a new task in but does not
 * stop the old one, so every write re-checks the token and expiry, and release only removes its own lock.
 */
export async function acquireSyncLock(database: Database, owner: string, options: Options = {}): Promise<SyncLease> {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? LOCK_TTL_MS, maxHold = options.maxHoldMs ?? LOCK_MAX_HOLD_MS;
  const token = randomUUID(), acquiredAt = now();
  const result = await database.prepare('INSERT INTO sync_locks(owner,expires,token) VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET expires=excluded.expires,token=excluded.token WHERE sync_locks.expires < ?')
    .bind(owner, acquiredAt + ttl, token, acquiredAt).run();
  if (!result.meta.changes) throw new Error(LOCK_BUSY);
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    const at = now();
    // Past the hold limit the lease is left to expire; a stuck task cannot keep others out forever.
    if (at - acquiredAt >= maxHold) return stop();
    // A failed renewal (busy or closed database) must not escape the timer and crash the process;
    // the lease then simply expires and later writes are refused.
    try {
      const renewed = database.prepare('UPDATE sync_locks SET expires = ? WHERE owner = ? AND token = ? AND expires >= ?').bind(Math.min(at + ttl, acquiredAt + maxHold), owner, token, at).execute();
      if (!renewed.meta.changes) stop();
    } catch { stop(); }
  }, options.renewMs ?? LOCK_RENEW_MS);
  timer.unref?.();
  function stop() { clearInterval(timer); timer = undefined; }
  return {
    token,
    write(run) {
      return database.transaction(() => {
        const held = database.prepare('SELECT 1 AS held FROM sync_locks WHERE owner = ? AND token = ? AND expires >= ?').bind(owner, token, now()).get();
        if (!held) throw new Error(LOCK_LOST);
        return run();
      });
    },
    async release() {
      stop();
      await database.prepare('DELETE FROM sync_locks WHERE owner = ? AND token = ?').bind(owner, token).run();
    },
  };
}

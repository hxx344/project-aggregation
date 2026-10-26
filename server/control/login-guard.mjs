import { randomUUID } from 'node:crypto';
import { immediate } from './schema.mjs';

// Per-IP attempts within a window, and the account's failures, password checks
// in flight and lock deadline, shared by every API instance on hub.sqlite
// (docs/api-dual-slot.md 4.2). Each step is one short write transaction; the
// password check itself runs outside them.
export const IP_ATTEMPT_LIMIT = 10, ACCOUNT_LOCKOUT_THRESHOLD = 5;
// A check in flight that its process never finished stops counting after this.
const PENDING_MS = 30_000;

export function createLoginGuard({ db, stmt }, { loginWindowMs, accountLockoutMs }) {
  const pending = (account, now) => stmt.prepare('SELECT COUNT(*) AS n FROM login_pending WHERE account=? AND expires>?').get(account, now).n;
  // A lock expires at its deadline; unlocked failures expire one lockout period
  // after the first one. A record with a check in flight stays, so that check's
  // failure still counts against it.
  function expire(account, now) {
    stmt.prepare('DELETE FROM login_pending WHERE expires<=?').run(now);
    const row = stmt.prepare('SELECT * FROM login_account_guard WHERE account=?').get(account);
    if (row && !pending(account, now) && (row.until ? row.until <= now : now - row.first_failure_at >= accountLockoutMs)) {
      stmt.prepare('DELETE FROM login_account_guard WHERE account=?').run(account);
      return null;
    }
    return row || null;
  }
  const lockedUntil = row => row?.until || 0;
  return {
    // Counts an attempt from `ip` before its body is read; null when the window's quota is used up.
    reserveIp: (ip, now) => immediate(db, () => {
      stmt.prepare('DELETE FROM login_ip_attempts WHERE until<?').run(now);
      const row = stmt.prepare('SELECT count, until FROM login_ip_attempts WHERE ip=?').get(ip);
      if (row && row.count >= IP_ATTEMPT_LIMIT) return null;
      const until = row ? row.until : now + loginWindowMs;
      stmt.prepare('INSERT INTO login_ip_attempts(ip,count,until) VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=count+1').run(ip, until);
      return { ip, until };
    }),
    // Gives a successful login's attempt back, only within the window it was counted in.
    refundIp: ({ ip, until }) => immediate(db, () => {
      stmt.prepare('UPDATE login_ip_attempts SET count=count-1 WHERE ip=? AND until=? AND count>0').run(ip, until);
      stmt.prepare('DELETE FROM login_ip_attempts WHERE ip=? AND count<=0').run(ip);
    }),
    // The lock deadline in force, or 0.
    lockedUntil: (account, now) => immediate(db, () => { const until = lockedUntil(expire(account, now)); return until > now ? until : 0; }),
    // Takes one of the account's remaining failures for a password check:
    // { locked: until }, { exhausted: true } or { id } to finish with failure(), success() or release().
    reserveAccount: (account, now) => immediate(db, () => {
      const row = expire(account, now);
      if (lockedUntil(row) > now) return { locked: row.until };
      if ((row?.failed || 0) + pending(account, now) >= ACCOUNT_LOCKOUT_THRESHOLD) return { exhausted: true };
      const id = randomUUID();
      stmt.prepare('INSERT INTO login_pending(id,account,expires) VALUES (?,?,?)').run(id, account, now + PENDING_MS);
      return { id, account };
    }),
    // Ends a check that neither failed nor succeeded (it threw).
    release: ({ id }) => immediate(db, () => { stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id); }),
    // Counts a failed check: { failed, lockedUntil } where lockedUntil is a lock
    // set earlier (still in force) or the one this failure set, else 0; `lockedNow` says which.
    failure: ({ id, account }, now) => immediate(db, () => {
      stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id);
      const row = stmt.prepare('SELECT * FROM login_account_guard WHERE account=?').get(account);
      const failed = (row?.failed || 0) + 1;
      const firstFailureAt = row?.failed ? row.first_failure_at : now;
      if (lockedUntil(row) > now) {
        stmt.prepare('UPDATE login_account_guard SET failed=? WHERE account=?').run(failed, account);
        return { failed, lockedUntil: row.until, lockedNow: false };
      }
      const until = failed >= ACCOUNT_LOCKOUT_THRESHOLD ? now + accountLockoutMs : 0;
      stmt.prepare('INSERT INTO login_account_guard(account,failed,first_failure_at,until) VALUES (?,?,?,?) ON CONFLICT(account) DO UPDATE SET failed=excluded.failed, first_failure_at=excluded.first_failure_at, until=excluded.until')
        .run(account, failed, firstFailureAt, until);
      return { failed, lockedUntil: until, lockedNow: until > 0 };
    }),
    // A correct password: refused with the deadline when concurrent failures
    // locked the account meanwhile, otherwise the failures are cleared and 0 returned.
    success: ({ id, account }, now) => immediate(db, () => {
      stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id);
      const row = stmt.prepare('SELECT * FROM login_account_guard WHERE account=?').get(account);
      if (lockedUntil(row) > now) return row.until;
      if (row && pending(account, now)) stmt.prepare('UPDATE login_account_guard SET failed=0, first_failure_at=0, until=0 WHERE account=?').run(account);
      else stmt.prepare('DELETE FROM login_account_guard WHERE account=?').run(account);
      return 0;
    }),
  };
}

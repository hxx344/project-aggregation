import { randomUUID } from 'node:crypto';
import { immediate } from './schema.mjs';

// Per-IP attempts within a window, and the account's failures, password checks
// in flight and lock deadline, shared by every API instance on hub.sqlite
// (docs/api-dual-slot.md 4.2). Each step is one short write transaction; the
// password check itself runs outside them.
export const IP_ATTEMPT_LIMIT = 10, ACCOUNT_LOCKOUT_THRESHOLD = 5;
// A check in flight that never finished (its process died, or recording its
// result failed) counts as one failure after this.
const PENDING_MS = 30_000;

export function createLoginGuard({ db, stmt }, { loginWindowMs, accountLockoutMs }) {
  const pending = (account, now) => stmt.prepare('SELECT COUNT(*) AS n FROM login_pending WHERE account=? AND expires>?').get(account, now).n;
  const guardRow = account => stmt.prepare('SELECT * FROM login_account_guard WHERE account=?').get(account);
  const ipRow = ip => stmt.prepare('SELECT count, until FROM login_ip_attempts WHERE ip=?').get(ip);
  const lockedUntil = row => row?.until || 0;
  // Adds `n` failures: { failed, lockedUntil } where lockedUntil is a lock set
  // earlier (still in force) or the one these failures set, else 0; `lockedNow` says which.
  function addFailures(account, n, now) {
    const row = guardRow(account);
    const failed = (row?.failed || 0) + n;
    const firstFailureAt = row?.failed ? row.first_failure_at : now;
    if (lockedUntil(row) > now) {
      stmt.prepare('UPDATE login_account_guard SET failed=? WHERE account=?').run(failed, account);
      return { failed, lockedUntil: row.until, lockedNow: false };
    }
    const until = failed >= ACCOUNT_LOCKOUT_THRESHOLD ? now + accountLockoutMs : 0;
    stmt.prepare('INSERT INTO login_account_guard(account,failed,first_failure_at,until) VALUES (?,?,?,?) ON CONFLICT(account) DO UPDATE SET failed=excluded.failed, first_failure_at=excluded.first_failure_at, until=excluded.until')
      .run(account, failed, firstFailureAt, until);
    return { failed, lockedUntil: until, lockedNow: until > 0 };
  }
  const stale = (row, at) => row.until ? row.until <= at : at - row.first_failure_at >= accountLockoutMs;
  // A lock expires at its deadline; unlocked failures expire one lockout period
  // after the first one. A record with a check in flight stays, so that check's
  // failure still counts against it. Lapsed checks become failures at the moment
  // their lease ended, however late this runs; the record they count against was
  // kept for them, so it is not judged stale before they are counted. Returns the
  // account's record and whether a lapsed check set the lock in force.
  function expire(account, now) {
    let lockedNow = false;
    for (const lapsed of stmt.prepare('DELETE FROM login_pending WHERE expires<=? RETURNING account, expires').all(now).sort((x, y) => x.expires - y.expires)) {
      const result = addFailures(lapsed.account, 1, lapsed.expires);
      if (lapsed.account === account && result.lockedNow && result.lockedUntil > now) lockedNow = true;
    }
    const row = guardRow(account);
    if (row && !pending(account, now) && stale(row, now)) {
      stmt.prepare('DELETE FROM login_account_guard WHERE account=?').run(account);
      return { row: null, lockedNow: false };
    }
    return { row: row || null, lockedNow };
  }
  const ipExhausted = (row, now) => row && row.until >= now && row.count >= IP_ATTEMPT_LIMIT;
  return {
    // Admits a login attempt before its body is read: { locked: until, lockedNow }
    // when the account is locked (lockedNow: a lapsed check just locked it),
    // { limited: true } when the IP's quota is used up, otherwise the counted
    // attempt { ip, until }. Refusals visible without the write lock skip it.
    admit: (account, ip, now) => {
      const row = guardRow(account);
      if (lockedUntil(row) > now) return { locked: row.until, lockedNow: false };
      if (ipExhausted(ipRow(ip), now)) return { limited: true };
      return immediate(db, () => {
        const current = expire(account, now);
        if (lockedUntil(current.row) > now) return { locked: current.row.until, lockedNow: current.lockedNow };
        stmt.prepare('DELETE FROM login_ip_attempts WHERE until<?').run(now);
        const attempts = ipRow(ip);
        if (ipExhausted(attempts, now)) return { limited: true };
        const until = attempts ? attempts.until : now + loginWindowMs;
        stmt.prepare('INSERT INTO login_ip_attempts(ip,count,until) VALUES (?,1,?) ON CONFLICT(ip) DO UPDATE SET count=count+1').run(ip, until);
        return { ip, until };
      });
    },
    // Takes one of the account's remaining failures for a password check:
    // { locked: until, lockedNow } as admit() reports it, { exhausted: true } or { id }
    // to finish with failure(), success() or release().
    reserveAccount: (account, now) => immediate(db, () => {
      const { row, lockedNow } = expire(account, now);
      if (lockedUntil(row) > now) return { locked: row.until, lockedNow };
      if ((row?.failed || 0) + pending(account, now) >= ACCOUNT_LOCKOUT_THRESHOLD) return { exhausted: true };
      const id = randomUUID();
      stmt.prepare('INSERT INTO login_pending(id,account,expires) VALUES (?,?,?)').run(id, account, now + PENDING_MS);
      return { id, account };
    }),
    // Ends a check that neither failed nor succeeded (it threw).
    release: ({ id }) => immediate(db, () => { stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id); }),
    // Counts a failed check, as addFailures() reports it. A check that outlived
    // its lease was counted when the lease expired and is not counted again.
    failure: ({ id, account }, now) => immediate(db, () => {
      if (stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id).changes) return addFailures(account, 1, now);
      const row = guardRow(account);
      return { failed: row?.failed || 0, lockedUntil: lockedUntil(row) > now ? row.until : 0, lockedNow: false };
    }),
    // A correct password: refused with the deadline when concurrent failures
    // locked the account meanwhile, otherwise the failures are cleared, the
    // IP attempt is given back within the window it was counted in, and 0 returned.
    success: ({ id, account }, { ip, until }, now) => immediate(db, () => {
      stmt.prepare('DELETE FROM login_pending WHERE id=?').run(id);
      const row = guardRow(account);
      if (lockedUntil(row) > now) return row.until;
      if (row && pending(account, now)) stmt.prepare('UPDATE login_account_guard SET failed=0, first_failure_at=0, until=0 WHERE account=?').run(account);
      else stmt.prepare('DELETE FROM login_account_guard WHERE account=?').run(account);
      stmt.prepare('UPDATE login_ip_attempts SET count=count-1 WHERE ip=? AND until=? AND count>0').run(ip, until);
      stmt.prepare('DELETE FROM login_ip_attempts WHERE ip=? AND count<=0').run(ip);
      return 0;
    }),
  };
}

// SQLite write lock statistics of this process (design doc 5.6), shared by the
// transaction helper in server/control/schema.mjs and the HTTP error mapping.

// node:sqlite reports SQLITE_BUSY (and its extended codes) as ERR_SQLITE_ERROR with the primary code in the low byte.
export const isSqliteBusy = error => error?.code === 'ERR_SQLITE_ERROR' && (error.errcode & 0xff) === 5;

// Counts are cumulative: `transactions` and their `waitBuckets` for every
// BEGIN IMMEDIATE that got the lock, `busy` for those that ran out of
// busy_timeout instead, `busyReplies` for requests answered 503 because of a
// busy write (also autocommit statements, which are not timed). The peaks are
// since the last log line, so each line shows its own interval.
export const WRITE_WAIT_BUCKETS_MS = [1, 10, 100, 1000, 5000];
const writes = { transactions: 0, busy: 0, busyReplies: 0, waitBuckets: Array(WRITE_WAIT_BUCKETS_MS.length + 1).fill(0), maxWaitMs: 0, maxHoldMs: 0 };
const bucketOfWait = ms => { const index = WRITE_WAIT_BUCKETS_MS.findIndex(limit => ms < limit); return index < 0 ? WRITE_WAIT_BUCKETS_MS.length : index; };
export const writeWaitStats = () => ({ ...writes, waitBuckets: [...writes.waitBuckets] });
export function recordWait(ms) { writes.transactions++; writes.waitBuckets[bucketOfWait(ms)]++; writes.maxWaitMs = Math.max(writes.maxWaitMs, ms); }
export function recordHold(ms) { writes.maxHoldMs = Math.max(writes.maxHoldMs, ms); }
export function recordBusy() { writes.busy++; }
export function recordBusyReply() { writes.busyReplies++; }

// Logs the statistics when they changed since this logger's last line, also when
// stopped; the journal keeps the distribution. One logger per process: every
// line resets the shared peaks. A line the logger failed to write is kept for
// the next try; a failure in the timer does not end the process, stop() lets
// the caller see it.
export function logWriteWaits({ logger = console, role, intervalMs = 15 * 60_000 }) {
  let logged = 0;
  const log = () => {
    const stats = writeWaitStats(), total = stats.transactions + stats.busy + stats.busyReplies;
    if (total === logged) return;
    logger.info?.({ type: 'sqlite_write_waits', role, bucketsMs: WRITE_WAIT_BUCKETS_MS, ...stats, maxWaitMs: Math.round(stats.maxWaitMs), maxHoldMs: Math.round(stats.maxHoldMs) }, 'SQLite 写锁等待统计');
    logged = total; writes.maxWaitMs = 0; writes.maxHoldMs = 0;
  };
  const timer = setInterval(() => { try { log(); } catch { /* the next interval or stop() writes it */ } }, intervalMs); timer.unref?.();
  return () => { clearInterval(timer); log(); };
}

import { randomUUID } from 'node:crypto';
import { immediate } from './schema.mjs';

// The one definition of a finished native execution job, shared by the
// executor and the update coordinator's idle check. The recovery admission
// keeps its own copy, so it reads a checkpoint without the server modules.
export const FINAL_EXECUTION = new Set(['completed', 'stopped']);
// The executor's execution_jobs_unfinished partial index is defined by this
// expression; a query must repeat it for SQLite to use that index.
const JOB_STATUS = "json_extract(json,'$.status')";
export const UNFINISHED_EXECUTION_JOB_SQL = `(${JOB_STATUS} IS NULL OR ${JOB_STATUS} NOT IN (${[...FINAL_EXECUTION].map(status => `'${status}'`).join(',')}))`;
export const EXECUTION_MAINTENANCE = '系统正在更新或等待确认更新结果，暂不能新建实盘任务或修改实盘连接';
// Each exchange call of the native executor is aborted after this long.
export const EXECUTION_CALL_TIMEOUT_MS = 35_000;
// A preview makes two exchange calls of EXECUTION_CALL_TIMEOUT_MS each; the
// runtime ends them once the API stopped waiting (docs/timeout-budgets.md, C7),
// but this bound does not rely on that. Expiry only keeps a crashed runtime from
// blocking updates until the next one clears the table; both processes read
// the same wall clock, so a forward clock jump can end an entry early.
export const EXECUTION_ENTRY_TTL_MS = 90_000;

// The update coordinator's idle check reads native execution jobs and open
// execution entries straight from hub.sqlite, so the API needs no in-process
// link to the executor. The jobs table belongs to the data plane; until it
// exists there are no jobs. A row that cannot be read counts as an unfinished
// job, so it blocks updates. `state` lists unfinished jobs only. While the
// executor's partial index exists it reads just the rows in that index. This
// assumes rows the executor wrote with JSON.stringify: json_extract also
// accepts JSON5 and JSONB and takes the first of duplicate keys where
// JSON.parse takes the last, so only a hand-edited row could be classified
// differently. Without the index every row is parsed as before. `transaction`
// runs the check and the maintenance write under the database write lock
// (design doc 5.5).
const statusOf = json => { try { return JSON.parse(json).status ?? 'unknown'; } catch { return 'unknown'; } };
const UNFINISHED_INDEX = 'execution_jobs_unfinished';
export function createExecutionJobsReader(db, { now = Date.now } = {}) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_jobs'");
  const index = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=? AND tbl_name='execution_jobs'");
  const open = db.prepare('SELECT COUNT(*) AS count FROM execution_entries WHERE expires_at > ?');
  const unfinished = rows => rows.map(row => ({ status: statusOf(row.json) })).filter(job => !FINAL_EXECUTION.has(job.status));
  return {
    state() {
      if (!table.get()) return { jobs: [] };
      if (index.get(UNFINISHED_INDEX)) {
        // An index of the same name with another definition cannot serve this query; parse every row instead.
        try { return { jobs: unfinished(db.prepare(`SELECT json FROM execution_jobs INDEXED BY ${UNFINISHED_INDEX} WHERE ${UNFINISHED_EXECUTION_JOB_SQL}`).all()) }; }
        catch (error) { if (!/^(no such index|no query solution)/.test(error?.message ?? '')) throw error; }
      }
      return { jobs: unfinished(db.prepare('SELECT json FROM execution_jobs').all()) };
    },
    openEntries: () => open.get(now()).count,
    transaction: fn => immediate(db, fn),
  };
}

// The runtime's side of the serialization: an account, preview or start write
// records an entry in the same write transaction that finds the durable
// maintenance flag off, and removes it when the operation ends. An update
// either sees the entry or is committed first, and the write is then refused.
// refuse throws the caller's mapped maintenance error; it has no default.
export function createExecutionEntries({ db, readMaintenance, refuse, log, now = Date.now, ttlMs = EXECUTION_ENTRY_TTL_MS }) {
  if (typeof readMaintenance !== 'function' || typeof refuse !== 'function') throw new TypeError('createExecutionEntries requires readMaintenance and refuse');
  const insert = db.prepare('INSERT INTO execution_entries(id,created_at,expires_at) VALUES (?,?,?)');
  const remove = db.prepare('DELETE FROM execution_entries WHERE id=?');
  return {
    // The runtime lock proves the previous runtime has exited, so its entries are void.
    clear: () => { db.exec('DELETE FROM execution_entries'); },
    async run(operation) {
      const id = randomUUID();
      immediate(db, () => {
        if (readMaintenance()) refuse();
        const at = now(); insert.run(id, at, at + ttlMs);
      });
      try { return await operation(); }
      finally {
        try { remove.run(id); } catch (error) { log?.warn({ err: error, type: 'execution' }, '执行入口记录未能删除，到期后自动失效'); }
      }
    },
  };
}

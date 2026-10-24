// The update coordinator's idle check reads native execution jobs straight from
// hub.sqlite, so the API needs no in-process link to the executor. The table
// belongs to the data plane; until it exists there are no jobs. A row that
// cannot be read counts as an unfinished job, so it blocks updates.
const statusOf = json => { try { return JSON.parse(json).status ?? 'unknown'; } catch { return 'unknown'; } };
export function createExecutionJobsReader(db) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_jobs'");
  return {
    state() {
      if (!table.get()) return { jobs: [] };
      return { jobs: db.prepare('SELECT json FROM execution_jobs').all().map(row => ({ status: statusOf(row.json) })) };
    },
  };
}

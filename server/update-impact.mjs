import { UNFINISHED_EXECUTION_JOB_SQL } from './control/execution-jobs.mjs';

const MODULES = new Set(['hub', 'aero', 'crossex', 'greeks', 'aster']);
const REASONS = new Set(['module-busy', 'module-idle', 'module-unavailable', 'final-order-check-required', 'native-tasks-active', 'native-idle', 'native-evidence-unavailable', 'aero-task-active', 'aero-idle']);
const STATUSES = new Set(['running', 'paused', 'stopping', 'failed', 'unknown']);
const safeTime = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) ? value : null;

export function nativeUpdateImpact(db, now = Date.now) {
  const observedAt = new Date(now()).toISOString();
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM execution_entries WHERE expires_at>?').get(now()).n;
    const rows = db.prepare(`SELECT id,json FROM execution_jobs WHERE ${UNFINISHED_EXECUTION_JOB_SQL} LIMIT 101`).all();
    const tasks = rows.slice(0, 100).map(row => { let status; try { status = JSON.parse(row.json).status; } catch {} return { id: /^[a-f0-9-]{36}$/.test(row.id) ? row.id : null, status: STATUSES.has(status) ? status : 'unknown' }; });
    return { moduleId: 'hub', observedAt, busy: count > 0 || rows.length > 0, reasonCode: count > 0 || rows.length ? 'native-tasks-active' : 'native-idle',
      activeRequests: count, tasks, truncated: rows.length > 100 };
  } catch { return { moduleId: 'hub', observedAt, busy: null, reasonCode: 'native-evidence-unavailable', activeRequests: null, tasks: [], truncated: false }; }
}

export function publicRuntimeImpact(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.modules) || value.modules.length > 5 || !safeTime(value.observedAt)) throw new Error('Invalid update impact');
  const seen = new Set();
  return { schemaVersion: 1, observedAt: value.observedAt, modules: value.modules.map(row => {
    if (!row || !MODULES.has(row.moduleId) || seen.has(row.moduleId) || !REASONS.has(row.reasonCode) || !safeTime(row.observedAt)
      || row.busy !== null && typeof row.busy !== 'boolean') throw new Error('Invalid update impact row');
    seen.add(row.moduleId);
    return { moduleId: row.moduleId, observedAt: row.observedAt, busy: row.busy, reasonCode: row.reasonCode,
      activeRequests: Number.isSafeInteger(row.activeRequests) && row.activeRequests >= 0 ? row.activeRequests : null,
      tasks: (Array.isArray(row.tasks) ? row.tasks : []).slice(0, 100).map(task => ({ id: typeof task?.id === 'string' && /^[a-f0-9-]{36}$/.test(task.id) ? task.id : null,
        status: STATUSES.has(task?.status) ? task.status : 'unknown' })), truncated: row.truncated === true };
  }) };
}

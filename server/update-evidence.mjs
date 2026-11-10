const ids = new Set(['hub', 'monitor', 'asset', 'crossex', 'greeks', 'aster']);
const units = new Set(['project-aggregation.service', 'project-aggregation-api.service', 'project-aggregation-entry.service', 'project-aggregation-api@a.service', 'project-aggregation-api@b.service']);
const missingCodes = new Set(['health-result-not-recorded', 'rollback-result-not-recorded', 'raw-logs-excluded', 'unit-states-not-recorded', 'version-evidence-incomplete']);
const choice = (value, choices) => choices.includes(value) ? value : null;
const timestamp = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) ? value : null;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;

// A second whitelist at the unprivileged boundary. Never forward arbitrary
// task messages, installer output, filesystem paths or credentials.
export function publicUpdateDiagnostic(value, jobId) {
  if (!value || value.schemaVersion !== 1 || value.jobId !== jobId || value.job?.id !== jobId || !/^[a-f0-9]{32}$/.test(jobId)
    || !['failed', 'interrupted'].includes(value.job.status) || !Array.isArray(value.job.steps) || value.job.steps.length > 32
    || !Array.isArray(value.versions) || value.versions.length > 32 || !Array.isArray(value.observation?.units) || value.observation.units.length > units.size
    || !Array.isArray(value.missing) || value.missing.length > missingCodes.size) throw new Error('Invalid update diagnostic');
  return { schemaVersion: 1, jobId, job: { id: jobId, status: value.job.status, startedAt: timestamp(value.job.startedAt), finishedAt: timestamp(value.job.finishedAt),
    deployMode: choice(value.job.deployMode, ['source', 'ci']), scope: choice(value.job.scope, ['full', 'api']), phase: choice(value.job.phase, ['prepare', 'activate']),
    activeModule: ids.has(value.job.activeModule) ? value.job.activeModule : null,
    steps: value.job.steps.filter(row => row && ids.has(row.id)).map(row => ({ id: row.id, status: choice(row.status, ['pending', 'running', 'succeeded', 'failed', 'skipped']) })) },
    versions: value.versions.filter(row => row && ids.has(row.id)).map(row => ({ id: row.id, fromCommit: commit(row.fromCommit), targetCommit: commit(row.targetCommit) })),
    observation: { observedAt: timestamp(value.observation.observedAt), units: value.observation.units.filter(row => row && units.has(row.unit)).map(row => ({ unit: row.unit,
      activeState: choice(row.activeState, ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance']),
      subState: choice(row.subState, ['running', 'dead', 'failed', 'exited', 'start', 'start-pre', 'start-post', 'stop', 'stop-sigterm', 'stop-sigkill', 'auto-restart', 'stop-post', 'final-sigterm', 'final-sigkill']) })) },
    health: { status: 'unknown' }, rollback: { status: 'unknown' }, missing: [...new Set(value.missing.filter(code => missingCodes.has(code)))] };
}

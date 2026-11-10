import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http-common.mjs';

export const BACKUP_STATUS_FILE = '/var/lib/project-aggregation-backup-status/readiness.json';
const SETTING = 'backup-readiness-v1';
const statuses = new Set(['running', 'unknown', 'failed', 'complete']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const choice = (value, values) => values.includes(value) ? value : null;
const messages = {
  BACKUP_METADATA_INVALID: '备份元数据格式无效，无法确认当前状态',
  BACKUP_DECLARATION_INVALID: '核验记录格式不正确，请检查材料状态与演练信息',
  BACKUP_IDENTITY_CHANGED: '备份身份已变化，请刷新后重新核对',
  BACKUP_DRILL_TIME_INVALID: '演练时间须在备份完成之后，且不能晚于当前时间',
  BACKUP_LEDGER_UNAVAILABLE: '人工台账暂不可读，已保留原记录，请先排查',
  BACKUP_LEDGER_CHANGED_REFRESH_REQUIRED: '台账已被更新，请刷新后重新核对',
};
const failure = (code, status = 400) => Object.assign(new HttpError(status, messages[code] ?? '备份核验请求无效'), { code });
const code = value => typeof value === 'string' && /^(?:RECOVERY|RUNTIME|UNSAFE_RUNTIME)_[A-Z_]{1,80}$/.test(value) ? value : null;

/** Only this fixed root-owned public file is read; no private backup/key directory. */
export function readBackupStatus() {
  if (process.platform !== 'linux') return { schemaVersion: 1, availability: 'unconfigured', schedule: { enabled: false }, runs: [] };
  try {
    for (const filename of [path.parse(BACKUP_STATUS_FILE).root, '/var', '/var/lib', path.dirname(BACKUP_STATUS_FILE), BACKUP_STATUS_FILE]) {
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022 || (filename === BACKUP_STATUS_FILE && (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024))) throw new Error('unsafe');
    }
    const fd = fs.openSync(BACKUP_STATUS_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (info.uid !== 0 || info.mode & 0o022 || !info.isFile() || info.nlink !== 1 || info.size > 256 * 1024) throw new Error('unsafe');
      return sanitizeBackupStatus(JSON.parse(fs.readFileSync(fd, 'utf8')));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return { schemaVersion: 1, availability: error.code === 'ENOENT' ? 'unconfigured' : 'unavailable', schedule: { enabled: false }, runs: [] };
  }
}

export function sanitizeBackupStatus(value) {
  if (value?.schemaVersion !== 1 || !iso(value.observedAt) || !Array.isArray(value.runs) || value.runs.length > 32) throw failure('BACKUP_METADATA_INVALID');
  const schedule = { enabled: value.schedule?.enabled === true, blockedByUnknown: value.schedule?.blockedByUnknown === true };
  if (schedule.enabled) {
    for (const field of ['start', 'end']) if (/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.schedule[field] ?? '')) schedule[field] = value.schedule[field];
    schedule.timezone = choice(value.schedule.timezone, ['Asia/Shanghai', 'UTC']);
    schedule.keep = Number.isSafeInteger(value.schedule.keep) && value.schedule.keep >= 2 && value.schedule.keep <= 30 ? value.schedule.keep : null;
  }
  const runs = value.runs.map(run => {
    if (!/^(?:scheduled-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}|manual-[a-f0-9]{24})$/.test(run.id ?? '') || !statuses.has(run.status)) throw failure('BACKUP_METADATA_INVALID');
    const row = { id: run.id, origin: run.id.startsWith('manual-') ? 'manual-registration' : 'scheduled', status: run.status, startedAt: iso(run.startedAt) ? run.startedAt : null, completedAt: iso(run.completedAt) ? run.completedAt : null,
      phase: choice(run.phase, ['preflight', 'cold-backup', 'archive-verification', 'retention', 'complete', 'interrupted']), error: code(run.error),
      notification: choice(run.notification, ['unknown', 'acknowledged', 'failed']), retention: choice(run.retention, ['removed', 'deleting', 'delete-failed']) };
    const archive = run.archive;
    if (archive && sha(archive.digest) && /^[a-f0-9-]{36}$/.test(archive.checkpointId ?? '') && /^[a-f0-9]{7,64}$/.test(archive.commit ?? '') && iso(archive.completedAt) && iso(archive.verifiedAt) && archive.archiveVerification === 'authenticated-ciphertext') {
      row.archive = { digest: archive.digest, checkpointId: archive.checkpointId, commit: archive.commit, completedAt: archive.completedAt, verifiedAt: archive.verifiedAt,
        archiveVerification: 'authenticated-ciphertext', location: run.id.startsWith('manual-') ? 'operator-local-registration' : 'local-managed',
        unresolvedDependencyCount: Number.isSafeInteger(archive.unresolvedDependencyCount) && archive.unresolvedDependencyCount >= 0 ? archive.unresolvedDependencyCount : null };
    }
    return row;
  });
  return { schemaVersion: 1, availability: 'available', observedAt: value.observedAt, schedule, runs };
}

function declaration(value) {
  if (!value || typeof value !== 'object' || !sha(value.digest) || !iso(value.checkedAt) || !/^[a-f0-9]{7,64}$/.test(value.commit ?? '') || !iso(value.backupAt)) throw failure('BACKUP_DECLARATION_INVALID');
  const retrieval = {};
  for (const key of ['package', 'dataKey', 'secretsKey']) {
    const state = choice(value.retrieval?.[key], ['unchecked', 'retrieved', 'missing']);
    if (!state) throw failure('BACKUP_DECLARATION_INVALID');
    retrieval[key] = state;
  }
  const drill = value.drill;
  if (!drill || !choice(drill.kind, ['none', 'ci-fixture', 'independent']) || !choice(drill.result, ['not-run', 'passed', 'failed', 'unknown']) || !choice(drill.isolation, ['unknown', 'isolated', 'not-isolated']) ||
      !Array.isArray(drill.coverage) || drill.coverage.length > 7 || drill.coverage.some(item => !['hub', 'monitor', 'asset', 'crossex', 'greeks', 'aster', 'credentials'].includes(item)) ||
      !(drill.durationSeconds === null || Number.isInteger(drill.durationSeconds) && drill.durationSeconds >= 0 && drill.durationSeconds <= 604800) ||
      !(drill.at === null || iso(drill.at)) || (drill.kind === 'none' && drill.result !== 'not-run') || (drill.result === 'passed' && (drill.kind === 'none' || !drill.at || drill.isolation !== 'isolated' || !drill.coverage.length))) throw failure('BACKUP_DECLARATION_INVALID');
  // There is deliberately no free-text field that could capture key material.
  return { digest: value.digest, commit: value.commit, backupAt: value.backupAt, checkedAt: value.checkedAt, origin: 'operator-declaration', retrieval,
    drill: { kind: drill.kind, result: drill.result, at: drill.at, isolation: drill.isolation, durationSeconds: drill.durationSeconds, coverage: [...new Set(drill.coverage)] } };
}

export function createBackupReadiness({ getSetting, setSetting, transaction, readStatus = readBackupStatus, now = () => new Date().toISOString() }) {
  if (typeof transaction !== 'function') throw new Error('BACKUP_LEDGER_TRANSACTION_REQUIRED');
  function records() {
    const raw = getSetting(SETTING);
    if (!raw) return { entries: [], revision: 0, ledgerAvailability: 'available' };
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 96 * 1024) throw new Error('invalid');
      const value = JSON.parse(raw);
      if (value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > 64) throw new Error('invalid');
      const revision = value.revision ?? 0;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid');
      return { entries: value.entries.map(declaration), revision, ledgerAvailability: 'available' };
    } catch { return { entries: [], revision: null, ledgerAvailability: 'unavailable' }; }
  }
  function snapshot() {
    const status = readStatus(), ledger = records();
    return { ...status, ledgerAvailability: ledger.ledgerAvailability, ledgerRevision: ledger.revision, runs: status.runs.map(run => ({ ...run,
      declaration: run.archive ? ledger.entries.find(item => item.digest === run.archive.digest && item.commit === run.archive.commit && item.backupAt === run.archive.completedAt) ?? null : null })) };
  }
  function record(input) {
    if (!input || Object.keys(input).some(key => !['digest', 'commit', 'backupAt', 'retrieval', 'drill', 'expectedRevision'].includes(key)) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw failure('BACKUP_DECLARATION_INVALID');
    const item = declaration({ ...input, checkedAt: now() });
    const status = readStatus();
    const archive = status.runs.find(run => run.archive?.digest === item.digest && run.archive.commit === item.commit && run.archive.completedAt === item.backupAt)?.archive;
    if (!archive) throw failure('BACKUP_IDENTITY_CHANGED', 409);
    if (item.drill.at && (Date.parse(item.drill.at) < Date.parse(item.backupAt) || Date.parse(item.drill.at) > Date.parse(item.checkedAt) + 60_000)) throw failure('BACKUP_DRILL_TIME_INVALID');
    transaction(() => {
      const ledger = records();
      if (ledger.ledgerAvailability !== 'available') throw failure('BACKUP_LEDGER_UNAVAILABLE', 409);
      if (ledger.revision !== input.expectedRevision || ledger.revision >= Number.MAX_SAFE_INTEGER) throw failure('BACKUP_LEDGER_CHANGED_REFRESH_REQUIRED', 409);
      const entries = ledger.entries.filter(previous => previous.digest !== item.digest);
      entries.push(item);
      setSetting(SETTING, JSON.stringify({ schemaVersion: 1, revision: ledger.revision + 1, entries: entries.slice(-64) }));
    });
    return snapshot();
  }
  return { snapshot, record };
}

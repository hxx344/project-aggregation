import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupReadiness, sanitizeBackupStatus, readBackupStatus } from '../server/recovery/readiness.mjs';

const archive = (digit = 'a') => ({ digest: digit.repeat(64), checkpointId: '12345678-1234-1234-1234-123456789012', commit: 'b'.repeat(40), completedAt: '2026-11-10T00:00:00Z', verifiedAt: '2026-11-10T00:01:00Z', archiveVerification: 'authenticated-ciphertext', unresolvedDependencyCount: 0 });
const matches = pattern => error => pattern.test(error.code ?? '');
const rawStatus = (archives = [archive()]) => ({ schemaVersion: 1, observedAt: '2026-11-10T00:02:00Z', schedule: { enabled: true, start: '23:00', end: '01:00', timezone: 'Asia/Shanghai', keep: 7, webhook: 'never-expose' }, runs: archives.map((item, index) => ({ id: `scheduled-20261110T000000Z-${String(index).padStart(12, '0')}`, status: 'complete', phase: 'complete', archive: item, secretKey: 'never-expose' })) });
const input = (item = archive()) => ({ expectedRevision: 0, digest: item.digest, commit: item.commit, backupAt: item.completedAt, retrieval: { package: 'retrieved', dataKey: 'missing', secretsKey: 'unchecked' }, drill: { kind: 'none', result: 'not-run', at: null, durationSeconds: null, isolation: 'unknown', coverage: [] } });
function fixture() {
  let settings = '', status = sanitizeBackupStatus(rawStatus());
  const service = createBackupReadiness({ getSetting: () => settings, setSetting: (_key, value) => { settings = value; }, transaction: action => action(), readStatus: () => status, now: () => '2026-11-10T02:00:00Z' });
  return { service, get saved() { return settings; }, set saved(value) { settings = value; }, set status(value) { status = sanitizeBackupStatus(value); } };
}

test('archive authentication is distinct from missing key retrieval and failed independent drill', () => {
  const f = fixture();
  const initial = f.service.snapshot().runs[0];
  assert.equal(initial.archive.archiveVerification, 'authenticated-ciphertext');
  assert.equal(initial.declaration, null);
  const body = input();
  body.drill = { kind: 'independent', result: 'failed', at: '2026-11-10T01:00:00Z', isolation: 'isolated', durationSeconds: 120, coverage: ['hub'] };
  const row = f.service.record(body).runs[0];
  assert.equal(row.declaration.retrieval.package, 'retrieved');
  assert.equal(row.declaration.retrieval.dataKey, 'missing');
  assert.equal(row.declaration.drill.result, 'failed');
  assert.equal(row.declaration.origin, 'operator-declaration');
});

test('old backup drill never attaches to a new digest, version, or creation time', () => {
  const f = fixture();
  const body = input();
  body.drill = { kind: 'independent', result: 'passed', at: '2026-11-10T01:00:00Z', isolation: 'isolated', durationSeconds: 120, coverage: ['hub', 'credentials'] };
  f.service.record(body);
  for (const next of [archive('c'), { ...archive(), commit: 'd'.repeat(40) }, { ...archive(), completedAt: '2026-11-10T00:30:00Z' }]) {
    f.status = rawStatus([next]);
    assert.equal(f.service.snapshot().runs[0].declaration, null);
    assert.throws(() => f.service.record(body), matches(/BACKUP_IDENTITY_CHANGED/));
  }
});

test('CI evidence remains a manually declared CI fixture, not an independent drill', () => {
  const f = fixture(), body = input();
  body.drill = { kind: 'ci-fixture', result: 'passed', at: '2026-11-10T01:00:00Z', isolation: 'isolated', durationSeconds: 3, coverage: ['hub'] };
  const row = f.service.record(body).runs[0];
  assert.equal(row.declaration.drill.kind, 'ci-fixture');
  assert.equal(row.declaration.origin, 'operator-declaration');
});

test('snapshot whitelist omits secret payload, filesystem and notification endpoint', () => {
  const raw = rawStatus();
  Object.assign(raw.runs[0].archive, { entries: [{ path: '/root/private' }], authentication: { data: 'private' }, dataKey: 'private' });
  raw.runs[0].error = 'https://secret.invalid/token';
  raw.runs[0].phase = '/root/private';
  const value = JSON.stringify(sanitizeBackupStatus(raw));
  for (const secret of ['never-expose', '/root', 'token', 'private']) assert.ok(!value.includes(secret));
});

test('no secret field is persisted; wrong schema, oversize and corrupt old ledger fail closed', () => {
  const f = fixture();
  assert.throws(() => f.service.record({ ...input(), dataKey: 'DO-NOT-STORE' }), matches(/INVALID/));
  assert.equal(f.saved, '');
  for (const old of ['{', JSON.stringify({ schemaVersion: 0, entries: [] }), 'x'.repeat(100_000)]) {
    f.saved = old;
    assert.equal(f.service.snapshot().ledgerAvailability, 'unavailable');
    assert.throws(() => f.service.record(input()), matches(/LEDGER_UNAVAILABLE/));
    assert.equal(f.saved, old);
  }
  f.saved = '';
  assert.equal(f.service.snapshot().ledgerAvailability, 'available');
});

test('drill needs isolated coverage and matching backup time; caller cannot forge checkedAt', () => {
  const f = fixture();
  const valid = { kind: 'independent', result: 'passed', at: '2026-11-10T01:00:00Z', isolation: 'isolated', durationSeconds: 2, coverage: ['hub'] };
  for (const drill of [{ ...valid, at: null }, { ...valid, isolation: 'unknown' }, { ...valid, coverage: [] }, { ...valid, at: '2026-11-09T01:00:00Z' }, { ...valid, at: '2027-11-09T01:00:00Z' }]) assert.throws(() => f.service.record({ ...input(), drill }), matches(/BACKUP_/));
  assert.throws(() => f.service.record({ ...input(), checkedAt: '2026-11-10T01:00:00Z' }), matches(/INVALID/));
});

test('new bounded state tolerates extra old fields while unknown envelope and oversized list refuse', () => {
  const value = rawStatus();
  value.runs[0].legacy = true;
  assert.equal(sanitizeBackupStatus(value).runs.length, 1);
  assert.throws(() => sanitizeBackupStatus({ ...value, schemaVersion: 2 }), matches(/INVALID/));
  assert.throws(() => sanitizeBackupStatus({ ...value, runs: Array(33).fill(value.runs[0]) }), matches(/INVALID/));
});

test('default reader is read-only and returns an explicit unavailable/unconfigured state', () => {
  const result = readBackupStatus();
  assert.equal(result.schemaVersion, 1);
  assert.ok(['available', 'unavailable', 'unconfigured'].includes(result.availability));
});

test('concurrent stale declarations are rejected by revision, preserving the first writer', () => {
  const f = fixture();
  f.service.record(input());
  const saved = f.saved;
  assert.throws(() => f.service.record({ ...input(), retrieval: { package: 'missing', dataKey: 'missing', secretsKey: 'missing' } }), matches(/CHANGED_REFRESH_REQUIRED/));
  assert.equal(f.saved, saved);
  const next = f.service.record({ ...input(), expectedRevision: 1 });
  assert.equal(next.ledgerRevision, 2);
});

test('existing manually registered local backup accepts identity-bound declarations', () => {
  const f = fixture(), raw = rawStatus();
  raw.runs[0].id = 'manual-' + 'a'.repeat(24);
  f.status = raw;
  const row = f.service.record(input()).runs[0];
  assert.equal(row.origin, 'manual-registration');
  assert.equal(row.archive.location, 'operator-local-registration');
  assert.equal(row.declaration.retrieval.dataKey, 'missing');
});

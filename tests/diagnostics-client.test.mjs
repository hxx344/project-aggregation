import test from 'node:test';
import assert from 'node:assert/strict';
import { ageSnapshot, attentionDiagnostics, connectionDiagnostic, diagnosticLabel, nextSnapshotExpiry, snapshotDiagnostics } from '../src/hub-state.ts';

const start = Date.parse('2026-10-07T08:00:00.000Z');
const iso = value => new Date(value).toISOString();
const issue = (kind, id = 'pair:gold') => ({ id, kind, message: '黄金配对：后台处理中', firstSeenAt: iso(start) });
const snapshot = diagnostics => ({ project: { id: 'aster', adapter: 'aster', enabled: true, staleAfterSeconds: 120 },
  state: 'partial', updatedAt: iso(start), checkedAt: iso(start), message: '摘要部分指标暂不可用', metrics: [], diagnostics });

test('home attention shows manual actions immediately, sustained faults after two minutes, and never notices', () => {
  const current = snapshot([issue('notice', 'report'), issue('fault'), issue('action', 'pair:other')]);
  assert.deepEqual(attentionDiagnostics(current, start).map(row => row.id), ['pair:other']);
  assert.deepEqual(attentionDiagnostics(current, start + 119999).map(row => row.id), ['pair:other']);
  assert.deepEqual(attentionDiagnostics(current, start + 120000).map(row => row.id), ['pair:gold', 'pair:other']);
  assert.equal(snapshotDiagnostics(current).length, 3);
  assert.equal(attentionDiagnostics(snapshot([issue('notice')]), start + 86400000).length, 0);
  assert.equal(diagnosticLabel(issue('notice'), start), '运行提示');
  assert.equal(diagnosticLabel(issue('fault'), start), '观察中');
  assert.equal(diagnosticLabel(issue('fault'), start + 120000), '持续异常');
});

test('disabled projects and link-only entries have no attention or details', () => {
  const current = snapshot([issue('action')]);
  assert.equal(attentionDiagnostics({ ...current, project: { ...current.project, enabled: false } }, start).length, 0);
  assert.equal(snapshotDiagnostics({ ...current, project: { ...current.project, adapter: 'link' } }).length, 0);
  const link = { ...current, state: 'online', updatedAt: null, project: { ...current.project, adapter: 'link' } };
  assert.equal(ageSnapshot(link, start + 999999).state, 'online');
  assert.equal(ageSnapshot({ ...current, project: { ...current.project, enabled: false } }, start + 999999).state, 'partial');
});

test('client data expiration adds a separate fault and cannot be hidden by informational source diagnostics', () => {
  const current = snapshot([issue('notice')]);
  const aged = ageSnapshot(current, start + 120001);
  assert.equal(aged.state, 'stale');
  assert.equal(current.diagnostics.length, 1);
  assert.equal(aged.diagnostics.length, 2);
  assert.equal(aged.diagnostics[1].id, 'hub:data-freshness');
  assert.equal(aged.diagnostics[1].firstSeenAt, iso(start + 120000));
  assert.equal(attentionDiagnostics(aged, start + 120001).length, 0);
  assert.equal(attentionDiagnostics(aged, start + 240000).length, 1);
  assert.equal(ageSnapshot(aged, start + 240000).diagnostics.length, 2);
  assert.equal(ageSnapshot({ ...current, freshness: 'static' }, start + 999999).state, 'partial');
});

test('browser scheduling covers both source expiration and pending fault maturity without polling', () => {
  const current = snapshot([issue('fault')]);
  assert.equal(nextSnapshotExpiry([current], start), start + 120000);
  assert.equal(nextSnapshotExpiry([current], start + 120000), start + 120001);
  assert.equal(nextSnapshotExpiry([current], start + 120001), start + 240000);
  assert.equal(nextSnapshotExpiry([current], start + 240000), null);
  assert.equal(nextSnapshotExpiry([{ ...current, freshness: 'static' }], start), start + 120000);
});

test('missing or already old source times start a local observation, never inherit years of age', () => {
  for (const updatedAt of [null, '2000-01-01T00:00:00.000Z']) {
    const aged = ageSnapshot({ ...snapshot([]), updatedAt }, start + 1);
    assert.equal(aged.diagnostics[0].firstSeenAt, iso(start));
    assert.equal(attentionDiagnostics(aged, start + 1).length, 0);
  }
});

test('recovered diagnostics clear attention and connection issues keep their own entry action', () => {
  assert.equal(attentionDiagnostics(snapshot([]), start + 999999).length, 0);
  assert.equal(connectionDiagnostic(issue('action', 'hub:auth')), true);
  assert.equal(connectionDiagnostic(issue('fault', 'hub:connection')), true);
  assert.equal(connectionDiagnostic(issue('action')), false);
  assert.equal(attentionDiagnostics(snapshot(undefined), start).length, 1);
});

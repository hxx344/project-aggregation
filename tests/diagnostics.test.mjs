import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDiagnostics, snapshotDiagnostics } from '../server/diagnostics.mjs';

const now = Date.parse('2026-10-07T00:00:00Z');
const project = { staleAfterSeconds: 120 };
const fresh = { state: 'online', sourceState: 'online', message: '正常', updatedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), sourceDiagnostics: [] };

test('diagnostic continuity depends on ID and kind, not message or upstream timestamps', () => {
  const initial = reconcileDiagnostics([{ id: 'pair:a', kind: 'fault', message: '初次', firstSeenAt: '2000-01-01T00:00:00Z' }], [], now);
  assert.equal(initial[0].firstSeenAt, new Date(now).toISOString());
  assert.equal(reconcileDiagnostics([{ id: 'pair:a', kind: 'fault', message: '新文案' }], initial, now + 120000)[0].firstSeenAt, initial[0].firstSeenAt);
  assert.equal(reconcileDiagnostics([{ id: 'pair:a', kind: 'action', message: '人工核对' }], initial, now + 120000)[0].firstSeenAt, new Date(now + 120000).toISOString());
  assert.deepEqual(reconcileDiagnostics([], initial, now), []);
});

test('classified empty diagnostics cannot suppress expiry, missing dates, or transport failures', () => {
  assert.deepEqual(snapshotDiagnostics(fresh, project, now), []);
  for (const updatedAt of [null, 'not-a-date', new Date(now - 120000).toISOString(), new Date(now + 61000).toISOString()]) {
    const result = snapshotDiagnostics({ ...fresh, updatedAt }, project, now);
    assert.equal(result[0].id, 'hub:data-freshness'); assert.equal(result[0].kind, 'fault'); assert.equal(result[0].firstSeenAt, new Date(now).toISOString());
  }
  const auth = snapshotDiagnostics({ ...fresh, transportError: { code: 'unauthorized', message: '凭据失效' } }, project, now);
  assert.deepEqual(auth.map(({ id, kind }) => ({ id, kind })), [{ id: 'hub:auth', kind: 'action' }]);
  assert.equal(snapshotDiagnostics({ ...fresh, transportError: { code: 'timeout', message: '超时' } }, project, now)[0].id, 'hub:connection');
  assert.deepEqual(snapshotDiagnostics({ ...fresh, updatedAt: null, freshness: 'static' }, project, now), []);
});

test('legacy health is conservative while classified notices do not become faults', () => {
  for (const state of ['partial', 'offline', 'stale']) {
    const legacy = snapshotDiagnostics({ ...fresh, sourceDiagnostics: undefined, sourceState: state }, project, now);
    assert.equal(legacy[0].id, 'hub:legacy-health'); assert.equal(legacy[0].kind, 'fault');
  }
  const notices = snapshotDiagnostics({ ...fresh, sourceState: 'partial', sourceDiagnostics: [{ id: 'stats', kind: 'notice', message: '统计延迟' }] }, project, now);
  assert.equal(notices.length, 1); assert.equal(notices[0].kind, 'notice');
  const failed = snapshotDiagnostics({ ...fresh, updatedAt: null, lastSuccessAt: null, transportError: { code: 'timeout', message: '超时' } }, project, now);
  assert.deepEqual(failed.map(item => item.id), ['hub:connection']);
});

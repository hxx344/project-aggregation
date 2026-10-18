import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBaseline, summarizeSources, validateBaselineInterval, BASELINE_INTERVAL_MS, BASELINE_RETENTION_MS, BASELINE_MAX_BUCKETS } from '../server/observability.mjs';

const time = Date.parse('2026-10-19T00:00:00Z');
const source = (snapshot = {}, project = {}) => ({ project: { enabled: true, adapter: 'standard', apiUrl: 'http://module.workspace.internal', staleAfterSeconds: 120, ...project },
  snapshot: { state: 'online', updatedAt: new Date(time).toISOString(), ...snapshot } });
const quiet = { info() {}, warn() {} };
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); let now = time;
  const baseline = createBaseline({ db, now: () => now, intervalMs: 0, logger: quiet,
    readSnapshot: () => ({ projects: [source()], sseConnections: 0 }), ...options });
  t.after(async () => { await baseline.close(); db.close(); });
  return { db, baseline, advance(value) { now += value; } };
}

test('freshness uses strictest source TTL, excludes static and disabled data, and counts unknown as missing', () => {
  const result = summarizeSources([
    source(), source({ updatedAt: new Date(time - 30_000).toISOString(), staleAfterSeconds: 30 }),
    source({ updatedAt: null }), source({ updatedAt: new Date(time + 60_001).toISOString() }),
    source({ lastSuccessAt: null }), source({ freshness: 'static', updatedAt: null }),
    source({}, { enabled: false }), source({}, { adapter: 'link' }), source({}, { apiUrl: '' }),
    source({ state: 'offline', transportError: { code: 'connection' } }),
  ], time);
  assert.deepEqual(result, { eligible: 6, fresh: 2, stale: 1, missing: 3, static: 1, excluded: 3, unhealthy: 1 });
});

test('sampling persists one observation per minute and reads never manufacture records or fill gaps', async t => {
  const f = fixture(t);
  f.baseline.observeSummary(true, 12); f.baseline.observeSummary(false, 20); f.baseline.observeSlowConsumer();
  await f.baseline.sample(); await f.baseline.sample();
  assert.equal(f.baseline.read().sampling.retainedBuckets, 1);
  f.advance(3 * BASELINE_INTERVAL_MS); await f.baseline.sample();
  const read = f.baseline.read();
  assert.equal(read.sampling.retainedBuckets, 2); assert.equal(read.sampling.missingBuckets, 2);
  assert.deepEqual(read.summaryReads, { success: 1, failed: 1, durationMs: 32, maxDurationMs: 20 });
  assert.equal(read.sse.slowConsumerDisconnects, 1);
  assert.equal(read.coverage.executionResults, false);
  for (let i = 0; i < 3; i++) f.baseline.read();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM platform_baseline_samples').get().count, 2);
});

test('retention expires old buckets, limits recent reads and never samples backward clock periods', async t => {
  const f = fixture(t);
  await f.baseline.sample();
  f.advance(BASELINE_RETENTION_MS); await f.baseline.sample();
  assert.equal(f.baseline.read().sampling.retainedBuckets, 1);
  for (let i = 0; i < 65; i++) { f.advance(BASELINE_INTERVAL_MS); await f.baseline.sample(); }
  assert.equal(f.baseline.read().recentSamples.length, 60);
  f.advance(-BASELINE_INTERVAL_MS * 2);
  assert.equal(await f.baseline.sample(), null);
  assert.equal(f.baseline.read().sampling.clockRegressed, true);
  assert.equal(f.baseline.read().sampling.lastError.code, 'clock_regressed');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM platform_baseline_samples').get().count, 66);
  assert.equal(BASELINE_MAX_BUCKETS, BASELINE_RETENTION_MS / BASELINE_INTERVAL_MS);
});

test('sampling failure preserves successful observations and errors omit private details', async t => {
  let broken = false;
  const f = fixture(t, { readCapabilities: async () => { if (broken) throw new Error('private-credential-detail'); return []; } });
  await f.baseline.sample(); broken = true; f.advance(BASELINE_INTERVAL_MS);
  assert.equal(await f.baseline.sample(), null);
  const value = f.baseline.read();
  assert.equal(value.sampling.retainedBuckets, 1); assert.equal(value.sampling.lastError.code, 'sample_failed');
  assert.equal(JSON.stringify(value).includes('private-credential-detail'), false);
});

test('restart retains observations, damaged samples are skipped, and retention has a hard row bound', async t => {
  const f = fixture(t); await f.baseline.sample(); await f.baseline.close();
  const reopened = createBaseline({ db: f.db, intervalMs: 0, now: () => time, logger: quiet,
    readSnapshot: () => ({ projects: [], sseConnections: 0 }) });
  assert.equal(reopened.read().sampling.retainedBuckets, 1);
  f.db.prepare('UPDATE platform_baseline_samples SET json=?').run('{broken');
  assert.equal(reopened.read().sampling.invalidSamples, 1);
  assert.equal(reopened.read().sampling.retainedBuckets, 0);
  assert.equal(reopened.read().sampling.missingBuckets, null);
  assert.deepEqual(reopened.read().recentSamples, []);
  await reopened.sample();
  const insert = f.db.prepare('INSERT INTO platform_baseline_samples VALUES (?,1,?)');
  f.db.exec('BEGIN');
  for (let i = 1; i <= BASELINE_MAX_BUCKETS + 2; i++) insert.run(time - i, '{}');
  f.db.exec('COMMIT');
  await reopened.sample();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM platform_baseline_samples').get().count, BASELINE_MAX_BUCKETS);
  await reopened.close();
});

test('invalid historical rows stay visible after leaving the recent window and do not fill gaps', async t => {
  const f = fixture(t); await f.baseline.sample();
  f.advance(BASELINE_INTERVAL_MS); await f.baseline.sample();
  f.db.prepare('UPDATE platform_baseline_samples SET json=? WHERE bucket_ms=?').run('{broken', time + BASELINE_INTERVAL_MS);
  f.advance(61 * BASELINE_INTERVAL_MS); await f.baseline.sample();
  const read = f.baseline.read();
  assert.equal(read.sampling.retainedBuckets, 2); assert.equal(read.sampling.storedBuckets, 3);
  assert.equal(read.sampling.invalidSamples, 1); assert.equal(read.sampling.missingBuckets, 61);
  assert.equal(read.recentSamples.length, 1);
  f.db.prepare('UPDATE platform_baseline_samples SET json=? WHERE bucket_ms=?').run('{"schemaVersion":1}', time);
  assert.equal(f.baseline.read().sampling.invalidSamples, 2, 'a version number alone is not a valid observation');
});

test('validity index upgrades an existing minute table idempotently and follows JSON repairs', async t => {
  const f = fixture(t); await f.baseline.sample();
  const json = f.db.prepare('SELECT json FROM platform_baseline_samples').get().json;
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE platform_baseline_samples (bucket_ms INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, json TEXT NOT NULL)');
  db.prepare('INSERT INTO platform_baseline_samples VALUES (?,1,?)').run(time, json);
  const options = { db, intervalMs: 0, now: () => time, logger: quiet, readSnapshot: () => ({ projects: [], sseConnections: 0 }) };
  const first = createBaseline(options), second = createBaseline(options);
  t.after(async () => { await first.close(); await second.close(); db.close(); });
  assert.equal(first.read().sampling.retainedBuckets, 1);
  db.prepare('UPDATE platform_baseline_samples SET json=?').run('{broken');
  assert.equal(second.read().sampling.retainedBuckets, 0); assert.equal(second.read().sampling.invalidSamples, 1);
  db.prepare('UPDATE platform_baseline_samples SET json=?').run(json);
  assert.equal(first.read().sampling.retainedBuckets, 1); assert.equal(first.read().sampling.invalidSamples, 0);
});

test('sampling runs without readers and close aborts in-flight capability work without writing a sample', async t => {
  let calls = 0, aborted = false;
  const f = fixture(t, { intervalMs: 1000, readCapabilities: signal => {
    calls++;
    return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve([]); }, { once: true }));
  } });
  f.baseline.start(); await Promise.resolve(); assert.equal(calls, 1);
  await f.baseline.close(); assert.equal(aborted, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM platform_baseline_samples').get().count, 0);
  assert.equal(await f.baseline.sample(), null);
  f.baseline.start(); assert.equal(calls, 1);
});

test('synchronous observation failure does not pin the sampler to a completed promise', async t => {
  let broken = true;
  const f = fixture(t, { readCapabilities() { if (broken) throw new Error('read failed'); return []; } });
  assert.equal(await f.baseline.sample(), null); broken = false;
  assert.ok(await f.baseline.sample()); assert.equal(f.baseline.read().sampling.retainedBuckets, 1);
  for (const value of [-1, 0.5, 999, NaN, Infinity, 2_147_483_648]) assert.throws(() => validateBaselineInterval(value), /interval/);
});

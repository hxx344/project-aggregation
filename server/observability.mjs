import { randomUUID } from 'node:crypto';

export const BASELINE_INTERVAL_MS = 60_000;
export const BASELINE_RETENTION_MS = 28 * 24 * 60 * 60_000;
export const BASELINE_MAX_BUCKETS = 40_320;
const bucketOf = time => Math.floor(time / BASELINE_INTERVAL_MS) * BASELINE_INTERVAL_MS;

export function validateBaselineInterval(intervalMs) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2_147_483_647 || intervalMs > 0 && intervalMs < 1000) throw new RangeError('Invalid baseline interval');
}

// Only source timestamps determine freshness. Transport health is counted separately.
export function summarizeSources(projects, now) {
  const result = { eligible: 0, fresh: 0, stale: 0, missing: 0, static: 0, excluded: 0, unhealthy: 0 };
  for (const { project, snapshot } of projects) {
    if (!project.enabled || project.adapter === 'link' || !project.apiUrl) { result.excluded++; continue; }
    if (!snapshot || snapshot.transportError || !['online', 'partial'].includes(snapshot.sourceState || snapshot.state)) result.unhealthy++;
    if (snapshot?.freshness === 'static') { result.static++; continue; }
    result.eligible++;
    const at = typeof snapshot?.updatedAt === 'string' ? Date.parse(snapshot.updatedAt) : NaN;
    const ttl = Math.min(project.staleAfterSeconds, snapshot?.staleAfterSeconds || project.staleAfterSeconds) * 1000;
    if (!Number.isFinite(at) || at > now + 60_000 || snapshot?.lastSuccessAt === null) result.missing++;
    else if (now - at >= ttl) result.stale++;
    else result.fresh++;
  }
  return result;
}

/** Bounded minute observations, independent of browser activity and upstream refreshes. */
export function createBaseline({ db, readSnapshot, readCapabilities = async () => [], now = Date.now, intervalMs = BASELINE_INTERVAL_MS, logger = console }) {
  validateBaselineInterval(intervalMs);
  db.exec('CREATE TABLE IF NOT EXISTS platform_baseline_samples (bucket_ms INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, json TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO platform_baseline_samples(bucket_ms,schema_version,json) VALUES (?,1,?) ON CONFLICT(bucket_ms) DO UPDATE SET schema_version=excluded.schema_version,json=excluded.json');
  const prune = db.prepare('DELETE FROM platform_baseline_samples WHERE bucket_ms<? OR bucket_ms IN (SELECT bucket_ms FROM platform_baseline_samples ORDER BY bucket_ms DESC LIMIT -1 OFFSET ?)');
  const counts = ['summaries.eligible', 'summaries.fresh', 'summaries.stale', 'summaries.missing', 'summaries.static', 'summaries.excluded', 'summaries.unhealthy', 'summaryReads.success', 'summaryReads.failed', 'sse.activeConnections', 'sse.slowConsumerDisconnects'];
  const numeric = field => `json_type(json,'$.${field}') IN ('integer','real') AND json_extract(json,'$.${field}') BETWEEN 0 AND 9007199254740991`;
  // CASE guards every JSON extraction, including malformed rows outside the recent read window.
  const valid = `CASE WHEN schema_version=1 AND bucket_ms%60000=0 AND length(json)<=16384 AND json_valid(json) THEN COALESCE(
    json_type(json,'$.schemaVersion')='integer' AND json_extract(json,'$.schemaVersion')=1 AND json_type(json,'$.instanceId')='text'
    AND json_type(json,'$.observedAt')='text'
    AND substr(json_extract(json,'$.observedAt'),1,17)=strftime('%Y-%m-%dT%H:%M:',bucket_ms/1000,'unixepoch')
    AND substr(json_extract(json,'$.observedAt'),18) GLOB '[0-5][0-9].[0-9][0-9][0-9]Z'
    AND json_type(json,'$.capabilities')='array' AND json_type(json,'$.coverage')='object'
    AND ${counts.map(field => `json_type(json,'$.${field}')='integer' AND json_extract(json,'$.${field}') BETWEEN 0 AND 9007199254740991`).join(' AND ')}
    AND ${['summaryReads.durationMs', 'summaryReads.maxDurationMs'].map(numeric).join(' AND ')}
    AND json_extract(json,'$.summaries.eligible')=json_extract(json,'$.summaries.fresh')+json_extract(json,'$.summaries.stale')+json_extract(json,'$.summaries.missing'),0) ELSE 0 END`;
  // The generated column's index is updated with the JSON, including repairs/corruption.
  // Historical coverage reads use that index instead of parsing 28 days of payloads.
  if (!db.prepare('PRAGMA table_xinfo(platform_baseline_samples)').all().some(column => column.name === 'valid_sample')) {
    db.exec(`ALTER TABLE platform_baseline_samples ADD COLUMN valid_sample INTEGER GENERATED ALWAYS AS (${valid}) VIRTUAL`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS platform_baseline_valid_bucket ON platform_baseline_samples(valid_sample,bucket_ms)');
  const recent = db.prepare('SELECT bucket_ms,schema_version,json FROM platform_baseline_samples WHERE valid_sample=1 AND bucket_ms>=? AND bucket_ms<=? ORDER BY bucket_ms DESC LIMIT 60');
  const bounds = db.prepare('SELECT COUNT(*) AS count,MIN(bucket_ms) AS first,MAX(bucket_ms) AS last FROM platform_baseline_samples WHERE valid_sample=1 AND bucket_ms>=? AND bucket_ms<=?');
  const invalid = db.prepare('SELECT COUNT(*) AS count FROM platform_baseline_samples WHERE valid_sample=0 AND bucket_ms>=? AND bucket_ms<=?');
  const newest = db.prepare('SELECT MAX(bucket_ms) AS last FROM platform_baseline_samples WHERE valid_sample=1');
  const instanceId = randomUUID();
  const reads = { success: 0, failed: 0, durationMs: 0, maxDurationMs: 0 };
  let timer, pending, controller, closed = false, lastError = null, slowConsumers = 0;
  function current() {
    const at = now(), value = readSnapshot();
    return { schemaVersion: 1, observedAt: new Date(at).toISOString(), instanceId,
      summaries: summarizeSources(value.projects, at), summaryReads: { ...reads },
      sse: { activeConnections: value.sseConnections, slowConsumerDisconnects: slowConsumers },
      coverage: { executionResults: false, updateSuccessRate: false, browserPushLatency: false, crossModuleAccountProtection: value.accountWriterVersion === 1 } };
  }
  function read() {
    const at = now(), bucket = bucketOf(at), earliest = bucket - BASELINE_RETENTION_MS + BASELINE_INTERVAL_MS;
    const range = bounds.get(earliest, bucket);
    let invalidSamples = invalid.get(earliest, bucket).count;
    const samples = recent.all(bucket - 59 * BASELINE_INTERVAL_MS, bucket).flatMap(row => {
      try { const value = JSON.parse(row.json); if (row.schema_version !== 1 || value.schemaVersion !== 1) throw new Error('Invalid sample'); return [{ bucketAt: new Date(row.bucket_ms).toISOString(), ...value }]; }
      catch { invalidSamples++; return []; }
    });
    return { ...current(), sampling: { intervalMs, retentionDays: 28, maxBuckets: BASELINE_MAX_BUCKETS,
      retainedBuckets: range.count, storedBuckets: range.count + invalidSamples, firstBucketAt: range.first === null ? null : new Date(range.first).toISOString(),
      lastBucketAt: range.last === null ? null : new Date(range.last).toISOString(),
      missingBuckets: range.first === null ? null : Math.max(0, (bucket - range.first) / BASELINE_INTERVAL_MS + 1 - range.count),
      clockRegressed: newest.get().last > bucket, lastError, invalidSamples }, recentSamples: samples };
  }
  function sample() {
    if (closed) return Promise.resolve(null);
    if (pending) return pending;
    controller = new AbortController();
    pending = Promise.resolve().then(async () => {
      try {
        const capabilities = await readCapabilities(controller.signal);
        if (closed) return null;
        const value = { ...current(), capabilities }, at = Date.parse(value.observedAt), bucket = bucketOf(at);
        if (newest.get().last > bucket) { lastError = { code: 'clock_regressed', at: new Date(at).toISOString() }; return null; }
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > 16 * 1024) throw new Error('Baseline sample exceeds limit');
        db.exec('BEGIN IMMEDIATE');
        try { insert.run(bucket, json); prune.run(bucket - BASELINE_RETENTION_MS + BASELINE_INTERVAL_MS, BASELINE_MAX_BUCKETS); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        lastError = null;
        logger.info?.({ type: 'architecture_baseline', ...value }, '架构基线采样');
        return value;
      } catch {
        if (!closed) { lastError = { code: 'sample_failed', at: new Date(now()).toISOString() }; logger.warn?.({ type: 'architecture_baseline_error', code: 'sample_failed' }, '架构基线采样失败'); }
        return null;
      } finally { pending = null; controller = null; }
    });
    return pending;
  }
  return { read, sample,
    observeSummary(success, durationMs) { if (closed) return; reads[success ? 'success' : 'failed']++; if (Number.isFinite(durationMs) && durationMs >= 0) { reads.durationMs += durationMs; reads.maxDurationMs = Math.max(reads.maxDurationMs, durationMs); } },
    observeSlowConsumer() { if (!closed) slowConsumers++; },
    start() { if (closed || timer || intervalMs === 0) return; void sample(); timer = setInterval(() => void sample(), intervalMs); timer.unref(); },
    async close() { closed = true; clearInterval(timer); controller?.abort(); await pending; },
  };
}

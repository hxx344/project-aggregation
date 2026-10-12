import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failedPerpetualSummary, parsePerpetualSummary, perpetualMonitorSummary, readPerpetualSummary, unavailablePerpetualSummary } from '../lib/perpetual-summary.ts';

const now = Date.UTC(2026, 9, 7);
const source = (patch = {}) => ({ schemaVersion: 1, monitorId: 'perpetual', available: true, status: 'live', state: 'online',
  quoteUpdatedAt: now, updatedAt: now, staleAfterMs: 30_000, baseCount: 800, quoteCount: 5000,
  exchangeCount: 7, onlineExchangeCount: 7, liveExchangeCount: 7, message: '', ...patch });

test('overview uses actual quote times and source expiry, independently of a newer response or message time', () => {
  const live = perpetualMonitorSummary(parsePerpetualSummary(source()), undefined, now);
  assert.equal(live.status, 'live'); assert.equal(live.fetchedAt, new Date(now).toISOString());
  assert.equal(live.staleAfterMs, 30_000);
  assert.deepEqual(live.metrics.map(metric => metric.value), ['800', '7 / 7']);
  const old = source({ quoteUpdatedAt: now - 30_001, updatedAt: now, generatedAt: now });
  const stale = perpetualMonitorSummary(parsePerpetualSummary(old), undefined, now);
  assert.equal(stale.status, 'stale'); assert.equal(stale.fetchedAt, new Date(old.quoteUpdatedAt).toISOString());
  assert.equal(stale.metrics[1].label, '上次在线');
  assert.equal(perpetualMonitorSummary(source({ status: 'snapshot' }), undefined, now).status, 'stale');
  assert.equal(perpetualMonitorSummary(source({ quoteUpdatedAt: null }), undefined, now).status, 'stale');
});

test('partial coverage stays usable and explicitly describes missing platforms or books', () => {
  const partial = perpetualMonitorSummary(source({ status: 'partial', state: 'partial', onlineExchangeCount: 3, message: '行情待更新：bybit' }), undefined, now);
  assert.equal(partial.status, 'live'); assert.equal(partial.metrics[1].value, '3 / 7');
  assert.match(partial.note, /部分平台在线/); assert.match(partial.note, /bybit/);
  const marksOnly = perpetualMonitorSummary(source({ state: 'stale', liveExchangeCount: 0, message: '盘口过期或缺失' }), undefined, now);
  assert.equal(marksOnly.status, 'live'); assert.match(marksOnly.note, /部分盘口待更新/);
});

test('failed reads retain values and source times, then a successful source read recovers', () => {
  const live = perpetualMonitorSummary(source(), undefined, now), failed = failedPerpetualSummary(live);
  assert.equal(failed.status, 'stale'); assert.equal(failed.metrics, live.metrics);
  assert.equal(failed.fetchedAt, live.fetchedAt); assert.equal(failed.staleAfterMs, live.staleAfterMs);
  const recovered = perpetualMonitorSummary(source({ quoteUpdatedAt: now + 1000, baseCount: 801 }), failed, now + 1000);
  assert.equal(recovered.status, 'live'); assert.equal(recovered.metrics[0].value, '801');
  assert.equal(recovered.fetchedAt, new Date(now + 1000).toISOString());
});

test('missing data uses placeholders and an unavailable backend is an explicit failure', () => {
  const initial = perpetualMonitorSummary();
  assert.equal(initial.status, 'loading'); assert.deepEqual(initial.metrics.map(metric => metric.value), ['—', '—']);
  assert.equal(failedPerpetualSummary(initial).status, 'error');
  const connecting = perpetualMonitorSummary(source({ status: 'connecting', quoteCount: 0, baseCount: 0, onlineExchangeCount: 0, quoteUpdatedAt: null }), undefined, now);
  assert.equal(connecting.status, 'loading'); assert.deepEqual(connecting.metrics.map(metric => metric.value), ['—', '—']);
  const unavailable = parsePerpetualSummary(unavailablePerpetualSummary());
  const preview = perpetualMonitorSummary(unavailable);
  assert.equal(preview.status, 'error'); assert.equal(preview.fetchedAt, null);
  assert.deepEqual(preview.metrics.map(metric => metric.value), ['—', '—']);
  const live = perpetualMonitorSummary(source(), undefined, now);
  const failed = perpetualMonitorSummary(unavailable, live);
  assert.equal(failed.status, 'error'); assert.equal(failed.metrics, live.metrics); assert.equal(failed.fetchedAt, live.fetchedAt);
});

test('summary validates source identity, counters and timestamps before replacing retained data', () => {
  for (const patch of [{ monitorId: 'oil' }, { schemaVersion: 2 }, { onlineExchangeCount: 8 }, { baseCount: null },
    { quoteUpdatedAt: 'today' }, { quoteUpdatedAt: 9e15 }, { staleAfterMs: 0 }, { quoteCount: 10 }, { status: 'ok' }]) {
    assert.throws(() => parsePerpetualSummary(source(patch)), /响应无效/);
  }
});

test('overview requests only the small summary endpoint, with cancellation and no response caching', async () => {
  const controller = new AbortController();
  const value = await readPerpetualSummary(controller.signal, async (url, options) => {
    assert.equal(url, '/api/monitors/perpetual/summary'); assert.equal(options.signal, controller.signal); assert.equal(options.cache, 'no-store');
    return Response.json(source());
  });
  assert.equal(value.baseCount, 800);
  await assert.rejects(readPerpetualSummary(controller.signal, async () => new Response('', { status: 401 })), /更新失败/);
  await assert.rejects(readPerpetualSummary(controller.signal, async () => Response.json({})), /响应无效/);
});

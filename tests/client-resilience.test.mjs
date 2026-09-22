import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import { nextSnapshotExpiry, ageSnapshot } from '../src/hub-state.ts';
import { createOverviewDecoder, createStreamWatchdog } from '../src/overview-feed.ts';
import { createOverviewEncoder } from '../server/overview-stream.mjs';

test('API deadline releases a hanging fetch and a hanging body, without retrying mutations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const bodyHangs of [false, true]) {
    let calls = 0, signal, finish;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++; signal = options.signal;
      const pending = new Promise(resolve => { finish = resolve; });
      return bodyHangs ? { ok: true, status: 200, json: () => pending } : pending;
    });
    const result = api('/api/projects', { method: 'POST', timeoutMs: 100 });
    const rejected = assert.rejects(result, { name: 'TimeoutError' });
    await Promise.resolve(); t.mock.timers.tick(100); await rejected;
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
    finish(bodyHangs ? {} : Response.json({})); await Promise.resolve();
    t.mock.restoreAll();
  }
});

test('caller cancellation returns promptly even when transport ignores abort', async t => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
  const controller = new AbortController();
  const result = api('/api/overview', { signal: controller.signal });
  controller.abort(); await assert.rejects(result, { name: 'AbortError' });
});

const snapshot = (id, ttl = 10) => ({ project: { id, staleAfterSeconds: 120 }, staleAfterSeconds: ttl, state: 'online', updatedAt: new Date(100000).toISOString(), metrics: [], message: '' });
test('freshness wakes only at actual expiry, including the stricter source TTL', () => {
  const items = [snapshot('fast'), snapshot('slow', 30), { ...snapshot('static'), freshness: 'static' }];
  assert.equal(nextSnapshotExpiry(items, 105000), 110001);
  assert.equal(ageSnapshot(items[0], 110001).state, 'stale');
  assert.equal(nextSnapshotExpiry(items, 110001), 130001);
  assert.equal(nextSnapshotExpiry(items, 130001), null);
});

test('stream deltas preserve other projects and handle removal, order, revisions and reconnects', () => {
  let encode = createOverviewEncoder(); const decode = createOverviewDecoder();
  const send = projects => { const event = encode({ projects, generatedAt: new Date(105000).toISOString() }); return { event, data: decode(JSON.stringify(event)) }; };
  const a = snapshot('a'), b = snapshot('b');
  const first = send([a, b]).data;
  const beat = send([a, b]); assert.equal(beat.event.type, 'heartbeat'); assert.equal(beat.data, null);
  const changed = send([a, { ...b, project: { ...b.project, revision: 'new' } }]);
  assert.equal(changed.event.projects.length, 1); assert.equal(changed.data.projects[0], first.projects[0]);
  assert.equal(changed.data.projects[1].project.revision, 'new');
  assert.deepEqual(send([b, a]).data.projects.map(s => s.project.id), ['b', 'a']);
  assert.deepEqual(send([b]).data.projects.map(s => s.project.id), ['b']);
  assert.throws(() => decode(JSON.stringify({ type: 'patch', baseSequence: 100, sequence: 101, projects: [], order: [], generatedAt: new Date().toISOString() })), /sequence/);
  encode = createOverviewEncoder(); assert.deepEqual(send([a]).data.projects.map(s => s.project.id), ['a']);
});

test('an open but silent stream expires; heartbeat renews connection health only', () => {
  let now = 0; const watchdog = createStreamWatchdog(() => now);
  now = 39999; assert.equal(watchdog.expired(), false);
  now = 40000; assert.equal(watchdog.expired(), true);
  watchdog.received(); assert.equal(watchdog.expired(), false);
  now = 80000; assert.equal(watchdog.expired(), true);
});

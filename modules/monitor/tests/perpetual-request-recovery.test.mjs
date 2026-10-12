import test from 'node:test';
import assert from 'node:assert/strict';
import { startPerpetualFeed, readPerpetualSnapshot } from '../lib/perpetual-feed.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = generatedAt => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt, staleAfterMs: 30000,
  status: 'live', exchanges: [{ id: 'binance', status: 'live' }], quotes: [] });

function fixture(options = {}) {
  const timers = new Set(), requests = [], streams = [], data = [], states = [], errors = [];
  const feed = startPerpetualFeed({
    fetchSnapshot: signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    createStream: () => { const stream = { onmessage: null, onerror: null, closed: false, close() { this.closed = true; } }; streams.push(stream); return stream; },
    onData: value => data.push(value), onConnection: value => states.push(value), onError: value => errors.push(value),
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
    cancel: timer => timers.delete(timer),
    ...options,
  });
  function run(delay) {
    const pending = [...timers].filter(timer => timer.delay === delay);
    assert.ok(pending.length, `missing ${delay}ms timer`);
    for (const timer of pending) if (timers.delete(timer)) timer.callback();
  }
  return { feed, timers, requests, streams, data, states, errors, run };
}

test('foreground recovery preserves a healthy stream and its incremental baseline', async t => {
  let now = 0;
  const f = fixture({ monotonic: () => now }); t.after(() => f.feed.stop());
  f.requests[0].resolve({ ...snapshot(1000), streamId: 'live', sequence: 0 }); await tick();
  f.streams[0].onmessage({ data: JSON.stringify({ ...snapshot(1000), streamId: 'live', sequence: 0 }) });
  now = 1000;
  f.feed.resume(); f.feed.resume(); f.feed.resume();
  assert.equal(f.streams.length, 1); assert.equal(f.streams[0].closed, false);
  assert.equal(f.requests.length, 1); assert.equal(f.states.at(-1), 'stream');
  f.streams[0].onmessage({ data: JSON.stringify({ ...snapshot(2000), type: 'patch', streamId: 'live', sequence: 1, baseSequence: 0, patches: [], removed: [] }) });
  assert.equal(f.data.at(-1).sequence, 1);
});

test('wake after a frozen timer replaces only the stalled request and ignores its late response', async t => {
  let now = 0;
  const f = fixture({ monotonic: () => now }); t.after(() => f.feed.stop());
  const oldMessage = f.streams[0].onmessage;
  now = 12_001;
  f.feed.resume(); f.feed.resume();
  assert.equal(f.streams.length, 2); assert.equal(f.streams[0].closed, true);
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].signal.aborted, true);
  await tick();
  assert.equal(f.errors.length, 0, 'retired request must not report an error');
  assert.equal([...f.timers].filter(timer => timer.delay === 12_000).length, 2, 'new stream and request deadlines survive old cleanup');
  f.requests[1].resolve(snapshot(3000)); await tick();
  f.requests[0].resolve(snapshot(9000)); oldMessage({ data: JSON.stringify(snapshot(10000)) }); await tick();
  assert.equal(f.data.at(-1).generatedAt, 3000);
});

test('a stale stream resumes once without canceling a recent manual read', async t => {
  let now = 0;
  const f = fixture({ monotonic: () => now }); t.after(() => f.feed.stop());
  f.requests[0].resolve(snapshot(1000)); await tick();
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(2000)) });
  now = 11_000; f.feed.refresh();
  now = 12_001; f.feed.resume(); f.feed.resume();
  assert.equal(f.streams.length, 2); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].signal.aborted, false);
  assert.equal(f.data.at(-1).generatedAt, 2000, 'existing quotes remain visible while recovering');
  f.streams[1].onmessage({ data: JSON.stringify(snapshot(4000)) });
  f.requests[1].resolve(snapshot(3000)); await tick();
  assert.equal(f.data.at(-1).generatedAt, 4000); assert.equal(f.states.at(-1), 'stream');
});

test('foreground recovery immediately retries a failed stream but coalesces repeated events', async t => {
  let now = 0;
  const f = fixture({ monotonic: () => now }); t.after(() => f.feed.stop());
  f.requests[0].resolve(snapshot(1000)); await tick();
  f.streams[0].onerror();
  f.feed.resume(); f.feed.resume();
  assert.equal(f.streams.length, 2); assert.equal(f.requests.length, 2);
  f.streams[1].onerror(); f.feed.resume();
  assert.equal(f.streams.length, 2, 'rapid failed restores must not open unbounded connections');
  now = 1000; f.feed.resume();
  assert.equal(f.streams.length, 3);
});

test('resuming an initial connection or a stopped feed does not start extra work', async () => {
  let now = 0;
  const f = fixture({ monotonic: () => now });
  f.feed.resume(); f.feed.resume();
  assert.equal(f.streams.length, 1); assert.equal(f.requests.length, 1);
  f.feed.stop(); now = 60_000; f.feed.resume(); await tick();
  assert.equal(f.streams.length, 1); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test('a first snapshot starts alongside SSE and displays data even when the stream is silent', async t => {
  const f = fixture(); t.after(() => f.feed.stop());
  assert.equal(f.requests.length, 1); assert.equal(f.streams.length, 1);
  f.requests[0].resolve(snapshot(1000)); await tick();
  assert.equal(f.data[0].exchanges.length, 1); assert.equal(f.states.at(-1), 'polling');
  f.run(5000); assert.equal(f.requests.length, 2);
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(2000)) });
  f.requests[1].resolve(snapshot(1500)); await tick();
  assert.equal(f.data.at(-1).generatedAt, 2000); assert.equal(f.states.at(-1), 'stream');
  assert.equal([...f.timers].some(timer => timer.delay === 5000), false);
});

test('a transport that ignores abort cannot trap initial loading or prevent a successful retry', async t => {
  const f = fixture(); t.after(() => f.feed.stop());
  f.run(12000); await tick();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.states.at(-1), 'error'); assert.match(f.errors.at(-1), /12 秒.*5 秒后/);
  f.run(5000); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(snapshot(3000)); await tick();
  assert.equal(f.data.length, 1); assert.equal(f.errors.at(-1), '');
  f.requests[0].resolve(snapshot(9000)); await tick();
  assert.equal(f.data.length, 1); assert.equal(f.data[0].generatedAt, 3000, 'late canceled result must not win even with a newer timestamp');
});

test('manual refresh can recover immediately after timeout and remains single-flight', async t => {
  const f = fixture(); t.after(() => f.feed.stop());
  f.feed.refresh(); assert.equal(f.requests.length, 1);
  f.run(12000); await tick();
  f.feed.refresh(); f.feed.refresh(); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(snapshot(4000)); await tick();
  assert.equal(f.data[0].generatedAt, 4000); assert.equal(f.states.at(-1), 'polling');
});

test('manual refresh waits for an existing snapshot request so its result can display immediately', async t => {
  const f = fixture(); t.after(() => f.feed.stop());
  const completion = f.feed.refresh();
  assert.equal(f.feed.refresh(), completion); assert.equal(f.requests.length, 1);
  let flushed = false;
  void completion.then(() => { flushed = true; });
  await tick(); assert.equal(flushed, false);
  f.requests[0].resolve(snapshot(4500)); await completion;
  assert.equal(flushed, true); assert.equal(f.data.at(-1).generatedAt, 4500);
});

test('the twenty-second display interval also controls fallback polling and its retry message', async t => {
  const f = fixture({ pollIntervalMs: () => 20_000 }); t.after(() => f.feed.stop());
  f.requests[0].reject(Error('offline')); await tick();
  assert.match(f.errors.at(-1), /20 秒后/);
  assert.equal([...f.timers].some(timer => timer.delay === 5000), false);
  f.run(20_000); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(snapshot(4000)); await tick();
  assert.equal(f.data.at(-1).generatedAt, 4000);
});

test('stopping an uncooperative request releases all timers without an error or late update', async () => {
  const f = fixture(); f.feed.stop(); await tick();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.timers.size, 0);
  f.requests[0].resolve(snapshot(5000)); await tick();
  assert.equal(f.data.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.timers.size, 0);
});

test('a live stream remains healthy when its pending snapshot times out', async t => {
  const f = fixture(); t.after(() => f.feed.stop());
  const requestTimeout = [...f.timers].at(-1);
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(6000)) });
  f.timers.delete(requestTimeout); requestTimeout.callback(); await tick();
  assert.equal(f.states.at(-1), 'stream'); assert.equal(f.errors.at(-1), '');
  assert.equal(f.data.at(-1).generatedAt, 6000);
  assert.equal([...f.timers].some(timer => timer.delay === 5000), false);
});

for (const status of [401, 403, 502, 503, 504]) {
  test(`snapshot HTTP ${status} is reported with its status instead of indefinite connecting`, async t => {
    const f = fixture(); t.after(() => f.feed.stop());
    const error = await readPerpetualSnapshot(new AbortController().signal,
      async () => new Response('private upstream details', { status })).catch(error => error);
    f.requests[0].reject(error); await tick();
    assert.equal(f.states.at(-1), 'error'); assert.match(f.errors.at(-1), new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(f.errors.at(-1), /private upstream/);
    assert.match(f.errors.at(-1), /5 秒后/);
  });
}

test('HTML and invalid schema are visible failures, and successful snapshots retain their source time', async () => {
  for (const body of ['<html>login</html>', JSON.stringify({ quotes: [] })]) {
    await assert.rejects(readPerpetualSnapshot(new AbortController().signal,
      async () => new Response(body)), /无效数据/);
  }
  const old = snapshot(10);
  assert.deepEqual(await readPerpetualSnapshot(new AbortController().signal,
    async () => Response.json(old)), old);
});

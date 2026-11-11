import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceStore } from '../src/live-resource.ts';

function harness() {
  let now = 0, hidden = false, online = true, wake = null, nextId = 0;
  const timers = new Map();
  const env = {
    now: () => now, hidden: () => hidden, online: () => online,
    setTimer: (callback, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimer: id => { timers.delete(id); },
    listen: handler => { wake = handler; return () => { wake = null; }; },
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    store: createResourceStore(env), timers,
    listening: () => wake !== null,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].callback(); await flush();
      }
      now = end; await flush();
    },
    async setHidden(value) { hidden = value; wake?.(); await flush(); },
    async setOnline(value) { online = value; wake?.(); await flush(); },
    flush,
  };
}

// Each call returns a deferred response the test resolves explicitly.
function source(intervalMs) {
  const calls = [];
  const read = signal => new Promise((resolve, reject) => {
    const call = { signal, resolve, reject };
    calls.push(call);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return { calls, source: { read, intervalMs } };
}
const watch = () => { const seen = []; return { seen, listener: snapshot => seen.push(snapshot), last: () => seen.at(-1) }; };

test('subscribers of one key share a single request and result', async () => {
  const h = harness(), { calls, source: src } = source(15_000), a = watch(), b = watch();
  h.store.subscribe('/host', src, a.listener);
  h.store.subscribe('/host', src, b.listener);
  assert.equal(calls.length, 1);
  calls[0].resolve({ cpu: 1 }); await h.flush();
  assert.deepEqual(a.last().data, { cpu: 1 });
  assert.equal(b.last().status, 'ready');
  assert.equal(b.last().receivedAt, 0);
});

test('the shortest subscriber interval drives polling and reads never overlap', async () => {
  const h = harness(), slow = source(15_000), fast = source(5_000), w = watch();
  const leave = h.store.subscribe('/host', slow.source, w.listener);
  slow.calls[0].resolve(1); await h.flush();
  await h.advance(3_000);
  h.store.subscribe('/host', fast.source, watch().listener);
  assert.equal(slow.calls.length, 1, 'a fresh result is reused when the new interval has not elapsed');
  await h.advance(2_000);
  assert.equal(slow.calls.length, 2, 'the first subscriber read function serves the key');
  await h.advance(20_000);
  assert.equal(slow.calls.length, 2, 'no new read while one is in flight');
  slow.calls[1].resolve(2); await h.flush();
  await h.advance(5_000);
  assert.equal(slow.calls.length, 3);
  slow.calls[2].resolve(3); await h.flush();
  leave();
  await h.advance(5_000);
  assert.equal(slow.calls.length, 4, 'remaining subscriber keeps its own interval');
});

test('a new subscriber with a shorter interval reads at once when the result is older than it allows', async () => {
  const h = harness(), slow = source(15_000), w = watch();
  h.store.subscribe('/host', slow.source, w.listener);
  slow.calls[0].resolve(1); await h.flush();
  await h.advance(10_000);
  h.store.subscribe('/host', source(5_000).source, watch().listener);
  assert.equal(slow.calls.length, 2);
});

test('hidden and offline abort the read, keep data and resume immediately', async () => {
  const h = harness(), { calls, source: src } = source(15_000), w = watch();
  h.store.subscribe('/accounts', src, w.listener);
  calls[0].resolve('old'); await h.flush();
  await h.advance(15_000);
  assert.equal(calls.length, 2);
  await h.setHidden(true);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(w.last().status, 'paused');
  assert.equal(w.last().data, 'old');
  await h.advance(60_000);
  assert.equal(calls.length, 2, 'background tab does not poll');
  await h.setHidden(false);
  assert.equal(calls.length, 3);
  assert.equal(w.last().status, 'loading');
  assert.equal(w.last().data, 'old', 'previous data stays visible but is not ready');
  calls[2].resolve('new'); await h.flush();
  await h.setOnline(false);
  assert.equal(w.last().status, 'offline');
  await h.advance(60_000);
  assert.equal(calls.length, 3);
  await h.setOnline(true);
  assert.equal(calls.length, 4);
});

test('a late response from an aborted read cannot overwrite newer data', async () => {
  const h = harness(), calls = [], w = watch();
  // This reader ignores abort, like a response that was already on its way.
  const read = () => new Promise(resolve => calls.push(resolve));
  h.store.subscribe('/digest', { read, intervalMs: 30_000 }, w.listener);
  h.store.commit('/digest', 'saved');
  calls[0]('stale'); await h.flush();
  assert.equal(w.last().data, 'saved');
  void h.store.refresh('/digest');
  void h.store.refresh('/digest');
  calls[2]('second'); await h.flush();
  calls[1]('first'); await h.flush();
  assert.equal(w.last().data, 'second', 'refresh supersedes the read before it');
});

test('commit makes write results current and restarts the interval from the write', async () => {
  const h = harness(), { calls, source: src } = source(10_000), w = watch();
  h.store.subscribe('/ledger', src, w.listener);
  calls[0].resolve('before'); await h.flush();
  await h.advance(8_000);
  h.store.commit('/ledger', 'written');
  assert.equal(w.last().data, 'written');
  assert.equal(w.last().status, 'ready');
  await h.advance(9_000);
  assert.equal(calls.length, 1);
  await h.advance(1_000);
  assert.equal(calls.length, 2);
});

test('failures keep the last result and retry on the interval; 401 stops until refresh', async () => {
  const h = harness(), { calls, source: src } = source(5_000), w = watch();
  h.store.subscribe('/host', src, w.listener);
  calls[0].resolve('ok'); await h.flush();
  await h.advance(5_000);
  calls[1].reject(new Error('timeout')); await h.flush();
  assert.equal(w.last().status, 'error');
  assert.equal(w.last().data, 'ok');
  assert.equal(w.last().error.message, 'timeout');
  await h.advance(5_000);
  assert.equal(calls.length, 3);
  calls[2].reject(Object.assign(new Error('login'), { status: 401 })); await h.flush();
  await h.advance(60_000);
  await h.setHidden(true); await h.setHidden(false);
  assert.equal(calls.length, 3, 'expired session is not retried by polling or wake');
  void h.store.refresh('/host');
  assert.equal(calls.length, 4);
  calls[3].resolve('again'); await h.flush();
  assert.equal(w.last().error, null);
});

test('parse failures are read failures and a synchronous throw does not wedge the key', async () => {
  const h = harness(), w = watch();
  let attempts = 0;
  const read = () => { attempts++; throw new Error('invalid'); };
  h.store.subscribe('/accounts', { read, intervalMs: 1_000 }, w.listener);
  await h.flush();
  assert.equal(w.last().status, 'error');
  await h.advance(1_000);
  assert.equal(attempts, 2);
});

test('the last subscriber leaving aborts the read and discards the cached result', async () => {
  const h = harness(), first = source(5_000);
  const leave = h.store.subscribe('/host', first.source, watch().listener);
  first.calls[0].resolve('session-a'); await h.flush();
  await h.advance(5_000);
  leave();
  assert.equal(first.calls[1].signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listening(), false);
  const second = source(5_000), w = watch();
  h.store.subscribe('/host', second.source, w.listener);
  assert.equal(w.last().data, null, 'a later subscriber never sees the discarded result');
  assert.equal(second.calls.length, 1);
});

test('one-shot resources read on subscribe and on refresh only', async () => {
  const h = harness(), { calls, source: src } = source(null), w = watch();
  h.store.subscribe('/feed', src, w.listener);
  calls[0].resolve('tokens'); await h.flush();
  await h.advance(600_000);
  assert.equal(calls.length, 1);
  await h.setHidden(true); await h.setHidden(false);
  assert.equal(calls.length, 1, 'a completed one-shot read is not repeated on wake');
  void h.store.refresh('/feed');
  assert.equal(calls.length, 2);
});

test('a refresh requested while hidden is kept and read on return', async () => {
  const h = harness(), { calls, source: src } = source(null), w = watch();
  h.store.subscribe('/feed', src, w.listener);
  calls[0].resolve('before-write'); await h.flush();
  await h.setHidden(true);
  void h.store.refresh('/feed');
  assert.equal(calls.length, 1);
  await h.setHidden(false);
  assert.equal(calls.length, 2, 'the write follow-up read is not swallowed');
  assert.equal(w.last().status, 'loading', 'old data is not reported as ready');
});

test('an expired session stays an error across hide and return', async () => {
  const h = harness(), { calls, source: src } = source(5_000), w = watch();
  h.store.subscribe('/accounts', src, w.listener);
  calls[0].reject(Object.assign(new Error('login'), { status: 401 })); await h.flush();
  await h.setHidden(true);
  await h.setHidden(false);
  assert.equal(w.last().status, 'error');
  assert.equal(calls.length, 1);
});

test('retune changes the interval without aborting the read or dropping data', async () => {
  const h = harness(), { calls, source: src } = source(15_000), w = watch();
  const handle = h.store.subscribe('/probes', src, w.listener);
  calls[0].resolve('idle'); await h.flush();
  await h.advance(2_000);
  handle.retune(3_000);
  assert.equal(calls.length, 1, 'not yet due under the shorter interval');
  await h.advance(1_000);
  assert.equal(calls.length, 2, 'the shorter interval applies from the last read');
  handle.retune(15_000);
  assert.equal(calls[1].signal.aborted, false, 'an in-flight read survives retuning');
  calls[1].resolve('running'); await h.flush();
  await h.advance(14_000);
  assert.equal(calls.length, 2);
  await h.advance(1_000);
  assert.equal(calls.length, 3);
  assert.equal(w.last().data, 'running');
});

test('retune reads at once when already due, follows wake, and is ignored when stopped or left', async () => {
  const h = harness(), { calls, source: src } = source(15_000), w = watch();
  const handle = h.store.subscribe('/probes', src, w.listener);
  calls[0].resolve('idle'); await h.flush();
  await h.advance(4_000);
  handle.retune(3_000);
  assert.equal(calls.length, 2, 'a shorter interval that has already elapsed reads at once');
  calls[1].resolve('running'); await h.flush();
  await h.setHidden(true);
  handle.retune(15_000);
  assert.equal(calls.length, 2, 'retuning while hidden does not read');
  await h.setHidden(false);
  assert.equal(calls.length, 3, 'a polled resource reads on return');
  calls[2].resolve('back'); await h.flush();
  handle.retune(null);
  await h.advance(60_000);
  assert.equal(calls.length, 3, 'null stops polling');
  assert.equal(h.timers.size, 0);
  void h.store.refresh('/probes');
  calls[3].reject(Object.assign(new Error('login'), { status: 401 })); await h.flush();
  await h.advance(5_000);
  handle.retune(1_000);
  await h.advance(5_000);
  assert.equal(calls.length, 4, 'an expired session is not retried by retune');
  handle();
  handle.retune(500);
  assert.equal(h.timers.size, 0, 'retune after leaving has no effect');
});

test('subscribing while hidden waits for the page to become visible', async () => {
  const h = harness(), { calls, source: src } = source(5_000), w = watch();
  await h.setHidden(true);
  h.store.subscribe('/host', src, w.listener);
  assert.equal(calls.length, 0);
  assert.equal(w.last().status, 'paused');
  await h.setHidden(false);
  assert.equal(calls.length, 1);
});

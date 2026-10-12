import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRead } from '../src/latest-read.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('manual and polling reads deduplicate; mutation refresh supersedes an older reply', async () => {
  const reads = [], values = [], errors = [];
  const reader = createLatestRead({ canRead: () => true, load: signal => { const read = { ...deferred(), signal }; reads.push(read); return read.promise; }, onData: value => values.push(value), onError: error => errors.push(error) });
  const first = reader.refresh(); assert.equal(reader.refresh(), first); await Promise.resolve(); assert.equal(reads.length, 1);
  const afterMutation = reader.refresh(true); await Promise.resolve(); assert.equal(reads.length, 2); assert.equal(reads[0].signal.aborted, true);
  reads[1].resolve('new'); await afterMutation; reads[0].resolve('old'); await first;
  assert.deepEqual(values, ['new']); assert.deepEqual(errors, []);
});

test('hidden state cancels reads, suppresses an ignored abort and resumes immediately', async () => {
  let active = true; const reads = [], values = [];
  const reader = createLatestRead({ canRead: () => active, load: signal => { const read = { ...deferred(), signal }; reads.push(read); return read.promise; }, onData: value => values.push(value), onError: () => assert.fail('cancelled read error') });
  const pending = reader.refresh(); await Promise.resolve(); active = false; reader.cancel();
  await reader.refresh(); assert.equal(reads.length, 1); reads[0].resolve('hidden'); await pending; assert.deepEqual(values, []);
  active = true; const resumed = reader.refresh(); await Promise.resolve(); reads[1].resolve('resumed'); await resumed; assert.deepEqual(values, ['resumed']);
});

test('deadline abort reaches transport and leaves a new refresh available', async () => {
  const errors = []; let count = 0;
  const reader = createLatestRead({ timeoutMs: 5, canRead: () => true, load: signal => { count++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }, onData: () => assert.fail('timed-out data'), onError: error => errors.push(error) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await reader.refresh(); await reader.refresh(); assert.equal(count, 2); assert.equal(errors.length, 2); assert.equal(errors[0].name, 'TimeoutError'); } finally { clearTimeout(keepAlive); reader.cancel(); }
});

test('an ignored timeout releases polling and late success or rejection cannot overwrite recovery', async () => {
  const reads = [], values = [], errors = [];
  const reader = createLatestRead({ timeoutMs: 5, canRead: () => true,
    load: () => { const read = deferred(); reads.push(read); return read.promise; },
    onData: value => values.push(value), onError: error => errors.push(error),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await reader.refresh(); await reader.refresh();
    const recovered = reader.refresh(); await Promise.resolve(); reads[2].resolve('fresh'); await recovered;
    reads[0].resolve('obsolete'); reads[1].reject(new Error('late transport failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(values, ['fresh']); assert.equal(errors.length, 2);
    assert.ok(errors.every(error => error.name === 'TimeoutError'));
  } finally { clearTimeout(keepAlive); reader.cancel(); }
});

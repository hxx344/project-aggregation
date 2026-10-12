import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadActivity, readActivity } from '../lib/read-activity.ts';
import { startActivityPolling } from '../lib/polling.ts';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('background permission requires a handshake and a boolean grant, independently of foreground activity', () => {
  const activity = createReadActivity(true);
  activity.update(false, true); assert.equal(activity.allowed(false), false);
  activity.connect(); assert.equal(activity.allowed(false), false);
  activity.update(true); assert.equal(activity.allowed(false), true); assert.equal(activity.allowed(true), false);
  activity.update(false, true); assert.equal(activity.allowed(true), true); assert.equal(activity.background(false), true);
  activity.update(false, 'true'); assert.equal(activity.allowed(false), false);
  activity.configure(false); assert.equal(activity.allowed(true), true);
});

test('trusted background host permission preserves an in-flight read, slows polling and refreshes on foreground return', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  readActivity.configure(true); t.after(() => readActivity.configure(false));
  const page = Object.assign(new EventTarget(), { hidden: false });
  let calls = 0, release, signal;
  const values = [];
  const poll = startActivityPolling({ page, intervalMs: 1000,
    load: input => { calls++; signal = input; return new Promise(resolve => { release = resolve; }); },
    onData: value => values.push(value), onError: assert.fail });
  t.after(() => poll.stop()); await flush(); assert.equal(calls, 0);
  readActivity.connect(); readActivity.update(true, true); await flush(); assert.equal(calls, 1);
  readActivity.update(false, true); assert.equal(signal.aborted, false);
  release(1); await flush(); assert.deepEqual(values, [1]);
  t.mock.timers.tick(29_999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  const oldSignal = signal, oldRelease = release;
  readActivity.update(true, true); await flush(); assert.equal(calls, 3, 'Foreground replaces the pending background read');
  assert.equal(oldSignal.aborted, true); oldRelease(2); await flush(); assert.deepEqual(values, [1]);
  release(3); await flush();
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 4);
  readActivity.update(false, false); assert.equal(signal.aborted, true);
  release(4); await flush(); assert.deepEqual(values, [1, 3], 'Permission revocation discards old results');
});

test('focus and pageshow replace a hung background read even before visibility catches up', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const view = new EventTarget(), page = Object.assign(new EventTarget(), { hidden: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: view });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const calls = [], values = [];
  const poll = startActivityPolling({ page, intervalMs: 1000,
    load: signal => new Promise(resolve => calls.push({ signal, resolve })), onData: value => values.push(value), onError: assert.fail });
  t.after(() => poll.stop()); await flush(); assert.equal(calls.length, 1);
  view.dispatchEvent(new Event('focus')); await flush(); assert.equal(calls.length, 2); assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve('old'); await flush();
  const current = poll.refresh(); await flush(); assert.equal(calls.length, 2, 'Late finally cannot release the newer request slot');
  calls[1].resolve('focus'); await current; assert.deepEqual(values, ['focus']);
  view.dispatchEvent(new Event('pageshow')); await flush(); assert.equal(calls.length, 3);
  calls[2].resolve('pageshow'); await flush(); assert.deepEqual(values, ['focus', 'pageshow']);
});

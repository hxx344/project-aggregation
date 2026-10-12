import test from 'node:test';
import assert from 'node:assert/strict';
import { startRefreshLoop } from '../lib/refresh-loop.ts';

test('background sync keeps one minute cadence and foreground/network recovery refreshes promptly', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = Object.assign(new EventTarget(), { hidden: false }), view = new EventTarget();
  let online = true, calls = 0, active = false;
  const loop = startRefreshLoop({ page, view, enabled: () => online, onActivity: value => { active = value; }, refresh: () => { calls++; } });
  assert.equal(calls, 1);
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(59_999); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.equal(calls, 2);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); assert.equal(calls, 3);
  online = false; view.dispatchEvent(new Event('offline')); assert.equal(active, false);
  t.mock.timers.tick(60_000); assert.equal(calls, 3);
  online = true; view.dispatchEvent(new Event('online')); assert.equal(calls, 4);
  view.dispatchEvent(new Event('focus')); assert.equal(calls, 5);
  view.dispatchEvent(new Event('pageshow')); assert.equal(calls, 6);
  loop.stop(); t.mock.timers.tick(60_000); view.dispatchEvent(new Event('focus'));
  assert.equal(calls, 6); assert.equal(active, false);
});

test('inactive old hosts start no sync until activity is granted', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = Object.assign(new EventTarget(), { hidden: true }), view = new EventTarget();
  let permitted = false, calls = 0;
  const loop = startRefreshLoop({ page, view, enabled: () => permitted, onActivity: () => {}, refresh: () => { calls++; } });
  t.mock.timers.tick(60_000); assert.equal(calls, 0);
  permitted = true; loop.synchronize(); assert.equal(calls, 1);
  t.mock.timers.tick(60_000); assert.equal(calls, 2);
  loop.stop();
});

test('explicit restore invokes the existing single-flight sync even before visibility catches up', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = Object.assign(new EventTarget(), { hidden: true }), view = new EventTarget();
  let calls = 0;
  const loop = startRefreshLoop({ page, view, enabled: () => true, onActivity: () => {}, refresh: () => { calls++; } });
  view.dispatchEvent(new Event('focus')); view.dispatchEvent(new Event('pageshow'));
  t.mock.timers.tick(60_000); loop.stop();
  assert.equal(calls, 4);
});

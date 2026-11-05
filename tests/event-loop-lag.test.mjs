import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLoopLag } from '../server/runtime/event-loop-lag.mjs';

function clock() {
  let mono = 1_000_000, wall = Date.parse('2026-11-05T01:23:54.000Z');
  return { mono: () => mono, now: () => wall, advance(ms) { mono += ms; wall += ms; } };
}
const manual = c => createEventLoopLag({ mono: c.mono, now: c.now, setTimer: () => ({}), clearTimer() {} });

test('a late tick is recorded as a stall with its end time and windows age it out', () => {
  const c = clock(), lag = manual(c);
  lag.start();
  c.advance(100); lag.observe(); // on time
  c.advance(130); lag.observe(); // 30 ms jitter, below the stall threshold
  c.advance(2_700); lag.observe(); // blocked ~2.6 s, like the cost-research report
  let value = lag.read();
  assert.equal(value.monitoring, true);
  assert.equal(value.lastMinute.maxMs, 2_600);
  assert.equal(value.lastMinute.stalls, 1);
  assert.deepEqual(value.recentStalls, [{ endedAt: '2026-11-05T01:23:56.930Z', durationMs: 2_600 }]);

  for (let i = 0; i < 700; i++) { c.advance(100); lag.observe(); } // 70 s of healthy ticks
  value = lag.read();
  assert.equal(value.lastMinute.maxMs, 0, 'the stall has left the 1 minute window');
  assert.equal(value.lastFiveMinutes.maxMs, 2_600);
  assert.equal(value.lastFiveMinutes.stalls, 1);

  for (let i = 0; i < 3_000; i++) { c.advance(100); lag.observe(); } // 5 more minutes
  value = lag.read();
  assert.equal(value.lastFiveMinutes.maxMs, 0);
  assert.equal(value.lastFiveMinutes.stalls, 0);
  assert.equal(value.recentStalls.length, 1, 'the stall list keeps aged stalls');
});

test('a wall clock jump is not a stall and the stall list is bounded, newest first', () => {
  const c = clock(), lag = manual(c);
  let wallOffset = 0;
  const jumped = createEventLoopLag({ mono: c.mono, now: () => c.now() + wallOffset, setTimer: () => ({}), clearTimer() {} });
  jumped.start(); wallOffset = 3_600_000; c.advance(100); jumped.observe();
  assert.equal(jumped.read().lastMinute.stalls, 0);

  lag.start();
  for (let i = 1; i <= 25; i++) { c.advance(100 + 300 + i); lag.observe(); }
  const stalls = lag.read().recentStalls;
  assert.equal(stalls.length, 20);
  assert.equal(stalls[0].durationMs, 325);
  assert.equal(stalls.at(-1).durationMs, 306);
});

test('no samples reads as unknown, and stop ends monitoring', () => {
  const c = clock(); let cleared = 0;
  const lag = createEventLoopLag({ mono: c.mono, now: c.now, setTimer: () => ({ unref() {} }), clearTimer() { cleared += 1; } });
  assert.equal(lag.read().since, null);
  lag.start();
  assert.deepEqual(lag.read().lastMinute, { maxMs: null, stalls: 0 });
  lag.stop();
  assert.equal(cleared, 1); assert.equal(lag.read().monitoring, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLoopLag } from '../server/runtime/event-loop-lag.mjs';
import { createStallProfiler, summarizeProfile } from '../server/runtime/stall-profiler.mjs';

const ROOT = '/opt/app/current/';
const frame = (functionName, url = '', lineNumber = -1) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '0' });

function profile() {
  // root → tick → buildReport → JSON.stringify ; root → (idle)
  return {
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 5] },
      { id: 2, callFrame: frame('tick', 'file:///opt/app/current/server/research.mjs', 9), children: [3] },
      { id: 3, callFrame: frame('buildReport', 'file:///opt/app/current/server/research.mjs', 41), children: [4] },
      { id: 4, callFrame: frame('stringify'), children: [] },
      { id: 5, callFrame: frame('(idle)'), children: [] },
    ],
    startTime: 0,
    // 10 s of idle, then 1.5 s in stringify under buildReport, then 0.3 s in buildReport itself.
    samples: [5, 5, 4, 4, 4, 3, 5],
    timeDeltas: [0, 10_000_000, 500_000, 500_000, 500_000, 500_000, 300_000],
    endTime: 12_400_000,
  };
}

test('the summary attributes the stall window to the functions and stack that ran', () => {
  const summary = summarizeProfile(profile(), { windowMs: 2_000, root: ROOT });
  assert.deepEqual(summary.top, [{ name: 'stringify', ms: 1_500 }, { name: 'buildReport server/research.mjs:42', ms: 300 }]);
  assert.equal(summary.busyMs, 1_800);
  assert.deepEqual(summary.stacks[0], { ms: 1_500, frames: ['stringify', 'buildReport server/research.mjs:42', 'tick server/research.mjs:10'] });
  // The 10 s idle stretch before the window is left out, and idle never counts as busy.
  assert.equal(summarizeProfile(profile(), { windowMs: 60_000, root: ROOT }).busyMs, 1_800);
});

function fakeSession(calls, result = profile()) {
  return () => ({
    connect() { calls.push('connect'); },
    disconnect() { calls.push('disconnect'); },
    async post(method) { calls.push(method); return method === 'Profiler.stop' ? { profile: result } : {}; },
  });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a long stall arms sampling, the next one is logged with its hotspots, then the profiler rests', async () => {
  const calls = [], logs = [], timers = [];
  let now = 0;
  const profiler = createStallProfiler({ log: { warn: (fields, message) => logs.push({ fields, message }) }, openSession: fakeSession(calls), root: ROOT,
    mono: () => now, setTimer: (fn, ms) => { timers.push(ms); return { unref() {} }; }, clearTimer() {} });
  profiler.stall(800); await settle();
  assert.equal(calls.length, 0, 'a stall below the trigger does not profile');
  profiler.stall(2_100); await settle();
  assert.deepEqual(calls, ['connect', 'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
  assert.match(logs[0].message, /数据面卡顿 2100 ms，开始 CPU 采样/);
  assert.deepEqual(timers, [180_000]);
  now = 60_000; profiler.stall(1_900); await settle();
  assert.deepEqual(calls.slice(4), ['Profiler.stop', 'disconnect']);
  assert.match(logs[1].message, /数据面卡顿 1900 ms 期间的 CPU 热点（采样 1800 ms）：stringify 1500ms；buildReport server\/research\.mjs:42 300ms/);
  assert.deepEqual(logs[1].fields.stacks[0].frames.at(-1), 'tick server/research.mjs:10');
  now = 60_000 + 599_000; profiler.stall(3_000); await settle();
  assert.equal(calls.length, 6, 'no new sampling during the cooldown');
  now = 60_000 + 600_000; profiler.stall(3_000); await settle();
  assert.equal(calls.length, 10, 'sampling re-arms after the cooldown');
  profiler.stop(); await settle();
  assert.deepEqual(calls.slice(-2), ['Profiler.stop', 'disconnect']);
});

test('an inspector failure is logged once and never escapes into the stall monitor', async () => {
  const logs = [];
  const profiler = createStallProfiler({ log: { warn: (fields, message) => logs.push(message) },
    openSession: () => ({ connect() { throw new Error('inspector unavailable'); }, disconnect() {}, async post() {} }) });
  const lag = createEventLoopLag({ mono: () => 0, now: () => 0, setTimer: () => ({}), clearTimer() {}, onStall: ms => profiler.stall(ms) });
  assert.doesNotThrow(() => profiler.stall(5_000));
  await settle();
  assert.deepEqual(logs, ['数据面卡顿 5000 ms，开始 CPU 采样以定位下一次卡顿', '卡顿采样失败']);
  lag.stop();
});

test('the stall monitor reports each stall to its observer and survives an observer throwing', () => {
  let mono = 0;
  const seen = [];
  const lag = createEventLoopLag({ mono: () => mono, now: () => 0, setTimer: () => ({}), clearTimer() {}, onStall: ms => { seen.push(ms); throw new Error('observer'); } });
  lag.start();
  mono += 150; lag.observe();
  mono += 1_300; lag.observe();
  assert.deepEqual(seen, [1_200]);
  assert.equal(lag.read().lastMinute.stalls, 1);
});

test('a real profile of this process names the function that blocked the thread', async () => {
  const logs = [];
  const profiler = createStallProfiler({ log: { warn: (fields, message) => logs.push({ fields, message }) }, triggerMs: 100, samplingUs: 1_000 });
  profiler.stall(150);
  await new Promise(resolve => setTimeout(resolve, 50));
  function blockTheThreadForTest() { const end = performance.now() + 300; let spins = 0; while (performance.now() < end) spins += 1; return spins; }
  blockTheThreadForTest();
  profiler.stall(300);
  for (let index = 0; index < 100 && logs.length < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 20));
  profiler.stop();
  assert.equal(logs.length, 2);
  const names = logs[1].fields.stacks.flatMap(stack => stack.frames).join('\n');
  assert.match(names, /blockTheThreadForTest tests\/stall-profiler\.test\.mjs:\d+/);
});

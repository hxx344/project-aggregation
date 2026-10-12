import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualDisplay } from '../lib/perpetual-display.ts';

const snapshot = sequence => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 1000 + sequence,
  staleAfterMs: 30000, status: 'live', streamId: 'display-test', sequence, exchanges: [], quotes: [] });

function fixture() {
  let now = 0, id = 0;
  const timers = new Map(), data = [];
  const display = createPerpetualDisplay({ onData: value => data.push(value), now: () => now,
    schedule: (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; }, cancel: timer => timers.delete(timer) });
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  return { display, timers, data, advance };
}

test('initial data is immediate and continuous frames publish only the latest snapshot every twenty seconds', () => {
  const f = fixture();
  f.display.accept(snapshot(0));
  assert.equal(f.data.length, 1);
  for (let second = 1; second < 20; second++) { f.advance(1000); f.display.accept(snapshot(second)); }
  assert.equal(f.data.length, 1); assert.equal(f.timers.size, 1);
  f.advance(1000);
  assert.deepEqual(f.data.map(value => value.sequence), [0, 19]);
  f.display.accept(snapshot(20)); f.advance(19999);
  assert.equal(f.data.length, 2); f.advance(1);
  assert.deepEqual(f.data.map(value => value.sequence), [0, 19, 20]);
  f.display.stop();
});

test('sampling preserves all original source timestamps and does not synthesize fresh observations', () => {
  const f = fixture(), old = { ...snapshot(1), quotes: [{ exchange: 'a', symbol: 'BTCUSDT', bidAskAt: 5, receivedAt: 10 }] };
  f.display.accept(snapshot(0)); f.advance(1000); f.display.accept(old); f.advance(19000);
  assert.equal(f.data.at(-1), old); assert.equal(f.data.at(-1).generatedAt, 1001);
  assert.equal(f.data.at(-1).quotes[0].bidAskAt, 5); assert.equal(f.data.at(-1).quotes[0].receivedAt, 10);
});

test('manual or foreground flush is immediate, coalesces repeated events and starts a new display interval', () => {
  const f = fixture(); f.display.accept(snapshot(0)); f.advance(5000); f.display.accept(snapshot(1));
  f.display.flush(); f.display.flush();
  assert.deepEqual(f.data.map(value => value.sequence), [0, 1]); assert.equal(f.timers.size, 0);
  f.advance(1000); f.display.accept(snapshot(2)); f.advance(18999);
  assert.equal(f.data.length, 2); f.advance(1); assert.equal(f.data.at(-1).sequence, 2);
});

test('pause or offline reset discards buffered frames and lets the next connection display immediately', () => {
  const f = fixture(); f.display.accept(snapshot(0)); f.advance(1000); f.display.accept(snapshot(1));
  f.display.reset(); f.advance(20000);
  assert.equal(f.data.length, 1); assert.equal(f.timers.size, 0);
  f.display.accept(snapshot(2)); assert.equal(f.data.at(-1).sequence, 2);
});

test('stopping cannot publish a delayed frame or accept new data', () => {
  const f = fixture(); f.display.accept(snapshot(0)); f.advance(1000); f.display.accept(snapshot(1));
  const pending = [...f.timers.values()][0].callback;
  f.display.stop(); pending(); f.display.accept(snapshot(2)); f.display.flush();
  assert.equal(f.data.length, 1); assert.equal(f.timers.size, 0);
});

test('an idle display has no recurring timer and publishes immediately after a full interval', () => {
  const f = fixture(); f.display.accept(snapshot(0)); f.advance(60000);
  assert.equal(f.timers.size, 0); assert.equal(f.data.length, 1);
  f.display.accept(snapshot(1)); assert.equal(f.data.length, 2); assert.equal(f.timers.size, 0);
});

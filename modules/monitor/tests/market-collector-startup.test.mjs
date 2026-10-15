import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketCollector } from '../server/market-collector.mjs';

const NOW = Date.UTC(2026, 9, 16);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(rows, definitions) {
  let now = NOW, sequence = 0;
  const timers = new Map(), calls = [];
  const jobs = definitions.map(([id, action, intervalMs]) => ({ id, action, intervalMs, load: async () => {
    calls.push({ key: `${id}/${action}`, at: now });
    return { fetchedAt: new Date(now).toISOString() };
  } }));
  const store = { status: () => rows, raw: () => null, write() {}, fail() { assert.fail('Fixture collection must succeed'); } };
  const collector = createMarketCollector(store, { jobs, clock: () => now, timers: {
    setTimeout(fn, delay) { timers.set(++sequence, { fn, at: now + delay }); return sequence; },
    clearTimeout(id) { timers.delete(id); },
  } });
  return { collector, timers, calls, async advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); void timer.fn(); }
    await flush();
  } };
}

test('restart waits only the remaining source-age interval for persisted histories, with immediate quotes', async () => {
  const f = fixture([
    { key: 'hynix/history', source_ms: NOW - 8000, success_ms: NOW - 1000, saved_ms: NOW - 1000, error: null },
    { key: 'oil/funding', source_ms: NOW - 20_000, success_ms: NOW - 1000, error: null },
  ], [['hynix', 'quote', 10_000], ['hynix', 'history', 60_000], ['oil', 'funding', 300_000]]);
  try {
    f.collector.start(); await flush();
    assert.deepEqual(f.calls.map(call => call.key), ['hynix/quote']);
    await f.advance(51_999);
    assert.equal(f.calls.filter(call => call.key === 'hynix/history').length, 0);
    await f.advance(1);
    assert.equal(f.calls.find(call => call.key === 'hynix/history').at, NOW + 52_000);
    await f.advance(228_000);
    assert.equal(f.calls.find(call => call.key === 'oil/funding').at, NOW + 280_000);
  } finally { await f.collector.stop(); }
  assert.equal(f.timers.size, 0);
});

test('a recent save cannot defer old sources, failures, seed-only datasets, or missing histories', async () => {
  const f = fixture([
    { key: 'hynix/history', source_ms: NOW - 120_000, success_ms: NOW, saved_ms: NOW, error: null },
    { key: 'oil/history', source_ms: NOW, success_ms: NOW, error: 'upstream unavailable' },
    { key: 'oil/funding', source_ms: NOW, success_ms: null, error: null },
  ], [['hynix', 'history', 60_000], ['oil', 'history', 300_000], ['oil', 'funding', 300_000], ['oil', 'candles/15m', 60_000]]);
  try {
    f.collector.start(); await flush();
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls.every(call => call.at === NOW));
  } finally { await f.collector.stop(); }
});

test('equally fresh gold/oil histories remain staggered when their persisted refresh deadlines coincide', async () => {
  const f = fixture(['history', 'bz/history', 'bybit/history'].map(action => ({ key: 'cl-xau/' + action, source_ms: NOW - 8000, success_ms: NOW - 8000, error: null })),
    ['history', 'bz/history', 'bybit/history'].map(action => ['cl-xau', action, 60_000]));
  try {
    f.collector.start(); await flush();
    assert.equal(f.calls.length, 0);
    await f.advance(52_000);
    assert.deepEqual(f.calls.map(call => call.key), ['cl-xau/history']);
    await f.advance(350);
    assert.equal(f.calls.at(-1).key, 'cl-xau/bz/history');
    await f.advance(350);
    assert.equal(f.calls.at(-1).key, 'cl-xau/bybit/history');
  } finally { await f.collector.stop(); }
});

test('gold/oil starts are staggered independently of quotes and pause/stop cancel every delayed task', async () => {
  const f = fixture([], [
    ['cl-xau', 'quote', 30_000], ['cl-xau', 'history', 60_000], ['cl-xau', 'funding', 300_000],
    ['cl-xau', 'bz/quote', 30_000], ['cl-xau', 'bz/history', 60_000], ['cl-xau', 'bz/funding', 300_000],
  ]);
  try {
    f.collector.start(); await flush();
    assert.deepEqual(f.calls.map(call => call.key), ['cl-xau/quote', 'cl-xau/history', 'cl-xau/bz/quote']);
    await f.advance(349);
    assert.equal(f.calls.length, 3);
    await f.advance(1);
    assert.equal(f.calls.at(-1).key, 'cl-xau/funding');
    await f.collector.pause('cl-xau');
    assert.equal(f.timers.size, 0);
    await f.advance(10_000);
    assert.equal(f.calls.length, 4, 'paused histories cannot escape their delayed startup');
    f.collector.resume('cl-xau'); await flush();
    assert.equal(f.calls.length, 7);
    await f.collector.stop();
    await f.advance(60_000);
    assert.equal(f.calls.length, 7);
    assert.equal(f.timers.size, 0);
  } finally { await f.collector.stop(); }
});

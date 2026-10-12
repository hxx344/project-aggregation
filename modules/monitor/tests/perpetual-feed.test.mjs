import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerpetualClock, createPerpetualSnapshotAccumulator, parsePerpetualSnapshot, startPerpetualFeed } from "../lib/perpetual-feed.ts";

const snapshot = generatedAt => ({ schemaVersion: 1, monitorId: "perpetual", generatedAt, staleAfterMs: 30000, status: "live", exchanges: [], quotes: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('lifecycle field patches add and remove notices without changing quote ages', () => {
  const merge = createPerpetualSnapshotAccumulator();
  const initial = { ...snapshot(1000), streamId: 'notice-test', sequence: 0, quotes: [{ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100, bidAskAt: 1000, receivedAt: 1000 }] };
  merge(initial);
  const frame = { ...snapshot(2000), type: 'patch', streamId: 'notice-test', baseSequence: 0, sequence: 1, removed: [], patches: [['test:BTCUSDT', { delisting: true, delistingAt: 100000 }]] };
  const marked = merge(frame).quotes[0];
  assert.equal(marked.delisting, true); assert.equal(marked.delistingAt, 100000);
  assert.equal(marked.bidAskAt, 1000); assert.equal(marked.receivedAt, 1000);
  const cleared = merge({ ...frame, baseSequence: 1, sequence: 2, patches: [['test:BTCUSDT', { delisting: false, delistingAt: null }]] }).quotes[0];
  assert.equal(cleared.delisting, false); assert.equal(cleared.delistingAt, null);
  assert.equal(cleared.bid, 100); assert.equal(cleared.bidAskAt, 1000);
});

test('taker fee metadata patches reach the browser without confirming the quote age', () => {
  const merge = createPerpetualSnapshotAccumulator();
  merge({ ...snapshot(1000), streamId: 'fee-test', sequence: 0, quotes: [{ exchange: 'test', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: 100, bidAskAt: 1000, receivedAt: 1000 }] });
  const frame = { ...snapshot(32000), type: 'patch', streamId: 'fee-test', baseSequence: 0, sequence: 1, removed: [], patches: [['test:BTCUSDT', { takerFeeRate: 0.0006, takerFeeAt: 32000, takerFeeSource: 'bitget-contract' }]] };
  const current = merge(frame).quotes[0];
  assert.equal(current.takerFeeRate, 0.0006); assert.equal(current.takerFeeAt, 32000); assert.equal(current.takerFeeSource, 'bitget-contract');
  assert.equal(current.bidAskAt, 1000); assert.equal(current.receivedAt, 1000);
  const cleared = merge({ ...frame, baseSequence: 1, sequence: 2, patches: [['test:BTCUSDT', { takerFeeRate: null, takerFeeAt: null, takerFeeSource: null }]] }).quotes[0];
  assert.equal(cleared.takerFeeRate, null); assert.equal(cleared.takerFeeAt, null); assert.equal(cleared.takerFeeSource, null);
  assert.equal(cleared.bid, 100); assert.equal(cleared.bidAskAt, 1000);
});

function fixture(fetchSnapshot = async () => snapshot(1), options = {}) {
  const streams = [], timers = new Map(), data = [], statuses = [], errors = [];
  let id = 0;
  const feed = startPerpetualFeed({
    fetchSnapshot,
    createStream: () => { const stream = { onmessage: null, onerror: null, closed: false, close() { this.closed = true; } }; streams.push(stream); return stream; },
    onData: value => data.push(value), onConnection: value => statuses.push(value), onError: value => errors.push(value),
    schedule: (callback, delay) => { const timer = ++id; timers.set(timer, { callback, delay }); return timer; }, cancel: timer => timers.delete(timer),
    ...options,
  });
  function run(delay) { const timer = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(timer, `missing ${delay}ms timer`); timers.delete(timer[0]); timer[1].callback(); }
  return { feed, streams, timers, data, statuses, errors, run };
}

test("perpetual stream ignores old snapshots, falls back on error and retries streaming", async () => {
  const f = fixture(); await tick();
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(10)) });
  f.streams[0].onmessage({ data: JSON.stringify(snapshot(9)) });
  assert.deepEqual(f.data.map(item => item.generatedAt), [1, 10]);
  assert.equal(f.statuses.at(-1), "stream");
  f.streams[0].onerror(); await tick();
  assert.equal(f.streams[0].closed, true);
  assert.equal(f.statuses.at(-1), "polling");
  f.run(30000); assert.equal(f.streams.length, 2);
  f.streams[1].onmessage({ data: JSON.stringify(snapshot(11)) });
  assert.equal(f.statuses.at(-1), "stream");
  assert.equal([...f.timers.values()].some(timer => timer.delay === 5000), false);
  f.feed.stop(); assert.equal(f.timers.size, 0);
});

test("stop aborts pending requests and rejects late stream callbacks", async () => {
  let finish, signal;
  const f = fixture(input => { signal = input; return new Promise(resolve => { finish = resolve; }); });
  f.feed.refresh();
  const onmessage = f.streams[0].onmessage;
  f.feed.stop();
  assert.equal(signal.aborted, true); assert.equal(f.streams[0].closed, true);
  finish(snapshot(10)); onmessage({ data: JSON.stringify(snapshot(11)) }); await tick();
  assert.equal(f.data.length, 0); assert.equal(f.timers.size, 0);
});

test("silent streams switch to polling, failed requests retry without replacing prior data", async () => {
  let fail = false, calls = 0;
  const f = fixture(async () => { calls++; if (fail) throw Error("offline"); return snapshot(1); });
  await tick(); assert.equal(calls, 1); f.streams[0].onmessage({ data: JSON.stringify(snapshot(1)) }); fail = true;
  f.run(12000); await tick();
  assert.equal(f.statuses.at(-1), "error"); assert.equal(f.data.length, 2);
  f.run(5000); await tick(); assert.equal(calls, 3);
  f.feed.stop();
});

test("delta snapshots preserve untouched quote identities and no-change array identities", () => {
  const merge = createPerpetualSnapshotAccumulator();
  const first = merge({ ...snapshot(1), quotes: [{ exchange: "a", symbol: "BTCUSDT", bid: 100 }, { exchange: "b", symbol: "BTCUSDT", bid: 101 }] });
  const delta = { ...snapshot(2), type: "delta", updates: [], removed: [] }; delete delta.quotes;
  const unchanged = merge(delta); assert.equal(unchanged.quotes, first.quotes);
  const second = merge({ ...delta, generatedAt: 3, updates: [{ exchange: "b", symbol: "BTCUSDT", bid: 102 }] });
  assert.notEqual(second.quotes, first.quotes); assert.equal(second.quotes[0], first.quotes[0]); assert.equal(second.quotes[1].bid, 102);
  const synced = merge(JSON.parse(JSON.stringify({ ...second, generatedAt: 4 })));
  assert.equal(synced.quotes, second.quotes);
  const removed = merge({ ...delta, generatedAt: 5, removed: ["a:BTCUSDT"] });
  assert.equal(removed.quotes.length, 1); assert.equal(removed.quotes[0], second.quotes[1]);
  assert.equal(merge({ ...delta, generatedAt: 4, removed: ["b:BTCUSDT"] }), null);
});

test("a delta without a baseline triggers one snapshot recovery instead of rendering partial markets", async () => {
  let requests = 0, finish;
  const f = fixture(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(requests, 1);
  f.streams[0].onmessage({ data: JSON.stringify({ ...snapshot(2), type: "delta", updates: [], removed: [] }) });
  assert.equal(requests, 1); finish(snapshot(3));
  await tick(); assert.equal(requests, 1); assert.equal(f.streams[0].closed, true); assert.equal(f.data[0].generatedAt, 3);
  f.feed.stop();
});

test("visibility lifecycle can stop a feed and resume with a new stream without leaked polls", async () => {
  let requests = 0;
  const hidden = fixture(async () => { requests++; return snapshot(2); });
  hidden.streams[0].onmessage({ data: JSON.stringify(snapshot(1)) }); hidden.feed.stop();
  const resumed = fixture(async () => { requests++; return snapshot(3); });
  resumed.streams[0].onmessage({ data: JSON.stringify(snapshot(3)) }); await tick();
  assert.equal(requests, 2); assert.equal(hidden.timers.size, 0); assert.equal(resumed.data[0].generatedAt, 3);
  resumed.feed.stop();
});

test("invalid schema fails visibly instead of entering the data model", () => {
  assert.throws(() => parsePerpetualSnapshot({ ...snapshot(1), quotes: null }));
  assert.throws(() => parsePerpetualSnapshot({ ...snapshot(1), staleAfterMs: 0 }));
  const f = fixture(); f.streams[0].onmessage({ data: "bad json" });
  assert.equal(f.statuses.at(-1), "polling"); f.feed.stop();
});

const sequenced = (sequence = 0, streamId = "service-a", generatedAt = 1000 + sequence) => ({ ...snapshot(generatedAt), streamId, sequence });
const patch = (sequence, patches = [], extra = {}) => ({ ...sequenced(sequence), type: "patch", baseSequence: sequence - 1, patches, removed: [], ...extra });
const btc = { exchange: "a", symbol: "BTCUSDT", base: "BTC", quoteCurrency: "USDT", bid: 100, ask: 101, receivedAt: 1000, bidAskAt: 1000, markAt: 1000, fundingAt: 1000 };

test("compact patches apply changed fields, null removals and complete new identities", () => {
  const merge = createPerpetualSnapshotAccumulator();
  const first = merge({ ...sequenced(), quotes: [btc] });
  const second = merge(patch(1, [["a:BTCUSDT", { bid: 102, bidAskAt: 2000, receivedAt: 2000 }]]));
  assert.equal(second.quotes[0].ask, 101); assert.equal(second.quotes[0].bid, 102);
  assert.equal(first.quotes[0].bid, 100);
  const third = merge(patch(2, [["a:BTCUSDT", { bidAskAt: null }], ["b:BTCUSDT", { ...btc, exchange: "b" }]]));
  assert.equal(third.quotes.length, 2); assert.equal(third.quotes[0].bidAskAt, null);
  const unchanged = merge(patch(3)); assert.equal(unchanged.quotes, third.quotes);
  const removed = merge(patch(4, [], { removed: ["a:BTCUSDT"] })); assert.equal(removed.quotes.length, 1);
});

test("sequence ordering survives server clock rollback and restart while rejecting old HTTP baselines", () => {
  const merge = createPerpetualSnapshotAccumulator();
  merge({ ...sequenced(10, "service-a", 10000), quotes: [btc] });
  const rollback = merge(patch(11, [["a:BTCUSDT", { bid: 105 }]], { generatedAt: 9000 }));
  assert.equal(rollback.quotes[0].bid, 105);
  assert.equal(merge({ ...sequenced(9, "service-a", 11000), quotes: [btc] }), null);
  assert.throws(() => merge(patch(12, [], { streamId: "service-b" })), /基线/);
  const restarted = merge({ ...sequenced(0, "service-b", 8000), quotes: [btc] });
  assert.equal(restarted.generatedAt, 8000); assert.equal(restarted.sequence, 0);
  assert.equal(merge(patch(1, [["a:BTCUSDT", { bid: 106 }]], { streamId: "service-b", generatedAt: 8001 })).quotes[0].bid, 106);
});

test("a missing compact patch reconnects immediately and a fresh full frame restores the baseline", () => {
  const f = fixture();
  f.streams[0].onmessage({ data: JSON.stringify({ ...sequenced(), quotes: [btc] }) });
  f.streams[0].onmessage({ data: JSON.stringify(patch(2)) });
  assert.equal(f.streams.length, 2); assert.equal(f.streams[0].closed, true); assert.equal(f.statuses.at(-1), "connecting");
  f.streams[1].onmessage({ data: JSON.stringify({ ...sequenced(2), quotes: [btc] }) });
  f.streams[1].onmessage({ data: JSON.stringify(patch(3, [["a:BTCUSDT", { bid: 110 }]])) });
  assert.equal(f.data.at(-1).quotes[0].bid, 110); assert.equal(f.statuses.at(-1), "stream"); f.feed.stop();
});

test("repeated resync failures fall back to HTTP without opening unbounded streams", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return { ...sequenced(3), quotes: [btc] }; });
  f.streams[0].onmessage({ data: JSON.stringify(patch(1)) });
  assert.equal(f.streams.length, 2);
  f.streams[1].onmessage({ data: JSON.stringify(patch(2)) }); await tick();
  assert.equal(f.streams.length, 2); assert.equal(requests, 1); assert.equal(f.data.at(-1).sequence, 3); f.feed.stop();
});

test("viewer clock advances offline but reanchors to a recovered server frame regardless of local clock skew", () => {
  let elapsed = 100;
  const clock = createPerpetualClock(() => elapsed);
  assert.equal(clock.read(), 0); clock.accept(1800000000000);
  elapsed += 31000; assert.equal(clock.read(), 1800000031000); assert.equal(clock.quietFor(), 31000);
  clock.accept(1800000010000, undefined, true); assert.equal(clock.read(), 1800000010000);
  elapsed += 500; assert.equal(clock.read(), 1800000010500);
});

test("continuous delayed frames cannot turn a thirty-second-old observation into fresh data", () => {
  let elapsed = 0;
  const clock = createPerpetualClock(() => elapsed);
  clock.accept(1800000000000, "a", true);
  elapsed = 15000; assert.equal(clock.accept(1800000001000, "a"), 1800000015000);
  elapsed = 31000; assert.equal(clock.accept(1800000002000, "a"), 1800000031000);
  clock.accept(1799999900000, "a"); assert.equal(clock.read(), 1799999900000, "explicit server clock rollback starts a new time anchor");
  clock.accept(1799999800000, "b"); assert.equal(clock.read(), 1799999800000, "a restarted server uses its own clock");
});

test("more than twelve seconds of accumulating stream delay triggers an immediate resynchronization", () => {
  let elapsed = 0;
  const f = fixture(undefined, { monotonic: () => elapsed });
  f.streams[0].onmessage({ data: JSON.stringify({ ...sequenced(0, "service-a", 100000), quotes: [btc] }) });
  elapsed = 15000;
  f.streams[0].onmessage({ data: JSON.stringify(patch(1, [], { generatedAt: 101000 })) });
  assert.equal(f.streams.length, 2); assert.equal(f.statuses.at(-1), "connecting");
  f.streams[1].onmessage({ data: JSON.stringify({ ...sequenced(5, "service-a", 115000), quotes: [btc] }) });
  assert.equal(f.data.at(-1).generatedAt, 115000); f.feed.stop();
});

test("late HTTP data from a retired service cannot overwrite an already recovered SSE baseline", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.streams[0].onmessage({ data: JSON.stringify({ ...sequenced(5), quotes: [btc] }) });
  f.feed.refresh();
  f.streams[0].onmessage({ data: JSON.stringify({ ...sequenced(0, "service-b"), quotes: [{ ...btc, bid: 200 }] }) });
  finish({ ...sequenced(6, "service-a"), quotes: [btc] }); await tick();
  assert.equal(f.data.at(-1).streamId, "service-b"); assert.equal(f.data.at(-1).quotes[0].bid, 200); f.feed.stop();
});

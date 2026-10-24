import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualDisplay } from '../lib/perpetual-display.ts';
import { createPerpetualRankingSelector, defaultPerpetualFilters } from '../lib/perpetual-spreads.ts';

const snapshot = sequence => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 1000 + sequence,
  staleAfterMs: 30000, status: 'live', streamId: 'display-test', sequence, exchanges: [], quotes: [] });

const SOURCE = 1_000_000;
// Source time follows the fixture clock; confirmations carry the original observation time.
const quoted = (sequence, bookAt, extra = {}, status = 'live') => ({ ...snapshot(sequence), generatedAt: SOURCE + sequence * 1000,
  exchanges: [{ id: 'gate', name: 'Gate', kind: 'cex', status }],
  quotes: [{ exchange: 'gate', symbol: 'ORDER_USDT', bidAskAt: bookAt, markAt: bookAt, receivedAt: bookAt, fundingAt: SOURCE, ...extra }] });

function fixture({ source = false } = {}) {
  let now = 0, id = 0;
  const timers = new Map(), data = [];
  const display = createPerpetualDisplay({ onData: value => data.push(value), now: () => now, ...(source ? { sourceNow: () => SOURCE + now } : {}),
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

test('a displayed quote is replaced before it expires when a newer observation is already held back', () => {
  const f = fixture({ source: true });
  // Bulk confirmations plus server pacing can publish a book that is already 12 seconds old.
  f.display.accept(quoted(0, SOURCE - 12_000));
  f.advance(3000); f.display.accept(quoted(3, SOURCE - 2000));
  assert.equal(f.data.length, 1);
  // Expiry at source +18s; publish one display-clock tick earlier instead of waiting for +20s.
  f.advance(13_999); assert.equal(f.data.length, 1);
  f.advance(1); assert.deepEqual(f.data.map(value => value.sequence), [0, 3]);
  assert.equal(f.timers.size, 0);
});

test('quotes without a newer observation still expire on time and keep the regular interval', () => {
  const f = fixture({ source: true });
  f.display.accept(quoted(0, SOURCE - 12_000));
  // A frame that only repeats the old observation is not evidence of a fresher price.
  f.advance(3000); f.display.accept(quoted(3, SOURCE - 12_000, { fundingAt: SOURCE + 3000 }));
  f.advance(16_999); assert.equal(f.data.length, 1);
  f.advance(1); assert.deepEqual(f.data.map(value => value.sequence), [0, 3]);
});

test('already expired quotes wait for the regular interval and late confirmations publish immediately', () => {
  const stale = fixture({ source: true });
  stale.display.accept(quoted(0, SOURCE - 31_000));
  stale.advance(1000); stale.display.accept(quoted(1, SOURCE + 1000));
  stale.advance(18_999); assert.equal(stale.data.length, 1);
  stale.advance(1); assert.equal(stale.data.at(-1).sequence, 1);

  const late = fixture({ source: true });
  late.display.accept(quoted(0, SOURCE - 12_000));
  late.advance(18_500); late.display.accept(quoted(18, SOURCE + 18_000));
  assert.deepEqual(late.data.map(value => value.sequence), [0, 18]);
});

test('funding rates are replaced before the five-minute ranking limit', () => {
  const f = fixture({ source: true });
  f.display.accept(quoted(0, SOURCE, { fundingAt: SOURCE - 290_000 }));
  f.advance(1000); f.display.accept(quoted(1, SOURCE, { fundingAt: SOURCE + 1000 }));
  f.advance(7999); assert.equal(f.data.length, 1);
  f.advance(1); assert.equal(f.data.at(-1).sequence, 1);
});

test('an earlier expiry replaces the pending interval timer and later frames cannot postpone it', () => {
  const f = fixture({ source: true });
  f.display.accept(quoted(0, SOURCE - 12_000));
  f.advance(1000); f.display.accept(quoted(1, SOURCE - 12_000));
  assert.equal([...f.timers.values()][0].at, 20_000);
  f.advance(2000); f.display.accept(quoted(3, SOURCE + 3000));
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].at, 17_000);
  f.advance(1000); f.display.accept(quoted(4, SOURCE + 4000));
  assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].at, 17_000);
  f.advance(13_000); assert.deepEqual(f.data.map(value => value.sequence), [0, 4]);
});

test('confirmations that would expire before the regular publication do not shorten the interval', () => {
  const f = fixture({ source: true });
  // A slow poll confirming a nearly expired book cannot keep the row visible, so it must not cause churn.
  f.display.accept(quoted(0, SOURCE - 12_000));
  f.advance(1000); f.display.accept(quoted(1, SOURCE - 11_000));
  f.advance(18_999); assert.equal(f.data.length, 1);
  f.advance(1); assert.equal(f.data.at(-1).sequence, 1);
});

test('quotes outside the ranking do not trigger early publication', () => {
  for (const next of [quoted(3, SOURCE + 3000, {}, 'stale'), quoted(3, SOURCE + 3000, { comparable: false })]) {
    const f = fixture({ source: true });
    f.display.accept(quoted(0, SOURCE - 12_000));
    f.advance(3000); f.display.accept(next);
    f.advance(16_999); assert.equal(f.data.length, 1);
    f.advance(1); assert.equal(f.data.at(-1).sequence, 3);
  }
});

test('a pair confirmed through paced bulk books stays ranked across display intervals', () => {
  const f = fixture({ source: true }), select = createPerpetualRankingSelector(), missing = [];
  const venue = id => ({ id, name: id, kind: 'cex', status: 'live', marketCount: 1, quoteCount: 1, lastMessageAt: SOURCE, error: null });
  let previous = null;
  for (let second = 0; second <= 120; second++) {
    const at = SOURCE + second * 1000;
    // Five-second bulk confirmations arrive eight seconds after observation, so books are 8-12 seconds old.
    const bookAt = SOURCE - 12_000 + Math.floor((second * 1000 + 4000) / 5000) * 5000;
    if (previous?.bookAt !== bookAt) {
      const leg = (exchange, bid) => ({ exchange, symbol: 'ORDERUSDT', base: 'ORDER', quoteCurrency: 'USDT', bid, ask: bid + 0.001, mark: bid, last: bid,
        fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: at + 3_600_000, sourceTime: bookAt, receivedAt: at, transport: 'rest',
        bidAskAt: bookAt, markAt: bookAt, fundingAt: at });
      previous = { bookAt, frame: { ...snapshot(second), generatedAt: at, exchanges: [venue('binance'), venue('bybit')], quotes: [leg('binance', 0.1), leg('bybit', 0.102)] } };
    }
    f.display.accept({ ...previous.frame, sequence: second, generatedAt: at });
    if (!select(f.data.at(-1), defaultPerpetualFilters, at).length) missing.push(second);
    f.advance(1000);
  }
  assert.deepEqual(missing, []);
});

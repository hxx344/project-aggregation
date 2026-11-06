import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualDisplay } from '../lib/perpetual-display.ts';
import { createPerpetualDisplay as createHeadDisplay } from './fixtures/perpetual-display-head.ts';
import { classifyPerpetualQuote, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, perpetualSpreadKey, quoteIsFresh, quotePriceTime, rankPerpetualSpreads } from '../lib/perpetual-spreads.ts';

const snapshot = sequence => ({ schemaVersion: 1, monitorId: 'perpetual', generatedAt: 1000 + sequence,
  staleAfterMs: 30000, status: 'live', streamId: 'display-test', sequence, exchanges: [], quotes: [] });

const SOURCE = 1_000_000;
// Source time follows the fixture clock; confirmations carry the original observation time.
const quoted = (sequence, bookAt, extra = {}, status = 'live') => ({ ...snapshot(sequence), generatedAt: SOURCE + sequence * 1000,
  exchanges: [{ id: 'gate', name: 'Gate', kind: 'cex', status }],
  quotes: [{ exchange: 'gate', symbol: 'ORDER_USDT', bidAskAt: bookAt, markAt: bookAt, receivedAt: bookAt, fundingAt: SOURCE, ...extra }] });

function fixture({ source = false, create = createPerpetualDisplay, timerLag = () => 0 } = {}) {
  let now = 0, id = 0;
  const timers = new Map(), data = [], publishedAt = [];
  const display = create({ onData: value => { data.push(value); publishedAt.push(now); }, now: () => now, ...(source ? { sourceNow: () => SOURCE + now } : {}),
    schedule: (callback, delay) => { timers.set(++id, { callback, at: now + delay + timerLag(now + delay) }); return id; }, cancel: timer => timers.delete(timer) });
  const advance = milliseconds => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
      if (!next) break;
      now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  return { display, timers, data, publishedAt, advance, jump: milliseconds => { now += milliseconds; } };
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

// Cross-leg skew replay: Binance streams every second; Bybit's book time is scripted per second.
const pairVenue = (id, status = 'live') => ({ id, name: id, kind: 'cex', status, marketCount: 1, quoteCount: 1, lastMessageAt: SOURCE, error: null });
const pairLeg = (exchange, base, bid, bookAt, at) => ({ exchange, symbol: `${base}USDT`, base, quoteCurrency: 'USDT', bid, ask: bid + 0.001, mark: bid, last: bid,
  fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: at + 3_600_000, sourceTime: bookAt, receivedAt: at, transport: 'rest', bidAskAt: bookAt, markAt: bookAt, fundingAt: at });
const pairFrame = (second, bases, bybitStatus = 'live') => {
  const at = SOURCE + second * 1000;
  return { ...snapshot(second), generatedAt: at, exchanges: [pairVenue('binance'), pairVenue('bybit', bybitStatus)],
    quotes: bases.flatMap(([base, bybitSecond]) => [pairLeg('binance', base, 0.1, at, at), pairLeg('bybit', base, 0.102, SOURCE + bybitSecond * 1000, at)]) };
};
const exclusion = (frame, base, at) => {
  const legs = frame.quotes.filter(quote => quote.base === base), live = new Set(frame.exchanges.filter(venue => venue.status === 'live').map(venue => venue.id));
  if (legs.some(quote => !live.has(quote.exchange))) return 'offline';
  if (legs.some(quote => !quoteIsFresh(quote, 'book', at, frame.staleAfterMs))) return 'stale';
  return Math.abs(quotePriceTime(legs[0], 'book') - quotePriceTime(legs[1], 'book')) > 5000 ? 'skew' : 'ranked';
};
/** Real display scheduling plus the page's ranking selector, sampled on the page's one-second clock. */
function replaySkew({ seconds, bybitAt, status = () => 'live', events = {} }) {
  const f = fixture({ source: true }), select = createPerpetualRankingSelector(), timeline = [];
  let receiving = true;
  for (let second = 0; second <= seconds; second++) {
    const at = SOURCE + second * 1000;
    events[second]?.({ display: f.display, receive: value => { receiving = value; } });
    const frame = pairFrame(second, [['ORDER', bybitAt(second)]], status(second));
    if (receiving) f.display.accept(frame);
    const shown = f.data.at(-1), ranked = select(shown, defaultPerpetualFilters, at).length > 0;
    timeline.push({ second, received: receiving ? second : null, shown: shown.sequence, source: shown.quotes.map(quote => (quote.bidAskAt - SOURCE) / 1000), ranked, reason: exclusion(shown, 'ORDER', at) });
    assert.equal(ranked, timeline.at(-1).reason === 'ranked', `second ${second}: selector and replay reason agree`);
    if (second < seconds) f.advance(1000);
  }
  return { timeline, published: f.publishedAt.map(time => time / 1000), absent: timeline.filter(row => !row.ranked).map(row => row.second) };
}
// Bybit is one second behind until its book stalls at +13s. The +20s publication carries frame 19 (6s skew);
// Bybit realigns at +21s.
const skewThenRealign = second => second < 13 ? second - 1 : second <= 20 ? 13 : second;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

test('a pair removed only for leg skew returns on the realigned frame instead of waiting for the next interval', () => {
  const run = replaySkew({ seconds: 60, bybitAt: skewThenRealign });
  assert.deepEqual(run.timeline[19], { second: 19, received: 19, shown: 0, source: [0, -1], ranked: true, reason: 'ranked' });
  assert.deepEqual(run.timeline[20], { second: 20, received: 20, shown: 19, source: [19, 13], ranked: false, reason: 'skew' });
  assert.deepEqual(run.timeline[21], { second: 21, received: 21, shown: 21, source: [21, 21], ranked: true, reason: 'ranked' });
  assert.deepEqual(run.absent, [20]);
  // One extra recovery; the original deadline is preserved for every other pair.
  assert.deepEqual(run.published, [0, 20, 21, 40, 60]);
});

test('without a realigned observation the skewed pair stays out and no extra publication happens', () => {
  const run = replaySkew({ seconds: 60, bybitAt: second => second < 13 ? second - 1 : 13 });
  assert.deepEqual(run.published, [0, 20, 40, 60]);
  assert.deepEqual(run.absent, range(20, 60));
  assert.deepEqual([...new Set(run.timeline.slice(20).map(row => row.reason))], ['skew', 'stale']);
  assert.equal(run.timeline.find(row => row.reason === 'stale').second, 44);
});

test('a realigned observation from an offline venue does not trigger skew recovery', () => {
  const run = replaySkew({ seconds: 60, bybitAt: skewThenRealign, status: second => second <= 20 ? 'live' : 'stale' });
  assert.deepEqual(run.published, [0, 20, 40, 60]);
  assert.deepEqual(run.timeline[40].reason, 'offline');
  assert.deepEqual(run.absent, range(20, 60));
});

test('pausing details clears the recovery state; resuming displays immediately and keeps the regular interval', () => {
  const run = replaySkew({ seconds: 60, bybitAt: skewThenRealign, events: {
    21: ({ display, receive }) => { display.reset(); receive(false); },
    30: ({ receive }) => receive(true),
  } });
  assert.deepEqual(run.published, [0, 20, 30, 50]);
  assert.deepEqual(run.absent, range(20, 29));
  assert.ok(run.timeline.slice(21, 30).every(row => row.received === null && row.shown === 19));
});

test('background reception still recovers on the realigned frame and the foreground flush shows the latest frame', () => {
  const run = replaySkew({ seconds: 60, bybitAt: skewThenRealign, events: { 30: ({ display }) => display.flush() } });
  assert.deepEqual(run.published, [0, 20, 21, 30, 50]);
  assert.deepEqual(run.absent, [20]);
});

test('market-wide oscillating skew does not trade one excluded fifth for another with extra publications', () => {
  // Forty pairs whose paced book is 2-6 seconds old: every frame skews a different fifth of them,
  // so no publication, early or regular, can show all pairs; only the regular cadence publishes.
  const bases = Array.from({ length: 40 }, (_, index) => [`P${String(index).padStart(2, '0')}`, index % 5]);
  const f = fixture({ source: true });
  let shownAbsent = 0, latestAbsent = 0;
  for (let second = 0; second <= 600; second++) {
    const at = SOURCE + second * 1000;
    const frame = pairFrame(second, bases.map(([base, phase]) => [base, Math.floor((second - phase - 2) / 5) * 5 + phase]));
    f.display.accept(frame);
    shownAbsent += bases.length - rankPerpetualSpreads(f.data.at(-1), defaultPerpetualFilters, at).length;
    latestAbsent += bases.length - rankPerpetualSpreads(frame, defaultPerpetualFilters, at).length;
    if (second < 600) f.advance(1000);
  }
  assert.deepEqual(f.publishedAt.map(time => time / 1000), range(0, 30).map(index => index * 20));
  // The shown frames exclude no larger share than the stream itself does.
  assert.equal(latestAbsent, 8 * 601);
  assert.ok(shownAbsent <= latestAbsent, `shown ${shownAbsent} vs latest ${latestAbsent} absent pair-seconds`);
});

test('one recovery per regular publication: a pair that realigns after the recovery waits for the next interval', () => {
  const f = fixture({ source: true }), select = createPerpetualRankingSelector(), ranked = [];
  // EARLY realigns at +21s, LATE at +23s; both stalled at +13s for the +20s publication.
  const early = second => second < 13 ? second - 1 : second <= 20 ? 13 : second;
  const late = second => second < 13 ? second - 1 : second <= 22 ? 13 : second;
  for (let second = 0; second <= 45; second++) {
    f.display.accept(pairFrame(second, [['EARLY', early(second)], ['LATE', late(second)]]));
    ranked.push(select(f.data.at(-1), defaultPerpetualFilters, SOURCE + second * 1000).map(row => row.base).sort().join(','));
    if (second < 45) f.advance(1000);
  }
  assert.deepEqual(f.publishedAt.map(time => time / 1000), [0, 20, 21, 40]);
  assert.deepEqual(ranked.slice(19, 23), ['EARLY,LATE', '', 'EARLY', 'EARLY']);
  assert.equal(ranked.indexOf('EARLY,LATE', 20), 40);
});

test('an imminent expiry rescue coalesces a skew recovery without moving the regular deadline', () => {
  // AGING's Bybit book is 27 seconds old when the +20s publication shows it, so a newer observation forces an expiry rescue.
  const run = agingAt => {
    const f = fixture({ source: true }), select = createPerpetualRankingSelector(), ranked = [];
    for (let second = 0; second <= 45; second++) {
      f.display.accept(pairFrame(second, [['ORDER', skewThenRealign(second)], ['AGING', agingAt(second)]]));
      ranked.push(select(f.data.at(-1), defaultPerpetualFilters, SOURCE + second * 1000).some(row => row.base === 'ORDER'));
      if (second < 45) f.advance(1000);
    }
    return { published: f.publishedAt.map(time => time / 1000), absent: ranked.flatMap((value, second) => value ? [] : [second]) };
  };
  // The newer AGING observation arrives at +22s: one early publication both rescues it and returns ORDER.
  assert.deepEqual(run(second => second < 22 ? -7 : second), { published: [0, 20, 22, 42], absent: [20, 21] });
  // Without a newer observation the recovery waits until AGING has expired rather than publishing ahead of a possible rescue.
  assert.deepEqual(run(() => -7), { published: [0, 20, 24, 40], absent: [20, 21, 22, 23] });
});

const replayFilters = [
  { ...defaultPerpetualFilters, priceMode: 'book' },
  { ...defaultPerpetualFilters, priceMode: 'mark' },
  { ...defaultPerpetualFilters, priceMode: 'book', sortBy: 'funding' },
];

/** Compare the actual page selectors, by directed contract pair rather than aggregate row count. */
function differentialReplay(frames, timerLag = () => 0) {
  const runs = [createHeadDisplay, createPerpetualDisplay].map(create => ({
    ...fixture({ source: true, create, timerLag }),
    selectors: replayFilters.map(() => createPerpetualRankingSelector()),
    absent: new Map(), timeline: [], staleAt: new Map(),
  }));
  const universe = new Set();
  for (let second = 0; second < frames.length; second++) {
    const at = SOURCE + second * 1000;
    for (const run of runs) {
      if (second) run.advance(1000);
      if (frames[second]) run.display.accept(frames[second]);
      const shown = run.data.at(-1);
      const ranked = new Set(run.selectors.flatMap((select, index) =>
        select(shown, replayFilters[index], at).map(row => `${index}:${perpetualSpreadKey(row)}`)));
      for (const key of ranked) universe.add(key);
      run.timeline.push(ranked);
      for (const quote of shown.quotes) {
        for (const mode of ['book', 'mark', 'funding']) {
          const time = mode === 'funding' ? quote.fundingAt : quotePriceTime(quote, mode);
          const key = `${quote.exchange}:${quote.symbol}:${mode}:${time}`;
          const stale = mode === 'funding' ? at - time > 300_000
            : classifyPerpetualQuote(quote, mode, at, shown.staleAfterMs) === 'stale';
          // Expiration is still evaluated on the true source clock, never on publication time.
          if (stale) {
            assert.ok(mode === 'funding' ? normalizedFunding8h(quote, at) === null : !quoteIsFresh(quote, mode, at, shown.staleAfterMs));
            if (!run.staleAt.has(key)) run.staleAt.set(key, second);
          }
        }
      }
    }
  }
  for (const run of runs) for (const key of universe) run.absent.set(key, run.timeline.filter(rows => !rows.has(key)).length);
  return { head: runs[0], current: runs[1], frames };
}

function assertNoRegression(run, context) {
  const { head, current, frames } = run;
  for (const [key, seconds] of head.absent) assert.ok(current.absent.get(key) <= seconds,
    `${context}: ${key} absent current=${current.absent.get(key)}s HEAD=${seconds}s; publications current=${current.publishedAt} HEAD=${head.publishedAt}`);
  for (let second = 0; second < head.timeline.length; second++) for (const key of head.timeline[second]) {
    assert.ok(current.timeline[second].has(key), `${context}: ${key} newly absent at ${second}s`);
  }
  // Every original regular/expiry publication must be visible by the same instant.
  // This checks rescue times even when the one-second ranking sample cannot see a short delay.
  for (let index = 0; index < head.data.length; index++) {
    const at = head.publishedAt[index], frame = head.data[index];
    const shownIndex = current.publishedAt.findLastIndex(time => time <= at);
    assert.ok(current.data[shownIndex].sequence >= frame.sequence,
      `${context}: HEAD published sequence=${frame.sequence} at ${at}ms but current still shows ${current.data[shownIndex].sequence}`);
  }
  // A newer *real* observation may avoid stale display altogether. When the same observation
  // survives in both displays, its stale marker must not be postponed.
  for (const [key, at] of head.staleAt) {
    if (current.staleAt.has(key)) assert.ok(current.staleAt.get(key) <= at, `${context}: stale marker delayed for ${key}`);
  }
  for (const frame of current.data) assert.ok(frames.includes(frame), `${context}: display must publish an original whole frame`);
  const headEvents = new Set(head.publishedAt.map((at, index) => `${at}:${head.data[index].sequence}`));
  const extras = current.publishedAt.filter((at, index) => !headEvents.delete(`${at}:${current.data[index].sequence}`));
  assert.equal(headEvents.size, 0, `${context}: original scheduled publications must be preserved`);
  for (let index = 1; index < extras.length; index++) assert.ok(extras[index] - extras[index - 1] >= 20_000,
    `${context}: more than one added recovery in a rolling 20s interval: ${extras}`);
  for (let index = 0; index < head.publishedAt.length; index++) {
    const start = head.publishedAt[index], end = head.publishedAt[index + 1] ?? Infinity;
    assert.ok(extras.filter(at => at > start && at < end).length <= 1,
      `${context}: more than one recovery between HEAD publications ${start}..${end}`);
  }
  return extras.length;
}

const replayRowKeys = (frame, at) => new Set(replayFilters.flatMap((filters, index) =>
  rankPerpetualSpreads(frame, filters, at).map(row => `${index}:${perpetualSpreadKey(row)}`)));

// Independent oracle: remove only the skew gate by aligning *already fresh* fixture quotes.
// All other ranking gates, including actual prices, venue state and funding, stay in force.
function keysIgnoringSkew(frame, at) {
  return new Set(replayFilters.flatMap((filters, index) => {
    const quotes = frame.quotes.filter(quote => quoteIsFresh(quote, filters.priceMode, at, frame.staleAfterMs))
      .map(quote => ({ ...quote, bidAskAt: at, markAt: at, receivedAt: at }));
    return rankPerpetualSpreads({ ...frame, quotes }, filters, at).map(row => `${index}:${perpetualSpreadKey(row)}`);
  }));
}

/**
 * A continuously rankable received pair is shown within 20s + event-loop lateness:
 * both the rolling recovery budget and the next baseline deadline are at most 20s away.
 * Additionally, a safe frame must serve the oldest ready/recently-ready cohort at its first
 * budget slot. A reservation lapses one realignment gap (at least 20s) plus one display tick after
 * the last realignment. This model counts every realignment, including ones the display refuses
 * as unsafe, measures gaps between realignment starts, keeps the longest and ignores the display's
 * gap limit. Refused realignments between safe ones can make its gap shorter than the display's,
 * so it may lapse earlier and fail spuriously, but never later. This catches starvation hidden by HEAD
 * or by repeated short skew interruptions.
 */
function assertRecoveryLiveness(run, context, timerLatenessMs = 0) {
  const { head, current, frames } = run, waiting = new Map(), candidates = new Map(), seen = new Set();
  const baseline = new Set(head.publishedAt.map((at, index) => `${at}:${head.data[index].sequence}`));
  let publication = 0, latest, baselineFrame, recoveryAt = -Infinity, used = false;
  for (let second = 0; second < frames.length; second++) {
    const at = SOURCE + second * 1000;
    while (publication < current.data.length && current.publishedAt[publication] <= second * 1000) {
      const frame = current.data[publication], time = current.publishedAt[publication], source = SOURCE + time;
      const ranked = replayRowKeys(frame, source), eligible = keysIgnoringSkew(frame, source);
      for (const key of candidates.keys()) if (ranked.has(key)) candidates.delete(key);
      for (const key of eligible) if (!ranked.has(key) && seen.has(key) && !candidates.has(key)) {
        candidates.set(key, { since: time, lastReady: -Infinity, start: -Infinity, ready: false, gap: 0 });
      }
      for (const key of ranked) seen.add(key);
      if (baseline.has(`${time}:${frame.sequence}`)) { used = false; baselineFrame = frame; }
      else { used = true; recoveryAt = time; }
      publication++;
    }
    if (frames[second]) latest = frames[second];
    const ready = replayRowKeys(latest, at), eligible = keysIgnoringSkew(latest, at), shown = current.timeline[second];
    for (const [key, candidate] of candidates) {
      // Like the display, a briefly ineligible candidate keeps its place and is merely not ready.
      if (!eligible.has(key)) candidate.ready = false;
      else if (ready.has(key)) {
        if (!candidate.ready) {
          if (Number.isFinite(candidate.start)) candidate.gap = Math.max(candidate.gap, second * 1000 - candidate.start);
          candidate.start = second * 1000;
        }
        candidate.ready = true; candidate.lastReady = second * 1000;
      } else candidate.ready = false;
    }
    for (const key of waiting.keys()) if (!ready.has(key) || shown.has(key)) waiting.delete(key);
    for (const key of ready) {
      if (shown.has(key)) continue;
      if (!waiting.has(key)) waiting.set(key, second * 1000);
      assert.ok(second * 1000 - waiting.get(key) < 20_000 + timerLatenessMs,
        `${context}: ${key} continuously ready since ${waiting.get(key)}ms, still absent at ${second}s`);
    }
    const reserved = [...candidates].filter(([, candidate]) =>
      second * 1000 < candidate.lastReady + Math.max(20_000, candidate.gap) + 1000 + timerLatenessMs);
    const oldest = Math.min(...reserved.map(([, candidate]) => candidate.since));
    const oldestReady = reserved.filter(([key, candidate]) => candidate.since === oldest && ready.has(key));
    if (!oldestReady.length || used || second * 1000 < recoveryAt + 20_000) continue;
    // A sufficient, deliberately stricter external safety condition: no baseline row is lost,
    // every quote survives the whole interval, and no observation timestamp goes backwards.
    const before = new Map(baselineFrame.quotes.map(quote => [`${quote.exchange}:${quote.symbol}`, quote]));
    const safe = [...replayRowKeys(baselineFrame, at)].every(key => ready.has(key))
      && latest.exchanges.every(venue => venue.status === 'live')
      && latest.quotes.every(quote => {
        const old = before.get(`${quote.exchange}:${quote.symbol}`);
        return quote.comparable !== false && ['book', 'mark'].every(mode => quoteIsFresh(quote, mode, at, latest.staleAfterMs)
          && at - quotePriceTime(quote, mode) <= 8000 && (!old || quotePriceTime(quote, mode) >= quotePriceTime(old, mode)))
          && at - quote.fundingAt <= 270_000 && (!old || quote.fundingAt >= old.fundingAt);
      });
    if (!safe || !frames[second]) continue;
    for (const [key] of oldestReady) assert.ok(shown.has(key),
      `${context}: oldest candidate ${key} ready at free budget ${second}s; publications=${current.publishedAt}`);
  }
}

function repeatedSkewFrames(seconds, alignments = [['EARLY', 1], ['LATE', 3]]) {
  return range(0, seconds).map(second => {
    const cycle = Math.floor((second + 1) / 20) * 20;
    return pairFrame(second, alignments.map(([base, delay]) =>
      [base, cycle && second < cycle + delay ? cycle - 7 : second]));
  });
}

/**
 * Starvation across short re-skews (#187). A previously shown pair is tracked from its first absent
 * second while it stays eligible apart from leg skew and keeps realigning within `realignMs` of its
 * previous readiness (or of losing the row); `realignMs` comes from the scenario's frames, never from
 * the display's constants. assertRecoveryLiveness forgets such a pair when it skews again; this tracker
 * does not, so a pair that only misses the budget each cycle fails.
 */
function assertNoStarvation(run, context, { boundMs, realignMs, bases, feasible }) {
  const { current, frames } = run, tracked = new Map(), seen = new Set();
  const checked = key => !bases || bases.includes(JSON.parse(key.slice(key.indexOf(':') + 1))[0]);
  let latest, longest = 0;
  for (let second = 0; second < frames.length; second++) {
    const at = SOURCE + second * 1000, now = second * 1000;
    if (frames[second]) latest = frames[second];
    const shown = current.timeline[second], eligible = keysIgnoringSkew(latest, at);
    const ready = !feasible || feasible[second] ? replayRowKeys(latest, at) : new Set();
    for (const [key, pair] of tracked) {
      if (shown.has(key) || !eligible.has(key)) tracked.delete(key);
      else if (ready.has(key)) pair.lastReady = now;
      else if (now >= Math.max(pair.since, pair.lastReady) + realignMs) tracked.delete(key);
    }
    for (const key of eligible) if (checked(key) && seen.has(key) && !shown.has(key) && !tracked.has(key)) {
      tracked.set(key, { since: now, lastReady: ready.has(key) ? now : -Infinity });
    }
    for (const key of shown) seen.add(key);
    for (const [key, pair] of tracked) {
      longest = Math.max(longest, now - pair.since);
      assert.ok(now - pair.since <= boundMs,
        `${context}: ${key} keeps realigning but absent since ${pair.since}ms at ${second}s; publications=${current.publishedAt}`);
    }
  }
  return longest;
}

/**
 * Every base realigns for `width` seconds at `phase` of each `period` seconds; otherwise Bybit trails by 6s.
 * `avoidBaseline` keeps the baseline-sampled second skewed: a cohort the baseline shows would make every
 * recovery that drops it a rotation, which the display refuses by design, so the others can wait forever.
 */
function periodicAlignmentFrames(seconds, alignments, { avoidBaseline = false, bybitStatus = () => 'live' } = {}) {
  return range(0, seconds).map(second => pairFrame(second, alignments.map(([base, phase, width = 1, period = 20]) =>
    [base, second < 20 || (!(avoidBaseline && second % 20 === 19) && ((second - phase) % period + period) % period < width)
      ? second : second - 6]), bybitStatus(second)));
}

/**
 * Seconds whose frame still ranks every row the baseline (HEAD) shows at that second. Only there can a
 * recovery publish without making a baseline row newly absent, so a realignment at any other second
 * cannot be served without breaking the no-regression property (#218).
 */
function baselineKeptAt(run) {
  let latest;
  return run.frames.map((frame, second) => {
    if (frame) latest = frame;
    const rows = replayRowKeys(latest, SOURCE + second * 1000);
    return [...run.head.timeline[second]].every(key => rows.has(key));
  });
}

/**
 * Longest wait, in the frames themselves, from second 20 or one realignment start to the next; Infinity if a base never repeats.
 * A realignment needs both venues live; with `feasible` it must also fall on a second that keeps every baseline row.
 */
function realignmentGapMs(frames, bases, feasible) {
  let longest = 0;
  for (const base of bases) {
    const starts = [];
    let previous = false;
    for (let second = 20; second < frames.length; second++) {
      const [binance, bybit] = frames[second].quotes.filter(quote => quote.base === base);
      const aligned = Math.abs(quotePriceTime(binance, 'book') - quotePriceTime(bybit, 'book')) <= 5000
        && frames[second].exchanges.every(venue => venue.status === 'live') && (!feasible || feasible[second]);
      if (aligned && !previous) starts.push(second);
      previous = aligned;
    }
    if (starts.length < 2) return Infinity;
    longest = Math.max(longest, starts[0] - 20, ...starts.slice(1).map((start, index) => start - starts[index]));
  }
  return longest * 1000;
}

/**
 * Oldest first serves one waiting cohort per turn. A pair waits out the interval that dropped it, then
 * each cohort ahead of it and finally its own turn take at most one realignment gap plus one 20s budget
 * interval each.
 */
const starvationWindow = (frames, bases, cohorts = bases.length, feasible) => {
  const gapMs = realignmentGapMs(frames, bases, feasible);
  return { realignMs: gapMs + 1000, boundMs: (cohorts + 1) * (gapMs + 20_000) };
};
// Bybit trails by 6s except while `alignedAt(base, second)` holds or during the aligned prelude.
const scriptedAlignmentFrames = (seconds, bases, alignedAt) => range(0, seconds).map(second =>
  pairFrame(second, bases.map(base => [base, second < 20 || alignedAt(base, second) ? second : second - 6])));
const bookKey = base => `0:${JSON.stringify([base, `binance:${base}USDT`, `bybit:${base}USDT`])}`;

test('a pair aligned one second after a competing pair is not starved by the recovery budget (#187)', () => {
  const run = differentialReplay(periodicAlignmentFrames(3600, [['EARLY', 1], ['THIRD', 1], ['LATE', 2]]));
  assertNoRegression(run, 'adjacent periodic phases');
  assertRecoveryLiveness(run, 'adjacent periodic phases');
  assertNoStarvation(run, 'adjacent periodic phases', { ...starvationWindow(run.frames, ['EARLY', 'THIRD', 'LATE']), boundMs: 60_000 });
  const absent = base => run.current.absent.get(bookKey(base));
  for (const base of ['EARLY', 'THIRD', 'LATE']) {
    // HEAD shows the aligned prelude through the +20s publication of frame 19, then never again.
    assert.equal(run.head.absent.get(bookKey(base)), 3561);
    // One recovery per interval now alternates the two cohorts instead of always serving EARLY/THIRD.
    assert.ok(absent(base) < 2000, `${base} absent ${absent(base)}s`);
  }
});

for (const period of [21, 22, 41]) {
  test(`pairs realigning every ${period}s one second apart all keep recovering (#187)`, () => {
    const alignments = [['EARLY', 1, 1, period], ['THIRD', 1, 1, period], ['LATE', 2, 1, period]];
    const run = differentialReplay(periodicAlignmentFrames(3600, alignments));
    assertNoRegression(run, `period ${period}`);
    assertRecoveryLiveness(run, `period ${period}`);
    assertNoStarvation(run, `period ${period}`, starvationWindow(run.frames, alignments.map(([base]) => base)));
  });
}

test('a realignment interrupted by one skewed frame does not shorten the known gap', () => {
  // SPLIT realigns at +18s and +20s of every 40s; the baseline-sampled +19s frame in between is skewed.
  const alignments = [['SPLIT', 18, 3, 40], ['EARLY', 3, 3, 40]];
  const run = differentialReplay(periodicAlignmentFrames(1200, alignments, { avoidBaseline: true }));
  assertNoRegression(run, 'split realignment');
  assertRecoveryLiveness(run, 'split realignment');
  assertNoStarvation(run, 'split realignment', starvationWindow(run.frames, alignments.map(([base]) => base)));
});

/**
 * C is aligned through every baseline-sampled second, so the baseline shows it and a recovery frame
 * in which C is skewed would rotate it out. A realigns only while C is skewed, so the display refuses
 * every A frame; A must not reserve the budget ahead of B, whose realignments are safe.
 */
const refusedCandidate = {
  'C aligned at 15-19s, A every 40s at 10s': (base, second) => base === 'C' ? second % 20 >= 15 : base === 'A' ? second % 40 === 10 : undefined,
  'C skewed only at 10s, A every 40s at 10s': (base, second) => base === 'C' ? second % 20 !== 10 : base === 'A' ? second % 40 === 10 : undefined,
  'C aligned at 15-19s, A every 41s': (base, second) => base === 'C' ? second % 20 >= 15 : base === 'A' ? second % 41 === 10 : undefined,
  'C aligned at 15-19s, A only at 45s and 400s': (base, second) => base === 'C' ? second % 20 >= 15 : base === 'A' ? second === 45 || second === 400 : undefined,
};
for (const [name, alignedAt] of Object.entries(refusedCandidate)) {
  test(`a candidate refused as unsafe does not reserve the budget ahead of a safe pair: ${name}`, () => {
    // B realigns once at +39s, then at +16s of every 20s from +60s, while C is aligned.
    const frames = scriptedAlignmentFrames(1200, ['C', 'A', 'B'], (base, second) =>
      alignedAt(base, second) ?? (second === 39 || (second >= 60 && second % 20 === 16)));
    const run = differentialReplay(frames);
    assertNoRegression(run, name);
    assertRecoveryLiveness(run, name);
    assertNoStarvation(run, name, { ...starvationWindow(frames, ['B'], 3), bases: ['B'] });
  });
}

test('safety refusals: 64 seeded replays never let a refused candidate starve a safe pair', () => {
  for (let seed = 1; seed <= 64; seed++) {
    const random = randomSource(seed);
    const from = 12 + Math.floor(random() * 6), period = 20 + Math.floor(random() * 41), phase = Math.floor(random() * period);
    const width = 1 + Math.floor(random() * 2), safe = from + Math.floor(random() * (19 - from));
    const scenario = JSON.stringify({ from, period, phase, width, safe });
    // C spans the baseline-sampled second; A has any rhythm, so some of its frames are safe and others refused.
    const frames = scriptedAlignmentFrames(1200, ['C', 'A', 'B'], (base, second) => base === 'C' ? second % 20 >= from
      : base === 'A' ? ((second - phase) % period + period) % period < width : second === 39 || (second >= 60 && second % 20 === safe));
    const run = differentialReplay(frames);
    assertNoRegression(run, `refusal seed=${seed} ${scenario}`);
    assertRecoveryLiveness(run, `refusal seed=${seed} ${scenario}`);
    assertNoStarvation(run, `refusal seed=${seed} ${scenario}`, { ...starvationWindow(frames, ['B'], 3), bases: ['B'] });
  }
});

/** OLD misses safe realignments at +45s and `second` while FIRST holds the budget, then stays skewed. */
const stoppedCandidate = second => differentialReplay(scriptedAlignmentFrames(500, ['OLD', 'FIRST'], (base, at) =>
  base === 'OLD' ? at === 45 || at === second : at % 20 !== 19));
const recoveriesAfter = (run, second) => run.current.publishedAt.filter(at => at > second * 1000 && at % 20_000 !== 0);

test('a candidate that learned a gap and stopped realigning releases its reservation one gap and a display tick later', () => {
  const run = stoppedCandidate(83);
  assertNoRegression(run, 'stopped candidate');
  assertRecoveryLiveness(run, 'stopped candidate');
  // Learned gap 83 - 45 = 38s: FIRST, dropped again at +100s, waits until 83 + 38 + 1.
  assert.equal(recoveriesAfter(run, 83)[0], 122_000);
  assert.ok(range(100, 121).every(second => !run.current.timeline[second].has(bookKey('FIRST'))));
  assert.ok(run.current.timeline[122].has(bookKey('FIRST')));
});

test('a learned gap holds the budget for at most two minutes', () => {
  const run = stoppedCandidate(243);
  assertNoRegression(run, 'long learned gap');
  assertRecoveryLiveness(run, 'long learned gap');
  // A 198s gap is limited to 120s: FIRST returns at 243 + 120 + 1 instead of 243 + 198 + 1.
  assert.equal(recoveriesAfter(run, 243)[0], 364_000);
  assert.ok(run.current.timeline[364].has(bookKey('FIRST')));
});

const longestAbsence = (run, base) => {
  let longest = 0, current = 0;
  for (const rows of run.current.timeline) { current = rows.has(bookKey(base)) ? 0 : current + 1; longest = Math.max(longest, current); }
  return longest;
};

// Reservations of pairs whose realignment gaps exceed the 120s cap lapse before they realign, yet releasing them
// earlier, or whenever the pair's observed rhythm says it cannot use the slot yet, let the short pair take every
// budget: one long pair below was never shown again and another waited 2370s (#222).
for (const [name, alignments, longGap] of [
  ['three long pairs', [['L0', 90, 3, 130], ['L1', 88, 1, 139], ['L2', 102, 2, 131], ['S', 0, 3, 26]], ['L0', 'L1', 'L2']],
  ['two long pairs', [['L0', 48, 2, 123], ['L1', 64, 2, 138], ['S', 17, 3, 20]], ['L0', 'L1']],
]) {
  test(`pairs realigning beyond the reservation cap keep their reservation against a short pair: ${name} (#222)`, () => {
    const run = differentialReplay(periodicAlignmentFrames(3600, alignments, { avoidBaseline: true }));
    assertNoRegression(run, name);
    assertRecoveryLiveness(run, name);
    for (const base of longGap) assert.ok(longestAbsence(run, base) <= 900, `${name}: ${base} absent for ${longestAbsence(run, base)}s`);
  });
}

test('starvation: 128 randomized periodic replays with random periods and phases recover every cohort within a bounded wait', context => {
  let longest = 0, worst = 0;
  for (let seed = 1; seed <= 128; seed++) {
    const random = randomSource(seed), count = 2 + Math.floor(random() * 3);
    let alignments, frames, window;
    do {
      alignments = Array.from({ length: count }, (_, index) => {
        const period = 20 + Math.floor(random() * 61), width = 1 + Math.floor(random() * 3);
        return [`P${index}`, Math.floor(random() * period), width, period];
      });
      const maxPeriod = Math.max(...alignments.map(([, , , period]) => period));
      // Long enough for several bounded waits of the slowest cohort to elapse.
      frames = periodicAlignmentFrames(2 * (count + 1) * (maxPeriod + 20) + 20, alignments, { avoidBaseline: true });
      window = starvationWindow(frames, alignments.map(([base]) => base));
    } while (!Number.isFinite(window.boundMs));
    const run = differentialReplay(frames);
    assertNoRegression(run, `periodic seed=${seed}`);
    assertRecoveryLiveness(run, `periodic seed=${seed}`);
    const tracked = assertNoStarvation(run, `periodic seed=${seed} ${JSON.stringify(alignments)}`, window);
    longest = Math.max(longest, tracked); worst = Math.max(worst, tracked / window.boundMs);
  }
  context.diagnostic(`longest tracked absence ${longest / 1000}s; worst ${Math.round(worst * 100)}% of the bound`);
});

test('a pair aligned on the baseline-sampled second blocks only pairs it never aligns with (#218)', () => {
  // SAMPLED is aligned exactly when every baseline publication samples (+19s of each 20s), OTHER only at +5s.
  const run = differentialReplay(periodicAlignmentFrames(1200, [['SAMPLED', 19, 1, 20], ['OTHER', 5, 1, 20]]));
  assertNoRegression(run, 'baseline-sampled pair');
  assertRecoveryLiveness(run, 'baseline-sampled pair');
  const feasible = baselineKeptAt(run);
  // Every OTHER realignment frame skews SAMPLED, which the baseline shows the whole time; showing OTHER
  // would make SAMPLED newly absent, so OTHER stays absent in HEAD and current alike.
  assert.equal(run.head.absent.get(bookKey('SAMPLED')), 0);
  assert.equal(run.current.absent.get(bookKey('OTHER')), run.head.absent.get(bookKey('OTHER')));
  assert.ok(range(40, 1200).every(second => second % 20 !== 5 || !feasible[second]));
  assert.equal(realignmentGapMs(run.frames, ['OTHER'], feasible), Infinity);
  assert.throws(() => assertNoStarvation(run, 'baseline-sampled pair', starvationWindow(run.frames, ['SAMPLED', 'OTHER'])), /OTHER/);
});

test('a refused pair does not hold the budget against a pair whose realignments keep every baseline row (#218)', () => {
  // P1 (7-9s of every 30s) is aligned on the sampled +39s of every 60s, so P0 (48-49s of every 60s) is always refused.
  const alignments = [['P0', 48, 2, 60], ['P1', 7, 3, 30]];
  const run = differentialReplay(periodicAlignmentFrames(1200, alignments));
  assertNoRegression(run, 'refused P0');
  assertRecoveryLiveness(run, 'refused P0');
  const feasible = baselineKeptAt(run);
  assert.equal(realignmentGapMs(run.frames, ['P0'], feasible), Infinity);
  assertNoStarvation(run, 'refused P0', { ...starvationWindow(run.frames, ['P1'], 2, feasible), feasible });
  assert.ok(run.current.absent.get(bookKey('P1')) <= 457, `P1 absent ${run.current.absent.get(bookKey('P1'))}s`);
});

test('starvation: 128 randomized periodic replays without forced baseline misalignment serve every pair the baseline allows (#218)', context => {
  let longest = 0, blocked = 0, checked = 0;
  for (let seed = 1; seed <= 128; seed++) {
    const random = randomSource(seed), count = 2 + Math.floor(random() * 3);
    let alignments, frames;
    do {
      alignments = Array.from({ length: count }, (_, index) => {
        const period = 20 + Math.floor(random() * 61), width = 1 + Math.floor(random() * 3);
        return [`P${index}`, Math.floor(random() * period), width, period];
      });
      const maxPeriod = Math.max(...alignments.map(([, , , period]) => period));
      frames = periodicAlignmentFrames(2 * (count + 1) * (maxPeriod + 20) + 20, alignments);
    } while (!Number.isFinite(realignmentGapMs(frames, alignments.map(([base]) => base))));
    const run = differentialReplay(frames), bases = alignments.map(([base]) => base), feasible = baselineKeptAt(run);
    assertNoRegression(run, `unforced seed=${seed}`);
    assertRecoveryLiveness(run, `unforced seed=${seed}`);
    // Bases the baseline never lets realign twice cannot be served without a regression; every base is still tracked.
    const reachable = bases.filter(base => Number.isFinite(realignmentGapMs(frames, [base], feasible)));
    blocked += bases.length - reachable.length; checked += bases.length;
    if (!reachable.length) continue;
    longest = Math.max(longest, assertNoStarvation(run, `unforced seed=${seed} ${JSON.stringify(alignments)}`,
      { ...starvationWindow(frames, reachable, bases.length, feasible), feasible }));
  }
  context.diagnostic(`longest tracked absence ${longest / 1000}s; ${blocked} of ${checked} bases never realign twice on a baseline-compatible second`);
});

test('a waiting pair keeps recovering after a venue is offline for two seconds (#220)', () => {
  const alignments = [['EARLY', 1], ['THIRD', 1], ['LATE', 2]];
  const run = differentialReplay(periodicAlignmentFrames(1200, alignments, { bybitStatus: second => second >= 105 && second <= 106 ? 'stale' : 'live' }));
  assertNoRegression(run, 'brief offline');
  assertRecoveryLiveness(run, 'brief offline');
  assertNoStarvation(run, 'brief offline', { ...starvationWindow(run.frames, alignments.map(([base]) => base)), boundMs: 60_000 });
  for (const base of ['EARLY', 'THIRD', 'LATE']) assert.ok(run.current.timeline.slice(1100).some(rows => rows.has(bookKey(base))), `${base} recovered after the outage`);
});

test('a shown pair dropped while its venue is offline during a publication returns to the recovery queue (#220)', () => {
  // ONLY realigns at +1s of every 20s. The +41s recovery shows it; Bybit is offline across the +60s publication.
  const run = differentialReplay(periodicAlignmentFrames(400, [['ONLY', 1]], { bybitStatus: second => second >= 59 && second <= 60 ? 'stale' : 'live' }));
  assertNoRegression(run, 'offline publication');
  assertRecoveryLiveness(run, 'offline publication');
  assertNoStarvation(run, 'offline publication', starvationWindow(run.frames, ['ONLY']));
  assert.ok(run.current.timeline[41].has(bookKey('ONLY')));
  assert.ok(run.current.timeline[81].has(bookKey('ONLY')));
});

test('starvation: 128 randomized periodic replays with brief venue outages keep every waiting pair (#220)', context => {
  let longest = 0, outages = 0;
  for (let seed = 1; seed <= 128; seed++) {
    const random = randomSource(seed), count = 2 + Math.floor(random() * 3);
    let alignments, frames, window, offline;
    do {
      alignments = Array.from({ length: count }, (_, index) => {
        const period = 20 + Math.floor(random() * 61), width = 1 + Math.floor(random() * 3);
        return [`P${index}`, Math.floor(random() * period), width, period];
      });
      const maxPeriod = Math.max(...alignments.map(([, , , period]) => period)), seconds = 2 * (count + 1) * (maxPeriod + 20) + 20;
      // One to three outages of one or two seconds anywhere after the aligned prelude.
      offline = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const from = 20 + Math.floor(random() * (seconds - 20));
        return [from, from + Math.floor(random() * 2)];
      });
      frames = periodicAlignmentFrames(seconds, alignments, { avoidBaseline: true,
        bybitStatus: second => offline.some(([from, to]) => second >= from && second <= to) ? 'stale' : 'live' });
      window = starvationWindow(frames, alignments.map(([base]) => base));
    } while (!Number.isFinite(window.boundMs));
    outages += offline.length;
    const run = differentialReplay(frames), scenario = JSON.stringify({ alignments, offline });
    assertNoRegression(run, `outage seed=${seed} ${scenario}`);
    assertRecoveryLiveness(run, `outage seed=${seed} ${scenario}`);
    longest = Math.max(longest, assertNoStarvation(run, `outage seed=${seed} ${scenario}`, window));
  }
  context.diagnostic(`${outages} outages; longest tracked absence ${longest / 1000}s`);
});

test('repeated single-pair skew recovers at every available budget instead of losing the candidate', () => {
  const run = differentialReplay(repeatedSkewFrames(121, [['EARLY', 1]]));
  assertNoRegression(run, 'repeated single skew');
  assertRecoveryLiveness(run, 'repeated single skew');
  assert.deepEqual(run.current.publishedAt.filter(at => at % 20_000 !== 0), [21, 41, 61, 81, 101, 121].map(second => second * 1000));
});

test('repeated two-pair skew retains the waiting pair and recovers all ready pairs in one frame', () => {
  const run = differentialReplay(repeatedSkewFrames(123));
  assertNoRegression(run, 'repeated two-pair skew');
  assertRecoveryLiveness(run, 'repeated two-pair skew');
  assert.deepEqual(run.current.publishedAt.filter(at => at % 20_000 !== 0), [21, 43, 63, 83, 103, 123].map(second => second * 1000));
  for (const second of [43, 83, 123]) assert.equal(run.current.timeline[second].size, 4, `both pairs in book and mark at ${second}s`);
  // At +63s/+103s the budget callback precedes that second's incoming frame. It must publish
  // the received +62s/+102s frame honestly, then retain LATE for the following recovery slot.
  for (const second of [63, 103]) {
    const index = run.current.publishedAt.indexOf(second * 1000);
    assert.equal(run.current.data[index].sequence, second - 1);
    assert.equal(run.current.timeline[second].size, 2);
  }
});

test('pairs excluded by one publication share priority even when the monotonic clock advances inside the loop', () => {
  let time = 0, reads = 0;
  const data = [];
  const display = createPerpetualDisplay({
    onData: frame => data.push(frame), now: () => time + ++reads / 1000, sourceNow: () => SOURCE + time,
    schedule: () => 1, cancel: () => {},
  });
  display.accept(pairFrame(0, [['FIRST', 0], ['SECOND', 0]]));
  time = 20_000; display.accept(pairFrame(20, [['FIRST', 14], ['SECOND', 14]]));
  time = 21_000; display.accept(pairFrame(21, [['FIRST', 14], ['SECOND', 21]]));
  assert.deepEqual(data.map(frame => frame.sequence), [0, 20, 21]);
  assert.deepEqual(rankPerpetualSpreads(data.at(-1), defaultPerpetualFilters, SOURCE + time).map(row => row.base), ['SECOND']);
  display.stop();
});

test('a permanently skewed candidate cannot reserve the budget ahead of a newer ready pair', () => {
  const frames = range(0, 61).map(second => pairFrame(second, [
    ['STUCK', second < 19 ? second : second - 6],
    ['READY', second >= 39 && second <= 40 ? 33 : second],
  ]));
  const run = differentialReplay(frames);
  assertNoRegression(run, 'permanently skewed candidate');
  assertRecoveryLiveness(run, 'permanently skewed candidate');
  assert.ok(run.current.publishedAt.includes(41_000));
  assert.equal(run.current.timeline[41].size, 2);
});

test('a previously ready candidate releases its reservation after one interval and a display tick, including without new frames', () => {
  const frames = range(0, 60).map(second => {
    if (second > 41) return null;
    const ready = second >= 19 && second <= 20 ? 13 : second >= 39 && second <= 40 ? 33 : second;
    const stuck = second < 19 || (second >= 23 && second <= 30) ? second : second < 23 ? 13 : second - 6;
    return pairFrame(second, [['READY', ready], ['STUCK', stuck]]);
  });
  const run = differentialReplay(frames);
  assertNoRegression(run, 'expired candidate reservation');
  assertRecoveryLiveness(run, 'expired candidate reservation');
  assert.deepEqual(run.current.publishedAt, [0, 20_000, 21_000, 40_000, 51_000, 60_000]);
  assert.equal(run.current.data[4].sequence, 41);
});

const lateConfirmationFrames = (mode = 'book') => range(0, 45).map(second => {
  const frame = pairFrame(second, [['ORDER', skewThenRealign(second)], ['AGING', second]]);
  frame.quotes = frame.quotes.map(quote => {
    if (quote.base !== 'AGING') return quote;
    const old = second < 25 ? SOURCE - (mode === 'funding' ? 277_000 : 7000) : SOURCE + second * 1000;
    return { ...quote, [mode === 'book' ? 'bidAskAt' : mode === 'mark' ? 'markAt' : 'fundingAt']: old,
      fundingRate: quote.exchange === 'binance' ? 0.0001 : 0.0002 };
  });
  return frame;
});

test('HEAD differential: recovery preserves a late expiry rescue after the displayed quote expires (P1)', () => {
  for (const [index, mode] of ['book', 'mark', 'funding'].entries()) {
    const run = differentialReplay(lateConfirmationFrames(mode));
    const aging = `${index}:${JSON.stringify(['AGING', 'binance:AGINGUSDT', 'bybit:AGINGUSDT'])}`;
    assert.equal(run.head.absent.get(aging), 1);
    assert.ok(run.head.publishedAt.includes(25_000));
    assertNoRegression(run, `late-confirmation P1 ${mode}`);
    assert.deepEqual(run.current.publishedAt, [0, 20_000, 24_000, 25_000, 45_000]);
  }
});

test('expiry rescues do not replenish the rolling recovery budget', () => {
  const frames = lateConfirmationFrames().map((frame, second) => {
    const late = pairFrame(second, [['LATE', second === 25 ? 19 : second]]);
    return { ...frame, quotes: [...frame.quotes, ...late.quotes] };
  });
  const run = differentialReplay(frames);
  assertNoRegression(run, 'rolling recovery budget');
  assert.deepEqual(run.current.publishedAt, [0, 20_000, 24_000, 25_000, 44_000, 45_000]);
});

function pendingBudgetFixture() {
  const f = fixture({ source: true }), frames = lateConfirmationFrames();
  for (let second = 0; second <= 26; second++) {
    if (second) f.advance(1000);
    const late = pairFrame(second, [['LATE', second === 25 ? 19 : second]]);
    f.display.accept({ ...frames[second], quotes: [...frames[second].quotes, ...late.quotes] });
  }
  assert.deepEqual([...f.timers.values()].map(timer => timer.at).sort(), [44_000, 45_000]);
  return f;
}

test('a held realignment wakes exactly when the budget becomes available without another input frame', () => {
  const f = pendingBudgetFixture();
  f.advance(17_999);
  assert.deepEqual(f.publishedAt, [0, 20_000, 24_000, 25_000]);
  f.advance(1);
  assert.equal(f.publishedAt.at(-1), 44_000);
  assert.equal(f.data.at(-1).sequence, 26);
  assert.equal(rankPerpetualSpreads(f.data.at(-1), defaultPerpetualFilters, SOURCE + 44_000).length, 3);
  f.advance(1000);
  assert.deepEqual(f.publishedAt, [0, 20_000, 24_000, 25_000, 44_000, 45_000]);
});

test('a delayed recovery callback leaves an overdue baseline publication to its original timer', () => {
  const f = pendingBudgetFixture();
  f.jump(20_000); f.advance(0);
  assert.deepEqual(f.publishedAt, [0, 20_000, 24_000, 25_000, 46_000]);
  assert.equal(f.timers.size, 0);
});

test('invalidating a pending pair clears its budget wakeup but preserves the baseline timer', () => {
  const f = pendingBudgetFixture();
  f.advance(1000);
  const frame = pairFrame(27, [['ORDER', 27], ['AGING', 27], ['LATE', 27]]);
  frame.quotes = frame.quotes.map(quote => quote.base === 'LATE' ? { ...quote, comparable: false } : quote);
  f.display.accept(frame);
  assert.deepEqual([...f.timers.values()].map(timer => timer.at), [45_000]);
  f.advance(18_000);
  assert.deepEqual(f.publishedAt, [0, 20_000, 24_000, 25_000, 45_000]);
});

test('reset and stop clear both timers and the recovery candidate queue', () => {
  for (const action of ['reset', 'stop']) {
    const f = pendingBudgetFixture(), count = f.data.length;
    f.display[action](); f.advance(60_000);
    assert.equal(f.timers.size, 0);
    assert.equal(f.data.length, count);
    f.display.accept(pairFrame(86, [['NEW', 86]]));
    assert.equal(f.data.length, count + (action === 'reset' ? 1 : 0));
  }
});

test('a recovery retains the pending baseline frame and old observations expire if reception stops', () => {
  const frames = range(0, 60).map(second => second <= 21 ? pairFrame(second, [['ORDER', skewThenRealign(second)]]) : null);
  const run = differentialReplay(frames);
  assertNoRegression(run, 'reception stops after recovery');
  assert.deepEqual(run.current.publishedAt, [0, 20_000, 21_000, 40_000]);
  assert.equal(run.current.timeline[51].size, 2);
  assert.equal(run.current.timeline[52].size, 0);
});

test('a currently incomparable aging quote cannot hide a pending expiry rescue (P2)', () => {
  const frames = range(0, 42).map(second => {
    const frame = pairFrame(second, [['ORDER', skewThenRealign(second)], ['AGING', second < 22 ? -7 : second]]);
    frame.quotes = frame.quotes.map(quote => quote.base === 'AGING'
      ? { ...quote, comparable: second !== 21, ...(second < 22 ? { bidAskAt: SOURCE - 7000, markAt: SOURCE - 7000 } : {}) } : quote);
    return frame;
  });
  const run = differentialReplay(frames);
  assertNoRegression(run, 'incomparable P2');
  assert.deepEqual(run.current.publishedAt, [0, 20_000, 22_000, 42_000]);
});

test('an expiry timer delayed past the regular deadline still arms skew recovery (P2)', () => {
  const f = fixture({ source: true });
  const frame = (second, bybit, book) => {
    const value = pairFrame(second, [['ORDER', bybit], ['AGING', book]]);
    value.quotes = value.quotes.map(quote => quote.base === 'AGING'
      ? { ...quote, bidAskAt: SOURCE + book * 1000, markAt: SOURCE + book * 1000 } : quote);
    return value;
  };
  f.display.accept(frame(0, -1, -12));
  f.advance(3000); f.display.accept(frame(3, 2, 3));
  assert.equal([...f.timers.values()][0].at, 17_000);
  f.advance(13_000); f.display.accept(frame(16, 10, 16));
  // The browser event loop is suspended across both the expiry and regular deadlines.
  f.jump(4000); f.advance(0);
  assert.deepEqual(f.publishedAt, [0, 20_000]);
  f.advance(1000); f.display.accept(frame(21, 21, 21));
  assert.deepEqual(f.publishedAt, [0, 20_000, 21_000]);
});

// Mulberry32: deterministic across platforms; failures include the seed for exact reproduction.
function randomSource(seed) {
  let state = seed;
  return () => {
    let value = state += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function randomReplay(seed) {
  const random = randomSource(seed), exchanges = ['binance', 'bybit', 'gate'];
  const bases = ['ORDER', 'SECOND', 'THIRD', 'FOURTH'];
  const states = bases.flatMap(base => exchanges.map((exchange, venue) => ({
    base, exchange, bid: 0.1 + venue * 0.002, book: -Math.floor(random() * 13), mark: -Math.floor(random() * 13),
    funding: -Math.floor(random() * 305), pausedUntil: 0, comparable: true,
  })));
  const venues = exchanges.map(id => ({ id, offlineUntil: 0 }));
  const frames = [];
  const expirySecond = 22 + Math.floor(random() * 6), confirmationSecond = expirySecond + 2 + Math.floor(random() * 5);
  for (let second = 0; second <= 240; second++) {
    const at = SOURCE + second * 1000;
    for (const venue of venues) if (random() < 0.012) venue.offlineUntil = second + 2 + Math.floor(random() * 22);
    for (const state of states) {
      if (random() < 0.015) state.pausedUntil = second + 5 + Math.floor(random() * 38);
      if (random() < 0.03) state.comparable = !state.comparable;
      if (second >= state.pausedUntil) {
        if (random() < 0.45) state.book = Math.max(state.book, second - Math.floor(random() * 15));
        if (random() < 0.3) state.mark = Math.max(state.mark, second - Math.floor(random() * 15));
        if (random() < 0.035) state.funding = second - Math.floor(random() * 10);
      }
    }
    // Feed gaps and delayed callbacks are independent; queued data may publish while reception is quiet.
    if (second && random() < 0.1) { frames.push(null); continue; }
    frames.push({ ...snapshot(second), generatedAt: at, exchanges: venues.map(venue => pairVenue(venue.id, second < venue.offlineUntil ? 'stale' : 'live')),
      quotes: states.map(state => ({
        ...pairLeg(state.exchange, state.base, state.bid, SOURCE + state.book * 1000, at),
        markAt: SOURCE + state.mark * 1000, fundingAt: SOURCE + state.funding * 1000,
        fundingRate: 0.0001 + exchanges.indexOf(state.exchange) * 0.0001, comparable: state.comparable,
      })) });
  }
  // Randomized adversarial prelude exercises recoveries rather than letting unrelated old quotes
  // veto every one. The remaining three minutes mix multiple venues, gaps and eligibility changes.
  if (seed % 4 !== 0) for (let second = 0; second <= 60; second++) {
    const aging = seed % 4 === 3 || second >= confirmationSecond ? second : expirySecond - 30;
    const frame = pairFrame(second, [['ORDER', skewThenRealign(second)], ['AGING', aging], ['STABLE', second]]);
    frame.quotes = frame.quotes.map(quote => quote.base === 'AGING'
      ? { ...quote, bidAskAt: SOURCE + aging * 1000, markAt: SOURCE + aging * 1000,
        comparable: seed % 4 !== 2 || second !== 21 } : quote);
    frames[second] = frame;
  }
  // A pure function of the deadline gives both implementations identical event-loop stalls.
  const timerLag = due => {
    if (due <= 60_000 && seed % 4 !== 0) return 0;
    const value = Math.imul((due | 0) ^ seed, 0x45d9f3b) >>> 0;
    return value % 5 === 0 ? value % 4001 : 0;
  };
  return differentialReplay(frames, timerLag);
}

test('HEAD differential: 384 seeded multi-pair replays never add absence, delay protection, or exceed the recovery budget', context => {
  let recoveries = 0, improved = 0;
  for (let seed = 1; seed <= 384; seed++) {
    const run = randomReplay(seed);
    recoveries += assertNoRegression(run, `seed=${seed}`);
    assertRecoveryLiveness(run, `seed=${seed}`, 4000);
    for (const [key, seconds] of run.head.absent) if (run.current.absent.get(key) < seconds) improved++;
  }
  assert.ok(recoveries >= 96 && improved >= 192, 'replay must exercise successful recovery, not only vetoes');
  context.diagnostic(`384 seeds × 241 seconds; ${recoveries} extra recoveries; ${improved} directed pair/mode totals improved`);
});

test('recovery liveness: 384 randomized repeated-skew replays cannot starve a pending pair', () => {
  for (let seed = 1; seed <= 384; seed++) {
    const random = randomSource(seed), alignments = [['EARLY', 1 + Math.floor(random() * 2)], ['LATE', 3 + Math.floor(random() * 3)]];
    const run = differentialReplay(repeatedSkewFrames(180, alignments));
    assertNoRegression(run, `repeated seed=${seed}`);
    assertRecoveryLiveness(run, `repeated seed=${seed}`);
    assertNoStarvation(run, `repeated seed=${seed}`, { ...starvationWindow(run.frames, alignments.map(([base]) => base)), boundMs: 60_000 });
    for (const [base] of alignments) {
      const key = `0:${JSON.stringify([base, `binance:${base}USDT`, `bybit:${base}USDT`])}`;
      assert.ok(run.current.timeline.slice(40).some(rows => rows.has(key)), `repeated seed=${seed}: ${base} never recovered`);
    }
  }
});

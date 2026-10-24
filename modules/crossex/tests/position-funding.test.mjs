import test from 'node:test';
import assert from 'node:assert/strict';
import { createPositionFunding } from '../server/position-funding.mjs';
import { createMarket } from '../server/market.mjs';
import { epoch, feed, catalog } from './fixtures.mjs';
import { memoryMarketStore } from './live-market-performance-fixture.mjs';

const HOUR = 3_600_000, SYMBOL = 'BYBIT_FUTURE_AXIS_USDT';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ current, identity } = {}) {
  let now = epoch;
  const calls = { identity: 0, current: 0 }, gates = [];
  const funding = createPositionFunding({ clock: () => now,
    identityReader: async symbol => { calls.identity++; return identity ? identity(symbol) : { exchange: symbol.split('_')[0].toLowerCase(), symbol }; },
    currentReader: async quote => { calls.current++; return current ? current(quote, now, gates) : { rate: '-0.00911135', intervalHours: 4, nextFundingAt: now + HOUR, sourceAt: now }; } });
  return { funding, calls, gates, advance(ms) { now += ms; }, get now() { return now; } };
}

test('held contract rates come from the venue reader and are normalized per settlement interval', async () => {
  const f = fixture();
  assert.deepEqual(f.funding.rates([SYMBOL]), [], 'the first view must not wait on public IO');
  await flush();
  const [row] = f.funding.rates([SYMBOL]);
  assert.deepEqual(row, { exchange: 'bybit', symbol: SYMBOL, quoteCurrency: 'USDT', rate: -0.00911135, intervalHours: 4,
    normalized8hBps: -182.227, nextFundingAt: epoch + HOUR, fundingAt: epoch, expiresAt: epoch + 300_000 });
  assert.deepEqual(f.calls, { identity: 1, current: 1 });
});

test('refresh is bounded to 30 seconds and native identity is reused for 15 minutes', async () => {
  const f = fixture();
  f.funding.rates([SYMBOL]); await flush();
  f.advance(29_999); f.funding.rates([SYMBOL]); await flush();
  assert.deepEqual(f.calls, { identity: 1, current: 1 });
  f.advance(1); f.funding.rates([SYMBOL]); await flush();
  assert.deepEqual(f.calls, { identity: 1, current: 2 });
  assert.equal(f.funding.rates([SYMBOL])[0].fundingAt, epoch + 30_000);
  f.advance(900_000); f.funding.rates([SYMBOL]); await flush();
  assert.deepEqual(f.calls, { identity: 2, current: 3 });
});

test('a failed read keeps the last rate only until its source deadline and re-resolves identity', async () => {
  let failing = false;
  const f = fixture({ current: (quote, now) => { if (failing) throw new Error('503'); return { rate: '0.0001', intervalHours: 8, nextFundingAt: now + HOUR, sourceAt: now }; } });
  f.funding.rates([SYMBOL]); await flush();
  failing = true; f.advance(30_000); f.funding.rates([SYMBOL]); await flush();
  assert.equal(f.funding.rates([SYMBOL]).length, 1);
  f.advance(30_000); f.funding.rates([SYMBOL]); await flush();
  assert.equal(f.calls.identity, 2, 'a failed attempt discards the cached native identity');
  f.advance(239_999); assert.equal(f.funding.rates([SYMBOL]).length, 1);
  f.advance(1); assert.deepEqual(f.funding.rates([SYMBOL]), []);
});

test('missing, unbounded or mismatched rate data never becomes a displayed rate', async () => {
  for (const value of [null, { rate: '0.0001', intervalHours: null, sourceAt: epoch }, { rate: '0.0001', intervalHours: 0, sourceAt: epoch },
    { rate: '0.0001', intervalHours: 169, sourceAt: epoch }, { rate: '0.0001', intervalHours: 8, sourceAt: epoch + 1001 },
    { rate: '0.0001', intervalHours: 8, sourceAt: null }, { rate: 'NaN', intervalHours: 8, sourceAt: epoch }]) {
    const f = fixture({ current: () => value });
    f.funding.rates([SYMBOL]); await flush();
    assert.deepEqual(f.funding.rates([SYMBOL]), [], JSON.stringify(value));
  }
  const wrongVenue = fixture({ identity: () => ({ exchange: 'okx' }) });
  wrongVenue.funding.rates([SYMBOL]); await flush();
  assert.deepEqual(wrongVenue.funding.rates([SYMBOL]), []);
  const invalid = fixture();
  assert.deepEqual(invalid.funding.rates(['AXISUSDT', 'BYBIT_SPOT_AXIS_USDT', 'BYBIT_FUTURE_AXIS_EUR', 42, null]), []);
  assert.deepEqual(invalid.calls, { identity: 0, current: 0 });
});

test('concurrent public reads are capped and stop waits for in-flight reads', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ current: async (quote, now) => { await blocked; return { rate: '0', intervalHours: 1, nextFundingAt: now + HOUR, sourceAt: now }; } });
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F'].map(base => `OKX_FUTURE_${base}_USDT`);
  f.funding.rates(symbols); await flush();
  assert.equal(f.calls.current, 4);
  let stopped = false; const stopping = f.funding.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  release(); await stopping;
  f.advance(60_000); f.funding.rates(symbols); await flush();
  assert.equal(f.calls.current, 4, 'no read starts after stop');
});

test('reads rotate oldest attempt first so every held symbol is covered, with no cap on the list', async () => {
  const pending = [], read = new Set();
  const f = fixture({ current: (quote, now) => new Promise(resolve => pending.push(() => { read.add(quote.symbol); resolve({ rate: '0', intervalHours: 1, nextFundingAt: now + HOUR, sourceAt: now }); })) });
  const symbols = Array.from({ length: 70 }, (_, i) => `OKX_FUTURE_T${i}_USDT`);
  for (let round = 0; round < 18; round++) {
    f.funding.rates(symbols); await flush();
    assert.ok(pending.length <= 4, `round ${round} started ${pending.length} reads`);
    pending.splice(0).forEach(finish => finish()); await flush();
    f.advance(2000);
  }
  assert.equal(read.size, 70, 'symbols re-read at 30 s must not starve ones never read');
  assert.equal(f.funding.rates(symbols).length, 70);
});
test('clock rollback cannot starve symbols whose last attempt now lies in the future', async () => {
  const pending = [], read = new Set();
  const f = fixture({ current: quote => new Promise(resolve => pending.push({ at: f.now, finish: () => {
    read.add(quote.symbol); resolve({ rate: '0', intervalHours: 1, nextFundingAt: f.now + HOUR, sourceAt: f.now }); } })) });
  const symbols = Array.from({ length: 12 }, (_, i) => `OKX_FUTURE_R${i}_USDT`);
  for (let i = 0; i < 3; i++) { f.funding.rates(symbols); await flush(); pending.splice(0).forEach(p => p.finish()); await flush(); f.advance(2000); }
  assert.equal(read.size, 12);
  read.clear(); f.advance(-HOUR);
  for (let i = 0; i < 60; i++) {
    f.funding.rates(symbols); await flush();
    for (const p of pending.filter(p => f.now - p.at >= 16_000)) { pending.splice(pending.indexOf(p), 1); p.finish(); }
    await flush(); f.advance(2000);
  }
  assert.equal(read.size, 12, 'reads taking 16 s after a one-hour rollback still reach every symbol');
});

test('after a clock rollback a fresh read replaces a cached rate stamped in the future', async () => {
  const f = fixture({ current: (quote, now) => ({ rate: '0.0001', intervalHours: 8, nextFundingAt: now + HOUR, sourceAt: now }) });
  f.funding.rates([SYMBOL]); await flush();
  f.advance(-HOUR); assert.deepEqual(f.funding.rates([SYMBOL]), []); await flush();
  assert.equal(f.funding.rates([SYMBOL])[0]?.fundingAt, f.now);
});

test('a rate limit pauses that venue before identity resolution, keeps its identity and spares other venues', async () => {
  let limited = true;
  const f = fixture({ current: (quote, now) => {
    if (limited && quote.exchange === 'binance') throw Object.assign(new Error('429'), { status: 429 });
    return { rate: '0', intervalHours: 8, nextFundingAt: now + HOUR, sourceAt: now }; } });
  const symbols = ['BINANCE_FUTURE_A_USDT', 'BINANCE_FUTURE_B_USDT', 'OKX_FUTURE_A_USDT'];
  f.funding.rates([symbols[0]]); await flush();
  assert.deepEqual(f.calls, { identity: 1, current: 1 });
  f.advance(30_000); f.funding.rates(symbols); await flush();
  assert.deepEqual(f.calls, { identity: 2, current: 2 }, 'only the other venue is read while Binance cools down');
  limited = false; f.advance(30_000); f.funding.rates(symbols); await flush();
  assert.deepEqual(f.calls, { identity: 3, current: 5 }, 'the limited symbol reuses its identity once the pause ends');
  assert.equal(f.funding.rates(symbols).length, 3);
});
test('an identity-stage limit cools the venue, and a cooldown voided by clock rollback never revives', async () => {
  let limited = true;
  const f = fixture({ identity: symbol => {
    if (limited) throw Object.assign(new Error('只读来源响应 429'), { status: 502, sourceStatus: 429 });
    return { exchange: symbol.split('_')[0].toLowerCase(), symbol }; } });
  f.funding.rates(['BINANCE_FUTURE_A_USDT']); await flush();
  f.advance(2000); f.funding.rates(['BINANCE_FUTURE_A_USDT', 'BINANCE_FUTURE_B_USDT']); await flush();
  assert.deepEqual(f.calls, { identity: 1, current: 0 }, 'a new holding on the limited venue waits');
  limited = false; f.advance(-HOUR); f.funding.rates(['BINANCE_FUTURE_B_USDT']); await flush();
  assert.deepEqual(f.calls, { identity: 2, current: 1 });
  f.advance(HOUR); f.funding.rates(['BINANCE_FUTURE_C_USDT']); await flush();
  assert.deepEqual(f.calls, { identity: 3, current: 2 }, 'the voided deadline is not reapplied when time catches up');
});
test('market positions read held funding even when Monitor omits the contract', async t => {
  const reads = [];
  const market = createMarket(memoryMarketStore(), { clock: () => epoch,
    feedReader: async () => ({ ...feed(epoch), schemaVersion: 2, quotes: [], signals: [], exchanges: [] }),
    catalogReader: async () => catalog,
    identityReader: async symbol => ({ exchange: 'bybit', symbol: 'AXISUSDT', crossexSymbol: symbol }),
    currentFundingReader: async quote => { reads.push(quote.symbol); return { rate: '-0.00911135', intervalHours: 4, nextFundingAt: epoch + HOUR, sourceAt: epoch }; },
    depthReader: async () => { throw new Error('positions must not fetch depth'); } });
  t.after(() => market.stop()); await market.refresh();
  assert.deepEqual(market.view({ includeOpportunities: false, positionSymbols: [SYMBOL] }).positionFundingRates, []);
  assert.deepEqual(reads, [], 'lightweight reads do not start funding IO');
  market.view({ includeOpportunities: false, includePositionFunding: true, positionSymbols: [SYMBOL] }); await flush();
  const state = market.view({ includeOpportunities: false, includePositionFunding: true, positionSymbols: [SYMBOL] });
  assert.deepEqual(reads, ['AXISUSDT']);
  assert.equal(state.positionFundingRates.length, 1);
  assert.equal(state.positionFundingRates[0].normalized8hBps, -182.227);
  assert.deepEqual(state.fundingOpportunities, []);
});

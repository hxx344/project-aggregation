import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, epoch } from './fixtures.mjs';
import { createServerClock, sourceIsStale, valuationStaleReason } from '../src/freshness.ts';

test('server clock ages during stalled reads and charges transit time without using the browser wall clock', () => {
  let elapsed = 50;
  const clock = createServerClock(() => elapsed);
  elapsed = 350; clock.sample(epoch, 50);
  assert.equal(clock.now(), epoch + 300);
  const valuation = { at: epoch - 9500, stale: false, net: 5 };
  assert.equal(valuationStaleReason(valuation, clock.now(), false), '');
  elapsed += 201;
  assert.match(valuationStaleReason(valuation, clock.now(), false), /10 秒/);
  assert.equal(valuation.at, epoch - 9500, 'aging cannot renew the actual quote time');
  elapsed += 3600000;
  assert.match(valuationStaleReason(valuation, clock.now(), false), /10 秒/);
});

test('fresh unrelated quotes cannot extend a frozen feed or an older position', () => {
  const source = { state: 'partial', updatedAt: epoch, generatedAt: epoch - 9500 };
  assert.equal(sourceIsStale(source, epoch, true), false);
  assert.equal(sourceIsStale(source, epoch + 501, true), true);
  assert.equal(sourceIsStale(source, epoch, false), true);
  assert.match(valuationStaleReason({ at: epoch - 10001, stale: false }, epoch, false), /10 秒/);
});

for (const [name, change, reason] of [
  ['missing quote', f => f.quotes.pop(), /bybit 缺少/],
  ['old quote', f => { f.quotes[1].bidAskAt -= 11000; }, /bybit 盘口已 11.0 秒/],
  ['future quote', f => { f.quotes[1].bidAskAt += 1001; f.quotes[1].receivedAt += 1001; }, /领先/],
  ['invalid identity', f => { f.quotes[1].identityVerified = false; }, /身份无效/],
  ['changed identity', f => { f.quotes[1].settlementCurrency = 'USD'; }, /身份已变化/],
  ['offline leg', f => { f.exchanges[1].status = 'offline'; }, /bybit 行情连接/],
  ['out of sync', f => { f.quotes[1].bidAskAt -= 5001; }, /双腿盘口相差 5.0 秒/],
]) test(`old valuation explains ${name} and retains the last value without publishing it in totals`, async t => {
  const f = fixture(t); await f.engine.tick();
  await f.engine.open(`signal-${epoch}`, `valuation-${name.replaceAll(' ', '-')}`);
  await f.engine.tick();
  const previous = f.engine.view().positions[0].valuation;
  const next = feed(); next.signals = []; change(next);
  f.setFeed(next); await f.engine.refreshSource();
  const state = f.engine.view(), value = state.positions[0].valuation;
  assert.equal(value.stale, true); assert.match(value.reason, reason);
  assert.equal(value.net, previous.net); assert.equal(value.at, previous.at);
  assert.equal(state.totals.unrealizedPnl, null);
  assert.ok(Object.hasOwn(value.quoteTimes, 'short'));
});

test('held positions use fresh quotes even after their opportunity leaves the signal list', async t => {
  const f = fixture(t); await f.engine.tick(); await f.engine.open(`signal-${epoch}`, 'held-no-ranked-signal');
  f.advance(2000); const next = feed(f.now()); next.signals = [];
  f.setFeed(next); await f.engine.refreshSource();
  const state = f.engine.view();
  assert.equal(state.opportunities.length, 0); assert.equal(state.positions[0].valuation.stale, false);
  assert.equal(state.positions[0].valuation.at, epoch + 2000);
});

test('source read diagnostics record receipt and duration without changing quote timestamps', async t => {
  let fail = false;
  const f = fixture(t, { feedReader: async () => { f.advance(150); if (fail) throw new Error('transport down'); return feed(); } });
  await f.engine.refreshSource();
  let source = f.engine.view().source;
  assert.equal(source.checkedAt, epoch); assert.equal(source.receivedAt, epoch + 150);
  assert.equal(source.durationMs, 150); assert.equal(source.updatedAt, epoch);
  fail = true; await f.engine.refreshSource(); source = f.engine.view().source;
  assert.equal(source.receivedAt, epoch + 150); assert.equal(source.state, 'offline');
  await f.engine.settings({ config: { monitorUrl: 'http://127.0.0.1:3001' } });
  source = f.engine.view().source;
  assert.equal(source.receivedAt, null); assert.equal(source.durationMs, null);
});

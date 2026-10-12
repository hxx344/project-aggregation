import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, book, epoch } from './fixtures.mjs';

test('expired holding closes with independent depth even when Monitor is offline', async t => {
  const f = fixture(t); await f.engine.settings({ config: { enabled: true, maxHoldMinutes: 1, takeProfitBps: 5000, stopLossBps: 5000 } }); await f.engine.tick();
  f.advance(61000); f.offline(true); await f.engine.tick();
  assert.equal(f.store.positions('open').length, 0); assert.equal(f.store.positions('closed')[0].reason, '达到最长持有时间');
});

test('entry-only pause continues risk exits; disabled automatic mode pauses them', async t => {
  const f = fixture(t); await f.engine.settings({ config: { enabled: true, maxHoldMinutes: 1 } }); await f.engine.tick();
  await f.engine.settings({ config: { entryPaused: true, enabled: false } }); f.advance(61000); f.setFeed(feed(f.now())); await f.engine.tick(); assert.equal(f.store.positions('open').length, 1);
  await f.engine.settings({ config: { enabled: true } }); await f.engine.tick(); assert.equal(f.store.positions('open').length, 0);
  f.advance(70000); f.setFeed(feed(f.now())); await f.engine.tick(); assert.equal(f.store.positions('open').length, 0);
});

test('fee overrides affect eligibility and immutable leg snapshots affect realized PnL', async t => {
  const f = fixture(t); await f.engine.settings({ config: { feeSchedule: [{ exchange: 'binance', symbol: '', makerBps: 0, takerBps: 10, source: 'operator', updatedAt: epoch }, { exchange: 'bybit', symbol: 'BTCUSDT', makerBps: -1, takerBps: 20, source: 'operator', updatedAt: epoch }] } });
  await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'fee-snapshot-open');
  await f.engine.settings({ config: { feeBps: 100, feeSchedule: [] } });
  f.setDepth(() => ({ at: f.now(), bids: [[101, 100]], asks: [[101, 100]] }));
  const closed = await f.engine.closePosition(p.id, 'fee-snapshot-close');
  assert.ok(Math.abs(closed.result.net - (p.quantity * 2 - p.quantity * (100 * 10 + 102 * 20 + 101 * 30) / 10000)) < 1e-10);
});

test('depth exit valuation reports partial capacity and never total PnL for a partial exit', async t => {
  const f = fixture(t); await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'depth-mark-open');
  f.setDepth(q => ({ ...book(q, f.now()), bids: [[q.bid, 0.1]], asks: [[q.ask, 0.1]] })); await f.engine.refreshValuations();
  const value = f.engine.view().positions[0].exitQuote;
  assert.equal(value.complete, false); assert.equal(value.priceOnlyNet, null); assert.equal(value.longQuantity, 0.1);
  f.advance(16000); f.setDepth(q => book(q, f.now())); await f.engine.refreshValuations(); assert.equal(f.store.findPosition(p.id).exitQuote.complete, true);
  f.advance(11000); assert.equal(f.engine.view().positions[0].exitQuote.stale, true);
});

test('funding updates closed records once and invalidates history version across restart', async t => {
  const f = fixture(t, { fundingReader: async (q, from, to) => ({ exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: from, coveredTo: to, complete: true, source: 'test', sourceAt: to, current: null, settlements: [{ at: from + 1000, rate: q.exchange === 'binance' ? '0.001' : '0.002', markPrice: '100', unit: 'rate', source: 'test' }] }) });
  await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'funding-test-open'); f.advance(2000); await f.engine.closePosition(p.id, 'funding-test-close');
  const version = f.engine.view().historyVersion; await f.engine.refreshAccounting();
  const updated = f.engine.view({ historyVersion: version }); assert.ok(updated.history); assert.equal(updated.history[0].funding.status, 'complete');
  const confirmed = updated.history[0].funding.confirmed; assert.ok(Math.abs(confirmed - p.quantity * 0.1) < 1e-12);
  await f.reopen(); await f.engine.refreshAccounting(); assert.equal(f.store.findPosition(p.id).funding.confirmed, confirmed);
});

test('sample history keeps null gaps and survives restart without inventing percentage returns', async t => {
  const f = fixture(t); await f.engine.tick(); await f.engine.open(`signal-${epoch}`, 'analytics-test-open'); await f.engine.refreshAccounting();
  f.advance(16000); f.offline(true); await f.engine.tick();
  const missing = f.engine.view().analytics.samples.at(-1); assert.equal(missing.equity, null); assert.equal(missing.unrealized, null);
  await f.reopen(); assert.equal(f.engine.view().analytics.samples.at(-1).at, missing.at);
});

test('a zero-length initial funding ledger is not complete for later held time', async t => {
  const f = fixture(t); await f.engine.tick(); await f.engine.open(`signal-${epoch}`, 'funding-zero-length');
  f.advance(1000); f.setFeed(feed(f.now())); await f.engine.tick();
  const value = f.engine.view(); assert.notEqual(value.positions[0].funding.status, 'complete'); assert.equal(value.totals.netWithFunding, null);
});

test('funding read failures preserve already confirmed settlement rows as a partial ledger', async t => {
  let failed = false;
  const f = fixture(t, { fundingReader: async (q, from, to) => failed ? { exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: null, coveredTo: null, complete: false, current: null, settlements: [], error: 'cooldown' } : { exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: from, coveredTo: to, complete: true, source: 'test', sourceAt: to, current: null, settlements: [{ at: from + 1000, rate: '0.001', markPrice: '100', unit: 'rate', source: 'test' }] } });
  await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'funding-preserve-open'); f.advance(2000); await f.engine.refreshAccounting();
  assert.equal(f.store.findPosition(p.id).funding.entries.length, 2);
  failed = true; f.advance(61000); await f.engine.refreshAccounting(); const after = f.store.findPosition(p.id).funding;
  assert.equal(after.entries.length, 2); assert.notEqual(after.status, 'complete'); assert.equal(after.confirmed, null);
});

test('native schedules cannot extend funding coverage after source timestamps expire or restart', async t => {
  const f = fixture(t, { fundingReader: async (q, from, to) => ({ exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: from, coveredTo: to, complete: true, sourceAt: to, source: 'test', settlements: [], current: { rate: '0.001', intervalHours: 8, nextFundingAt: from + 7 * 3600000, sourceAt: to } }) });
  await f.engine.tick(); await f.engine.open(`signal-${epoch}`, 'funding-expire-open'); f.advance(1000); await f.engine.refreshAccounting();
  f.advance(1000); f.setFeed(feed(f.now())); await f.engine.tick(); assert.equal(f.engine.view().positions[0].funding.status, 'complete');
  f.advance(180001); f.setFeed(feed(f.now())); await f.engine.tick(); assert.notEqual(f.engine.view().positions[0].funding.status, 'complete'); assert.equal(f.engine.view().totals.netWithFunding, null);
  await f.reopen(); assert.notEqual(f.engine.view().positions[0].funding.status, 'complete');
});

test('funding response racing a close cannot present a truncated estimate as the whole holding period', async t => {
  const releases = [];
  const f = fixture(t, { fundingReader: (q, from, to) => new Promise(resolve => releases.push(() => resolve({ exchange: q.exchange, symbol: q.symbol, from, to, coveredFrom: from, coveredTo: to, complete: true, source: 'test', sourceAt: to, current: null, settlements: [] }))) });
  await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'funding-race-open'); f.advance(1000);
  const accounting = f.engine.refreshAccounting(); assert.equal(releases.length, 2);
  f.advance(500); await f.engine.closePosition(p.id, 'funding-race-close'); for (const release of releases) release(); await accounting;
  const closed = f.store.findPosition(p.id); assert.equal(closed.funding.status, 'partial'); assert.equal(closed.funding.confirmed, null); assert.equal(closed.funding.estimated, null); assert.equal(closed.result.netWithFunding, null);
});

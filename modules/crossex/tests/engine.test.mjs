import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, book, quote, epoch } from './fixtures.mjs';

test('manual open/close records equal fills and correct PnL with all four fees', async t => {
  const f = fixture(t); await f.engine.tick();
  const p = await f.engine.open(`signal-${epoch}`, 'open-request-one');
  assert.equal(p.longFill.quantity, p.shortFill.quantity); assert.equal(p.status, 'open');
  f.setDepth(q => ({ at: f.now(), bids: [[101, 100]], asks: [[101, 100]] }));
  const closed = await f.engine.closePosition(p.id, 'close-request-one');
  const expectedGross = p.quantity * 2, expectedFees = p.quantity * (100 + 102 + 101 + 101) * 6 / 10000;
  assert.ok(Math.abs(closed.result.net - (expectedGross - expectedFees)) < 1e-10);
  assert.equal(closed.fundingPnl, null); assert.equal(f.engine.view().totals.closedCount, 1);
});
test('concurrent retry, repeated signal, active base and restart all preserve dedup', async t => {
  const f = fixture(t); await f.engine.tick();
  const [a, b] = await Promise.all([f.engine.open(`signal-${epoch}`, 'identical-request'), f.engine.open(`signal-${epoch}`, 'identical-request')]);
  assert.equal(a.id, b.id); assert.equal(f.engine.view().totals.openCount, 1);
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'different-request'), /已执行/);
  await assert.rejects(f.engine.closePosition(a.id, 'identical-request'), /编号/);
  await f.reopen(); await f.engine.tick(); assert.equal((await f.engine.open(`signal-${epoch}`, 'identical-request')).id, a.id);
  f.advance(1); f.setFeed(feed(f.now())); await f.engine.tick(); await assert.rejects(f.engine.open(`signal-${f.now()}`, 'new-signal-request'), /已有/);
});
test('failure of either leg or partial visible depth creates no fictitious fill', async t => {
  const f = fixture(t); await f.engine.tick(); f.setDepth(q => q.exchange === 'bybit' ? { at: f.now(), bids: [[102, 0.001]], asks: [[103, 1]] } : book(q, f.now()));
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'shallow-request'), /深度不足/); assert.equal(f.store.positions().length, 0);
  f.setDepth(q => { if (q.exchange === 'bybit') throw new Error('venue failed'); return book(q, f.now()); });
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'failed-leg-request')); assert.equal(f.store.positions().length, 0);
});
test('signal expiring during depth read cannot open', async t => {
  const f = fixture(t); await f.engine.tick(); f.setDepth(q => { f.advance(6000); return book(q, f.now()); });
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'expired-request'), /过期/); assert.equal(f.store.positions().length, 0);
});
test('stale source preserves last valuation and freezes new trades', async t => {
  const f = fixture(t); await f.engine.tick(); await f.engine.open(`signal-${epoch}`, 'first-open-request'); await f.engine.tick();
  f.offline(true); await f.engine.tick(); const value = f.engine.view();
  assert.equal(value.source.state, 'offline'); assert.equal(value.totals.unrealizedPnl, null); assert.equal(value.positions[0].valuation.stale, true); assert.equal(value.positions[0].valuation.at, epoch);
  assert.equal(value.opportunities[0].eligible, false);
});
test('source heartbeat cannot freshen stale underlying prices', async t => {
  const f = fixture(t); f.advance(20000); f.setFeed({ ...feed(), generatedAt: f.now() }); await f.engine.tick();
  assert.equal(f.engine.view().source.updatedAt, epoch); assert.equal(f.engine.view().opportunities[0].eligible, false);
});
test('automatic lifecycle opens and closes on fresh depth, paused engine never trades', async t => {
  const f = fixture(t); await f.engine.tick(); assert.equal(f.store.positions().length, 0);
  await f.engine.settings({ config: { enabled: true } }); await f.engine.tick(); assert.equal(f.engine.view().totals.openCount, 1);
  f.advance(5000); const next = feed(f.now()); next.quotes = [quote('binance', f.now(), { bid: 101, ask: 101 }), quote('bybit', f.now(), { bid: 101, ask: 101 })]; next.signals = []; f.setFeed(next);
  f.setDepth(q => book(next.quotes.find(x => x.exchange === q.exchange), f.now())); await f.engine.tick();
  assert.equal(f.engine.view().totals.openCount, 0); assert.equal(f.engine.view().history[0].reason, '达到止盈');
});
test('settings and source credentials persist encrypted, target changes clear them', async t => {
  const f = fixture(t); await f.engine.settings({ config: { feeBps: 10 }, monitorPassword: 'test-monitor-secret' });
  assert.equal(f.engine.view().config.hasMonitorPassword, true); assert.doesNotMatch(JSON.stringify(f.engine.view()), /test-monitor-secret/);
  assert.notEqual(f.store.get('monitorPassword'), 'test-monitor-secret'); await f.reopen(); assert.equal(f.engine.view().config.feeBps, 10);
  await f.engine.settings({ config: { monitorUrl: 'http://127.0.0.1:3001' } }); assert.equal(f.engine.view().config.hasMonitorPassword, false);
});
test('failed close keeps the open position intact and can be retried', async t => {
  const f = fixture(t); await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'first-open-request'); f.setDepth(q => ({ ...book(q, f.now()), bids: [[99, 0.00001]] }));
  await assert.rejects(f.engine.closePosition(p.id, 'close-failure-request')); assert.equal(f.engine.view().totals.openCount, 1); assert.equal(f.engine.view().totals.realizedPnl, 0);
});

test('recent closes and cooldown use close time even beyond the history page limit', async t => {
  const f = fixture(t); await f.engine.tick(); const p = await f.engine.open(`signal-${epoch}`, 'old-position-open');
  for (let i = 0; i < 205; i++) f.store.savePosition({ ...p, id: `later-${i}`, signalId: `later-signal-${i}`, pairKey: `later-pair-${i}`, base: `ALT${i}`, status: 'closed', openedAt: epoch + i + 1, closedAt: epoch + 1000 + i, result: { net: 1 } });
  f.advance(10000); await f.engine.closePosition(p.id, 'old-position-close');
  assert.equal(f.engine.view().history[0].id, p.id); assert.equal(f.engine.view().history.length, 200); assert.equal(f.engine.view().totals.closedCount, 206);
  assert.ok(f.store.coolingBases(epoch).includes('BTC'));
  f.advance(1); f.setFeed(feed(f.now())); await f.engine.tick(); await assert.rejects(f.engine.open(`signal-${f.now()}`, 'cooldown-reopen-request'), /冷却/);
});

test('out-of-phase browser polls can use the exact recent version without extending expiry', async t => {
  const f = fixture(t); await f.engine.tick(); f.advance(5000); f.setFeed(feed(f.now())); await f.engine.tick();
  assert.equal((await f.engine.open(`signal-${epoch}`, 'browser-previous-version')).status, 'open');
});
test('remembered signal cannot outlive original expiry or current market eligibility', async t => {
  const f = fixture(t); await f.engine.tick(); f.advance(10001); f.setFeed(feed(f.now())); await f.engine.tick();
  await assert.rejects(f.engine.open(`signal-${epoch}`, 'expired-previous-version'), /变化/);
  const id = `signal-${f.now()}`; f.advance(1); const next = feed(f.now()); next.signals = []; next.quotes = []; f.setFeed(next); await f.engine.tick();
  await assert.rejects(f.engine.open(id, 'delisted-previous-version'), /变化/);
});

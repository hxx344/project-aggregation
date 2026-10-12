import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, book, epoch } from './fixtures.mjs';

async function step(f, count = 1) { for (let i = 0; i < count; i++) { f.advance(1000); f.setFeed(feed(f.now())); await f.engine.tick(); } }
async function setup(t, scenario = 'normal', options = {}) {
  const f = fixture(t, options); await f.engine.settings({ config: { executionMode: 'staged', executionScenario: scenario, executionDelayMs: 0, slippageBps: 5, clipNotional: 25 } }); await f.engine.tick();
  const e = await f.engine.open(`signal-${epoch}`, 'staged-open-request'); return { f, e };
}

test('staged receipts survive restart and idempotent retries return current operation', async t => {
  const { f, e } = await setup(t, 'unknown-short');
  await step(f); const submitted = f.store.findExecution(e.id);
  assert.equal(submitted.orders.length, 1); assert.equal(f.store.findPosition(e.positionId).longQuantity, '0');
  await f.reopen(); await step(f);
  assert.ok(Number(f.store.findPosition(e.positionId).longQuantity) > 0);
  const receiptIds = f.store.findExecution(e.id).fills.map(x => x.id);
  await f.reopen(); await step(f, 40);
  const completed = await f.engine.open(`signal-${epoch}`, 'staged-open-request');
  assert.equal(completed.id, e.id); assert.equal(completed.state, 'completed');
  assert.equal(new Set(completed.fills.map(x => x.id)).size, completed.fills.length);
  for (const id of receiptIds) assert.equal(completed.fills.filter(x => x.id === id).length, 1);
  const p = f.store.findPosition(e.positionId); assert.equal(p.longQuantity, String(p.quantity)); assert.equal(p.shortQuantity, String(p.quantity));
  assert.ok(completed.orders.some(x => x.leg === 'short')); assert.equal(completed.reservedNotional, 0);
});

test('staged close realizes partial exits exactly once and preserves all entry and exit fees', async t => {
  const { f, e } = await setup(t); await step(f, 40);
  const p = f.store.findPosition(e.positionId);
  f.setDepth(() => ({ at: f.now(), bids: [[101, 100]], asks: [[101, 100]] }));
  const close = await f.engine.closePosition(p.id, 'staged-close-request'); await step(f, 40);
  assert.equal(f.store.findExecution(close.id).state, 'completed');
  const closed = f.store.findPosition(p.id);
  assert.equal(closed.status, 'closed'); assert.equal(closed.longQuantity, '0'); assert.equal(closed.shortQuantity, '0');
  assert.ok(Math.abs(closed.result.net - (p.quantity * 2 - p.quantity * 404 * 6 / 10000)) < 1e-10);
  assert.equal(new Set(f.store.findExecution(close.id).fills.map(x => x.id)).size, f.store.findExecution(close.id).fills.length);
});

test('rejected leg repairs and shallow depth blocks without inventing fills', async t => {
  const { f, e } = await setup(t, 'reject-short'); await step(f, 40);
  assert.equal(f.store.findExecution(e.id).state, 'completed');
  assert.ok(f.store.findExecution(e.id).orders.some(x => x.state === 'REJECTED'));
  assert.ok(f.store.findExecution(e.id).repairCost > 0);
  const p = f.store.findPosition(e.positionId), close = await f.engine.closePosition(p.id, 'blocked-close-request');
  f.setDepth(q => ({ ...book(q, f.now()), bids: [[q.bid, 0.00000001]], asks: [[q.ask, 0.00000001]] }));
  await step(f, 5); assert.equal(f.store.findExecution(close.id).state, 'blocked');
  assert.equal(f.store.findPosition(p.id).longQuantity, p.longQuantity);
  f.setDepth(q => book(q, f.now())); await f.engine.executionAction(close.id, 'retry', 'retry-close-task'); await step(f, 40);
  assert.equal(f.store.findPosition(p.id).status, 'closed');
});

test('cancel reconciles already accepted unknown receipts before releasing reservation', async t => {
  const { f, e } = await setup(t, 'unknown-short'); await step(f, 3);
  assert.equal(f.store.findExecution(e.id).orders.at(-1).state, 'UNKNOWN');
  await f.engine.executionAction(e.id, 'cancel', 'cancel-task-request'); await f.reopen(); await step(f, 3);
  const cancelled = f.store.findExecution(e.id), p = f.store.findPosition(e.positionId);
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.reservedNotional, 0);
  assert.ok(Number(p.longQuantity) > 0); assert.ok(Number(p.shortQuantity) > 0);
  assert.equal(cancelled.fills.length, 2);
});

test('partial scenario obeys lot steps, fixed seed and reconciles every actual fill', async t => {
  const { f, e } = await setup(t, 'partial'); await step(f, 160);
  const task = f.store.findExecution(e.id); assert.equal(task.state, 'completed');
  for (const fill of task.fills) assert.ok(Math.abs(fill.quantity / 0.001 - Math.round(fill.quantity / 0.001)) < 1e-8);
  assert.ok(task.fills.length > task.orders.length);
  const p = f.store.findPosition(e.positionId); assert.ok(Math.abs(task.fills.filter(x => x.leg === 'long').reduce((n, x) => n + x.quantity, 0) - p.quantity) < 1e-10);
});

test('queued entry reserves both legs before there are any fills', async t => {
  const { f, e } = await setup(t);
  assert.equal(f.engine.view().totals.reservedNotional, 200);
  assert.equal(f.engine.view().totals.usedNotional, 0);
  assert.equal(f.engine.view().totals.openCount, 1);
  await f.engine.executionAction(e.id, 'cancel', 'cancel-before-fill'); await step(f);
  assert.equal(f.engine.view().totals.reservedNotional, 0); assert.equal(f.engine.view().totals.openCount, 0);
});

test('clip tails respect submitted order minimums and actual exit quantities release budget', async t => {
  const { f, e } = await setup(t); await f.engine.settings({ config: { clipNotional: 33 } });
  await step(f, 40); const p = f.store.findPosition(e.positionId);
  const close = await f.engine.closePosition(p.id, 'minimum-tail-close'); const before = f.engine.view().totals.usedNotional;
  await step(f, 2); assert.ok(f.engine.view().totals.usedNotional < before);
  await step(f, 40);
  for (const order of f.store.findExecution(close.id).orders) assert.ok(order.quantity * order.price >= 5);
});

test('cancelled automatic close can be replaced on the next risk check', async t => {
  const { f, e } = await setup(t); await step(f, 40);
  await f.engine.settings({ config: { enabled: true, entryPaused: true, executionDelayMs: 0 } });
  const p = f.store.findPosition(e.positionId); p.maxHoldMinutes = 1; p.stopLossBps = 5000; p.takeProfitBps = 5000; f.store.savePosition(p);
  await step(f, 21); const first = f.store.executions(true).find(x => x.kind === 'close'); assert.ok(first);
  await f.engine.executionAction(first.id, 'cancel', 'cancel-automatic-close'); await step(f, 2);
  const next = f.store.executions(true).find(x => x.kind === 'close'); assert.ok(next); assert.notEqual(next.id, first.id);
});

test('a booked fill invalidates an earlier zero-quantity depth valuation', async t => {
  const { f, e } = await setup(t); await f.engine.refreshValuations();
  assert.equal(f.engine.view().positions[0].exitQuote.stale, false);
  await step(f, 2); const p = f.store.findPosition(e.positionId); assert.ok(Number(p.longQuantity) > 0);
  assert.equal(f.engine.view().positions[0].exitQuote.stale, true); assert.equal(f.engine.view().positions[0].exitQuote.net, null);
});

test('single-leg exposure can trigger a staged profit exit without filling the empty leg', async t => {
  const { f, e } = await setup(t); await step(f, 2);
  await f.engine.executionAction(e.id, 'cancel', 'single-leg-cancel'); await step(f);
  const p = f.store.findPosition(e.positionId); assert.equal(p.shortQuantity, '0');
  f.setDepth(() => ({ at: f.now(), bids: [[103, 100]], asks: [[103, 100]] }));
  await f.engine.settings({ config: { enabled: true, entryPaused: true } });
  f.advance(1000); const next = feed(f.now()); next.quotes = next.quotes.map(q => ({ ...q, bid: 103, ask: 103 })); f.setFeed(next); await f.engine.tick();
  assert.ok(f.store.executions(true).some(x => x.kind === 'close'));
  await step(f, 20); assert.equal(f.store.findPosition(p.id).status, 'closed');
});

test('failed cancellation retains exposure and reservation until an explicit retry confirms it', async t => {
  const { f, e } = await setup(t, 'cancel-reject'); await step(f, 2);
  await f.engine.executionAction(e.id, 'cancel', 'cancel-rejected-request'); await step(f, 3);
  const blocked = f.store.findExecution(e.id); assert.equal(blocked.state, 'blocked'); assert.ok(blocked.reservedNotional > 0);
  const exposure = f.store.findPosition(e.positionId).longQuantity; await f.reopen(); await step(f, 2); assert.equal(f.store.findExecution(e.id).state, 'blocked');
  await f.engine.executionAction(e.id, 'retry', 'cancel-rejected-retry'); await step(f);
  assert.equal(f.store.findExecution(e.id).state, 'cancelled'); assert.equal(f.store.findPosition(e.positionId).longQuantity, exposure); assert.equal(f.store.findExecution(e.id).reservedNotional, 0);
});

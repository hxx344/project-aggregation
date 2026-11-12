// Hard notional caps (plan 7, 3.0): per job and running total of opening jobs, checked at preview and inside confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/contracts.ts';
import { add, cmp } from '../src/decimal.ts';
import { createExecutor } from '../src/executor.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
async function withHarness(run: (h: Harness) => Promise<void>, notionalLimits?: { perJob: string; totalOpen: string }) {
  const h = createHarness({ notionalLimits });
  try { await run(h); } finally { h.dispose(); }
}
const bzIntent = () => ({ ...openIntent(), symbol: 'BZUSDT' });
const closeIntent = () => openIntent({ action: 'close' });

test('真实账户必须配置名义金额上限；格式错误的上限不能启动', () => withHarness(async h => {
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], environment: 'mainnet' }), code('notional_limits_required'));
  // With caps the mainnet start still stops at the simulated-only transport guard.
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.bybit], environment: 'mainnet', notionalLimits: { perJob: '100', totalOpen: '500' } }), code('live_transport_refused'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '600', totalOpen: '500' } }), code('invalid_value'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '0', totalOpen: '500' } }), code('invalid_decimal'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '1', totalOpen: '2000000000' } }), code('invalid_value'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], notionalLimits: { perJob: '1' } as never }), code('missing_field'));
}));

test('单笔上限：按价格保护界限计价，超限在预览拒绝且不下单', () => withHarness(async h => {
  bindAccounts(h.ex);
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['2', '2'] }), SESSION), code('notional_job_cap'));
  const preview = await h.ex.preview(openIntent(), SESSION);
  // Binance buys at its bound (above the 70.02 ask); the job counts the dearer leg.
  const [lead, hedge] = preview.legs;
  assert.equal(cmp(preview.notional, lead.priceBound as string), 0);
  assert.ok(cmp(preview.notional, hedge.quote.ask) >= 0 && cmp(preview.notional, '100') <= 0);
  assert.ok(preview.notes.some(note => note.includes('单笔上限 100 USDT')));
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
}, { perJob: '100', totalOpen: '1000' }));

test('累计上限：两个预览各自不超限，确认事务内按当时累计再核，后确认的一笔被拒', () => withHarness(async h => {
  bindAccounts(h.ex);
  const cl = await h.ex.preview(openIntent(), SESSION);
  const bz = await h.ex.preview(bzIntent(), SESSION);
  assert.ok(cmp(add(cl.notional, bz.notional), '120') > 0);
  h.ex.confirm({ previewId: cl.id, requestId: randomUUID(), confirmLive: true }, SESSION);
  assert.throws(() => h.ex.confirm({ previewId: bz.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('notional_total_cap'));
  assert.deepEqual(h.ex.notionalLimits(), { perJob: '100', totalOpen: '120', openUsed: cl.notional });
  // The refused confirm consumed nothing: no job, no lock, no order.
  assert.equal(h.ex.recentJobs().length, 1);
  await assert.rejects(h.ex.preview(bzIntent(), SESSION), code('notional_total_cap'));
}, { perJob: '100', totalOpen: '120' }));

test('累计不因成交或平仓退回；平仓只受单笔上限，累计用尽后仍可平仓', () => withHarness(async h => {
  bindAccounts(h.ex);
  const first = await previewAndConfirm(h);
  assert.equal((await settle(h, first.jobId)).status, 'completed');
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('notional_total_cap'));
  await assert.rejects(h.ex.preview(openIntent({ action: 'close', quantity: ['2', '2'] }), SESSION), code('close_exceeds_position'));
  const close = await previewAndConfirm(h, closeIntent());
  assert.equal((await settle(h, close.jobId)).status, 'completed');
  assert.equal(h.ex.notionalLimits()?.openUsed, first.preview.notional);
}, { perJob: '100', totalOpen: '100' }));

test('没有任何委托离开进程就结束的任务不计入累计；重启后累计仍从库内任务算出', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId, preview } = await previewAndConfirm(h);
  assert.equal(h.ex.notionalLimits()?.openUsed, preview.notional);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.equal(h.ex.jobView(jobId).status, 'failed');
  assert.equal(h.ex.notionalLimits()?.openUsed, '0');
  const sent = await previewAndConfirm(h);
  assert.equal((await settle(h, sent.jobId)).status, 'completed');
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.equal(h.ex.notionalLimits()?.openUsed, sent.preview.notional);
}, { perJob: '100', totalOpen: '150' }));

test('未配置上限时不限制（模拟默认）', () => withHarness(async h => {
  bindAccounts(h.ex);
  assert.equal(h.ex.notionalLimits(), null);
  const preview = await h.ex.preview(openIntent({ quantity: ['10', '10'] }), SESSION);
  assert.ok(!preview.notes.some(note => note.includes('单笔上限')));
}));

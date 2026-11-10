import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/contracts.ts';
import { createExecutor } from '../src/executor.ts';
import { openStore } from '../src/store.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
async function withHarness(run: (h: Harness) => Promise<void>, options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  try { await run(h); } finally { h.dispose(); }
}
const opState = (h: Harness, jobId: string, leg: 0 | 1) => h.ex.jobView(jobId).legs[leg].operation?.state ?? null;

test('正常双腿：预览不下单，确认后先发首腿，按成交量对冲并完成', () => withHarness(async h => {
  bindAccounts(h.ex);
  const preview = await h.ex.preview(openIntent(), SESSION);
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
  assert.equal(preview.legs[0].orderSide, 'buy');
  assert.equal(preview.legs[1].orderSide, 'sell');
  const confirmed = h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION);
  assert.equal(confirmed.duplicate, false);
  assert.equal(confirmed.job.status, 'accepted');
  const view = await settle(h, confirmed.job.id);
  assert.equal(view.status, 'completed');
  assert.equal(view.locked, false);
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'long'), '1');
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '1');
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [1, 1]);
}));

test('C03 重复确认只返回同一任务；换会话、换载荷、已消费或过期的预览都被拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { preview, requestId, jobId } = await previewAndConfirm(h);
  const again = h.ex.confirm({ previewId: preview.id, requestId, confirmLive: true }, SESSION);
  assert.equal(again.duplicate, true);
  assert.equal(again.job.id, jobId);
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId, confirmLive: true }, 'other-session-01'), code('request_reused'));
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_invalid'));
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId, confirmLive: false }, SESSION), code('confirm_required'));
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('symbol_locked'));
  await settle(h, jobId);
  const second = await h.ex.preview(openIntent({ action: 'close' }), SESSION);
  assert.throws(() => h.ex.confirm({ previewId: second.id, requestId, confirmLive: true }, SESSION), code('request_reused'));
  h.advance(31_000);
  assert.throws(() => h.ex.confirm({ previewId: second.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_invalid'));
  assert.equal(h.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 1);
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [1, 1]);
}));

test('C01 能力与身份：ANT 不可执行、Bybit ANT 不可读、跨所与方向约束、身份与凭据绑定', () => withHarness(async h => {
  bindAccounts(h.ex);
  const intent = openIntent();
  await assert.rejects(h.ex.preview({ ...intent, symbol: 'ANTHROPICUSDT' }, SESSION), code('invalid_value'));
  await assert.rejects(h.ex.preview({ ...intent, legs: [intent.legs[0], { ...intent.legs[1], venue: 'binance' }] }, SESSION), code('same_venue'));
  await assert.rejects(h.ex.preview({ ...intent, legs: [intent.legs[0], { ...intent.legs[1], side: 'long' }] }, SESSION), code('same_side'));
  await assert.rejects(h.ex.preview({ ...intent, legs: [{ ...intent.legs[0], orderType: 'limit' }, intent.legs[1]] }, SESSION), code('limit_price'));
  await assert.rejects(h.ex.observe('bybit', 'ANTHROPICUSDT'), code('venue_symbol'));
  const ant = await h.ex.observe('binance', 'ANTHROPICUSDT');
  assert.equal(ant.instrument.quantityStep, '0.001');
  assert.deepEqual(ant.position, { long: '0', short: '0' });

  const rotated = h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 2 });
  assert.equal(rotated.accountKey, 'binance:simulated:BN1001');
  assert.throws(() => h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 1 }), code('credential_version'));
  assert.throws(() => h.ex.registerAccount({ venue: 'bybit', environment: 'simulated', accountId: 'BY2002', accountMode: 'standard', credentialVersion: 1 }), code('invalid_value'));
  assert.throws(() => h.ex.registerAccount({ venue: 'binance', environment: 'mainnet', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 3 }), code('environment'));

  const preview = await h.ex.preview(openIntent(), SESSION);
  h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 3 });
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('binding_changed'));

  const { jobId } = await previewAndConfirm(h);
  assert.throws(() => h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN3003', accountMode: 'standard', credentialVersion: 1 }), code('account_busy'));
  await settle(h, jobId);

  // The venue reports another principal behind the bound key: no preview, no send.
  h.binance.accounts.set('BN4004', { ...h.binance.accounts.get('BN1001')!, positions: new Map() });
  h.ex.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN4004', accountMode: 'standard', credentialVersion: 1 });
  await assert.rejects(h.ex.preview(openIntent({ action: 'close' }), SESSION), code('account_identity'));
}));

test('C01 原型拒绝任何非模拟传输或非模拟环境', () => withHarness(async h => {
  const live = { ...h.binance, venue: 'binance', capabilities: { ...h.binance.capabilities, transport: 'live' } } as unknown as typeof h.binance;
  assert.throws(() => createExecutor({ store: h.store, connectors: [live] }), code('live_transport_refused'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance], environment: 'mainnet' }), code('live_transport_refused'));
  assert.throws(() => createExecutor({ store: h.store, connectors: [h.binance, h.binance] }), code('duplicate_connector'));
}));

test('C02 数量、名义金额、桶数平衡与持仓模式在预览阶段拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1e3', '1'] }), SESSION), code('invalid_decimal'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1.005', '1'] }), SESSION), code('quantity_step'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1', '1.05'] }), SESSION), code('quantity_step'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['2000', '2000'] }), SESSION), code('quantity_range'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['0.05', '0.1'] }), SESSION), code('min_notional'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1', '2'] }), SESSION), code('unbalanced'));
  // Within one hedge step is still unequal: completion needs equal barrels, so it is refused up front.
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1.01', '1'] }), SESSION), code('unbalanced'));
  await assert.rejects(h.ex.preview(openIntent({ quantity: ['1', '1.1'] }), SESSION), code('unbalanced'));
  await assert.rejects(h.ex.preview(openIntent({ action: 'close' }), SESSION), code('close_exceeds_position'));
  h.binance.setPosition('BN1001', 'CLUSDT', 'short', '1');
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('implicit_reduce'));
  h.binance.setPosition('BN1001', 'CLUSDT', 'short', '0');
  h.bybit.addForeignOrder('BY2002', 'CLUSDT');
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('external_orders'));
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
}));

test('C04 首腿部分成交：对冲腿按实际成交量发送；步长取整留下的差额转人工并保留合约锁', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '0.4' });
  const first = await previewAndConfirm(h);
  const done = await settle(h, first.jobId);
  assert.equal(done.status, 'completed');
  assert.equal(done.legs[1].operation?.quantity, '0.4');
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '0.4');

  h.binance.inject({ operation: 'place', mode: 'partial', filled: '0.45' });
  const second = await previewAndConfirm(h);
  const view = await settle(h, second.jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[1].operation?.quantity, '0.4');
  assert.match(view.reason ?? '', /未对冲 0.05 桶/);
  assert.equal(view.locked, true);
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('symbol_locked'));
  const requestId = randomUUID();
  const acknowledged = h.ex.acknowledge(second.jobId, requestId, SESSION);
  assert.equal(acknowledged.locked, false);
  assert.equal(h.ex.acknowledge(second.jobId, requestId, SESSION).status, 'attention');
  assert.throws(() => h.ex.acknowledge(first.jobId, randomUUID(), SESSION), code('not_attention'));
  await h.ex.preview(openIntent(), SESSION);
}));

test('C04 对冲腿被交易所拒绝：不重发，首腿敞口保留并转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  const { jobId } = await previewAndConfirm(h);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[1].operation?.state, 'rejected');
  for (let i = 0; i < 3; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.bybit.calls.place, 1);
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'long'), '1');
}));

test('C05 首腿回报丢失：按原客户订单号核对到成交，不重发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual([h.binance.calls.place, h.binance.arrived.place, h.bybit.arrived.place], [1, 1, 1]);
}));

test('C05 首腿查询短暂查无（可见性滞后）：观察窗内不判定未创建，随后查到成交', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  h.binance.inject({ operation: 'query', mode: 'not-found', times: 3 });
  for (let i = 0; i < 3; i++) { h.advance(10_000); await h.ex.tick(); assert.equal(opState(h, jobId, 0), 'unknown'); }
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(h.binance.calls.place, 1);
}));

test('C05 请求未到达交易所：过有效窗口、间隔多次查无且账户无痕迹才判定未创建，期间不重发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown');
  for (let i = 0; i < 11; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(opState(h, jobId, 0), 'unknown', '有效窗口内不得判定');
  h.advance(11_000); await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown', '只查无一次不得判定');
  h.advance(1_000); await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown', '两次查无间隔不足不得判定');
  h.advance(5_000); await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'not-created');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.deepEqual([h.binance.calls.place, h.binance.arrived.place, h.bybit.calls.place], [1, 0, 0]);
}));

test('C05 查无原委托但账户有不明仓位：不判定未创建；超过观察窗加宽限仍不明则转人工并保留锁', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  h.binance.setPosition('BN1001', 'CLUSDT', 'long', '1');
  for (let i = 0; i < 16; i++) { h.advance(10_000); await h.ex.tick(); }
  let view = h.ex.jobView(jobId);
  assert.equal(view.legs[0].operation?.state, 'unknown');
  assert.match(view.legs[0].operation?.note ?? '', /不一致/);
  assert.equal(view.status, 'running', '观察窗（120 秒）加宽限（60 秒）之内继续核对');
  for (let i = 0; i < 3; i++) { h.advance(10_000); await h.ex.tick(); }
  view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[0].operation?.state, 'unknown', '转人工不等于判定未创建');
  assert.equal(view.locked, true);
  await assert.rejects(h.ex.preview(openIntent(), SESSION), code('symbol_locked'));
  assert.equal(h.ex.acknowledge(jobId, randomUUID(), SESSION).locked, false);
  assert.deepEqual([h.binance.calls.place, h.bybit.calls.place], [1, 0]);
}));

test('C05 按客户订单号的查询持续失败：查无计数不跨失败累计，宽限后转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  h.binance.inject({ operation: 'query', mode: 'read-fail', times: 1_000 });
  for (let i = 0; i < 17; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.ex.jobView(jobId).status, 'running');
  for (let i = 0; i < 2; i++) { h.advance(10_000); await h.ex.tick(); }
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[0].operation?.state, 'unknown');
  assert.equal(view.locked, true);
  assert.equal(h.binance.calls.place, 1);
}));

test('C05 查无原委托且账户读取持续失败：不判定未创建，宽限后转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  h.binance.inject({ operation: 'account', mode: 'read-fail', times: 1_000 });
  for (let i = 0; i < 17; i++) { h.advance(10_000); await h.ex.tick(); }
  let view = h.ex.jobView(jobId);
  assert.equal(view.status, 'running');
  assert.equal(view.legs[0].operation?.state, 'unknown');
  assert.match(view.legs[0].operation?.note ?? '', /账户读取失败/);
  for (let i = 0; i < 2; i++) { h.advance(10_000); await h.ex.tick(); }
  view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[0].operation?.state, 'unknown');
  assert.equal(view.locked, true);
  assert.equal(h.binance.calls.place, 1);
}));

test('C06 长时间停机后接管：宽限从接管开始计，先完成查无判定而不是直接转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown');
  h.clock.now += 600_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).status, 'running');
  h.advance(6_000); await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'not-created');
  assert.equal((await settle(h, jobId)).status, 'failed');
  assert.equal(h.binance.calls.place, 1);
}));

test('C04 对冲腿账户读取持续失败：首腿敞口不无限等待，宽限后转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'filled');
  h.bybit.inject({ operation: 'account', mode: 'read-fail', times: 1_000 });
  await h.ex.tick();
  assert.match(h.ex.jobView(jobId).reason ?? '', /对冲腿等待账户读取/);
  for (let i = 0; i < 5; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.ex.jobView(jobId).status, 'running');
  h.advance(10_000); await h.ex.tick();
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /持续失败/);
  assert.equal(view.locked, true);
  assert.equal(h.bybit.calls.place, 0);
}));

test('C05 同一实例内结果未写入（发送中或已落盘未标记）：不等重启即恢复，不重发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  const sent = await previewAndConfirm(h);
  await h.ex.tick();
  // Emulates a failed write-back after the venue call returned: the row still says sending.
  h.store.db.prepare("UPDATE operations SET state = 'sending', json = json_set(json, '$.state', 'sending') WHERE job_id = ?").run(sent.jobId);
  await h.ex.tick();
  assert.equal(opState(h, sent.jobId, 0), 'sending', '调用超时之内不改写');
  h.advance(1_000);
  await h.ex.tick();
  assert.equal(opState(h, sent.jobId, 0), 'filled');
  assert.equal((await settle(h, sent.jobId)).status, 'completed');
  assert.equal(h.binance.calls.place, 1);

  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const prepared = await previewAndConfirm(h, openIntent({ action: 'close' }));
  await h.ex.tick();
  h.store.db.prepare("UPDATE operations SET state = 'prepared', json = json_set(json, '$.state', 'prepared') WHERE job_id = ?").run(prepared.jobId);
  await h.ex.tick();
  assert.equal(opState(h, prepared.jobId, 0), 'not-sent');
  assert.equal((await settle(h, prepared.jobId)).status, 'failed');
  assert.equal(h.binance.calls.place, 2);
}));

test('C05 调用超时（交易所已受理但无回答）记为未知，再按原身份核对', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'hang-after-apply' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'unknown');
  h.binance.releaseHung();
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.equal(h.binance.calls.place, 1);
}));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`等待超时：${label}`);
}

test('C05/C06 发送中崩溃并被接管：新写者把发送中记为未知，核对原委托，不再发送新委托；旧实例写入被隔离', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'hang-after-apply' });
  const { jobId } = await previewAndConfirm(h);
  const old = h.ex;
  const pending = old.tick();
  await waitFor(() => opState(h, jobId, 0) === 'sending', '首腿进入发送中');
  h.clock.now += 61_000;
  const next = h.restart();
  assert.equal(next.acquire(), true);
  assert.equal(next.generation, old.generation + 1);
  assert.equal(opState(h, jobId, 0), 'unknown');
  assert.equal(h.ex.jobView(jobId).holdNewSends, true);
  await assert.rejects(pending, (error: unknown) => error instanceof ContractError && error.code === 'writer_lost');
  assert.equal(old.retired, true);
  assert.equal(opState(h, jobId, 0), 'unknown', '旧实例的迟到结果不得写回');
  const view = await settle(h, jobId);
  assert.equal(view.legs[0].operation?.state, 'filled');
  assert.equal(view.status, 'attention');
  assert.equal(h.bybit.calls.place, 0);
  assert.equal(h.binance.calls.place, 1);
  h.binance.releaseHung();
}, { budgets: { callTimeoutMs: 400 } }));

test('C05 落盘后、发送前崩溃：恢复为未发送，不补发', () => withHarness(async h => {
  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h);
  await h.ex.tick();
  // Emulates a kill between the prepare and send transactions: the row says prepared.
  h.store.db.prepare("UPDATE operations SET state = 'prepared', json = json_set(json, '$.state', 'prepared') WHERE job_id = ?").run(jobId);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.equal(opState(h, jobId, 0), 'not-sent');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.equal(h.binance.calls.place, 1);
}));

test('C06 重启：未发送的已受理任务取消并释放锁', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.equal(h.ex.jobView(jobId).status, 'failed');
  assert.equal(h.ex.jobView(jobId).locked, false);
  assert.equal(h.binance.calls.place, 0);
}));

test('C06 旧代次预览在接管后确认被拒绝', () => withHarness(async h => {
  bindAccounts(h.ex);
  const preview = await h.ex.preview(openIntent(), SESSION);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_generation'));
}, { budgets: { previewTtlMs: 120_000 } }));

test('C06 写者租约：有效期内第二实例取不到写入权；租约过期后原实例停止写入', () => withHarness(async h => {
  bindAccounts(h.ex);
  const first = h.ex;
  const secondStore = openStore(h.file);
  try {
  const second = createExecutor({ store: secondStore, connectors: [h.binance, h.bybit], now: () => h.clock.now, budgets: { callTimeoutMs: 50 } });
  assert.equal(second.acquire(), false);
  await assert.rejects(second.preview(openIntent(), SESSION), code('writer_lost'));
  h.clock.now += 60_001;
  assert.equal(first.acquire(), false);
  assert.equal(first.retired, true);
  assert.throws(() => first.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 9 }), code('writer_lost'));
  assert.equal(second.acquire(), true);
  assert.equal(second.generation, 2);
  } finally { secondStore.close(); }
}));

test('停止：发送前停止不发任何委托；停止请求幂等', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h);
  const requestId = randomUUID();
  h.ex.requestStop(jobId, requestId, SESSION);
  assert.equal(h.ex.requestStop(jobId, requestId, SESSION).stopRequested, true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'stopped');
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
  const other = await previewAndConfirm(h);
  assert.throws(() => h.ex.requestStop(other.jobId, requestId, SESSION), code('request_reused'));
}));

test('停止：首腿限价挂单被撤销；部分成交后停止不发对冲腿并转人工', () => withHarness(async h => {
  bindAccounts(h.ex);
  const first = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00' }));
  await h.ex.tick();
  assert.equal(opState(h, first.jobId, 0), 'open');
  h.ex.requestStop(first.jobId, randomUUID(), SESSION);
  const stopped = await settle(h, first.jobId);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.legs[0].operation?.state, 'canceled');

  const second = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00' }));
  await h.ex.tick();
  h.binance.fillResting(h.ex.jobView(second.jobId).legs[0].operation!.clientOrderId, '0.3');
  h.ex.requestStop(second.jobId, randomUUID(), SESSION);
  const partial = await settle(h, second.jobId);
  assert.equal(partial.status, 'attention');
  assert.equal(partial.legs[0].operation?.filledQuantity, '0.3');
  assert.equal(h.bybit.calls.place, 0);
}));

test('超过最长执行时间：撤销未成交挂单，任务失败', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00', timeoutMs: 30_000 }));
  await h.ex.tick();
  h.advance(31_000);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.equal(view.legs[0].operation?.state, 'canceled');
}));

test('撤单结果不明：发送前计数，最多尝试上限次数且按间隔重试', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00' }));
  await h.ex.tick();
  h.binance.inject({ operation: 'cancel', mode: 'not-sent' });
  h.binance.inject({ operation: 'cancel', mode: 'lost-request', times: 20 });
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  await h.ex.tick();
  await h.ex.tick();
  assert.equal(h.binance.calls.cancel, 1, '同一间隔内不重复撤单');
  for (let i = 0; i < 10; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.binance.calls.cancel, 6, '本地未发送的一次不计入上限');
  assert.equal(h.binance.arrived.cancel, 0);
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /撤单 5 次仍未确认/);
  assert.equal(view.locked, true);
  // attention still reconciles: a later fill of the resting order becomes visible.
  h.binance.fillResting(view.legs[0].operation!.clientOrderId, '1');
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'filled');
  assert.equal(h.binance.calls.cancel, 6);
  assert.equal(h.bybit.calls.place, 0);
}));

test('C06 接管后立即撤销剩余挂单，不等最长执行时间', () => withHarness(async h => {
  bindAccounts(h.ex);
  const { jobId } = await previewAndConfirm(h, openIntent({ orderType: 'limit', limitPrice: '69.00', timeoutMs: 600_000 }));
  await h.ex.tick();
  assert.equal(opState(h, jobId, 0), 'open');
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const view = await settle(h, jobId);
  assert.equal(view.legs[0].operation?.state, 'canceled');
  assert.equal(view.status, 'failed');
  assert.equal(h.binance.arrived.cancel, 1);
  assert.equal(h.bybit.calls.place, 0);
}));

test('C06 正常关闭交还租约：新实例无需等待过期即可接管，旧实例不再写入', () => withHarness(async h => {
  bindAccounts(h.ex);
  const old = h.ex;
  old.close();
  assert.equal(old.retired, true);
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.throws(() => old.registerAccount({ venue: 'binance', environment: 'simulated', accountId: 'BN1001', accountMode: 'standard', credentialVersion: 5 }), code('writer_lost'));
}));

test('C06 发送前盘口过期：不发送并结束任务；账户读取暂时失败：保留任务稍后再试', () => withHarness(async h => {
  bindAccounts(h.ex);
  const first = await previewAndConfirm(h);
  h.bybit.setBook('CLUSDT', { ageMs: 10_001 });
  const failed = await settle(h, first.jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /盘口已过期/);
  h.bybit.setBook('CLUSDT', { ageMs: 0 });

  const incomplete = await previewAndConfirm(h);
  h.binance.setBook('CLUSDT', { complete: false });
  assert.equal((await settle(h, incomplete.jobId)).status, 'failed');
  h.binance.setBook('CLUSDT', { complete: true });

  const second = await previewAndConfirm(h);
  h.binance.inject({ operation: 'account', mode: 'read-fail' });
  await h.ex.tick();
  const waiting = h.ex.jobView(second.jobId);
  assert.equal(waiting.status, 'accepted');
  assert.match(waiting.reason ?? '', /读取失败/);
  assert.equal((await settle(h, second.jobId)).status, 'completed');
  assert.equal(h.binance.calls.place, 1);
}));

test('平仓：只减仓，平掉已开双腿', () => withHarness(async h => {
  bindAccounts(h.ex);
  await settle(h, (await previewAndConfirm(h)).jobId);
  const view = await settle(h, (await previewAndConfirm(h, openIntent({ action: 'close' }))).jobId);
  assert.equal(view.status, 'completed');
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'long'), '0');
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'short'), '0');
}));

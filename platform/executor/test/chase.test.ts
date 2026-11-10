// Bybit native chase strategy as the lead leg: no client id, so a create without
// an answer is never resent and is settled only by adoption or a person's
// confirmation that nothing was created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError } from '../src/contracts.ts';
import type { StrategyRequest } from '../src/connector.ts';
import { SESSION, bindAccounts, chaseIntent, createHarness, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
async function withHarness(run: (h: Harness) => Promise<void>, options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  try { bindAccounts(h.ex); await run(h); } finally { h.dispose(); }
}
const takeover = (h: Harness) => { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); };
const lead = (h: Harness, jobId: string) => h.ex.jobView(jobId).legs[0].operation!;
const same: StrategyRequest = { symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '1', maxChasePrice: '70.42', reduceOnly: false };
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error(`等待超时：${label}`);
}
const sends = (h: Harness) => [h.bybit.calls['strategy-place'], h.bybit.arrived['strategy-place'], h.bybit.calls.place];

test('追价首腿：以预览界限作为最高追价发送，立即成交后按成交对冲完成；对冲腿仍为市价 IOC', () => withHarness(async h => {
  const { preview, jobId } = await previewAndConfirm(h, chaseIntent());
  assert.equal(preview.legs[0].priceBound, '70.42');
  assert.ok(preview.notes.some(note => note.includes('原生追价策略') && note.includes('70.42')));
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  const [strategy] = h.bybit.strategiesOf('BY2002');
  assert.deepEqual([strategy.maxChasePrice, strategy.side, strategy.quantity, strategy.status, strategy.childrenSettled], ['70.42', 'buy', '1', 'terminal', true]);
  const op = view.legs[0].operation!;
  assert.deepEqual([op.kind, op.state, op.remoteId, op.filledQuantity, op.strategyStatus], ['strategy', 'filled', strategy.strategyId, '1', 'terminal']);
  assert.equal(view.legs[0].orderType, 'chase');
  assert.deepEqual(sends(h), [1, 1, 0]);
  assert.equal(h.bybit.position('BY2002', 'CLUSDT', 'long'), '1');
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'short'), '1');
  const hedge = [...h.binance.orders.values()][0].request;
  assert.deepEqual([hedge.type, hedge.timeInForce, hedge.quantity], ['market', 'ioc', '1']);
}));

test('追价首腿：部分成交保持运行；截止后停止并重查，子单滞后时先不结清，结清后按实际成交对冲', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'children-lag' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).strategyStatus, lead(h, jobId).filledQuantity], ['open', 'working', '0.4']);
  const strategyId = lead(h, jobId).remoteId!;
  // A lower cumulative fill is a stale answer and never lowers what is on disk.
  const venueStrategy = h.bybit.strategies.get(strategyId)!;
  venueStrategy.filled = '0.2';
  h.advance(10_000);
  await h.ex.tick();
  assert.equal(lead(h, jobId).filledQuantity, '0.4');
  assert.match(lead(h, jobId).note ?? '', /回退/);
  venueStrategy.filled = '0.4';
  assert.equal(h.bybit.calls['strategy-stop'], 0, '截止前不停止');
  assert.equal(h.binance.calls.place, 0);

  h.advance(21_000);
  await h.ex.tick();
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).strategyStatus, lead(h, jobId).childrenSettled], ['open', 'terminal', false]);
  assert.equal(h.binance.calls.place, 0, '子单未结清时不对冲');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual([view.legs[0].operation?.state, view.legs[0].filledQuantity], ['canceled', '0.4']);
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'short'), '0.4');
  assert.equal(h.bybit.arrived['strategy-stop'], 1, '已结束的策略不重复停止');
}));

test('追价首腿：已结束但子单持续未结清，超过宽限转人工，不对冲', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'children-lag' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  h.advance(31_000);
  await h.ex.tick();
  assert.deepEqual([lead(h, jobId).strategyStatus, lead(h, jobId).childrenSettled], ['terminal', false]);
  h.bybit.strategies.get(lead(h, jobId).remoteId!)!.lagQueries = 1_000;
  const view = await settle(h, jobId, { ticks: 150 });
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /子单超过 60000 毫秒仍未结清/);
  assert.equal(h.binance.calls.place, 0);
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
}));

test('追价首腿：策略被交易所暂停时立即停止，按已成交量对冲', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'paused', filled: '0.5' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 3_600_000 }));
  await h.ex.tick();
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).strategyStatus], ['open', 'paused']);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.ok(h.clock.now < view.deadlineAt);
  assert.deepEqual([view.legs[0].operation?.state, view.legs[0].filledQuantity], ['canceled', '0.5']);
  assert.match(view.legs[0].operation?.note ?? '', /暂停，已停止/);
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'short'), '0.5');
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
}));

test('追价 ACK 丢失：不重发、不自动核对，立即转人工；确认被拒；错误编号、身份不符、时段外均不能认领；认领后停止剩余并结清', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  let view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.strategyPending, true);
  assert.match(view.reason ?? '', /追价策略创建结果未知.*需人工填写策略编号认领/);
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).remoteId], ['unknown', null]);
  for (let i = 0; i < 5; i++) { h.advance(1_000); await h.ex.tick(); }
  assert.deepEqual(sends(h), [1, 1, 0], '结果不明时绝不重发');
  assert.equal(h.bybit.calls['strategy-query'], 0, '无策略编号时不做任何自动核对');
  assert.throws(() => h.ex.acknowledge(jobId, randomUUID(), SESSION), code('strategy_unresolved'));

  const [real] = h.bybit.strategiesOf('BY2002');
  assert.deepEqual([real.status, real.filledQuantity], ['working', '0.3']);
  const adopt = (strategyId: string, requestId = randomUUID()) => h.ex.adoptStrategy({ jobId, requestId, strategyId }, SESSION);
  await assert.rejects(adopt(randomUUID()), code('strategy_not_found'));
  await assert.rejects(adopt('bad id!'), code('invalid_value'));
  await assert.rejects(adopt(h.bybit.addForeignStrategy('BY2002', { ...same, quantity: '2' })), code('strategy_identity'));
  await assert.rejects(adopt(h.bybit.addForeignStrategy('BY2002', { ...same, reduceOnly: true })), code('strategy_identity'));
  await assert.rejects(adopt(h.bybit.addForeignStrategy('BY2002', same, { createdAt: h.clock.now - 3_600_000 })), code('strategy_window'));
  await assert.rejects(h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId, extra: 1 }, SESSION), code('unknown_field'));
  assert.equal(lead(h, jobId).state, 'unknown');
  assert.equal(h.bybit.calls['strategy-stop'], 0);

  const requestId = randomUUID();
  view = await adopt(real.strategyId, requestId);
  const op = view.legs[0].operation!;
  assert.deepEqual([op.remoteId, op.state, op.filledQuantity, op.strategyStatus], [real.strategyId, 'canceled', '0.3', 'terminal']);
  assert.ok(op.adoptedAt);
  assert.equal(view.strategyPending, false);
  assert.equal(h.bybit.arrived['strategy-stop'], 1, '认领后停止剩余部分');
  assert.ok(view.events.some(item => item.type === 'strategy-adopted'));
  assert.equal((await adopt(real.strategyId, requestId)).legs[0].operation?.remoteId, real.strategyId, '同一请求编号重试返回原结果');
  await assert.rejects(adopt(real.strategyId), code('no_pending_strategy'));
  await assert.rejects(h.ex.adoptStrategy({ jobId, requestId, strategyId: randomUUID() }, SESSION), code('request_reused'));
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  assert.equal(h.ex.jobView(jobId).locked, false);
  assert.deepEqual(sends(h), [1, 1, 0]);
  assert.equal(h.binance.calls.place, 0, '待人工任务不补发对冲腿');
}));

test('追价认领：已被其他委托认领的策略编号不能再认领', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response' });
  const first = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  const [taken] = h.bybit.strategiesOf('BY2002');
  const view = await h.ex.adoptStrategy({ jobId: first.jobId, requestId: randomUUID(), strategyId: taken.strategyId }, SESSION);
  assert.equal(view.legs[0].operation?.state, 'filled');
  assert.equal(h.bybit.calls['strategy-stop'], 0, '已结束的策略无需停止');
  h.ex.acknowledge(first.jobId, randomUUID(), SESSION);

  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response' });
  const second = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.equal(h.ex.jobView(second.jobId).status, 'attention');
  await assert.rejects(h.ex.adoptStrategy({ jobId: second.jobId, requestId: randomUUID(), strategyId: taken.strategyId }, SESSION), code('strategy_claimed'));
  const own = h.bybit.strategiesOf('BY2002').find(item => item.strategyId !== taken.strategyId)!;
  assert.equal((await h.ex.adoptStrategy({ jobId: second.jobId, requestId: randomUUID(), strategyId: own.strategyId }, SESSION)).legs[0].operation?.remoteId, own.strategyId);
}));

test('追价认领：认领后停止被拒，待人工期间有界重试停止直至结清', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'reject' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  const [real] = h.bybit.strategiesOf('BY2002');
  const view = await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION);
  assert.deepEqual([view.legs[0].operation?.state, view.legs[0].operation?.strategyStatus], ['open', 'working']);
  assert.match(view.legs[0].operation?.note ?? '', /撤单未确认/);
  await h.ex.tick();
  assert.equal(h.bybit.calls['strategy-stop'], 1, '重试间隔内不重发停止');
  h.advance(10_000);
  await h.ex.tick();
  assert.equal(h.bybit.arrived['strategy-stop'], 2);
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).filledQuantity], ['canceled', '0.3']);
  for (let i = 0; i < 3; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.bybit.calls['strategy-stop'], 2);
  assert.equal(h.ex.jobView(jobId).status, 'attention');
}));

test('追价请求丢失：观察窗前、有运行中或时段内已结束的策略、持仓不一致、列表读取失败时都不能确认未创建；条件满足后确认，账户可再交易', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).status, 'attention');
  assert.equal(h.bybit.strategies.size, 0);
  const confirmNot = (requestId = randomUUID()) => h.ex.confirmNotCreated({ jobId, requestId }, SESSION);
  await assert.rejects(confirmNot(), code('create_window'));
  h.advance(121_000);

  const foreign = h.bybit.addForeignStrategy('BY2002', same);
  await assert.rejects(confirmNot(), code('strategy_running'));
  Object.assign(h.bybit.strategies.get(foreign)!, { status: 'paused' });
  await assert.rejects(confirmNot(), code('strategy_running'));
  Object.assign(h.bybit.strategies.get(foreign)!, { status: 'terminal', childrenSettled: true });
  await assert.rejects(confirmNot(), code('strategy_candidate'));
  h.bybit.strategies.get(foreign)!.createdAt = h.clock.now - 3_600_000;

  h.bybit.inject({ operation: 'strategy-list', mode: 'read-fail' });
  await assert.rejects(confirmNot(), code('venue_read_failed'));
  h.bybit.setPosition('BY2002', 'CLUSDT', 'long', '0.5');
  await assert.rejects(confirmNot(), code('position_mismatch'));
  h.bybit.setPosition('BY2002', 'CLUSDT', 'long', '0');
  h.bybit.inject({ operation: 'account', mode: 'read-fail' });
  await assert.rejects(confirmNot(), code('venue_read_failed'));
  assert.deepEqual([lead(h, jobId).state, h.ex.jobView(jobId).strategyPending], ['unknown', true]);
  assert.throws(() => h.ex.acknowledge(jobId, randomUUID(), SESSION), code('strategy_unresolved'));

  const requestId = randomUUID();
  const view = await confirmNot(requestId);
  assert.deepEqual([view.legs[0].operation?.state, view.strategyPending], ['not-created', false]);
  assert.ok(view.events.some(item => item.type === 'strategy-not-created'));
  assert.match(view.reason ?? '', /已人工确认 .*追价策略未创建/);
  assert.equal((await confirmNot(requestId)).legs[0].operation?.state, 'not-created');
  await assert.rejects(confirmNot(), code('no_pending_strategy'));
  assert.deepEqual(sends(h), [1, 0, 0]);
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  const next = await previewAndConfirm(h, chaseIntent());
  assert.equal((await settle(h, next.jobId)).status, 'completed');
}));

test('追价接管：发送中崩溃记为未知并立即转人工，不重发；按交易所策略编号认领后结清', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.equal(lead(h, jobId).state, 'filled');
  // Emulates a kill after the sending mark, before the answer was written.
  h.store.db.prepare("UPDATE operations SET state = 'sending', settled = 0, json = json_set(json, '$.state', 'sending', '$.remoteId', NULL, '$.filledQuantity', '0', '$.averagePrice', NULL, '$.strategyStatus', NULL) WHERE job_id = ? AND leg = 0").run(jobId);
  takeover(h);
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).remoteId], ['unknown', null]);
  assert.match(lead(h, jobId).note ?? '', /恢复：追价策略发送中断/);
  await h.ex.tick();
  const view = h.ex.jobView(jobId);
  assert.deepEqual([view.status, view.strategyPending], ['attention', true]);
  assert.deepEqual(sends(h), [1, 1, 0]);
  assert.equal(h.binance.calls.place, 0);
  const [strategy] = h.bybit.strategiesOf('BY2002');
  const adopted = await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: strategy.strategyId }, SESSION);
  assert.deepEqual([adopted.legs[0].operation?.state, adopted.legs[0].filledQuantity], ['filled', '1']);
}));

test('追价接管：运行中的策略在接管后被停止，按停止后成交补发对冲腿', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 3_600_000 }));
  await h.ex.tick();
  assert.equal(lead(h, jobId).strategyStatus, 'working');
  takeover(h);
  assert.equal(h.ex.jobView(jobId).holdNewSends, true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual([view.legs[0].operation?.state, view.legs[1].filledQuantity], ['canceled', '0.4']);
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
  assert.equal(h.bybit.calls['strategy-place'], 1);
}));

test('追价预览：只允许 Bybit 首腿、不带限价、连接器须声明追价能力', () => withHarness(async h => {
  const intent = chaseIntent();
  await assert.rejects(h.ex.preview({ ...intent, legs: [{ ...intent.legs[0], venue: 'binance' }, { ...intent.legs[1], venue: 'bybit' }] }, SESSION), code('chase_unsupported'));
  await assert.rejects(h.ex.preview({ ...intent, legs: [{ ...intent.legs[0], limitPrice: '70.10' }, intent.legs[1]] }, SESSION), code('limit_price'));
  const hedgeChase = { ...intent, legs: [{ venue: 'binance', side: 'short', quantity: '1', orderType: 'market' }, { venue: 'bybit', side: 'long', quantity: '1', orderType: 'chase' }] };
  await assert.rejects(h.ex.preview(hedgeChase, SESSION), code('chase_unsupported'));
  delete (h.bybit.capabilities as { chase?: true }).chase;
  await assert.rejects(h.ex.preview(intent, SESSION), code('chase_unsupported'));
  assert.equal(h.bybit.calls['strategy-place'] + h.binance.calls.place + h.bybit.calls.place, 0);
}));

const rawLead = (h: Harness, jobId: string) => JSON.parse((h.store.db.prepare('SELECT json FROM operations WHERE job_id = ? AND leg = 0').get(jobId) as { json: string }).json) as Record<string, unknown>;

test('追价确认未创建：候选只看发送时段前后创建的策略，发送 10 分钟后才创建并结束的同合约策略不阻止确认', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-request' });
  const sentAt = h.clock.now;
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  h.advance(600_000);
  h.bybit.addForeignStrategy('BY2002', same, { status: 'terminal' });
  const edge = h.bybit.addForeignStrategy('BY2002', same, { status: 'terminal', createdAt: sentAt + 50 + 300_000 });
  await assert.rejects(h.ex.confirmNotCreated({ jobId, requestId: randomUUID() }, SESSION), code('strategy_candidate'));
  h.bybit.strategies.get(edge)!.createdAt = sentAt + 50 + 300_001;
  const view = await h.ex.confirmNotCreated({ jobId, requestId: randomUUID() }, SESSION);
  assert.equal(view.legs[0].operation?.state, 'not-created');
}));

test('追价确认未创建：本执行器已认领的已结束策略不算候选；同合约有外部挂单时拒绝', () => withHarness(async h => {
  const first = await previewAndConfirm(h, chaseIntent());
  assert.equal((await settle(h, first.jobId)).status, 'completed');
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).status, 'attention');
  h.advance(121_000);
  h.bybit.addForeignOrder('BY2002', 'CLUSDT');
  await assert.rejects(h.ex.confirmNotCreated({ jobId, requestId: randomUUID() }, SESSION), code('position_mismatch'));
  h.bybit.accounts.get('BY2002')!.foreignOrders.length = 0;
  assert.equal((await h.ex.confirmNotCreated({ jobId, requestId: randomUUID() }, SESSION)).legs[0].operation?.state, 'not-created');
}));

test('追价认领时间窗：准备时刻减偏差与发送时刻加调用超时加偏差两端，界内可认领，界外拒绝', async () => {
  for (const side of ['from', 'to'] as const) {
    await withHarness(async h => {
      h.bybit.inject({ operation: 'strategy-place', mode: 'lost-request' });
      const at = h.clock.now;
      const { jobId } = await previewAndConfirm(h, chaseIntent());
      await h.ex.tick();
      const inside = side === 'from' ? at - 5_000 : at + 50 + 5_000, outside = side === 'from' ? inside - 1 : inside + 1;
      const adopt = (createdAt: number) => h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: h.bybit.addForeignStrategy('BY2002', same, { createdAt }) }, SESSION);
      await assert.rejects(adopt(outside), code('strategy_window'));
      const view = await adopt(inside);
      assert.ok(view.legs[0].operation?.adoptedAt, side);
    });
  }
});

test('追价认领：最高追价不同的策略身份不符，不能认领', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  await assert.rejects(h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: h.bybit.addForeignStrategy('BY2002', { ...same, maxChasePrice: '70.43' }) }, SESSION), code('strategy_identity'));
}));

test('追价停止：停止请求到达时又成交一部分，按停止后重查的实际成交量对冲', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'fill-on-stop', filled: '0.3' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  assert.equal(lead(h, jobId).filledQuantity, '0.4');
  h.advance(31_000);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual([view.legs[0].operation?.state, view.legs[0].filledQuantity, view.legs[1].filledQuantity], ['canceled', '0.7', '0.7']);
  assert.equal(h.binance.position('BN1001', 'CLUSDT', 'short'), '0.7');
}));

test('追价状态回退：已读到结束后又读到运行中的回报被拒收，不重复停止，子单等待计时不清空', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'children-lag' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  h.advance(31_000);
  await h.ex.tick();
  assert.deepEqual([lead(h, jobId).strategyStatus, lead(h, jobId).childrenSettled], ['terminal', false]);
  const waitSince = rawLead(h, jobId).childrenWaitSince;
  assert.equal(typeof waitSince, 'number');
  const venueStrategy = h.bybit.strategies.get(lead(h, jobId).remoteId!)!;
  venueStrategy.status = 'working';
  for (let i = 0; i < 3; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(lead(h, jobId).strategyStatus, 'terminal');
  assert.match(lead(h, jobId).note ?? '', /状态从已结束回退/);
  assert.equal(rawLead(h, jobId).childrenWaitSince, waitSince);
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
  venueStrategy.status = 'terminal';
  assert.equal((await settle(h, jobId)).status, 'completed');
}));

test('追价 ACK 编号已被其他委托认领：按结果不明转人工，备注记下编号，不对该编号发停止', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  const first = await previewAndConfirm(h, chaseIntent({ timeoutMs: 3_600_000 }));
  await h.ex.tick();
  const taken = lead(h, first.jobId).remoteId!;
  h.bybit.inject({ operation: 'strategy-place', mode: 'wrong-id', strategyId: taken });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ symbol: 'BZUSDT', timeoutMs: 30_000 }));
  await h.ex.tick();
  const view = h.ex.jobView(jobId);
  assert.deepEqual([view.status, view.strategyPending, lead(h, jobId).state, lead(h, jobId).remoteId], ['attention', true, 'unknown', null]);
  assert.ok((lead(h, jobId).note ?? '').includes(taken));
  assert.ok(view.events.some(item => item.type === 'operation-sent' && (item as { strategyId?: string }).strategyId === taken));
  for (let i = 0; i < 4; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.bybit.calls['strategy-stop'], 0);
  assert.equal(h.bybit.strategies.get(taken)!.status, 'working');
}));

test('追价 ACK 编号是已结清委托认领过、身份与时段都相符的策略：仍不采用，不按其成交对冲', () => withHarness(async h => {
  const first = await previewAndConfirm(h, chaseIntent());
  assert.equal((await settle(h, first.jobId)).status, 'completed');
  const taken = lead(h, first.jobId).remoteId!;
  h.bybit.inject({ operation: 'strategy-place', mode: 'wrong-id', strategyId: taken });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.deepEqual([h.ex.jobView(jobId).status, lead(h, jobId).state, lead(h, jobId).remoteId], ['attention', 'unknown', null]);
  assert.match(lead(h, jobId).note ?? '', /已被其他委托认领/);
  assert.equal(h.binance.calls.place, 1, '只有第一笔任务的对冲');
}));

test('追价 ACK 编号查无或身份不符：按结果不明转人工，不对该编号发停止', async () => {
  for (const kind of ['missing', 'identity'] as const) {
    await withHarness(async h => {
      // On another symbol, so the foreign strategy's child does not show as an external order on the traded one.
      const wrong = kind === 'missing' ? randomUUID() : h.bybit.addForeignStrategy('BY2002', { ...same, symbol: 'BZUSDT' });
      h.bybit.inject({ operation: 'strategy-place', mode: 'wrong-id', strategyId: wrong });
      const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
      await h.ex.tick();
      assert.deepEqual([h.ex.jobView(jobId).status, lead(h, jobId).state, lead(h, jobId).remoteId], ['attention', 'unknown', null], kind);
      assert.match(lead(h, jobId).note ?? '', kind === 'missing' ? /查无回报的策略编号/ : /身份不一致/);
      assert.ok((lead(h, jobId).note ?? '').includes(wrong));
      for (let i = 0; i < 4; i++) { h.advance(10_000); await h.ex.tick(); }
      assert.equal(h.bybit.calls['strategy-stop'], 0, kind);
    });
  }
});

test('追价 ACK 后查询失败：保留编号但核对身份前不停止；核对通过后按截止停止并对冲', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-query', mode: 'read-fail', times: 3 });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).filledQuantity], ['open', '0']);
  assert.ok(lead(h, jobId).remoteId);
  h.advance(31_000);
  await h.ex.tick();
  await h.ex.tick();
  assert.equal(h.bybit.calls['strategy-stop'], 0, '身份未核对时截止也不停止');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed');
  assert.deepEqual([view.legs[0].filledQuantity, view.legs[1].filledQuantity], ['0.4', '0.4']);
  assert.equal(h.bybit.arrived['strategy-stop'], 1);
}));

test('追价 ACK 后身份一直无法核对：超过宽限按结果不明转人工，从不停止，不能直接确认处理；读取恢复后可凭备注中的编号认领', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  h.bybit.inject({ operation: 'strategy-query', mode: 'read-fail', times: 1_000 });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  const view = await settle(h, jobId, { ticks: 100 });
  const [real] = h.bybit.strategiesOf('BY2002');
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /创建结果未知/);
  assert.deepEqual([lead(h, jobId).state, lead(h, jobId).remoteId, lead(h, jobId).ackStrategyId, view.strategyPending], ['unknown', null, real.strategyId, true]);
  assert.match(lead(h, jobId).note ?? '', /未能查询核对身份/);
  assert.ok((lead(h, jobId).note ?? '').includes(real.strategyId));
  assert.ok(view.events.some(item => item.type === 'strategy-disowned'));
  assert.throws(() => h.ex.acknowledge(jobId, randomUUID(), SESSION), code('strategy_unresolved'));
  assert.equal(h.bybit.calls['strategy-stop'], 0);
  h.bybit.clearFaults();
  const adopted = await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION);
  assert.deepEqual([adopted.legs[0].operation!.remoteId, adopted.strategyPending], [real.strategyId, false]);
  assert.match(adopted.reason ?? '', new RegExp(`已人工认领 .*${real.strategyId}（首腿成交 0.4）`));
  assert.equal(h.bybit.calls['strategy-stop'], 1);
}));

test('追价 ACK 后查询失败、之后查无或身份不符：按结果不明转人工，不能直接确认处理，不发停止', async () => {
  for (const kind of ['missing', 'identity'] as const) {
    await withHarness(async h => {
      const wrong = kind === 'missing' ? randomUUID() : h.bybit.addForeignStrategy('BY2002', { ...same, symbol: 'BZUSDT' });
      h.bybit.inject({ operation: 'strategy-place', mode: 'wrong-id', strategyId: wrong });
      h.bybit.inject({ operation: 'strategy-query', mode: 'read-fail', times: 1 });
      const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
      await h.ex.tick();
      assert.deepEqual([lead(h, jobId).state, lead(h, jobId).remoteId, lead(h, jobId).ackStrategyId], ['open', wrong, wrong], kind);
      h.advance(1_000);
      await h.ex.tick();
      const view = h.ex.jobView(jobId);
      assert.deepEqual([view.status, lead(h, jobId).state, lead(h, jobId).remoteId, view.strategyPending], ['attention', 'unknown', null, true], kind);
      assert.match(lead(h, jobId).note ?? '', kind === 'missing' ? /查无回报的策略编号/ : /身份不一致/);
      assert.match(view.reason ?? '', /创建结果未知/);
      assert.throws(() => h.ex.acknowledge(jobId, randomUUID(), SESSION), code('strategy_unresolved'), kind);
      for (let i = 0; i < 4; i++) { h.advance(10_000); await h.ex.tick(); }
      assert.equal(h.bybit.calls['strategy-stop'], 0, kind);
    });
  }
});

test('追价 ACK 编号查到的策略创建于准备之前或回报之后（含首次查询失败、之后才查到）：不采用，按结果不明转人工', async () => {
  for (const [label, offset, readFails] of [['准备之前', -60_000, 0], ['回报之后', 60_000, 0], ['准备之前、首次查询失败', -60_000, 1]] as const) {
    await withHarness(async h => {
      const other = h.bybit.addForeignStrategy('BY2002', same, { status: 'terminal', createdAt: h.clock.now + offset });
      h.bybit.inject({ operation: 'strategy-place', mode: 'wrong-id', strategyId: other });
      if (readFails) h.bybit.inject({ operation: 'strategy-query', mode: 'read-fail', times: readFails });
      const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
      await h.ex.tick();
      if (readFails) {
        assert.deepEqual([lead(h, jobId).state, lead(h, jobId).remoteId], ['open', other], label);
        h.advance(1_000);
        await h.ex.tick();
      }
      assert.deepEqual([h.ex.jobView(jobId).status, lead(h, jobId).state, lead(h, jobId).remoteId, lead(h, jobId).filledQuantity], ['attention', 'unknown', null, '0'], label);
      assert.match(lead(h, jobId).note ?? '', /创建时间不在本委托发送时段内/, label);
      assert.equal(h.bybit.calls['strategy-stop'] + h.binance.calls.place, 0, label);
    });
  }
});

test('追价 ACK 核对期间被接管：回报的策略编号已落盘，恢复后的备注里可见', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-query', mode: 'hang-after-apply' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  const old = h.ex;
  const pending = old.tick();
  await waitFor(() => h.ex.jobView(jobId).legs[0].operation?.ackStrategyId != null, 'ACK 编号落盘');
  assert.equal(lead(h, jobId).state, 'sending');
  const [real] = h.bybit.strategiesOf('BY2002');
  assert.equal(lead(h, jobId).ackStrategyId, real.strategyId);
  takeover(h);
  await assert.rejects(pending, code('writer_lost'));
  assert.equal(lead(h, jobId).state, 'unknown');
  assert.ok((lead(h, jobId).note ?? '').includes(`交易所曾回报策略编号 ${real.strategyId}`));
  h.bybit.releaseHung();
}, { budgets: { callTimeoutMs: 400 } }));

test('追价核对：已核对的策略编号后来回报身份不符，转人工并不再对其发停止', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  const { jobId } = await previewAndConfirm(h, chaseIntent({ timeoutMs: 30_000 }));
  await h.ex.tick();
  const id = lead(h, jobId).remoteId!;
  h.bybit.strategies.get(id)!.request.quantity = '2';
  h.advance(31_000);
  await h.ex.tick();
  for (let i = 0; i < 4; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.ex.jobView(jobId).status, 'attention');
  assert.match(h.ex.jobView(jobId).reason ?? '', /身份不一致，不对其发送停止/);
  assert.equal(lead(h, jobId).remoteId, id);
  assert.equal(h.bybit.calls['strategy-stop'], 0);
  assert.ok(h.ex.jobView(jobId).events.some(item => item.type === 'strategy-identity-mismatch'));
}));

test('追价强制释放：须明确确认风险；释放后登记已释放、可确认人工处理，不重发、不认领、不核对；请求编号幂等', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  assert.throws(() => h.ex.acknowledge(jobId, randomUUID(), SESSION), code('strategy_unresolved'));
  const release = (extra: Record<string, unknown>, requestId = randomUUID()) => h.ex.releaseStrategy({ jobId, requestId, ...extra }, SESSION);
  for (const extra of [{}, { acknowledgeRisk: false }, { acknowledgeRisk: 'true' }, { acknowledgeRisk: 1 }]) assert.throws(() => release(extra), code('acknowledge_risk'));
  assert.throws(() => release({ acknowledgeRisk: true, more: 1 }), code('unknown_field'));
  assert.equal(h.ex.jobView(jobId).strategyPending, true);
  const requestId = randomUUID();
  const view = release({ acknowledgeRisk: true }, requestId);
  const op = view.legs[0].operation!;
  assert.deepEqual([op.state, op.remoteId, view.strategyPending, view.status], ['unknown', null, false, 'attention']);
  assert.ok(op.releasedAt);
  assert.match(op.note ?? '', /人工强制释放：策略可能已成交/);
  assert.match(view.reason ?? '', /已人工强制释放追价策略/);
  assert.ok(view.events.some(item => item.type === 'strategy-released' && (item as { requestId?: string }).requestId === requestId));
  assert.equal(release({ acknowledgeRisk: true }, requestId).events.filter(item => item.type === 'strategy-released').length, 1, '同一请求编号重试返回原结果');
  assert.throws(() => release({ acknowledgeRisk: true }), code('no_pending_strategy'));
  const [real] = h.bybit.strategiesOf('BY2002');
  await assert.rejects(h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION), code('no_pending_strategy'));
  h.advance(121_000);
  await assert.rejects(h.ex.confirmNotCreated({ jobId, requestId: randomUUID() }, SESSION), code('no_pending_strategy'));
  for (let i = 0; i < 5; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.deepEqual(sends(h), [1, 1, 0], '释放后不重发');
  assert.equal(h.bybit.calls['strategy-query'] + h.bybit.calls['strategy-stop'], 0);
  assert.match(lead(h, jobId).note ?? '', /人工强制释放/);
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  assert.equal(h.ex.jobView(jobId).locked, false);
  assert.equal(lead(h, jobId).state, 'unknown');
}));

test('追价认领：待人工期间停止持续未发送时尝试次数有上限，达到后不再尝试并在备注说明', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'not-sent', times: 1_000 });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  const [real] = h.bybit.strategiesOf('BY2002');
  await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION);
  assert.equal(h.bybit.calls['strategy-stop'], 1);
  for (let i = 0; i < 20; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.bybit.calls['strategy-stop'], 1 + 5);
  assert.equal(h.bybit.arrived['strategy-stop'], 0);
  assert.match(lead(h, jobId).note ?? '', /已尝试停止 5 次仍未结束，不再自动停止/);
}));

test('追价认领：人工确认处理后不再停止认领的策略', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'reject', times: 1_000 });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  const [real] = h.bybit.strategiesOf('BY2002');
  await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION);
  assert.equal(h.bybit.calls['strategy-stop'], 1);
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  for (let i = 0; i < 5; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.bybit.calls['strategy-stop'], 1);
  assert.equal(lead(h, jobId).strategyStatus, 'working');
}));

test('追价认领：核对等待交易所期间人工确认处理，本轮也不再停止认领的策略', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'lost-response', filled: '0.3' });
  h.bybit.inject({ operation: 'strategy-stop', mode: 'reject', times: 1_000 });
  const { jobId } = await previewAndConfirm(h, chaseIntent());
  await h.ex.tick();
  const [real] = h.bybit.strategiesOf('BY2002');
  await h.ex.adoptStrategy({ jobId, requestId: randomUUID(), strategyId: real.strategyId }, SESSION);
  assert.equal(h.bybit.calls['strategy-stop'], 1);
  h.advance(10_000);
  h.bybit.inject({ operation: 'strategy-query', mode: 'hang-after-apply' });
  const queries = h.bybit.calls['strategy-query'];
  const pending = h.ex.tick();
  await waitFor(() => h.bybit.calls['strategy-query'] > queries, '核对进入等待');
  h.ex.acknowledge(jobId, randomUUID(), SESSION);
  await pending;
  assert.equal(h.bybit.calls['strategy-stop'], 1);
  h.bybit.releaseHung();
}, { budgets: { callTimeoutMs: 400 } }));
